import { MCPConnector, type ConnectorOptions, type MCPConnectorConfig } from "./base";

export const uniprotConfig: MCPConnectorConfig = {
  baseUrl: "https://rest.uniprot.org",
  description: "UniProt 蛋白质序列与功能注释数据库",
  tools: [
    { name: "search", description: "搜索蛋白质条目", endpoint: "/uniprotkb/search" },
    { name: "getProtein", description: "按 accession 获取蛋白质条目", endpoint: "/uniprotkb/{accession}" },
    { name: "getSequence", description: "获取蛋白质 FASTA 序列", endpoint: "/uniprotkb/{accession}.fasta", responseType: "text" },
  ],
  metadata: { domain: "uniprot.org", apiKeyRequired: false, status: "available" },
};

export class UniProtConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("uniprot", uniprotConfig, options);
  }
}

export const pdbConfig: MCPConnectorConfig = {
  baseUrl: "https://data.rcsb.org/rest/v1",
  description: "RCSB Protein Data Bank 蛋白质结构数据库",
  tools: [
    { name: "searchStructures", description: "搜索 PDB 结构", endpoint: "https://search.rcsb.org/rcsbsearch/v2/query", method: "POST" },
    { name: "getStructure", description: "按 PDB ID 获取结构条目", endpoint: "/core/entry/{pdbId}" },
    { name: "downloadPdb", description: "下载 PDB 格式结构文件", endpoint: "/files/pdb/{pdbId}.pdb", responseType: "text" },
  ],
  metadata: { domain: "rcsb.org", apiKeyRequired: false, status: "available" },
};

export class PDBConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("pdb", pdbConfig, options);
  }

  async searchStructures(params: { query?: string; rows?: number } & Record<string, unknown>): Promise<unknown> {
    const q = String(params.query ?? "");
    const rows = Number(params.rows ?? 10);
    const payload = {
      query: {
        type: "group",
        logical_operator: "and",
        nodes: [
          {
            type: "terminal",
            service: "text",
            parameters: {
              attribute: "rcsb_polymer_entity.pdbx_description",
              operator: "contains_words",
              value: q,
            },
          },
        ],
      },
      return_type: "entry",
      request_options: { paginate: { start: 0, rows } },
    };
    return super.call("searchStructures", payload as unknown as Record<string, unknown>);
  }
}
