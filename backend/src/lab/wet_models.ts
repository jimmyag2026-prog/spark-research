import type { ResearchRecord } from "../project/models";
import type { SafetyCheckResult } from "./protocol";
import type { CompiledStep, DeckSlotPlan } from "./opentrons_protocol";
import type { WetRunLogEntry, WetSummaryValue } from "./wet_backend";

// 湿实验状态机（DESIGN 域 B3 的 wet 半边 · AD-6）。
//
// 与 P5 的干实验状态机（`experiment/models.ts`）**刻意分开两张表**：
//   - 两条链的状态集不同（湿实验多了 compile / safety_check / awaiting_approval / rejected）；
//   - P5 的转移表被一组穷举测试逐格锁死（7 合法 + 42 非法），往里加状态会把那组测试的
//     语义悄悄改掉。状态机的价值就在于「表是什么就是什么」，不该为了复用去动它。
// 两者共用的是 record 存储、边语义与 `RecordStore.update()` 窄口，那些才是该复用的东西。
//
// ```
// design → compile → safety_check → awaiting_approval → wet_run → collect → analyze → concluded
//             ↑           │                 │              │                      └→ iterated
//             │           └→ failed         └→ rejected    └→ failed
//             └───────────── 重新编译（compile 会清掉已有 approve）
// ```
//
// **唯一进入 `wet_run` 的门是 `approve()`**。这是 AD-6 的落点：安全门全过也只是
// 允许停在 `awaiting_approval`，物理世界的操作不自动化审批。
export const WET_EXPERIMENT_STATES = [
  "design", // 自然语言协议已记录，还没编译
  "compile", // 已编译成 Opentrons 脚本，还没过安全门
  "safety_check", // 安全门已跑且通过（不通过不会进这个状态）
  "awaiting_approval", // 等人工 approve —— 安全门通过 ≠ 可以执行
  "wet_run", // 已被显式 approve，允许/正在执行
  "collect", // run log 与脚本已回收进 artifact
  "analyze", // 已产出 observation（evidence=observed）
  "concluded", // 终态：得出结论
  "iterated", // 终态：另起一条实验
  "rejected", // 终态之一：人工拒绝（可重新编译后再来）
  "failed", // 安全门不过 / 执行失败（可重新编译）
] as const;
export type WetExperimentState = (typeof WET_EXPERIMENT_STATES)[number];

export const WET_LEGAL_TRANSITIONS: Readonly<
  Record<WetExperimentState, readonly WetExperimentState[]>
> = {
  design: ["compile"],
  compile: ["safety_check", "compile", "failed"],
  safety_check: ["awaiting_approval", "compile"],
  awaiting_approval: ["wet_run", "rejected", "compile"],
  wet_run: ["collect", "failed", "compile"],
  collect: ["analyze", "failed"],
  analyze: ["concluded", "iterated"],
  rejected: ["compile"],
  failed: ["compile"],
  concluded: [],
  iterated: [],
};

export const WET_TERMINAL_STATES: readonly WetExperimentState[] = ["concluded", "iterated"];

export function canWetTransition(from: WetExperimentState, to: WetExperimentState): boolean {
  return (WET_LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

export function isWetExperimentState(value: unknown): value is WetExperimentState {
  return typeof value === "string" && (WET_EXPERIMENT_STATES as readonly string[]).includes(value);
}

export interface WetTransitionEntry {
  from: WetExperimentState;
  to: WetExperimentState;
  at: string;
  note: string | null;
}

// approve / reject 的落点。两者都必须留一条 decision record，metadata 里带
// **批的是哪个协议 hash** —— 「批过了」与「批的是这一版」是两件事。
export interface ApprovalRecordMeta {
  decisionRecordId: string;
  actor: string;
  at: string;
  protocolHash: string;
  note: string | null;
}

export interface RejectionRecordMeta {
  decisionRecordId: string;
  actor: string;
  at: string;
  protocolHash: string;
  reason: string;
}

export interface WetExperimentMeta {
  kind: "experiment";
  mode: "wet";
  state: WetExperimentState;
  backend: string;
  // 自然语言协议原文——编译的输入，审计时要能看到人到底说了什么。
  naturalLanguage: string;
  hypothesis: string | null;
  protocolId: string | null;
  protocolName: string | null;
  protocolHash: string | null;
  apiLevel: string | null;
  robotType: string | null;
  deck: DeckSlotPlan[];
  compiledSteps: CompiledStep[];
  compileWarnings: string[];
  safetyChecks: SafetyCheckResult[];
  safetyPassed: boolean | null;
  approval: ApprovalRecordMeta | null;
  rejection: RejectionRecordMeta | null;
  runId: string | null;
  runDir: string | null;
  attempts: number;
  iteration: number;
  parentExperimentId: string | null;
  // 干实验来源（干湿闭环接通点）。
  derivedFromDryExperimentId: string | null;
  history: WetTransitionEntry[];
  timestamps: Partial<Record<WetExperimentState, string>>;
  summary: Record<string, WetSummaryValue> | null;
  runLogEntryCount: number | null;
  artifactRecordIds: string[];
  observationId: string | null;
  conclusionId: string | null;
  lastError: string | null;
}

export interface WetExperimentView extends WetExperimentMeta {
  id: string;
  title: string;
  createdAt: string;
  record: ResearchRecord;
}

export class WetStateError extends Error {
  readonly from: WetExperimentState;
  readonly to: WetExperimentState;

  constructor(from: WetExperimentState, to: WetExperimentState, hint = "") {
    super(
      `非法状态转移 ${from} → ${to}（${from} 只能转到 ${
        (WET_LEGAL_TRANSITIONS[from] ?? []).join(" / ") || "无（终态）"
      }）${hint ? `。${hint}` : ""}`,
    );
    this.name = "WetStateError";
    this.from = from;
    this.to = to;
  }
}

export class WetExperimentNotFoundError extends Error {
  constructor(ref: string) {
    super(`找不到湿实验 record '${ref}'`);
    this.name = "WetExperimentNotFoundError";
  }
}

// approve gate 被绕过时抛这个。**它与 WetStateError 分开**：
// 「状态不对」和「没人批过」是两种不同的错误，用户要采取的动作也不同。
export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return Math.abs(value) >= 1e-4 && Math.abs(value) < 1e7 ? value.toFixed(4) : value.toExponential(4);
  }
  return String(value);
}

// 正文由**代码**渲染（同 P4/P5）：状态、协议 hash、安全门结论、审批人都是确定的事实，
// 让模型写正文等于把这些也交出去。
export function renderWetExperiment(view: Omit<WetExperimentView, "record">): string {
  const lines: string[] = [];
  lines.push(`# 湿实验 · ${view.title}`);
  lines.push("");
  lines.push(`- record: \`${view.id}\``);
  lines.push(`- 状态：**${view.state}**`);
  lines.push(`- 后端：${view.backend}`);
  lines.push(`- 迭代：第 ${view.iteration} 轮 · 执行 ${view.attempts} 次`);
  if (view.protocolHash) lines.push(`- protocolHash: \`${view.protocolHash}\``);
  if (view.apiLevel) lines.push(`- 编译目标：Opentrons ${view.robotType} / Protocol API v${view.apiLevel}`);
  if (view.runId) lines.push(`- run: \`${view.runId}\``);
  if (view.derivedFromDryExperimentId) {
    lines.push(`- 来自干实验：\`${view.derivedFromDryExperimentId}\``);
  }
  lines.push("");
  lines.push("## 协议原文");
  lines.push("");
  lines.push("```");
  lines.push(view.naturalLanguage);
  lines.push("```");
  if (view.hypothesis) {
    lines.push("");
    lines.push("## 假设");
    lines.push(view.hypothesis);
  }
  if (view.compiledSteps.length > 0) {
    lines.push("");
    lines.push("## 编译后的步骤");
    lines.push("");
    lines.push("| 步骤 | 动作 | 落地方式 | 说明 |");
    lines.push("|------|------|---------|------|");
    for (const step of view.compiledSteps) {
      lines.push(`| ${step.stepId} | ${step.action} | ${step.execution} | ${step.summary} |`);
    }
    const notes = view.compiledSteps.flatMap((s) => s.notes.map((n) => `${s.stepId}: ${n}`));
    if (notes.length > 0) {
      lines.push("");
      lines.push("编译注记：");
      for (const note of notes) lines.push(`- ${note}`);
    }
  }
  if (view.safetyChecks.length > 0) {
    lines.push("");
    lines.push("## 安全门");
    lines.push("");
    lines.push("| 检查 | 结果 | 详情 |");
    lines.push("|------|------|------|");
    for (const check of view.safetyChecks) {
      lines.push(`| ${check.check} | ${check.passed ? "通过" : "**拦截**"} | ${check.detail ?? "—"} |`);
    }
    lines.push("");
    lines.push("> 安全门通过 ≠ 可以执行。执行前必须有人工 approve（AD-6）。");
  }
  if (view.approval) {
    lines.push("");
    lines.push("## 审批");
    lines.push("");
    lines.push(`- ✅ ${view.approval.actor} 于 ${view.approval.at} 批准`);
    lines.push(`- 批准的协议 hash: \`${view.approval.protocolHash}\``);
    lines.push(`- decision record: \`${view.approval.decisionRecordId}\``);
    if (view.approval.note) lines.push(`- 备注：${view.approval.note}`);
  }
  if (view.rejection) {
    lines.push("");
    lines.push("## 审批");
    lines.push("");
    lines.push(`- ❌ ${view.rejection.actor} 于 ${view.rejection.at} 拒绝`);
    lines.push(`- 被拒的协议 hash: \`${view.rejection.protocolHash}\``);
    lines.push(`- 理由：${view.rejection.reason}`);
    lines.push(`- decision record: \`${view.rejection.decisionRecordId}\``);
  }
  if (view.summary && Object.keys(view.summary).length > 0) {
    lines.push("");
    lines.push("## 执行摘要");
    lines.push("");
    lines.push("| 指标 | 值 |");
    lines.push("|------|-----|");
    for (const [key, value] of Object.entries(view.summary)) {
      lines.push(`| ${key} | ${formatValue(value)} |`);
    }
  }
  if (view.lastError) {
    lines.push("");
    lines.push("## 最近一次失败");
    lines.push("");
    lines.push(`\`\`\`\n${view.lastError}\n\`\`\``);
  }
  lines.push("");
  lines.push("## 状态轨迹");
  lines.push("");
  for (const entry of view.history) {
    lines.push(`- ${entry.at} · ${entry.from} → ${entry.to}${entry.note ? ` — ${entry.note}` : ""}`);
  }
  return lines.join("\n");
}

// 湿实验的 observation：evidence=**observed**。
// 这是「设备执行后被观察到的事实」，不是算出来的（干实验的 observation 是 computed）。
// 模拟器执行同样落 observed —— 它执行的是真实协议引擎，只是硬件是模拟的；
// 这一点在正文里明写，读图的人必须知道数据来自模拟而非真机。
export function renderWetObservation(input: {
  title: string;
  backend: string;
  protocolHash: string;
  summary: Record<string, WetSummaryValue>;
  stepTrace: Array<{ stepId: string; action: string; entries: number }>;
  readings: Array<{ stepId: string | null; reading: unknown }>;
  note: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`# 观察 · ${input.title}`);
  lines.push("");
  lines.push(
    input.backend === "opentrons_simulate"
      ? `> 数据来源：Opentrons 官方**模拟器**（协议引擎真实执行，硬件为模拟）。protocolHash \`${input.protocolHash}\`。`
      : `> 数据来源：${input.backend}。protocolHash \`${input.protocolHash}\`。`,
  );
  if (input.note) {
    lines.push("");
    lines.push(input.note);
  }
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|------|-----|");
  for (const [key, value] of Object.entries(input.summary)) {
    lines.push(`| ${key} | ${formatValue(value)} |`);
  }
  if (input.stepTrace.length > 0) {
    lines.push("");
    lines.push("## 步骤执行轨迹");
    lines.push("");
    lines.push("| 步骤 | 动作 | run log 条目数 |");
    lines.push("|------|------|---------------|");
    for (const step of input.stepTrace) {
      lines.push(`| ${step.stepId} | ${step.action} | ${step.entries} |`);
    }
  }
  if (input.readings.length > 0) {
    lines.push("");
    lines.push("## 读数");
    lines.push("");
    for (const reading of input.readings) {
      lines.push(`- ${reading.stepId ?? "?"}: \`${JSON.stringify(reading.reading)}\``);
    }
  }
  return lines.join("\n");
}

export function renderDecision(input: {
  decision: "approve" | "reject";
  actor: string;
  at: string;
  protocolHash: string;
  experimentId: string;
  experimentTitle: string;
  steps: CompiledStep[];
  safetyChecks: SafetyCheckResult[];
  reason: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`# 决策 · ${input.decision === "approve" ? "批准执行湿实验" : "拒绝执行湿实验"}`);
  lines.push("");
  lines.push(`- 实验：\`${input.experimentId}\` · ${input.experimentTitle}`);
  lines.push(`- 决策人：**${input.actor}**`);
  lines.push(`- 时间：${input.at}`);
  // hash 是这条 decision 的核心内容：批的是**哪一版**协议。
  lines.push(`- 协议 hash：\`${input.protocolHash}\``);
  if (input.reason) lines.push(`- 理由：${input.reason}`);
  lines.push("");
  lines.push("## 批的是这些步骤");
  lines.push("");
  lines.push("| 步骤 | 动作 | 落地方式 | 说明 |");
  lines.push("|------|------|---------|------|");
  for (const step of input.steps) {
    lines.push(`| ${step.stepId} | ${step.action} | ${step.execution} | ${step.summary} |`);
  }
  lines.push("");
  lines.push("## 当时的安全门结论");
  lines.push("");
  for (const check of input.safetyChecks) {
    lines.push(`- ${check.passed ? "✅" : "❌"} ${check.check}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  return lines.join("\n");
}

export type { WetRunLogEntry };
