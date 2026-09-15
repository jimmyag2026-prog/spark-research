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
import { llmQueryTranslator } from "../literature/prepare_query";
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
import {
  type DeltaListener,
  type PartialCardPayload,
  type PartialKind,
  type PartialListener,
  type PartialPaper,
  type PartialPayload,
} from "./progress";
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
  /**
   * β-2（v0.10）：**中间产物出口**——检索候选清单 / 每源结果 / 每张精读卡完成即推。
   * 与 `note` 同级：`note` 推的是「现在在干什么」（一句人话），这条推的是
   * 「刚刚产出了什么」（结构化）。不给 = 完全空操作，CLI 与既有测试逐字节不变。
   *
   * **本 lane 只加回调与事件出口，不改流程逻辑**（流程内部的并行/预筛归 lane α，
   * 它同期在改同一个文件）。所以下面每个调用点都紧贴着已有的那一行，不移动任何语句。
   */
  emitPartial?: PartialListener;
  /** β-2：产生这些事件的 plan 任务 id（chat 路径给；CLI / 测试不给）。 */
  taskId?: string;
  /**
   * β-3（v0.10）：正文增量出口。综述走 `target:"review"`，精读卡走 `card:<paperId>`。
   * 不给 = 不开流式（provider 侧不走 SSE 分支，行为与接线前一致）。
   */
  onDelta?: DeltaListener;
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
  // β-2：事件出口。**观察者抛异常不许弄死管线**——但也不许静默吞掉，
  // 所以落进执行日志（note）而不是 `catch {}`（自动化降级必须留痕）。
  const partial = (kind: PartialKind, payload: PartialPayload): void => {
    if (!deps.emitPartial) return;
    try {
      deps.emitPartial({ kind, ...(deps.taskId ? { taskId: deps.taskId } : {}), ts: Date.now(), payload });
    } catch (e) {
      note(`partial(${kind}) 推送失败：${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
    }
  };
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
        {
          cooldownOn429: true, // U55：生产入口打开 429 冷却
          // γ-2（U58）：中文查询的英译器。这是生产入口，显式注入——
          // LiteratureSearcher 自己不 new LLMRouter（见它构造函数里的说明）。
          translate: llmQueryTranslator(deps.llm, deps.model),
        },
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
      // β-2：每源一条 —— ok / failed / timeout / skipped + 条数。**失败与成功同样推**，
      // 不然「某源静默没出结果」在界面上和「这个源没被查」长得一模一样（U43 的病）。
      for (const s of r.sources) {
        partial("search_source", {
          query,
          source: s.source,
          outcome: s.outcome,
          count: s.count ?? null,
          elapsedMs: s.elapsedMs ?? null,
          ...(s.error ? { error: s.error.slice(0, 160) } : {}),
        });
      }
      for (const s of r.sources) if (s.outcome === "failed") failures.push(`源 ${s.source}（「${query}」）失败：${(s.error ?? "").slice(0, 120)}`);
      // ③ 入库（按 DOI / 标题合并，LibraryStore 自己去重）
      const hits: PartialPaper[] = [];
      for (const paper of r.papers) {
        const added = library.add(paper, { tags: ["chat"] });
        added.merged ? result.merged++ : result.added++;
        if (!collected.some((p) => p.id === added.paper.id)) collected.push(added.paper);
        if (hits.length < 20) {
          hits.push({
            id: added.paper.id,
            title: added.paper.title,
            year: added.paper.year ?? null,
            doi: added.paper.doi ?? null,
            sources: Array.isArray(added.paper.sources) ? [...added.paper.sources] : [],
          });
        }
      }
      // β-2：检索一回来就把候选清单推上屏（≤ 20 条）——在下载与精读开跑**之前**，
      // 这是「检索完成 ≤ 10s 页面出现论文标题」那条 DONE 的产生端。
      partial("papers", { query, found: r.papers.length, papers: hits });
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
    // γ-2（U58 ③）：**零摘要且没拿到 PDF 的论文不精读**。
    //
    // AMiner 的 search 接口对相当一部分条目不回 abstract（归一化后就是 `abstract: null`）。
    // 这种论文送进 ReadingCardGenerator，模型手上只有一个标题——产出的「精读卡」是
    // 纯粹的凭标题编造，而它**一旦入库就带着 record 身份**，后面综述会引它。
    // 这比少一张卡糟得多，所以宁可少读：跳过的如实进 failures，用户看得见为什么。
    const readable = targets.filter((p) => {
      if (p.abstract && p.abstract.trim() !== "") return true;
      return result.downloads.some((d) => d.paperId === p.id && d.ok);
    });
    for (const p of targets) {
      if (readable.some((r) => r.id === p.id)) continue;
      failures.push(`跳过精读（库内无摘要、也没拿到 PDF，只凭标题生成的卡不可信）：${p.title.slice(0, 60)}`);
    }
    note(`精读 ${readable.length} 篇${readable.length < targets.length ? `（跳过 ${targets.length - readable.length} 篇零摘要且无全文）` : ""}`);
    const gen = await generator.generateMany(readable.map((p) => p.id), {
      sessionId: deps.sessionId,
      // β-2：**每张卡完成即推一条**（不是等 8 张全好了一起给）——精读是全流程最慢的一段，
      // 这条事件就是「精读每完成一张页面多一行」那条 DONE 的产生端。
      // 失败那篇不推 card 事件（没有内容可推），它由 cardFailures 与 note 如实交代。
      onProgress: ({ paperId, ok }) => {
        if (!deps.emitPartial || !ok) return;
        const card = listReadingCards(records, library).find((c) => c.paperId === paperId);
        if (!card) return;
        const payload: PartialCardPayload = {
          paperId,
          title: card.title,
          year: library.get(paperId)?.year ?? null,
          // 一句话关键发现 = 卡里的第一条 keyFindings（schema 保证至少 1 条）。取不到就 null，不编。
          keyFinding: card.keyFindings[0] ?? null,
          // 相关性分：预筛（lane α-1）落地后由它填；现在管线不产出分数 → null 而不是 0
          // （0 会被读成「判定为不相关」，那是另一件事）。
          relevance: null,
          basis: (card as { basis?: string }).basis ?? null,
        };
        partial("card", payload);
      },
      // β-3：精读卡正文的增量（target = `card:<paperId>`，在 reading.ts 里拼）。
      ...(deps.onDelta ? { onDelta: deps.onDelta } : {}),
      // α-2：并行 3（W10-0 实测 0 次 429）。串行时这一段占基线 181.5s 里的 85.7s。
      concurrency: normalizeConcurrency(options.readConcurrency),
    });
    result.cardFailures = gen.failures;
    const cards: StoredReadingCard[] = listReadingCards(records, library).filter((c) => readable.some((t) => t.id === c.paperId));
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
    // β-3：综述正文逐块到达（target = "review"，重试时 revision +1，都在 review.ts 里定）。
    const draft = await reviewer.generate(cards, {
      topic: options.topic,
      sessionId: deps.sessionId,
      ...(deps.onDelta ? { onDelta: deps.onDelta } : {}),
    });
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
