// ClinVar：临床解读变异——致病性分级、关联疾病、基因。走 NCBI E-utilities，
// db=clinvar，免 key。
//
// 拉动来源（§1.4.2 checklist □0）：F-1 缺口——v0.5 connector 扩展调研点名的「基因组学/
// 临床变异」空白；genomics 域此前只有 ensembl/ncbi/cncb，没有专门做临床解读的源。
//
// **限速（V26）**：host `eutils.ncbi.nlm.nih.gov` 与已有的 pubmed / ncbi 两个 connector
// 共用同一台 NCBI 机器的匿名配额（官方文档口径 3 req/s，累计到整台机器，不分 db）——
// 见 `backend/src/http/ratelimit.ts` 的 `HOST_RATE_POLICIES["eutils.ncbi.nlm.nih.gov"]`。
// 本 connector 自己不做节流，节流统一在 `ConnectorRegistry` 注入的
// `RateLimitedHttp` 装饰器里按 host 合池——这正是 V26 的核心：键控是 host，不是
// connector，三个 eutils connector 共享同一个令牌桶。
//
// 坑（实测 + 上游 openscience 调研笔记）：
//   - esummary 返回的分类字段在新版 ClinVar 已从 `clinical_significance` 迁到
//     `germline_classification.description`；本 connector 只管「把请求发对、把原始
//     JSON 拿回来」，两种字段形状的兼容解析属于未来归一化层职责（ClinVar 目前不在
//     统一文献检索里，暂无归一化消费方）。
//   - esearch 返回的是 UID 列表，不是可读的 accession（如 RCV000012345）；
//     esearch → esummary 是标准两步流程，getSummary 需要调用方先拿到 esearch 的
//     idlist 再传进来（与 pubmed connector 的两跳模式一致，但这里不在 connector
//     内部自动串联——ClinVar 的典型用法是先筛 UID 再按需批量取详情，两步分开调用
//     比强制每次 search 都带一次 esummary 更省请求）。
import { HttpConnector, type ConnectorOptions, type HttpConnectorConfig } from "./base";

export const clinvarConfig: HttpConnectorConfig = {
  baseUrl: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
  description: "ClinVar：临床解读变异（致病性分级、关联疾病、基因），NCBI E-utilities db=clinvar，免 key",
  tools: [
    { name: "search", description: "检索变异 UID 列表（esearch, db=clinvar）。参数：{ query, retmax? }", endpoint: "/esearch.fcgi" },
    {
      name: "getSummary",
      description: "按 UID（单个或逗号分隔多个）批量获取变异摘要（esummary, db=clinvar）。参数：{ id }",
      endpoint: "/esummary.fcgi",
    },
  ],
  metadata: {
    domain: "ncbi.nlm.nih.gov",
    apiKeyRequired: false,
    status: "available",
    caveat:
      "与 Spark 已有 pubmed/ncbi 共用 eutils 主机限速（BACKLOG V26：按 host 合池，匿名约 3 req/s，累计计，" +
      "不按 connector 分别计）。分类字段新版 ClinVar 在 germline_classification.description，旧版在 " +
      "clinical_significance，本 connector 不做兼容解析——只透传 esummary 原始 JSON。",
  },
};

export class ClinVarConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("clinvar", clinvarConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getSummary", (p) => this.getSummary(p));
  }

  async search(params: { query?: string; retmax?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string") {
      mapped.term = params.query;
      delete mapped.query;
    }
    if (!mapped.term) throw new Error('Connector "clinvar" tool "search" 需要参数 query');
    mapped.db = "clinvar";
    mapped.retmode ??= "json";
    mapped.retmax ??= params.retmax ?? 10;
    return this.requestRaw("search", mapped);
  }

  async getSummary(params: { id?: string | number | string[] } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    const ids = Array.isArray(params.id) ? params.id.join(",") : params.id;
    if (!ids) throw new Error('Connector "clinvar" tool "getSummary" 需要参数 id（单个或逗号分隔的 UID）');
    mapped.id = ids;
    mapped.db = "clinvar";
    mapped.retmode ??= "json";
    return this.requestRaw("getSummary", mapped);
  }
}
