import { isCredentialMissing } from "../connectors/aminer";
import { ConnectorRegistry } from "../connectors/registry";
import type { ConnectorOptions } from "../connectors/base";
import { compareMergedPapers, dedupePapers, type DedupeOptions } from "./dedupe";
import { normalizeResponse } from "./normalize";
import {
  DEFAULT_SEARCH_SOURCES,
  normalizeDoi,
  type LiteratureSource,
  type Paper,
  type RankMode,
} from "./models";
import { SHAPE_SOURCES, classifyIdentifier } from "./cli";
import { segmentQuery, type SegmentResult } from "./segment";

// 跨源统一检索（DESIGN 域 A1）：并发查询 → 归一化 → 去重合并 → 排序。
//
// 关键性质：**单源失败不拖垮整次检索**。每个源独立 settle，失败的源在
// sourceStatus 里如实标注（含错误摘要），成功的源照常合并返回。
// AMiner 无 key 时走 connector 的降级返回体，标为 skipped 而不是 failed。

export type SourceOutcome = "ok" | "failed" | "skipped";

export interface SourceStatus {
  source: LiteratureSource;
  outcome: SourceOutcome;
  count: number;
  // 失败原因摘要，只含状态码/错误类型，不含任何凭据或响应体。
  error?: string;
  // skipped 时的说明（如「未配置凭据」）。
  note?: string;
  elapsedMs: number;
}

export interface LiteratureSearchResult {
  query: string;
  papers: Paper[];
  sources: SourceStatus[];
  totalBeforeDedupe: number;
  mergedCount: number;
  // V67：本次结果实际用的排序档位 + 人类可读的依据说明（AD-12：结果怎么来的要可见）。
  // 可选：`LiteratureSearcher` 生产路径必填；其它 lane/既有测试里手写的 fixture
  // （非本 lane 文件所有权，footprint 不许碰）不知道这两个字段，留可选避免逼着
  // 那些无关测试跟着改——cli.ts 打印时按未设置处理即可，不影响它们各自测的行为。
  rank?: RankMode;
  rankNote?: string;
}

export interface LiteratureSearchOptions extends DedupeOptions {
  sources?: LiteratureSource[];
  // 每个源取多少条。
  perSource?: number;
  // 合并去重后最多返回多少条。
  limit?: number;
  // V67：跨源合并后的排序依据，默认 blended。
  rank?: RankMode;
}

// ── V67：跨源合并排序 ──────────────────────────────────────────────────────
//
// `dedupePapers`（dedupe.ts，不在本 lane 文件所有权内）内部固定用
// `compareMergedPapers` 排一次序（命中源数 → 被引 → 年份 → 标题），这就是 R1/R2
// 实证追出来的问题排序本身：`--rank hits` 必须与它逐字节一致（回归测试钉住），
// 所以这里**不改 dedupe.ts**，而是拿它已经排好的数组，按 `--rank` 选的档位在
// search.ts 这一层重新排一次（`hits` 档直接原样返回，不重新 sort，避免任何字节级风险）。
//
// 被引数缺失（AMiner search 接口只给区间字符串、部分源没有被引字段）时**不当 0 处理**
// ——把它当 0 会把「没有这个数据」误判成「已证实 0 被引」，在被引普遍 >0 的结果集里
// 比真正 0 被引论文排得更差都不奇怪，这正是要避免的「编造」。citations/recent 两档
// 缺值论文整体退化为 hits 排序（排在有值的论文之后，档内顺序按 hits）；blended 档
// 缺被引数的论文取本次结果集里**已知被引论文** citationFactor 的中位数作代理
// （既不因缺数据判死刑，也不会白得只有真被引论文才配拿的分——纯 0/1 二元处理不了这个平衡）。

// 被引数压成对数量级：1000 与 10000 被引不该按十倍算，是量级差距。
// 系数是可调旋钮——阴性对照①（被引权重置 0）直接把这个常量改成 0 复跑测试用。
const BLENDED_CITATION_WEIGHT = 1;
// 年份衰减半衰期（年）：里程碑论文往往是几年前发的，衰减要温和，
// 不能反而把它们排到检索式直接命中但内容偏题的新论文后面。
const BLENDED_YEAR_HALF_LIFE = 12;

// V67 深度 / 用户 2026-09-11 拍板：blended 档默认每源抓取池从 10 加深到 30。
// 出处：docs/devlog/W7-B1.md §四「真实召回核验」——`--limit 10`（即
// perSource=10）下跨源重叠太稀薄，hits 退化成准被引排序，blended 没有额外空间
// 纠正；`--limit 50` 复现时才看到 V67 描述的病灶真正发作（RFdiffusion 从
// top10 外的 20/28 拉回 top10 内的 6/5）。30 是「浅池不够、50 又是特地复现用的
// 极端值」之间的默认档位。只在 blended 档且调用方没有显式给 perSource 时生效——
// 显式给的优先，`--rank hits` 的既有回归钉子（perSource 默认 10）不受影响。
const BLENDED_DEEP_POOL = 30;

function knownCitationFactor(citedByCount: number, weight: number): number {
  return 1 + weight * Math.log1p(Math.max(0, citedByCount));
}

// 阴性对照②的靶子：删掉这个函数、直接在 rankBlended 里用
// `paper.citedByCount ?? 0` 代入 knownCitationFactor，就是「把缺被引数当 0 处理」的
// bug 形态——会让 v67_ranking.test.ts 的退化断言变红（见 docs/devlog/W7-B1.md）。
function fallbackCitationFactor(papers: Paper[], weight: number): number {
  const known = papers
    .map((p) => p.citedByCount)
    .filter((c): c is number => c !== null)
    .map((c) => knownCitationFactor(c, weight));
  if (known.length === 0) return 1; // 整个结果集都没有被引数据：中性，退化为纯 hits×年份。
  known.sort((a, b) => a - b);
  const mid = Math.floor(known.length / 2);
  return known.length % 2 === 0 ? (known[mid - 1]! + known[mid]!) / 2 : known[mid]!;
}

function yearFactor(year: number | null, now: number, halfLife: number): number {
  if (year === null) return 1; // 缺年份同理：中性，不按「最老」处理。
  const age = Math.max(0, now - year);
  return Math.pow(0.5, age / halfLife);
}

export function rankBlended(
  papers: Paper[],
  options: { citationWeight?: number; yearHalfLife?: number; now?: number } = {},
): Paper[] {
  const weight = options.citationWeight ?? BLENDED_CITATION_WEIGHT;
  const halfLife = options.yearHalfLife ?? BLENDED_YEAR_HALF_LIFE;
  const now = options.now ?? new Date().getFullYear();
  const fallback = fallbackCitationFactor(papers, weight);
  const scored = papers.map((paper) => {
    const hits = Math.max(1, paper.sources.length);
    const citation = paper.citedByCount !== null ? knownCitationFactor(paper.citedByCount, weight) : fallback;
    const year = yearFactor(paper.year, now, halfLife);
    return { paper, score: hits * citation * year };
  });
  scored.sort((a, b) => b.score - a.score || compareMergedPapers(a.paper, b.paper));
  return scored.map((s) => s.paper);
}

// 纯按被引数降序；缺值整体退化到 hits 排序（不当 0，不会被强行排进「0 被引」的位置——
// 排在已知被引论文之后，组内顺序则完全按 hits/年份/标题，即 `compareMergedPapers`）。
export function rankCitations(papers: Paper[]): Paper[] {
  const known = papers.filter((p) => p.citedByCount !== null);
  const unknown = papers.filter((p) => p.citedByCount === null);
  known.sort((a, b) => b.citedByCount! - a.citedByCount! || compareMergedPapers(a, b));
  unknown.sort(compareMergedPapers);
  return [...known, ...unknown];
}

// 纯按年份降序；缺值同款退化到 hits 排序。
export function rankRecent(papers: Paper[]): Paper[] {
  const known = papers.filter((p) => p.year !== null);
  const unknown = papers.filter((p) => p.year === null);
  known.sort((a, b) => b.year! - a.year! || compareMergedPapers(a, b));
  unknown.sort(compareMergedPapers);
  return [...known, ...unknown];
}

export interface RankResult {
  papers: Paper[];
  note: string;
}

// 单一入口：`dedupePapers` 已经排过一次序（compareMergedPapers），这里按 `--rank`
// 选的档位在其输出之上重排；`hits` 档不重新 sort（哪怕语义等价，直接原样返回是对
// 「逐字节一致」回归测试最强的保证，不留任何浮点/排序稳定性带来的风险）。
export function applyRank(papers: Paper[], rank: RankMode): RankResult {
  switch (rank) {
    case "hits":
      return {
        papers,
        note: "排序依据: hits（命中源数 → 被引 → 年份 → 标题，v0.6 原始行为，未纳入被引/年份加权）",
      };
    case "citations":
      return {
        papers: rankCitations(papers),
        note: "排序依据: citations（被引数降序；无被引数据的论文不当 0 处理，整体退化为 hits 排序排在已知被引论文之后）",
      };
    case "recent":
      return {
        papers: rankRecent(papers),
        note: "排序依据: recent（年份降序；缺年份的论文不当最老处理，整体退化为 hits 排序排在已知年份论文之后）",
      };
    case "blended":
    default:
      return {
        papers: rankBlended(papers),
        note:
          "排序依据: blended（命中源数 × 被引数归一化(log, 权重 " +
          `${BLENDED_CITATION_WEIGHT}) × 年份衰减(半衰期 ${BLENDED_YEAR_HALF_LIFE} 年)；` +
          "缺被引数据的论文取本次结果集已知被引论文的中位数代理，不当 0 处理）",
      };
  }
}

// V65 残余：粗略判定「含 CJK」——只需要回答「有没有中文」这一个判据，不需要精确到
// 具体文字系统。基本 CJK 统一表意文字区（一-鿿）覆盖绝大多数简繁中文场景，
// 够用；判过头（比如漏判扩展区生僻字）不是本判据要解决的问题。
const CJK_RANGE = /[一-鿿]/;
function containsCJK(text: string): boolean {
  return CJK_RANGE.test(text);
}

export type Segmenter = (text: string) => Promise<SegmentResult>;

function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    // Error message 里只可能是我们自己构造的「HTTP xxx」或参数校验文案，
    // connector 层已保证不回显响应体/请求头。
    return error.message.split("\n")[0]!.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

export class LiteratureSearcher {
  private registry: ConnectorRegistry;
  // V65 残余：真实分词器默认 `segmentQuery`（jieba，见 segment.ts）；测试注入假实现
  // 验证「拆词入口」本身的判据（含 CJK / 无空格 / 0 命中三个条件），不依赖真装了 jieba。
  private segmenter: Segmenter;
  private readonly deepPool: number;

  constructor(
    registryOrOptions: ConnectorRegistry | ConnectorOptions = {},
    options: { segmenter?: Segmenter; deepPool?: number } = {},
  ) {
    this.registry =
      registryOrOptions instanceof ConnectorRegistry
        ? registryOrOptions
        : new ConnectorRegistry(registryOrOptions).registerBuiltins();
    this.segmenter = options.segmenter ?? segmentQuery;
    // alpha.5 收口：深池档位可注入——fixture cassette 按 perSource=10 录制（FixtureHttp 精确匹配 URL），
    // 测试场景显式传 10 如实反映录制条件；生产默认 BLENDED_DEEP_POOL。
    this.deepPool = options.deepPool ?? BLENDED_DEEP_POOL;
  }

  async search(query: string, options: LiteratureSearchOptions = {}): Promise<LiteratureSearchResult> {
    const sources = options.sources ?? DEFAULT_SEARCH_SOURCES;
    // rank 要在算 perSource 之前先解出来（下面 BLENDED_DEEP_POOL 判据要用它）；
    // 类级默认仍是 "hits"，理由见下面 `applyRank` 调用点之前的既有注释（V67 2.3）。
    const rank = options.rank ?? "hits";
    const deepPoolApplied = options.perSource === undefined && rank === "blended";
    const perSource = options.perSource ?? (rank === "blended" ? this.deepPool : 10);

    const settled = await Promise.all(
      sources.map((source) => this.searchOne(source, query, perSource)),
    );

    const all: Paper[] = [];
    const statuses: SourceStatus[] = [];
    for (const { status, papers } of settled) {
      // 深池默认生效时如实标注在每个成功源上（AD-12：结果怎么来的要可见）；
      // skipped/failed 的源没有「抓了多少池子」这件事，不掺和进去。
      const note =
        deepPoolApplied && status.outcome === "ok"
          ? status.note
            ? `${status.note}；深池 ${this.deepPool}/源（blended 默认）`
            : `深池 ${this.deepPool}/源（blended 默认）`
          : status.note;
      statuses.push(note === status.note ? status : { ...status, note });
      all.push(...papers);
    }

    const { papers: merged, mergedCount } = dedupePapers(all, options);
    // 类级默认**不是** DEFAULT_RANK_MODE（blended）——`LiteratureSearcher` 除了 `lit search`
    // CLI，还有其它内部调用方不显式传 `rank`（如 `ideation/novelty.ts` 的候选检索，不在
    // 本 lane 文件所有权内）。真跑过一次：把这里改成 `?? DEFAULT_RANK_MODE` 后，
    // `tests/unit/novelty_e2e.test.ts` 的语义口径 e2e 从绿变红——不是逻辑 bug，是候选集
    // 顺序变了导致 embedding fixture（按旧候选集录制）缺条目、静默退化成 lexical。
    // V67 的证据（R1/R2）全部来自 `lit search` 这个人类入口，不是内部检索候选的相关性——
    // 所以「默认 blended」只在 CLI 层落地（cli.ts 的 parseRank 不给 `--rank` 时回落到
    // DEFAULT_RANK_MODE 并显式传参），类级默认保持 v0.6 的 "hits"，不静默牵连其它调用方。
    // （`rank` 已在方法顶部算 perSource 时解出，这里直接复用，不重复 `options.rank ?? "hits"`。）
    const { papers: ranked, note: rankNote } = applyRank(merged, rank);
    return {
      query,
      papers: options.limit ? ranked.slice(0, options.limit) : ranked,
      sources: statuses,
      totalBeforeDedupe: all.length,
      mergedCount,
      rank,
      rankNote,
    };
  }

  // 按 DOI / arXiv id / PMID 取单篇，跨源合并成一条。用于 `lit add`。
  // 单篇取数没有「排序」这个概念（结果去重后通常就是 0/1 条），rank 固定标 "hits"
  // 且不重排——与 v0.6 行为一致，`--rank` 不影响 `lit add`（任务书未要求它影响）。
  async fetchById(
    id: string,
    options: { sources?: LiteratureSource[] } & DedupeOptions = {},
  ): Promise<LiteratureSearchResult> {
    const sources = options.sources ?? DEFAULT_SEARCH_SOURCES;
    const settled = await Promise.all(sources.map((source) => this.fetchOne(source, id)));
    const all: Paper[] = [];
    const statuses: SourceStatus[] = [];
    for (const { status, papers } of settled) {
      statuses.push(status);
      all.push(...papers);
    }
    // 按 id 取单篇时，命中的结果理论上就是同一篇；仍然过一遍去重把跨源字段合并起来。
    const { papers, mergedCount } = dedupePapers(all, options);
    return {
      query: id,
      papers,
      sources: statuses,
      totalBeforeDedupe: all.length,
      mergedCount,
      rank: "hits",
      rankNote: "按标识符取单篇，不涉及排序档位",
    };
  }

  private async searchOne(
    source: LiteratureSource,
    query: string,
    perSource: number,
  ): Promise<{ status: SourceStatus; papers: Paper[] }> {
    const first = await this.run(source, () => this.registry.call(source, "search", { query, limit: perSource }));
    // V65（R1-T3 → 主会话实测复核）：AMiner 的 title 检索是**词序列匹配**——查询串必须
    // 像标题里的连续片段（"brain computer interface" 命中 5 条，追加 "neural decoding"
    // 就 0 条；中文同理）。多概念查询（空白分隔）因此整体扑空，这正是 V8「中文召回
    // 极差」的机制根源。兜底：原查询 0 命中且含多词时，按空白拆词逐词查、按命中词数
    // 打分合并，并在 status.note 里**如实标注**这是拆词合并的结果（不是原查询命中）。
    // 只对 aminer 生效——其它源是真正的关键词检索，实测无此形态，不做没有证据的泛化。
    if (source !== "aminer" || first.status.outcome !== "ok" || first.papers.length > 0) return first;
    let terms = query.split(/\s+/).filter(Boolean);
    let segmentedByJieba = false;
    let segmentFailureReason: string | null = null;
    // V65 残余：空格拆词兜底认不出中文连写复合词（中文本就没有空格，"运动意图解码"
    // 整段被当成 1 个词，terms.length===1，走不进下面的多词合并）。原查询 0 命中、
    // 没有空格可拆、但含 CJK 时，先试一次分词器——分出的词再走下面**同一套**
    // 「按命中词数合并」逻辑，不额外发明第二套合并规则。纯英文 / 已经有空格的查询
    // 不碰分词器（前者没有 CJK，后者已经有 terms 可用）。
    if (terms.length < 2 && containsCJK(query)) {
      const segmented = await this.segmenter(query);
      if (segmented.terms && segmented.terms.length >= 2) {
        terms = segmented.terms;
        segmentedByJieba = true;
      } else {
        segmentFailureReason = segmented.reason ?? "分词结果为空或不足 2 词";
      }
    }
    if (terms.length < 2) {
      return {
        ...first,
        status: {
          ...first.status,
          note:
            "0 命中。AMiner 按词序列匹配标题；若查询是多个概念连写，用空格分开可触发拆词兜底" +
            (segmentFailureReason ? `（分词器不可用，退回空格拆词：${segmentFailureReason}）` : ""),
        },
      };
    }
    const useTerms = terms.slice(0, 4);
    const started = Date.now();
    const hitCount = new Map<string, number>();
    const byKey = new Map<string, Paper>();
    const order: string[] = [];
    const failedTerms: string[] = [];
    // 逐词串行（尊重礼貌头/限速；4 词以内延迟可接受）。
    // 池子加深到 ≥20：实测基准论文常在单词结果的 10–20 位区间（R2 前主会话用 T3
    // 冻结基准量过：top-10 命中 0/3、top-20 命中 3/3），先取深池再按命中词数排序截断。
    const termPool = Math.max(perSource, 20);
    for (const term of useTerms) {
      const r = await this.run(source, () => this.registry.call(source, "search", { query: term, limit: termPool }));
      if (r.status.outcome !== "ok") {
        failedTerms.push(term);
        continue;
      }
      for (const paper of r.papers) {
        const key = paper.ids.aminer ?? `${paper.title}#${paper.year ?? ""}`;
        if (!byKey.has(key)) {
          byKey.set(key, paper);
          order.push(key);
        }
        hitCount.set(key, (hitCount.get(key) ?? 0) + 1);
      }
    }
    // 命中词数多者优先；同分保持首次出现顺序（各词内部本来就是源侧相关性序）。
    // 原始序号先固化——比较器里对正被排序的数组做 indexOf 会拿到半排状态的错序号。
    const firstSeen = new Map(order.map((k, i) => [k, i] as const));
    // alpha.6（R4 P1-6）：单词命中即入选把「信号解码」的卫星通信论文带进脑机接口前 10——
    // 多词查询要求 ≥2 词同时命中；一个都没有才退回单词命中并在 note 里说明查准率低。
    const minHits = Math.min(2, useTerms.length);
    let pool = order.filter((k) => (hitCount.get(k) ?? 0) >= minHits);
    let precisionNote: string;
    if (pool.length === 0) {
      pool = [...order];
      precisionNote = `无 ${minHits} 词同时命中，退回单词命中（查准率低，建议换更具体的词）`;
    } else {
      precisionNote = `只取 ≥${minHits} 词同时命中（${pool.length} 篇）`;
    }
    const merged = pool
      .sort((a, b) => (hitCount.get(b) ?? 0) - (hitCount.get(a) ?? 0) || firstSeen.get(a)! - firstSeen.get(b)!)
      .slice(0, perSource)
      .map((k) => byKey.get(k)!);
    const noteBits = [
      segmentedByJieba
        ? `原查询 0 命中（AMiner 按词序列匹配）；jieba 分词合并（${useTerms.length} 词：${useTerms.join("、")}）`
        : `原查询 0 命中（AMiner 按词序列匹配）；已按 ${useTerms.length} 词拆分查询、按命中词数合并`,
    ];
    noteBits.push(precisionNote);
    if (terms.length > useTerms.length) noteBits.push(`仅取前 ${useTerms.length} 词`);
    if (failedTerms.length > 0) noteBits.push(`词 [${failedTerms.join("、")}] 查询失败未计入`);
    return {
      status: {
        source,
        outcome: "ok",
        count: merged.length,
        note: noteBits.join("；"),
        elapsedMs: first.status.elapsedMs + (Date.now() - started),
      },
      papers: merged,
    };
  }

  private async fetchOne(
    source: LiteratureSource,
    id: string,
  ): Promise<{ status: SourceStatus; papers: Paper[] }> {
    // 「这个源认不认得这个 id 形态」——判据来自 `literature/cli.ts` 的 `SHAPE_SOURCES`
    // **单一真源**，不在这里另写一份。
    //
    // 这里原本是一张写死的三源白名单（crossref/openalex/biorxiv + DOI 判断），
    // **其余源一律把原始 id 透传上去**。零上下文外部验收（W5-2 末）当场抓到后果：
    //   $ lit add 9999.99999          ← 一个不存在的 arXiv id
    //   ✅ 已入库  [c0093cc5] Intravenous nitroglycerin （1978 年，与用户要的毫无关系）
    // pubmed 的 eutils 把 `9999.99999` 宽容解析成 PMID 9999，**报成功、退出码 0**。
    //
    // 这比「静默返回空」更糟一档：不是「没查到」被报成「查了没有」，
    // 而是**「没查到」被报成「查到了，给你另一篇」**——垃圾论文以 paper record 落进证据图、
    // 被 `lit read` 花真钱生成精读卡、最后并列进 `report export` 的参考文献，
    // 而 `citation-integrity`「引用必须在库内」会全部放行（它们确实在库内）。
    //
    // 形态**未知**时不拦：未知形态可能仍被某个源认得（比如 semanticscholar 的 CorpusId），
    // 拦掉会把一条能用的路堵死。只拦「形态已识别、且这个源不在该形态的能力表里」。
    const shape = classifyIdentifier(id);
    if (shape !== "unknown" && !SHAPE_SOURCES[shape].includes(source)) {
      return {
        status: {
          source,
          outcome: "skipped",
          count: 0,
          note: `id '${id}' 是 ${shape} 形态，不是该源可解析的标识符`,
          elapsedMs: 0,
        },
        papers: [],
      };
    }
    return this.run(source, () => this.registry.call(source, "getPaper", { id }));
  }

  private async run(
    source: LiteratureSource,
    fn: () => Promise<unknown>,
  ): Promise<{ status: SourceStatus; papers: Paper[] }> {
    const started = Date.now();
    try {
      const payload = await fn();
      const elapsedMs = Date.now() - started;
      // 带凭据的源在无 key 时返回结构化降级体，这里识别成 skipped。
      if (isCredentialMissing(payload)) {
        return {
          status: { source, outcome: "skipped", count: 0, note: payload.message, elapsedMs },
          papers: [],
        };
      }
      const papers = normalizeResponse(source, payload);
      return { status: { source, outcome: "ok", count: papers.length, elapsedMs }, papers };
    } catch (error) {
      return {
        status: {
          source,
          outcome: "failed",
          count: 0,
          error: errorSummary(error),
          elapsedMs: Date.now() - started,
        },
        papers: [],
      };
    }
  }
}
