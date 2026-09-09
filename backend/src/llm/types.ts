// LLM Runtime v2 的类型面（P11 接口先行）。
//
// 这一层是 v0.4 三条主线的共同地基：tool calling（P12 的 ToolBus 与真子代理）、
// 流式（P14 的 SSE token 流）、usage 记账（P13 的帧级账本）、JSON 模式（BACKLOG V12）
// 用的是同一个抽象。分头做四遍适配层是本阶段最容易犯的错，所以先把类型钉死。

/** 一次对话里的消息。相对 v1 新增 `tool` 角色与 assistant 的 toolCalls。 */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** 给模型看的工具定义。inputSchema 是 JSON Schema，与 MCP 工具同源（P12 不另写一份）。 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 模型要求调用的一次工具。 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** 拿不到单价或上游不报 usage 时为 null。**绝不填 0 冒充免费**（诚实记录）。 */
  costUsd: number | null;
  /** 上游没报 usage 时为 true——让下游能区分「免费」与「不知道」。 */
  usageUnavailable?: boolean;
}

export type LlmErrorKind = "auth" | "rate_limit" | "timeout" | "parse" | "upstream" | "unsupported";

export interface LlmError {
  kind: LlmErrorKind;
  message: string;
  /** 只有幂等且可能自愈的失败才是 true（限流 / 超时 / 5xx）。 */
  retryable: boolean;
}

interface LlmResponseBase {
  provider: string;
  model: string;
  /** 模型要求的工具调用。非 tool loop 场景恒为空数组。 */
  toolCalls: ToolCall[];
  usage: Usage;
  /** 上游给的结束原因（"stop" / "length" / "tool_calls" / …）。拿不到就是 undefined。 */
  finishReason?: string;
}

/**
 * **AD-13 做成可辨识联合，而不是靠约定。**
 *
 * 根治的是评审 F-2：orchestrator 曾把 router 的错误文本
 * （"[error] No API key configured..."）当成模型产出，review 照样放行。
 * P10 的 D-4 在四个调用点加了 `if (!res.ok)`——那是四道各自可能被忘记的防线。
 *
 * 这里更进一步：`ok: false` 分支的 `content` 类型是**字面量 `""`**，
 * 且 `error` 是**必填**。于是这两件事在编译期就不可能：
 *   - 构造一个「失败但带内容」的响应（内容会被误当产出）
 *   - 构造一个「失败但没说为什么」的响应（诊断信息凭空消失）
 *
 * 迁移提示：`ok === false` 时想拿原因，读 `error.message`，不要读 `content`。
 */
export type LlmResponse =
  | (LlmResponseBase & { ok: true; content: string; error?: undefined })
  | (LlmResponseBase & { ok: false; content: ""; error: LlmError });

/**
 * provider 的能力位。**随 `capabilities --json` 透出**——外部 agent 与 ToolBus
 * 在选模型**之前**就要知道能不能跑 tool loop，而不是跑到一半才发现。
 *
 * P12 的 ToolBus 遇到 `toolCalling: false` 必须走**显式降级**（JSON 计划 + 逐步执行）
 * 并如实告知，不许静默失败——降级路径有独立 e2e（见 v0.4 方案 §6.2）。
 */
export interface ProviderCapabilities {
  toolCalling: boolean;
  jsonMode: boolean;
  streaming: boolean;
  /** 上游是否在响应里回报 token 用量。false 时 Usage.usageUnavailable 会是 true。 */
  usageReported: boolean;
}

export interface CallOptions {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | { name: string };
  /** BACKLOG V12 的根治：不再靠「解析失败重试一次」治标。 */
  responseFormat?: "text" | "json_object";
  timeoutMs?: number;
  /** 仅对 `retryable` 的失败生效。 */
  maxRetries?: number;
  signal?: AbortSignal;
  /** 传了就走流式；每个增量片段回调一次。P14 的 SSE token 流接这里。 */
  onDelta?: (chunk: string) => void;
}

/** 错误消息里绝不能出现凭据。构造 LlmError 时统一走这里做一次兜底。 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g, "[redacted]")
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*)("?)[^"'\s,}]{6,}\2/gi, "$1[redacted]");
}

/**
 * 构造一个成功响应。生产 adapter 与测试假实现共用，省得每处手写 `toolCalls: []` /
 * `usage: {...}`——手写会让「新增一个必填字段」变成几十处散落的编译错误，
 * 而那正是 v1 那个无人消费的 `mock` 字段能一直赖着不走的原因。
 */
export function llmText(
  args: { provider: string; model: string; content: string; finishReason?: string; usage?: Partial<Usage> },
): LlmResponse {
  return {
    ok: true,
    provider: args.provider,
    model: args.model,
    content: args.content,
    toolCalls: [],
    usage: {
      inputTokens: args.usage?.inputTokens ?? 0,
      outputTokens: args.usage?.outputTokens ?? 0,
      costUsd: args.usage?.costUsd ?? null,
      usageUnavailable: args.usage?.usageUnavailable ?? true,
    },
    ...(args.finishReason ? { finishReason: args.finishReason } : {}),
  };
}

/** 构造一个失败响应。**保证 AD-13 的不变式**（content 恒空，错误只在 error）。 */
export function llmFailure(
  args: { provider: string; model: string; kind: LlmErrorKind; message: string; retryable?: boolean },
): LlmResponse {
  return {
    ok: false,
    provider: args.provider,
    model: args.model,
    content: "",
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true },
    error: { kind: args.kind, message: args.message, retryable: args.retryable ?? false },
  };
}

/**
 * 补齐 LlmResponse 的必填字段（`toolCalls` / `usage`）。
 * 给测试里手写响应字面量用——比每处重复六行字段可读，也让「以后再加必填字段」
 * 只需要改这一处，而不是又一次散落几十处编译错误。
 */
export function llmExtras(): Pick<LlmResponse, "toolCalls" | "usage"> {
  return {
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true },
  };
}
