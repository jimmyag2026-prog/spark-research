// 文献 API 的「礼貌头」配置（OpenAlex / CrossRef 的 polite pool、Semantic Scholar 的 UA 约定）。
//
// 纪律：**不硬编码任何个人信息**。默认值是占位符，用户通过环境变量
// SPARK_RESEARCH_CONTACT_EMAIL 配置自己的邮箱；未配置时用占位邮箱，
// 请求依然能走（只是进不了 polite pool），并在 connector 元数据里提示。

export const CONTACT_EMAIL_ENV = "SPARK_RESEARCH_CONTACT_EMAIL";
export const USER_AGENT_ENV = "SPARK_RESEARCH_USER_AGENT";

export const PLACEHOLDER_CONTACT_EMAIL = "spark-research@example.invalid";
export const PROJECT_URL = "https://github.com/jimmyag2026-prog/spark-research";
export const CLIENT_VERSION = "0.2";

export function contactEmail(env: Record<string, string | undefined> = process.env): string {
  const raw = env[CONTACT_EMAIL_ENV]?.trim();
  return raw && raw.includes("@") ? raw : PLACEHOLDER_CONTACT_EMAIL;
}

export function isContactEmailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return contactEmail(env) !== PLACEHOLDER_CONTACT_EMAIL;
}

export function userAgent(env: Record<string, string | undefined> = process.env): string {
  const raw = env[USER_AGENT_ENV]?.trim();
  if (raw) return raw;
  return `spark-research/${CLIENT_VERSION} (${PROJECT_URL}; mailto:${contactEmail(env)})`;
}

export function politeHeaders(options: { contactEmail?: string; userAgent?: string } = {}): Record<string, string> {
  return {
    "User-Agent": options.userAgent ?? userAgent(),
    From: options.contactEmail ?? contactEmail(),
  };
}
