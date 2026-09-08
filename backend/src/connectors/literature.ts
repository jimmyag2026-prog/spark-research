import { MCPConnector, type ConnectorOptions, type MCPConnectorConfig } from "./base";
import { politeHeaders } from "./politeness";

export const pubmedConfig: MCPConnectorConfig = {
  baseUrl: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
  description: "PubMed 生物医学文献数据库（NCBI E-utilities）",
  tools: [
    { name: "search", description: "检索 PubMed 文献", endpoint: "/esearch.fcgi" },
    { name: "getAbstract", description: "按 PMID 获取摘要", endpoint: "/efetch.fcgi", responseType: "text" },
  ],
  metadata: { domain: "ncbi.nlm.nih.gov", apiKeyRequired: false, status: "available" },
};

export class PubMedConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("pubmed", pubmedConfig, options);
  }

  async search(params: { query?: string; retmax?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string") {
      mapped.term = params.query;
      delete mapped.query;
    }
    mapped.db ??= "pubmed";
    mapped.retmode ??= "json";
    mapped.retmax ??= params.retmax ?? 10;
    return super.call("search", mapped);
  }

  async getAbstract(params: { id?: string | number; rettype?: string } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (params.id !== undefined) {
      mapped.id = params.id;
    }
    mapped.db ??= "pubmed";
    mapped.rettype ??= "abstract";
    return super.call("getAbstract", mapped);
  }
}

export const arxivConfig: MCPConnectorConfig = {
  baseUrl: "https://export.arxiv.org/api",
  description: "arXiv 预印本数据库",
  tools: [
    { name: "search", description: "检索 arXiv 论文", endpoint: "/query", responseType: "text" },
    { name: "getPaper", description: "按 ID 获取论文", endpoint: "/query", responseType: "text" },
  ],
  metadata: { domain: "arxiv.org", apiKeyRequired: false, status: "available" },
};

export class arXivConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("arxiv", arxivConfig, options);
  }

  async search(params: { query?: string; max_results?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string" && !("search_query" in params)) {
      mapped.search_query = `all:${params.query}`;
      delete mapped.query;
    }
    if (params.max_results !== undefined) {
      mapped.max_results = params.max_results;
    }
    return super.call("search", mapped);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P2 新增：四个免 key 文献源。每个至少 search + getPaper（fetch-by-id）两个工具。
// 归一化到统一 Paper 模型的逻辑不在这里，而在 backend/src/literature/normalize.ts，
// connector 只负责「按各家 API 的口径把请求发对、把原始 JSON 拿回来」。
// ─────────────────────────────────────────────────────────────────────────────

// OpenAlex 的 id 可以是 W2741809807、doi:10.x/y 或完整 https://doi.org/... URL。
export function openAlexEntityId(raw: string): string {
  const id = raw.trim();
  if (/^https?:\/\/openalex\.org\//i.test(id)) return id.split("/").pop()!;
  if (/^W\d+$/i.test(id)) return id.toUpperCase();
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(id)) return `doi:${id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
  if (/^10\.\d{4,9}\//.test(id)) return `doi:${id}`;
  if (/^(pmid|pmcid|doi|mag):/i.test(id)) return id;
  return id;
}

// OpenAlex 的 work 对象默认极其臃肿（单条可达 30 KB，大半是我们不用的 concepts/counts_by_year）。
// 用 select 只取归一化需要的字段：响应体缩小一个数量级，对 API 也更礼貌。
export const OPENALEX_SELECT = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "publication_date",
  "cited_by_count",
  "authorships",
  "primary_location",
  "open_access",
  "best_oa_location",
  "ids",
  "abstract_inverted_index",
  "referenced_works",
].join(",");

export const openalexConfig: MCPConnectorConfig = {
  baseUrl: "https://api.openalex.org",
  description: "OpenAlex 开放学术图谱（作品/作者/机构，免 key，支持 polite pool）",
  tools: [
    { name: "search", description: "全文检索作品（works）", endpoint: "/works" },
    { name: "getPaper", description: "按 OpenAlex ID / DOI 获取单篇作品", endpoint: "/works/{id}" },
    { name: "getReferences", description: "获取某作品的参考文献（referenced_works）", endpoint: "/works/{id}" },
  ],
  metadata: { domain: "api.openalex.org", apiKeyRequired: false, status: "available" },
};

export class OpenAlexConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("openalex", openalexConfig, options);
  }

  // OpenAlex 用 mailto 查询参数而不是 header 进 polite pool。
  protected override queryFor(): Record<string, string> {
    return { mailto: this.options.contactEmail ?? politeHeaders().From };
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  async search(params: { query?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string") {
      mapped.search = params.query;
      delete mapped.query;
    }
    if (params.limit !== undefined) {
      mapped["per-page"] = Math.min(Number(params.limit) || 10, 200);
      delete mapped.limit;
    }
    mapped["per-page"] ??= 10;
    mapped.select ??= OPENALEX_SELECT;
    return super.call("search", mapped);
  }

  async getPaper(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "openalex" tool "getPaper" 需要参数 id');
    return super.call("getPaper", { ...params, id: openAlexEntityId(id), select: params.select ?? OPENALEX_SELECT });
  }

  async getReferences(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "openalex" tool "getReferences" 需要参数 id');
    return super.call("getReferences", { ...params, id: openAlexEntityId(id), select: "id,referenced_works" });
  }
}

export const crossrefConfig: MCPConnectorConfig = {
  baseUrl: "https://api.crossref.org",
  description: "CrossRef DOI 注册元数据（免 key，mailto 进 polite pool）",
  tools: [
    { name: "search", description: "检索 CrossRef 作品", endpoint: "/works" },
    { name: "getPaper", description: "按 DOI 获取单篇元数据", endpoint: "/works/{id}" },
  ],
  metadata: { domain: "api.crossref.org", apiKeyRequired: false, status: "available" },
};

export class CrossRefConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("crossref", crossrefConfig, options);
  }

  protected override queryFor(): Record<string, string> {
    return { mailto: this.options.contactEmail ?? politeHeaders().From };
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  async search(params: { query?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (params.limit !== undefined) {
      mapped.rows = Math.min(Number(params.limit) || 10, 100);
      delete mapped.limit;
    }
    mapped.rows ??= 10;
    return super.call("search", mapped);
  }

  async getPaper(params: { id?: string; doi?: string } & Record<string, unknown>): Promise<unknown> {
    const raw = String(params.id ?? params.doi ?? "");
    if (!raw) throw new Error('Connector "crossref" tool "getPaper" 需要参数 id（DOI）');
    const doi = raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    const rest = { ...params };
    delete rest.doi;
    return super.call("getPaper", { ...rest, id: doi });
  }
}

export const europepmcConfig: MCPConnectorConfig = {
  baseUrl: "https://www.ebi.ac.uk/europepmc/webservices/rest",
  description: "Europe PMC 生命科学文献（免 key，含 OA 全文链接）",
  tools: [
    { name: "search", description: "检索 Europe PMC", endpoint: "/search" },
    { name: "getPaper", description: "按 DOI / PMID / PMCID 获取单篇", endpoint: "/search" },
  ],
  metadata: { domain: "ebi.ac.uk", apiKeyRequired: false, status: "available" },
};

// Europe PMC 没有独立的 by-id 端点，统一走 search + 字段限定查询。
export function europePmcIdQuery(raw: string): string {
  const id = raw.trim();
  if (/^PMC\d+$/i.test(id)) return `PMCID:${id.toUpperCase()}`;
  if (/^\d{4,9}$/.test(id)) return `EXT_ID:${id} AND SRC:MED`;
  const doi = id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return `DOI:"${doi}"`;
}

export class EuropePMCConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("europepmc", europepmcConfig, options);
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  async search(params: { query?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (params.limit !== undefined) {
      mapped.pageSize = Math.min(Number(params.limit) || 10, 100);
      delete mapped.limit;
    }
    mapped.pageSize ??= 10;
    mapped.format ??= "json";
    // core 结果集才带 abstract 与 fullTextUrlList（PDF 下载管线依赖它）。
    mapped.resultType ??= "core";
    return super.call("search", mapped);
  }

  async getPaper(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "europepmc" tool "getPaper" 需要参数 id');
    const rest = { ...params };
    delete rest.id;
    return super.call("getPaper", {
      ...rest,
      query: europePmcIdQuery(id),
      format: "json",
      resultType: "core",
      pageSize: 1,
    });
  }
}

export const S2_FIELDS =
  "paperId,externalIds,title,abstract,year,venue,publicationVenue,authors,openAccessPdf,citationCount,referenceCount,url,isOpenAccess";

export const semanticscholarConfig: MCPConnectorConfig = {
  baseUrl: "https://api.semanticscholar.org/graph/v1",
  description: "Semantic Scholar 学术图谱（免 key；无 key 时共享公共限流额度）",
  tools: [
    { name: "search", description: "检索论文", endpoint: "/paper/search" },
    { name: "getPaper", description: "按 S2 ID / DOI / arXiv ID 获取单篇", endpoint: "/paper/{id}" },
  ],
  metadata: { domain: "api.semanticscholar.org", apiKeyRequired: false, status: "available" },
};

// Semantic Scholar 支持带前缀的外部 id：DOI:10.x/y、arXiv:2101.00001、PMID:12345。
export function semanticScholarPaperId(raw: string): string {
  const id = raw.trim();
  if (/^(DOI|ARXIV|PMID|PMCID|MAG|ACL|CorpusId):/i.test(id)) return id;
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(id)) return `DOI:${id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
  if (/^10\.\d{4,9}\//.test(id)) return `DOI:${id}`;
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) return `arXiv:${id}`;
  return id;
}

export class SemanticScholarConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("semanticscholar", semanticscholarConfig, options);
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  async search(params: { query?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    mapped.limit = Math.min(Number(params.limit ?? 10) || 10, 100);
    mapped.fields ??= S2_FIELDS;
    return super.call("search", mapped);
  }

  async getPaper(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "semanticscholar" tool "getPaper" 需要参数 id');
    return super.call("getPaper", { ...params, id: semanticScholarPaperId(id), fields: params.fields ?? S2_FIELDS });
  }
}

