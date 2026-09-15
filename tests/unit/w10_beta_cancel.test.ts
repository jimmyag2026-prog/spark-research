// v0.10 lane β · β-4 取消（V156 ③：/stream 断开 → AbortSignal 透传 → 台账不再增行）。
//
// 被测面分三层，每层一条：
//   ① HttpClient 认调用方的 signal，且**不把取消伪装成超时**；
//   ② ConnectorRegistry.call 把 signal 递到真正发请求的那一处（接线，不只是形状）；
//   ③ 台账：signal 一 abort，后续调用不再往 usage.jsonl 写新行。
// `/stream` 那一端（`routes/session.ts` 建 AbortController、`orchestrator.chat()` 透传
// 到 `llmFor`）是收口专属文件，diff 在 `docs/devlog/W10-beta.md`「收口 diff」段。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpTimeoutError, NativeHttp, StubHttp, type HttpRequestInit } from "../../backend/src/http/client";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { HttpConnector } from "../../backend/src/connectors/base";
import { UsageStore, usageTrackingLlm } from "../../backend/src/usage/ledger";
import type { ChatMessage, CallOptions, LlmResponse } from "../../backend/src/llm/types";

/** 永不响应但正确响应 AbortSignal 的上游（同 tests/unit/http_client.test.ts 的口径）。 */
function neverRespondingFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    })) as unknown as typeof fetch;
}

describe("β-4 ① · HttpClient 认调用方的取消信号", () => {
  test("请求在飞时 abort → 立刻抛出；**不是** HttpTimeoutError（取消 ≠ 上游慢）", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = neverRespondingFetch();
    try {
      const controller = new AbortController();
      const started = Date.now();
      const pending = new NativeHttp().request("https://example.invalid/never", { timeoutMs: 60_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      let caught: unknown;
      try { await pending; } catch (e) { caught = e; }
      expect(caught).toBeTruthy();
      expect(caught, "取消被伪装成超时：重试逻辑会把「用户不要了」当成「上游慢」再打一次").not.toBeInstanceOf(HttpTimeoutError);
      expect(Date.now() - started).toBeLessThan(5_000); // 没有等到 60s 超时
    } finally {
      globalThis.fetch = original;
    }
  });

  test("超时仍旧是 HttpTimeoutError（老行为没被取消逻辑改掉）", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = neverRespondingFetch();
    try {
      const controller = new AbortController(); // 给了 signal 但从不 abort
      let caught: unknown;
      try {
        await new NativeHttp().request("https://example.invalid/never", { timeoutMs: 150, signal: controller.signal });
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(HttpTimeoutError);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("β-4 ② · ConnectorRegistry.call 把 signal 递到发请求那一处", () => {
  const config = {
    baseUrl: "https://example.invalid/api/",
    description: "gate",
    domain: "literature",
    tools: [{ name: "search", endpoint: "search", description: "s" }],
  };

  test("接线：registry.call(..., { signal }) → HttpClient 收到的 init.signal 是同一个对象", async () => {
    const seen: HttpRequestInit[] = [];
    const http = new StubHttp((_url, init) => {
      seen.push(init);
      return StubHttp.json({ results: [] }).request(_url, init) as never;
    });
    const registry = new ConnectorRegistry({ http });
    registry.registerCustom("gate-source", config as never);
    const controller = new AbortController();
    await registry.call("gate-source", "search", { query: "rsi" }, { signal: controller.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal, "signal 没到 HttpClient —— 透传断在 registry 或 base.requestRaw").toBe(controller.signal);
  });

  test("不给 signal = 与接线前一字不差（init 里没有这个字段）", async () => {
    const seen: HttpRequestInit[] = [];
    const http = new StubHttp((_url, init) => {
      seen.push(init);
      return StubHttp.json({ results: [] }).request(_url, init) as never;
    });
    const registry = new ConnectorRegistry({ http });
    registry.registerCustom("gate-source", config as never);
    await registry.call("gate-source", "search", { query: "rsi" });
    expect("signal" in seen[0]!).toBe(false);
  });

  test("已经 abort 的 signal：请求发出去也立刻被取消（HttpConnector 直调同样透传）", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = neverRespondingFetch();
    try {
      const connector = new HttpConnector("gate-source", config as never, {});
      const controller = new AbortController();
      controller.abort();
      let caught: unknown;
      try { await connector.call("search", { query: "rsi" }, { signal: controller.signal }); } catch (e) { caught = e; }
      expect(caught).toBeTruthy();
      expect(String((caught as Error).message)).not.toContain("timed out");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("β-4 ③ · 断开之后台账不再增行（V156 ③ 的可观测形态）", () => {
  test("signal abort 之后的调用不产生新的 usage.jsonl 行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w10-beta-usage-"));
    try {
      const store = new UsageStore(join(dir, "usage.jsonl"));
      const controller = new AbortController();
      // 假 provider：**尊重 signal**（真 provider 已经这么做了，见 llm/providers/*.ts 的
      // effectiveSignal 与 raceWithAbort）。这里测的是「透传到了 → 调用不再发生 → 不记账」。
      const llm = {
        async call(_messages: ChatMessage[], modelOrOptions: string | CallOptions = {}): Promise<LlmResponse> {
          const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
          if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          return { ok: true, provider: "fake", model: "deepseek-v4-flash", content: "x", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: null } } as unknown as LlmResponse;
        },
      };
      const tracked = usageTrackingLlm({ llm: llm as never, store, command: "chat" });
      const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
      const call = () => tracked.call(messages, { model: "deepseek-v4-flash", signal: controller.signal });

      await call();
      const linesBefore = readFileSync(store.path(), "utf8").trim().split("\n").length;
      expect(linesBefore).toBe(1);

      controller.abort(); // = 用户关掉了 /stream 那条连接
      for (let i = 0; i < 3; i++) {
        let threw = false;
        try { await call(); } catch { threw = true; }
        expect(threw, "abort 之后调用居然还成功了——signal 没被透传下去").toBe(true);
      }
      const linesAfter = readFileSync(store.path(), "utf8").trim().split("\n").length;
      expect(linesAfter, "断开后台账还在增行（V156 ③ 的病）").toBe(linesBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
