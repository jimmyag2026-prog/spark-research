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
    expect(res.content).toContain("timeout");
    expect(elapsed).toBeLessThan(5_000);
  });

  test("kimi 调用超时与 HTTP 错误在 content 里可区分（D-2 要求：能分辨超时 vs 上游报错）", async () => {
    const timeoutRouter = new LLMRouter(
      { KIMI_API_KEY: "test-key" },
      { fetchImpl: neverRespondingFetch(), timeoutMs: 150 },
    );
    const timeoutRes = await timeoutRouter.call([{ role: "user", content: "hi" }], "kimi-k2");
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.content).toContain("timeout");

    const httpErrorFetch: typeof fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const errorRouter = new LLMRouter({ KIMI_API_KEY: "test-key" }, { fetchImpl: httpErrorFetch });
    const errorRes = await errorRouter.call([{ role: "user", content: "hi" }], "kimi-k2");
    expect(errorRes.ok).toBe(false);
    expect(errorRes.content).toContain("HTTP 500");
    // 两条失败路径的文案必须不同，调用方（orchestrator 的 D-4 检查）不需要靠猜就能
    // 区分「网络/超时没有落地」与「上游给了一个明确的错误状态码」。
    expect(errorRes.content).not.toContain("timeout");
  });

  test("timeoutMs 未传时仍走模块级默认（构造函数签名向后兼容：不传第二个参数）", () => {
    // 既有调用点 `new LLMRouter()` / `new LLMRouter(env)`（literature/cli.ts、
    // orchestrator.ts、server/context.ts 等）不改代码也必须继续工作。
    expect(() => new LLMRouter()).not.toThrow();
    expect(() => new LLMRouter({})).not.toThrow();
  });
});
