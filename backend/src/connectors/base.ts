import { AsyncLocalStorage } from "node:async_hooks";
import { defaultHttp, type HttpClient } from "../http/client";

// 向后兼容用：仅供 `reflectedHandler()` 的重入判定使用（见下方注释）。
// 用 AsyncLocalStorage 按「调用链」而不是按「实例」隔离状态——同一个 connector 实例
// 上并发的两条调用链各自拿到独立的 store，互不污染。这与旧版 `__handlingTool`
// 实例字段的关键区别：旧字段跨并发请求共享，是 P0 竞态的根源。
const reflectionReentryGuard = new AsyncLocalStorage<string>();

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

  // 显式 handler 表（构造期由子类注册），取代「同名方法即 handler」的魔法反射分发。
  //
  // **P10-a 修复的并发竞态（P0）**：旧实现用单值实例字段 `__handlingTool` 标记「当前
  // 正在走哪个工具的 handler」，用来防止 handler 内部调用 `super.call()` 时死循环重入
  // 自己。但该字段跨请求共享——并发请求 A 在 `await` 期间字段保持为 "search"，此时
  // 并发请求 B 调同一工具会被判定为「重入」而被跳过 handler，直接落到通用 URL 拼装
  // 路径（零参数映射），导致 OpenAlex query 不翻译、EuropePMC 丢 format=json、AMiner
  // 凭据检查被跳过等。
  //
  // 新实现全程不写任何实例可变状态：`handlers` 是构造期一次性写入、运行期只读的表；
  // `call()` 查表分发，不判断「是否正在处理」。递归问题改为结构性解决——handler 内部
  // 落到通用路径时调用 `requestRaw()`，它根本不查 handler 表，天然不会重入自己。
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

  // 子类构造函数里调用：为某个工具名注册显式 handler。
  protected handle(toolName: string, fn: (params: Record<string, unknown>) => Promise<unknown>): void {
    this.handlers.set(toolName, fn);
  }

  // 向后兼容路径：仓库外部（如脚手架生成的 connector、EXTENDING.md 里描述的旧契约）
  // 可能还在用「与 tool 同名的实例方法即 handler」这套没有显式 `this.handle(...)`
  // 注册的旧写法。仓库内部所有 connector 都已迁到显式 handlers 表（上面），不会走
  // 到这条路径；这里只是不让没迁移的第三方 connector 悄悄退化成"零参数映射"。
  private reflectedHandler(
    toolName: string,
  ): ((params: Record<string, unknown>) => Promise<unknown>) | undefined {
    const candidate = (this as unknown as Record<string, unknown>)[toolName];
    if (typeof candidate === "function" && toolName in this) {
      return (candidate as (p: Record<string, unknown>) => Promise<unknown>).bind(this);
    }
    return undefined;
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

    // 兼容旧契约（见 reflectedHandler 注释）。重入判定用调用链本地的 AsyncLocalStorage
    // store，不是实例字段：并发调用各自的 store 互不可见，不会出现"请求 B 因为请求
    // A 正在处理同名工具而被错误跳过 handler"的竞态。
    const reflected = this.reflectedHandler(toolName);
    if (reflected && reflectionReentryGuard.getStore() !== toolName) {
      return await reflectionReentryGuard.run(toolName, () => reflected(params));
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
