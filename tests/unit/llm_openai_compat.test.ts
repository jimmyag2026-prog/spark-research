import { describe, expect, test } from "bun:test";
import { OpenAiCompatAdapter } from "../../backend/src/llm/providers/openai_compat";
import type { ProviderRequest } from "../../backend/src/llm/providers/types";

// V134：OpenAiCompatAdapter had no dedicated unit test file before this fix (only
// exercised indirectly through router.ts tests with mocked adapters). This file
// covers just the timeout-gap negative control the v0.8.1 external review found —
// it is not meant to backfill full coverage of the adapter.

function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    options: {},
    apiKey: "sk-test",
    baseUrl: "",
    timeoutMs: 5_000,
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })) as unknown as typeof fetch,
    ...overrides,
  };
}

/** 200 OK，body 是一个永不发送数据、也不 close 的流——模拟上游挂起。 */
function hangingStreamFetch(): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // 故意什么都不做。
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function hangingJsonFetch(): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // 故意什么都不做。
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("V134：超时覆盖流式/正文读取，不只是 fetch() 本身", () => {
  test("200 OK 之后流式 body 挂起 → 在 timeoutMs 内返回 timeout 失败，而不是永久挂起", async () => {
    const adapter = new OpenAiCompatAdapter({ id: "test", baseUrl: "https://example.invalid" });
    const started = Date.now();
    const res = await adapter.call(
      baseRequest({ fetchImpl: hangingStreamFetch(), timeoutMs: 50, options: { onDelta: () => {} } }),
    );
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.content).toBe("");
    expect(res.error.kind).toBe("timeout");
    expect(res.error.retryable).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("200 OK 之后非流式 body 挂起 → 在 timeoutMs 内返回 timeout 失败", async () => {
    const adapter = new OpenAiCompatAdapter({ id: "test", baseUrl: "https://example.invalid" });
    const started = Date.now();
    const res = await adapter.call(baseRequest({ fetchImpl: hangingJsonFetch(), timeoutMs: 50 }));
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.content).toBe("");
    expect(res.error.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(2_000);
  });

  test("正常 200 OK 非流式响应仍然成功（回归：改动没有破坏正常路径）", async () => {
    const adapter = new OpenAiCompatAdapter({ id: "test", baseUrl: "https://example.invalid" });
    const res = await adapter.call(baseRequest());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.content).toBe("ok");
  });
});
