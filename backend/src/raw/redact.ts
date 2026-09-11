// v0.7 W7-D0 · 脱敏（AD-2 延伸）：raw 层落盘前的唯一关口。
//
// 规则刻意粗：键名命中就整值替换，不做「看起来像 key 才替换」的聪明事——漏掉一个真 key
// 的代价远大于多替换几个无害字段。请求头一律不记（调用方连传的语法空间都没有，见
// ConnectorPayload 没有 headers 字段）。

const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|credential|cookie|bearer)/i;

export const REDACTED = "<redacted>";

export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** LLM CallOptions 里可能带 env/key 之类的运行期注入，落盘前剥掉。 */
export function redactLlmOptions(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const { env: _env, ...rest } = options as Record<string, unknown>;
  return redact(rest);
}
