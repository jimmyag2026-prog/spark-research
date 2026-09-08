import {
  MCPConnector,
  type ConnectorMetadata,
  type ConnectorOptions,
  type MCPConnectorConfig,
  type MCPTool,
} from "./base";
import { PDBConnector, UniProtConnector, pdbConfig, uniprotConfig } from "./proteins";
import {
  arXivConnector,
  CrossRefConnector,
  EuropePMCConnector,
  OpenAlexConnector,
  PubMedConnector,
  SemanticScholarConnector,
  arxivConfig,
  crossrefConfig,
  europepmcConfig,
  openalexConfig,
  pubmedConfig,
  semanticscholarConfig,
} from "./literature";
import { AMinerConnector, aminerConfig } from "./aminer";
import { CNCBConnector, CNKIConnector, WanFangConnector, cncbConfig, cnkiConfig, wanfangConfig } from "./china";
import { EnsemblConnector, NCBIConnector, ensemblConfig, ncbiConfig } from "./genomics";
import { ChemBLConnector, PubChemConnector, chemblConfig, pubchemConfig } from "./chemistry";

const alphafoldConfig: MCPConnectorConfig = {
  baseUrl: "https://alphafold.ebi.ac.uk/api",
  description: "AlphaFold 蛋白质结构预测数据库（EMBL-EBI）",
  tools: [
    { name: "search", description: "按 UniProt accession 搜索结构", endpoint: "/prediction/{id}" },
    { name: "getModel", description: "获取 AlphaFold 模型", endpoint: "/prediction/{id}" },
  ],
  metadata: { domain: "alphafold.ebi.ac.uk", apiKeyRequired: false, status: "available" },
};

export const BUILTIN_CONNECTORS: Record<string, Array<{ name: string; config: MCPConnectorConfig }>> = {
  proteins: [
    { name: "uniprot", config: uniprotConfig },
    { name: "pdb", config: pdbConfig },
    { name: "alphafold", config: alphafoldConfig },
  ],
  genomics: [
    { name: "ensembl", config: ensemblConfig },
    { name: "ncbi", config: ncbiConfig },
    { name: "cncb", config: cncbConfig },
  ],
  chemistry: [
    { name: "chembl", config: chemblConfig },
    { name: "pubchem", config: pubchemConfig },
  ],
  literature: [
    { name: "pubmed", config: pubmedConfig },
    { name: "arxiv", config: arxivConfig },
    { name: "openalex", config: openalexConfig },
    { name: "crossref", config: crossrefConfig },
    { name: "europepmc", config: europepmcConfig },
    { name: "semanticscholar", config: semanticscholarConfig },
    { name: "aminer", config: aminerConfig },
    { name: "cnki", config: cnkiConfig },
    { name: "wanfang", config: wanfangConfig },
  ],
};

const CONNECTOR_CLASSES: Record<string, new (options?: ConnectorOptions) => MCPConnector> = {
  uniprot: UniProtConnector,
  pdb: PDBConnector,
  pubmed: PubMedConnector,
  arxiv: arXivConnector,
  openalex: OpenAlexConnector,
  crossref: CrossRefConnector,
  europepmc: EuropePMCConnector,
  semanticscholar: SemanticScholarConnector,
  aminer: AMinerConnector,
  cnki: CNKIConnector,
  cncb: CNCBConnector,
  wanfang: WanFangConnector,
  ensembl: EnsemblConnector,
  ncbi: NCBIConnector,
  chembl: ChemBLConnector,
  pubchem: PubChemConnector,
};

export class ConnectorRegistry {
  private connectors = new Map<string, MCPConnector>();
  private options: ConnectorOptions;

  // options 在这里注入一次，之后所有内置 connector 共用同一个 http / 凭据提供方。
  constructor(options: ConnectorOptions = {}) {
    this.options = options;
  }

  registerBuiltins(options?: ConnectorOptions): this {
    if (options) this.options = { ...this.options, ...options };
    for (const defs of Object.values(BUILTIN_CONNECTORS)) {
      for (const { name, config } of defs) {
        const Cls = CONNECTOR_CLASSES[name];
        this.connectors.set(
          name,
          Cls ? new Cls(this.options) : new MCPConnector(name, config, this.options),
        );
      }
    }
    return this;
  }

  registerCustom(name: string, config: MCPConnectorConfig): MCPConnector {
    const connector = new MCPConnector(name, config, this.options);
    this.connectors.set(name, connector);
    return connector;
  }

  get(name: string): MCPConnector | undefined {
    return this.connectors.get(name);
  }

  async call(connectorName: string, toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const connector = this.connectors.get(connectorName);
    if (!connector) {
      throw new Error(`Unknown connector "${connectorName}". Available: ${[...this.connectors.keys()].join(", ")}`);
    }
    return connector.call(toolName, params);
  }

  listTools(connectorName: string): MCPTool[] {
    const connector = this.connectors.get(connectorName);
    if (!connector) throw new Error(`Unknown connector "${connectorName}"`);
    return connector.listTools();
  }

  listAll(): Array<{
    name: string;
    domain: string;
    description: string;
    baseUrl: string;
    metadata: ConnectorMetadata | null;
    tools: MCPTool[];
  }> {
    return [...this.connectors.values()].map((connector) => ({
      name: connector.name,
      domain: this.domainOf(connector.name),
      description: connector.config.description,
      baseUrl: connector.config.baseUrl,
      metadata: connector.config.metadata ?? null,
      tools: connector.listTools(),
    }));
  }

  listDomain(domain: string): MCPConnector[] {
    const names = (BUILTIN_CONNECTORS[domain] ?? []).map((d) => d.name);
    return names.map((name) => this.connectors.get(name)).filter((c): c is MCPConnector => c !== undefined);
  }

  private domainOf(name: string): string {
    for (const [domain, defs] of Object.entries(BUILTIN_CONNECTORS)) {
      if (defs.some((d) => d.name === name)) return domain;
    }
    return "custom";
  }
}
