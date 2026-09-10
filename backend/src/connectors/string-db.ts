// STRING：已知与预测的蛋白质-蛋白质互作网络。免 key。
//
// 拉动来源（§1.4.2 checklist □0）：F-1 缺口——v0.5 connector 扩展调研点名的「通路/组学」
// 空白，与 reactome 同批补齐 pathways 域。
//
// host `string-db.org` 与仓库内任何已有 connector 都不共享——不需要 §1.4.0 的限速登记。
// 官方文档要求批量请求时限速（建议每秒不超过一次批量请求），单条查询未强制节流；
// 这里不设 HOST_RATE_POLICIES 条目（「没写来源的数字不许进表」——官方文档给的是批量请求
// 的建议节奏，不是一个可直接套进令牌桶的 rps 数字，勉强编一个反而是假精确）。
//
// 坑（实测响应结构 + 上游 openscience 调研笔记）：
//   - STRING 按物种分域，**默认物种是人类**（NCBI taxon 9606）；查询非人类蛋白必须
//     显式传 species（NCBI taxon id，如小鼠 10090），否则大概率查不到或查错物种。
//   - `get_string_ids`（解析名称→STRING ID）与 `interaction_partners`（取互作伙伴）
//     是两个独立端点，不是一个端点的两种参数——分别映射成 search / getPartners 两个工具。
import { HttpConnector, type ConnectorOptions, type HttpConnectorConfig } from "./base";

export const stringDbConfig: HttpConnectorConfig = {
  baseUrl: "https://string-db.org/api",
  description: "STRING：已知与预测的蛋白质-蛋白质互作网络（免 key，物种默认人类 taxon 9606）",
  tools: [
    {
      name: "search",
      description: "把基因/蛋白名解析为 STRING 内部 ID。参数：{ query, species?（NCBI taxon id，默认 9606）, limit? }",
      endpoint: "/json/get_string_ids",
    },
    {
      name: "getPartners",
      description: "获取某 STRING ID（或基因名）的互作伙伴列表。参数：{ id, species?, limit? }",
      endpoint: "/json/interaction_partners",
    },
  ],
  metadata: {
    domain: "string-db.org",
    apiKeyRequired: false,
    status: "available",
    caveat: "默认物种人类（taxon 9606）；非人类物种必须显式传 species，否则解析结果可能为空或串物种。",
  },
};

export class StringDBConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("string-db", stringDbConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getPartners", (p) => this.getPartners(p));
  }

  async search(
    params: { query?: string; identifiers?: string; species?: string | number; limit?: number } & Record<string, unknown>,
  ): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    const identifiers = params.identifiers ?? params.query;
    if (!identifiers) throw new Error('Connector "string-db" tool "search" 需要参数 query 或 identifiers');
    mapped.identifiers = identifiers;
    delete mapped.query;
    mapped.species ??= 9606;
    mapped.limit ??= params.limit ?? 10;
    mapped.echo_query ??= 1;
    return this.requestRaw("search", mapped);
  }

  async getPartners(
    params: { id?: string; identifiers?: string; species?: string | number; limit?: number } & Record<string, unknown>,
  ): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    const identifiers = params.identifiers ?? params.id;
    if (!identifiers) throw new Error('Connector "string-db" tool "getPartners" 需要参数 id 或 identifiers');
    mapped.identifiers = identifiers;
    delete mapped.id;
    mapped.limit ??= params.limit ?? 25;
    if (params.species !== undefined) mapped.species = params.species;
    return this.requestRaw("getPartners", mapped);
  }
}
