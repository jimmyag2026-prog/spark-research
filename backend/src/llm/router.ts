import { configuredLlmTimeoutMs } from "../config";
import { anthropicAdapter } from "./providers/anthropic";
import { OpenAiCompatAdapter } from "./providers/openai_compat";
import { failure, type ProviderAdapter } from "./providers/types";
import type { CallOptions, ChatMessage, LlmResponse, ProviderCapabilities } from "./types";

export type { CallOptions, ChatMessage, LlmResponse, ProviderCapabilities, ToolCall, ToolSpec, Usage } from "./types";

export const SUPPORTED_PROVIDERS = ["kimi", "openai", "anthropic", "deepseek", "qwen", "openrouter"] as const;
export type Provider = (typeof SUPPORTED_PROVIDERS)[number];

export const PROVIDER_MODELS: Record<Provider, readonly string[]> = {
  kimi: ["kimi-k2", "moonshot-v1-32k", "moonshot-v1-8k"],
  openai: ["gpt-4o", "gpt-4o-mini", "o4-mini"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  qwen: ["qwen3", "qwen-max"],
  // z-ai/glm-5.3-flash：v0.6 B2 轮次指定模型。必须显式登记——providerForModel 的
  // 关键词兜底认不出 "z-ai/glm"（不含 kimi/gpt/claude/deepseek/qwen 任何一个词），
  // 不登记会静默落到 kimi adapter 用错误的 baseUrl 调用。
  openrouter: ["moonshotai/kimi-k2.6", "z-ai/glm-5.3-flash"],
};

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

function providerForModel(model: string): Provider {
  for (const provider of SUPPORTED_PROVIDERS) {
    if (PROVIDER_MODELS[provider].includes(model)) return provider;
  }
  const low = model.toLowerCase();
  if (low.includes("kimi") || low.includes("moonshot")) return "kimi";
  if (low.includes("gpt") || low.includes("o4")) return "openai";
  if (low.includes("claude")) return "anthropic";
  if (low.includes("deepseek")) return "deepseek";
  if (low.includes("qwen")) return "qwen";
  return "kimi";
}

function defaultLlmTimeoutMs(): number {
  return configuredLlmTimeoutMs(120_000);
}

export class LLMRouter {
  static readonly SUPPORTED_PROVIDERS = SUPPORTED_PROVIDERS;
  static readonly PROVIDER_MODELS = PROVIDER_MODELS;
  static readonly DEFAULT_MODEL = DEFAULT_MODEL;

  private env: Record<string, string | undefined>;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(
    env: Record<string, string | undefined> = process.env,
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.env = env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? defaultLlmTimeoutMs();
  }

  /**
   * 第二个参数向后兼容：既可以像 v1 那样传模型名字符串，也可以传 CallOptions。
   * 9 个生产消费方与 12 个测试文件都用 `call(messages, model?)`，不改它们。
   */
  async call(messages: ChatMessage[], modelOrOptions: string | CallOptions = {}): Promise<LlmResponse> {
    const options: CallOptions =
      typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
    const model = options.model ?? DEFAULT_MODEL;

    const entry = this.resolve(model);
    if (!entry) {
      const configured = implementedProviders()
        .filter((p) => this.env[ADAPTERS[p]!.envKey])
        .join(" / ");
      const isLocal = LOCAL_MODEL_PREFIX.test(model);
      return failure(isLocal ? "local" : providerForModel(model), model, {
        kind: "auth",
        message: isLocal
          ? `模型 '${model}' 以 local/ 开头，但没设置 ${LOCAL_BASE_URL_ENV}——本地端点（ollama / vLLM / 任意自建 OpenAI 兼容服务）需要先设这个环境变量指向其 baseUrl。`
          : configured
            ? `模型 '${model}' 没有可用的 provider（已配置：${configured}）`
            : "没有配置任何 API key。设置 KIMI_API_KEY 或 OPENROUTER_API_KEY，或运行 `spark-research auth`",
        retryable: false,
      });
    }

    return entry.adapter.call({
      model: entry.wireModel(model),
      messages,
      options,
      // 本地端点允许空 key（很多本地服务不校验）；其它 provider 走到这里时
      // resolve() 已经保证 env[envKey] 有值，`?? ""` 只对本地端点生效。
      apiKey: this.env[entry.envKey] ?? "",
      baseUrl: "",
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
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
    for (const provider of implementedProviders()) {
      const entry = ADAPTERS[provider]!;
      if (this.env[entry.envKey]) return { ...entry, wireModel: identity };
    }
    return null;
  }

  /** 某个模型实际可用的能力位。**随 capabilities --json 透出**，供调用方选模型前 introspect。 */
  capabilitiesFor(model = DEFAULT_MODEL): ProviderCapabilities | null {
    return this.resolve(model)?.adapter.capabilities(model) ?? null;
  }

  listModels(): Record<Provider, readonly string[]> {
    const result = {} as Record<Provider, readonly string[]>;
    for (const provider of SUPPORTED_PROVIDERS) {
      result[provider] = [...PROVIDER_MODELS[provider]];
    }
    return result;
  }
}
