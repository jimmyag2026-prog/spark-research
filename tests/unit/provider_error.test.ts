import { describe, expect, test } from "bun:test";
import {
  classifyProviderError,
  MAX_ERROR_BODY_CHARS,
  normalizeProviderError,
  parseRetryAfterMs,
  providerFailure,
  retryDelayMs,
  toLlmError,
} from "../../backend/src/llm/provider_error";

// lane α-2（USAGE_LOG U1）：跨 provider 的错误规范化与分类。
// 每种真实错误体形状一条用例；判据顺序（限流优先于上下文溢出）单独一条。

function classify(input: Parameters<typeof normalizeProviderError>[0]) {
  return classifyProviderError(normalizeProviderError(input));
}

describe("α-2 · normalizeProviderError：三种真实形状都要认", () => {
  test("① OpenAI / Anthropic 形状：{\"error\":{\"message\",\"type\",\"code\"}}", () => {
    const n = normalizeProviderError({
      statusCode: 400,
      body: JSON.stringify({
        error: { message: "This model's maximum context length is 128000 tokens", type: "invalid_request_error", code: "context_length_exceeded" },
      }),
    });
    expect(n.statusCode).toBe(400);
    expect(n.code).toBe("context_length_exceeded");
    expect(n.type).toBe("invalid_request_error");
    expect(n.message).toContain("maximum context length");
  });

  test("② OpenRouter 形状：数字 error.code 当 HTTP 类 + metadata.error_type，且没有 statusCode", () => {
    const n = normalizeProviderError({
      body: JSON.stringify({
        error: { code: 502, message: "Provider returned error", metadata: { error_type: "provider_unavailable" } },
      }),
    });
    // 这个 5xx 必须保下来：丢了它，一条提到 "context window" 的网关错误就会被判成终态溢出。
    expect(n.statusCode).toBe(502);
    expect(n.type).toBe("provider_unavailable");
    expect(classifyProviderError(n)).toEqual({ kind: "upstream", retryable: true });
  });

  test("③ 裸 token 形状：{\"error\":\"operation_in_progress\"}", () => {
    const n = normalizeProviderError({ body: JSON.stringify({ error: "operation_in_progress" }) });
    expect(n.code).toBe("operation_in_progress");
    expect(n.message).toBe("operation_in_progress");
  });

  test("非 JSON 响应体（网关的 HTML / 纯文本）原样保留为 message", () => {
    const n = normalizeProviderError({ statusCode: 502, body: "<html><body>502 Bad Gateway</body></html>" });
    expect(n.code).toBe("");
    expect(n.message).toContain("502 Bad Gateway");
    expect(classifyProviderError(n).kind).toBe("upstream");
  });

  test("错误体截断放宽到能装下完整错误 JSON（原来是 200 / 400 字符）", () => {
    const long = "x".repeat(1_500);
    const n = normalizeProviderError({
      statusCode: 400,
      body: JSON.stringify({ error: { message: long, type: "invalid_request_error" } }),
    });
    expect(MAX_ERROR_BODY_CHARS).toBeGreaterThanOrEqual(1_000);
    // 原来 200 字符的截断会把这条 message 砍在半截（连 JSON 都解析不出来）。
    expect(n.message.length).toBeGreaterThan(900);
    expect(n.type).toBe("invalid_request_error");
  });

  test("脱敏：错误体回显了鉴权头也不会进 message", () => {
    const n = normalizeProviderError({
      statusCode: 401,
      body: JSON.stringify({ error: { message: "bad key: sk-abcdefghijklmnopqrstuvwxyz012345", type: "authentication_error" } }),
    });
    expect(n.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(n.message).toContain("[redacted]");
  });
});

describe("α-2 · classifyProviderError：判据顺序就是判据", () => {
  test("429 → rate_limit 可重试", () => {
    expect(classify({ statusCode: 429, body: "{}" })).toEqual({ kind: "rate_limit", retryable: true });
  });

  test("**含 'input token count' 的 429 → rate_limit，不是 unsupported**", () => {
    // 真实形状：限流错误的措辞里带着 token 计数，按上下文溢出判会把一次**瞬时**限流
    // 判成终态「输入太大」——既不重试，还会去做一次毫无意义的上下文压缩。
    const body = JSON.stringify({
      error: {
        type: "rate_limit_error",
        message: "This request would exceed your organization's rate limit: input token count exceeds the maximum allowed per minute",
      },
    });
    expect(classify({ statusCode: 429, body })).toEqual({ kind: "rate_limit", retryable: true });
    // 同一段措辞、没有 429 时，才轮到溢出判据。
    expect(classify({ statusCode: 400, body: JSON.stringify({ error: { message: "input token count exceeds the maximum" } }) })).toEqual({
      kind: "unsupported",
      retryable: false,
    });
  });

  test("无 statusCode 的流内限流帧（quota / overloaded）仍判 rate_limit", () => {
    expect(classify({ body: JSON.stringify({ error: { message: "You exceeded your current quota" } }) })).toEqual({
      kind: "rate_limit",
      retryable: true,
    });
    expect(classify({ body: JSON.stringify({ error: { type: "overloaded_error" } }) })).toEqual({
      kind: "rate_limit",
      retryable: true,
    });
  });

  test("401 / 403 → auth 不可重试", () => {
    expect(classify({ statusCode: 401, body: "{}" })).toEqual({ kind: "auth", retryable: false });
    expect(classify({ statusCode: 403, body: "{}" })).toEqual({ kind: "auth", retryable: false });
    expect(classify({ body: JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }) })).toEqual({
      kind: "auth",
      retryable: false,
    });
  });

  test("上下文 / 载荷溢出 → unsupported 不可重试", () => {
    expect(classify({ statusCode: 400, body: JSON.stringify({ error: { code: "context_length_exceeded" } }) })).toEqual({
      kind: "unsupported",
      retryable: false,
    });
    // 413：网关按字节拒绝，连模型都没看到。仍是确定性失败。
    expect(classify({ statusCode: 413, body: "Payload Too Large" })).toEqual({ kind: "unsupported", retryable: false });
    expect(classify({ body: JSON.stringify({ error: { message: "prompt is too long: 210000 tokens > 200000 maximum" } }) })).toEqual({
      kind: "unsupported",
      retryable: false,
    });
  });

  test("≥500 / server_error → upstream 可重试；529 overloaded 归 rate_limit（措辞优先）", () => {
    expect(classify({ statusCode: 500, body: "{}" })).toEqual({ kind: "upstream", retryable: true });
    expect(classify({ body: JSON.stringify({ error: { type: "server_error", message: "boom" } }) })).toEqual({
      kind: "upstream",
      retryable: true,
    });
    // 与 anthropic.ts 原 classifyHttpError 的差异，如实记在 devlog：529/overloaded_error
    // 以前判 upstream，现在按判据顺序归 rate_limit。两者都可重试，差别只在 errorKind 的归类。
    expect(classify({ statusCode: 529, body: JSON.stringify({ error: { type: "overloaded_error" } }) })).toEqual({
      kind: "rate_limit",
      retryable: true,
    });
  });

  test("400 非溢出：措辞像解析问题判 parse，否则 unsupported；都不可重试", () => {
    expect(classify({ statusCode: 400, body: JSON.stringify({ error: { message: "Invalid JSON payload" } }) })).toEqual({
      kind: "parse",
      retryable: false,
    });
    expect(classify({ statusCode: 400, body: JSON.stringify({ error: { message: "tools are not supported for this model" } }) })).toEqual({
      kind: "unsupported",
      retryable: false,
    });
  });

  test("兜底：有状态码的未知 4xx 不重试，没有状态码的（流内帧）留一次机会", () => {
    expect(classify({ statusCode: 409, body: "{}" })).toEqual({ kind: "upstream", retryable: false });
    expect(classify({ body: "connection reset by peer" })).toEqual({ kind: "upstream", retryable: true });
  });
});

describe("α-2 · Retry-After 解析与退避时间表", () => {
  test("Retry-After（秒）/ retry-after-ms（毫秒）都要认", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2_000);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1_500);
    expect(parseRetryAfterMs({ "Retry-After": "3" })).toBe(3_000);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "不是数字也不是日期" }))).toBeUndefined();
  });

  test("规范化结果把 retryAfterMs 带进 LlmError", () => {
    const err = toLlmError(
      normalizeProviderError({ statusCode: 429, body: "{}", headers: new Headers({ "retry-after": "7" }) }),
    );
    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(7_000);
    expect(err.statusCode).toBe(429);
  });

  test("退避：上游给了时间表就按上游走（仍受 maxDelayMs 约束），没给才指数退避", () => {
    const withHeader = retryDelayMs({
      error: { kind: "rate_limit", message: "", retryable: true, retryAfterMs: 2_500 },
      attempt: 0,
      baseDelayMs: 200,
      maxDelayMs: 4_000,
      jitter: 0,
    });
    expect(withHeader).toBe(2_500);
    // 一个 1 小时的 Retry-After 不该让一次交互式调用挂一小时。
    expect(
      retryDelayMs({
        error: { kind: "rate_limit", message: "", retryable: true, retryAfterMs: 3_600_000 },
        attempt: 0,
        baseDelayMs: 200,
        maxDelayMs: 4_000,
        jitter: 0,
      }),
    ).toBe(4_000);
    expect(
      retryDelayMs({ error: { kind: "upstream", message: "", retryable: true }, attempt: 2, baseDelayMs: 200, maxDelayMs: 4_000, jitter: 0 }),
    ).toBe(800);
  });
});

describe("α-2 · providerFailure：AD-13 不变式 + 规范化字段落到 LlmError", () => {
  test("失败响应 content 恒空，error 带 statusCode / code / type", () => {
    const res = providerFailure(
      "openrouter",
      "z-ai/glm-5.3-flash",
      normalizeProviderError({
        statusCode: 429,
        body: JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error", code: "rate_limit_exceeded" } }),
        headers: new Headers({ "retry-after-ms": "900" }),
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.content).toBe("");
    expect(res.error.kind).toBe("rate_limit");
    expect(res.error.retryable).toBe(true);
    expect(res.error.statusCode).toBe(429);
    expect(res.error.code).toBe("rate_limit_exceeded");
    expect(res.error.type).toBe("rate_limit_error");
    expect(res.error.retryAfterMs).toBe(900);
    expect(res.error.message).toContain("HTTP 429");
  });
});
