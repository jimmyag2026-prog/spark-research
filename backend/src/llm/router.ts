import { configuredLlmTimeoutMs } from "../config";
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
  openrouter: ["moonshotai/kimi-k2.6"],
};

export const DEFAULT_MODEL = "moonshotai/kimi-k2.6";

// **已实装的 provider**。`SUPPORTED_PROVIDERS` 是「模型名能被识别成哪一家」的字典，
// 这张表才是「真的能发出请求」的清单——v0.3.1 的实测缺口正是两者被混为一谈
// （声明 6 个、实现 2 个，其余静默落到 OpenRouter）。
// lane R-a 接入 openai / deepseek / qwen / 本地端点、R-b 接入 anthropic 时，
// 加的是这张表，`capabilities` 与 narrative_parity 门禁都读它。
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
};

export function implementedProviders(): Provider[] {
  return Object.keys(ADAPTERS) as Provider[];
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
      return failure(providerForModel(model), model, {
        kind: "auth",
        message: configured
          ? `模型 '${model}' 没有可用的 provider（已配置：${configured}）`
          : "没有配置任何 API key。设置 KIMI_API_KEY 或 OPENROUTER_API_KEY，或运行 `spark-research auth`",
        retryable: false,
      });
    }

    return entry.adapter.call({
      model,
      messages,
      options,
      apiKey: this.env[entry.envKey]!,
      baseUrl: "",
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  /** 选 adapter：优先模型所属的 provider；它没配 key 时退到任一已配置的兼容 provider。 */
  private resolve(model: string): { adapter: ProviderAdapter; envKey: string } | null {
    const preferred = ADAPTERS[providerForModel(model)];
    if (preferred && this.env[preferred.envKey]) return preferred;
    for (const provider of implementedProviders()) {
      const entry = ADAPTERS[provider]!;
      if (this.env[entry.envKey]) return entry;
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
