import { HttpConnector, type ConnectorOptions, type HttpConnectorConfig } from "./base";
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

export const aminerConfig: HttpConnectorConfig = {
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

export class AMinerConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super(AMINER_CONNECTOR_ID, aminerConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getPaper", (p) => this.getPaper(p));
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
    return this.requestWithAuthRetry("search", mapped);
  }

  async getPaper(
    params: { id?: string; ids?: string[] } & Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isConfigured()) return credentialMissingResult();
    const ids = params.ids ?? (params.id ? [String(params.id)] : []);
    if (ids.length === 0) throw new Error('Connector "aminer" tool "getPaper" 需要参数 id 或 ids');
    // 官方限制单次最多 100 个 id。
    return this.requestWithAuthRetry("getPaper", { ids: ids.slice(0, 100) });
  }

  // ── V73：间歇 401，历史台账复核后加的保守重试 ────────────────────────────────
  //
  // 出处：`docs/devlog/W8-alpha.md`（本 lane）对 `~/.spark-research/
  // api_calls.polluted-2026-09-11.jsonl` 的只读统计——4907 次 aminer 调用、91 次
  // 401（1.85%）。两条统计结论：
  //   1. 91 次 401 里没有任何两次连续出现（run-length 恒为 1）；
  //   2. 78.9% 的 401 发生在与上一次 aminer 调用间隔 > 30s 之后（对照：200 的
  //      调用里只有 0.83% 前面隔了这么久）——与「高并发触发限速」相反的方向
  //      （v0.6 R2 复核过：12 并发 burst 实测 0 个 401，见 `docs/BACKLOG.md`
  //      V73 行），更像是「AMiner 侧鉴权/会话空闲一段时间后失效，空闲后的
  //      第一次请求会先吃一次 401」。
  //
  // **如实交代**：这是从历史日志回溯出的统计相关性，不是本 lane 现场用受控的
  // 空闲间隔实验复现出的因果关系——纪律要求只读日志（不得对 `~/.spark-research`
  // 发起改动性操作之外的实时探测），所以无法在本 lane 内把「空闲 > 30s → 401」
  // 坐实成因果证据。但效应量足够大（数量级差异，不是噪音），值得当一次「可复现
  // 的模式」处理：保守修法——401 只重试一次，不无限重试。如果第二次仍然 401
  // （真凭据失效 / 权限问题），原样抛出，不会被这个重试掩盖成「看起来正常」。
  private async requestWithAuthRetry(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.requestRaw(toolName, params);
    } catch (error) {
      if (error instanceof Error && /\bHTTP 401\b/.test(error.message)) {
        return await this.requestRaw(toolName, params);
      }
      throw error;
    }
  }
}
