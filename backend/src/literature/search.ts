import { isCredentialMissing } from "../connectors/aminer";
import { ConnectorRegistry } from "../connectors/registry";
import type { ConnectorOptions } from "../connectors/base";
import { dedupePapers, type DedupeOptions } from "./dedupe";
import { normalizeResponse } from "./normalize";
import { DEFAULT_SEARCH_SOURCES, normalizeDoi, type LiteratureSource, type Paper } from "./models";
import { SHAPE_SOURCES, classifyIdentifier } from "./cli";

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
}

export interface LiteratureSearchOptions extends DedupeOptions {
  sources?: LiteratureSource[];
  // 每个源取多少条。
  perSource?: number;
  // 合并去重后最多返回多少条。
  limit?: number;
}

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

  constructor(registryOrOptions: ConnectorRegistry | ConnectorOptions = {}) {
    this.registry =
      registryOrOptions instanceof ConnectorRegistry
        ? registryOrOptions
        : new ConnectorRegistry(registryOrOptions).registerBuiltins();
  }

  async search(query: string, options: LiteratureSearchOptions = {}): Promise<LiteratureSearchResult> {
    const sources = options.sources ?? DEFAULT_SEARCH_SOURCES;
    const perSource = options.perSource ?? 10;

    const settled = await Promise.all(
      sources.map((source) => this.searchOne(source, query, perSource)),
    );

    const all: Paper[] = [];
    const statuses: SourceStatus[] = [];
    for (const { status, papers } of settled) {
      statuses.push(status);
      all.push(...papers);
    }

    const { papers, mergedCount } = dedupePapers(all, options);
    return {
      query,
      papers: options.limit ? papers.slice(0, options.limit) : papers,
      sources: statuses,
      totalBeforeDedupe: all.length,
      mergedCount,
    };
  }

  // 按 DOI / arXiv id / PMID 取单篇，跨源合并成一条。用于 `lit add`。
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
    return { query: id, papers, sources: statuses, totalBeforeDedupe: all.length, mergedCount };
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
    const terms = query.split(/\s+/).filter(Boolean);
    if (terms.length < 2) {
      return {
        ...first,
        status: {
          ...first.status,
          note: "0 命中。AMiner 按词序列匹配标题；若查询是多个概念连写，用空格分开可触发拆词兜底",
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
    const merged = [...order]
      .sort((a, b) => (hitCount.get(b) ?? 0) - (hitCount.get(a) ?? 0) || firstSeen.get(a)! - firstSeen.get(b)!)
      .slice(0, perSource)
      .map((k) => byKey.get(k)!);
    const noteBits = [
      `原查询 0 命中（AMiner 按词序列匹配）；已按 ${useTerms.length} 词拆分查询、按命中词数合并`,
    ];
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
