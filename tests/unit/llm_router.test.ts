import { describe, expect, test } from "bun:test";
import { LLMRouter } from "../../backend/src/llm/router";

// D-2（P10-b）：router 的 openrouter/kimi 调用之前是裸 fetch，无超时——一次卡住的
// 模型调用会让整个 orchestrator 流程永久挂起。这里用 fetchImpl 注入一个「永不响应，
// 但正确响应 AbortSignal」的假实现（真实 fetch 在超时场景下就是这样：abort 触发时
// fetch() 本身 reject 一个 AbortError），不需要 monkey-patch 全局 fetch。

function neverRespondingFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }
    });
  }) as unknown as typeof fetch;
}

describe("LLMRouter 超时（D-2）", () => {
  test("openrouter 调用在 timeoutMs 内返回可见的 ok:false 超时错误，而不是挂死", async () => {
    const router = new LLMRouter(
      { OPENROUTER_API_KEY: "test-key" },
      { fetchImpl: neverRespondingFetch(), timeoutMs: 200 },
    );
    const started = Date.now();
    const res = await router.call(
      [{ role: "user", content: "hello" }],
      "moonshotai/kimi-k2.6",
    );
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    // AD-13：失败时 content 恒空，错误只在 error 字段。
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("timeout");
    expect(res.error?.message).toContain("未返回");
    expect(elapsed).toBeLessThan(5_000);
  });

  test("kimi 调用超时与 HTTP 错误可被机器区分（error.kind，不靠读文案）", async () => {
    const timeoutRouter = new LLMRouter(
      { KIMI_API_KEY: "test-key" },
      { fetchImpl: neverRespondingFetch(), timeoutMs: 150 },
    );
    const timeoutRes = await timeoutRouter.call([{ role: "user", content: "hi" }], "kimi-k2");
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.content).toBe("");
    expect(timeoutRes.error?.kind).toBe("timeout");

    const httpErrorFetch: typeof fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const errorRouter = new LLMRouter({ KIMI_API_KEY: "test-key" }, { fetchImpl: httpErrorFetch });
    const errorRes = await errorRouter.call([{ role: "user", content: "hi" }], "kimi-k2");
    expect(errorRes.ok).toBe(false);
    expect(errorRes.content).toBe("");
    // 两条失败路径必须能被调用方区分开，而且**不靠读文案**：
    // P11 起 error.kind 是机器可读的枚举，「网络/超时没有落地」是 "timeout"，
    // 「上游给了明确错误状态码」是 "upstream"/"auth"/"rate_limit"。
    expect(errorRes.error?.kind).toBe("upstream");
    expect(errorRes.error?.message).toContain("HTTP 500");
    expect(errorRes.error?.retryable).toBe(true);
  });

  test("timeoutMs 未传时仍走模块级默认（构造函数签名向后兼容：不传第二个参数）", () => {
    // 既有调用点 `new LLMRouter()` / `new LLMRouter(env)`（literature/cli.ts、
    // orchestrator.ts、server/context.ts 等）不改代码也必须继续工作。
    expect(() => new LLMRouter()).not.toThrow();
    expect(() => new LLMRouter({})).not.toThrow();
  });
});
