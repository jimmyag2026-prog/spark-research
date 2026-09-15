// V172（v0.9.1，用户 2026-09-15 定义的五步流程）：chat 的 `skill` 任务对文献类技能**真执行**，
// 而不是只把技能说明书塞给模型。五步各自对应仓库里早已被六轮验收打磨过的实现：
//   ① 关键词拆解 —— 由规划器在 plan 阶段产出 `params.queries[]`（本文件只消费它）
//   ② 多源检索取 DOI/索引 —— LiteratureSearcher（7 源并发 + AMiner 词拆分，按 DOI/标题去重）
//   ③ 按索引入库并下载 —— LibraryStore.add + PdfDownloader（OA 直链，SHA256 血缘）
//   ④ 读取确认哪些有用 —— ReadingCardGenerator（逐篇精读卡）
//   ⑤ 综述与总结 —— ReviewDraftGenerator + citationIntegrity（库外引用会被 veto）
// 之前三次真实会话都死在「模型手搓 connector 参数」这条路上（U42 / U47 / U48）；这条路把它绕开。
import { extractPdfText } from "../literature/pdf_text";
import { LibraryStore, type LibraryPaper } from "../literature/library";
import { LiteratureSearcher, type LiteratureSearchResult, type SourceStatus } from "../literature/search";
import { PdfDownloader } from "../literature/pdf";
import { ReadingCardGenerator, listReadingCards, type StoredReadingCard } from "../literature/reading";
import { ReviewDraftGenerator, baselinesFrom, baselinesFromAbstracts, type AbstractEntry } from "../literature/review";
import { prescreenCandidates } from "../literature/prescreen";
import { normalizeConcurrency } from "../literature/limits";
import { libraryKeyIndex } from "../literature/export";
import { citationIntegrity } from "../reviewer/rules";
import { explainCitationGap } from "../reviewer/citation_judge";
import { ConnectorRegistry } from "../connectors/registry";
import { CredentialStore } from "../daemon/credentials";
import type { LiteratureSource } from "../literature/models";
import type { LLMRouter } from "../llm/router";
import type { Project } from "../project/manager";

export type LiteraturePipelineMode = "search" | "review";

/**
 * α-1（v0.10）：综述深度。
 * - `quick`（**默认**）：预筛留 top-K → 这批的**摘要一次调用**出综述。不下载、不建卡。
 *   LLM 调用 ≤ 2 次。摘要级的问题就该用摘要级的成本回答——第五/六次真实会话证明
 *   默认走全文级路径是「用全文的钱做摘要的事」。
 * - `deep`：预筛留 top-K → 下载 PDF → 逐篇精读卡（并行 `readConcurrency`）→ 综述。
 */
export type LiteratureDepth = "quick" | "deep";

export interface LiteraturePipelineDeps {
  llm: Pick<LLMRouter, "call">;
  /** U50：精读卡与综述用的模型（不给 = llm 自己的默认）。 */
  model?: string;
  project: Project;
  sessionId: string;
  /** 测试注入：不给则按凭据 + 内置连接器构造真 searcher。 */
  searcher?: Pick<LiteratureSearcher, "search">;
  /** 测试注入：不给则用真 PdfDownloader。 */
  downloadPdf?: (library: LibraryStore, paperId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 阶段进度（写进执行日志 / progress 事件）。 */
  note?: (message: string) => void;
}

export interface LiteraturePipelineOptions {
  mode: LiteraturePipelineMode;
  queries: string[];
  topic?: string;
  /** 每条查询取多少条（默认 15）。 */
  limit?: number;
  sources?: LiteratureSource[];
  /** review 模式最多精读多少篇（默认 8——每张卡一次 LLM 调用，这是花钱的上限）。 */
  maxRead?: number;
  /** α-1：综述深度，默认 `quick`。 */
  depth?: LiteratureDepth;
  /** α-1：预筛后保留多少篇（默认 8）。 */
  topK?: number;
  /** α-1：关掉预筛（阴性对照 / 明确要「全都要」时用）。默认开。 */
  prescreen?: boolean;
  /** α-2：deep 档精读并行度，默认 `DEFAULT_READ_CONCURRENCY`（=3）。 */
  readConcurrency?: number;
}

export interface LiteraturePipelineResult {
  ok: boolean;
  mode: LiteraturePipelineMode;
  queries: string[];
  searches: Array<{ query: string; sources: SourceStatus[]; found: number }>;
  added: number;
  merged: number;
  library: number;
  /** ③ 下载：paperId → ok / reason */
  downloads: Array<{ paperId: string; title: string; ok: boolean; reason?: string }>;
  /** ④ 精读卡 */
  cards: Array<{ paperId: string; title: string; year: number | null; basis: string | null }>;
  cardFailures: Array<{ paperId: string; error: string }>;
  /** ⑤ 综述 */
  review: null | { artifactId: string | null; path: string | null; citedKeys: number; unknownKeys: number; gap: Record<string, number>; markdownHead: string };
  /** W10-0：各阶段耗时（ms），v0.10 提速的基线与复测都读它。 */
  timings: { search: number; download: number; read: number; review: number; prescreen: number; total: number };
  /** α-1：本次实际走的档位（调用方没给时是默认值，报告里不许靠猜）。 */
  depth: LiteratureDepth;
  /** α-1：预筛结果。`enabled:false` = 被显式关掉（阴性对照路径）。 */
  prescreen: { enabled: boolean; candidates: number; kept: number; dropped: Array<{ paperId: string; title: string; score: number | null }>; llmCalls: number; note: string };
  /** α-1：本次流程真实发出的 LLM 调用数（quick 档的 ≤2 门禁读它）。 */
  llmCalls: number;
  /** 给 summarize 看的人话摘要（≤ 1500 字符）。 */
  digest: string;
  failures: string[];
}

function pick<T>(xs: T[], n: number): T[] {
  return xs.slice(0, Math.max(0, n));
}

export async function runLiteraturePipeline(
  deps: LiteraturePipelineDeps,
  options: LiteraturePipelineOptions,
): Promise<LiteraturePipelineResult> {
  const note = deps.note ?? (() => {});
  const queries = options.queries.map((q) => q.trim()).filter(Boolean);
  const failures: string[] = [];
  const depth: LiteratureDepth = options.depth ?? "quick";
  const topK = options.topK ?? 8;
  // 「本次到底打了几次模型」只能数出来，不能算出来：重试、fail-open、两档不同路径
  // 都会改变次数。这里把 llm 包一层计数器，**所有**下游（预筛/精读/综述）共用它。
  let llmCalls = 0;
  const countingLlm: Pick<LLMRouter, "call"> = {
    call: (messages, modelOrOptions) => {
      llmCalls++;
      return deps.llm.call(messages, modelOrOptions as never);
    },
  };
  const result: LiteraturePipelineResult = {
    ok: false,
    mode: options.mode,
    queries,
    searches: [],
    added: 0,
    merged: 0,
    library: 0,
    downloads: [],
    cards: [],
    cardFailures: [],
    review: null,
    timings: { search: 0, download: 0, read: 0, review: 0, prescreen: 0, total: 0 },
    depth,
    prescreen: { enabled: options.prescreen !== false, candidates: 0, kept: 0, dropped: [], llmCalls: 0, note: "预筛：未执行" },
    llmCalls: 0,
    digest: "",
    failures,
  };
  const T0 = Date.now();
  const mark = (k: keyof LiteraturePipelineResult["timings"], from: number) => { result.timings[k] = Date.now() - from; result.timings.total = Date.now() - T0; };
  if (queries.length === 0) {
    failures.push("没有检索词：规划器应在 params.queries 里给出拆解后的关键词（3–6 条）");
    result.digest = failures[0]!;
    return result;
  }

  const project = deps.project;
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  try {
    // ② 多源检索
    const tSearch = Date.now();
    const searcher =
      deps.searcher ??
      new LiteratureSearcher(
        new ConnectorRegistry({ credentials: new CredentialStore(), rawSink: project.raw(), command: "chat" }).registerBuiltins(),
        { cooldownOn429: true }, // U55：生产入口打开 429 冷却
      );
    const collected: LibraryPaper[] = [];
    for (const query of queries) {
      note(`检索「${query}」`);
      let r: LiteratureSearchResult;
      try {
        r = await searcher.search(query, { limit: options.limit ?? 15, sources: options.sources });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`检索「${query}」失败：${msg.slice(0, 160)}`);
        result.searches.push({ query, sources: [], found: 0 });
        continue;
      }
      result.searches.push({ query, sources: r.sources, found: r.papers.length });
      for (const s of r.sources) if (s.outcome === "failed") failures.push(`源 ${s.source}（「${query}」）失败：${(s.error ?? "").slice(0, 120)}`);
      // ③ 入库（按 DOI / 标题合并，LibraryStore 自己去重）
      for (const paper of r.papers) {
        const added = library.add(paper, { tags: ["chat"] });
        added.merged ? result.merged++ : result.added++;
        if (!collected.some((p) => p.id === added.paper.id)) collected.push(added.paper);
      }
    }
    library.rebuildCitations();
    result.library = library.list().length;
    mark("search", tSearch);

    if (options.mode === "search" || collected.length === 0) {
      result.ok = collected.length > 0;
      if (!result.ok) failures.push("所有查询都没有命中可入库的论文");
      result.digest = renderDigest(result, collected);
      return result;
    }

    // α-1 批量预筛：一次便宜调用给全部候选打 0–3 分，只留 top-K。
    // 放在下载**之前**——被剔除的论文连 PDF 都不该去拉（U51 那批 8 篇里 5 篇无关，
    // 每篇都白白试了 2–3 条直链）。库里仍然留着它们，只是不进本次综述。
    const tPre = Date.now();
    let selected = collected;
    if (options.prescreen === false) {
      result.prescreen = { enabled: false, candidates: collected.length, kept: collected.length, dropped: [], llmCalls: 0, note: "预筛：已关闭（调用方显式 prescreen:false）" };
    } else {
      note(`预筛 ${collected.length} 篇候选`);
      const screened = await prescreenCandidates(
        { llm: countingLlm },
        collected.map((p) => ({ id: p.id, title: p.title, year: p.year, abstract: p.abstract })),
        { topic: options.topic ?? queries.join(" / "), topK, ...(deps.model ? { model: deps.model } : {}), sessionId: deps.sessionId },
      );
      const keptIds = new Set(screened.kept.map((c) => c.id));
      selected = collected.filter((p) => keptIds.has(p.id));
      result.prescreen = {
        enabled: true,
        candidates: collected.length,
        kept: selected.length,
        dropped: screened.dropped.map((c) => ({ paperId: c.id, title: c.title, score: screened.scores.get(c.id) ?? null })),
        llmCalls: screened.llmCalls,
        note: screened.note,
      };
      note(screened.note);
    }
    mark("prescreen", tPre);

    // α-1 quick 档：到此为止不再下载、不再建卡——全部入选论文的**摘要一次调用**出综述。
    if (depth === "quick") {
      const tQuick = Date.now();
      const entries = quickEntries(pick(selected, topK), library);
      if (entries.length === 0) {
        failures.push("quick 档没有可用的摘要条目（入选论文都不在库内 key 索引里）");
        result.digest = renderDigest(result, collected);
        return result;
      }
      note(`综述（quick 档，${entries.length} 条摘要一次成稿）`);
      const reviewer = new ReviewDraftGenerator({
        llm: countingLlm,
        model: deps.model,
        library,
        records: project.records(),
        artifacts: project.artifacts(),
        workDir: project.paths.artifactsDir,
      });
      const draft = await reviewer.generateQuick(entries, { topic: options.topic, sessionId: deps.sessionId });
      const knownKeys = libraryKeyIndex(library.list()).keys;
      // 引用核验走的是**同一个** citationIntegrity，只是基准从精读卡换成摘要。
      const check = await citationIntegrity({
        draft: draft.markdown,
        knownKeys,
        baselines: baselinesFromAbstracts(entries),
        judge: undefined,
        artifactId: draft.artifactId ?? "",
        location: "text/markdown",
      });
      const gap = explainCitationGap(check.citations, knownKeys, baselinesFromAbstracts(entries));
      result.review = {
        artifactId: draft.artifactId,
        path: draft.path,
        citedKeys: draft.citedKeys.length,
        unknownKeys: draft.unknownKeys.length,
        gap: { total: gap.total, judged: gap.judged, unresolved: gap.unresolved, duplicate: gap.duplicate, selfReference: gap.selfReference },
        markdownHead: draft.markdown.slice(0, 1200),
      };
      mark("review", tQuick);
      result.ok = true;
      result.digest = renderDigest(result, collected);
      return result;
    }

    // ③ 下载（尽力而为；没有 OA 就按摘要精读）
    const tDl = Date.now();
    const targets = pick(selected, options.maxRead ?? topK);
    const downloadPdf =
      deps.downloadPdf ??
      (async (lib: LibraryStore, id: string) => {
        const d = new PdfDownloader({ papersDir: project.paths.papersDir, library: lib });
        const r = await d.download(id);
        return { ok: r.ok, reason: r.ok ? undefined : `${r.reason ?? "unknown"}: ${r.message ?? ""}` };
      });
    for (const p of targets) {
      note(`下载 PDF：${p.title.slice(0, 60)}`);
      try {
        const d = await downloadPdf(library, p.id);
        result.downloads.push({ paperId: p.id, title: p.title, ok: d.ok, reason: d.reason });
      } catch (e) {
        result.downloads.push({ paperId: p.id, title: p.title, ok: false, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    mark("download", tDl);
    // ④ 精读卡（每篇一次 LLM 调用，走会话的预算闸）
    const tRead = Date.now();
    const records = project.records();
    const generator = new ReadingCardGenerator({
      llm: countingLlm,
      model: deps.model,
      library,
      records,
      projectContext: project.meta.description || undefined,
      fullTextFor: async (p) => (p.pdfPath ? extractPdfText(p.pdfPath) : { ok: false, reason: "库内无 PDF（未下载或不可得）" }),
    });
    note(`精读 ${targets.length} 篇`);
    const gen = await generator.generateMany(targets.map((p) => p.id), {
      sessionId: deps.sessionId,
      // α-2：并行 3（W10-0 实测 0 次 429）。串行时这一段占基线 181.5s 里的 85.7s。
      concurrency: normalizeConcurrency(options.readConcurrency),
    });
    result.cardFailures = gen.failures;
    const cards: StoredReadingCard[] = listReadingCards(records, library).filter((c) => targets.some((t) => t.id === c.paperId));
    result.cards = cards.map((c) => ({ paperId: c.paperId, title: library.get(c.paperId)?.title ?? "", year: library.get(c.paperId)?.year ?? null, basis: (c as { basis?: string }).basis ?? null }));
    for (const f of gen.failures) failures.push(`精读失败 ${f.paperId.slice(0, 8)}：${f.error.slice(0, 120)}`);
    mark("read", tRead);
    if (cards.length === 0) {
      failures.push("没有生成任何精读卡，无法综述");
      result.digest = renderDigest(result, collected);
      return result;
    }

    // ⑤ 综述 + 引用核验（机械核对：库外 key 直接标出）
    const tRev = Date.now();
    note(`综述（${cards.length} 张精读卡）`);
    const reviewer = new ReviewDraftGenerator({
      llm: countingLlm,
      model: deps.model,
      library,
      records,
      artifacts: project.artifacts(),
      workDir: project.paths.artifactsDir,
    });
    const draft = await reviewer.generate(cards, { topic: options.topic, sessionId: deps.sessionId });
    const knownKeys = libraryKeyIndex(library.list()).keys;
    const check = await citationIntegrity({
      draft: draft.markdown,
      knownKeys,
      baselines: baselinesFrom(cards),
      judge: undefined,
      artifactId: draft.artifactId ?? "",
      location: "text/markdown",
    });
    const gap = explainCitationGap(check.citations, knownKeys, baselinesFrom(cards));
    result.review = {
      artifactId: draft.artifactId,
      path: draft.path,
      citedKeys: draft.citedKeys.length,
      unknownKeys: draft.unknownKeys.length,
      gap: { total: gap.total, judged: gap.judged, unresolved: gap.unresolved, duplicate: gap.duplicate, selfReference: gap.selfReference },
      markdownHead: draft.markdown.slice(0, 1200),
    };
    mark("review", tRev);
    result.ok = true;
    result.digest = renderDigest(result, collected);
    return result;
  } finally {
    // 每条 return 路径都要带上真实调用数——写在 finally 里，新增分支不会漏。
    result.llmCalls = llmCalls;
    library.close();
  }
}

// α-1：入选论文 → quick 档的摘要条目。key 按**当前库**现算（与精读卡走同一个索引），
// 不在索引里的论文直接跳过——宁可少一条，也不给综述一个无法核对的 key。
function quickEntries(papers: LibraryPaper[], library: LibraryStore): AbstractEntry[] {
  const byId = libraryKeyIndex(library.list()).byId;
  const out: AbstractEntry[] = [];
  for (const p of papers) {
    const key = byId.get(p.id);
    if (!key) continue;
    out.push({ paperId: p.id, bibtexKey: key, title: p.title, year: p.year, venue: p.venue, abstract: p.abstract });
  }
  return out;
}

function renderDigest(r: LiteraturePipelineResult, collected: LibraryPaper[]): string {
  const lines: string[] = [];
  lines.push(`文献流程（${r.mode} · ${r.depth} 档）：${r.queries.length} 条查询 → 命中 ${collected.length} 篇（新入库 ${r.added}，合并 ${r.merged}），库内共 ${r.library} 篇`);
  for (const s of r.searches) {
    const bySrc = s.sources.map((x) => `${x.source}:${x.outcome}${x.count !== undefined ? `(${x.count})` : ""}`).join(" ");
    lines.push(`  「${s.query}」→ ${s.found} 篇 · ${bySrc}`);
  }
  if (collected.length > 0) {
    lines.push("  命中样例：");
    for (const p of pick(collected, 6)) lines.push(`   - ${p.title}${p.year ? ` (${p.year})` : ""}${p.doi ? ` doi:${p.doi}` : ""}`);
  }
  // 预筛剔掉了什么必须写出来：静默丢文献是最难被发现的错误之一。
  if (r.prescreen.candidates > 0 || r.prescreen.enabled) {
    lines.push(`  ${r.prescreen.note}`);
    for (const d of r.prescreen.dropped.slice(0, 5)) lines.push(`   × 剔除（${d.score ?? "?"} 分）：${d.title.slice(0, 70)}`);
  }
  if (r.downloads.length > 0) lines.push(`  PDF：${r.downloads.filter((d) => d.ok).length}/${r.downloads.length} 篇下载成功`);
  if (r.cards.length > 0) lines.push(`  精读卡：${r.cards.length} 张（${r.cards.filter((c) => c.basis === "fulltext").length} 张基于全文，其余基于摘要）`);
  if (r.review) lines.push(`  综述：artifact ${r.review.artifactId ?? "（未入库）"} · 引用 ${r.review.citedKeys} 条 · 库外引用 ${r.review.unknownKeys} 条 · 核验未解析 ${r.review.gap.unresolved ?? 0}`);
  if (r.failures.length > 0) lines.push(`  失败/缺口（${r.failures.length}）：${r.failures.slice(0, 4).join("；")}`);
  return lines.join("\n").slice(0, 1500);
}
