import { describe, expect, test } from "bun:test";
import { AMinerConnector } from "../../backend/src/connectors/aminer";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";

// W8-1 α · V73：AMiner 间歇 401 的历史台账复核（见 docs/devlog/W8-alpha.md）。
//
// 只读统计结论（对 ~/.spark-research/api_calls.polluted-2026-09-11.jsonl，4907 次
// aminer 调用、91 次 401）：401 从不连续出现，且 78.9% 发生在与上一次 aminer 调用
// 间隔 >30s 之后（对照 200 只有 0.83%）——像是空闲后鉴权/会话失效，不是高并发限速
// （v0.6 R2 已排除后者，12 并发 burst 实测 0 个 401）。这是「可复现」（数据里有
// 稳定统计模式）的判定，按 V73 纪律修一个保守版本：401 只重试一次。

function fakeStore(values: Record<string, string> | null) {
  return {
    has: () => values !== null,
    get: () => values,
  };
}

describe("AMinerConnector · V73 401 重试一次", () => {
  test("第一次 401、第二次 200 → search 透明重试后成功，只多发一次请求", async () => {
    let calls = 0;
    const http = new StubHttp(() => {
      calls++;
      if (calls === 1) return new BufferedResponse({ status: 401, headers: {}, body: new Uint8Array() });
      return new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ code: 200, data: { hitList: [{ title: "T", year: 2020 }] } })),
      });
    });
    const connector = new AMinerConnector({ credentials: fakeStore({ api_key: "fake-token" }), http });
    const result = (await connector.search({ query: "AlphaFold" })) as { data: { hitList: unknown[] } };
    expect(calls).toBe(2);
    expect(result.data.hitList.length).toBe(1);
  });

  test("getPaper 同样重试一次：第一次 401、第二次 200 → 成功", async () => {
    let calls = 0;
    const http = new StubHttp(() => {
      calls++;
      if (calls === 1) return new BufferedResponse({ status: 401, headers: {}, body: new Uint8Array() });
      return new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ code: 200, data: [{ title: "T" }] })),
      });
    });
    const connector = new AMinerConnector({ credentials: fakeStore({ api_key: "fake-token" }), http });
    const result = (await connector.getPaper({ ids: ["abc123"] })) as { data: unknown[] };
    expect(calls).toBe(2);
    expect(result.data.length).toBe(1);
  });

  test("连续两次 401（真凭据失效场景）→ 不无限重试，原样抛出第二次的错误", async () => {
    let calls = 0;
    const http = new StubHttp(() => {
      calls++;
      return new BufferedResponse({ status: 401, headers: {}, body: new Uint8Array() });
    });
    const connector = new AMinerConnector({ credentials: fakeStore({ api_key: "fake-token" }), http });
    let message = "";
    try {
      await connector.search({ query: "AlphaFold" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // 只重试一次：总共 2 次请求（1 次原始 + 1 次重试），不是 3 次、不是无限次。
    expect(calls).toBe(2);
    expect(message).toContain("HTTP 401");
  });

  test("非 401 的失败（如 500）不触发重试——只有 401 是本次修法的目标", async () => {
    let calls = 0;
    const http = new StubHttp(() => {
      calls++;
      return new BufferedResponse({ status: 500, headers: {}, body: new Uint8Array() });
    });
    const connector = new AMinerConnector({ credentials: fakeStore({ api_key: "fake-token" }), http });
    let message = "";
    try {
      await connector.search({ query: "AlphaFold" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(calls).toBe(1);
    expect(message).toContain("HTTP 500");
  });
});
