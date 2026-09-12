import { defaultHttp, HttpTimeoutError, type HttpClient } from "../http/client";
import { recordApiCall } from "../usage/api_ledger";
import { configuredRawUpstreamInline } from "../config";
import { connectorLicense, isProprietaryLicense } from "../provenance/policy";
import { JsonlRawSink, globalRawSink, redact, type RawSink } from "../raw";

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
  /**
   * v0.7 W7-D0 · L0：每次 HTTP 调用的请求参数（脱敏）与原始响应体落 raw/connector/<name>/。
   * 有项目上下文的构造方传 `project.raw()`；不传则落全局兜底 `<dataDir>/raw/`——**不记等于漏**。
   */
  rawSink?: RawSink;
  /** 触发这次调用的命令（lit-search / lit-add / …），只用于 raw 行的 command 字段。 */
  command?: string | null;
}

// 一个普通的 HTTP 数据源客户端基类。
//
// **命名历史包袱（P9 修正）**：这个类原名 `MCPConnector`，但它与 Model Context
// Protocol 毫无关系——名字来自 v0.1 的早期设想，那时打算让每个数据源都是一个 MCP
// server。真正的 MCP 实现在 `backend/src/mcp/`（P9 落地）。两个东西同名会让读者
// 以为 connector 层在说 MCP 协议，所以在 v0.2.0 把公开 API 定下来**之前**改名。
// 旧名（`MCPConnector` / `MCPConnectorConfig` / `MCPTool`）曾以 deprecated 别名保留
// 兼容外部引用；v0.4 §2.2 明文废弃周期到 v0.5，周期已走完，v0.5 F-3（BACKLOG V15）
// 删除——breaking change，见 CHANGELOG。
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

  /**
   * W7-D0 · L0 埋点（与 recordApiCall 同一 finally）。凭据源（license 为 proprietary）的响应体
   * 默认只存 hash（`rawUpstreamInline=on` 才 inline），且这类行永不进共享集合（AD-16）。
   * 写盘失败不影响 connector 调用本身（与 api_ledger 同口径），系统性漏记由门禁 G1 对账抓。
   */
  private appendRaw(entry: {
    tool: string;
    host: string;
    method: string;
    params: Record<string, unknown>;
    status: number | string;
    latencyMs: number;
    contentType: string | null;
    rawText: string | null;
  }): void {
    try {
      const sink = this.options.rawSink ?? globalRawSink();
      const license = connectorLicense(this.name);
      const inlineOk = !isProprietaryLicense(license) || configuredRawUpstreamInline();
      sink.append({
        kind: "connector",
        command: this.options.command ?? null,
        provenanceClass: "upstream",
        license,
        payload: {
          connector: this.name,
          tool: entry.tool,
          host: entry.host,
          method: entry.method,
          params: redact(entry.params),
          status: entry.status,
          latencyMs: entry.latencyMs,
          contentType: entry.contentType,
          response:
            entry.rawText === null ? null : inlineOk ? sink.body(entry.rawText) : JsonlRawSink.hashOnly(entry.rawText),
        },
      });
    } catch {
      // 见上：不让 raw 落盘失败打断调用。
    }
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

    // W6-1 α（v0.6）：调用台账埋点。这是全体 connector 唯一发出真实 HTTP 请求的
    // 落地点（`call()` 要么走这里，要么走 handler 内部再调回这里，见类顶部注释）——
    // 埋在这一处，所有 connector 自动覆盖，不需要逐个 connector 手写一份（V46「同一件
    // 事两份手写副本」的教训）。落账只认 `host`（`url.host`，来自上面已经拼好的 URL
    // 对象），**绝不把 `url` 本身传给台账**——query string 里可能混着凭据。
    const host = url.host;
    const startedAt = Date.now();
    let status: number | string | undefined;
    // W7-D0：原始响应体在 JSON.parse 之前先留一份（AD-15）——归一化逻辑一改，旧结果靠它重算。
    let rawText: string | null = null;
    let contentType: string | null = null;
    // V63：这一层只看得到 `HttpClient` 接口——`RateLimitedHttp.request()` 的返回值
    // 恰好是 `RateLimitedResponse`（多带 `rateLimitWaitMs`）时才读得到真值；测试桩/
    // fixture http（StubHttp/FixtureHttp）没有这个字段，`?? 0` 落回旧口径的 0，
    // 不是所有调用方都必须知道限速器的存在。
    let rateLimitWaitMs = 0;
    try {
      const response = await this.http.request(url.toString(), {
        method: tool.method ?? "GET",
        headers,
        body: isPost ? JSON.stringify(remaining) : undefined,
      });
      status = response.status;
      rateLimitWaitMs = (response as { rateLimitWaitMs?: number }).rateLimitWaitMs ?? 0;
      // 有些测试桩/脚手架模板的响应对象不带 headers；raw 行的 contentType 只是元数据，缺了记 null。
      contentType = response.headers?.["content-type"] ?? null;
      if (!response.ok) {
        // 错误消息只带状态码，绝不回显响应体或请求头（可能含凭据）。
        throw new Error(
          `Connector "${this.name}" tool "${toolName}" failed: HTTP ${response.status}`,
        );
      }
      // 显式 await（而不是直接 `return response.text()/.json()`）：async 函数里
      // `return somePromise` 会让下面的 finally 在 promise 落定**之前**就执行——
      // 显式 await 才能保证台账记的 latencyMs 包含真正读完响应体的耗时。
      if (isText) {
        rawText = await response.text();
        return rawText;
      }
      // R2 实测（bioRxiv 服务端故障期）：上游可能回 HTTP 200 + 空 body，裸
      // response.json() 抛 "SyntaxError: Unexpected EOF"——用户读不出这是上游的问题。
      // 先取文本再解析，把「空响应」与「非法 JSON」都翻译成指명上游的可读错误。
      const raw = await response.text();
      rawText = raw;
      if (raw.trim() === "") {
        throw new Error(
          `Connector "${this.name}" tool "${toolName}": 上游返回空响应（HTTP ${response.status}、0 字节）——服务可能临时故障，稍后重试或换源`,
        );
      }
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(
          `Connector "${this.name}" tool "${toolName}": 上游响应不是合法 JSON（HTTP ${response.status}、${raw.length} 字节）——服务可能故障或接口变更`,
        );
      }
    } catch (error) {
      // status 还没被赋值 = 请求本身没有落地（fetch 抛错/超时），不是一个带状态码
      // 的 HttpResponse——与「上游返回了 4xx/5xx」结构上不同（client.ts 顶部注释
      // 的同一区分，在这里对台账的 status 字段做同样的区分）。
      status ??= error instanceof HttpTimeoutError
        ? "timeout"
        : `error:${error instanceof Error ? error.constructor.name : "Unknown"}`;
      throw error;
    } finally {
      this.appendRaw({
        tool: toolName,
        host,
        method: tool.method ?? "GET",
        params: remaining,
        status: status ?? "error:Unknown",
        latencyMs: Date.now() - startedAt,
        contentType,
        rawText,
      });
      recordApiCall({
        connector: this.name,
        host,
        status: status ?? "error:Unknown",
        latencyMs: Date.now() - startedAt,
        // V63：不再恒为 0——`RateLimitedHttp.request()` 现在把令牌桶真实等待的毫秒数
        // 带在响应对象上（见上方 rateLimitWaitMs 的读取），这里原样入账。非限速 http
        // （测试桩/fixture）没有这个字段，读回的就是初始值 0，与旧行为一致。
        rateLimitWaitMs,
      });
    }
  }

  listTools(): HttpTool[] {
    return this.config.tools.map((tool) => ({ ...tool }));
  }
}
