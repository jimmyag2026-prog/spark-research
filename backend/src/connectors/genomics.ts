import { MCPConnector, type ConnectorOptions, type MCPConnectorConfig } from "./base";

export const ensemblConfig: MCPConnectorConfig = {
  baseUrl: "https://rest.ensembl.org",
  description: "Ensembl 基因组数据库（EMBL-EBI）",
  tools: [
    { name: "search", description: "按基因/转录本 ID 查询", endpoint: "/lookup/{id}" },
    { name: "getGene", description: "按 ID 获取基因", endpoint: "/lookup/{id}" },
    { name: "getSequence", description: "获取序列", endpoint: "/sequence/id/{id}" },
  ],
  metadata: { domain: "ensembl.org", apiKeyRequired: false, status: "available" },
};

export class EnsemblConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("ensembl", ensemblConfig, options);
  }

  async search(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (params.id !== undefined) mapped.id = params.id;
    mapped["content-type"] = "application/json";
    return super.call("search", mapped);
  }
}

export const ncbiConfig: MCPConnectorConfig = {
  baseUrl: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
  description: "NCBI E-utilities（GenBank 等序列数据）",
  tools: [
    { name: "search", description: "检索 NCBI 数据库", endpoint: "/esearch.fcgi" },
    { name: "getSummary", description: "获取条目摘要", endpoint: "/esummary.fcgi" },
    { name: "getSequence", description: "获取 GenBank 序列", endpoint: "/efetch.fcgi", responseType: "text" },
  ],
  metadata: { domain: "ncbi.nlm.nih.gov", apiKeyRequired: false, status: "available" },
};

export class NCBIConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("ncbi", ncbiConfig, options);
  }

  async search(params: { query?: string; db?: string; retmax?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string") {
      mapped.term = params.query;
      delete mapped.query;
    }
    mapped.db ??= "nucleotide";
    mapped.retmode ??= "json";
    mapped.retmax ??= params.retmax ?? 10;
    return super.call("search", mapped);
  }

  async getSummary(params: { id?: string | number; db?: string } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (params.id !== undefined) mapped.id = params.id;
    mapped.db ??= "gene";
    mapped.retmode ??= "json";
    return super.call("getSummary", mapped);
  }
}
