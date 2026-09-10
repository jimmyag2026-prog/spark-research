// V26（BACKLOG）：按 host 合池的限速器。核心不变式——**键控是 host，不是
// connector**：pubmed / ncbi / clinvar 三个 connector 都打
// eutils.ncbi.nlm.nih.gov，必须共享同一个令牌桶，而不是各自维护一份、合计把主机
// 限速打穿三倍。
//
// 本文件两类用例：
//   1. 确定性令牌桶数学（手动推进注入的 `now()`，不触发真实 setTimeout 等待、
//      不依赖真实时钟——快、稳）。
//   2. 真实并发场景（三个 eutils connector 共享一个 RateLimitedHttp 实例，40 个
//      并发调用打同一个 host，用真实 Date.now() 记录每次请求"被放行"的时刻，
//      断言任意 1 秒滑动窗口内的请求数 ≤ rps + burst）——用一套比生产 HOST_RATE_POLICIES
//      更快的合成策略（保持同一套机制，只是把 rps/burst 调大到测试能在几百毫秒内
//      跑完，避免真实 3 rps 需要等十几秒）。
//
// 阴性对照（①②，方法论）：这两条不是写成"切换开关"的常驻测试用例，而是在开发时
// 真跑的手工验证——①把 RateLimitedHttp.request() 里的分桶 key 从 `host` 改成
// 调用方传入的 connector id（模拟"按 connector 各自限速"的错误实现），重跑本文件的
// 「合池」用例，必须红；②把 ConnectorRegistry 构造函数里 `options.http ?? rateLimitedHttp()`
// 还原成不带默认值的 `options.http`（相当于摘掉限速器），同样必须红。
// 两次改坏 → 看红 → `git diff` 字节级复原的完整过程与原始输出贴在
// docs/devlog/W5-2-c.md，这里不重复贴（避免测试文件本身依赖会漂移的外部状态）。
import { describe, expect, test } from "bun:test";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";
import { HOST_RATE_POLICIES, RateLimitedHttp, rateLimitedHttp, type HostRatePolicy } from "../../backend/src/http/ratelimit";
import { PubMedConnector } from "../../backend/src/connectors/literature";
import { NCBIConnector } from "../../backend/src/connectors/genomics";
import { ClinVarConnector } from "../../backend/src/connectors/clinvar";

function jsonHttp(onRequest?: (url: string) => void): StubHttp {
  return new StubHttp((url) => {
    onRequest?.(url);
    return new BufferedResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ ok: true, url })),
    });
  });
}

// 任意长度为 windowMs 的滑动窗口内，最多落了多少个时间戳。
function maxInAnyWindow(timestamps: number[], windowMs: number): number {
  const sorted = [...timestamps].sort((a, b) => a - b);
  let max = 0;
  for (let i = 0; i < sorted.length; i++) {
    let count = 0;
    for (let j = i; j < sorted.length && sorted[j]! - sorted[i]! < windowMs; j++) count++;
    max = Math.max(max, count);
  }
  return max;
}

describe("令牌桶数学（确定性，手动推进虚拟时钟，无真实等待）", () => {
  const HOST = "ratelimit-math.test";
  const POLICY: Record<string, HostRatePolicy> = {
    [HOST]: { rps: 2, burst: 4, source: "test-only", verifiedDate: "2026-09-10" },
  };

  test("冷启动满桶：前 burst 次请求瞬间放行，之后按 rps 匀速回填", async () => {
    let virtualNow = 1_000_000;
    const calls: string[] = [];
    const limiter = new RateLimitedHttp(jsonHttp(() => calls.push("hit")), POLICY, () => virtualNow);
    const url = `https://${HOST}/x`;

    // burst=4：前 4 次不应该消耗任何"时间"（tokens 4→0），bucketOf 之前是 null
    // （还没建过桶），之后应该精确落到 0。
    expect(limiter.bucketOf(HOST)).toBeNull();
    for (let i = 0; i < 4; i++) await limiter.request(url);
    expect(calls.length).toBe(4);
    expect(limiter.bucketOf(HOST)?.tokens).toBeCloseTo(0, 5);

    // 手动推进虚拟时钟 1000ms（=1 秒）。rps=2 → 应该精确回填 2 个令牌（未触顶 burst=4）。
    virtualNow += 1000;
    await limiter.request(url); // 消费 1 个：2（回填）- 1（本次消耗）= 1
    expect(calls.length).toBe(5);
    expect(limiter.bucketOf(HOST)?.tokens).toBeCloseTo(1, 5);
  });

  test("回填封顶 burst，不会因为推进很久的时钟而无限累积令牌", async () => {
    let virtualNow = 0;
    const limiter = new RateLimitedHttp(jsonHttp(), POLICY, () => virtualNow);
    const url = `https://${HOST}/y`;
    await limiter.request(url); // 建桶：满桶 4，消费 1 → 3
    expect(limiter.bucketOf(HOST)?.tokens).toBeCloseTo(3, 5);

    virtualNow += 100_000; // 推进 100 秒；rps=2 理论回填 200，远超 burst=4
    // 触发一次 refill（通过再发一次请求）：应该封顶在 burst，而不是 3+200。
    await limiter.request(url);
    // 封顶 4，再消费 1 → 3。
    expect(limiter.bucketOf(HOST)?.tokens).toBeCloseTo(3, 5);
  });

  test("无策略的 host 直通：不建桶、不延迟", async () => {
    const calls: string[] = [];
    const limiter = new RateLimitedHttp(jsonHttp(() => calls.push("hit")), POLICY, () => 0);
    for (let i = 0; i < 20; i++) {
      await limiter.request("https://no-policy.example.test/z");
    }
    expect(calls.length).toBe(20);
    expect(limiter.bucketOf("no-policy.example.test")).toBeNull();
  });

  test("非法 URL：不抛在限速层，原样交给 inner http 处理", async () => {
    const inner = new StubHttp(() => {
      throw new Error("inner saw an invalid url, as expected");
    });
    const limiter = new RateLimitedHttp(inner, POLICY, () => 0);
    await expect(limiter.request("not a url")).rejects.toThrow(/inner saw an invalid url/);
  });
});

describe("HOST_RATE_POLICIES：生产策略表的结构完整性", () => {
  test("eutils.ncbi.nlm.nih.gov 策略齐全：数字、来源、核实日期都不缺（「没写来源的数字不许进表」）", () => {
    const policy = HOST_RATE_POLICIES["eutils.ncbi.nlm.nih.gov"];
    expect(policy).toBeDefined();
    expect(policy!.rps).toBe(3);
    expect(policy!.burst).toBeGreaterThan(0);
    expect(policy!.source.length).toBeGreaterThan(10);
    expect(policy!.source).toMatch(/^https?:\/\//);
    expect(policy!.verifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("rateLimitedHttp() 工厂函数默认走生产策略表", () => {
    const http = rateLimitedHttp(jsonHttp());
    expect(http).toBeInstanceOf(RateLimitedHttp);
    expect((http as RateLimitedHttp).bucketOf("eutils.ncbi.nlm.nih.gov")).toBeNull(); // 还没发过请求，未建桶
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V26 核心不变式：真实并发场景，三个 eutils connector 共享同一个按 host 键控的桶。
// ─────────────────────────────────────────────────────────────────────────────
describe("V26 · 按 host 合池（pubmed + ncbi + clinvar 共享 eutils.ncbi.nlm.nih.gov 的桶）", () => {
  const HOST = "eutils.ncbi.nlm.nih.gov";
  // 用比生产策略（3 rps）快得多的合成策略：机制完全一样（同一个 RateLimitedHttp
  // 类、同一套 refill 数学），只是把数字调大，让测试在几百毫秒内跑完，而不是
  // 真的等十几秒。断言的不变式（任意 1s 窗口 ≤ rps+burst）与生产策略下的不变式
  // 是同一条公式，与具体数字无关。
  const FAST_POLICY: Record<string, HostRatePolicy> = {
    [HOST]: { rps: 25, burst: 5, source: "test-only（比生产 3rps 快，验证同一套机制）", verifiedDate: "2026-09-10" },
  };

  test("40 个并发调用（pubmed.getPaper + ncbi.search + clinvar.search 混合）落在同一个桶，任意 1s 窗口 ≤ rps+burst", async () => {
    const timestamps: number[] = [];
    const stub = jsonHttp(() => timestamps.push(Date.now()));
    const limiter = new RateLimitedHttp(stub, FAST_POLICY);

    const pubmed = new PubMedConnector({ http: limiter });
    const ncbi = new NCBIConnector({ http: limiter });
    const clinvar = new ClinVarConnector({ http: limiter });

    const N = 40;
    const jobs: Array<() => Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      const kind = i % 3;
      if (kind === 0) jobs.push(() => pubmed.getPaper({ id: String(i) }));
      else if (kind === 1) jobs.push(() => ncbi.search({ query: `gene-${i}` }));
      else jobs.push(() => clinvar.search({ query: `variant-${i}` }));
    }

    const started = Date.now();
    await Promise.all(jobs.map((job) => job()));
    const elapsedMs = Date.now() - started;

    expect(timestamps.length).toBe(N);
    // 核心断言：任意 1 秒窗口内，落到这个 host 的请求数不超过 rps+burst——
    // 无论这些请求来自哪个 connector。改成按 connector id 键控会让这里变红
    // （三个桶各自 25+5=30，理论峰值能到 90，远超单桶的 30）——见文件头阴性对照①。
    const worst = maxInAnyWindow(timestamps, 1000);
    expect(worst).toBeLessThanOrEqual(FAST_POLICY[HOST]!.rps + FAST_POLICY[HOST]!.burst + 2); // +2 容忍真实定时器抖动

    // 摘掉限速器（inner http 直连）时，40 个请求会在同一个事件循环 tick 附近全部
    // 放行，elapsedMs 会趋近 0；有限速器时，(N-burst)/rps 的下限必须真实"花掉"——
    // 这条断言证明请求确实被拖慢了，而不只是窗口计数凑巧没超（见文件头阴性对照②）。
    const theoreticalMinMs = ((N - FAST_POLICY[HOST]!.burst) / FAST_POLICY[HOST]!.rps) * 1000;
    expect(elapsedMs).toBeGreaterThan(theoreticalMinMs * 0.5);
  });

  test("对照：单独一个 connector 打同一 host，同样遵守 rps+burst（合池不是「三个桶恰好没撞上」的巧合）", async () => {
    const timestamps: number[] = [];
    const stub = jsonHttp(() => timestamps.push(Date.now()));
    const limiter = new RateLimitedHttp(stub, FAST_POLICY);
    const pubmed = new PubMedConnector({ http: limiter });

    const N = 20;
    await Promise.all(Array.from({ length: N }, (_, i) => pubmed.getPaper({ id: String(i) })));

    expect(timestamps.length).toBe(N);
    const worst = maxInAnyWindow(timestamps, 1000);
    expect(worst).toBeLessThanOrEqual(FAST_POLICY[HOST]!.rps + FAST_POLICY[HOST]!.burst + 2);
  });

  // 这是 V26 阴性对照②真正覆盖到的测试：不给 ConnectorRegistry 传 http，
  // 走生产默认值 `options.http ?? rateLimitedHttp()`（registry.ts 构造函数），
  // 端到端验证真的会按**生产** HOST_RATE_POLICIES（3 rps / burst 3）节流——
  // 不是「构造没炸」这种弱验证。不打真实网络：mock 全局 fetch（NativeHttp 内部
  // 调的就是它）立即返回假响应，但限速器本身用的是真实 Date.now()/setTimeout，
  // 所以节流的"慢"是真实发生的，只是不需要真的等网络。
  //
  // 把 registry.ts 构造函数里的 `options.http ?? rateLimitedHttp()` 还原成
  // 不带默认值的 `options.http`（相当于摘掉限速器）后重跑这条用例，必须红——
  // elapsedMs 断言会失败（请求会在毫秒级全部放行，而不是被真实拖慢）。
  // 实测输出见 docs/devlog/W5-2-c.md。
  test("ConnectorRegistry 未显式传 http 时默认注入限速器，端到端真实按生产策略节流（V26 阴性对照②）", async () => {
    const { ConnectorRegistry } = await import("../../backend/src/connectors/registry");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const registry = new ConnectorRegistry().registerBuiltins();
      const N = 5; // 生产策略 rps=3, burst=3：理论最短耗时 (5-3)/3 ≈ 0.67s
      const started = Date.now();
      await Promise.all(
        Array.from({ length: N }, (_, i) => registry.call("clinvar", "search", { query: `smoke-${i}` })),
      );
      const elapsedMs = Date.now() - started;
      expect(fetchCalls).toBe(N);
      // 没有限速器时，5 个 mock fetch 调用会在几毫秒内全部完成；
      // 有生产策略（3rps/burst3）节流时，理论下限 ~667ms——给足抖动余量，
      // 断言明显大于"零延迟"的量级即可，不追求卡着理论值。
      expect(elapsedMs).toBeGreaterThan(300);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("测试/fixture 场景显式传入 http 时，registry 原样使用，不会被再包一层限速器（确定性不受影响）", async () => {
    const { ConnectorRegistry } = await import("../../backend/src/connectors/registry");
    const calls: string[] = [];
    const stub = jsonHttp((url) => calls.push(url));
    const registry = new ConnectorRegistry({ http: stub }).registerBuiltins();
    // 20 个并发请求同一个 eutils host：如果 registry 偷偷又包了一层限速器，
    // 这些请求会被拖慢；用 StubHttp 本身不带延迟的特性反证——全部应该在同一个
    // 事件循环 tick 附近完成（不依赖真实等待），而不是被拖到 (20-burst)/rps 秒之后。
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => registry.call("clinvar", "search", { query: `x-${i}` })),
    );
    const elapsedMs = Date.now() - started;
    expect(calls.length).toBe(20);
    expect(elapsedMs).toBeLessThan(500); // 生产 3rps 策略下 20 个请求真限速会花 ~6s+，这里应该毫秒级完成
  });
});
