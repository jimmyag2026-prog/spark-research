import { isCredentialMissing } from "../connectors/aminer";
import { ConnectorRegistry } from "../connectors/registry";
import type { ConnectorOptions } from "../connectors/base";
import { dedupePapers, type DedupeOptions } from "./dedupe";
import { normalizeResponse } from "./normalize";
import { DEFAULT_SEARCH_SOURCES, normalizeDoi, type LiteratureSource, type Paper } from "./models";

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
    return this.run(source, () => this.registry.call(source, "search", { query, limit: perSource }));
  }

  private async fetchOne(
    source: LiteratureSource,
    id: string,
  ): Promise<{ status: SourceStatus; papers: Paper[] }> {
    // CrossRef / OpenAlex 只认 DOI 形态的 id；不是 DOI 就别去打无谓的 404。
    const doi = normalizeDoi(id);
    if ((source === "crossref" || source === "openalex") && !doi && !/^W\d+$/i.test(id)) {
      return {
        status: {
          source,
          outcome: "skipped",
          count: 0,
          note: `id '${id}' 不是该源可解析的标识符`,
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
