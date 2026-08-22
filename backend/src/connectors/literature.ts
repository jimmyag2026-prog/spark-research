import { MCPConnector, type MCPConnectorConfig } from "./base";

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
  constructor() {
    super("pubmed", pubmedConfig);
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
  constructor() {
    super("arxiv", arxivConfig);
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

