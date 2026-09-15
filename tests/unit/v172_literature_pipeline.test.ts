// V172（用户定义的五步文献流程）：chat 的 skill 任务对 literature-search / literature-review 真执行。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { runLiteraturePipeline } from "../../backend/src/agents/literature_pipeline";
import type { LiteratureSearchResult } from "../../backend/src/literature/search";
import { LibraryStore } from "../../backend/src/literature/library";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

const paper = (i: number, extra: Record<string, unknown> = {}) => ({
  title: `Paper ${i} on repetitive strain injury`,
  authors: [{ name: `Author ${i}` }],
  year: 2020 + i,
  venue: "J Occup Health",
  doi: `10.1000/rsi.${i}`,
  ids: { doi: `10.1000/rsi.${i}` },
  abstract: `Abstract ${i}: prevalence and prevention of RSI among office workers.`,
  url: null,
  pdfUrl: null,
  citedByCount: 10 * i,
  isOpenAccess: false,
  sources: ["openalex"],
  references: [],
  ...extra,
});
const fakeSearcher = (n = 3) => ({
  calls: [] as string[],
  async search(query: string): Promise<LiteratureSearchResult> {
    this.calls.push(query);
    return {
      query,
      sources: [{ source: "openalex", outcome: "ok", count: n, elapsedMs: 5 }, { source: "arxiv", outcome: "failed", count: 0, elapsedMs: 5, error: "HTTP 429" }],
      papers: Array.from({ length: n }, (_, i) => paper(i)),
    } as unknown as LiteratureSearchResult;
  },
});
class ScriptLlm {
  readonly prompts: string[] = [];
  private i = 0;
  constructor(private readonly replies: Array<string | ((prompt: string) => string)>) {}
  readonly models: Array<string | undefined> = [];
  async call(messages: ChatMessage[], options?: unknown): Promise<LlmResponse> {
    const prompt = messages.map((m) => m.content).join("\n");
    this.prompts.push(prompt);
    this.models.push(typeof options === "string" ? options : (options as { model?: string } | undefined)?.model);
    const r = this.replies[Math.min(this.i++, this.replies.length - 1)]!;
    const content = typeof r === "function" ? r(prompt) : r;
    return { ok: true, content, provider: "kimi", model: "test", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as LlmResponse;
  }
  listModels() { return {}; }
}
const CARD = JSON.stringify({
  researchQuestion: "RSI 在办公人群中的患病率与预防？",
  methods: "横断面问卷 + 工效学干预对照。",
  keyFindings: ["患病率 30%", "工效学干预降低 40% 症状"],
  limitations: ["自报数据"],
  relationToProject: "提供中美对比的基线数字。",
});

let root: string; let pm: ProjectManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "v172-")); pm = new ProjectManager(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("V172 · runLiteraturePipeline", () => {
  test("search 模式：多条查询 → 入库去重 → 摘要列出标题与各源 outcome；零 LLM 调用", async () => {
    const project = pm.create("lp-search", { name: "x" });
    const searcher = fakeSearcher(3);
    const llm = new ScriptLlm(["不该被调用"]);
    const r = await runLiteraturePipeline({ llm, project, sessionId: "s1", searcher }, { mode: "search", queries: ["rsi china", "rsi usa"] });
    expect(r.ok).toBe(true);
    expect(searcher.calls).toEqual(["rsi china", "rsi usa"]);
    expect(r.added).toBe(3);          // 同 DOI 第二次按合并
    expect(r.merged).toBe(3);
    expect(r.library).toBe(3);
    expect(r.digest).toContain("Paper 0 on repetitive strain injury");
    expect(r.digest).toContain("arxiv:failed");
    expect(r.failures.join("\n")).toContain("HTTP 429");
    expect(llm.prompts).toHaveLength(0);
    project.close();
  });

  test("review 模式：下载(注入失败→按摘要) → 每篇一张精读卡 → 综述 artifact；ok=true", async () => {
    const project = pm.create("lp-review", { name: "x", description: "中美 RSI 对比" });
    // 综述必须只引用库内 key（citation-integrity 会 veto 库外引用）——从项目文献库现算一个真实 key。
    const realKey = () => {
      const lib = new LibraryStore(project.paths.libraryDb);
      try { return libraryKeyIndex(lib.list()).keys[0] ?? "unknown"; } finally { lib.close(); }
    };
    const llm = new ScriptLlm([CARD, CARD, CARD, () => `# 综述\n\nRSI 患病率约三成[@${realKey()}]。`]);
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s2", searcher: fakeSearcher(3), downloadPdf: async () => ({ ok: false, reason: "no-oa" }) },
      // v0.10 α-1：默认档从「逐篇精读」改成 quick，这个用例验的是 deep 路径 → 显式写死 deep。
      // 候选 3 篇 ≤ 预筛的 skipBelow(3)，预筛不发调用，所以调用数仍是 3 卡 + 1 综述。
      { mode: "review", queries: ["rsi"], topic: "中美 RSI", maxRead: 3, depth: "deep" },
    );
    expect(r.downloads).toHaveLength(3);
    expect(r.downloads.every((d) => !d.ok)).toBe(true);
    expect(r.cards).toHaveLength(3);
    expect(r.review).not.toBeNull();
    expect(r.ok).toBe(true);
    expect(r.digest).toContain("精读卡：3 张");
    expect(r.digest).toContain("综述：");
    expect(llm.prompts.length).toBe(4); // 3 张卡 + 1 份综述
    project.close();
  });

  test("没有检索词 → ok=false 并说明规划器该给 queries", async () => {
    const project = pm.create("lp-empty", { name: "x" });
    const r = await runLiteraturePipeline({ llm: new ScriptLlm([]), project, sessionId: "s3", searcher: fakeSearcher(0) }, { mode: "search", queries: ["  "] });
    expect(r.ok).toBe(false);
    expect(r.digest).toContain("params.queries");
    project.close();
  });
});

describe("V172 · chat 的 skill 任务真执行", () => {
  test("plan 给 literature-search + queries → 流程跑了、产出落盘、摘要进 summarize；未知技能仍只加载上下文", async () => {
    pm.create("lp-orch", { name: "x" });
    pm.bindSession("s-orch", "lp-orch");
    const daemon = new SparkResearchDaemon({ projects: pm });
    const searcher = fakeSearcher(2);
    const llm = new ScriptLlm([
      JSON.stringify([
        { id: "t1", kind: "skill", description: "查文献", params: { skill: "literature-search", queries: ["rsi china", "rsi usa"] } },
        { id: "t2", kind: "skill", description: "别的技能", params: { skill: "protein-analysis" } },
      ]),
      "汇总",
    ]);
    const orch = new OrchestratorAgent(daemon, { llm: llm as never, projects: pm, workspaceRoot: join(root, "ws"), literatureSearcher: searcher });
    const result = await orch.processRequest("RSI 中美进展", "s-orch");
    const t1 = result.execution.find((e) => e.taskId === "t1")!;
    expect(t1.ok).toBe(true);
    expect(t1.output).toContain("文献流程（search · quick 档）");
    expect(searcher.calls).toEqual(["rsi china", "rsi usa"]);
    const saved = join(root, "ws", "s-orch", "t1.json");
    expect(existsSync(saved)).toBe(true);
    expect((JSON.parse(readFileSync(saved, "utf8")) as { added: number }).added).toBe(2);
    const t2 = result.execution.find((e) => e.taskId === "t2")!;
    expect(t2.ok).toBe(true);
    expect(t2.output).not.toContain("文献流程");
    expect(llm.prompts[llm.prompts.length - 1]).toContain("Paper 0 on repetitive strain injury");
  });

  test("规划器提示词明确要求文献需求走 skill 而不是 connector（AD-17：约定要被读到）", async () => {
    pm.create("lp-plan", { name: "x" });
    pm.bindSession("s-plan", "lp-plan");
    const llm = new ScriptLlm([JSON.stringify([{ id: "t1", kind: "analysis", description: "x" }]), "汇总"]);
    const orch = new OrchestratorAgent(new SparkResearchDaemon({ projects: pm }), { llm: llm as never, projects: pm, workspaceRoot: join(root, "ws") });
    await orch.processRequest("x", "s-plan");
    expect(llm.prompts[0]).toContain('"skill":"literature-review"');
    expect(llm.prompts[0]).toContain("queries");
    expect(llm.prompts[0]).toContain("instead of connector tasks");
  });
});

describe("U49 / U50 · 流程内进度推到界面；精读/综述用文献子代理模型", () => {
  test("U49：文献流程的每个阶段都以 progress 事件推出（以前精读 8 篇期间界面像卡死）", async () => {
    pm.create("lp-prog", { name: "x" });
    pm.bindSession("s-prog", "lp-prog");
    const llm = new ScriptLlm([
      JSON.stringify([{ id: "t1", kind: "skill", description: "查文献", params: { skill: "literature-search", queries: ["rsi china"] } }]),
      "汇总",
    ]);
    const orch = new OrchestratorAgent(new SparkResearchDaemon({ projects: pm }), { llm: llm as never, projects: pm, workspaceRoot: join(root, "ws"), literatureSearcher: fakeSearcher(2) });
    const events: string[] = [];
    await orch.processRequest("RSI", "s-prog", { onProgress: (e) => events.push(`${e.stage}|${e.message}`) });
    expect(events.some((e) => e.startsWith("execute|") && e.includes("检索「rsi china」"))).toBe(true);
    // 计数不变式：进度里的 complete 不超过 total
    expect(events.every((e) => !/执行中 (\d+)\/(\d+)/.test(e) || Number(RegExp.$1) <= Number(RegExp.$2))).toBe(true);
  });

  test("U50：pipeline 把 model 透传给精读卡与综述的每次调用", async () => {
    const project = pm.create("lp-model", { name: "x" });
    const realKey = () => { const lib = new LibraryStore(project.paths.libraryDb); try { return libraryKeyIndex(lib.list()).keys[0] ?? "unknown"; } finally { lib.close(); } };
    const llm = new ScriptLlm([CARD, () => `# 综述\n\n一句[@${realKey()}]。`]);
    const r = await runLiteraturePipeline(
      { llm, model: "deepseek-v4-flash", project, sessionId: "s-model", searcher: fakeSearcher(1), downloadPdf: async () => ({ ok: false }) },
      { mode: "review", queries: ["rsi"], maxRead: 1 },
    );
    expect(r.ok).toBe(true);
    expect(llm.models).toEqual(["deepseek-v4-flash", "deepseek-v4-flash"]);
    project.close();
  });

  test("U50：编排层的模型选择顺序 = 会话覆盖 > subAgentModel_literature > 默认（源码级钉住接线）", async () => {
    const src = await Bun.file(new URL("../../backend/src/agents/orchestrator.ts", import.meta.url)).text();
    expect(src).toMatch(/model: this\.sessionModel\.get\(sessionId\) \?\? configuredSubAgentModel\("literature"/);
  });
});

describe("U57 · skill 的结构化摘要完整到达 summarize（不被 600 字符上限切掉）", () => {
  test("6 条查询 × 多篇命中 → summarize 看到「命中样例」与末尾行，而不是只看到前几条查询", async () => {
    pm.create("lp-u57", { name: "x" });
    pm.bindSession("s-u57", "lp-u57");
    const searcher = fakeSearcher(8);
    const queries = Array.from({ length: 6 }, (_, i) => `query number ${i} about recursive self improvement`);
    const llm = new ScriptLlm([
      JSON.stringify([{ id: "t1", kind: "skill", description: "查文献", params: { skill: "literature-search", queries } }]),
      "汇总",
    ]);
    const orch = new OrchestratorAgent(new SparkResearchDaemon({ projects: pm }), { llm: llm as never, projects: pm, workspaceRoot: join(root, "ws"), literatureSearcher: searcher });
    const result = await orch.processRequest("RSI", "s-u57");
    const digest = result.execution.find((e) => e.taskId === "t1")!.output;
    expect(digest.length).toBeGreaterThan(700); // 现场：1500 字符
    const summ = llm.prompts[llm.prompts.length - 1]!;
    expect(summ).toContain("命中样例");           // 在第 600 字符之后
    expect(summ).toContain("Paper 0 on repetitive strain injury");
  });

  test("规划提示词明说：literature-review 已含综述 artifact，不要再排 analysis 综合任务", async () => {
    pm.create("lp-u57b", { name: "x" }); pm.bindSession("s-u57b", "lp-u57b");
    const llm = new ScriptLlm([JSON.stringify([{ id: "t1", kind: "analysis", description: "x" }]), "汇总"]);
    const orch = new OrchestratorAgent(new SparkResearchDaemon({ projects: pm }), { llm: llm as never, projects: pm, workspaceRoot: join(root, "ws") });
    await orch.processRequest("q", "s-u57b");
    expect(llm.prompts[0]).toContain("do NOT add a separate");
  });
});
