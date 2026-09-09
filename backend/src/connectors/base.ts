import { defaultHttp, type HttpClient } from "../http/client";

export type ToolResponseType = "json" | "text";

export interface MCPTool {
  name: string;
  description: string;
  endpoint: string;
  method?: "GET" | "POST";
  responseType?: ToolResponseType;
}

export interface ConnectorMetadata {
  domain: string;
  apiKeyRequired: boolean;
  status: "available" | "placeholder";
  // 已知限制（P9）。`status: "available"` 说的是「接口实现了」，不等于「无条件可用」——
  // 例如 Semantic Scholar 匿名请求实测持续 429。这条会被 `capabilities` 原样透出，
  // 让外部 agent 在选源之前就知道会撞什么墙，而不是撞完再猜。
  caveat?: string;
}

export interface MCPConnectorConfig {
  baseUrl: string;
  description: string;
  tools: MCPTool[];
  metadata?: ConnectorMetadata;
}

// 凭据提供方的结构化契约。connector 层刻意不 import daemon 的 CredentialStore，
// 避免 connector → daemon 的反向依赖；CredentialStore 结构上满足此接口（AD-2）。
export interface CredentialProvider {
  has(connectorId: string): boolean;
  get(connectorId: string): Record<string, string> | null;
}

export interface ConnectorOptions {
  // 可注入的 http 层，供 fixture 回放使用；默认走真实网络。
  http?: HttpClient;
  // 只有带凭据的 connector（如 aminer）需要；其余忽略。
  credentials?: CredentialProvider;
  // 礼貌头联系邮箱（OpenAlex/CrossRef 的 polite pool）。
  contactEmail?: string;
  userAgent?: string;
}

export class MCPConnector {
  readonly name: string;
  readonly config: MCPConnectorConfig;
  protected readonly http: HttpClient;
  protected readonly options: ConnectorOptions;

  constructor(name: string, config: MCPConnectorConfig, options: ConnectorOptions = {}) {
    this.name = name;
    this.config = config;
    this.options = options;
    this.http = options.http ?? defaultHttp;
  }

  private __handlingTool = "";

  // 子类可覆写：为请求追加礼貌头 / 鉴权头。
  protected headersFor(_toolName: string): Record<string, string> {
    return {};
  }

  // 子类可覆写：为请求追加查询参数（如 mailto）。
  protected queryFor(_toolName: string): Record<string, string> {
    return {};
  }

  async call(toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.config.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(
        `Unknown tool "${toolName}" for connector "${this.name}". Available: ${this.config.tools
          .map((t) => t.name)
          .join(", ")}`,
      );
    }

    const handler = (this as unknown as Record<string, unknown>)[toolName];
    if (typeof handler === "function" && toolName in this && this.__handlingTool !== toolName) {
      this.__handlingTool = toolName;
      try {
        return await (handler as (p: Record<string, unknown>) => Promise<unknown>).call(this, params);
      } finally {
        this.__handlingTool = "";
      }
    }

    let path = tool.endpoint;
    const remaining: Record<string, unknown> = { ...params };
    for (const key of Object.keys(remaining)) {
      if (path.includes(`{${key}}`)) {
        path = path.replaceAll(`{${key}}`, encodeURIComponent(String(remaining[key])));
        delete remaining[key];
      }
    }

    const url = path.startsWith("http")
      ? new URL(path)
      : new URL(path.replace(/^\//, ""), this.config.baseUrl.endsWith("/") ? this.config.baseUrl : this.config.baseUrl + "/");
    const isText = tool.responseType === "text";
    const isPost = (tool.method ?? "GET") === "POST";
    const headers: Record<string, string> = {
      Accept: isText ? "*/*" : "application/json",
      ...this.headersFor(toolName),
    };

    for (const [key, value] of Object.entries(this.queryFor(toolName))) {
      url.searchParams.set(key, value);
    }

    if (isPost) {
      headers["Content-Type"] = "application/json";
    } else {
      for (const [key, value] of Object.entries(remaining)) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.http.request(url.toString(), {
      method: tool.method ?? "GET",
      headers,
      body: isPost ? JSON.stringify(remaining) : undefined,
    });
    if (!response.ok) {
      // 错误消息只带状态码，绝不回显响应体或请求头（可能含凭据）。
      throw new Error(
        `Connector "${this.name}" tool "${toolName}" failed: HTTP ${response.status}`,
      );
    }
    return isText ? response.text() : response.json();
  }

  listTools(): MCPTool[] {
    return this.config.tools.map((tool) => ({ ...tool }));
  }
}
