import type { ResearchRecord } from "../project/models";
import type { Severity } from "../reviewer/rules";

// 结论卡（DESIGN 域 E2）：claim + 证据列表（record 链接）+ limitations + confidence + review 状态。
//
// P5/P6 只落了最小形态（`metadata.review = "pending"` 一个字符串），P8 把它补成完整结构：
// review 从「一个字符串」变成「一次可审计的评审」——谁在什么时候、依据哪些 finding 做的判定。
// 旧形态照样读得出来（`parseConclusionCard` 对两种形态都兼容），不需要数据迁移。

export const CONCLUSION_CARD_KIND = "conclusion_card";

export const CONCLUSION_REVIEW_STATES = ["pending", "approved", "vetoed"] as const;
export type ConclusionReviewState = (typeof CONCLUSION_REVIEW_STATES)[number];

export function isConclusionReviewState(value: unknown): value is ConclusionReviewState {
  return typeof value === "string" && (CONCLUSION_REVIEW_STATES as readonly string[]).includes(value);
}

// 结论卡的来源模式：干实验 / 湿实验 / 手工登记。
export type ConclusionMode = "dry" | "wet" | "manual";

// 一条 finding 的可持久化摘要（存进 record metadata，供 CLI/报告/前端复读）。
// 与 `Finding` 的区别：这里不带 artifactId（结论卡不是 artifact），且一定带 rule。
export interface ConclusionFindingStamp {
  rule: string;
  severity: Severity;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ConclusionReviewStamp {
  state: ConclusionReviewState;
  at: string | null;
  actor: string | null;
  // 与 AD-6 同一套口径：explicit / env:SPARK_ACTOR / env:USER / http:explicit / checker。
  actorSource: string | null;
  hardCount: number;
  softCount: number;
  findings: ConclusionFindingStamp[];
  // 人工否决时的理由（自动否决为 null——理由就是 findings 本身）。
  reason: string | null;
  decisionRecordId: string | null;
}

export const PENDING_REVIEW: ConclusionReviewStamp = {
  state: "pending",
  at: null,
  actor: null,
  actorSource: null,
  hardCount: 0,
  softCount: 0,
  findings: [],
  reason: null,
  decisionRecordId: null,
};

export interface ConclusionCard {
  recordId: string;
  project: string;
  title: string;
  claim: string;
  limitations: string | null;
  confidence: string | null;
  mode: ConclusionMode;
  experimentId: string | null;
  // 证据（observation record id）。P5/P6 的单个 observationId 在这里被规范成数组。
  evidenceIds: string[];
  review: ConclusionReviewStamp;
  createdAt: string;
  record: ResearchRecord;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseFindings(raw: unknown): ConclusionFindingStamp[] {
  if (!Array.isArray(raw)) return [];
  const out: ConclusionFindingStamp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (typeof f.rule !== "string" || typeof f.message !== "string") continue;
    if (f.severity !== "hard" && f.severity !== "soft") continue;
    out.push({
      rule: f.rule,
      severity: f.severity,
      message: f.message,
      ...(f.detail && typeof f.detail === "object" ? { detail: f.detail as Record<string, unknown> } : {}),
    });
  }
  return out;
}

// review 字段有两种历史形态：
//   P5/P6： "pending"（裸字符串）
//   P8：    { state, at, actor, findings, ... }
// 两种都要读得出来；读不出来的一律落回 pending——**不给自己发通过证**，
// 一个解析不了的 review 字段绝不能被当成 approved。
export function parseReviewStamp(raw: unknown): ConclusionReviewStamp {
  if (isConclusionReviewState(raw)) return { ...PENDING_REVIEW, state: raw };
  if (!raw || typeof raw !== "object") return { ...PENDING_REVIEW };
  const r = raw as Record<string, unknown>;
  const state = isConclusionReviewState(r.state) ? r.state : "pending";
  const findings = parseFindings(r.findings);
  return {
    state,
    at: stringOrNull(r.at),
    actor: stringOrNull(r.actor),
    actorSource: stringOrNull(r.actorSource),
    hardCount: typeof r.hardCount === "number" ? r.hardCount : findings.filter((f) => f.severity === "hard").length,
    softCount: typeof r.softCount === "number" ? r.softCount : findings.filter((f) => f.severity === "soft").length,
    findings,
    reason: stringOrNull(r.reason),
    decisionRecordId: stringOrNull(r.decisionRecordId),
  };
}

function parseEvidenceIds(meta: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const list = meta.evidenceIds;
  if (Array.isArray(list)) {
    for (const item of list) if (typeof item === "string" && item.trim()) ids.push(item);
  }
  // P5/P6 的单证据形态。
  if (typeof meta.observationId === "string" && meta.observationId.trim()) ids.push(meta.observationId);
  return [...new Set(ids)];
}

function parseMode(meta: Record<string, unknown>): ConclusionMode {
  if (meta.mode === "wet" || meta.mode === "dry" || meta.mode === "manual") return meta.mode;
  // P5 的干实验结论卡没写 mode（湿的写了）；有 experimentId 就当干实验，否则手工。
  return typeof meta.experimentId === "string" && meta.experimentId ? "dry" : "manual";
}

// record → 结论卡。不是 conclusion_card 的 conclusion record 返回 null
//（宁可少认一张卡，也不要把别的东西当成结论去评审）。
export function parseConclusionCard(record: ResearchRecord): ConclusionCard | null {
  if (record.type !== "conclusion") return null;
  const meta = record.metadata as Record<string, unknown>;
  if (meta.kind !== CONCLUSION_CARD_KIND) return null;
  const claim = typeof meta.claim === "string" && meta.claim.trim() ? meta.claim : record.content;
  if (!claim.trim()) return null;
  return {
    recordId: record.id,
    project: record.project,
    title: record.title,
    claim,
    limitations: stringOrNull(meta.limitations),
    confidence: stringOrNull(meta.confidence),
    mode: parseMode(meta),
    experimentId: stringOrNull(meta.experimentId),
    evidenceIds: parseEvidenceIds(meta),
    review: parseReviewStamp(meta.review),
    createdAt: record.createdAt,
    record,
  };
}

const STATE_LABEL: Record<ConclusionReviewState, string> = {
  pending: "待评审（pending）",
  approved: "已通过（approved）",
  vetoed: "已否决（vetoed）",
};

export function reviewStateLabel(state: ConclusionReviewState): string {
  return STATE_LABEL[state];
}

// 结论卡正文由代码渲染（与 experiment/novelty 报告同一条纪律）：
// review 状态、证据 id、finding 清单都是确定的事实，不交给模型写。
export function renderConclusionCard(
  card: Omit<ConclusionCard, "record" | "recordId"> & { recordId: string },
): string {
  const lines: string[] = [];
  lines.push(`# 结论 · ${card.title}`);
  lines.push("");
  lines.push(`- record: \`${card.recordId}\``);
  lines.push(`- review: **${reviewStateLabel(card.review.state)}**`);
  if (card.review.at) {
    lines.push(
      `- 评审：${card.review.actor ?? "(未记名)"}${card.review.actorSource ? `（${card.review.actorSource}）` : ""} · ${card.review.at}`,
    );
  }
  if (card.confidence) lines.push(`- confidence: ${card.confidence}`);
  if (card.experimentId) lines.push(`- 实验：\`${card.experimentId}\`（${card.mode}）`);
  lines.push("");
  lines.push("## 主张（claim）");
  lines.push("");
  lines.push(card.claim);
  lines.push("");
  lines.push("## 证据");
  lines.push("");
  if (card.evidenceIds.length === 0) {
    lines.push("- （无）—— 没有证据的结论进不了报告结论区");
  } else {
    for (const id of card.evidenceIds) lines.push(`- observation \`${id}\``);
  }
  lines.push("");
  lines.push("## 局限（limitations）");
  lines.push("");
  lines.push(card.limitations ?? "（未填写）");
  if (card.review.findings.length > 0) {
    lines.push("");
    lines.push("## 最近一次评审的 finding");
    lines.push("");
    for (const f of card.review.findings) {
      lines.push(`- **${f.severity}** \`${f.rule}\` — ${f.message}`);
    }
  }
  if (card.review.reason) {
    lines.push("");
    lines.push(`## 人工否决理由`);
    lines.push("");
    lines.push(card.review.reason);
  }
  return lines.join("\n");
}
