import { describe, expect, test } from "bun:test";
import { HttpTimeoutError, NativeHttp } from "../../backend/src/http/client";

// D-2（P10-b）验收 1/4：connector 检索路径经 HttpClient。
//
// 所有文献/蛋白/化学等 connector（backend/src/connectors/base.ts，lane D-a 同期在改，
// 不在本 lane 改动范围）最终都通过 NativeHttp.request() 打网络。这里直接在
// HttpClient 这一层注入一个「永不响应」的假上游（monkey-patch globalThis.fetch，
// 正确响应 AbortSignal——这是真实 fetch 超时时的实际行为），断言在**短超时**下
// 请求返回一个可见的、结构化的超时错误，而不是让整条检索链路永久挂起。
// 超时本身设得很短（200ms），CI 不需要真等默认的 30s。

function neverRespondingFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // 不支持 abort 的上游：故意永远挂着，逼近最坏情况。
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

describe("D-2 验收：connector 检索路径（经 HttpClient）不会挂死", () => {
  test("上游永不响应时，NativeHttp 在短超时内返回可见的 HttpTimeoutError", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = neverRespondingFetch();
    try {
      const http = new NativeHttp();
      const started = Date.now();
      const outcome = await http
        .request("https://example.invalid/literature/search", { timeoutMs: 200 })
        .then((res) => ({ kind: "response" as const, res }))
        .catch((err) => ({ kind: "error" as const, err }));
      const elapsed = Date.now() - started;

      expect(outcome.kind).toBe("error");
      if (outcome.kind === "error") {
        expect(outcome.err).toBeInstanceOf(HttpTimeoutError);
        expect((outcome.err as Error).message).toContain("timed out");
      }
      // 断言真的是被超时打断，而不是巧合地在测试超时前完成。
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      globalThis.fetch = original;
    }
  });
});
