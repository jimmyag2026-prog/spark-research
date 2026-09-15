import {
  HttpConnector,
  type ConnectorMetadata,
  type ConnectorOptions,
  type HttpConnectorConfig,
  type HttpTool,
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
import { ClinVarConnector, clinvarConfig } from "./clinvar";
import { BioRxivConnector, biorxivConfig } from "./biorxiv";
import { ReactomeConnector, reactomeConfig } from "./reactome";
import { StringDBConnector, stringDbConfig } from "./string-db";
import { sharedRateLimitedHttp } from "../http/ratelimit";

const alphafoldConfig: HttpConnectorConfig = {
  baseUrl: "https://alphafold.ebi.ac.uk/api",
  description: "AlphaFold 蛋白质结构预测数据库（EMBL-EBI）",
  tools: [
    { name: "search", description: "按 UniProt accession 搜索结构", endpoint: "/prediction/{id}" },
    { name: "getModel", description: "获取 AlphaFold 模型", endpoint: "/prediction/{id}" },
  ],
  metadata: { domain: "alphafold.ebi.ac.uk", apiKeyRequired: false, status: "available" },
};

export const BUILTIN_CONNECTORS: Record<string, Array<{ name: string; config: HttpConnectorConfig }>> = {
  proteins: [
    { name: "uniprot", config: uniprotConfig },
    { name: "pdb", config: pdbConfig },
    { name: "alphafold", config: alphafoldConfig },
  ],
  genomics: [
    { name: "ensembl", config: ensemblConfig },
    { name: "ncbi", config: ncbiConfig },
    { name: "cncb", config: cncbConfig },
    { name: "clinvar", config: clinvarConfig },
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
    { name: "biorxiv", config: biorxivConfig },
  ],
  // 新域（W5-2 γ · V26 附带的 C2 第一批）：通路/组学数据源，此前仓库完全没有覆盖。
  pathways: [
    { name: "reactome", config: reactomeConfig },
    { name: "string-db", config: stringDbConfig },
  ],
};

const CONNECTOR_CLASSES: Record<string, new (options?: ConnectorOptions) => HttpConnector> = {
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
  clinvar: ClinVarConnector,
  biorxiv: BioRxivConnector,
  reactome: ReactomeConnector,
  "string-db": StringDBConnector,
};

/**
 * U47（v0.9.1）：给**规划器**看的连接器清单——纯数据，零网络、零凭据读取。
 *
 * 现场：三次真实使用里，规划器编出 `pubmed.esearch`（真名是 `search`；连接器描述里那句
 * 「esearch 取 id 列表」把它带偏了）、又反复把 `cnki`/`wanfang` 这两个 `status:"placeholder"`
 * 的死源排进计划。根因不是模型笨，是 `plan()` 的提示词里**只有技能描述，没有能力清单**——
 * 它不知道有哪些 server、工具叫什么、哪些根本调不通，只能猜。
 *
 * 刻意只回「名字 + 工具名 + 能不能用」三样：给全量描述会把 plan 的 prompt 顶大（U44 的教训）。
 * 凭据状态不在这里解析（要读 CredentialStore，属运行期）——标 `needsCredential`，
 * 运行时未配置会按 skipped 处理，规划器知道「可能被跳过」就够了。
 */
export interface ConnectorPlanningEntry {
  name: string;
  tools: string[];
  usable: boolean;
  note: string | null;
}

export function connectorPlanningInventory(): ConnectorPlanningEntry[] {
  const out: ConnectorPlanningEntry[] = [];
  for (const defs of Object.values(BUILTIN_CONNECTORS)) {
    for (const { name, config } of defs) {
      const status = config.metadata?.status;
      const placeholder = status === "placeholder";
      out.push({
        name,
        tools: config.tools.map((t) => t.name),
        usable: !placeholder,
        note: placeholder
          ? "占位实现，调用必失败——不要排进计划"
          : config.metadata?.apiKeyRequired
            ? "需凭据；未配置时该源会被跳过"
            : null,
      });
    }
  }
  return out;
}

/** 渲染成 plan 提示词里的一段。可用的按 `name: tool1, tool2` 列；不可用的单列黑名单。 */
export function renderConnectorInventory(entries = connectorPlanningInventory()): string {
  const usable = entries.filter((e) => e.usable);
  const dead = entries.filter((e) => !e.usable);
  const lines = usable.map((e) => `  ${e.name}: ${e.tools.join(", ")}${e.note ? `  (${e.note})` : ""}`);
  let text = `Connectors available for kind:"connector" — use these EXACT server and tool names:\n${lines.join("\n")}`;
  if (dead.length > 0) {
    text += `\nDo NOT plan connector tasks for these (they always fail): ${dead.map((e) => e.name).join(", ")}.`;
  }
  return text;
}

export class ConnectorRegistry {
  private connectors = new Map<string, HttpConnector>();
  private options: ConnectorOptions;

  // options 在这里注入一次，之后所有内置 connector 共用同一个 http / 凭据提供方。
  //
  // V26：`options.http` 未显式传入时默认成 `rateLimitedHttp()`——这样生产路径
  // （registry 不带 options 直接 new）天然带限速，测试/fixture 场景显式传入
  // `http`（StubHttp/FixtureHttp）时原样使用，不会被多包一层限速器（测试确定性
  // 不受影响）。阴性对照②：把这一行删掉/还原成 `options.http`（不给默认值），
  // 同主机并发测试必须红——见 docs/devlog/W5-2-c.md。
  constructor(options: ConnectorOptions = {}) {
    // α-5（v0.10）：默认值从「每个 registry 一个新装饰器」改成**进程内共享实例**。
    // 各自 new 一个，桶状态就各算各的——同一进程里两个 registry（或 registry 与
    // PdfDownloader）打同一台主机时，按 host 分桶的意义就被稀释了。
    this.options = { ...options, http: options.http ?? sharedRateLimitedHttp() };
  }

  registerBuiltins(options?: ConnectorOptions): this {
    if (options) this.options = { ...this.options, ...options };
    for (const defs of Object.values(BUILTIN_CONNECTORS)) {
      for (const { name, config } of defs) {
        const Cls = CONNECTOR_CLASSES[name];
        this.connectors.set(
          name,
          Cls ? new Cls(this.options) : new HttpConnector(name, config, this.options),
        );
      }
    }
    return this;
  }

  registerCustom(name: string, config: HttpConnectorConfig): HttpConnector {
    const connector = new HttpConnector(name, config, this.options);
    this.connectors.set(name, connector);
    return connector;
  }

  get(name: string): HttpConnector | undefined {
    return this.connectors.get(name);
  }

  async call(connectorName: string, toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const connector = this.connectors.get(connectorName);
    if (!connector) {
      throw new Error(`Unknown connector "${connectorName}". Available: ${[...this.connectors.keys()].join(", ")}`);
    }
    return connector.call(toolName, params);
  }

  listTools(connectorName: string): HttpTool[] {
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
    tools: HttpTool[];
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

  listDomain(domain: string): HttpConnector[] {
    const names = (BUILTIN_CONNECTORS[domain] ?? []).map((d) => d.name);
    return names.map((name) => this.connectors.get(name)).filter((c): c is HttpConnector => c !== undefined);
  }

  private domainOf(name: string): string {
    for (const [domain, defs] of Object.entries(BUILTIN_CONNECTORS)) {
      if (defs.some((d) => d.name === name)) return domain;
    }
    return "custom";
  }
}
