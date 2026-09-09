import { describe, expect, test } from "bun:test";
import { LLMRouter } from "../../backend/src/llm/router";

// D-2（P10-b）验收 2/4：LLM 调用路径。
//
// 注入一个「永不响应，但正确响应 AbortSignal」的假 fetch 实现（不需要打真实网络，
// 也不需要 monkey-patch 全局 fetch——LLMRouter 现在支持注入 fetchImpl），断言
// router.call() 在短超时内返回一个可见的 ok:false + 超时说明，而不是让调用方
// （orchestrator 的 plan/summarize/analysis/subagent 四处调用点）永久挂起。

function neverRespondingFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as unknown as typeof fetch;
}

describe("D-2 验收：LLM 调用路径不会挂死", () => {
  test("上游永不响应时，router.call() 在短超时内返回可见的超时错误（ok:false）", async () => {
    const router = new LLMRouter(
      { OPENROUTER_API_KEY: "test-key" },
      { fetchImpl: neverRespondingFetch(), timeoutMs: 200 },
    );
    const started = Date.now();
    const res = await router.call([{ role: "user", content: "hello" }], "moonshotai/kimi-k2.6");
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.content.toLowerCase()).toContain("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3_000);
  });
});
