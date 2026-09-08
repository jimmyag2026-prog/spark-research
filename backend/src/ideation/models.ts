// 思路库的数据模型（DESIGN 域 A4「Co-explore」+ 域 D2「与思路库联动」）。
//
// Idea 卡 = 假设陈述 + 支持文献 + 反对文献 + 待验证点 + novelty 状态。
// 落成 `idea` record（P1 的 8 类之一，不新增类型），支持/反对文献用 supports/contradicts 边
// 连到库内论文的 `paper` record。

export const NOVELTY_STATUSES = [
  "unchecked",
  "checked-novel",
  "checked-incremental",
  "checked-overlap",
] as const;
export type NoveltyStatus = (typeof NOVELTY_STATUSES)[number];

// 单条 claim 的评级（DESIGN 域 D1 第 3 步）。
export const NOVELTY_RATINGS = ["novel", "incremental", "existing"] as const;
export type NoveltyRating = (typeof NOVELTY_RATINGS)[number];

export const IDEA_CARD_KIND = "idea_card";
export const NOVELTY_REPORT_KIND = "novelty_report";

// 一条证据：要么锚在库内论文的 bibtex key 上，要么显式标成推断（key=null）。
// 「或显式标注 inferred」是设计里的原话——但推断必须**显式**，不能靠留空蒙混。
export interface IdeaEvidence {
  key: string | null;
  note: string;
  inferred: boolean;
}

export interface IdeaCard {
  hypothesis: string;
  // Co-explore 的批判性讨论正文（苏格拉底式反问 + 带来源的观点）。
  critique: string;
  supporting: IdeaEvidence[];
  contradicting: IdeaEvidence[];
  openQuestions: string[];
}

export interface StoredIdeaCard extends IdeaCard {
  recordId: string;
  createdAt: string;
  model: string | null;
  noveltyStatus: NoveltyStatus;
  // 最近一次 novelty check 的报告 record（未查过时为 null）。
  noveltyReportRecordId: string | null;
  checkedAt: string | null;
}

// ── 评级 → 思路库状态 ───────────────────────────────────────────────────────
//
// 取最保守的一条：只要有一条 claim 已被做过，整个 idea 就是 overlap；
// 全部 novel 才算 checked-novel。宁可低估新颖性，也不给用户虚假的安心。
export function statusFromRatings(ratings: NoveltyRating[]): NoveltyStatus {
  if (ratings.length === 0) return "unchecked";
  if (ratings.includes("existing")) return "checked-overlap";
  if (ratings.includes("incremental")) return "checked-incremental";
  return "checked-novel";
}

// ── schema 校验 ─────────────────────────────────────────────────────────────

export interface IdeaCardValidation {
  ok: boolean;
  errors: string[];
  fields?: IdeaCard;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export interface EvidenceValidation {
  ok: boolean;
  errors: string[];
  items: IdeaEvidence[];
}

// 证据数组校验：每条要么给库内 key，要么 inferred=true。
// 越界 key（不在库内）**不是**「顺手丢掉」的小问题——它就是伪造引用，
// 与 P3 citation-integrity 的口径一致：一条无法回链到项目文献库的引用不许存在。
export function validateEvidenceList(
  raw: unknown,
  field: string,
  knownKeys: Set<string>,
): EvidenceValidation {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [`字段 '${field}' 必须是数组`], items: [] };
  }
  const items: IdeaEvidence[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${field}[${i}] 不是对象`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    if (!nonEmptyString(obj.note)) {
      errors.push(`${field}[${i}].note 缺失或不是非空字符串`);
      return;
    }
    const rawKey = typeof obj.key === "string" ? obj.key.trim().replace(/^\[?@?/, "").replace(/\]$/, "") : "";
    const inferred = obj.inferred === true;
    if (rawKey) {
      if (!knownKeys.has(rawKey)) {
        errors.push(
          `${field}[${i}].key '${rawKey}' 不在项目文献库中（只能引用库内论文；` +
            `要引它先 spark-research lit add 入库）`,
        );
        return;
      }
      items.push({ key: rawKey, note: (obj.note as string).trim(), inferred: false });
      return;
    }
    if (!inferred) {
      errors.push(`${field}[${i}] 既没有库内 key 也没有 inferred:true（观点必须带来源或显式标注推断）`);
      return;
    }
    items.push({ key: null, note: (obj.note as string).trim(), inferred: true });
  });
  return { ok: errors.length === 0, errors, items };
}

export interface IdeaCardValidationOptions {
  knownKeys: Iterable<string>;
  // 至少要有一条反对/复杂化证据（DESIGN 域 A4：批判性反馈不能只顺着说）。
  requireContradiction?: boolean;
}

export function validateIdeaCardPayload(
  payload: unknown,
  options: IdeaCardValidationOptions,
): IdeaCardValidation {
  const known = new Set(options.knownKeys);
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["输出不是 JSON 对象"] };
  }
  const obj = payload as Record<string, unknown>;

  for (const field of ["hypothesis", "critique"]) {
    if (!nonEmptyString(obj[field])) errors.push(`字段 '${field}' 缺失或不是非空字符串`);
  }

  const supporting = validateEvidenceList(obj.supporting, "supporting", known);
  errors.push(...supporting.errors);
  const contradicting = validateEvidenceList(obj.contradicting, "contradicting", known);
  errors.push(...contradicting.errors);

  if (options.requireContradiction !== false && contradicting.ok && contradicting.items.length === 0) {
    errors.push("字段 'contradicting' 至少要有 1 条反对或复杂化证据（不许只给支持面）");
  }

  const questions = obj.openQuestions;
  if (!Array.isArray(questions) || questions.length === 0 || !questions.every(nonEmptyString)) {
    errors.push("字段 'openQuestions' 必须是至少 1 条非空字符串的数组（待验证点）");
  }

  // 库非空时，整张卡至少要有一条**文献支撑**的证据。
  // 否则「全部标 inferred」就能绕过 grounding，卡片会退化成纯臆想。
  if (known.size > 0 && supporting.ok && contradicting.ok) {
    const sourced = [...supporting.items, ...contradicting.items].filter((e) => e.key !== null);
    if (sourced.length === 0) {
      errors.push("整张卡没有任何库内文献支撑（至少 1 条 supporting/contradicting 要引用库内论文）");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    fields: {
      hypothesis: (obj.hypothesis as string).trim(),
      critique: (obj.critique as string).trim(),
      supporting: supporting.items,
      contradicting: contradicting.items,
      openQuestions: (questions as string[]).map((q) => q.trim()),
    },
  };
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

export function ideaTitle(hypothesis: string): string {
  const oneLine = hypothesis.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

function renderEvidence(items: IdeaEvidence[]): string {
  if (items.length === 0) return "- （无）";
  return items
    .map((e) => (e.key ? `- [@${e.key}] ${e.note}` : `- （inferred）${e.note}`))
    .join("\n");
}

export function renderIdeaCard(card: IdeaCard, status: NoveltyStatus = "unchecked"): string {
  return [
    `# Idea 卡：${ideaTitle(card.hypothesis)}`,
    "",
    `## 假设陈述\n${card.hypothesis}`,
    "",
    `## 支持文献\n${renderEvidence(card.supporting)}`,
    "",
    `## 反对 / 复杂化证据\n${renderEvidence(card.contradicting)}`,
    "",
    `## 待验证点\n${card.openQuestions.map((q) => `- ${q}`).join("\n")}`,
    "",
    `## Novelty 状态\n${status}`,
    "",
    `## 共探讨论（inferred）\n${card.critique}`,
  ].join("\n");
}
