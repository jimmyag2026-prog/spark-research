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
/**
 * α-5（v0.10，U55）：**同一家服务的多个 host 要共用一个桶**。
 * arXiv 的检索走 `export.arxiv.org`、PDF 直链走 `arxiv.org`——按 host 分桶时这两条
 * 路各自 3s 一次，对 arXiv 来说就是 1.5s 一次，正好是 U55 探针「3s 间隔第二次仍
 * 429」的成因之一。这张表把 host 映射到**桶键**；没进表的 host，桶键 = host 本身。
 */
export const HOST_BUCKET_GROUPS: Readonly<Record<string, string>> = {
  "arxiv.org": "arxiv.org",
  "www.arxiv.org": "arxiv.org",
  "export.arxiv.org": "arxiv.org",
};

export function bucketKeyForHost(host: string): string {
  return HOST_BUCKET_GROUPS[host] ?? host;
}

/** `Retry-After` 等待的上限：再久也不值得把整条流程挂在这里（任务书定 60s）。 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * 解析 `Retry-After`：秒数或 HTTP-date 两种形态（RFC 9110 §10.2.3）。
 * 解析不出来、是负数、或超过上限 → 返回 null / 截到上限，**绝不无限等**。
 */
export function parseRetryAfterMs(raw: string | undefined, now: number): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delta = date - now;
  if (delta <= 0) return null;
  return Math.min(delta, MAX_RETRY_AFTER_MS);
}

export const HOST_RATE_POLICIES: Readonly<Record<string, HostRatePolicy>> = {
  // α-5（v0.10）：arXiv。W10-0 复测本机 IP 仍在惩罚名单（1 req/3s × 10 → 0 次 200），
  // 所以这条策略的 DONE **不是「能拿到 200」**，而是「不浪费一次请求」：
  // 3s 一次、检索与 PDF 共用一桶、收到带 Retry-After 的 429 就按它冷却（上限 60s），
  // 冷却期内一次请求都不发。桶键是上面 HOST_BUCKET_GROUPS 归并出来的 "arxiv.org"。
  "arxiv.org": {
    rps: 1 / 3,
    burst: 1,
    source: "https://info.arxiv.org/help/api/tou.html（arXiv API Terms of Use：请求之间至少间隔 3 秒）",
    verifiedDate: "2026-09-15",
    note:
      "官方 TOU 要求 ≥3s 间隔、单连接串行。export.arxiv.org（检索）与 arxiv.org（PDF 直链）" +
      "映射到同一个桶键，否则两条路各 3s = 对 arXiv 1.5s 一次。W10-0 实测本机 IP 仍被封，" +
      "能否 200 不由本策略决定。",
  },
  // alpha.6（R4 P1-7）：深池 30/源 × 四课题并发把 OpenAlex 匿名池打成 100% 429。官方上限 10 rps / 10 万天；
  // 礼貌池要 mailto（config `contactEmail`），未设置时更容易被限。这里按官方 rps 合池，不放宽。
  "api.openalex.org": {
    rps: 10,
    burst: 10,
    source: "https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication",
    verifiedDate: "2026-09-11",
    note: "官方：每秒 10 请求、每天 10 万；带 mailto 进礼貌池。spark-research 的 contactEmail 配置就是那个 mailto。",
  },
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

/**
 * V63（v0.8 W8-1 β）：`request()` 的返回值在普通 `HttpResponse` 之上多带一个
 * `rateLimitWaitMs`——这次调用在 `acquire()` 里真实等了多久（无策略/未触发等待时为 0）。
 * **不改调用方语义**：`RateLimitedHttp implements HttpClient`，`HttpClient.request()`
 * 的返回类型是 `Promise<HttpResponse>`——`RateLimitedResponse extends HttpResponse`
 * 是它的子类型，方法返回类型协变，仍然满足接口；不关心这个字段的调用方（绝大多数
 * `HttpClient` 消费方）原样把它当 `HttpResponse` 用，行为逐字节不变。只有读得懂
 * `RateLimitedResponse` 形状的调用方（connectors/base.ts）才会去读这个额外字段。
 */
export interface RateLimitedResponse extends HttpResponse {
  /** α-5 起，这个数把「令牌桶排队」与「上游 Retry-After 冷却」两段等待都算进去。 */
  rateLimitWaitMs: number;
}

// 标准令牌桶：容量 = burst，持续按 rps（token/秒）速率补充，封顶容量。
// 对任意长度为 T 秒的窗口，可消耗的令牌数上限是 `burst + rps * T`——
// T=1s 时正好对应 HOST_RATE_POLICIES 里 `rps + burst` 的口径
// （tests/concurrency/host_ratelimit.test.ts 断言的就是这条不变式）。
export class RateLimitedHttp implements HttpClient {
  private buckets = new Map<string, Bucket>();
  // α-5：桶键 → 冷却截止时刻（上游 429 的 Retry-After 给的）。冷却期内**一个请求都不发**。
  private cooldownUntil = new Map<string, number>();
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
  // 参数按 host 传，内部归一到桶键——调用方不必知道 arxiv 两个 host 共桶这件事。
  bucketOf(host: string): { tokens: number; lastRefill: number } | null {
    const bucket = this.buckets.get(bucketKeyForHost(host));
    return bucket ? { tokens: bucket.tokens, lastRefill: bucket.lastRefill } : null;
  }

  /** 测试/诊断用：某 host 所在桶的冷却截止时刻（没有冷却时为 null）。 */
  cooldownOf(host: string): number | null {
    return this.cooldownUntil.get(bucketKeyForHost(host)) ?? null;
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
  // V63：返回值从 void 改成「这次真实等了多少毫秒」——用同一个 `this.now()`（测试注入的
  // 虚拟时钟或生产的 Date.now）在进入前后各采一次样，与 refill() 用的时钟同源，口径一致；
  // 立刻拿到令牌（无需等待）时返回 0。
  private async acquire(key: string, policy: HostRatePolicy): Promise<number> {
    const start = this.now();
    const bucket = this.bucketFor(key, policy);
    for (;;) {
      this.refill(bucket, policy);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return Math.max(0, this.now() - start);
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

  /**
   * α-5：冷却闸——上游明确说了「Retry-After 秒后再来」，那期间**一个请求都不发**。
   * 与令牌桶是两件事：桶管稳态节奏，冷却管「上游已经在生气」，谁也替代不了谁。
   * 无策略的 host 也走这一条（收到过带 Retry-After 的 429 就该听话），所以它独立于 acquire。
   */
  private async waitCooldown(key: string): Promise<number> {
    const start = this.now();
    for (;;) {
      const until = this.cooldownUntil.get(key);
      if (until === undefined) return Math.max(0, this.now() - start);
      const remaining = until - this.now();
      if (remaining <= 0) { this.cooldownUntil.delete(key); return Math.max(0, this.now() - start); }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
  }

  // 键控是 host，不是 connector：`new URL(url).host` 是唯一的分桶依据。
  // 这是 V26 的核心——阴性对照①就是把这一行的分桶 key 改成调用方传入的 connector id，
  // 验证同主机并发测试会变红（结果贴在 docs/devlog/W5-2-c.md）。
  async request(url: string, init?: HttpRequestInit): Promise<RateLimitedResponse> {
    let host: string | null;
    try {
      host = new URL(url).host;
    } catch {
      host = null; // 非法 URL：交给 inner http 的错误处理，不在这里判断。
    }
    // α-5：策略与分桶都按**桶键**查（默认 = host；arxiv 的两个 host 归并成一个）。
    const key = host ? bucketKeyForHost(host) : null;
    const policy = key ? this.policies[key] : undefined;
    const cooldownWaitMs = key ? await this.waitCooldown(key) : 0;
    const rateLimitWaitMs = cooldownWaitMs + (policy && key ? await this.acquire(key, policy) : 0);
    const response = await this.inner.request(url, init);
    // α-5：上游说「等一会儿」就记下冷却截止时刻，下一次请求在闸前等，而不是发出去再挨一次 429。
    // **只在有 Retry-After 头时生效**：没有头就没有可核实的数字，不自己编一个退避。
    if (key && response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers["retry-after"], this.now());
      if (retryAfterMs !== null) {
        const until = this.now() + retryAfterMs;
        this.cooldownUntil.set(key, Math.max(until, this.cooldownUntil.get(key) ?? 0));
      }
    }
    // V63：原地挂一个字段而不是 `{...response}` 展开——`BufferedResponse.ok` 是
    // prototype 上的 getter，spread 只拷贝自有可枚举属性会把它丢掉；`Object.assign`
    // 保留原型/方法，只加这一个字段，`inner` 返回的对象不会被其他持有者提前读取。
    return Object.assign(response, { rateLimitWaitMs });
  }
}

export function rateLimitedHttp(inner: HttpClient = defaultHttp): HttpClient {
  return new RateLimitedHttp(inner);
}

// α-5：**进程内共享的**限速器。「PDF 直链与检索共用一桶」这条 DONE 靠它兑现——
// 每个 ConnectorRegistry / PdfDownloader 各 new 一个装饰器，桶状态就各算各的，
// 桶键归并得再对也没用。生产路径（未显式注入 http）一律经这一个实例；
// 测试注入 StubHttp/FixtureHttp 时不经过它，确定性不受影响。
let sharedInstance: RateLimitedHttp | null = null;
export function sharedRateLimitedHttp(): HttpClient {
  if (!sharedInstance) sharedInstance = new RateLimitedHttp(defaultHttp);
  return sharedInstance;
}
