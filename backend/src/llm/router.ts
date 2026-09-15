import { configuredLlmTimeoutMs } from "../config";
import { anthropicAdapter } from "./providers/anthropic";
import { OpenAiCompatAdapter } from "./providers/openai_compat";
import { failure, type ProviderAdapter } from "./providers/types";
import type { CallOptions, ChatMessage, LlmResponse, ProviderCapabilities } from "./types";
import { guardLlmCall } from "./watchdog";
import { retryDelayMs } from "./provider_error";
import { MODELS_BY_PROVIDER, UnknownModelError, assertKnownModel } from "./providers/registry";

export type { CallOptions, ChatMessage, LlmResponse, ProviderCapabilities, ToolCall, ToolSpec, Usage } from "./types";

export const SUPPORTED_PROVIDERS = ["kimi", "openai", "anthropic", "deepseek", "qwen", "openrouter"] as const;
export type Provider = (typeof SUPPORTED_PROVIDERS)[number];

// v0.9 β-3（U5）：模型归属只有一份真源——单价表（providers/registry.ts）。此处不再手写清单。
// 必须是 re-export 而不是 `const X = MODELS_BY_PROVIDER`：registry → router（providerApiKeyEnv）与
// router → registry 成环，后者在模块顶层求值会踩 ESM TDZ（β 实测）。
export { MODELS_BY_PROVIDER as PROVIDER_MODELS } from "./providers/registry";

export const DEFAULT_MODEL = "moonshotai/kimi-k2.6";

// **已实装的 provider**。`SUPPORTED_PROVIDERS` 是「模型名能被识别成哪一家」的字典，
// 这张表才是「真的能发出请求」的清单——v0.3.1 的实测缺口正是两者被混为一谈
// （声明 6 个、实现 2 个，其余静默落到 OpenRouter）。
//
// R-a（P11-a）补上 openai / deepseek / qwen：三家都是 OpenAI 兼容端点，baseUrl 与官方文档
// 已用 WebSearch 核实（见 docs/devlog/P11-a.md）——三家都支持 tools / response_format:json_object /
// 流式，所以用 `OpenAiCompatAdapter` 的默认云端 capabilities（不传 `capabilities` 覆盖）。
// R-b 接入 anthropic 时加的也是这张表。
const ADAPTERS: Partial<Record<Provider, { adapter: ProviderAdapter; envKey: string }>> = {
  openrouter: {
    adapter: new OpenAiCompatAdapter({
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      extraHeaders: { "HTTP-Referer": "https://spark-research.local", "X-Title": "Spark Research" },
    }),
    envKey: "OPENROUTER_API_KEY",
  },
  kimi: {
    adapter: new OpenAiCompatAdapter({ id: "kimi", baseUrl: "https://api.moonshot.ai/v1" }),
    envKey: "KIMI_API_KEY",
  },
  // P11 lane R-b：Anthropic 原生（Messages API，与 OpenAI 形状差七处，见 providers/anthropic.ts）。
  // 接线由主会话统一做——R-b 与 R-c 都不持有 router.ts，避免两条 lane 在同一文件上撞车。
  anthropic: {
    adapter: anthropicAdapter,
    envKey: "ANTHROPIC_API_KEY",
  },
  openai: {
    adapter: new OpenAiCompatAdapter({ id: "openai", baseUrl: "https://api.openai.com/v1" }),
    envKey: "OPENAI_API_KEY",
  },
  deepseek: {
    // DeepSeek 官方文档的规范 baseUrl 是不带 /v1 的 https://api.deepseek.com
    // （/v1 是给「照抄 OpenAI SDK 代码」用户准备的兼容别名，两者等价，这里用规范形式）。
    adapter: new OpenAiCompatAdapter({ id: "deepseek", baseUrl: "https://api.deepseek.com" }),
    envKey: "DEEPSEEK_API_KEY",
  },
  qwen: {
    // 阿里云 DashScope 的 OpenAI 兼容模式。这里用中国大陆网关；国际网关是
    // dashscope-intl.aliyuncs.com，两者 baseUrl 不同——本 lane 没有真实账号可验证
    // 网络可达性（测试全部走注入的 fetchImpl），如实记在 devlog，需要国际网关时
    // 交给 R-c 把它收进 CONFIG_SETTINGS 做成可配置项，而不是在这里猜。
    adapter: new OpenAiCompatAdapter({
      id: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }),
    envKey: "QWEN_API_KEY",
  },
};

/**
 * provider → 它需要的环境变量名。**这里是单一真源**（就是 ADAPTERS 本身）。
 *
 * 为什么要导出：P11 收口时踩过——`providers/registry.ts` 曾手工抄了一份同样的映射，
 * 我接线 anthropic 时只改了 ADAPTERS，那份副本没跟上，于是 capabilities 的
 * 「能力位与直接探测一致」断言当场变红。lane R-c 在 devlog 里已经点名这个脆弱性，
 * 它在同一个 PR 里就兑现了。**副本删掉，改成从这里派生。**
 */
export function providerApiKeyEnv(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(ADAPTERS)) {
    if (entry) out[id] = entry.envKey;
  }
  return out;
}

export function implementedProviders(): Provider[] {
  return Object.keys(ADAPTERS) as Provider[];
}

/**
 * 本地端点（ollama / vLLM / 任意自建 OpenAI 兼容服务）。
 *
 * 不进 `SUPPORTED_PROVIDERS`/`Provider` 联合类型——那张表是「模型名 → provider」的
 * 静态字典，本地服务器上的模型名是用户自己起的（"llama3.1" / "qwen2.5:7b" / ...），
 * 硬塞一个空的 `PROVIDER_MODELS.local: []` 会踩中 `orchestrator.test.ts` 里
 * 「每个 provider 的模型列表非空」的既有断言（那个文件不属于本 lane 的所有权，
 * 不能为了本地端点去改它的期望）。
 *
 * 改用显式前缀路由：模型名形如 `local/<真实模型名>` 或 `local:<真实模型名>` 时命中，
 * 前缀剥掉后才是发给本地服务器的 `model` 字段。baseUrl 从环境变量
 * `SPARK_LOCAL_LLM_BASE_URL` 读（config/index.ts 是 R-c 的所有权，本 lane 不加新
 * 配置项——需要收进 `CONFIG_SETTINGS` 交给 R-c 或后续处理，这里先用环境变量落地）。
 * key 允许为空：`SPARK_LOCAL_LLM_API_KEY` 未设时以空字符串调用，adapter 会省略
 * Authorization 头（很多本地服务不校验）。
 *
 * capabilities 保守上报（toolCalling/jsonMode: false，streaming: true，
 * usageReported: false）——本地模型是否支持 function calling / json 模式因模型而异，
 * 我们没有能力在不打真实网络的前提下探测，AD-12 不允许一刀切报 true。
 */
const LOCAL_MODEL_PREFIX = /^local[/:]/;
const LOCAL_BASE_URL_ENV = "SPARK_LOCAL_LLM_BASE_URL";
const LOCAL_API_KEY_ENV = "SPARK_LOCAL_LLM_API_KEY";

function localCapabilities(): ProviderCapabilities {
  return { toolCalling: false, jsonMode: false, streaming: true, usageReported: false };
}

export function providerForModel(model: string): Provider {
  // v0.9 β-3（U5）：认不出的模型名**抛错**（UnknownModelError，kind: unsupported），不再静默当 Kimi；
  // 关键词兜底命中时 registry 打一行 warn（自动化降级必须留痕）。
  const known = assertKnownModel(model);
  if (known.kind === "local") {
    // resolve() 先按 LOCAL_MODEL_PREFIX 分流，本函数在生产路径上不会收到 local/ 名；记账层用 resolveModelName（不抛）。
    throw new Error(`模型 "${model}" 是本地端点（local/ 前缀），不属于任何云端 provider`);
  }
  return known.provider;
}

function defaultLlmTimeoutMs(): number {
  return configuredLlmTimeoutMs(120_000);
}

// V137：`LlmError.retryable` (and `CallOptions.maxRetries`, "仅对 retryable 的失败
// 生效") were both declared but had zero readers anywhere in this file — every
// transient failure (timeout, rate limit, 5xx) propagated straight to the caller
// with no retry path at all, despite the type surface promising one existed.
//
// Bounded exponential backoff + jitter, gated strictly on `error.retryable`.
// **Streaming calls (`options.onDelta` set) are excluded**: a retryable failure
// can happen mid-stream, after some chunks were already delivered to the caller
// via `onDelta` — retrying would re-run the whole request and re-deliver those
// chunks a second time, corrupting whatever the caller is assembling from them.
// Nothing in the non-streaming path is non-idempotent, so retrying it is safe.
// One retry by default, not more: this is a default applied to *every* caller
// that doesn't opt into a different `CallOptions.maxRetries`, including ones with
// their own tight timeout budgets (see tests/timeout/llm.test.ts) — tripling
// worst-case latency by default would be a worse regression than the one being
// fixed. Callers that want more resilience can pass a higher `maxRetries` per call.
const DEFAULT_MAX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 4_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMRouter {
  static readonly SUPPORTED_PROVIDERS = SUPPORTED_PROVIDERS;
  static get PROVIDER_MODELS(): Readonly<Record<Provider, readonly string[]>> {
    return MODELS_BY_PROVIDER;
  }
  static readonly DEFAULT_MODEL = DEFAULT_MODEL;

  private env: Record<string, string | undefined>;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private defaultMaxRetries: number;
  private retryBaseDelayMs: number;
  private sleepImpl: (ms: number) => Promise<void>;

  constructor(
    env: Record<string, string | undefined> = process.env,
    opts: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      /** V137：default for calls that don't set `CallOptions.maxRetries` themselves. */
      maxRetries?: number;
      retryBaseDelayMs?: number;
      /** Test hook — real callers never need this; tests inject a no-op to avoid real waits. */
      sleepImpl?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.env = env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? defaultLlmTimeoutMs();
    this.defaultMaxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
  }

  /**
   * 第二个参数向后兼容：既可以像 v1 那样传模型名字符串，也可以传 CallOptions。
   * 9 个生产消费方与 12 个测试文件都用 `call(messages, model?)`，不改它们。
   */
  async call(messages: ChatMessage[], modelOrOptions: string | CallOptions = {}): Promise<LlmResponse> {
    const options: CallOptions =
      typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
    const model = options.model ?? DEFAULT_MODEL;

    let entry: ReturnType<LLMRouter["resolve"]>;
    try {
      entry = this.resolve(model);
    } catch (e) {
      // v0.9 β-3 / AD-13：未登记的模型名不许异常穿透——翻成 ok:false，消息里已列出已登记模型与下一步。
      if (e instanceof UnknownModelError) return failure("(unknown)", model, { kind: "unsupported", message: e.message, retryable: false });
      throw e;
    }
    if (!entry) {
      const configured = implementedProviders()
        .filter((p) => this.env[ADAPTERS[p]!.envKey])
        .join(" / ");
      const isLocal = LOCAL_MODEL_PREFIX.test(model);
      const owner = isLocal ? null : providerForModel(model);
      const ownerKey = owner ? ADAPTERS[owner]?.envKey : undefined;
      return failure(owner ?? "local", model, {
        kind: "auth",
        message: isLocal
          ? `模型 '${model}' 以 local/ 开头，但没设置 ${LOCAL_BASE_URL_ENV}——本地端点（ollama / vLLM / 任意自建 OpenAI 兼容服务）需要先设这个环境变量指向其 baseUrl。`
          : !configured
            ? "没有配置任何 API key。设置 KIMI_API_KEY 或 OPENROUTER_API_KEY，或运行 `spark-research auth`"
            : ownerKey
              // V154：不再静默回退到别家 provider；把「该配哪把 key」说清楚。
              ? `模型 '${model}' 属于 ${owner}，但没有设置 ${ownerKey}（已配置的 provider：${configured}）。运行 \`spark-research auth\` 配置，或改用已配置 provider 的模型。`
              : `模型 '${model}' 没有可用的 provider（已配置：${configured}）`,
        retryable: false,
      });
    }

    // V137：streaming calls never retry (see the DEFAULT_MAX_RETRIES comment above
    // for why) — bounded exponential backoff + jitter otherwise, gated strictly on
    // `error.retryable`, capped by `options.maxRetries` (declared in CallOptions
    // since P11, never consumed until now) or the router's own default.
    const maxRetries = options.onDelta ? 0 : options.maxRetries ?? this.defaultMaxRetries;
    let attempt = 0;
    for (;;) {
      // α-1（v0.9）：输出看门狗——只计等待模型事件的时间，真实增量续期，元数据帧不续期。
      // guard 必须建在循环内：run() 在 finally 里 dispose()，跨重试复用会带着上一轮的剩余预算。
      const guard = guardLlmCall({
        provider: entry.adapter.id,
        model,
        options,
        capabilities: entry.adapter.capabilities(model),
        defaultIdleTimeoutMs: this.timeoutMs,
      });
      const response = await guard.run((guarded) =>
        entry.adapter.call({
          model: entry.wireModel(model),
          messages,
          options: guarded,
          // 本地端点允许空 key（很多本地服务不校验）；其它 provider 走到这里时
          // resolve() 已经保证 env[envKey] 有值，`?? ""` 只对本地端点生效。
          apiKey: this.env[entry.envKey] ?? "",
          baseUrl: "",
          timeoutMs: guarded.timeoutMs ?? this.timeoutMs,
          fetchImpl: this.fetchImpl,
        }),
      );
      if (response.ok || !response.error.retryable || attempt >= maxRetries) return response;
      // α-2（v0.9）：有 Retry-After 时按 provider 给的时间表走；否则指数退避 + 抖动（V137 本体不动）。
      const delay = retryDelayMs({ error: response.error, attempt, baseDelayMs: this.retryBaseDelayMs, maxDelayMs: RETRY_MAX_DELAY_MS });
      await this.sleepImpl(delay);
      attempt++;
    }
  }

  /**
   * 选 adapter：`local/<model>` / `local:<model>` 前缀显式路由到本地端点
   * （baseUrl 来自 `SPARK_LOCAL_LLM_BASE_URL`）；否则优先模型所属的 provider，
   * 它没配 key 时退到任一已配置的兼容 provider（本地端点不参与这条隐式回退——
   * 它是显式 opt-in，不应该在用户没提到 "local/" 时悄悄替对方发请求）。
   */
  private resolve(model: string): { adapter: ProviderAdapter; envKey: string; wireModel: (m: string) => string } | null {
    if (LOCAL_MODEL_PREFIX.test(model)) {
      const baseUrl = this.env[LOCAL_BASE_URL_ENV];
      if (!baseUrl) return null;
      const adapter = new OpenAiCompatAdapter({ id: "local", baseUrl, capabilities: localCapabilities });
      return { adapter, envKey: LOCAL_API_KEY_ENV, wireModel: (m) => m.replace(LOCAL_MODEL_PREFIX, "") };
    }
    const identity = (m: string) => m;
    const preferred = ADAPTERS[providerForModel(model)];
    if (preferred && this.env[preferred.envKey]) return { ...preferred, wireModel: identity };
    // V154（v0.9 收口，β 挖出的 U10 第二成因）：模型所属 provider 没配 key 时**不再**隐式回退到任一
    // 已配置的 provider——那会把 "qwen-max" 原样发给 OpenRouter 并"照常回答"，用户完全看不见。
    // 现在 fail-closed：返回 null，call() 落 kind:"auth" 并列出已配置的 provider 作下一步。
    return null;
  }

  /** 某个模型实际可用的能力位。**随 capabilities --json 透出**，供调用方选模型前 introspect。 */
  capabilitiesFor(model = DEFAULT_MODEL): ProviderCapabilities | null {
    return this.resolve(model)?.adapter.capabilities(model) ?? null;
  }

  listModels(): Record<Provider, readonly string[]> {
    const result = {} as Record<Provider, readonly string[]>;
    for (const provider of SUPPORTED_PROVIDERS) {
      result[provider] = [...MODELS_BY_PROVIDER[provider]];
    }
    return result;
  }
}
