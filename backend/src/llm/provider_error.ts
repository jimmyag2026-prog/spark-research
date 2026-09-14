// 跨 provider 的错误规范化与分类（lane α-2 · USAGE_LOG U1）。
//
// **来源**：分类骨架（规范化的取值顺序、429 优先于上下文溢出这条判据及其原因）移植自
// OpenScience `backend/cli/src/session/retry.ts` 的 `normalizeProviderError` /
// `isContextOverflow`（Apache-2.0）。**只抄机制不抄类型**——上游那份的入参绑死在
// Vercel AI SDK 的 `APIError` 上，这里改成「HTTP 响应体 + 头」与「流内错误帧」两种来源。
//
// **在修什么**：
//   ① `classifyHttpError` 只在 `anthropic.ts` 有一份；`openai_compat.ts` 自己手写了一行
//      三元式（401/403→auth，429→rate_limit，其余→upstream），两份各自演化；
//   ② **流式错误帧从来没人分类**——OpenAI 兼容流里的 `data: {"error": {...}}` 帧在
//      `consumeStream` 里被 `json.choices?.[0]` 读成 undefined 后**静默丢弃**，
//      于是一次上游 502 会变成一个 `ok: true` 的空回答（U1 那条「失败没留痕」的极端形态）；
//   ③ 两个适配器的失败路径都**不读 `response.headers`**，`Retry-After` 白白扔掉；
//      错误体还被截到 200 / 400 字符——一条 OpenRouter 的错误 JSON 通常比这长，
//      截断点常常正好落在 `message` 中间，事后连「上游到底说了什么」都读不全。
//
// 分类判据（顺序本身就是判据，不能重排）：
//   1. 限流最优先。429 / too_many_requests / 文本含 rate limit·quota·overloaded·resource exhausted
//      → `rate_limit`，可重试。**必须排在上下文溢出前面**：限流措辞里常常带着
//      "input token count exceeds..."，按溢出判会把一次**瞬时**限流判成终态的
//      「输入太大」，于是不但不重试，还会去做一次毫无意义的上下文压缩。
//   2. 401 / 403 / authentication_error / permission_error → `auth`，不可重试。
//   3. 上下文/载荷溢出（413、context_length_exceeded、"context window"、"prompt is too long"…）
//      → `unsupported`，**不可重试**（重发同一个请求必然复现）。
//   4. ≥500 / 529 / server_error / internal_error / overloaded_error → `upstream`，可重试。
//   5. 400 → 消息像解析问题的判 `parse`，否则 `unsupported`；都不可重试。
//   6. 其余：`upstream`。**有 statusCode 的不可重试**（上游明确拒绝了）；
//      **没有 statusCode 的可重试**——那是流内错误帧/网关截断这类瞬时形态。

import { llmFailure, redactSecrets } from "./types";
import type { LlmError, LlmErrorKind, LlmResponse } from "./types";

/** 错误体保留长度。**要能装下一整条错误 JSON**——200/400 字符会把 message 截断在半截。 */
export const MAX_ERROR_BODY_CHARS = 4_000;
/** 进 `LlmError.message` 的上限：够读完上游原话，又不至于把一页 HTML 全塞进日志。 */
export const MAX_ERROR_MESSAGE_CHARS = 1_000;

export type HeaderSource = Headers | Record<string, string | undefined> | undefined;

export interface NormalizedProviderError {
  /** 上游 HTTP 状态码；流内错误帧（无状态码）时 undefined。 */
  statusCode?: number;
  /** provider 的错误码，字符串化（OpenRouter 的数字 `error.code` 会被当成 HTTP 类抬进 statusCode）。 */
  code: string;
  /** provider 的错误类型（`error.type` / `metadata.error_type`）。 */
  type: string;
  /** 人读的错误原话（已脱敏、已截断）。 */
  message: string;
  /** `Retry-After` / `retry-after-ms` 解析出的建议重试延迟（毫秒）。 */
  retryAfterMs?: number;
}

function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | undefined>;
  const hit = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return hit ? record[hit] : undefined;
}

/**
 * `Retry-After`（秒，或 HTTP-date）与 `retry-after-ms`（毫秒，OpenAI/Anthropic 都在用）。
 * 解析不出来就返回 undefined——**猜一个数比没有更糟**（会让退避按错的时间表走）。
 */
export function parseRetryAfterMs(headers: HeaderSource): number | undefined {
  const ms = headerValue(headers, "retry-after-ms") ?? headerValue(headers, "x-ratelimit-reset-after-ms");
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  const raw = headerValue(headers, "retry-after");
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function parseJson(source: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(source) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从「HTTP 响应体」或「流内错误帧」提取规范化字段。三种真实形状都要认：
 *   ① `{"error":{"message","type","code"}}`（OpenAI / Anthropic / DeepSeek / Qwen）
 *   ② `{"error":{"code":502,"message":...,"metadata":{"error_type":"provider_unavailable"}}}`
 *      —— OpenRouter 用**数字** `error.code` 放 HTTP 类且不给 statusCode。
 *      这个 5xx 必须保下来：否则一条提到 "context window" 的网关错误会被判成终态溢出。
 *   ③ `{"error":"operation_in_progress"}` —— 裸 token，没有错误对象。
 */
export function normalizeProviderError(input: {
  /** HTTP 状态码；流内错误帧没有就不传。 */
  statusCode?: number;
  /** 原始响应体 / 帧的 JSON 文本。 */
  body?: string;
  /** 拿不到响应体时的兜底文案（例如 fetch 抛出的 Error.message）。 */
  message?: string;
  headers?: HeaderSource;
}): NormalizedProviderError {
  let statusCode = input.statusCode;
  const raw = (input.body ?? input.message ?? "").slice(0, MAX_ERROR_BODY_CHARS);
  let code = "";
  let type = "";
  let message = raw;

  const json = parseJson(raw);
  if (json) {
    const errObj =
      json.error && typeof json.error === "object"
        ? (json.error as Record<string, unknown>)
        : json.detail && typeof json.detail === "object"
          ? (json.detail as Record<string, unknown>)
          : json;
    const metadata = (errObj.metadata ?? json.metadata) as Record<string, unknown> | undefined;
    const nested = Number(
      errObj.statusCode ??
        errObj.status_code ??
        json.statusCode ??
        json.status_code ??
        (typeof errObj.code === "number" ? errObj.code : undefined) ??
        (typeof json.code === "number" ? json.code : undefined),
    );
    if (!statusCode && Number.isFinite(nested)) statusCode = nested;
    // 裸 token 形状：`{"error":"operation_in_progress"}`。
    const token = typeof json.error === "string" && /^[a-z0-9_]+$/.test(json.error) ? json.error : "";
    code = asString(errObj.code) || asString(json.code) || token || "";
    type =
      asString(errObj.type) ||
      asString(json.type) ||
      asString(metadata?.error_type) ||
      "";
    message = asString(errObj.message) || asString(json.message) || (token ? token : raw);
  }

  const retryAfterMs = parseRetryAfterMs(input.headers);
  return {
    ...(statusCode !== undefined && Number.isFinite(statusCode) ? { statusCode } : {}),
    code,
    type,
    message: redactSecrets(message).slice(0, MAX_ERROR_MESSAGE_CHARS),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

const RATELIMIT_CODES = new Set([
  "rate_limit_error",
  "rate_limit_exceeded",
  "too_many_requests",
  "insufficient_quota",
  "quota_exceeded",
  "resource_exhausted",
  "overloaded_error",
  "429",
]);

const RATELIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  "quota",
  "overloaded",
  "resource exhausted",
  "resource_exhausted",
  // 故意不收 "please try again later"：5xx 的官方文案里普遍带这一句，
  // 收了会把一半的 upstream 故障改判成 rate_limit（两者都可重试，但 errorKind 会失真）。
];

const AUTH_CODES = new Set([
  "authentication_error",
  "permission_error",
  "invalid_api_key",
  "unauthorized",
  "permission_denied",
  "account_deactivated",
]);

const OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "string_above_max_length",
  "prompt_too_long",
  "max_tokens_exceeded",
  "request_too_large",
]);

const OVERFLOW_PATTERNS = [
  "context window",
  "context length",
  "maximum context",
  "prompt is too long",
  "input is too long",
  "too many tokens",
  "reduce the length",
  "exceeds the maximum",
  "payload too large",
];

const UPSTREAM_CODES = new Set(["server_error", "internal_error", "internal_server_error", "api_error", "provider_unavailable"]);

const PARSE_PATTERNS = ["json", "malformed", "parse", "invalid schema", "decode"];

/**
 * 规范化结果 → `LlmErrorKind` + 可重试性。判据顺序见文件头，**顺序本身就是判据**。
 */
export function classifyProviderError(normalized: NormalizedProviderError): { kind: LlmErrorKind; retryable: boolean } {
  const status = normalized.statusCode;
  const code = normalized.code.toLowerCase();
  const type = normalized.type.toLowerCase();
  const text = `${code} ${type} ${normalized.message}`.toLowerCase();

  // 1. 限流最优先——必须排在溢出前面（见文件头）。
  if (status === 429 || RATELIMIT_CODES.has(code) || RATELIMIT_CODES.has(type) || RATELIMIT_PATTERNS.some((p) => text.includes(p))) {
    return { kind: "rate_limit", retryable: true };
  }
  // 2. 鉴权。
  if (status === 401 || status === 403 || AUTH_CODES.has(code) || AUTH_CODES.has(type)) {
    return { kind: "auth", retryable: false };
  }
  // 3. 上下文/载荷溢出：确定性失败，重发同一个请求必然复现。
  if (status === 413 || OVERFLOW_CODES.has(code) || OVERFLOW_CODES.has(type) || OVERFLOW_PATTERNS.some((p) => text.includes(p))) {
    return { kind: "unsupported", retryable: false };
  }
  // 4. 上游故障 / 过载。529 是 Anthropic 专用的 overloaded_error 状态码。
  if ((status !== undefined && status >= 500) || UPSTREAM_CODES.has(code) || UPSTREAM_CODES.has(type)) {
    return { kind: "upstream", retryable: true };
  }
  // 5. 400：分不清「我们发错了」与「上游不支持」时，看措辞。两者都不该重试。
  if (status === 400 || status === 422) {
    return { kind: PARSE_PATTERNS.some((p) => text.includes(p)) ? "parse" : "unsupported", retryable: false };
  }
  if (status === 404) return { kind: "unsupported", retryable: false };
  // 6. 兜底：没有状态码的多半是流内错误帧/网关截断这类瞬时形态，留一次重试机会；
  //    有状态码却走到这里的，是上游明确的 4xx 拒绝，重试没有意义。
  return { kind: "upstream", retryable: status === undefined };
}

/** 规范化 + 分类，一步到位。两个适配器的失败路径都走它，不再各写各的。 */
export function toLlmError(normalized: NormalizedProviderError): LlmError {
  const { kind, retryable } = classifyProviderError(normalized);
  const status = normalized.statusCode;
  return {
    kind,
    message: `${status !== undefined ? `HTTP ${status}` : "上游错误"}${normalized.type ? ` [${normalized.type}]` : ""}${
      normalized.message ? `: ${normalized.message}` : ""
    }`,
    retryable,
    ...(status !== undefined ? { statusCode: status } : {}),
    ...(normalized.code ? { code: normalized.code } : {}),
    ...(normalized.type ? { type: normalized.type } : {}),
    ...(normalized.retryAfterMs !== undefined ? { retryAfterMs: normalized.retryAfterMs } : {}),
  };
}

/** 构造带规范化字段的失败响应（AD-13 不变式由 `llmFailure` 保证）。 */
export function providerFailure(provider: string, model: string, normalized: NormalizedProviderError): LlmResponse {
  return llmFailure({ provider, model, ...toLlmError(normalized) });
}

/**
 * 退避延迟：**上游给了时间表就按上游的走**（`Retry-After` / `retry-after-ms`），
 * 否则退回指数退避 + 抖动。V137 的重试循环在 `router.ts`，这里只提供这一个纯函数，
 * 接线走收口 diff（见 `docs/devlog/W9-alpha.md`「收口 diff」）。
 */
export function retryDelayMs(input: {
  error: LlmError;
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter?: number;
}): number {
  if (input.error.retryAfterMs !== undefined && input.error.retryAfterMs >= 0) {
    // 上游说多久就多久，仍受 maxDelayMs 约束——一个 3600s 的 Retry-After 不该让一次
    // 交互式调用挂一小时（那是「失败并告诉用户」的场景，不是「悄悄等」的场景）。
    return Math.min(input.error.retryAfterMs, input.maxDelayMs);
  }
  const exp = Math.min(input.baseDelayMs * 2 ** input.attempt, input.maxDelayMs);
  return exp + (input.jitter ?? Math.random()) * input.baseDelayMs;
}
