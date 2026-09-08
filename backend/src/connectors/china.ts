import { MCPConnector, type ConnectorOptions, type MCPConnectorConfig } from "./base";

// 国家基因组科学数据中心（CNCB/NGDC）
// 真实 API：
//   - GWH API: https://ngdc.cncb.ac.cn/gwh/api/public/genome/<id> / assembly/<acc> / bioProject/<acc> / bioSample/<acc>
//   - GenBase REST: https://ngdc.cncb.ac.cn/genbase/api/file/fasta?acc=<id>（下载序列）
//   - BIG Search: https://ngdc.cncb.ac.cn/search/（AND/OR/NOT 查询语法）
export const cncbConfig: MCPConnectorConfig = {
  baseUrl: "https://ngdc.cncb.ac.cn/gwh/api/public",
  description: "国家基因组科学数据中心（CNCB/NGDC，中国）",
  tools: [
    { name: "getGenome", description: "按 genome_id 获取基因组信息", endpoint: "/genome/{id}" },
    { name: "getAssembly", description: "按 assembly accession 获取组装信息", endpoint: "/assembly/{accession}" },
    { name: "getBioProject", description: "按 BioProject accession 获取项目信息", endpoint: "/bioProject/{accession}" },
    { name: "getBioSample", description: "按 BioSample accession 获取样本信息", endpoint: "/bioSample/{accession}" },
  ],
  metadata: { domain: "ngdc.cncb.ac.cn", apiKeyRequired: false, status: "available" },
};

export class CNCBConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("cncb", cncbConfig, options);
  }
}

// 中国知网（CNKI）
// 官方开放平台需申请 API key（https://open.cnki.net），社区已有开源实现：
//   - ExquisiteCore/cnki-search (Go): 访问 https://kns.cnki.net/kns8s/brief/grid（POST QueryJson）
//   - slender0923/cnki-mcp: MCP server，15 种搜索类型
// 当前为占位：接入官方 API key 后可直接使用，或封装社区开源方案
export const cnkiConfig: MCPConnectorConfig = {
  baseUrl: "https://kns.cnki.net/kns8s",
  description: "中国知网（CNKI）文献数据库（社区方案或官方API，需申请）",
  tools: [
    { name: "search", description: "检索知网文献（需通过 kns8s/brief/grid 或官方API）", endpoint: "/brief/grid", method: "POST" },
  ],
  metadata: { domain: "cnki.net", apiKeyRequired: true, status: "placeholder" },
};

export class CNKIConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("cnki", cnkiConfig, options);
  }
}

// 万方数据：官方 Web API 需企业授权/API key，当前为占位配置
export const wanfangConfig: MCPConnectorConfig = {
  baseUrl: "https://api.wanfangdata.com.cn",
  description: "万方数据（万方，中国）",
  tools: [
    { name: "search", description: "检索万方文献", endpoint: "/search" },
  ],
  metadata: { domain: "wanfangdata.com.cn", apiKeyRequired: true, status: "placeholder" },
};

export class WanFangConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super("wanfang", wanfangConfig, options);
  }
}
