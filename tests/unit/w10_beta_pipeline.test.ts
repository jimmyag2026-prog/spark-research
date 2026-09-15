// v0.10 lane β · β-2（partial 事件）与 β-3（delta 的 target / revision）的 e2e 门禁。
//
// 「e2e 用假 LLM」这句在本仓的既有先例是 `tests/e2e/fixture_server.ts`（ScriptedLlm +
// cassette 回放）。这里取同一条口径、但把被测面收到**管线本身**：`/stream` 的 SSE 出口
// 与 orchestrator 的回调透传是收口专属文件（本 lane 一行不碰，diff 在
// `docs/devlog/W10-beta.md`「收口 diff」），所以这里钉的是收口之前必须成立的那一半：
//   - 检索一回来就有 `partial.papers`（且在下载/精读开跑之前）
//   - 每张卡一条 `partial.card`
//   - 综述正文逐块到达，`target === "review"`，重写一稿 → `revision` +1
// 收口那 10 行只负责「把这些事件原样 send 出去」，不产生新语义。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { runLiteraturePipeline } from "../../backend/src/agents/literature_pipeline";
import type { DeltaEvent, PartialCardPayload, PartialEvent, PartialPapersPayload, PartialSearchSourcePayload } from "../../backend/src/agents/progress";
import { LibraryStore } from "../../backend/src/literature/library";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import type { LiteratureSearchResult } from "../../backend/src/literature/search";
import type { CallOptions, ChatMessage, LlmResponse } from "../../backend/src/llm/types";

const paper = (i: number) => ({
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
});

const fakeSearcher = (n = 3) => ({
  async search(query: string): Promise<LiteratureSearchResult> {
    return {
      query,
      sources: [
        { source: "openalex", outcome: "ok", count: n, elapsedMs: 5 },
        { source: "arxiv", outcome: "failed", count: 0, elapsedMs: 5, error: "HTTP 429" },
      ],
      papers: Array.from({ length: n }, (_, i) => paper(i)),
    } as unknown as LiteratureSearchResult;
  },
});

/** 假 LLM：调用方给了 onDelta 就**真的**分块回调（不然流式那条门禁测的是空气）。 */
class StreamingScriptLlm {
  readonly prompts: string[] = [];
  readonly streamed: boolean[] = [];
  private i = 0;
  constructor(private readonly replies: Array<string | ((prompt: string) => string)>) {}
  async call(messages: ChatMessage[], modelOrOptions?: string | CallOptions): Promise<LlmResponse> {
    this.prompts.push(messages.map((m) => m.content).join("\n"));
    const options = typeof modelOrOptions === "object" ? modelOrOptions : undefined;
    this.streamed.push(Boolean(options?.onDelta));
    const r = this.replies[Math.min(this.i++, this.replies.length - 1)]!;
    const content = typeof r === "function" ? r(this.prompts[this.prompts.length - 1]!) : r;
    if (options?.onDelta) {
      for (let at = 0; at < content.length; at += 16) options.onDelta(content.slice(at, at + 16));
    }
    return { ok: true, content, provider: "fake", model: "test", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: null } } as unknown as LlmResponse;
  }
}

const CARD = JSON.stringify({
  researchQuestion: "RSI 在办公人群中的患病率与预防？",
  methods: "横断面问卷 + 工效学干预对照。",
  keyFindings: ["患病率 30%", "工效学干预降低 40% 症状"],
  limitations: ["自报数据"],
  relationToProject: "提供中美对比的基线数字。",
});

let root: string;
let pm: ProjectManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "w10-beta-")); pm = new ProjectManager(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function keyOf(project: ReturnType<ProjectManager["create"]>): string {
  const lib = new LibraryStore(project.paths.libraryDb);
  try { return libraryKeyIndex(lib.list()).keys[0] ?? "unknown"; } finally { lib.close(); }
}

describe("β-2 · partial 事件（papers / search_source / card）", () => {
  test("检索一回来就推候选清单与每源结果，且在下载/精读开跑之前（DONE：检索完成 ≤ 10s 出现论文标题）", async () => {
    const project = pm.create("beta-partial", { name: "x", description: "中美 RSI 对比" });
    const llm = new StreamingScriptLlm([CARD, CARD, CARD, () => `# 综述\n\nRSI 患病率约三成[@${keyOf(project)}]。`]);
    const events: PartialEvent[] = [];
    const notes: string[] = [];
    const t0 = Date.now();
    const r = await runLiteraturePipeline(
      {
        llm,
        project,
        sessionId: "s-partial",
        searcher: fakeSearcher(3),
        downloadPdf: async () => ({ ok: false, reason: "no-oa" }),
        note: (m) => notes.push(m),
        emitPartial: (e) => events.push(e),
        taskId: "t1",
      },
      { mode: "review", depth: "deep", queries: ["rsi"], topic: "中美 RSI", maxRead: 3 },
    );
    expect(r.ok).toBe(true);

    const papers = events.filter((e) => e.kind === "papers");
    expect(papers).toHaveLength(1);
    const payload = papers[0]!.payload as PartialPapersPayload;
    expect(payload.query).toBe("rsi");
    expect(payload.found).toBe(3);
    expect(payload.papers.map((p) => p.title)).toEqual([
      "Paper 0 on repetitive strain injury",
      "Paper 1 on repetitive strain injury",
      "Paper 2 on repetitive strain injury",
    ]);
    expect(payload.papers[0]!.doi).toBe("10.1000/rsi.0");
    expect(payload.papers[0]!.year).toBe(2020);
    expect(papers[0]!.taskId).toBe("t1");
    // 「≤ 10s」在假 LLM 下是个上界检查：真实检索的耗时由 lane α 管，这里钉的是
    // **事件的位置**——它必须在下载与精读之前发出，而不是跟着最终结果一起来。
    expect(papers[0]!.ts - t0).toBeLessThan(10_000);
    const firstCardAt = events.findIndex((e) => e.kind === "card");
    expect(events.indexOf(papers[0]!)).toBeLessThan(firstCardAt);
    expect(notes.indexOf("下载 PDF：Paper 0 on repetitive strain injury")).toBeGreaterThanOrEqual(0);

    // 每源一条，失败源也推（不然「查了但失败」和「根本没查」在界面上一样）。
    const sources = events.filter((e) => e.kind === "search_source").map((e) => e.payload as PartialSearchSourcePayload);
    expect(sources.map((s) => `${s.source}:${s.outcome}`)).toEqual(["openalex:ok", "arxiv:failed"]);
    expect(sources[0]!.count).toBe(3);
    expect(sources[1]!.error).toContain("429");
    expect(sources[0]!.error).toBeUndefined();
    project.close();
  });

  test("每张精读卡完成推一条 card，带标题 + 一句 keyFindings（不是等 8 张一起给）", async () => {
    const project = pm.create("beta-card", { name: "x" });
    const llm = new StreamingScriptLlm([CARD, CARD, CARD, () => `# 综述\n\n一句[@${keyOf(project)}]。`]);
    const events: PartialEvent[] = [];
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s-card", searcher: fakeSearcher(3), downloadPdf: async () => ({ ok: false }), emitPartial: (e) => events.push(e) },
      { mode: "review", depth: "deep", queries: ["rsi"], maxRead: 3 },
    );
    const cards = events.filter((e) => e.kind === "card").map((e) => e.payload as PartialCardPayload);
    expect(r.cards).toHaveLength(3);
    expect(cards).toHaveLength(3); // 一卡一条，不多不少
    expect(new Set(cards.map((c) => c.paperId)).size).toBe(3);
    for (const c of cards) {
      expect(c.title).toContain("repetitive strain injury");
      expect(c.keyFinding).toBe("患病率 30%");
      expect(c.basis).toBe("abstract"); // 注入的下载全失败 → 摘要级，如实标
      expect(c.relevance).toBeNull();   // 管线还不产出相关性分：null，不是 0
    }
    project.close();
  });

  test("不给 emitPartial = 完全空操作（CLI 与既有测试路径逐字节不变）", async () => {
    const project = pm.create("beta-noop", { name: "x" });
    const llm = new StreamingScriptLlm([CARD, () => `# 综述\n\n一句[@${keyOf(project)}]。`]);
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s-noop", searcher: fakeSearcher(1), downloadPdf: async () => ({ ok: false }) },
      { mode: "review", depth: "deep", queries: ["rsi"], maxRead: 1 },
    );
    expect(r.ok).toBe(true);
    expect(r.cards).toHaveLength(1);
    expect(llm.streamed.every((s) => s === false), "没给 onDelta 却走了流式分支").toBe(true);
    project.close();
  });

  test("观察者抛异常不许弄死管线，但要留痕（不是静默 catch）", async () => {
    const project = pm.create("beta-throw", { name: "x" });
    const llm = new StreamingScriptLlm([CARD, () => `# 综述\n\n一句[@${keyOf(project)}]。`]);
    const notes: string[] = [];
    const r = await runLiteraturePipeline(
      {
        llm, project, sessionId: "s-throw", searcher: fakeSearcher(1), downloadPdf: async () => ({ ok: false }),
        note: (m) => notes.push(m),
        emitPartial: () => { throw new Error("SSE 已关闭"); },
      },
      { mode: "review", depth: "deep", queries: ["rsi"], maxRead: 1 },
    );
    expect(r.ok).toBe(true);
    expect(notes.join("\n")).toContain("推送失败");
    project.close();
  });
});

describe("β-3 · delta 的 target / revision", () => {
  test("综述正文逐块到达且 target = review；拼起来就是落库的正文", async () => {
    const project = pm.create("beta-delta", { name: "x" });
    const llm = new StreamingScriptLlm([CARD, CARD, (p) => (p.includes("综述") || p.includes("白名单") ? `# 综述\n\nRSI 患病率约三成，证据仍以横断面为主[@${keyOf(project)}]。` : CARD)]);
    const deltas: DeltaEvent[] = [];
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s-delta", searcher: fakeSearcher(2), downloadPdf: async () => ({ ok: false }), onDelta: (d) => deltas.push(d) },
      { mode: "review", depth: "deep", queries: ["rsi"], maxRead: 2 },
    );
    expect(r.review).not.toBeNull();
    const review = deltas.filter((d) => d.target === "review");
    expect(review.length, "综述没有逐块到达——onDelta 没被接到 review.ts 的调用点").toBeGreaterThan(1);
    expect(review.every((d) => d.revision === 1)).toBe(true);
    expect(review.map((d) => d.chunk).join("")).toContain("RSI 患病率约三成");
    expect(r.review!.markdownHead).toContain(review.map((d) => d.chunk).join("").slice(0, 20).trim().slice(0, 10));

    // 精读卡也流式，target = card:<paperId>，且 paperId 真的是库内 id（不是占位串）。
    const cardDeltas = deltas.filter((d) => d.target.startsWith("card:"));
    expect(cardDeltas.length).toBeGreaterThan(1);
    const ids = new Set(cardDeltas.map((d) => d.target.slice("card:".length)));
    for (const id of ids) expect(r.cards.some((c) => c.paperId === id), `delta 的 target 里那个 id 不在本次精读的卡里：${id}`).toBe(true);
    project.close();
  });

  test("综述重写一稿（引用了库外 key）→ revision +1，前端据此清空重画", async () => {
    const project = pm.create("beta-rev", { name: "x" });
    let reviewCall = 0;
    const llm = new StreamingScriptLlm([
      CARD,
      () => {
        reviewCall++;
        // 第一稿引用库外 key → 被 veto → 生成器重试一次；第二稿改用库内 key。
        return reviewCall === 1 ? "# 综述\n\n一句[@not-in-library2020]。" : `# 综述\n\n一句[@${keyOf(project)}]。`;
      },
    ]);
    const deltas: DeltaEvent[] = [];
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s-rev", searcher: fakeSearcher(1), downloadPdf: async () => ({ ok: false }), onDelta: (d) => deltas.push(d) },
      { mode: "review", depth: "deep", queries: ["rsi"], maxRead: 1 },
    );
    expect(r.review).not.toBeNull();
    const revisions = [...new Set(deltas.filter((d) => d.target === "review").map((d) => d.revision))];
    expect(revisions).toEqual([1, 2]);
    project.close();
  });
});
