// Reactome ContentService：人工校订、同行评审的人类通路/反应/分子事件数据库。免 key。
//
// 拉动来源（§1.4.2 checklist □0）：F-1 缺口——v0.5 connector 扩展调研点名的「通路/组学」
// 空白，此前仓库完全没有 pathways 域。
//
// host `reactome.org` 与仓库内任何已有 connector 都不共享——不需要 §1.4.0 的限速登记
// （官方文档未给出具体限速数字，「没写来源的数字不许进表」，宁可不设策略，让 host 直通，
// 也不编一个没有出处的数字）。
//
// 坑（实测响应结构 + 上游 openscience 调研笔记）：
//   - `/search/query` 返回按类型分组的结果（`results[].entries[]`），不是扁平列表——
//     这里原样透传分组结构，扁平化/截断留给调用方（Spark 契约：connector 只管把
//     请求发对、把原始 JSON 拿回来）。
//   - 条目名称/摘要里常带 `<span class="highlighting">` 高亮标记（实测确认），是否清洗
//     HTML 标签同样留给调用方。
//   - `species` 参数接受物种学名字符串（如 "Homo sapiens"），不是 taxon id。
//   - 搜索端点没有 rows/limit 参数，本 connector 显式丢弃调用方传入的 limit，
//     避免它被当成一个上游不认识的裸查询参数误发出去。
import { HttpConnector, type ConnectorOptions, type HttpConnectorConfig } from "./base";

export const reactomeConfig: HttpConnectorConfig = {
  baseUrl: "https://reactome.org/ContentService",
  description: "Reactome：人工校订、同行评审的生物通路/反应/分子事件数据库（免 key）",
  tools: [
    {
      name: "search",
      description:
        '全文检索通路/反应/事件条目（cluster=true 按类型分组）。参数：{ query, species? }（species 是物种学名字符串，如 "Homo sapiens"）',
      endpoint: "/search/query",
    },
    { name: "getEntry", description: "按 stId 或 dbId 获取完整条目详情", endpoint: "/data/query/{id}" },
  ],
  metadata: {
    domain: "reactome.org",
    apiKeyRequired: false,
    status: "available",
    caveat:
      "search 返回按类型分组的结果（results[].entries[]），不是扁平列表；条目名称/摘要可能带 " +
      "<span class=\"highlighting\"> 高亮标记，均未在 connector 层处理，留给调用方。",
  },
};

export class ReactomeConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("reactome", reactomeConfig, options);
    this.handle("search", (p) => this.search(p));
  }

  async search(params: { query?: string; species?: string } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (!mapped.query) throw new Error('Connector "reactome" tool "search" 需要参数 query');
    mapped.cluster ??= "true";
    // Reactome 的搜索端点没有结果数量参数（不支持 rows/limit），截断留给调用方。
    delete mapped.limit;
    return this.requestRaw("search", mapped);
  }
}
