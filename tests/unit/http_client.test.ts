import { describe, expect, test } from "bun:test";
import { HttpTimeoutError, NativeHttp } from "../../backend/src/http/client";

// D-2（P10-b）：NativeHttp 之前是裸 fetch，无超时——任一上游挂起就是整条 connector
// 检索链路永久卡死。这里不打真实网络，monkey-patch `globalThis.fetch` 模拟一个
// 「永不响应，但会正确响应 AbortSignal」的上游（这是真实 fetch 在超时场景下的
// 实际行为：abort 触发时 fetch() 本身会 reject）。

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
      // 故意不 resolve：模拟一个永远不返回的上游。
    });
  }) as unknown as typeof fetch;
}

describe("NativeHttp 超时（D-2）", () => {
  test("永不响应的上游在 timeoutMs 内抛出可见的 HttpTimeoutError，而不是挂死", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = neverRespondingFetch();
    try {
      const http = new NativeHttp();
      const started = Date.now();
      let caught: unknown;
      try {
        await http.request("https://example.invalid/never", { timeoutMs: 200 });
      } catch (err) {
        caught = err;
      }
      const elapsed = Date.now() - started;
      expect(caught).toBeInstanceOf(HttpTimeoutError);
      expect((caught as HttpTimeoutError).timeout).toBe(true);
      expect((caught as Error).message).toContain("timed out");
      // 明显小于「真的等了很久」——留足 CI 抖动空间，但要证明不是靠自然挂死撞上的。
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("timeoutMs<=0 显式关闭超时：请求正常完成不受影响", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const http = new NativeHttp();
      const res = await http.request("https://example.invalid/ok", { timeoutMs: 0 });
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("上游返回正常响应时不受超时机制干扰", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    try {
      const http = new NativeHttp();
      // 故意不传 timeoutMs：这是 connectors/base.ts（lane D-a）实际的调用形态——
      // 字段必须可选，缺席时套默认超时也不能妨碍一次正常快速返回的请求。
      const res = await http.request("https://example.invalid/fast");
      expect(res.ok).toBe(true);
      expect(await res.text()).toBe("hello");
    } finally {
      globalThis.fetch = original;
    }
  });
});
