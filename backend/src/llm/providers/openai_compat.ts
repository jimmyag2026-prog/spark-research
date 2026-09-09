import type { ChatMessage, LlmResponse, ProviderCapabilities, Usage } from "../types";
import { redactSecrets } from "../types";
import { failure, type ProviderAdapter, type ProviderRequest } from "./types";

// OpenAI 兼容基座。
//
// **「模型中立」的真正落点**：kimi / openrouter / openai / deepseek / qwen /
// ollama / vLLM / 任意自建 baseUrl 走的都是同一套 `/chat/completions` 形状，
// 差别只在 baseUrl、鉴权头与少数可选字段。v0.3.1 之前这里是两份几乎逐行重复的
// `callKimi` / `callOpenRouter`——那也是「声明 6 个 provider 只实现 2 个」的成因：
// 每加一个 provider 就要再抄一份，于是没人加。
//
// **P11 接口先行只搬运既有行为**（把两份重复合成一份 + 换成 v2 响应形状），
// tool calling / 流式 / JSON 模式 / usage 由 lane R-a 在此基础上补齐——
// 所以下面的 capabilities 现在如实报 false，**不许提前写成 true**（AD-12：
// 声称必须与实现一致，capabilities 是给外部 agent 选模型用的，不是许愿池）。

export interface OpenAiCompatOptions {
  id: string;
  baseUrl: string;
  /** 额外请求头（如 OpenRouter 的 HTTP-Referer / X-Title）。 */
  extraHeaders?: Record<string, string>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

function usageOf(data: ChatCompletionResponse): Usage {
  const input = data.usage?.prompt_tokens;
  const output = data.usage?.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") {
    // 上游没报用量。**不填 0 冒充免费**——下游（P13 的帧级账本）要能区分
    // 「这次真的没花钱」与「我们不知道花了多少」。
    return { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true };
  }
  // 单价表由 lane R-c 接入 registry；在那之前 costUsd 如实为 null。
  return { inputTokens: input, outputTokens: output, costUsd: null };
}

export class OpenAiCompatAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAiCompatOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.extraHeaders = options.extraHeaders ?? {};
  }

  capabilities(_model: string): ProviderCapabilities {
    // P11 接口先行阶段的**真实**能力：只有基础对话。R-a 补齐后再逐项翻 true。
    return { toolCalling: false, jsonMode: false, streaming: false, usageReported: true };
  }

  async call(request: ProviderRequest): Promise<LlmResponse> {
    const { model, messages, apiKey, timeoutMs, fetchImpl, options } = request;

    if (options.tools?.length) {
      // 显式拒绝而不是静默忽略：调用方（P12 的 ToolBus）据此走降级路径。
      // 静默忽略 tools 会让模型「看不见工具」却照常回话，是最难查的那种失败。
      return failure(this.id, model, {
        kind: "unsupported",
        message: `provider '${this.id}' 尚未支持 tool calling（P11 接口先行阶段，由 lane R-a 补齐）`,
        retryable: false,
      });
    }

    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify({ model, messages: toWireMessages(messages), temperature: 0.2 }),
        signal: options.signal ?? controller.signal,
      });
    } catch (error) {
      // 超时与其它网络失败在这里分岔：AbortController 触发的一律是 AbortError。
      const timedOut = error instanceof Error && error.name === "AbortError";
      const message = error instanceof Error ? error.message : String(error);
      return failure(this.id, model, {
        kind: timedOut ? "timeout" : "upstream",
        message: timedOut
          ? `请求超过 ${timeoutMs}ms 未返回`
          : `网络层失败：${redactSecrets(message)}`,
        retryable: true,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      // 响应体可能回显请求内容（含鉴权头），过一遍脱敏再截断。
      const body = redactSecrets((await response.text()).slice(0, 200));
      const kind = response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "rate_limit" : "upstream";
      return failure(this.id, model, {
        kind,
        message: `HTTP ${response.status}${body ? `: ${body}` : ""}`,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    let data: ChatCompletionResponse;
    try {
      data = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      return failure(this.id, model, {
        kind: "parse",
        message: `上游返回的不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      });
    }

    const choice = data.choices?.[0];
    return {
      ok: true,
      provider: this.id,
      model,
      content: String(choice?.message?.content ?? ""),
      toolCalls: [],
      usage: usageOf(data),
      ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };
  }
}
