import { configuredLlmTimeoutMs } from "../config";
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

// D-2（P10-b）：无超时的裸 fetch 会让任何一次卡住的模型调用把整条 orchestrator
// 流程挂死。config/ 面板（P9）没有对应设置项（只读不改，见 docs/devlog/P10-b.md），
// 走 env + 常量默认。120s：对照 backend/src/lab/wet_backend.ts 的湿实验后端超时
// 惯例（同为「一次外部调用整体等多久算挂」的量级），也留够长文本生成的余量。
// P10 收口：默认值收进 config 注册表（`CONFIG_SETTINGS.llmTimeoutMs`），优先级仍是
// env > config.json > 常量默认，与仓库其余配置项走同一套解析（P9「配置面收口」）。
// 做成函数而不是模块级常量：改了 config.json 不必重启进程。
function defaultLlmTimeoutMs(): number {
  return configuredLlmTimeoutMs(120_000);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (timeoutMs <= 0) return fetchImpl(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 超时是否命中：AbortController 触发的失败一律是 DOMException("AbortError")
// （或等价的 name === "AbortError"）。用它把「超时」与「网络层其它失败」
// （DNS 解析失败、连接被拒等，同样是 fetch() 抛错）分开报出去。
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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

export class LLMRouter {
  static readonly SUPPORTED_PROVIDERS = SUPPORTED_PROVIDERS;
  static readonly PROVIDER_MODELS = PROVIDER_MODELS;
  static readonly DEFAULT_MODEL = DEFAULT_MODEL;

  private env: Record<string, string | undefined>;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  // 第二个参数是新增的可选项（D-2）：fetchImpl 供测试注入「永不响应」的假实现而不必
  // monkey-patch 全局 fetch；timeoutMs 覆盖模块级默认，同样只为测试用短超时跑得快。
  // 两者都可选，所有既有调用点（`new LLMRouter()` / `new LLMRouter(env)`）不用改。
  constructor(
    env: Record<string, string | undefined> = process.env,
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.env = env;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? defaultLlmTimeoutMs();
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
    let response: Response;
    try {
      response = await fetchWithTimeout(
        OPENROUTER_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "HTTP-Referer": "https://spark-research.local",
            "X-Title": "Spark Research",
          },
          body: JSON.stringify({ model, messages, temperature: 0.2 }),
        },
        this.timeoutMs,
        this.fetchImpl,
      );
    } catch (error) {
      // 「超时」与「上游报错」在这里就分岔：超时是请求根本没落地（无 HTTP 状态码可言），
      // 上游报错是拿到了响应但 status 不在 2xx——下面 !response.ok 分支处理的是后者。
      const timedOut = isAbortError(error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        provider: "openrouter",
        model,
        content: timedOut
          ? `[error] timeout: openrouter request exceeded ${this.timeoutMs}ms`
          : `[error] network: ${message}`,
        mock: false,
      };
    }
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
    let response: Response;
    try {
      response = await fetchWithTimeout(
        KIMI_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ model, messages, temperature: 0.2 }),
        },
        this.timeoutMs,
        this.fetchImpl,
      );
    } catch (error) {
      const timedOut = isAbortError(error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        provider: "kimi",
        model,
        content: timedOut
          ? `[error] timeout: kimi request exceeded ${this.timeoutMs}ms`
          : `[error] network: ${message}`,
        mock: false,
      };
    }
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
