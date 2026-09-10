import type { ChatMessage, LlmResponse, ProviderCapabilities, ToolCall, Usage } from "../types";
import { redactSecrets } from "../types";
import { failure, type ProviderAdapter, type ProviderRequest } from "./types";

// Anthropic 原生适配器（lane R-b，方案 §4.1）。
//
// **为什么不能复用 openai_compat.ts**：Anthropic 的 Messages API 与 OpenAI 的
// `/chat/completions` 形状在五个维度上不同（见 docs/devlog/P11-b.md 的对照表）：
// 端点（`/v1/messages`）、鉴权（`x-api-key` + `anthropic-version` 头，不是
// `Authorization: Bearer`）、system 提示（顶层 `system` 参数，不在 messages 里）、
// 工具定义（`input_schema` 而非 `function.parameters`）、工具调用/结果的线格式
// （`content[]` 里的 `tool_use` / `tool_result` 块，`tool_use.input` 已经是对象，
// 不需要 `JSON.parse`——与 OpenAI 的 `function.arguments` 字符串相反）。硬套
// openai_compat 只会把两边都写脏，所以独立成一份，遵守同一个 `ProviderAdapter`
// 契约（`backend/src/llm/providers/types.ts`）。
//
// **不支持 response_format**：Anthropic Messages API 没有 JSON 模式参数。
// `capabilities().jsonMode` 如实报 `false`；调用方仍然传 `responseFormat:"json_object"`
// 时，本 adapter 显式返回 `kind:"unsupported"` 的失败（不静默忽略、不假装支持、
// 不用「预填 assistant 消息」的偏方去冒充——那会让"是否真的拿到了 JSON"变成一句
// 没人验证过的承诺，见 devlog 里的取舍记录）。

const ANTHROPIC_VERSION = "2023-06-01";
// CallOptions 没有 maxTokens 字段（llm/types.ts 是 R-c/主会话的所有权，本 lane
// 不加字段），而 Anthropic 的 max_tokens 是必填参数。这里用一个保守的默认值；
// 需要可配置时应该在 CallOptions 上加 `maxTokens?: number`（见 devlog 的已知缺口）。
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface MessagesResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicErrorBody {
  type?: string;
  error?: { type?: string; message?: string };
}

const CAPABILITIES: ProviderCapabilities = {
  toolCalling: true,
  jsonMode: false,
  streaming: true,
  usageReported: true,
};

/**
 * `ChatMessage[]` → Anthropic 的 `{system, messages}`。
 *
 * 三条与 OpenAI 不同的规则都在这里落地：
 *   - `system` 角色的消息**不进 messages 数组**，拼接进顶层 `system` 字符串。
 *   - 连续的 `tool` 角色消息（一轮里模型并发调用多个工具时会产生多条）合并成
 *     **一个** `role:"user"` 消息，content 是多个 `tool_result` 块——这是
 *     Anthropic API 的要求（P12 的 ToolBus 会产出多工具并发调用，这里如果按
 *     OpenAI 的「每条 tool 消息独立一轮」处理会被上游拒绝）。
 *   - assistant 带 `toolCalls` 时，content 编码成 `[{type:"text",...}?, {type:"tool_use",...}]`
 *     数组；`tool_use.input` 用 `tc.args`（本来就是对象，不需要 stringify）。
 */
function toAnthropicRequest(messages: ChatMessage[]): { system?: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const wireMessages: Array<Record<string, unknown>> = [];
  let pendingToolResults: Array<Record<string, unknown>> | null = null;

  const flushToolResults = (): void => {
    if (pendingToolResults) {
      wireMessages.push({ role: "user", content: pendingToolResults });
      pendingToolResults = null;
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      if (pendingToolResults) pendingToolResults.push(block);
      else pendingToolResults = [block];
      continue;
    }
    flushToolResults();
    if (m.role === "user") {
      wireMessages.push({ role: "user", content: m.content });
      continue;
    }
    // 剩下唯一可能的分支是 assistant（ChatMessage 的第四种角色 "tool" 已在上面
    // continue 掉）。显式判 `m.role === "assistant"` 而不是靠排除法落到 else——
    // `{role:"system"|"user", content}` 是单一对象类型里的联合值字段，continue
    // 之后 TS 不会把它从剩余分支的类型里排除掉，显式判断避免 TS2339。
    if (m.role === "assistant") {
      if (m.toolCalls?.length) {
        const content: Array<Record<string, unknown>> = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
        }
        wireMessages.push({ role: "assistant", content });
      } else {
        wireMessages.push({ role: "assistant", content: m.content });
      }
    }
  }
  flushToolResults();

  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: wireMessages };
}

function buildRequestBody(
  model: string,
  messages: ChatMessage[],
  options: ProviderRequest["options"],
  stream: boolean,
): Record<string, unknown> {
  const { system, messages: wireMessages } = toAnthropicRequest(messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: DEFAULT_MAX_TOKENS,
    messages: wireMessages,
  };
  if (system) body.system = system;
  if (options.tools?.length) {
    body.tools = options.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    if (options.toolChoice) {
      body.tool_choice =
        options.toolChoice === "auto"
          ? { type: "auto" }
          : options.toolChoice === "none"
            ? { type: "none" }
            : { type: "tool", name: options.toolChoice.name };
    }
  }
  if (stream) body.stream = true;
  return body;
}

/**
 * 非流式响应的 `content[]` → `ToolCall[]`。**`tool_use.input` 已经是对象**
 * （Anthropic 的响应体本来就是 JSON，不像 OpenAI 那样把 arguments 序列化成字符串
 * 塞进去）——所以这里不调用 `JSON.parse`，但仍然要校验它确实是个对象，不是
 * `undefined`/数组/原始值，**校验失败要显式失败，不许放行一个错形状的 args 或
 * 静默塞 `{}`**（对齐 R-a-1 的纪律；阴性对照①就是验证这条真的被测试钉住）。
 */
function parseToolUseBlocks(blocks: AnthropicContentBlock[]): { ok: true; calls: ToolCall[] } | { ok: false; message: string } {
  const calls: ToolCall[] = [];
  let idx = 0;
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const name = block.name ?? "";
    if (!name) {
      return { ok: false, message: `第 ${idx} 个 tool_use 块缺少 name 字段` };
    }
    const input = block.input;
    if (input === undefined || input === null || typeof input !== "object" || Array.isArray(input)) {
      return {
        ok: false,
        message: `第 ${idx} 个 tool_use 块（${name}）的 input 不是合法对象：${JSON.stringify(input)}`,
      };
    }
    calls.push({ id: block.id ?? `toolu_${idx}`, name, args: input as Record<string, unknown> });
    idx++;
  }
  return { ok: true, calls };
}

/**
 * 流式路径下，`tool_use` 的 `input` 是按 `input_json_delta.partial_json` 分片
 * 增量传的（与非流式相反，这里*是*要拼接字符串再 `JSON.parse`——跟 OpenAI 流式
 * `delta.tool_calls[].function.arguments` 是同一种"增量文本，结束后一次性解析"
 * 的形状，只是外层事件名不同）。**解析失败同样显式失败，不静默吞**。
 */
function parseStreamToolCalls(
  acc: Map<number, { id?: string; name?: string; args: string }>,
): { ok: true; calls: ToolCall[] } | { ok: false; message: string } {
  const calls: ToolCall[] = [];
  const sorted = [...acc.entries()].sort((a, b) => a[0] - b[0]);
  for (const [idx, v] of sorted) {
    const name = v.name ?? "";
    if (!name) {
      return { ok: false, message: `第 ${idx} 个流式 tool_use 块缺少 name 字段` };
    }
    const raw = v.args.trim();
    let input: Record<string, unknown>;
    try {
      input = raw === "" ? {} : JSON.parse(raw);
    } catch (error) {
      return {
        ok: false,
        message: `第 ${idx} 个流式 tool_use 块（${name}）聚合后的 partial_json 不是合法 JSON：${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    calls.push({ id: v.id ?? `toolu_${idx}`, name, args: input });
  }
  return { ok: true, calls };
}

function textOf(blocks: AnthropicContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function usageOf(data: MessagesResponse): Usage {
  const input = data.usage?.input_tokens;
  const output = data.usage?.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") {
    // 上游没报用量。**不填 0 冒充免费**——与 openai_compat 的纪律一致（AD-13 的
    // 姊妹条款）。Anthropic 正常情况下总是报 usage（capabilities().usageReported
    // 如实为 true），这里只是防御性兜底。
    return { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true };
  }
  // 单价表由 lane R-c 接入 registry；在那之前 costUsd 如实为 null。
  return { inputTokens: input, outputTokens: output, costUsd: null };
}

function classifyHttpError(status: number, errType?: string): { kind: "auth" | "rate_limit" | "upstream"; retryable: boolean } {
  if (status === 401 || status === 403 || errType === "authentication_error" || errType === "permission_error") {
    return { kind: "auth", retryable: false };
  }
  if (status === 429 || errType === "rate_limit_error") {
    return { kind: "rate_limit", retryable: true };
  }
  // 529 是 Anthropic 专用的 "overloaded_error" 状态码（上游过载，语义上等价于
  // 5xx，值得重试）。
  if (status === 529 || errType === "overloaded_error" || status >= 500) {
    return { kind: "upstream", retryable: true };
  }
  return { kind: "upstream", retryable: false };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly baseUrl: string;

  constructor(options: { id?: string; baseUrl?: string } = {}) {
    this.id = options.id ?? "anthropic";
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  }

  capabilities(_model: string): ProviderCapabilities {
    void _model;
    return { ...CAPABILITIES };
  }

  async call(request: ProviderRequest): Promise<LlmResponse> {
    const { model, messages, apiKey, timeoutMs, fetchImpl, options } = request;

    // **不假装支持 response_format**：Anthropic Messages API 没有这个参数。
    // 显式失败而不是静默忽略——静默忽略会让调用方以为自己拿到了 JSON 模式的
    // 保证，实际上模型完全可能吐自然语言，这是最难查的那种失败（对齐 P11-iface
    // 里「静默忽略 tools 会让模型看不见工具却照常回话」同一条纪律）。
    if (options.responseFormat === "json_object") {
      return failure(this.id, model, {
        kind: "unsupported",
        message:
          "Anthropic Messages API 原生不支持 response_format：capabilities().jsonMode 已如实报 false，" +
          "调用方不应该对 anthropic provider 传 responseFormat:'json_object'（见 docs/devlog/P11-b.md 的取舍记录）。",
        retryable: false,
      });
    }

    const streaming = Boolean(options.onDelta);
    const body = buildRequestBody(model, messages, options, streaming);

    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: options.signal ?? controller.signal,
      });
    } catch (error) {
      // 超时与其它网络失败在这里分岔：AbortController 触发的一律是 AbortError。
      const timedOut = error instanceof Error && error.name === "AbortError";
      const message = error instanceof Error ? error.message : String(error);
      return failure(this.id, model, {
        kind: timedOut ? "timeout" : "upstream",
        message: timedOut ? `请求超过 ${timeoutMs}ms 未返回` : `网络层失败：${redactSecrets(message)}`,
        retryable: true,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      const rawText = (await response.text()).slice(0, 400);
      let errType: string | undefined;
      let errMessage = rawText;
      try {
        const parsed = JSON.parse(rawText) as AnthropicErrorBody;
        errType = parsed.error?.type;
        if (parsed.error?.message) errMessage = parsed.error.message;
      } catch {
        // 上游没回合法 JSON 错误体，退回原始文本。
      }
      const { kind, retryable } = classifyHttpError(response.status, errType);
      return failure(this.id, model, {
        kind,
        message: `HTTP ${response.status}${errMessage ? `: ${redactSecrets(errMessage.slice(0, 200))}` : ""}`,
        retryable,
      });
    }

    if (streaming) {
      return this.consumeStream(response, model, options.onDelta!);
    }

    let data: MessagesResponse;
    try {
      data = (await response.json()) as MessagesResponse;
    } catch (error) {
      return failure(this.id, model, {
        kind: "parse",
        message: `上游返回的不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      });
    }

    const blocks = data.content ?? [];
    const parsed = parseToolUseBlocks(blocks);
    if (!parsed.ok) {
      return failure(this.id, model, { kind: "parse", message: parsed.message, retryable: false });
    }

    return {
      ok: true,
      provider: this.id,
      model,
      content: textOf(blocks),
      toolCalls: parsed.calls,
      usage: usageOf(data),
      ...(data.stop_reason ? { finishReason: data.stop_reason } : {}),
    };
  }

  /**
   * 逐块解析 Anthropic 的 SSE 事件流。与 OpenAI 的单一 `chat.completion.chunk`
   * 事件类型不同，Anthropic 用一串命名事件表达同一件事（`message_start` →
   * `content_block_start` → 若干 `content_block_delta` → `content_block_stop` →
   * `message_delta`（带最终 `stop_reason` 与 `usage.output_tokens`）→
   * `message_stop`）。事件的 JSON 载荷自带 `type` 字段，与开头的 `event:` 行
   * 冗余，所以这里只解析 `data:` 行，用载荷里的 `type` 分流——不需要单独跟踪
   * `event:` 行。
   *
   * `text_delta` 逐块回调 `onDelta`；`input_json_delta` 的 `partial_json` 按
   * `index` 分片累积，流结束后交给 `parseStreamToolCalls` 统一解析（与非流式
   * 路径的 `parseToolUseBlocks` 是两个独立的解析函数——因为线格式本身不同：
   * 流式是要拼接的 JSON 文本片段，非流式是已经解析好的对象）。
   * 上游中途发 `error` 事件（网络已建立、流已开始后才报错是 Anthropic 的常见
   * 失败模式）时**显式失败**，不把已经攒到的半截内容当成功返回。
   */
  private async consumeStream(response: Response, model: string, onDelta: (chunk: string) => void): Promise<LlmResponse> {
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
    let inputTokens = 0;
    let outputTokens = 0;
    let usageSeen = false;
    let streamError: { message: string } | null = null;
    const toolCallAcc = new Map<number, { id?: string; name?: string; args: string }>();
    const blockKinds = new Map<number, string>();

    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "" || payload === "[DONE]") return;
      let json: {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { type?: string; message?: string };
      };
      try {
        json = JSON.parse(payload);
      } catch {
        // 忽略解析不了的行（keep-alive/comment 行不是错误）。
        return;
      }

      switch (json.type) {
        case "message_start": {
          if (typeof json.message?.usage?.input_tokens === "number") {
            inputTokens = json.message.usage.input_tokens;
            usageSeen = true;
          }
          break;
        }
        case "content_block_start": {
          const idx = json.index ?? 0;
          if (json.content_block?.type) blockKinds.set(idx, json.content_block.type);
          if (json.content_block?.type === "tool_use") {
            toolCallAcc.set(idx, { id: json.content_block.id, name: json.content_block.name, args: "" });
          }
          break;
        }
        case "content_block_delta": {
          const idx = json.index ?? 0;
          if (json.delta?.type === "text_delta" && typeof json.delta.text === "string") {
            content += json.delta.text;
            onDelta(json.delta.text);
          } else if (json.delta?.type === "input_json_delta" && typeof json.delta.partial_json === "string") {
            const acc = toolCallAcc.get(idx) ?? { args: "" };
            acc.args += json.delta.partial_json;
            toolCallAcc.set(idx, acc);
          }
          break;
        }
        case "message_delta": {
          if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
          if (typeof json.usage?.output_tokens === "number") {
            outputTokens = json.usage.output_tokens;
            usageSeen = true;
          }
          break;
        }
        case "error": {
          streamError = { message: json.error?.message ?? "上游流式响应中途报错（error 事件）" };
          break;
        }
        default:
          break;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
      if (streamError) break;
    }
    if (!streamError && buffer.trim()) processLine(buffer);

    if (streamError) {
      return failure(this.id, model, {
        kind: "upstream",
        message: `流式响应中途报错：${redactSecrets((streamError as { message: string }).message)}`,
        retryable: true,
      });
    }

    let toolCalls: ToolCall[] = [];
    if (toolCallAcc.size > 0) {
      const parsed = parseStreamToolCalls(toolCallAcc);
      if (!parsed.ok) {
        return failure(this.id, model, { kind: "parse", message: parsed.message, retryable: false });
      }
      toolCalls = parsed.calls;
    }

    // 拿不到 usage 就如实 usageUnavailable:true（不许填 0 冒充）——与非流式路径
    // 及 openai_compat 的纪律一致。
    const usage: Usage = usageSeen
      ? { inputTokens, outputTokens, costUsd: null }
      : { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true };

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

/**
 * 给主会话接线用的现成实例（默认 `baseUrl: https://api.anthropic.com`）。
 * `router.ts` 的 `ADAPTERS` 里加一行 `anthropic: { adapter: anthropicAdapter,
 * envKey: "ANTHROPIC_API_KEY" }` 即可——接线说明详见 docs/devlog/P11-b.md。
 */
export const anthropicAdapter = new AnthropicAdapter();
