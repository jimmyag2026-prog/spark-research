import { defaultHttp, type HttpClient } from "../http/client";

export type ToolResponseType = "json" | "text";

export interface HttpTool {
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

export interface HttpConnectorConfig {
  baseUrl: string;
  description: string;
  tools: HttpTool[];
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

// 一个普通的 HTTP 数据源客户端基类。
//
// **命名历史包袱（P9 修正）**：这个类原名 `MCPConnector`，但它与 Model Context
// Protocol 毫无关系——名字来自 v0.1 的早期设想，那时打算让每个数据源都是一个 MCP
// server。真正的 MCP 实现在 `backend/src/mcp/`（P9 落地）。两个东西同名会让读者
// 以为 connector 层在说 MCP 协议，所以在 v0.2.0 把公开 API 定下来**之前**改名。
// 旧名保留为 deprecated 别名，外部代码不会断。
export class HttpConnector {
  readonly name: string;
  readonly config: HttpConnectorConfig;
  protected readonly http: HttpClient;
  protected readonly options: ConnectorOptions;

  constructor(name: string, config: HttpConnectorConfig, options: ConnectorOptions = {}) {
    this.name = name;
    this.config = config;
    this.options = options;
    this.http = options.http ?? defaultHttp;
  }

  // 显式 handler 表（构造期由子类注册）。见下方 `handle()` 的注释了解为什么不是
  // 「同名方法即 handler」的反射分发——那是 P9 及更早版本的设计，v0.3 已移除。
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

  // 子类构造函数里调用：为某个工具名注册显式 handler。
  //
  // **v0.3 起这是唯一的分发机制**（P10-a）。P9 及更早版本里，`call()` 会反射检查
  // 「有没有一个与 toolName 同名的实例方法」，命中就自动当 handler 调用——这套魔法
  // 分发被外部评审判定为坏抽象：并发调用同一个 connector 实例时，旧实现靠一个跨请求
  // 共享的实例字段 `__handlingTool` 判断「是否正在处理这个工具」防止 handler 内部
  // 调用 `call()` 时死循环重入，但该字段会被并发请求互相污染，导致 handler（参数
  // 映射、AD-2 的凭据缺失检查）被静默跳过、退化成零参数的通用直通——而且是偶发的，
  // 单元测试测不出来，只在生产的并发场景（daemon 共享单例 registry + swarm 并发调用）
  // 下现身。曾经试过用 `AsyncLocalStorage` 把反射分发做成竞态安全的兼容层，但那是给
  // 一个已经被判定为坏抽象的契约续命，而且引入了真实的运行时开销；主会话裁定：
  // 契约本身要改，不是加兜底——所以这里不再做任何反射，`handlers` 是构造期一次性
  // 写入、运行期只读的表，`call()` 只有「查表命中就走 handler，否则走通用路径」
  // 两条路，不存在任何跨请求共享的可变状态。
  protected handle(toolName: string, fn: (params: Record<string, unknown>) => Promise<unknown>): void {
    this.handlers.set(toolName, fn);
  }

  // 子类可覆写：为请求追加礼貌头 / 鉴权头。
  protected headersFor(_toolName: string): Record<string, string> {
    return {};
  }

  // 子类可覆写：为请求追加查询参数（如 mailto）。
  protected queryFor(_toolName: string): Record<string, string> {
    return {};
  }

  private assertKnownTool(toolName: string): HttpTool {
    const tool = this.config.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(
        `Unknown tool "${toolName}" for connector "${this.name}". Available: ${this.config.tools
          .map((t) => t.name)
          .join(", ")}`,
      );
    }
    return tool;
  }

  async call(toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.assertKnownTool(toolName);

    const handler = this.handlers.get(toolName);
    if (handler) {
      return await handler(params);
    }

    return this.requestRaw(toolName, params);
  }

  // 通用 URL 拼装 + 发请求路径。子类 handler 内部要落到这条路径时调用它，而不是
  // `call()`——它不查 handler 表，所以不会递归回到 handler 自己（见上方 handlers 注释）。
  protected async requestRaw(toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.assertKnownTool(toolName);
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

  listTools(): HttpTool[] {
    return this.config.tools.map((tool) => ({ ...tool }));
  }
}

// ── 旧名（deprecated 别名，P9 起改用上面的名字）──────────────────────────────
// 这三个别名只为兼容外部引用而存在；仓库内部一律用新名。

/** @deprecated 与 MCP 协议无关，改用 `HttpConnector`。 */
export const MCPConnector = HttpConnector;
/** @deprecated 与 MCP 协议无关，改用 `HttpConnector`。 */
export type MCPConnector = HttpConnector;
/** @deprecated 改用 `HttpConnectorConfig`。 */
export type MCPConnectorConfig = HttpConnectorConfig;
/** @deprecated 改用 `HttpTool`。 */
export type MCPTool = HttpTool;
