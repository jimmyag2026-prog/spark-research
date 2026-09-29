import { DEFAULT_PROMPT_DIR, projectBackgroundBlock, readPromptText } from "../agents/prompts";
import { extractJsonObject } from "../literature/reading";
import type { ChatMessage, LLMRouter } from "../llm/router";
import type { IdeaCard } from "./models";

// Cross-domain bridge（跨领域桥接，DESIGN 域 A · 技能 `cross-domain-bridge`）。
//
// 病因判断：模型在预训练里见过所有领域，但知识的检索被**上下文词汇**触发——用生物学
// 术语提问，激活的就是生物学文献的分布，物理学里的同构解法不会被唤醒。这条管线把
// 人类跨学科协作的实证经验翻译成可执行步骤：
//
//   ① 结构签名（Galison trading zone / boundary object）：把问题重写成剥掉领域词汇的
//      纯结构描述。**确定性代码**核对签名里不含用户声明的领域术语——过不了就打回。
//   ② 多语言唤醒：对着签名问「哪些领域研究过这个结构、叫什么名字、标准解法是什么」。
//   ③ 异质专家盲写（Janelia 小组 / 小团队颠覆）：每个领域一次**独立**调用，看不到其他
//      提案、没有共享历史。提案必须带显式映射表（哪些对应是承重的）。
//   ④ 结构审计（SESYNC facilitator / Virtual Lab critic）：**确定性代码**做同构测试与
//      Uzzi 比例门（常规骨架 + 一处非典型注入），全新奇与表面类比都杀。
//   ⑤ 锦标赛（co-scientist Elo）：两两对决，不开群聊——"Talk Isn't Always Cheap"
//      实证了群聊里正确的 agent 会被带偏。
//
// 与 co-explore 同一套管线纪律：schema 校验是硬门 → 失败原因回灌重试一次 → 仍不合格
// 就抛错，不落半成品。**所有产出都是推断**（inferred）——这条管线不查文献库，它产出的
// 是候选桥，真伪要交给 novelty-check 与实验。

export class BridgeError extends Error {
  readonly stage: BridgeStage;
  readonly validationErrors: string[];
  constructor(stage: BridgeStage, message: string, validationErrors: string[] = []) {
    super(`CrossDomainBridge[${stage}]: ${message}`);
    this.name = "BridgeError";
    this.stage = stage;
    this.validationErrors = validationErrors;
  }
}

export type BridgeStage = "signature" | "fields" | "proposal" | "audit" | "tournament";

export const BRIDGE_PROMPT_FILE = "bridge.txt";

export function loadBridgePrompt(promptDir = DEFAULT_PROMPT_DIR): string {
  return readPromptText(promptDir, BRIDGE_PROMPT_FILE) ?? `[prompt missing: ${BRIDGE_PROMPT_FILE}]`;
}

// ── 输入：问题卡（Heilmeier 式）────────────────────────────────────────────

export interface ProblemCard {
  /** 想做什么、卡在哪里。允许含术语——术语在 ① 被剥掉。 */
  statement: string;
  /** 问题所属领域（用来在审计里挡"同域自证"）。 */
  sourceField?: string;
  /** 用户声明的领域术语。结构签名里**不许出现**这些词（jargon 门的判据）。 */
  domainTerms: string[];
  /** 人类隐性判断：已知的死路。提案撞上死路 = 审计 soft finding。 */
  deadEnds: string[];
}

// ── ① 结构签名 ─────────────────────────────────────────────────────────────

export interface StructureSignature {
  objects: string[];
  relations: string[];
  dynamics: string;
  constraints: string[];
  objective: string;
  observables: string[];
}

export interface Validation<T> {
  ok: boolean;
  errors: string[];
  fields?: T;
}

function strList(value: unknown, field: string, errors: string[], min = 0): string[] {
  if (value === undefined || value === null) {
    if (min > 0) errors.push(`字段 '${field}' 缺失`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`字段 '${field}' 必须是字符串数组`);
    return [];
  }
  const items = value.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
  if (items.length < min) errors.push(`字段 '${field}' 至少要有 ${min} 项（现在 ${items.length}）`);
  return items;
}

function str(value: unknown, field: string, errors: string[], required = true): string {
  if (typeof value !== "string" || value.trim() === "") {
    if (required) errors.push(`字段 '${field}' 缺失或为空`);
    return "";
  }
  return value.trim();
}

// 字符串或字符串数组都收（数组用「；」合并）。冒烟实测：deepseek-v4-flash 会把 dynamics /
// objective 写成多条数组——内容完全合格，只因形态被打回等于把一份好签名扔掉。
function strOrJoined(value: unknown, field: string, errors: string[]): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
    if (items.length === 0) {
      errors.push(`字段 '${field}' 缺失或为空`);
      return "";
    }
    return items.join("；");
  }
  return str(value, field, errors);
}

/** 术语命中判据：不区分大小写的子串。≤2 个字符的术语太容易误伤（"AI"、"PD"），跳过。 */
export function jargonHits(text: string, domainTerms: readonly string[]): string[] {
  const haystack = text.toLowerCase();
  return domainTerms
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => haystack.includes(t.toLowerCase()));
}

export function validateStructureSignature(
  raw: unknown,
  options: { domainTerms?: readonly string[] } = {},
): Validation<StructureSignature> {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["结构签名必须是 JSON 对象"] };
  const r = raw as Record<string, unknown>;
  const fields: StructureSignature = {
    objects: strList(r.objects, "objects", errors, 2),
    relations: strList(r.relations, "relations", errors, 1),
    dynamics: strOrJoined(r.dynamics, "dynamics", errors),
    constraints: strList(r.constraints, "constraints", errors, 0),
    objective: strOrJoined(r.objective, "objective", errors),
    observables: strList(r.observables, "observables", errors, 1),
  };
  // jargon 门：签名的意义就是让别的领域能读懂。带着原领域术语的签名等于没翻译。
  const flat = [
    ...fields.objects,
    ...fields.relations,
    fields.dynamics,
    ...fields.constraints,
    fields.objective,
    ...fields.observables,
  ].join("\n");
  const hits = jargonHits(flat, options.domainTerms ?? []);
  if (hits.length > 0) {
    errors.push(`结构签名仍含领域术语：${hits.join("、")}——改用不依赖该领域的结构性描述`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], fields };
}

export function renderSignature(sig: StructureSignature): string {
  return [
    `对象：${sig.objects.join("；")}`,
    `关系：${sig.relations.join("；")}`,
    `动力学：${sig.dynamics}`,
    `约束：${sig.constraints.length > 0 ? sig.constraints.join("；") : "（无）"}`,
    `目标：${sig.objective}`,
    `可观测量：${sig.observables.join("；")}`,
  ].join("\n");
}

// ── ② 多语言唤醒：候选领域 ───────────────────────────────────────────────────

export interface FieldCandidate {
  field: string;
  /** 这个结构在该领域叫什么。 */
  localName: string;
  /** 该领域处理这个结构的标准方法。 */
  canonicalMethod: string;
}

export function validateFieldCandidates(raw: unknown, options: { min?: number } = {}): Validation<FieldCandidate[]> {
  const min = options.min ?? 3;
  const errors: string[] = [];
  const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown> | null)?.fields;
  if (!Array.isArray(list)) return { ok: false, errors: ["候选领域必须是数组（或 {fields: [...]}）"] };
  const seen = new Set<string>();
  const fields: FieldCandidate[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      errors.push(`第 ${i + 1} 项不是对象`);
      return;
    }
    const r = item as Record<string, unknown>;
    const local: string[] = [];
    const candidate: FieldCandidate = {
      field: str(r.field, `fields[${i}].field`, local),
      localName: str(r.localName, `fields[${i}].localName`, local),
      canonicalMethod: str(r.canonicalMethod, `fields[${i}].canonicalMethod`, local),
    };
    if (local.length > 0) {
      errors.push(...local);
      return;
    }
    const key = candidate.field.toLowerCase();
    // 同一领域出现两次不算两种视角——去重而不是报错，报错会让模型为凑数瞎编。
    if (seen.has(key)) return;
    seen.add(key);
    fields.push(candidate);
  });
  if (fields.length < min) errors.push(`至少要有 ${min} 个不同领域（现在 ${fields.length}）——视角太少就没有"跨"`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], fields };
}

// ── ③ 提案（带映射表）───────────────────────────────────────────────────────

export interface MappingRow {
  /** 来源领域里的对象 / 关系 */
  source: string;
  /** 对应到目标问题里的对象 / 关系 */
  target: string;
  /** 这条对应保持的是什么关系 */
  relation: string;
  /** 承重：这条对应断了，整个迁移就不成立。 */
  loadBearing: boolean;
}

export type LiteratureAge = "old" | "recent" | "mixed";
export const LITERATURE_AGES: readonly LiteratureAge[] = ["old", "recent", "mixed"];

export interface BridgeProposal {
  field: string;
  mechanism: string;
  /** 收敛成一句可证伪的话。 */
  statement: string;
  mapping: MappingRow[];
  /** Uzzi：高影响工作 = 极常规的组合骨架 + 一处非典型注入。 */
  conventionalSkeleton: string[];
  atypicalInjection: string;
  cheapFalsification: string;
  literatureAge: LiteratureAge;
  /** 自由文本参考（不是库内 key）——全部按 inferred 处理。 */
  references: string[];
}

export function validateBridgeProposal(raw: unknown): Validation<BridgeProposal> {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["提案必须是 JSON 对象"] };
  const r = raw as Record<string, unknown>;
  const mapping: MappingRow[] = [];
  if (!Array.isArray(r.mapping)) {
    errors.push("字段 'mapping' 必须是数组——没有映射表的类比只是修辞");
  } else {
    r.mapping.forEach((row, i) => {
      if (!row || typeof row !== "object") {
        errors.push(`mapping[${i}] 不是对象`);
        return;
      }
      const m = row as Record<string, unknown>;
      mapping.push({
        source: typeof m.source === "string" ? m.source.trim() : "",
        target: typeof m.target === "string" ? m.target.trim() : "",
        relation: typeof m.relation === "string" ? m.relation.trim() : "",
        loadBearing: m.loadBearing === true,
      });
    });
    if (mapping.length === 0) errors.push("字段 'mapping' 不能为空");
  }
  const ageRaw = typeof r.literatureAge === "string" ? r.literatureAge.trim() : "";
  const literatureAge = (LITERATURE_AGES as readonly string[]).includes(ageRaw) ? (ageRaw as LiteratureAge) : null;
  if (!literatureAge) errors.push(`字段 'literatureAge' 必须是 ${LITERATURE_AGES.join(" / ")}`);
  const fields: BridgeProposal = {
    field: str(r.field, "field", errors),
    mechanism: strOrJoined(r.mechanism, "mechanism", errors),
    statement: strOrJoined(r.statement, "statement", errors),
    mapping,
    conventionalSkeleton: strList(r.conventionalSkeleton, "conventionalSkeleton", errors, 0),
    atypicalInjection: str(r.atypicalInjection, "atypicalInjection", errors),
    cheapFalsification: strOrJoined(r.cheapFalsification, "cheapFalsification", errors),
    literatureAge: literatureAge ?? "mixed",
    references: strList(r.references, "references", errors, 0),
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], fields };
}

// ── ④ 结构审计（确定性）─────────────────────────────────────────────────────

export type AuditCode =
  | "superficial_analogy"
  | "broken_mapping"
  | "all_novel"
  | "unfalsifiable"
  | "dead_end_overlap"
  | "same_field";

export interface AuditFinding {
  code: AuditCode;
  severity: "hard" | "soft";
  message: string;
}

export interface AuditResult {
  pass: boolean;
  findings: AuditFinding[];
}

export const MIN_LOAD_BEARING = 2;
export const MIN_SKELETON = 2;
export const MIN_FALSIFICATION_CHARS = 20;

export function auditProposal(p: BridgeProposal, card: Pick<ProblemCard, "deadEnds" | "sourceField">): AuditResult {
  const findings: AuditFinding[] = [];
  const loadBearing = p.mapping.filter((m) => m.loadBearing);
  // 同构测试：类比便宜，正确的类比贵。承重对应不到两条 = 表面相似。
  if (loadBearing.length < MIN_LOAD_BEARING) {
    findings.push({
      code: "superficial_analogy",
      severity: "hard",
      message: `承重映射只有 ${loadBearing.length} 条（至少 ${MIN_LOAD_BEARING}）——这是表面类比，不是结构同构`,
    });
  }
  const broken = loadBearing.filter((m) => !m.source || !m.target || !m.relation);
  if (broken.length > 0) {
    findings.push({
      code: "broken_mapping",
      severity: "hard",
      message: `${broken.length} 条承重映射缺 source/target/relation 之一——写不出对应关系的映射不算映射`,
    });
  }
  // Uzzi 门：没有常规骨架的提案是"全新奇"，实证上影响最低。
  if (p.conventionalSkeleton.length < MIN_SKELETON) {
    findings.push({
      code: "all_novel",
      severity: "hard",
      message: `常规骨架只有 ${p.conventionalSkeleton.length} 条（至少 ${MIN_SKELETON}）——全新奇的组合不是高影响的形状`,
    });
  }
  if (p.cheapFalsification.length < MIN_FALSIFICATION_CHARS) {
    findings.push({
      code: "unfalsifiable",
      severity: "hard",
      message: "廉价伪证方案太短，不足以排期——写清做什么实验/计算、看到什么就算错",
    });
  }
  // 人类隐性判断：撞死路不直接杀（模型可能有理由），但必须显式报出来。
  const text = `${p.statement}\n${p.mechanism}\n${p.atypicalInjection}`;
  const dead = jargonHits(text, card.deadEnds);
  if (dead.length > 0) {
    findings.push({
      code: "dead_end_overlap",
      severity: "soft",
      message: `提案触及用户声明的死路：${dead.join("、")}——需要说明为什么这次不同`,
    });
  }
  if (card.sourceField && p.field.trim().toLowerCase() === card.sourceField.trim().toLowerCase()) {
    findings.push({
      code: "same_field",
      severity: "soft",
      message: "来源领域与问题所属领域相同——这不是跨领域桥，最多是领域内综述",
    });
  }
  return { pass: !findings.some((f) => f.severity === "hard"), findings };
}

// ── ⑤ 锦标赛（Elo，两两对决）────────────────────────────────────────────────

export type MatchOutcome = "a" | "b" | "tie";
export type PairJudge = (a: BridgeProposal, b: BridgeProposal) => Promise<MatchOutcome>;

export interface TournamentEntry {
  proposal: BridgeProposal;
  rating: number;
  wins: number;
  losses: number;
  ties: number;
}

export const ELO_INITIAL = 1000;
export const ELO_K = 32;

function expected(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/**
 * 单循环两两对决。评委每次只看两份提案——**不开群聊**，不让任何提案看到多数意见。
 * 结果按 rating 降序；同分按胜场，再按原始顺序（稳定）。
 */
export async function runTournament(proposals: BridgeProposal[], judge: PairJudge): Promise<TournamentEntry[]> {
  const entries: TournamentEntry[] = proposals.map((proposal) => ({
    proposal,
    rating: ELO_INITIAL,
    wins: 0,
    losses: 0,
    ties: 0,
  }));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      const outcome = await judge(a.proposal, b.proposal);
      const scoreA = outcome === "a" ? 1 : outcome === "b" ? 0 : 0.5;
      const ea = expected(a.rating, b.rating);
      a.rating += ELO_K * (scoreA - ea);
      b.rating += ELO_K * (1 - scoreA - (1 - ea));
      if (outcome === "a") {
        a.wins++;
        b.losses++;
      } else if (outcome === "b") {
        b.wins++;
        a.losses++;
      } else {
        a.ties++;
        b.ties++;
      }
    }
  }
  return entries
    .map((e, index) => ({ e, index }))
    .sort((x, y) => y.e.rating - x.e.rating || y.e.wins - x.e.wins || x.index - y.index)
    .map(({ e }) => e);
}

// ── 报告 ──────────────────────────────────────────────────────────────────

export interface RankedProposal {
  proposal: BridgeProposal;
  audit: AuditResult;
  rating: number;
  wins: number;
  losses: number;
  ties: number;
  rank: number;
}

export interface RejectedProposal {
  proposal: BridgeProposal;
  audit: AuditResult;
}

export interface BridgeReport {
  card: ProblemCard;
  signature: StructureSignature;
  fields: FieldCandidate[];
  ranked: RankedProposal[];
  rejected: RejectedProposal[];
  /** 提案阶段两次都没产出合格提案的领域（如实列出，不静默丢）。 */
  failedFields: Array<{ field: string; errors: string[] }>;
  model: string | null;
  llmCalls: number;
}

export function renderMapping(rows: MappingRow[]): string {
  return rows
    .map((m) => `  ${m.loadBearing ? "◆" : "◇"} ${m.source} → ${m.target}（${m.relation}）`)
    .join("\n");
}

export function renderBridgeReport(report: BridgeReport): string {
  const lines: string[] = [];
  lines.push("# 跨领域桥接报告", "");
  lines.push("## 问题", "", report.card.statement, "");
  if (report.card.deadEnds.length > 0) lines.push(`已知死路：${report.card.deadEnds.join("；")}`, "");
  lines.push("## 结构签名（已剥离领域术语）", "", renderSignature(report.signature), "");
  lines.push(`## 唤醒的领域（${report.fields.length}）`, "");
  for (const f of report.fields) lines.push(`- **${f.field}**：叫「${f.localName}」，标准解法 ${f.canonicalMethod}`);
  lines.push("");
  lines.push(`## 通过审计的桥（${report.ranked.length}，按锦标赛排名）`, "");
  for (const r of report.ranked) {
    const p = r.proposal;
    lines.push(`### #${r.rank} ${p.field} · Elo ${Math.round(r.rating)}（${r.wins}胜 ${r.losses}负 ${r.ties}平）`, "");
    lines.push(`**假设**：${p.statement}`, "");
    lines.push(`**机制**：${p.mechanism}`, "");
    lines.push("**映射表**（◆ 承重 / ◇ 装饰）：", "", renderMapping(p.mapping), "");
    lines.push(`**常规骨架**：${p.conventionalSkeleton.join("；")}`);
    lines.push(`**非典型注入**：${p.atypicalInjection}`);
    lines.push(`**廉价伪证**：${p.cheapFalsification}`);
    lines.push(`**文献年代**：${p.literatureAge}${p.references.length > 0 ? ` · 参考（未核验，inferred）：${p.references.join("；")}` : ""}`);
    const soft = r.audit.findings.filter((f) => f.severity === "soft");
    if (soft.length > 0) lines.push(`**审计提示**：${soft.map((f) => f.message).join("；")}`);
    lines.push("");
  }
  if (report.rejected.length > 0) {
    lines.push(`## 被审计否决的桥（${report.rejected.length}）`, "");
    for (const rj of report.rejected) {
      lines.push(`- **${rj.proposal.field}**：${rj.proposal.statement.slice(0, 80)}`);
      for (const f of rj.audit.findings.filter((x) => x.severity === "hard")) lines.push(`    ✗ ${f.message}`);
    }
    lines.push("");
  }
  if (report.failedFields.length > 0) {
    lines.push(`## 未能产出合格提案的领域（${report.failedFields.length}）`, "");
    for (const f of report.failedFields) lines.push(`- ${f.field}：${f.errors.slice(0, 2).join("；")}`);
    lines.push("");
  }
  lines.push(`> 全部内容为模型推断（inferred），未经文献库核对。下一步：对排名靠前的桥跑 novelty-check，或先做廉价伪证。`);
  lines.push(`> LLM 调用 ${report.llmCalls} 次${report.model ? ` · 模型 ${report.model}` : ""}`);
  return lines.join("\n");
}

/**
 * 通过审计的桥 → Idea 卡（可直接 `IdeaStore.create`）。
 * 这条管线不查文献库，所以 supporting/contradicting 全部 inferred；
 * contradicting 至少一条（共探同款纪律）：承重映射尚未在目标域验证，本身就是最大的反对意见。
 */
export function bridgeToIdeaCard(ranked: RankedProposal): IdeaCard {
  const p = ranked.proposal;
  const loadBearing = p.mapping.filter((m) => m.loadBearing);
  const contradicting = [
    {
      key: null,
      note: `承重映射（${loadBearing.map((m) => `${m.source}→${m.target}`).join("、")}）尚未在目标域验证；任一条不成立则迁移失效`,
      inferred: true,
    },
    ...ranked.audit.findings
      .filter((f) => f.severity === "soft")
      .map((f) => ({ key: null, note: f.message, inferred: true })),
  ];
  return {
    hypothesis: p.statement,
    critique: [
      `来源领域：${p.field}（${p.literatureAge} 文献）。机制：${p.mechanism}（inferred）`,
      "",
      "映射表（◆ 承重 / ◇ 装饰）：",
      renderMapping(p.mapping),
      "",
      `常规骨架：${p.conventionalSkeleton.join("；")}；非典型注入：${p.atypicalInjection}（inferred）`,
    ].join("\n"),
    supporting: [
      { key: null, note: `${p.field} 中 ${p.mechanism} 对同构结构的既有结果（未入库，待 lit search 核实）`, inferred: true },
    ],
    contradicting,
    openQuestions: [p.cheapFalsification],
  };
}

// ── 会话 ──────────────────────────────────────────────────────────────────

export interface BridgeDeps {
  llm: Pick<LLMRouter, "call">;
  model?: string;
  projectContext?: string;
  promptDir?: string;
}

export interface BridgeRunOptions {
  /** 唤醒多少个领域并各写一份提案（默认 6）。 */
  fields?: number;
  /** 阶段进度回调（CLI / chat 进度条）。 */
  note?: (message: string) => void;
}

interface Attempt<T> {
  value: T;
  model: string | null;
}

export class BridgeSession {
  private calls = 0;

  constructor(private deps: BridgeDeps) {}

  private async call(messages: ChatMessage[]) {
    this.calls++;
    return this.deps.model ? this.deps.llm.call(messages, this.deps.model) : this.deps.llm.call(messages);
  }

  /**
   * 通用「调用 → 校验 → 回灌重试一次」。**每次调用都是全新 messages**：
   * 没有共享历史是 ③ 盲写成立的前提，所以把它做成结构而不是靠 prompt 叮嘱。
   */
  private async ask<T>(
    stage: BridgeStage,
    userPrompt: string,
    validate: (raw: unknown) => Validation<T>,
  ): Promise<Attempt<T>> {
    const system = loadBridgePrompt(this.deps.promptDir);
    let lastErrors: string[] = [];
    let lastRaw = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ];
      if (attempt === 2) {
        messages.push({
          role: "user",
          content: "上一次输出不符合契约，请只重新输出修正后的 JSON。校验失败原因：\n" + lastErrors.map((e) => `- ${e}`).join("\n"),
        });
      }
      const response = await this.call(messages);
      if (!response.ok) {
        lastErrors = [`模型调用失败: ${response.error?.message ?? "未知原因"}`];
        continue;
      }
      lastRaw = response.content;
      const validation = validate(extractJsonObject(response.content));
      if (validation.ok) return { value: validation.fields!, model: response.model };
      lastErrors = validation.errors;
    }
    throw new BridgeError(
      stage,
      `重试 1 次后输出仍不合契约: ${lastErrors.join("; ")}` + (lastRaw ? `\n原始输出（截断 300 字）: ${lastRaw.slice(0, 300)}` : ""),
      lastErrors,
    );
  }

  private background(): string {
    return projectBackgroundBlock(this.deps.projectContext) || "（本项目未填写描述）";
  }

  async run(card: ProblemCard, options: BridgeRunOptions = {}): Promise<BridgeReport> {
    if (!card.statement.trim()) throw new BridgeError("signature", "问题陈述为空");
    const wanted = Math.max(2, options.fields ?? 6);
    const note = options.note ?? (() => {});
    this.calls = 0;
    let model: string | null = null;

    // ① 结构签名
    note("① 结构签名：剥离领域术语");
    const sig = await this.ask("signature", buildSignaturePrompt(card, this.background()), (raw) =>
      validateStructureSignature(raw, { domainTerms: card.domainTerms }),
    );
    model = sig.model ?? model;

    // ② 多语言唤醒
    note(`② 多语言唤醒：找 ${wanted} 个研究过同一结构的领域`);
    const fieldsAttempt = await this.ask("fields", buildFieldsPrompt(sig.value, wanted, card.sourceField), (raw) =>
      validateFieldCandidates(raw, { min: Math.min(3, wanted) }),
    );
    const fields = fieldsAttempt.value.slice(0, wanted);
    model = fieldsAttempt.model ?? model;

    // ③ 盲写：每个领域一次独立调用（无共享历史、看不到其他提案）
    const proposals: BridgeProposal[] = [];
    const failedFields: BridgeReport["failedFields"] = [];
    for (const [i, field] of fields.entries()) {
      note(`③ 盲写 ${i + 1}/${fields.length}：${field.field}`);
      try {
        const p = await this.ask("proposal", buildProposalPrompt(sig.value, field, i), validateBridgeProposal);
        model = p.model ?? model;
        // 领域名以唤醒阶段的为准——提案里写错了领域名不该成为审计里的"换域"。
        proposals.push({ ...p.value, field: p.value.field || field.field });
      } catch (e) {
        // 一个领域写不出合格提案不该把整轮带走，但**必须看得见**。
        failedFields.push({ field: field.field, errors: e instanceof BridgeError ? e.validationErrors : [String(e)] });
      }
    }
    if (proposals.length === 0) {
      throw new BridgeError("proposal", `${fields.length} 个领域都没能产出合格提案：${failedFields.map((f) => f.field).join("、")}`);
    }

    // ④ 审计（确定性）
    note("④ 结构审计：同构测试 + Uzzi 比例门");
    const passed: Array<{ proposal: BridgeProposal; audit: AuditResult }> = [];
    const rejected: RejectedProposal[] = [];
    for (const proposal of proposals) {
      const audit = auditProposal(proposal, card);
      (audit.pass ? passed : rejected).push({ proposal, audit });
    }

    // ⑤ 锦标赛（≥2 份才有对决；1 份直接排第一）
    let ranked: RankedProposal[] = [];
    if (passed.length >= 2) {
      note(`⑤ 锦标赛：${passed.length} 份提案两两对决`);
      const auditOf = new Map(passed.map((p) => [p.proposal, p.audit]));
      const entries = await runTournament(
        passed.map((p) => p.proposal),
        async (a, b) => {
          const r = await this.ask("tournament", buildJudgePrompt(sig.value, a, b), validateJudgeVerdict);
          model = r.model ?? model;
          return r.value;
        },
      );
      ranked = entries.map((e, index) => ({
        proposal: e.proposal,
        audit: auditOf.get(e.proposal)!,
        rating: e.rating,
        wins: e.wins,
        losses: e.losses,
        ties: e.ties,
        rank: index + 1,
      }));
    } else {
      ranked = passed.map((p, index) => ({
        proposal: p.proposal,
        audit: p.audit,
        rating: ELO_INITIAL,
        wins: 0,
        losses: 0,
        ties: 0,
        rank: index + 1,
      }));
    }

    return { card, signature: sig.value, fields, ranked, rejected, failedFields, model, llmCalls: this.calls };
  }
}

// ── prompts（user 段；system 段在 prompt/bridge.txt）─────────────────────────

export function buildSignaturePrompt(card: ProblemCard, background: string): string {
  return [
    background,
    "",
    "【阶段 ① 结构签名】把下面的研究问题重写成**不含任何领域术语**的纯结构描述。",
    "禁止出现的术语（用户声明）：" + (card.domainTerms.length > 0 ? card.domainTerms.join("、") : "（未声明，但仍要避免专有名词）"),
    "",
    "问题：",
    card.statement.trim(),
    "",
    "只输出一个 JSON 对象：",
    '{"objects":["...至少 2 个：系统里有哪些东西"],"relations":["...它们之间什么关系"],"dynamics":"...随时间/迭代怎么变","constraints":["..."],"objective":"...要优化/判定什么","observables":["...我们实际能测到什么"]}',
  ].join("\n");
}

export function buildFieldsPrompt(sig: StructureSignature, wanted: number, sourceField?: string): string {
  return [
    "【阶段 ② 多语言唤醒】下面是一个剥离了领域术语的结构签名。",
    `列出 ${wanted} 个**互不相同**的领域，它们各自研究过这个结构：在该领域叫什么名字、标准解法是什么。`,
    "优先考虑：远离问题原领域的领域、有成熟数学工具的领域、以及有十年以上老文献的冷门领域。",
    sourceField ? `问题原领域是「${sourceField}」——不要列它。` : "",
    "",
    renderSignature(sig),
    "",
    "只输出一个 JSON 对象：",
    '{"fields":[{"field":"领域名","localName":"该结构在此领域的名字","canonicalMethod":"标准解法"}]}',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function buildProposalPrompt(sig: StructureSignature, field: FieldCandidate, seat: number): string {
  return [
    `【阶段 ③ 盲写 · 席位 ${seat + 1}】你是「${field.field}」领域的资深研究者。你**只**看到下面的结构签名，看不到其他领域的提案。`,
    `在你的领域里这个结构叫「${field.localName}」，标准解法是 ${field.canonicalMethod}。`,
    "写一份把你领域的方法迁移到这个结构上的提案。要求：",
    "- mapping：逐条写出你领域的对象/关系 → 签名里的对象/关系，并标出哪几条是承重的（断了整个迁移就不成立）。至少 2 条承重。",
    "- conventionalSkeleton：至少 2 条**常规、成熟**的组合骨架（高影响工作 = 常规骨架 + 一处非典型注入）。",
    "- atypicalInjection：**只写一处**非典型注入。",
    "- cheapFalsification：下周就能做的最便宜的伪证实验/计算，写清看到什么就算错。",
    "- literatureAge：你依赖的文献主要是 old（≥10 年）/ recent / mixed。优先挖老的、冷门的。",
    "- references：自由文本，不要编造 DOI。",
    "",
    renderSignature(sig),
    "",
    "只输出一个 JSON 对象：",
    '{"field":"...","mechanism":"...","statement":"一句可证伪的话","mapping":[{"source":"...","target":"...","relation":"...","loadBearing":true}],"conventionalSkeleton":["...","..."],"atypicalInjection":"...","cheapFalsification":"...","literatureAge":"old|recent|mixed","references":["..."]}',
  ].join("\n");
}

export function buildJudgePrompt(sig: StructureSignature, a: BridgeProposal, b: BridgeProposal): string {
  const one = (label: string, p: BridgeProposal) =>
    [
      `提案 ${label}（${p.field}）`,
      `假设：${p.statement}`,
      `机制：${p.mechanism}`,
      "映射表：",
      renderMapping(p.mapping),
      `常规骨架：${p.conventionalSkeleton.join("；")}`,
      `非典型注入：${p.atypicalInjection}`,
      `廉价伪证：${p.cheapFalsification}`,
    ].join("\n");
  return [
    "【阶段 ⑤ 两两对决】你是评委，只看这两份提案，不知道其他提案的存在。",
    "评判维度（按重要性）：承重映射是否真的保持了做功的关系；可检验性；非典型注入是否承重而不是装饰。",
    "**不要**按新奇度打分——全新奇的组合实证上影响最低。",
    "",
    renderSignature(sig),
    "",
    one("A", a),
    "",
    one("B", b),
    "",
    '只输出一个 JSON 对象：{"winner":"A"|"B"|"tie","reason":"一句话"}',
  ].join("\n");
}

export function validateJudgeVerdict(raw: unknown): Validation<MatchOutcome> {
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["裁决必须是 JSON 对象"] };
  const w = String((raw as Record<string, unknown>).winner ?? "").trim().toLowerCase();
  if (w === "a" || w === "b") return { ok: true, errors: [], fields: w };
  if (w === "tie") return { ok: true, errors: [], fields: "tie" };
  return { ok: false, errors: [`winner 必须是 A / B / tie（现在 '${w}'）`] };
}
