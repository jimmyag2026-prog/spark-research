import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";
import { LLMRouter } from "../../backend/src/llm/router";
import { llmExtras } from "../../backend/src/llm/types";
import { runLitCommand } from "../../backend/src/literature/cli";
import { runUsageCommand } from "../../backend/src/cli/usage";
import { LibraryStore } from "../../backend/src/literature/library";
import { ProjectManager } from "../../backend/src/project/manager";
import { UsageStore, parseBudgetUsd, usageTrackingLlm } from "../../backend/src/usage/ledger";
import { CASSETTES, PER_SOURCE, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";

// G-3（v0.6）：轮级用量台账 + $2 预算闸。
//
// 验的四件事：
// 1. 台账落盘与统计（含坏行不静默、未知成本不当 0）
// 2. 预算闸：达上限拒绝（kind:"budget"、请求不发出）、跨进程累计（新进程读文件接着算）
// 3. CLI 接线：lit read --all 的优雅停（已完成的卡保留）与重跑接续（默认跳过已读）
// 4. `usage` 命令的诚实输出（unknown>0 时明说总数报不出）

const GLM = "z-ai/glm-5.3-flash";

function okResponse(tokens: { input: number; output: number }, model = GLM): LlmResponse {
  return {
    ok: true,
    provider: "openrouter",
    model,
    content: JSON.stringify({
      researchQuestion: "问题",
      methods: "方法",
      keyFindings: ["发现"],
      limitations: ["局限"],
      relationToProject: "背景",
    }),
    toolCalls: [],
    usage: { inputTokens: tokens.input, outputTokens: tokens.output, costUsd: null, usageUnavailable: false },
  };
}

class CountingLlm {
  calls = 0;
  constructor(private tokens = { input: 1_000_000, output: 0 }) {}
  call = async (_m: ChatMessage[], _mo?: unknown): Promise<LlmResponse> => {
    this.calls += 1;
    return okResponse(this.tokens);
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-g3-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("G-3 · UsageStore", () => {
  test("append + totals 按命令/模型归因；坏行计数不静默", () => {
    const store = new UsageStore(join(tmp, "usage.jsonl"));
    store.append({ ts: "t", command: "lit-read", provider: "openrouter", model: GLM, ok: true, inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
    store.append({ ts: "t", command: "lit-review", provider: "openrouter", model: GLM, ok: true, inputTokens: 50, outputTokens: 5, costUsd: null });
    appendFileSync(join(tmp, "usage.jsonl"), "not-json\n");
    const totals = store.totals();
    expect(totals.calls).toBe(2);
    expect(totals.knownCostUsd).toBeCloseTo(0.01, 8);
    expect(totals.unknownCostCalls).toBe(1);
    expect(totals.byCommand["lit-read"]!.calls).toBe(1);
    expect(totals.byModel[GLM]!.calls).toBe(2);
    expect(store.corruptLines()).toBeGreaterThan(0);
  });
});

describe("G-3 · usageTrackingLlm 预算闸", () => {
  test("每次调用落台账并按单价表计成本（glm-5.3-flash 实效价）", async () => {
    const store = new UsageStore(join(tmp, "usage.jsonl"));
    const inner = new CountingLlm({ input: 1_000_000, output: 0 });
    const wrapped = usageTrackingLlm({ llm: inner, store, command: "lit-read", configOptions: { env: {} } });
    await wrapped.call([{ role: "user", content: "hi" }], GLM);
    const totals = store.totals();
    expect(totals.calls).toBe(1);
    // 1M 输入 tokens × $0.0791/M = $0.0791（挂牌 ×1.055）
    expect(totals.knownCostUsd).toBeCloseTo(0.0791, 6);
    expect(totals.unknownCostCalls).toBe(0);
  });

  test("达到预算后拒绝：kind=budget、请求不发出、消息给下一步", async () => {
    const store = new UsageStore(join(tmp, "usage.jsonl"));
    const inner = new CountingLlm({ input: 1_000_000, output: 0 }); // 每次 $0.0791
    const wrapped = usageTrackingLlm({ llm: inner, store, command: "lit-read", budgetUsd: 0.1, configOptions: { env: {} } });
    const r1 = await wrapped.call([{ role: "user", content: "1" }], GLM);
    expect(r1.ok).toBe(true);
    const r2 = await wrapped.call([{ role: "user", content: "2" }], GLM); // 累计 0.0791 < 0.1，放行
    expect(r2.ok).toBe(true);
    const r3 = await wrapped.call([{ role: "user", content: "3" }], GLM); // 累计 0.1582 ≥ 0.1，拒
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.error.kind).toBe("budget");
      expect(r3.error.message).toContain("下一步");
    }
    expect(inner.calls).toBe(2); // 第三次没发出去
    expect(store.totals().calls).toBe(2); // 拒绝不入台账（不是 API 调用）
  });

  test("跨进程累计：新 wrapper 读文件历史，直接拒绝", async () => {
    const file = join(tmp, "usage.jsonl");
    const store1 = new UsageStore(file);
    const inner1 = new CountingLlm({ input: 2_000_000, output: 0 }); // $0.1582
    const w1 = usageTrackingLlm({ llm: inner1, store: store1, command: "lit-read", budgetUsd: 0.1, configOptions: { env: {} } });
    await w1.call([{ role: "user", content: "1" }], GLM);
    // 「新进程」：全新 store + wrapper，历史只能从文件读
    const inner2 = new CountingLlm();
    const w2 = usageTrackingLlm({ llm: inner2, store: new UsageStore(file), command: "lit-review", budgetUsd: 0.1, configOptions: { env: {} } });
    const r = await w2.call([{ role: "user", content: "2" }], GLM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("budget");
    expect(inner2.calls).toBe(0);
  });

  test("成本未知的调用不当 0：不推进已知花费、unknown 计数增加", async () => {
    const store = new UsageStore(join(tmp, "usage.jsonl"));
    const inner = {
      calls: 0,
      call: async (): Promise<LlmResponse> => {
        inner.calls += 1;
        return { ok: true, provider: "openrouter", model: "unpriced-model", content: "x", ...llmExtras() };
      },
    };
    const wrapped = usageTrackingLlm({ llm: inner, store, command: "lit-read", budgetUsd: 0.1, configOptions: { env: {} } });
    await wrapped.call([{ role: "user", content: "1" }]);
    const totals = store.totals();
    expect(totals.knownCostUsd).toBe(0);
    expect(totals.unknownCostCalls).toBe(1);
    // 已知下界没超，未知调用不触发「确定超」——闸不误杀（诚实的另一半在 usage 输出示警）
    const r = await wrapped.call([{ role: "user", content: "2" }]);
    expect(r.ok).toBe(true);
  });

  test("parseBudgetUsd：非法值报错并给示例", () => {
    const errs: string[] = [];
    expect(parseBudgetUsd("abc", (l) => errs.push(l))).toEqual({ ok: false });
    expect(errs[0]).toContain("--budget-usd 2");
    expect(parseBudgetUsd("2", () => {})).toEqual({ ok: true, value: 2 });
    expect(parseBudgetUsd(undefined, () => {})).toEqual({ ok: true });
  });
});

describe("G-3 · CLI 接线", () => {
  async function seedPapers(count: number) {
    const manager = new ProjectManager(tmp);
    const project = manager.create("g3", { name: "g3" });
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const searched = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, {
      sources: SEARCH_SOURCES,
      perSource: PER_SOURCE,
    });
    for (const paper of searched.papers.slice(0, count)) library.add(paper, { tags: ["background"] });
    return manager;
  }

  test("lit read --all 预算内完成的卡保留，超预算的失败可见且给下一步", async () => {
    const manager = await seedPapers(2);
    // 每篇精读 1M 输入 tokens ≈ $0.0791；预算 $0.05 → 第 1 篇成，第 2 篇被闸拒
    const inner = new CountingLlm({ input: 1_000_000, output: 0 });
    const out: string[] = [];
    const errLines: string[] = [];
    const code = await runLitCommand(
      ["read", "--all", "--budget-usd", "0.05", "--model", GLM],
      { manager, root: tmp, llm: inner, out: (l) => out.push(l), err: (l) => errLines.push(l) },
    );
    expect(inner.calls).toBeLessThanOrEqual(2); // 第 2 篇最多重试也不该真调用（预算已超）
    const all = [...out, ...errLines].join("\n");
    expect(all).toContain("预算闸");
    // 部分成功：有卡也有失败 → 退出码 0（与既有「部分失败」语义一致），失败逐条可见
    expect(code).toBe(0);
    expect(all).toContain("✅ 生成 1 张精读卡");
  });

  test("重跑接续：--all 默认跳过已有卡，零 LLM 调用零花费", async () => {
    const manager = await seedPapers(1);
    const inner1 = new CountingLlm();
    await runLitCommand(["read", "--all", "--model", GLM], { manager, root: tmp, llm: inner1, out: () => {}, err: () => {} });
    expect(inner1.calls).toBeGreaterThan(0);
    const inner2 = new CountingLlm();
    const out: string[] = [];
    const code = await runLitCommand(["read", "--all", "--model", GLM], { manager, root: tmp, llm: inner2, out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(0);
    expect(inner2.calls).toBe(0);
    expect(out.join("\n")).toContain("已有精读卡");
  });

  test("usage 命令：正常汇总 + unknown>0 时明说总数报不出", async () => {
    const manager = await seedPapers(1);
    const store = new UsageStore(join(tmp, "projects", "g3", "usage.jsonl"));
    store.append({ ts: "t", command: "lit-read", provider: "openrouter", model: GLM, ok: true, inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
    store.append({ ts: "t", command: "lit-read", provider: "openrouter", model: "unpriced", ok: true, inputTokens: 1, outputTokens: 1, costUsd: null });
    const out: string[] = [];
    const code = await runUsageCommand(["--project", "g3"], { manager, root: tmp, out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("已知花费（下界）$0.0100");
    expect(text).toContain("成本未知");
    expect(text).toContain("lit-read: 2 次");
  });
});
