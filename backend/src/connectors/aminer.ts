import { MCPConnector, type ConnectorOptions, type MCPConnectorConfig } from "./base";
import { politeHeaders } from "./politeness";

// AMiner 开放平台 connector（DESIGN §2.3 / AD-2：唯一带凭据的文献源）。
//
// 凭据取用口径（与主会话确认的契约）：
//   CredentialStore connector id = "aminer"，字段名 = "api_key"
//   → Authorization header 直接携带该 token。
//
// 硬性纪律：
//   1. 凭据只在 daemon 进程内取用，永不进 env / prompt / 日志 / 错误消息。
//   2. **无 key 时不抛异常**，返回结构化的「未配置凭据」结果（含配置指引）。
//   3. 任何错误路径都不得回显 token 或其片段——本文件里 token 只出现在
//      headersFor() 构造的 header 对象中，不写入任何返回值。

export const AMINER_CONNECTOR_ID = "aminer";
export const AMINER_CREDENTIAL_KEY = "api_key";

export const aminerConfig: MCPConnectorConfig = {
  baseUrl: "https://datacenter.aminer.cn/gateway/open_platform/api",
  description: "AMiner 开放平台（学术大数据；需 API Key，凭据只在 daemon 内取用）",
  tools: [
    { name: "search", description: "按标题检索论文", endpoint: "/paper/search" },
    { name: "getPaper", description: "按 AMiner paper id 批量取详情", endpoint: "/paper/info", method: "POST" },
  ],
  metadata: {
    domain: "datacenter.aminer.cn",
    apiKeyRequired: true,
    status: "available",
    caveat: "需配置凭据（`spark-research lit sources` 看是否已配）；未配置时统一检索把它标为 skipped，其余源照常返回",
  },
};

// 无 key 时的统一降级返回体。调用方（统一检索、CLI）用 `configured === false` 判定。
export interface CredentialMissingResult {
  ok: false;
  reason: "credentials_missing";
  connector: string;
  configured: false;
  // 缺哪些字段（只有字段名，永远没有值）。
  requiredKeys: string[];
  message: string;
  howToConfigure: string[];
  results: [];
}

export function credentialMissingResult(
  connectorId = AMINER_CONNECTOR_ID,
  requiredKeys: string[] = [AMINER_CREDENTIAL_KEY],
): CredentialMissingResult {
  return {
    ok: false,
    reason: "credentials_missing",
    connector: connectorId,
    configured: false,
    requiredKeys,
    message: `连接器 '${connectorId}' 未配置凭据，已跳过该数据源（不影响其他免 key 数据源）。`,
    howToConfigure: [
      `在 ~/.spark-research/credentials.json 的 connectors.${connectorId} 下填入字段 ${requiredKeys.join(" / ")}`,
      "文件权限须为 0600（chmod 600 ~/.spark-research/credentials.json）",
      "凭据只在 daemon 进程内读取，不会进入 env / prompt / 日志",
    ],
    results: [],
  };
}

export function isCredentialMissing(value: unknown): value is CredentialMissingResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { reason?: unknown }).reason === "credentials_missing"
  );
}

export class AMinerConnector extends MCPConnector {
  constructor(options: ConnectorOptions = {}) {
    super(AMINER_CONNECTOR_ID, aminerConfig, options);
  }

  // 是否已配置凭据。只看「有没有」，不把值带出这个方法之外。
  isConfigured(): boolean {
    return this.token() !== null;
  }

  private token(): string | null {
    const provider = this.options.credentials;
    if (!provider) return null;
    try {
      const values = provider.get(AMINER_CONNECTOR_ID);
      const token = values?.[AMINER_CREDENTIAL_KEY];
      return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
    } catch {
      // 凭据文件损坏等情况按「未配置」处理，绝不把底层错误消息（可能含路径/内容）外抛。
      return null;
    }
  }

  protected override headersFor(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]!,
    };
    const token = this.token();
    if (token) headers.Authorization = token;
    return headers;
  }

  async search(
    params: { query?: string; title?: string; page?: number; size?: number } & Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isConfigured()) return credentialMissingResult();
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string" && !params.title) {
      mapped.title = params.query;
    }
    delete mapped.query;
    if (!mapped.title) throw new Error('Connector "aminer" tool "search" 需要参数 query 或 title');
    mapped.page ??= 1;
    mapped.size ??= 10;
    return super.call("search", mapped);
  }

  async getPaper(
    params: { id?: string; ids?: string[] } & Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isConfigured()) return credentialMissingResult();
    const ids = params.ids ?? (params.id ? [String(params.id)] : []);
    if (ids.length === 0) throw new Error('Connector "aminer" tool "getPaper" 需要参数 id 或 ids');
    // 官方限制单次最多 100 个 id。
    return super.call("getPaper", { ids: ids.slice(0, 100) });
  }
}
