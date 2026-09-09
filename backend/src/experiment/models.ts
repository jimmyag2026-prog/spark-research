import type { ResearchRecord } from "../project/models";

// 干实验闭环状态机（DESIGN 域 B3）。
//
// 设计文档写的是 `design → dry_run → collect → analyze → iterate | conclude`。
// 落地时把 `iterate` / `conclude` 实现为两个**终态**而不是动作名：
// iterate 的语义是「这条实验到此为止，另起一条」——新实验是新的 record，
// 用 `supersedes` 边连回旧的（AD-1 的证据图纪律，见 devlog D3）。
export const EXPERIMENT_STATES = [
  "design", // 参数与假设已定，还没跑
  "dry_run", // 仿真已提交，任务在别的进程里跑
  "collect", // 产出已回收进 artifact
  "analyze", // 已产出 observation
  "concluded", // 终态：得出结论
  "iterated", // 终态：改参数另起一条实验
  "failed", // 仿真失败（可重试回 dry_run）
] as const;
export type ExperimentState = (typeof EXPERIMENT_STATES)[number];

// 合法转移表就是状态机本身：不在表里的一律拒绝。
export const LEGAL_TRANSITIONS: Readonly<Record<ExperimentState, readonly ExperimentState[]>> = {
  design: ["dry_run"],
  dry_run: ["collect", "failed"],
  collect: ["analyze"],
  analyze: ["concluded", "iterated"],
  failed: ["dry_run"],
  concluded: [],
  iterated: [],
};

export const TERMINAL_STATES: readonly ExperimentState[] = ["concluded", "iterated"];

export function canTransition(from: ExperimentState, to: ExperimentState): boolean {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

export interface TransitionEntry {
  from: ExperimentState;
  to: ExperimentState;
  at: string;
  note: string | null;
}

export type SummaryValue = string | number | boolean | null;

// experiment record 的 metadata 形态。写回一律走 RecordStore.update() 窄口
//（P4 定的口径：状态是生命周期字段，身份字段不可变）。
export interface ExperimentMeta {
  kind: "experiment";
  mode: "dry";
  state: ExperimentState;
  platform: string;
  simKind: string;
  params: Record<string, unknown>;
  hypothesis: string | null;
  runId: string | null;
  specHash: string | null;
  // 第几次提交仿真（含重试）。
  attempts: number;
  // 第几轮迭代（iterate 出来的新实验 +1）。
  iteration: number;
  parentExperimentId: string | null;
  history: TransitionEntry[];
  timestamps: Partial<Record<ExperimentState, string>>;
  summary: Record<string, SummaryValue> | null;
  artifactRecordIds: string[];
  observationId: string | null;
  conclusionId: string | null;
  lastError: string | null;
}

export interface ExperimentView extends ExperimentMeta {
  id: string;
  title: string;
  createdAt: string;
  record: ResearchRecord;
}

export class ExperimentStateError extends Error {
  readonly from: ExperimentState;
  readonly to: ExperimentState;

  constructor(from: ExperimentState, to: ExperimentState, hint = "") {
    super(
      `非法状态转移 ${from} → ${to}（${from} 只能转到 ${
        (LEGAL_TRANSITIONS[from] ?? []).join(" / ") || "无（终态）"
      }）${hint ? `。${hint}` : ""}`,
    );
    this.name = "ExperimentStateError";
    this.from = from;
    this.to = to;
  }
}

export class ExperimentNotFoundError extends Error {
  constructor(ref: string) {
    super(`找不到 experiment record '${ref}'`);
    this.name = "ExperimentNotFoundError";
  }
}

export function isExperimentState(value: unknown): value is ExperimentState {
  return typeof value === "string" && (EXPERIMENT_STATES as readonly string[]).includes(value);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return Math.abs(value) >= 1e-4 && Math.abs(value) < 1e7 ? value.toFixed(6) : value.toExponential(4);
  }
  return String(value);
}

// experiment record 的正文由**代码**渲染（同 P4 的 novelty 报告）：
// 状态、参数、摘要都是确定的，让模型写正文等于把这些也交出去。
export function renderExperiment(view: Omit<ExperimentView, "record">): string {
  const lines: string[] = [];
  lines.push(`# 实验 · ${view.title}`);
  lines.push("");
  lines.push(`- 状态：**${view.state}**`);
  lines.push(`- 平台：${view.platform} / ${view.simKind}`);
  lines.push(`- 迭代：第 ${view.iteration} 轮 · 提交 ${view.attempts} 次`);
  if (view.runId) lines.push(`- run: \`${view.runId}\``);
  if (view.specHash) lines.push(`- specHash: \`${view.specHash}\``);
  if (view.hypothesis) {
    lines.push("");
    lines.push(`## 假设`);
    lines.push(view.hypothesis);
  }
  lines.push("");
  lines.push("## 参数");
  lines.push("");
  lines.push("| 参数 | 值 |");
  lines.push("|------|-----|");
  for (const [key, value] of Object.entries(view.params).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${key} | ${formatValue(value)} |`);
  }
  if (view.summary && Object.keys(view.summary).length > 0) {
    lines.push("");
    lines.push("## 结果摘要");
    lines.push("");
    lines.push("| 指标 | 值 |");
    lines.push("|------|-----|");
    for (const [key, value] of Object.entries(view.summary)) {
      lines.push(`| ${key} | ${formatValue(value)} |`);
    }
  }
  if (view.lastError) {
    lines.push("");
    lines.push(`## 最近一次失败`);
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

export function renderObservation(
  title: string,
  summary: Record<string, SummaryValue>,
  files: { filename: string; role: string }[],
  note: string | null,
): string {
  const lines: string[] = [];
  lines.push(`# 观察 · ${title}`);
  if (note) {
    lines.push("");
    lines.push(note);
  }
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|------|-----|");
  for (const [key, value] of Object.entries(summary)) {
    lines.push(`| ${key} | ${formatValue(value)} |`);
  }
  if (files.length > 0) {
    lines.push("");
    lines.push("产出文件：");
    for (const file of files) lines.push(`- \`${file.filename}\`（${file.role}）`);
  }
  return lines.join("\n");
}
