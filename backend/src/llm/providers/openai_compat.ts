import type { ChatMessage, LlmResponse, ProviderCapabilities, ToolCall, Usage } from "../types";
import { redactSecrets } from "../types";
import { MAX_ERROR_BODY_CHARS, normalizeProviderError, providerFailure } from "../provider_error";
import { failure, raceWithAbort, type ProviderAdapter, type ProviderRequest } from "./types";

// OpenAI 兼容基座。
//
// **「模型中立」的真正落点**：kimi / openrouter / openai / deepseek / qwen /
// ollama / vLLM / 任意自建 baseUrl 走的都是同一套 `/chat/completions` 形状，
// 差别只在 baseUrl、鉴权头与少数可选字段。v0.3.1 之前这里是两份几乎逐行重复的
// `callKimi` / `callOpenRouter`——那也是「声明 6 个 provider 只实现 2 个」的成因：
// 每加一个 provider 就要再抄一份，于是没人加。
//
// **P11-a（本文件的 lane）在接口先行的基础上把 tool calling / 流式 / json_object
// 真正实现出来**：请求侧不再对 `options.tools` 显式拒绝，响应侧解析
// `message.tool_calls`（非流式）与增量 `delta.tool_calls`（流式）。
//
// capabilities() 现在**按 provider 实例区分**汇报（AD-12）：云端 OpenAI 兼容
// provider（openai/kimi/deepseek/qwen/openrouter，均已用 WebSearch 核实官方文档
// 支持 tools + response_format:json_object，见 docs/devlog/P11-a.md）默认视为
// 全支持；本地端点（ollama/vLLM/任意自建 baseUrl）默认保守（不承诺 tool calling /
// json 模式——因模型而异，我们没有能力在不打真实网络的前提下探测），构造时可传
// `capabilities` 覆盖。**声明是否支持不改变 call() 是否尝试发送**——同一份代码对
// 所有 provider 一视同仁地把 tools/response_format/stream 编码进请求；capabilities()
// 纯粹是给调用方选模型前 introspect 用的诚实广播，不是执行门禁。

export interface OpenAiCompatOptions {
  id: string;
  baseUrl: string;
  /** 额外请求头（如 OpenRouter 的 HTTP-Referer / X-Title）。 */
  extraHeaders?: Record<string, string>;
  /**
   * 该 provider 实际支持的能力位。省略时用云端 OpenAI 兼容 provider 的标准能力
   * （tool calling / json 模式 / 流式 / usage 上报全 true）。本地端点因模型而异，
   * 由调用方（router.ts）显式传入保守版本。
   */
  capabilities?: (model: string) => ProviderCapabilities;
}

interface WireToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const CLOUD_CAPABILITIES: ProviderCapabilities = {
  toolCalling: true,
  jsonMode: true,
  streaming: true,
  usageReported: true,
};

function defaultCapabilities(): ProviderCapabilities {
  return { ...CLOUD_CAPABILITIES };
}

function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * `message.tool_calls` / 流式累积出的等价结构 → `ToolCall[]`。
 * **解析失败要返回失败，不许静默吞掉**（R-a-1 的硬要求）——静默吞掉会让调用方
 * 拿到一个「工具调用凭空消失」的响应，比显式失败更难查。
 */
function parseToolCalls(raw: WireToolCall[]): { ok: true; calls: ToolCall[] } | { ok: false; message: string } {
  const calls: ToolCall[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    const tc = raw[idx]!;
    const name = tc.function?.name ?? "";
    const rawArgs = tc.function?.arguments ?? "";
    let args: Record<string, unknown>;
    try {
      args = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch (error) {
      return {
        ok: false,
        message: `第 ${idx} 个 tool_call（${name || "未知函数名"}）的 arguments 不是合法 JSON：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    calls.push({ id: tc.id ?? `call_${idx}`, name, args });
  }
  return { ok: true, calls };
}

function buildRequestBody(
  model: string,
  messages: ChatMessage[],
  options: ProviderRequest["options"],
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: toWireMessages(messages),
    temperature: 0.2,
  };
  if (options.tools?.length) {
    body.tools = options.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    if (options.toolChoice) {
      body.tool_choice =
        options.toolChoice === "auto" || options.toolChoice === "none"
          ? options.toolChoice
          : { type: "function", function: { name: options.toolChoice.name } };
    }
  }
  if (options.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }
  if (stream) {
    body.stream = true;
    // 流式下 usage 通常要靠 stream_options.include_usage 才有；拿不到就如实
    // usageUnavailable（下面 consumeStream 的默认值），不许填 0 冒充。
    body.stream_options = { include_usage: true };
  }
  return body;
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
  private readonly capabilitiesFn: (model: string) => ProviderCapabilities;

  constructor(options: OpenAiCompatOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.extraHeaders = options.extraHeaders ?? {};
    this.capabilitiesFn = options.capabilities ?? defaultCapabilities;
  }

  capabilities(model: string): ProviderCapabilities {
    return this.capabilitiesFn(model);
  }

  async call(request: ProviderRequest): Promise<LlmResponse> {
    const { model, messages, apiKey, timeoutMs, fetchImpl, options } = request;
    const streaming = Boolean(options.onDelta);
    const body = buildRequestBody(model, messages, options, streaming);

    // V134：the timer/controller must stay alive across the *entire* call, not just
    // the initial `fetch()` — a 200-OK response can still hang mid-stream or
    // mid-body. `effectiveSignal` is whatever signal actually governs the request
    // (caller-supplied, or our own timeout controller) and is reused below for
    // every subsequent body read via `raceWithAbort`, all inside one `finally` that
    // clears the timer exactly once, after everything (success or failure) settles.
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const effectiveSignal = options.signal ?? controller.signal;
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // 本地端点的 key 允许为空（很多本地服务不校验）——不发一个空 Bearer 头，
            // 免得个别服务器把「Authorization: Bearer 」当成格式错误的凭据来拒绝。
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...this.extraHeaders,
          },
          body: JSON.stringify(body),
          signal: effectiveSignal,
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
      }

      if (!response.ok) {
        let body2: string;
        try {
          // α-2：脱敏统一在 `normalizeProviderError` 里做（错误体可能回显请求内容含鉴权头）；
          // 截断从 200 放宽到 MAX_ERROR_BODY_CHARS——200 字符装不下一条完整的错误 JSON，
          // 截断点常常正好落在 `error.message` 中间，事后连上游说了什么都读不全。
          body2 = (await raceWithAbort(response.text(), effectiveSignal)).slice(0, MAX_ERROR_BODY_CHARS);
        } catch (error) {
          const timedOut = error instanceof Error && error.name === "AbortError";
          return failure(this.id, model, {
            kind: timedOut ? "timeout" : "upstream",
            message: timedOut
              ? `HTTP ${response.status} 的响应体在 ${timeoutMs}ms 内未读完`
              : `读取错误响应体失败：${error instanceof Error ? redactSecrets(error.message) : String(error)}`,
            retryable: true,
          });
        }
        // α-2：分类不再是这里手写的一行三元式（401/403→auth、429→rate_limit、其余→upstream，
        // 429 与 5xx 可重试）——那份判据与 anthropic.ts 的 classifyHttpError 各自演化，
        // 而且两边都不读 `response.headers`，`Retry-After` 白扔。统一交给 provider_error。
        return providerFailure(
          this.id,
          model,
          normalizeProviderError({ statusCode: response.status, body: body2, headers: response.headers }),
        );
      }

      if (streaming) {
        return await this.consumeStream(response, model, options.onDelta!, effectiveSignal, timeoutMs);
      }

      let data: ChatCompletionResponse;
      try {
        data = (await raceWithAbort(response.json(), effectiveSignal)) as ChatCompletionResponse;
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        return failure(this.id, model, {
          kind: timedOut ? "timeout" : "parse",
          message: timedOut
            ? `响应体在 ${timeoutMs}ms 内未读完（上游 200 OK 后挂起）`
            : `上游返回的不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        });
      }

      const choice = data.choices?.[0];
      const rawToolCalls = choice?.message?.tool_calls;
      let toolCalls: ToolCall[] = [];
      if (rawToolCalls?.length) {
        const parsed = parseToolCalls(rawToolCalls);
        if (!parsed.ok) {
          return failure(this.id, model, { kind: "parse", message: parsed.message, retryable: false });
        }
        toolCalls = parsed.calls;
      }

      return {
        ok: true,
        provider: this.id,
        model,
        content: String(choice?.message?.content ?? ""),
        toolCalls,
        usage: usageOf(data),
        ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 逐块解析 SSE（`data: {...}` 行），把 `choices[0].delta.content` 回调出去；
   * 结束时仍返回完整的 `LlmResponse`（R-a-2）。tool_calls 的增量片段（`delta.tool_calls`，
   * 按 `index` 分片、`arguments` 要跨块拼接）也在这里累积，拼完后复用非流式同一套
   * `parseToolCalls`——两条路径共用一份「解析失败必须显式失败」的纪律，不重复写一遍。
   */
  private async consumeStream(
    response: Response,
    model: string,
    onDelta: (chunk: string) => void,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<LlmResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      return failure(this.id, model, {
        kind: "parse",
        message: "流式响应没有可读的 body（fetchImpl 未返回 ReadableStream）",
        retryable: false,
      });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | undefined;
    // 拿不到 usage 就如实 usageUnavailable：true（不许填 0 冒充）——见 R-a-2。
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true };
    const toolCallAcc = new Map<number, { id?: string; name?: string; args: string }>();
    // α-2：流内错误帧。此前 `data: {"error": {...}}` 帧走到下面 `json.choices?.[0]`
    // 读成 undefined 后被**静默丢弃**——一次上游 502 于是变成一个 `ok:true` 的空回答
    // （USAGE_LOG U1 那条「失败没留下痕迹」的极端形态）。现在规范化 + 分类后显式失败。
    let streamError: LlmResponse | undefined;

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "" || payload === "[DONE]") return;
      let json: {
        choices?: Array<{ delta?: { content?: string; tool_calls?: WireToolCall[] }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: unknown;
      };
      try {
        json = JSON.parse(payload);
      } catch {
        // 忽略解析不了的行（少数网关会插入注释/keep-alive 行，不是错误）。
        return;
      }
      if (json.error !== undefined && json.error !== null) {
        // 帧里没有 HTTP 状态码；OpenRouter 会把 HTTP 类放在数字 `error.code` 里，
        // normalizeProviderError 认这种形状。第一条错误帧即终结本次流。
        streamError ??= providerFailure(this.id, model, normalizeProviderError({ body: payload }));
        return;
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const acc = toolCallAcc.get(idx) ?? { args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
          toolCallAcc.set(idx, acc);
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json.usage) {
        usage = {
          inputTokens: json.usage.prompt_tokens ?? 0,
          outputTokens: json.usage.completion_tokens ?? 0,
          costUsd: null,
        };
      }
    };

    // V134：each `reader.read()` races the abort signal — a `fetch()` that already
    // resolved with 200 OK carries no more implicit timeout protection on its own,
    // so a body that stops sending bytes (upstream wedge, dead connection kept
    // alive) would otherwise hang this loop forever.
    while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await raceWithAbort(reader.read(), signal));
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        try {
          await reader.cancel();
        } catch {
          // 已经在异常路径上，取消失败不影响我们要返回的错误。
        }
        return failure(this.id, model, {
          kind: timedOut ? "timeout" : "upstream",
          message: timedOut
            ? `流式响应体在 ${timeoutMs}ms 内未读完（上游 200 OK 后挂起）`
            : `读取流失败：${error instanceof Error ? redactSecrets(error.message) : String(error)}`,
          retryable: true,
        });
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
      if (streamError) {
        // 已经通过 onDelta 吐出去的增量**不会被撤回**——调用方拿到的是一个残缺的答案
        // 加一条明确的失败（AD-13：失败响应的 content 恒空）。这比返回 ok:true 的
        // 半截内容诚实：后者会被 review 当成完整产出放行。如实记在 devlog。
        try {
          await reader.cancel();
        } catch {
          // 已在异常路径上，取消失败不影响要返回的错误。
        }
        return streamError;
      }
    }
    if (buffer.trim()) processLine(buffer);
    if (streamError) return streamError;

    let toolCalls: ToolCall[] = [];
    if (toolCallAcc.size > 0) {
      const raw: WireToolCall[] = [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ id: v.id, function: { name: v.name, arguments: v.args } }));
      const parsed = parseToolCalls(raw);
      if (!parsed.ok) {
        return failure(this.id, model, { kind: "parse", message: parsed.message, retryable: false });
      }
      toolCalls = parsed.calls;
    }

    return {
      ok: true,
      provider: this.id,
      model,
      content,
      toolCalls,
      usage,
      ...(finishReason ? { finishReason } : {}),
    };
  }
}
