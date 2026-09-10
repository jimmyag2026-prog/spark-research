import { defaultHttp, type HttpClient, type HttpRequestInit, type HttpResponse } from "./client";

// V26（BACKLOG）：connector 层此前只有礼貌头（connectors/politeness.ts），**没有任何
// 限速器**。pubmed / ncbi 已经共享 NCBI eutils 的主机级配额；本波新增的 clinvar
// 打的是同一台机器。**键控必须是 host，不是 connector**——按 connector 分别节流，
// 三个 eutils connector 合计仍会打穿主机限速、集体撞 429（见本文件末尾的令牌桶
// 设计说明，以及 docs/devlog/W5-2-c.md 里贴出的阴性对照原始输出）。
//
// 接线点：`ConnectorRegistry` 构造函数（connectors/registry.ts）—— `options.http` 未显式
// 传入时默认成 `rateLimitedHttp()`，所有内置 connector 共用同一个装饰器实例（同一份
// 按 host 分桶的状态）。测试/fixture 场景显式传入 `http`（StubHttp/FixtureHttp）时，
// 那个注入值原样使用，**不会**被包一层限速——测试的确定性不受影响，这也是为什么
// `RateLimitedHttp` 必须是"外面套一层"的装饰器形态而不是揉进 NativeHttp 内部。

export interface HostRatePolicy {
  rps: number;
  burst: number;
  // 数字的出处：URL 或可核实的文档引用。**没写来源的数字不许进表**（PRICING 同一纪律）。
  source: string;
  // 核实日期（YYYY-MM-DD）——限速策略会变，没有日期就没法判断是不是过期了。
  verifiedDate: string;
  note?: string;
}

// 首批策略：目前只登记「多个 connector 真的共享同一台主机」这一种场景——
// eutils.ncbi.nlm.nih.gov 被 pubmed / ncbi / clinvar 三个 connector 共用。
// 本波新增的 biorxiv / reactome / string-db 各自的 host 在仓库里没有第二个消费方，
// 没有「集体打穿」的风险，也没有可核实来源的具体数字（官方文档未给出），
// 故不编造条目——无策略的 host 走 request() 的直通分支，行为与未接限速器时一致。
export const HOST_RATE_POLICIES: Readonly<Record<string, HostRatePolicy>> = {
  "eutils.ncbi.nlm.nih.gov": {
    rps: 3,
    burst: 3,
    source: "https://eutilities.github.io/site/API_Key/usageandkey/（NCBI E-utilities Usage Guidelines and API Key，即 NBK25497 现行发布位置）",
    verifiedDate: "2026-09-10",
    note:
      "匿名（无 API key）上限；带 key 可到 10 rps，但 spark-research 未走 key 路径，" +
      "不据此放宽。三个 eutils connector（pubmed/ncbi/clinvar）共享同一个按 host 键控的令牌桶。",
  },
};

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// 标准令牌桶：容量 = burst，持续按 rps（token/秒）速率补充，封顶容量。
// 对任意长度为 T 秒的窗口，可消耗的令牌数上限是 `burst + rps * T`——
// T=1s 时正好对应 HOST_RATE_POLICIES 里 `rps + burst` 的口径
// （tests/concurrency/host_ratelimit.test.ts 断言的就是这条不变式）。
export class RateLimitedHttp implements HttpClient {
  private buckets = new Map<string, Bucket>();
  private inner: HttpClient;
  private policies: Readonly<Record<string, HostRatePolicy>>;
  private now: () => number;

  constructor(
    inner: HttpClient = defaultHttp,
    policies: Readonly<Record<string, HostRatePolicy>> = HOST_RATE_POLICIES,
    now: () => number = Date.now,
  ) {
    this.inner = inner;
    this.policies = policies;
    this.now = now;
  }

  // 测试用：某 host 当前桶状态（tokens 是浮点数，未消耗的部分令牌不会被四舍五入）。
  bucketOf(host: string): { tokens: number; lastRefill: number } | null {
    const bucket = this.buckets.get(host);
    return bucket ? { tokens: bucket.tokens, lastRefill: bucket.lastRefill } : null;
  }

  private bucketFor(host: string, policy: HostRatePolicy): Bucket {
    let bucket = this.buckets.get(host);
    if (!bucket) {
      // 初始满桶：允许冷启动时先打一波 burst，而不是从 0 开始等。
      bucket = { tokens: policy.burst, lastRefill: this.now() };
      this.buckets.set(host, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket, policy: HostRatePolicy): void {
    const now = this.now();
    const elapsedSec = Math.max(0, now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(policy.burst, bucket.tokens + elapsedSec * policy.rps);
    bucket.lastRefill = now;
  }

  // 拿到 1 个令牌为止——同步的检查+扣减发生在一个不含 await 的代码块里，
  // JS 单线程语义保证了并发调用之间不会插入进来（不需要额外加锁）。
  private async acquire(host: string, policy: HostRatePolicy): Promise<void> {
    const bucket = this.bucketFor(host, policy);
    for (;;) {
      this.refill(bucket, policy);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const deficit = 1 - bucket.tokens;
      // 轮询间隔按"还差多少令牌 / 补充速率"折算成毫秒；封顶一个较小的值，
      // 避免单次 setTimeout 睡过头导致醒来时其实已经攒够好几个令牌却没有
      // 及时释放给排队中的其他并发请求（多个请求都在等同一个桶时，粒度越粗，
      // 醒来后的调度越不公平）。
      const waitMs = Math.min(50, Math.max(1, Math.ceil((deficit / policy.rps) * 1000)));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // 键控是 host，不是 connector：`new URL(url).host` 是唯一的分桶依据。
  // 这是 V26 的核心——阴性对照①就是把这一行的分桶 key 改成调用方传入的 connector id，
  // 验证同主机并发测试会变红（结果贴在 docs/devlog/W5-2-c.md）。
  async request(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    let host: string | null;
    try {
      host = new URL(url).host;
    } catch {
      host = null; // 非法 URL：交给 inner http 的错误处理，不在这里判断。
    }
    const policy = host ? this.policies[host] : undefined;
    if (policy && host) await this.acquire(host, policy);
    return this.inner.request(url, init);
  }
}

export function rateLimitedHttp(inner: HttpClient = defaultHttp): HttpClient {
  return new RateLimitedHttp(inner);
}
