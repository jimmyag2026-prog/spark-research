// v0.10 lane α（速度工程）门禁。
//
// 纪律（_COMMON.md 第 3 条）：**钉接线，不只钉内容**——U40/U47 的教训是「判据存在
// 但没被读到，测试照样绿」。所以每条门禁都尽量断言「那个东西真的没进下一阶段的
// 提示词 / 真的出现在发出去的请求体里」，而不只是断言某个返回字段等于某个数。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { runLiteraturePipeline } from "../../backend/src/agents/literature_pipeline";
import { LibraryStore } from "../../backend/src/literature/library";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import { ReadingCardGenerator } from "../../backend/src/literature/reading";
import { DEFAULT_READ_CONCURRENCY, STAGE_MAX_TOKENS, normalizeConcurrency } from "../../backend/src/literature/limits";
import { parsePrescreenScores, prescreenCandidates } from "../../backend/src/literature/prescreen";
import type { LiteratureSearchResult } from "../../backend/src/literature/search";
import { UsageStore, usageTrackingLlm } from "../../backend/src/usage/ledger";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

// ── 真实会话样本（T1 recursive self-improvement，workspaces/web_1789480157513）──
const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "../fixtures/literature/t1-lit-review-rsi-candidates.json"), "utf8"),
) as {
  topic: string;
  queries: string[];
  candidates: Array<{ title: string; year: number | null; abstract: string | null }>;
  _expectDropped: string[];
  _expectKept: string[];
};

const paperOf = (title: string, i: number, year: number | null) => ({
  title,
  authors: [{ name: `Author ${i}` }],
  year,
  venue: "J Test",
  doi: `10.1000/t1.${i}`,
  ids: { doi: `10.1000/t1.${i}` },
  abstract: null,
  url: null,
  pdfUrl: null,
  citedByCount: 10,
  isOpenAccess: false,
  sources: ["openalex"],
  references: [],
});

const fixtureSearcher = () => ({
  async search(query: string): Promise<LiteratureSearchResult> {
    return {
      query,
      sources: [{ source: "openalex", outcome: "ok", count: FIXTURE.candidates.length, elapsedMs: 5 }],
      papers: FIXTURE.candidates.map((c, i) => paperOf(c.title, i, c.year)),
    } as unknown as LiteratureSearchResult;
  },
});

/** 记录每一次调用的 prompt 与 options（门禁靠它看「真的发了什么」）。 */
class RecordingLlm {
  readonly prompts: string[] = [];
  readonly options: Array<Record<string, unknown> | string | undefined> = [];
  private i = 0;
  constructor(private readonly replies: Array<string | ((prompt: string) => string)>) {}
  async call(messages: ChatMessage[], options?: unknown): Promise<LlmResponse> {
    const prompt = messages.map((m) => (m as { content?: string }).content ?? "").join("\n");
    this.prompts.push(prompt);
    this.options.push(options as Record<string, unknown> | string | undefined);
    const r = this.replies[Math.min(this.i++, this.replies.length - 1)]!;
    return {
      ok: true,
      content: typeof r === "function" ? r(prompt) : r,
      provider: "test",
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: [],
    } as unknown as LlmResponse;
  }
}

/** 按 fixture 的「应剔除」清单给分：1..N 对应 FIXTURE.candidates 的顺序。 */
function fixtureScores(): string {
  return JSON.stringify(
    FIXTURE.candidates.map((c, i) => [i + 1, FIXTURE._expectDropped.includes(c.title) ? 0 : 3]),
  );
}

const CARD = JSON.stringify({
  researchQuestion: "递归自我改进的可行边界？",
  methods: "综述 + 案例分析。",
  keyFindings: ["能力跃迁呈阶梯而非连续"],
  limitations: ["缺乏可复现实验"],
  relationToProject: "提供本项目的对照基线。",
});

let root: string;
let pm: ProjectManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "w10a-")); pm = new ProjectManager(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// 综述里要引一个**入选论文**的 key（引用白名单只含入选的那批）。
const keyOfKept = (project: { paths: { libraryDb: string } }) => {
  const lib = new LibraryStore(project.paths.libraryDb);
  try {
    const idx = libraryKeyIndex(lib.list());
    const paper = lib.list().find((p) => p.title === FIXTURE._expectKept[0]);
    return (paper && idx.byId.get(paper.id)) ?? idx.keys[0] ?? "unknown";
  } finally { lib.close(); }
};

// ────────────────────────────── α-1 ──────────────────────────────
describe("α-1 · S9 两档综述", () => {
  test("quick 是默认档；LLM 调用数 ≤ 2（预筛 1 + 综述 1），不下载、不建卡", async () => {
    const project = pm.create("a1-quick", { name: "x", description: "递归自我改进" });
    const llm = new RecordingLlm([fixtureScores(), () => `# 综述\n\n能力跃迁呈阶梯[@${keyOfKept(project)}]。`]);
    let downloads = 0;
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s", searcher: fixtureSearcher(), downloadPdf: async () => { downloads++; return { ok: false }; } },
      { mode: "review", queries: [FIXTURE.queries[0]!], topic: FIXTURE.topic },
    );
    expect(r.depth).toBe("quick");           // 没传 depth = quick
    expect(r.ok).toBe(true);
    expect(r.llmCalls).toBeLessThanOrEqual(2);
    expect(r.llmCalls).toBe(2);
    expect(downloads).toBe(0);               // quick 档一次 PDF 都不拉
    expect(r.cards).toHaveLength(0);         // 一张精读卡都不建
    expect(r.review).not.toBeNull();
    expect(r.review!.unknownKeys).toBe(0);   // 引用仍只许库内 key
    project.close();
  });

  test("quick 综述提示词走同一套白名单语法，并声明「仅摘要」材料级别", async () => {
    const project = pm.create("a1-prompt", { name: "x" });
    const llm = new RecordingLlm([fixtureScores(), () => `# 综述\n\n见[@${keyOfKept(project)}]。`]);
    await runLiteraturePipeline(
      { llm, project, sessionId: "s", searcher: fixtureSearcher() },
      { mode: "review", queries: ["rsi"], topic: FIXTURE.topic },
    );
    const reviewPrompt = llm.prompts[1]!;
    expect(reviewPrompt).toContain("可用引用 key 白名单");
    expect(reviewPrompt).toContain("仅摘要");
    expect(reviewPrompt).toContain("[@");
    project.close();
  });

  test("综述 record 记下 depth（quick 的综述不许被当成精读产物）", async () => {
    const project = pm.create("a1-depth-record", { name: "x" });
    const llm = new RecordingLlm([fixtureScores(), () => `# 综述\n\n见[@${keyOfKept(project)}]。`]);
    await runLiteraturePipeline({ llm, project, sessionId: "s", searcher: fixtureSearcher() }, { mode: "review", queries: ["rsi"] });
    const drafts = project.records().list().filter((rec) => (rec.metadata as { kind?: string }).kind === "review_draft");
    expect(drafts).toHaveLength(1);
    expect((drafts[0]!.metadata as { depth?: string }).depth).toBe("quick");
    project.close();
  });

  test("deep 档：预筛后逐篇建卡，综述走精读卡路径", async () => {
    const project = pm.create("a1-deep", { name: "x" });
    const kept = FIXTURE.candidates.length - FIXTURE._expectDropped.length;
    const llm = new RecordingLlm([
      fixtureScores(),
      ...Array.from({ length: kept }, () => CARD),
      () => `# 综述\n\n见[@${keyOfKept(project)}]。`,
    ]);
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s", searcher: fixtureSearcher(), downloadPdf: async () => ({ ok: false, reason: "no-oa" }) },
      { mode: "review", queries: ["rsi"], depth: "deep", topic: FIXTURE.topic },
    );
    expect(r.depth).toBe("deep");
    expect(r.cards).toHaveLength(kept);
    expect(r.downloads).toHaveLength(kept);  // 只下载入选的，被剔的一篇都不拉
    expect(r.ok).toBe(true);
    project.close();
  });
});

describe("α-1 · 批量预筛（真实会话样本 t1-lit-review-rsi）", () => {
  test("接线：被剔除的候选不进综述提示词、不建卡、不下载", async () => {
    const project = pm.create("a1-screen", { name: "x" });
    const llm = new RecordingLlm([fixtureScores(), () => `# 综述\n\n见[@${keyOfKept(project)}]。`]);
    const pulled: string[] = [];
    const r = await runLiteraturePipeline(
      {
        llm, project, sessionId: "s", searcher: fixtureSearcher(),
        downloadPdf: async (lib, id) => { pulled.push(lib.get(id)?.title ?? id); return { ok: false }; },
      },
      { mode: "review", queries: ["rsi"], topic: FIXTURE.topic },
    );
    expect(r.prescreen.enabled).toBe(true);
    expect(r.prescreen.candidates).toBe(FIXTURE.candidates.length);
    expect(r.prescreen.kept).toBe(FIXTURE._expectKept.length);
    expect(r.prescreen.llmCalls).toBe(1);

    const reviewPrompt = llm.prompts[1]!;
    for (const title of FIXTURE._expectDropped) {
      // 关键一条：不是「结果里标了剔除」，而是**下一阶段的提示词里真的没有它**。
      expect(reviewPrompt).not.toContain(title);
      expect(pulled).not.toContain(title);
    }
    for (const title of FIXTURE._expectKept) expect(reviewPrompt).toContain(title);
    // digest 必须如实说剔了什么（静默丢文献是最难发现的错误）。
    expect(r.digest).toContain("剔除");
    project.close();
  });

  test("预筛关掉（阴性对照口径）→ 无关项原样进综述", async () => {
    const project = pm.create("a1-screen-off", { name: "x" });
    const llm = new RecordingLlm([() => `# 综述\n\n见[@${keyOfKept(project)}]。`]);
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s", searcher: fixtureSearcher() },
      { mode: "review", queries: ["rsi"], topic: FIXTURE.topic, prescreen: false },
    );
    expect(r.prescreen.enabled).toBe(false);
    expect(r.llmCalls).toBe(1); // 关掉预筛就只剩综述那一次
    const reviewPrompt = llm.prompts[0]!;
    for (const title of FIXTURE._expectDropped) expect(reviewPrompt).toContain(title);
    project.close();
  });

  test("fail-open：预筛输出无法解析 → 全留 + note 写明原因（绝不因筛选器坏了丢文献）", async () => {
    const llm = new RecordingLlm(["抱歉，我无法完成这个任务。"]);
    const candidates = FIXTURE.candidates.map((c, i) => ({ id: `p${i}`, title: c.title, year: c.year, abstract: c.abstract }));
    const r = await prescreenCandidates({ llm }, candidates, { topic: FIXTURE.topic, topK: 2, skipBelow: 0 });
    expect(r.failOpen).toBe(true);
    expect(r.dropped).toHaveLength(0);
    expect(r.kept).toHaveLength(candidates.length);
    expect(r.note).toContain("fail-open");
  });

  test("候选 ≤ 3 篇时不为预筛多花一次调用", async () => {
    const llm = new RecordingLlm(["[[1,3]]"]);
    const r = await prescreenCandidates({ llm }, [{ id: "a", title: "t", year: null, abstract: null }], { topic: "x", topK: 8 });
    expect(r.llmCalls).toBe(0);
    expect(llm.prompts).toHaveLength(0);
  });

  test("全员低分不返回空集（退回 top-K），非法分数/越界编号算解析失败", () => {
    expect(parsePrescreenScores("[[1,3],[2,0]]", 2)?.get(1)).toBe(3);
    expect(parsePrescreenScores("[[1,5]]", 2)).toBeNull();   // 分数越界
    expect(parsePrescreenScores("[[9,3]]", 2)).toBeNull();   // 编号越界
    expect(parsePrescreenScores("没有 JSON", 2)).toBeNull();
  });
});

// ────────────────────────────── α-2 ──────────────────────────────
describe("α-2 · S3 精读并行", () => {
  const manyPapers = (n: number) => Array.from({ length: n }, (_, i) => paperOf(`Paper ${i} on self-improvement`, i, 2020));

  /** 记录并发峰值的 llm。 */
  class ConcurrencyProbeLlm {
    inFlight = 0;
    peak = 0;
    async call(): Promise<LlmResponse> {
      this.inFlight++;
      this.peak = Math.max(this.peak, this.inFlight);
      await new Promise((r) => setTimeout(r, 15));
      this.inFlight--;
      return { ok: true, content: CARD, provider: "test", model: "test", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] } as unknown as LlmResponse;
    }
  }

  test("默认并行度 = 3（W10-0 实测值），单一真源在 limits.ts", () => {
    expect(DEFAULT_READ_CONCURRENCY).toBe(3);
    expect(ReadingCardGenerator.DEFAULT_CONCURRENCY).toBe(3);
    expect(normalizeConcurrency(undefined)).toBe(3);
    expect(normalizeConcurrency(0)).toBe(3);
    expect(normalizeConcurrency(Number.NaN)).toBe(3);
    expect(normalizeConcurrency(5)).toBe(5);
  });

  test("generateMany 真的并行到 N，且返回顺序仍按输入顺序", async () => {
    const project = pm.create("a2-conc", { name: "x" });
    const lib = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const ids = manyPapers(8).map((p) => lib.add(p as never, { tags: ["t"] }).paper.id);
    const llm = new ConcurrencyProbeLlm();
    const gen = new ReadingCardGenerator({ llm: llm as never, library: lib, records: project.records() });
    const out = await gen.generateMany(ids, { concurrency: 3 });
    expect(llm.peak).toBe(3);
    expect(out.cards).toHaveLength(8);
    expect(out.cards.map((c) => c.paperId)).toEqual(ids); // 顺序不许被并发打乱
    lib.close();
    project.close();
  });

  test("concurrency:1 = v0.9 的串行行为（峰值 1）", async () => {
    const project = pm.create("a2-serial", { name: "x" });
    const lib = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const ids = manyPapers(4).map((p) => lib.add(p as never, { tags: ["t"] }).paper.id);
    const llm = new ConcurrencyProbeLlm();
    const gen = new ReadingCardGenerator({ llm: llm as never, library: lib, records: project.records() });
    await gen.generateMany(ids, { concurrency: 1 });
    expect(llm.peak).toBe(1);
    lib.close();
    project.close();
  });

  test("一篇失败不影响其余，onProgress 的 done 单调递增到 total", async () => {
    const project = pm.create("a2-fail", { name: "x" });
    const lib = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const ids = manyPapers(5).map((p) => lib.add(p as never, { tags: ["t"] }).paper.id);
    let n = 0;
    const llm = {
      async call(): Promise<LlmResponse> {
        const bad = n++ % 5 === 2; // 第 3 篇的两次尝试都吐垃圾
        return { ok: true, content: bad ? "不是 JSON" : CARD, provider: "test", model: "test", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] } as unknown as LlmResponse;
      },
    };
    const seen: number[] = [];
    const gen = new ReadingCardGenerator({ llm: llm as never, library: lib, records: project.records() });
    const out = await gen.generateMany(ids, { concurrency: 3, onProgress: (p) => seen.push(p.done) });
    expect(out.cards.length + out.failures.length).toBe(5);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    lib.close();
    project.close();
  });

  test("A7 口径：并发 3 走 usageTrackingLlm，实际花费 ≤ 上限 × 1.2（预算闸不被并发打穿）", async () => {
    const project = pm.create("a2-budget", { name: "x" });
    const lib = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const ids = manyPapers(10).map((p) => lib.add(p as never, { tags: ["t"] }).paper.id);
    const COST = 0.01;
    const CAP = 0.05;
    let calls = 0;
    const inner = {
      async call(): Promise<LlmResponse> {
        calls++;
        await new Promise((r) => setTimeout(r, 15)); // 让并发者都先过闸，再有人结算
        return {
          ok: true, provider: "openrouter", model: "moonshotai/kimi-k2.6", content: CARD, toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 10, costUsd: COST, usageUnavailable: false },
        } as unknown as LlmResponse;
      },
    };
    const wrapped = usageTrackingLlm({
      llm: inner,
      store: new UsageStore(join(root, "usage.jsonl")),
      command: "test",
      budgetUsd: CAP,
      estimateUsd: () => COST,
    });
    const gen = new ReadingCardGenerator({ llm: wrapped, library: lib, records: project.records() });
    await gen.generateMany(ids, { concurrency: 3 });
    const spent = wrapped.ledger.snapshot().knownCostUsd;
    expect(calls * COST).toBeLessThanOrEqual(CAP * 1.2);
    expect(spent).toBeLessThanOrEqual(CAP * 1.2);
    expect(wrapped.ledger.snapshot().inFlightUsd).toBe(0); // 无残留预留
    lib.close();
    project.close();
  });

  test("接线：pipeline 的 deep 档真的并行到 3（不传 readConcurrency 时）", async () => {
    const project = pm.create("a2-pipe", { name: "x" });
    let inFlight = 0;
    let peak = 0;
    const llm = {
      async call(messages: ChatMessage[]): Promise<LlmResponse> {
        const prompt = messages.map((m) => (m as { content?: string }).content ?? "").join("\n");
        const isCard = prompt.includes("待精读论文");
        if (isCard) { inFlight++; peak = Math.max(peak, inFlight); }
        await new Promise((r) => setTimeout(r, 10));
        if (isCard) inFlight--;
        const scores = JSON.stringify(Array.from({ length: 8 }, (_, i) => [i + 1, 3]));
        return {
          ok: true,
          content: prompt.includes("相关性分数") ? scores : isCard ? CARD : `# 综述\n\n见[@${keyOfKept(project)}]。`,
          provider: "test", model: "test", usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [],
        } as unknown as LlmResponse;
      },
    };
    const searcher = {
      async search(query: string): Promise<LiteratureSearchResult> {
        return { query, sources: [], papers: manyPapers(8) } as unknown as LiteratureSearchResult;
      },
    };
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s", searcher, downloadPdf: async () => ({ ok: false }) },
      { mode: "review", queries: ["x"], depth: "deep", topK: 8 },
    );
    expect(r.cards).toHaveLength(8);
    expect(peak).toBe(3);
    project.close();
  });
});

// ────────────────────────────── α-3 ──────────────────────────────
describe("α-3 · 各阶段 maxTokens", () => {
  test("方案 §三 α-3 的数字就是表里的数字（改表要同时改方案）", () => {
    expect(STAGE_MAX_TOKENS).toMatchObject({ plan: 600, analysis: 900, summarize: 1200, card: 700, review: 2500 });
  });

  test("接线：精读卡调用带 maxTokens=700、综述带 2500、预筛带 300", async () => {
    const project = pm.create("a3-wire", { name: "x" });
    const llm = new RecordingLlm([fixtureScores(), CARD, CARD, () => `# 综述\n\n见[@${keyOfKept(project)}]。`]);
    await runLiteraturePipeline(
      { llm, project, sessionId: "s", searcher: fixtureSearcher(), downloadPdf: async () => ({ ok: false }) },
      { mode: "review", queries: ["rsi"], depth: "deep", topic: FIXTURE.topic },
    );
    const maxOf = (i: number) => (llm.options[i] as { maxTokens?: number } | undefined)?.maxTokens;
    expect(maxOf(0)).toBe(STAGE_MAX_TOKENS.prescreen);
    expect(maxOf(1)).toBe(STAGE_MAX_TOKENS.card);
    expect(maxOf(llm.options.length - 1)).toBe(STAGE_MAX_TOKENS.review);
    project.close();
  });

  test("接线：OpenAI 兼容请求体真的带上 max_tokens（P11 起声明、从未被消费）", async () => {
    const { OpenAiCompatAdapter } = await import("../../backend/src/llm/providers/openai_compat");
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = new OpenAiCompatAdapter({ id: "deepseek", baseUrl: "https://example.invalid/v1" });
    const base = { model: "m", messages: [{ role: "user" as const, content: "hi" }], apiKey: "k", baseUrl: "", timeoutMs: 5000, fetchImpl };
    await adapter.call({ ...base, options: { maxTokens: 700 } } as never);
    await adapter.call({ ...base, options: {} } as never);
    expect(bodies[0]!.max_tokens).toBe(700);
    expect("max_tokens" in bodies[1]!).toBe(false); // 不传时不加字段 → 既有行为不变
  });
});

// ────────────────────────────── α-4 ──────────────────────────────
import { PdfDownloader, pdfLinkFromLandingPage, unpaywallPdfUrl, unpaywallUrl } from "../../backend/src/literature/pdf";
import type { HttpClient, HttpRequestInit, HttpResponse } from "../../backend/src/http/client";

/** 按 URL 给固定响应的假 http（每次请求都记下来，门禁靠它数「发了几次、发给谁」）。 */
class StubHttp implements HttpClient {
  readonly requests: string[] = [];
  constructor(private readonly routes: Array<{ match: RegExp; status?: number; body: string | Uint8Array; headers?: Record<string, string> }>) {}
  async request(url: string, _init?: HttpRequestInit): Promise<HttpResponse> {
    this.requests.push(url);
    const hit = this.routes.find((r) => r.match.test(url));
    const body = hit?.body ?? "";
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const status = hit?.status ?? (hit ? 200 : 404);
    return {
      status, ok: status >= 200 && status < 300, url,
      headers: hit?.headers ?? { "content-type": "text/html" },
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      bytes: async () => bytes,
    };
  }
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfake");
const seedPaper = (project: { paths: { libraryDb: string }; records: () => never }, extra: Record<string, unknown>) => {
  const lib = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  const id = lib.add({ ...paperOf("Landing page paper", 1, 2024), ...extra } as never, { tags: ["t"] }).paper.id;
  return { lib, id };
};

describe("α-4 · S10 全文命中率", () => {
  test("落地页解析：citation_pdf_url 与 <link rel=alternate type=pdf> 都认，相对链接按落地页解析", () => {
    expect(pdfLinkFromLandingPage(`<meta name="citation_pdf_url" content="https://x.test/a.pdf">`, "https://x.test/art/1"))
      .toBe("https://x.test/a.pdf");
    expect(pdfLinkFromLandingPage(`<meta content="/rel.pdf" name="citation_pdf_url">`, "https://x.test/art/1"))
      .toBe("https://x.test/rel.pdf");
    expect(pdfLinkFromLandingPage(`<link rel="alternate" type="application/pdf" href="/alt.pdf">`, "https://x.test/art/1"))
      .toBe("https://x.test/alt.pdf");
    expect(pdfLinkFromLandingPage(`<html>没有任何 pdf 线索</html>`, "https://x.test/art/1")).toBeNull();
  });

  test("接线：not_a_pdf 的落地页 → 顺元标签走一跳真的拿到 PDF（origin=landing_meta）", async () => {
    const project = pm.create("a4-hop", { name: "x" });
    const { lib, id } = seedPaper(project as never, { pdfUrl: "https://pub.test/article/99" });
    const http = new StubHttp([
      { match: /article\/99$/, body: `<html><meta name="citation_pdf_url" content="https://pub.test/pdf/99.pdf"></html>` },
      { match: /pdf\/99\.pdf$/, body: PDF_BYTES, headers: { "content-type": "application/pdf" } },
    ]);
    const r = await new PdfDownloader({ http, papersDir: join(root, "papers"), library: lib, contactEmail: "a@b.test" }).download(id);
    expect(r.ok).toBe(true);
    expect(r.origin).toBe("landing_meta");
    expect(http.requests).toEqual(["https://pub.test/article/99", "https://pub.test/pdf/99.pdf"]);
    lib.close();
    project.close();
  });

  test("接线：直链全失败 → 按 DOI 问一次 Unpaywall 并下到 PDF（origin=unpaywall）", async () => {
    const project = pm.create("a4-unpaywall", { name: "x" });
    const { lib, id } = seedPaper(project as never, { pdfUrl: "https://paywall.test/x", doi: "10.1000/t1.1" });
    const http = new StubHttp([
      { match: /paywall\.test/, status: 403, body: "no" },
      { match: /api\.unpaywall\.org/, body: JSON.stringify({ best_oa_location: { url_for_pdf: "https://oa.test/real.pdf" } }), headers: { "content-type": "application/json" } },
      { match: /oa\.test/, body: PDF_BYTES, headers: { "content-type": "application/pdf" } },
    ]);
    const r = await new PdfDownloader({ http, papersDir: join(root, "papers"), library: lib, contactEmail: "a@b.test" }).download(id);
    expect(r.ok).toBe(true);
    expect(r.origin).toBe("unpaywall");
    expect(http.requests.some((u) => u.startsWith("https://api.unpaywall.org/v2/10.1000%2Ft1.1?email=a%40b.test"))).toBe(true);
    lib.close();
    project.close();
  });

  test("contactEmail 未配置（占位邮箱）→ 不敲 Unpaywall，但降级留痕", async () => {
    const project = pm.create("a4-noemail", { name: "x" });
    const { lib, id } = seedPaper(project as never, { pdfUrl: "https://paywall.test/x", doi: "10.1000/t1.1" });
    const http = new StubHttp([{ match: /paywall\.test/, status: 403, body: "no" }]);
    const r = await new PdfDownloader({
      http, papersDir: join(root, "papers"), library: lib,
      contactEmail: "spark-research@example.invalid",
    }).download(id);
    expect(r.ok).toBe(false);
    expect(http.requests.some((u) => u.includes("unpaywall"))).toBe(false);
    expect(r.attempts.some((a) => a.outcome.includes("contactEmail 未配置"))).toBe(true);
    lib.close();
    project.close();
  });

  test("拿不到 PDF 时 OA 标记标成 openalex(optimistic)（U51：标了 OA ≠ 能下到）", async () => {
    const project = pm.create("a4-oa", { name: "x" });
    const { lib, id } = seedPaper(project as never, { pdfUrl: "https://paywall.test/x", isOpenAccess: true });
    const http = new StubHttp([{ match: /paywall\.test/, status: 403, body: "no" }]);
    const r = await new PdfDownloader({ http, papersDir: join(root, "papers"), library: lib, unpaywall: false }).download(id);
    expect(r.ok).toBe(false);
    expect(r.oaSource).toBe("openalex(optimistic)");
    lib.close();
    project.close();
  });

  test("Unpaywall 响应解析：best 优先，其次任意 url_for_pdf；都没有就 null", () => {
    expect(unpaywallPdfUrl({ best_oa_location: { url_for_pdf: "https://a.test/1.pdf" } })).toBe("https://a.test/1.pdf");
    expect(unpaywallPdfUrl({ best_oa_location: { url_for_pdf: null }, oa_locations: [{ url_for_pdf: "https://b.test/2.pdf" }] })).toBe("https://b.test/2.pdf");
    expect(unpaywallPdfUrl({ best_oa_location: null, oa_locations: [] })).toBeNull();
    expect(unpaywallUrl("https://doi.org/10.1/x", "a@b.test")).toBe("https://api.unpaywall.org/v2/10.1%2Fx?email=a%40b.test");
  });
});

// ────────────────────────────── α-5 ──────────────────────────────
import { HOST_RATE_POLICIES, MAX_RETRY_AFTER_MS, RateLimitedHttp, bucketKeyForHost, parseRetryAfterMs } from "../../backend/src/http/ratelimit";
import { pickHeaders } from "../../backend/src/http/client";

describe("α-5 · arXiv 令牌桶 + Retry-After", () => {
  test("检索与 PDF 直链归到同一个桶键（否则对 arXiv 就是 1.5s 一次）", () => {
    expect(bucketKeyForHost("export.arxiv.org")).toBe("arxiv.org");
    expect(bucketKeyForHost("arxiv.org")).toBe("arxiv.org");
    expect(bucketKeyForHost("api.openalex.org")).toBe("api.openalex.org"); // 未归并的照旧 = host
    expect(HOST_RATE_POLICIES["arxiv.org"]!.rps).toBeCloseTo(1 / 3, 10);
    expect(HOST_RATE_POLICIES["arxiv.org"]!.burst).toBe(1);
  });

  test("接线：NativeHttp 的响应头白名单含 retry-after（不含它 = 冷却逻辑永远读到 undefined）", () => {
    const kept = pickHeaders(new Headers({ "retry-after": "7", "set-cookie": "a=b", "content-type": "text/html" }));
    expect(kept["retry-after"]).toBe("7");
    expect(kept["set-cookie"]).toBeUndefined();
  });

  test("Retry-After 解析：秒数、HTTP-date、上限 60s、垃圾值 → null", () => {
    const now = Date.parse("2026-09-16T00:00:00Z");
    expect(parseRetryAfterMs("7", now)).toBe(7000);
    expect(parseRetryAfterMs("9999", now)).toBe(MAX_RETRY_AFTER_MS); // 上限截断，绝不无限等
    expect(parseRetryAfterMs("Wed, 16 Sep 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfterMs("随便写点什么", now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
  });

  test("接线：假 429 + Retry-After → 冷却期内一个请求都不发（不浪费一次请求）", async () => {
    let now = 1_000_000;
    const sent: string[] = [];
    const inner: HttpClient = {
      async request(url: string): Promise<HttpResponse> {
        sent.push(url);
        return {
          status: 429, ok: false, url, headers: { "retry-after": "30" },
          text: async () => "", json: async () => ({}), bytes: async () => new Uint8Array(),
        };
      },
    };
    const limiter = new RateLimitedHttp(inner, HOST_RATE_POLICIES, () => now);
    await limiter.request("https://export.arxiv.org/api/query?q=1");
    expect(sent).toHaveLength(1);
    expect(limiter.cooldownOf("arxiv.org")).toBe(now + 30_000); // 检索侧的 429 冷却了 PDF 侧

    // 冷却期内发第二条（走 PDF 那个 host）：等着，不发。
    const pending = limiter.request("https://arxiv.org/pdf/2303.12712");
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toHaveLength(1); // ← 冷却期内 0 请求

    now += 31_000; // 冷却过去
    await pending;
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("arxiv.org/pdf");
  });

  test("没有 Retry-After 头的 429 不设冷却（没有可核实的数字就不自己编一个退避）", async () => {
    let now = 2_000_000;
    const inner: HttpClient = {
      async request(url: string): Promise<HttpResponse> {
        return { status: 429, ok: false, url, headers: {}, text: async () => "", json: async () => ({}), bytes: async () => new Uint8Array() };
      },
    };
    const limiter = new RateLimitedHttp(inner, HOST_RATE_POLICIES, () => now);
    await limiter.request("https://export.arxiv.org/api/query");
    expect(limiter.cooldownOf("arxiv.org")).toBeNull();
  });
});
