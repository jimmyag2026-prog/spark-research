export const SUPPORTED_PROVIDERS = ["kimi", "openai", "anthropic", "deepseek", "qwen", "openrouter"] as const;
export type Provider = (typeof SUPPORTED_PROVIDERS)[number];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResponse {
  ok: boolean;
  provider: Provider;
  model: string;
  content: string;
  mock: boolean;
  // 上游给的结束原因（"stop" / "length" / …）。拿不到就是 undefined。
  //
  // 为什么要它（P8-G5 实测）：判定器解析失败时，「模型没按格式输出」与「输出被截断」
  // 是两回事——前者该重试并把格式要求说重，后者重试多少次都一样。没有这个字段，
  // 两种失败在日志里长得完全一样，只能靠猜。
  finishReason?: string;
}

export const PROVIDER_MODELS: Record<Provider, readonly string[]> = {
  kimi: ["kimi-k2", "moonshot-v1-32k", "moonshot-v1-8k"],
  openai: ["gpt-4o", "gpt-4o-mini", "o4-mini"],
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  qwen: ["qwen3", "qwen-max"],
  openrouter: ["moonshotai/kimi-k2.6"],
};

export const DEFAULT_MODEL = "moonshotai/kimi-k2.6";

const KIMI_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

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

export class LLMRouter {
  static readonly SUPPORTED_PROVIDERS = SUPPORTED_PROVIDERS;
  static readonly PROVIDER_MODELS = PROVIDER_MODELS;
  static readonly DEFAULT_MODEL = DEFAULT_MODEL;

  private env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }

  private keys(): { kimi?: string; openrouter?: string } {
    return {
      kimi: this.env.KIMI_API_KEY ?? undefined,
      openrouter: this.env.OPENROUTER_API_KEY ?? undefined,
    };
  }

  async call(messages: ChatMessage[], model = DEFAULT_MODEL): Promise<LlmResponse> {
    const provider = providerForModel(model);
    const { kimi, openrouter } = this.keys();
    if (provider === "openrouter" && openrouter) {
      return this.callOpenRouter(messages, model, openrouter);
    }
    if (provider === "kimi" && kimi) {
      return this.callKimi(messages, model, kimi);
    }
    if (openrouter) {
      return this.callOpenRouter(messages, model, openrouter);
    }
    return {
      ok: false,
      provider,
      model,
      content: `[error] No API key configured. Set KIMI_API_KEY or OPENROUTER_API_KEY, or use 'spark-research auth' to configure.`,
      mock: false,
    };
  }

  private async callOpenRouter(
    messages: ChatMessage[],
    model: string,
    key: string,
  ): Promise<LlmResponse> {
    const response = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://spark-research.local",
        "X-Title": "Spark Research",
      },
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
    });
    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        provider: "openrouter",
        model,
        content: `[error] HTTP ${response.status}: ${text.slice(0, 200)}`,
        mock: false,
      };
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    return {
      ok: true,
      provider: "openrouter",
      model,
      content: String(content),
      mock: false,
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };
  }

  private async callKimi(
    messages: ChatMessage[],
    model: string,
    key: string,
  ): Promise<LlmResponse> {
    const response = await fetch(KIMI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
    });
    if (!response.ok) {
      return { ok: false, provider: "kimi", model, content: `[error] HTTP ${response.status}`, mock: false };
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? "";
    return {
      ok: true,
      provider: "kimi",
      model,
      content: String(content),
      mock: false,
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };
  }

  listModels(): Record<Provider, readonly string[]> {
    const result = {} as Record<Provider, readonly string[]>;
    for (const provider of SUPPORTED_PROVIDERS) {
      result[provider] = [...PROVIDER_MODELS[provider]];
    }
    return result;
  }
}
