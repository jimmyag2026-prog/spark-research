import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTrackedEmbedder,
  embedTexts,
  type EmbedAccounting,
} from "../../backend/src/llm/embeddings";
import { embedFailure, embedOk, type EmbedResponse } from "../../backend/src/llm/embeddings/types";
import {
  EMBEDDING_CAPABLE_PROVIDERS,
  embeddingPriceFor,
  supportsEmbeddings,
} from "../../backend/src/llm/providers/registry";
import { supportedEmbeddingProviders } from "../../backend/src/llm/embeddings/router";
import { MemoryRawSink } from "../../backend/src/raw";
import { UsageStore } from "../../backend/src/usage/ledger";

// W8-1 ζ（V2 embedding 语义化）· 成本入账层单测。
//
// 这一层刻意不重测 `llm/embeddings/router.ts` / `openai_compat.ts` 已经覆盖的 HTTP 细节
// （分批、维度校验、AD-13 失败契约见 tests/unit/embeddings.test.ts）——这里只测本 lane
// 新增的那一半：registry 单价查表、UsageStore.append 入账、raw kind:"llm" 落盘、
// 以及 novelty.ts 消费的 Embedder 契约桥接（createTrackedEmbedder）。

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "spark-w8-zeta-"));
  dirs.push(dir);
  return dir;
}
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function store(): UsageStore {
  return new UsageStore(join(tempRoot(), "usage.jsonl"));
}

/** 一次性 router 桩：固定返回给定响应，记录被问过几次文本。 */
function stubRouter(response: EmbedResponse, modelId: string | null = response.ok ? response.model : "openai/text-embedding-3-small") {
  const calls: string[][] = [];
  return {
    calls,
    router: {
      modelId: () => modelId,
      async embed(texts: string[]) {
        calls.push(texts);
        return response;
      },
    },
  };
}

describe("embeddingPriceFor / supportsEmbeddings（registry 单价表 + 能力位）", () => {
  test("openai text-embedding-3-small 有价，来源与核实日期都在", () => {
    const price = embeddingPriceFor("openai", "text-embedding-3-small");
    expect(price).not.toBeNull();
    expect(price!.perMillionUsd).toBe(0.02);
    expect(price!.source).toContain("https://");
    expect(price!.verifiedDate).toBe("2026-09-12");
  });

  test("查不到的 provider/model 返回 null，不是 0（qwen 未收录、编造的型号名同样 null）", () => {
    expect(embeddingPriceFor("qwen", "text-embedding-v3")).toBeNull();
    expect(embeddingPriceFor("openai", "made-up-model")).toBeNull();
    expect(embeddingPriceFor("local", "nomic-embed-text")).toBeNull();
  });

  test("EMBEDDING_CAPABLE_PROVIDERS 与 embeddings/router.ts 的 supportedEmbeddingProviders() provider 集合一致", () => {
    // 两边是手工同步的独立表（registry.ts 顶部注释解释了为什么不能 import 消除重复：
    // 会与 embeddings/router.ts 反向 import PROVIDER_API_KEY_ENV 成环）。这条测试就是
    // 防止「改了一边忘了另一边」的门禁。
    expect([...EMBEDDING_CAPABLE_PROVIDERS].sort()).toEqual([...supportedEmbeddingProviders()].sort());
    expect(supportsEmbeddings("openai")).toBe(true);
    expect(supportsEmbeddings("anthropic")).toBe(false);
  });
});

describe("embedTexts()（任务书字面签名）", () => {
  test("成功：返回 vectors/usage/provider/model，costUsd 按 registry 单价折算", async () => {
    const response = embedOk({
      provider: "openai",
      model: "openai/text-embedding-3-small",
      vectors: [[1, 0], [0, 1]],
      usage: { tokens: 1000, usageUnavailable: false },
    });
    const { router } = stubRouter(response);
    const result = await embedTexts(["a", "b"], { router });
    expect("unavailable" in result).toBe(false);
    if ("unavailable" in result) throw new Error("unreachable");
    expect(result.vectors).toEqual([[1, 0], [0, 1]]);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("openai/text-embedding-3-small");
    // 1000 token * $0.02/1e6 = $0.00002
    expect(result.usage.costUsd).toBeCloseTo(0.00002, 10);
    expect(result.usage.unpriced).toBe(false);
  });

  test("成功但单价查不到：costUsd null 且 unpriced true，不是 0（qwen 未标定入 registry）", async () => {
    const response = embedOk({
      provider: "qwen",
      model: "qwen/text-embedding-v3",
      vectors: [[1, 0]],
      usage: { tokens: 42 },
    });
    const { router } = stubRouter(response);
    const result = await embedTexts(["a"], { router });
    if ("unavailable" in result) throw new Error("unreachable");
    expect(result.usage.costUsd).toBeNull();
    expect(result.usage.unpriced).toBe(true);
  });

  test("失败：返回 {unavailable: reason}，不返回 vectors（AD-13 的可辨识联合在这一层延续）", async () => {
    const response = embedFailure({
      provider: "openai",
      model: "openai/text-embedding-3-small",
      kind: "upstream",
      message: "HTTP 500: internal error",
    });
    const { router } = stubRouter(response);
    const result = await embedTexts(["a"], { router });
    expect("unavailable" in result).toBe(true);
    if (!("unavailable" in result)) throw new Error("unreachable");
    expect(result.unavailable).toContain("upstream");
    expect(result.unavailable).toContain("internal error");
  });

  test("未配置（kind=unsupported，v0.7 默认路径）：unavailable 但不落账，不刷台账幽灵行", async () => {
    const response = embedFailure({
      provider: "none",
      model: "",
      kind: "unsupported",
      message: "未配置 embeddingModel",
    });
    const { router } = stubRouter(response, null);
    const s = store();
    const accounting: EmbedAccounting = { store: s, command: "novelty-check" };
    const result = await embedTexts(["a"], { router, accounting });
    expect("unavailable" in result).toBe(true);
    expect(s.readAll()).toHaveLength(0);
  });
});

describe("成本入账（UsageStore.append + raw kind:\"llm\"）", () => {
  test("成功调用：usage.jsonl 落一行 command=<cmd>:embedding，costUsd 与 embedTexts 返回值一致", async () => {
    const response = embedOk({
      provider: "openai",
      model: "openai/text-embedding-3-small",
      vectors: [[1, 0]],
      usage: { tokens: 500, usageUnavailable: false },
    });
    const { router } = stubRouter(response);
    const s = store();
    const raw = new MemoryRawSink({ project: "demo" });
    const accounting: EmbedAccounting = { store: s, command: "novelty-check", rawSink: raw, project: "demo", sessionId: "sess-1" };
    const result = await embedTexts(["hello"], { router, accounting });
    if ("unavailable" in result) throw new Error("unreachable");

    const rows = s.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.command).toBe("novelty-check:embedding");
    expect(rows[0]!.provider).toBe("openai");
    expect(rows[0]!.model).toBe("openai/text-embedding-3-small");
    expect(rows[0]!.ok).toBe(true);
    expect(rows[0]!.costUsd).toBeCloseTo(result.usage.costUsd!, 10);
    expect(rows[0]!.inputTokens).toBe(500);
    expect(rows[0]!.outputTokens).toBe(0);

    const rawRows = [...raw.iterate({ kind: "llm" })];
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]!.command).toBe("novelty-check:embedding");
    expect(rawRows[0]!.sessionId).toBe("sess-1");
    const payload = rawRows[0]!.payload as { options: Record<string, unknown> };
    expect(payload.options.endpoint).toBe("embeddings");
  });

  test("失败但确实打了网络（timeout）：仍落一行 ok=false 的 usage 记录（过程数据不能因为失败就消失）", async () => {
    const response = embedFailure({
      provider: "openai",
      model: "openai/text-embedding-3-small",
      kind: "timeout",
      message: "请求超过 5000ms 未返回",
      retryable: true,
    });
    const { router } = stubRouter(response, "openai/text-embedding-3-small");
    const s = store();
    const accounting: EmbedAccounting = { store: s, command: "novelty-check" };
    await embedTexts(["a"], { router, accounting });
    const rows = s.readAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.costUsd).toBeNull();
  });

  test("没给 accounting：调用照常返回结果，但完全不碰 store（纯查询用途）", async () => {
    const response = embedOk({ provider: "openai", model: "openai/text-embedding-3-small", vectors: [[1]], usage: { tokens: 10 } });
    const { router } = stubRouter(response);
    const result = await embedTexts(["a"], { router });
    if ("unavailable" in result) throw new Error("unreachable");
    expect(result.vectors).toEqual([[1]]);
    // 没有传 store，本来就无从断言——这里断言的是"不抛异常、能正常返回"本身。
  });
});

describe("createTrackedEmbedder()（novelty.ts 消费的 Embedder 契约桥接）", () => {
  test("embed() 原样转发 EmbedResponse（ok 分支）：结构与 router 直接返回的一致", async () => {
    const response = embedOk({ provider: "openai", model: "openai/text-embedding-3-small", vectors: [[1, 2, 3]], usage: { tokens: 7 } });
    const { router } = stubRouter(response);
    const embedder = createTrackedEmbedder({ router });
    const got = await embedder.embed(["x"]);
    expect(got).toEqual(response);
    expect(embedder.modelId()).toBe("openai/text-embedding-3-small");
  });

  test("embed() 原样转发失败响应（error.kind 等结构化字段不丢）——novelty.ts 的降级判断依赖这些字段", async () => {
    const response = embedFailure({ provider: "openai", model: "openai/text-embedding-3-small", kind: "auth", message: "缺 OPENAI_API_KEY" });
    const { router } = stubRouter(response, "openai/text-embedding-3-small");
    const embedder = createTrackedEmbedder({ router });
    const got = await embedder.embed(["x"]);
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error("unreachable");
    expect(got.error.kind).toBe("auth");
    expect(got.vectors).toBeNull();
  });

  test("accounting 副作用与 embedTexts 共用同一路径：成功调用也会落账", async () => {
    const response = embedOk({ provider: "openai", model: "openai/text-embedding-3-small", vectors: [[1]], usage: { tokens: 100 } });
    const { router } = stubRouter(response);
    const s = store();
    const embedder = createTrackedEmbedder({ router, accounting: { store: s, command: "novelty-check" } });
    await embedder.embed(["x"]);
    expect(s.readAll()).toHaveLength(1);
  });

  test("没有 accounting 时是纯直通（不抛、不落账）——deps.embedAccounting 未给时的 novelty.ts 默认行为", async () => {
    const response = embedOk({ provider: "openai", model: "openai/text-embedding-3-small", vectors: [[1]], usage: { tokens: 100 } });
    const { router } = stubRouter(response);
    const embedder = createTrackedEmbedder({ router });
    const got = await embedder.embed(["x"]);
    expect(got).toEqual(response);
  });
});
