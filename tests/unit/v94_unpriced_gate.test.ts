import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_MODELS } from "../../backend/src/llm/router";
import { priceFor } from "../../backend/src/llm/providers/registry";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";
import { runLitCommand } from "../../backend/src/literature/cli";
import { LibraryStore } from "../../backend/src/literature/library";
import { ProjectManager } from "../../backend/src/project/manager";
import { UsageStore, usageTrackingLlm } from "../../backend/src/usage/ledger";
import { CASSETTES, PER_SOURCE, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";

// V94（v0.8 G-4）：无价模型让预算闸静默失效。
// 改前：查不到单价 → 成本"未知" → 永不越线 → --budget-usd 对该模型形同虚设。
// 改后：设了预算 + 无价 → 默认拒绝；--allow-unpriced 显式放行并在 usage 标 unpriced。
// 阴性对照（已验红）：ledger.ts 里 `unpriced && options.allowUnpriced !== true` 判断去掉 → 第一条红。

const UNPRICED = "local/llama-whatever"; // 本地端点永远无价（registry 注释明文）

function llmReturning(model: string, content = "ok") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    call: async (_m: ChatMessage[], _mo?: unknown): Promise<LlmResponse> => {
      calls += 1;
      return {
        ok: true,
        provider: "local",
        model,
        content,
        toolCalls: [],
        usage: { inputTokens: 1000, outputTokens: 100, costUsd: null, usageUnavailable: false },
      };
    },
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-v94-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("V94 · 无价模型与预算闸", () => {
  test("设了预算 + 模型无单价 → 默认拒绝（kind:budget、不发请求、消息给 --allow-unpriced 与补价两条路）", async () => {
    const inner = llmReturning(UNPRICED);
    const wrapped = usageTrackingLlm({ llm: inner, store: new UsageStore(join(tmp, "u.jsonl")), command: "t", budgetUsd: 1, configOptions: { env: {} } });
    const res = await wrapped.call([{ role: "user", content: "hi" }], UNPRICED);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("budget");
      expect(res.error.message).toContain("--allow-unpriced");
      expect(res.error.message).toContain("SPARK_LLM_PRICING_JSON");
    }
    expect(inner.calls).toBe(0);
  });

  test("--allow-unpriced → 放行，usage 行标 unpriced:true，totals.unpricedCalls 计数，预算不被它推进", async () => {
    const inner = llmReturning(UNPRICED);
    const store = new UsageStore(join(tmp, "u.jsonl"));
    const wrapped = usageTrackingLlm({ llm: inner, store, command: "t", budgetUsd: 1, allowUnpriced: true, configOptions: { env: {} } });
    const res = await wrapped.call([{ role: "user", content: "hi" }], UNPRICED);
    expect(res.ok).toBe(true);
    expect(inner.calls).toBe(1);
    const rows = store.readAll();
    expect(rows.length).toBe(1);
    expect(rows[0]!.unpriced).toBe(true);
    expect(rows[0]!.costUsd).toBeNull(); // 未知不是 0
    const totals = store.totals();
    expect(totals.unpricedCalls).toBe(1);
    expect(totals.unknownCostCalls).toBe(1);
    expect(totals.knownCostUsd).toBe(0);
  });

  test("没设预算 → 无价模型照常放行（闸不存在就没有「失效」），仍标 unpriced", async () => {
    const inner = llmReturning(UNPRICED);
    const store = new UsageStore(join(tmp, "u.jsonl"));
    const wrapped = usageTrackingLlm({ llm: inner, store, command: "t", configOptions: { env: {} } });
    expect((await wrapped.call([{ role: "user", content: "hi" }], UNPRICED)).ok).toBe(true);
    expect(store.readAll()[0]!.unpriced).toBe(true);
  });

  test("有单价的模型不受影响：不标 unpriced", async () => {
    const store = new UsageStore(join(tmp, "u.jsonl"));
    const inner = {
      call: async (): Promise<LlmResponse> => ({
        ok: true,
        provider: "deepseek",
        model: "deepseek-chat",
        content: "ok",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10, costUsd: null, usageUnavailable: false },
      }),
    };
    const wrapped = usageTrackingLlm({ llm: inner, store, command: "t", budgetUsd: 1, configOptions: { env: {} } });
    expect((await wrapped.call([{ role: "user", content: "hi" }], "deepseek-chat")).ok).toBe(true);
    expect(store.readAll()[0]!.unpriced).toBeUndefined();
    expect(store.totals().unpricedCalls).toBe(0);
  });
});

describe("V94 · anthropic 单价表补齐（官方页直读 2026-09-11）", () => {
  test("PROVIDER_MODELS.anthropic 每个模型都有价，且来源是官方定价页", () => {
    for (const model of PROVIDER_MODELS.anthropic) {
      const p = priceFor("anthropic", model, { env: {} });
      expect(p).not.toBeNull();
      expect(p!.source).toContain("platform.claude.com");
      expect(p!.verifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  test("Opus 5 $5/$25 · Sonnet 5 $2/$10 · Haiku 4.5 $1/$5", () => {
    expect(priceFor("anthropic", "claude-opus-5", { env: {} })).toMatchObject({ inputPerMillionUsd: 5, outputPerMillionUsd: 25 });
    expect(priceFor("anthropic", "claude-sonnet-5", { env: {} })).toMatchObject({ inputPerMillionUsd: 2, outputPerMillionUsd: 10 });
    expect(priceFor("anthropic", "claude-haiku-4-5-20251001", { env: {} })).toMatchObject({ inputPerMillionUsd: 1, outputPerMillionUsd: 5 });
  });
});

describe("V94 · CLI 接线", () => {
  async function seed() {
    const manager = new ProjectManager(tmp);
    const project = manager.create("v94", { name: "v94" });
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const searched = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, { sources: SEARCH_SOURCES, perSource: PER_SOURCE });
    for (const paper of searched.papers.slice(0, 1)) library.add(paper, { tags: ["background"] });
    return manager;
  }
  const card = JSON.stringify({ researchQuestion: "q", methods: "m", keyFindings: ["f"], limitations: ["l"], relationToProject: "r" });

  test("lit read --all --budget-usd 1 --model <无价> → 拒；加 --allow-unpriced → 出卡", async () => {
    const manager = await seed();
    const denied = llmReturning(UNPRICED, card);
    const lines: string[] = [];
    await runLitCommand(["read", "--all", "--budget-usd", "1", "--model", UNPRICED], { manager, root: tmp, llm: denied, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    expect(denied.calls).toBe(0);
    expect(lines.join("\n")).toContain("没有价格");

    const allowed = llmReturning(UNPRICED, card);
    const lines2: string[] = [];
    const code = await runLitCommand(["read", "--all", "--budget-usd", "1", "--allow-unpriced", "--model", UNPRICED], { manager, root: tmp, llm: allowed, out: (l) => lines2.push(l), err: (l) => lines2.push(l) });
    expect(code).toBe(0);
    expect(allowed.calls).toBe(1);
    expect(lines2.join("\n")).toContain("✅ 生成 1 张精读卡");
  });
});
