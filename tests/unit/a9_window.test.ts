// A9 修复窗口门禁（v0.10.0-alpha.3）：U71 U72 U73。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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

const paper = (i: number) => ({
  title: `Paper ${i} on repetitive strain injury among office workers`,
  authors: [{ name: `Author ${i}` }], year: 2015 + i, venue: "J Occup Health",
  doi: `10.1000/rsi.${i}`, ids: { doi: `10.1000/rsi.${i}` },
  abstract: `Abstract ${i}: prevalence and prevention of RSI among office workers.`,
  url: null, pdfUrl: null, citedByCount: 10 * i, isOpenAccess: false, sources: ["openalex"], references: [],
});
const SOURCES = ["openalex", "crossref", "semanticscholar", "arxiv", "europepmc", "pubmed", "biorxiv", "aminer"];
const fakeSearcher = (n: number) => ({
  async search(query: string): Promise<LiteratureSearchResult> {
    return {
      query,
      sources: SOURCES.map((s) => ({ source: s, outcome: s === "arxiv" ? "failed" : "ok", count: s === "arxiv" ? 0 : n, elapsedMs: 5, ...(s === "arxiv" ? { error: "HTTP 429 rate limited by upstream" } : {}) })),
      papers: Array.from({ length: n }, (_, i) => paper(i)),
    } as unknown as LiteratureSearchResult;
  },
});
const CARD = JSON.stringify({ researchQuestion: "RSI？", methods: "问卷。", keyFindings: ["患病率 30%"], limitations: ["自报"], relationToProject: "基线。" });

/** 按提示词内容答：预筛给分、精读卡、综述（引一个库内 key）、其余原样。 */
function pipelineLlm(project: { paths: { libraryDb: string } }, extra: Record<string, string> = {}) {
  const calls: string[] = [];
  return {
    calls,
    async call(messages: ChatMessage[], _o?: unknown): Promise<LlmResponse> {
      const prompt = messages.map((m) => m.content).join("\n");
      let content: string;
      if (prompt.includes("Define a research_contract")) { calls.push("plan"); content = extra.plan ?? "[]"; }
      else if (prompt.includes("相关性分数")) { calls.push("prescreen"); content = JSON.stringify(Array.from({ length: 10 }, (_, i) => [i + 1, 3])); }
      else if (prompt.includes("待精读论文")) { calls.push("card"); content = CARD; }
      else if (prompt.includes("综述") || prompt.includes("review")) {
        calls.push("review");
        const lib = new LibraryStore(project.paths.libraryDb);
        try { content = `# 综述\n\n见[@${libraryKeyIndex(lib.list()).keys[0] ?? "unknown"}]。`; } finally { lib.close(); }
      } else { calls.push("other"); content = extra.plan ?? "汇总"; }
      return { ok: true, content, provider: "kimi", model: "test", usage: { inputTokens: 1, outputTokens: 5 } } as unknown as LlmResponse;
    },
    listModels() { return {}; },
  };
}

let root: string; let pm: ProjectManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "a9win-")); pm = new ProjectManager(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("U71 · digest 截断不再吃掉综述行", () => {
  test("6 条查询 × 8 源（超 1500 字符）→ digest 仍含「综述：artifact」且总长 ≤ 1500", async () => {
    const project = pm.create("u71", { name: "x" });
    const llm = pipelineLlm(project);
    const r = await runLiteraturePipeline(
      { llm: llm as never, project, sessionId: "s", searcher: fakeSearcher(6), downloadPdf: async () => ({ ok: false }) },
      { mode: "review", depth: "quick", queries: ["q1 rsi", "q2 ergonomics", "q3 prevention", "q4 office", "q5 wrist", "q6 posture"], topic: "RSI" },
    );
    expect(r.ok).toBe(true);
    expect(r.review?.artifactId).toBeTruthy();
    expect(r.digest.length).toBeLessThanOrEqual(1500);
    expect(r.digest).toContain("综述：artifact");
    expect(r.digest).toContain("检索明细已截断");
  });
});

describe("U73 · 预筛不在 maxRead 上游砍人", () => {
  test("10 篇候选、maxRead 8、不给 topK → 预筛留 8 而不是 4，精读 8 张", async () => {
    const project = pm.create("u73", { name: "x" });
    const llm = pipelineLlm(project);
    const r = await runLiteraturePipeline(
      { llm: llm as never, project, sessionId: "s", searcher: fakeSearcher(10), downloadPdf: async () => ({ ok: false }) },
      { mode: "review", depth: "deep", queries: ["rsi"], topic: "RSI", maxRead: 8 },
    );
    expect(r.prescreen.kept).toBeGreaterThanOrEqual(8);
    expect(r.cards).toHaveLength(8);
  });
});

describe("U72 · chat 把 depth 透给文献流程", () => {
  const plan = (params: Record<string, unknown>) => JSON.stringify([{ id: "t1", kind: "skill", description: "查文献", params: { skill: "literature-review", queries: ["rsi"], topic: "RSI", ...params } }]);
  async function run(slug: string, params: Record<string, unknown>) {
    const project = pm.create(slug, { name: "x" }); pm.bindSession(`s-${slug}`, slug);
    const llm = pipelineLlm(project, { plan: plan(params) });
    const orch = new OrchestratorAgent(new SparkResearchDaemon({ projects: pm }), { llm: llm as never, projects: pm, workspaceRoot: join(root, "ws"), literatureSearcher: fakeSearcher(3), literatureDownloadPdf: async () => ({ ok: false }) });
    await orch.processRequest("RSI 综述", `s-${slug}`);
    return JSON.parse(readFileSync(join(root, "ws", `s-${slug}`, "t1.json"), "utf8")) as { depth: string; cards: unknown[] };
  }
  test('params.depth:"deep" → deep 档，真建精读卡（partial(card) 的产生端）', async () => {
    const saved = await run("d1", { depth: "deep", maxRead: 3 });
    expect(saved.depth).toBe("deep");
    expect(saved.cards.length).toBeGreaterThan(0);
  });
  test("没给 depth 但给了 maxRead → deep（规划器写的 maxRead 不再是死参数）", async () => {
    const saved = await run("d2", { maxRead: 3 });
    expect(saved.depth).toBe("deep");
  });
  test("都没给 → quick", async () => {
    const saved = await run("d3", {});
    expect(saved.depth).toBe("quick");
    expect(saved.cards).toHaveLength(0);
  });
  test("规划提示词写明 depth 两档的取舍（约定要被读到）", async () => {
    const project = pm.create("d4", { name: "x" }); pm.bindSession("s-d4", "d4");
    const llm = pipelineLlm(project, { plan: JSON.stringify({ direct: "ok" }) });
    const prompts: string[] = [];
    const spy = { ...llm, async call(m: ChatMessage[], o?: unknown) { prompts.push(m.map((x) => x.content).join("\n")); return llm.call(m, o); }, listModels() { return {}; } };
    const orch = new OrchestratorAgent(new SparkResearchDaemon({ projects: pm }), { llm: spy as never, projects: pm, workspaceRoot: join(root, "ws") });
    await orch.processRequest("你好", "s-d4");
    expect(prompts[0]).toContain('"depth":"deep"');
    expect(prompts[0]).toContain('"depth":"quick"');
  });
});

describe("v0.10.0 · 预筛被上限截掉的不写成「剔除」", () => {
  test("10 篇全 3 分、maxRead 4 → digest 里是「未入选（3 分，超出留取上限 4）」而不是「剔除（3 分）」", async () => {
    const project = pm.create("cap", { name: "x" });
    const llm = pipelineLlm(project);
    const r = await runLiteraturePipeline(
      { llm: llm as never, project, sessionId: "s", searcher: fakeSearcher(10), downloadPdf: async () => ({ ok: false }) },
      { mode: "review", depth: "quick", queries: ["rsi"], topic: "RSI", topK: 4 },
    );
    expect(r.prescreen.kept).toBe(4);
    expect(r.digest).toContain("未入选（3 分，超出留取上限 4）");
    expect(r.digest).not.toContain("剔除（3 分）");
  });
});
