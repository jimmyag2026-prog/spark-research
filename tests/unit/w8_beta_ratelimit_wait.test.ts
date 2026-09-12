// v0.8 W8-1 β · V63：`RateLimitedHttp.request()` 此前把令牌桶等待时长折进总耗时，
// 但从没透出给调用方——`connectors/base.ts` 的 `recordApiCall()` 里 `rateLimitWaitMs`
// 恒为 0（见 usage/api_ledger.ts 改动前的字段注释）。本文件覆盖两件事：
//   1. ratelimit.ts 层：令牌桶耗尽后 `request()` 返回值带上真实等待毫秒（>0），
//      令牌充足时为 0；`RateLimitedResponse` 仍然满足 `HttpClient` 接口（不改调用方语义）。
//   2. connectors/base.ts 层：这个数字真的被读出来写进了 api_calls.jsonl 台账。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";
import { RateLimitedHttp, type HostRatePolicy } from "../../backend/src/http/ratelimit";
import { HttpConnector, type ConnectorOptions } from "../../backend/src/connectors/base";
import { ApiCallStore, apiCallStorePath } from "../../backend/src/usage/api_ledger";

function jsonHttp(): StubHttp {
  return new StubHttp(
    () =>
      new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ ok: true })),
      }),
  );
}

describe("V63 · RateLimitedHttp.request() 透出真实等待毫秒", () => {
  const HOST = "ratelimit-wait.test";
  const POLICY: Record<string, HostRatePolicy> = {
    [HOST]: { rps: 2, burst: 1, source: "test-only", verifiedDate: "2026-09-12" },
  };

  test("令牌充足（burst 内）：rateLimitWaitMs = 0", async () => {
    let virtualNow = 0;
    const limiter = new RateLimitedHttp(jsonHttp(), POLICY, () => virtualNow);
    const res = await limiter.request(`https://${HOST}/x`);
    expect(res.rateLimitWaitMs).toBe(0);
  });

  test("令牌耗尽：第二次调用 rateLimitWaitMs > 0，且约等于用虚拟时钟推进的等待时长", async () => {
    let virtualNow = 0;
    const limiter = new RateLimitedHttp(jsonHttp(), POLICY, () => virtualNow);
    const first = await limiter.request(`https://${HOST}/x`); // burst=1：瞬间放行，桶到 0
    expect(first.rateLimitWaitMs).toBe(0);

    // 第二次调用时桶是空的，acquire() 内部会 setTimeout 真实等待——但虚拟时钟不会自己走，
    // 所以在等待期间手动把 virtualNow 推过去，模拟"时间流逝、令牌攒够了"。
    const pending = limiter.request(`https://${HOST}/y`);
    // rps=2 → 补满 1 个令牌需要 500ms；分两步推进，确保至少经过一次轮询循环。
    await Bun.sleep(5);
    virtualNow += 300;
    await Bun.sleep(5);
    virtualNow += 300;
    const second = await pending;
    expect(second.rateLimitWaitMs).toBeGreaterThan(0);
    // 上界：总共推进了 600ms 的虚拟时间，等待时长不应该超出这个量级太多。
    expect(second.rateLimitWaitMs).toBeLessThanOrEqual(650);
  });

  test("无策略 host：直通，rateLimitWaitMs = 0", async () => {
    const limiter = new RateLimitedHttp(jsonHttp(), POLICY, () => 0);
    const res = await limiter.request("https://no-policy.ratelimit-wait.test/z");
    expect(res.rateLimitWaitMs).toBe(0);
  });
});

describe("V63 · connectors/base.ts 把 rateLimitWaitMs 写进 api_calls 台账", () => {
  const HOST = "connector-ratelimit-wait.test";
  const POLICY: Record<string, HostRatePolicy> = {
    [HOST]: { rps: 5, burst: 1, source: "test-only", verifiedDate: "2026-09-12" },
  };

  class ProbeConnector extends HttpConnector {
    constructor(options: ConnectorOptions) {
      super(
      "probe",
      { baseUrl: `https://${HOST}/`, description: "test", tools: [{ name: "ping", description: "ping", endpoint: "ping" }] },
      options,
    );
    }
  }

  test("令牌桶耗尽 → 第二次调用 waitMs > 0 且台账记到（非 0）", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "w8-beta-ratelimit-"));
    let virtualNow = 0;
    const limiter = new RateLimitedHttp(jsonHttp(), POLICY, () => virtualNow);
    const store = new ApiCallStore(apiCallStorePath({ root: dataDir }));
    const connector = new ProbeConnector({ http: limiter });
    // recordApiCall() 内部按「不传 store 就自己 new 一个走 apiCallStorePath(configOptions)」
    // 的口径找路径——connectors/base.ts 没有 configOptions 注入口，这里改用同一份
    // SPARK_RESEARCH_DATA_DIR 环境变量（与全局 bunfig 隔离测试同一套机制）在本用例内
    // 临时切换，调用完立即还原，避免污染其它并行用例。
    const prevDataDir = process.env.SPARK_RESEARCH_DATA_DIR;
    process.env.SPARK_RESEARCH_DATA_DIR = dataDir;
    try {
      await connector.call("ping"); // burst=1：第一次瞬间放行
      const pending = connector.call("ping"); // 第二次：桶空，真实等待
      await Bun.sleep(5);
      virtualNow += 500; // rps=5 → 200ms 补满 1 个令牌，给足余量
      await Bun.sleep(5);
      virtualNow += 500;
      await pending;
    } finally {
      if (prevDataDir === undefined) delete process.env.SPARK_RESEARCH_DATA_DIR;
      else process.env.SPARK_RESEARCH_DATA_DIR = prevDataDir;
    }

    expect(existsSync(store.path())).toBe(true);
    const lines = readFileSync(store.path(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].rateLimitWaitMs).toBe(0);
    expect(lines[1].rateLimitWaitMs).toBeGreaterThan(0);
  });
});
