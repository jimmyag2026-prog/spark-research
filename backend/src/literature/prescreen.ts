import type { LLMRouter } from "../llm/router";
import { STAGE_MAX_TOKENS } from "./limits";

// α-1（v0.10）：**批量预筛**。V172 残余「④ 只产卡不筛卡」——检索把 6 条查询的命中
// 一股脑塞进精读，真实会话 `web_1789480157513`（T1「recursive self-improvement」）
// 里 8 篇候选有 5 篇跟主题无关（AI in healthcare / AI in Education / AI and Business
// Value / XAI taxonomies / ML in the quantum domain），每篇照样烧一次全文级调用。
//
// 这里用**一次**便宜调用给全部候选打 0–3 分，只留 top-K。纪律：
//   - 一次调用，输出是紧凑的 `[[序号, 分数], …]`，不要模型解释理由（解释＝钱）。
//   - **fail-open**：解析失败/调用失败一律「全留」，绝不因为预筛坏了就把文献丢光。
//     丢文献是静默的正确性损失，慢只是钱——两害相权取其轻。失败原因写进 `note`。
//   - 分数不够 `minScore` 的一律不进综述、不建卡；但若**全部**都不够分，
//     退回按分数取 top-K（不返回空集）。

export const PRESCREEN_SYSTEM_PROMPT = `你是文献相关性筛选器。给定一个研究主题和一批候选论文（编号 + 标题 + 年份 + 摘要片段），为每篇打一个相关性分数。

评分标准：
3 = 直接研究该主题
2 = 相邻主题，能提供有用的对比/背景
1 = 同一个大领域但不回答该主题的问题
0 = 无关

只输出一个 JSON 数组，每项是 [编号, 分数] 两个整数，不要任何解释文字。例如：
[[1,3],[2,0],[3,2]]

纪律：每个候选都必须出现一次；分数只能是 0/1/2/3；不要输出编号以外的任何标识。`;

export interface PrescreenCandidate {
  id: string;
  title: string;
  year: number | null;
  abstract: string | null;
}

export interface PrescreenOptions {
  topic: string;
  /** 最多留几篇（默认 8）。 */
  topK?: number;
  /** 低于这个分的不留（默认 2）。 */
  minScore?: number;
  /**
   * 候选数 ≤ 这个值时不值得为预筛花一次调用（默认 3）。
   * **不能默认成 topK**：预筛的价值是「剔无关」，不是「截断到 K 篇」——真实会话
   * `web_1789480157513` 正好 8 篇候选、topK 也是 8，若按 topK 跳过，5 篇无关文献会
   * 原样进综述，预筛等于没装（这条是本 lane 第一次跑门禁时实际踩到的）。
   */
  skipBelow?: number;
  model?: string;
  sessionId?: string | null;
}

export interface PrescreenResult {
  /** 保留下来的候选（按分数降序，稳定：同分保持原顺序）。 */
  kept: PrescreenCandidate[];
  /** 被剔除的候选（同样按分数降序）。 */
  dropped: PrescreenCandidate[];
  scores: Map<string, number>;
  /** 真实发出的 LLM 调用数（0 = 跳过或未启用）。 */
  llmCalls: number;
  /** 人读的一行说明，进 digest / devlog。 */
  note: string;
  /** true = 因为失败或跳过而「全留」，此时 dropped 必为空。 */
  failOpen: boolean;
}

/** 摘要截断长度：预筛只需要判断「是不是这个主题」，不需要读完。 */
const ABSTRACT_CHARS = 320;

export function buildPrescreenPrompt(topic: string, candidates: PrescreenCandidate[]): string {
  const lines = candidates.map((c, i) => {
    const abs = (c.abstract ?? "").replace(/\s+/g, " ").trim().slice(0, ABSTRACT_CHARS);
    return `${i + 1}. ${c.title}${c.year ? ` (${c.year})` : ""}\n   ${abs || "（库内无摘要，只能按标题判断）"}`;
  });
  return [`研究主题：${topic.trim() || "（未给主题，按候选集合的共同主题判断）"}`, "", `候选（共 ${candidates.length} 篇）：`, ...lines].join("\n");
}

/**
 * 解析 `[[1,3],[2,0]]`。宽松到能吃掉 ```json 围栏与前后解释文字，但**不做字段级修补**：
 * 缺编号、分数越界、编号越界都算解析失败 → 调用方 fail-open。
 */
export function parsePrescreenScores(raw: string, count: number): Map<number, number> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const candidate of [fenced?.[1], raw]) {
    if (typeof candidate !== "string") continue;
    const start = candidate.indexOf("[");
    const end = candidate.lastIndexOf("]");
    if (start === -1 || end <= start) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const out = new Map<number, number>();
    let bad = false;
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length < 2) { bad = true; break; }
      const idx = Number(row[0]);
      const score = Number(row[1]);
      if (!Number.isInteger(idx) || idx < 1 || idx > count) { bad = true; break; }
      if (!Number.isInteger(score) || score < 0 || score > 3) { bad = true; break; }
      out.set(idx, score);
    }
    if (bad || out.size === 0) continue;
    return out;
  }
  return null;
}

export async function prescreenCandidates(
  deps: { llm: Pick<LLMRouter, "call"> },
  candidates: PrescreenCandidate[],
  options: PrescreenOptions,
): Promise<PrescreenResult> {
  const topK = options.topK ?? 8;
  const minScore = options.minScore ?? 2;
  const skipBelow = options.skipBelow ?? 3;
  const allScores = new Map<string, number>();
  const keepAll = (note: string, llmCalls: number): PrescreenResult => ({
    kept: candidates.slice(0, Math.max(topK, candidates.length)),
    dropped: [],
    scores: allScores,
    llmCalls,
    note,
    failOpen: true,
  });

  if (candidates.length === 0) return { kept: [], dropped: [], scores: allScores, llmCalls: 0, note: "预筛：无候选", failOpen: false };
  if (candidates.length <= skipBelow) {
    return keepAll(`预筛：候选 ${candidates.length} 篇 ≤ ${skipBelow}，不值得多花一次调用，全留`, 0);
  }

  const messages = [
    { role: "system" as const, content: PRESCREEN_SYSTEM_PROMPT },
    { role: "user" as const, content: buildPrescreenPrompt(options.topic, candidates) },
  ];
  const response = await deps.llm.call(messages, {
    ...(options.model ? { model: options.model } : {}),
    maxTokens: STAGE_MAX_TOKENS.prescreen,
  });
  if (!response.ok) {
    return keepAll(`预筛：调用失败（${response.error?.message?.slice(0, 80) ?? "未知"}）→ 全留（fail-open）`, 1);
  }
  const parsed = parsePrescreenScores(response.content, candidates.length);
  if (!parsed) {
    return keepAll(`预筛：输出无法解析（截断 80 字：${response.content.slice(0, 80).replace(/\s+/g, " ")}）→ 全留（fail-open）`, 1);
  }

  // 没被打分的候选按 minScore 处理——模型漏了一篇不该成为「悄悄丢掉它」的理由。
  const scored = candidates.map((c, i) => ({ c, score: parsed.get(i + 1) ?? minScore, i }));
  for (const s of scored) allScores.set(s.c.id, s.score);
  const byScore = [...scored].sort((a, b) => b.score - a.score || a.i - b.i);
  let keptRows = byScore.filter((s) => s.score >= minScore).slice(0, topK);
  let note: string;
  if (keptRows.length === 0) {
    // 全员低分：可能是主题串了、也可能是模型太苛刻。退回 top-K，别把库清空。
    keptRows = byScore.slice(0, topK);
    note = `预筛：无人达到 ${minScore} 分（可能主题不匹配），退回按分数取前 ${keptRows.length} 篇`;
  } else {
    note = `预筛：${candidates.length} 篇 → 留 ${keptRows.length} 篇（阈值 ${minScore} 分，上限 ${topK}）`;
  }
  const keptIds = new Set(keptRows.map((s) => s.c.id));
  return {
    kept: keptRows.map((s) => s.c),
    dropped: byScore.filter((s) => !keptIds.has(s.c.id)).map((s) => s.c),
    scores: allScores,
    llmCalls: 1,
    note,
    failOpen: false,
  };
}
