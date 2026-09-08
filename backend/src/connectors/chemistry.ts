import { MCPConnector, type ConnectorOptions, type MCPConnectorConfig } from "./base";

export const chemblConfig: MCPConnectorConfig = {
  baseUrl: "https://www.ebi.ac.uk/chembl/api/data",
  description: "ChEMBL 生物活性化合物数据库",
  tools: [
    { name: "search", description: "搜索分子", endpoint: "/molecule/search.json" },
    { name: "getMolecule", description: "按 ChEMBL ID 获取分子", endpoint: "/molecule/{chemblId}.json" },
  ],
  metadata: { domain: "ebi.ac.uk/chembl", apiKeyRequired: false, status: "available" },
};

export class ChemBLConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("chembl", chemblConfig, options);
  }

  async search(params: { query?: string; q?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string" && params.q === undefined) {
      mapped.q = params.query;
      delete mapped.query;
    }
    if (params.limit !== undefined) mapped.limit = params.limit;
    return super.call("search", mapped);
  }
}

export const pubchemConfig: MCPConnectorConfig = {
  baseUrl: "https://pubchem.ncbi.nlm.nih.gov/rest/pug",
  description: "PubChem 化合物数据库",
  tools: [
    { name: "search", description: "按名称搜索 CID", endpoint: "/compound/name/{name}/cids/JSON" },
    { name: "getCompound", description: "按 CID 获取化合物", endpoint: "/compound/cid/{cid}/JSON" },
  ],
  metadata: { domain: "pubchem.ncbi.nlm.nih.gov", apiKeyRequired: false, status: "available" },
};

export class PubChemConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("pubchem", pubchemConfig, options);
  }

  async search(params: { name?: string; query?: string } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (params.name === undefined && typeof params.query === "string") {
      mapped.name = params.query;
      delete mapped.query;
    }
    return super.call("search", mapped);
  }
}
