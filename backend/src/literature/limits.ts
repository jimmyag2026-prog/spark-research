// α-3（v0.10）：各阶段输出 token 上限的**单一真源**。
//
// 为什么需要它：v0.9 全链路一处 `maxTokens` 都没传——OpenAI 兼容侧不带 `max_tokens`
// 字段，上游爱写多长写多长；R6 基线里一句话 chat 4 次调用吐 8590 输出 token，78% 的
// 墙钟就是在等这些字。每个阶段的产物形状是已知的（plan 是紧凑 JSON、精读卡是五字段
// JSON、综述是一页 Markdown），给上限不会削掉有用内容，只削掉模型的自我陈述。
//
// 数字来自 `docs/DEVELOPMENT_PLAN_v0.10.md` §三 α-3（定稿 v1），不是我拍的。
// plan / analysis / summarize 三档在 `agents/orchestrator.ts`（收口专属文件）消费，
// 表放在这里是为了让收口那一侧改 ≤10 行就能接上，不必再抄一份数字。
export const STAGE_MAX_TOKENS = {
  /** 规划：紧凑 JSON。解析失败重试一次更小提示，**不退默认计划**（U29 的教训）。 */
  plan: 600,
  /** 单步分析。 */
  analysis: 900,
  /** 收尾汇总。 */
  summarize: 1200,
  /** 精读卡：五字段 JSON。 */
  card: 700,
  /** 综述草稿：一页 Markdown。 */
  review: 2500,
  /** α-1 批量预筛：输出只有 `[[i,s],…]`，几十个 token 就够。 */
  prescreen: 300,
} as const;

export type LlmStage = keyof typeof STAGE_MAX_TOKENS;

// α-2（v0.10）：S3 精读并行度的默认值。W10-0 实测 3 路并发 × 20 次打
// deepseek-v4-flash 与 openrouter/z-ai/glm-5.3-flash 各 0 次 429
// （见 docs/devlog/W10-0-baseline.md），故默认 3；**没有实测就不许调大**。
export const DEFAULT_READ_CONCURRENCY = 3;

/** 并发度归一：非法值（NaN / ≤0 / 非整数）一律退回默认值，不抛错。 */
export function normalizeConcurrency(raw: number | undefined, fallback = DEFAULT_READ_CONCURRENCY): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  return n >= 1 ? n : fallback;
}
