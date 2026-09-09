import { createHash } from "node:crypto";
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
// design → compile → safety_check → awaiting_approval → approved → executing → collect → analyze → concluded
//             ↑           │                 │              │  ↑        │  └→ compile          │       └→ iterated
//             │           └→ failed         └→ rejected    │  └────────┘（重连／崩溃恢复）      └→ failed
//             └───────────── 重新编译（compile 会清掉已有 approve）
// ```
//
// P10-d · D-10：`wet_run` 拆成了 `approved`（已批准、还没真的动手）与 `executing`
// （execute() 已经原子声明了执行权、正在跑）两个态。拆开之前 `wet_run` 一个状态要同时
// 表达「可以执行」和「正在执行」，并发的两个 execute() 读到的是同一个状态、都判断"能执行"，
// 于是双双通过—这正是 D-9 的物理执行两次问题在状态机层面的根。approved → executing 这条边
// **只能**由 execute() 内部一次 CAS（`RecordStore.update(..., { expectedRev })`）写出，
// 写不进去（rev 冲突）说明已经有别的调用先声明了，本次直接判负、绝不碰后端设备。
//
// **唯一进入 `approved` 的门是 `approve()`**。这是 AD-6 的落点：安全门全过也只是
// 允许停在 `awaiting_approval`，物理世界的操作不自动化审批。
//
// approval 是**一次性**的（D-10 第 2 点）：声明执行权（approved → executing）那一刻就把
// `approval` 消费掉（置空，原值搬进 `consumedApproval` 存档），不是等执行结束才清。
// 这样即使编排进程在 executing 期间被杀、重启后接手，`approval` 也已经不在了——
// 免审批重跑不可能，只能重新走 compile → safety_check → approve。
// `executing → compile` 这条边就是这条恢复路径：卡在 executing 的实验只能靠人显式
// 重新编译才能挣脱，execute() 自己**不会**主动把 executing 判定成 failed
// （那样会误伤另一个真的还在跑的并发请求——"卡住"和"正在跑"从状态本身分不出来，
// 分不出来就不猜，一律要求人做主）。
export const WET_EXPERIMENT_STATES = [
  "design", // 自然语言协议已记录，还没编译
  "compile", // 已编译成 Opentrons 脚本，还没过安全门
  "safety_check", // 安全门已跑且通过（不通过不会进这个状态）
  "awaiting_approval", // 等人工 approve —— 安全门通过 ≠ 可以执行
  "approved", // 已被显式 approve，还没真的开始执行（D-10：与 executing 分开）
  "executing", // execute() 已原子声明执行权，正在跑（或者：编排进程在这里挂了，等人恢复）
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
  awaiting_approval: ["approved", "rejected", "compile"],
  approved: ["executing", "failed", "compile"],
  executing: ["collect", "failed", "compile"],
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
  // P10-d · D-8：编译器在句子里看到了量纲/试剂/温度等信号，但没有任何一步/一条安全规则
  // 消费它——「用户写了但安全门没看见」。这条口径必须能被看见，见 renderWetExperiment。
  unconsumedWarnings: string[];
  safetyChecks: SafetyCheckResult[];
  safetyPassed: boolean | null;
  approval: ApprovalRecordMeta | null;
  rejection: RejectionRecordMeta | null;
  // P10-d · D-10：approval 是一次性的——声明执行权（approved → executing）那一刻就被消费
  // （approval 置空），原值搬到这里存档，供审计/正文回看「当初是谁批的」。
  consumedApproval: ApprovalRecordMeta | null;
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
  // P10-d · D-9：整个 meta（除这个字段自己）的完整性摘要，每次合法 transition() 都重算。
  // `RecordStore.update()` 是通用窄口，允许任何调用方对 metadata 做**部分**patch——
  // 如果有人绕开 WetLabLoop 直接 patch `state`/`approval`/`protocolHash` 那几个字段，
  // 这里的哈希对不上，get() 会拒绝信任这条记录（见 verifyMetaIntegrity）。
  // null = 这条记录还没被本机制保护过（老库迁移过来的历史记录）——不是「已验证安全」。
  integrityHash: string | null;
}

export interface WetExperimentView extends WetExperimentMeta {
  id: string;
  title: string;
  createdAt: string;
  record: ResearchRecord;
  // RecordStore 行级版本号（D-9 乐观并发用），不进 metadata。
  rev: number;
  // 见 integrityHash 的注释；true = 完整性核验通过或该记录尚未纳入保护（历史记录）。
  integrityOk: boolean;
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

// P10-d · D-9：并发 execute() 抢同一次执行权判负时抛这个。**继承 WetStateError**——
// HTTP 层（backend/src/server/routes/lab.ts）已经把 `WetStateError` 映射成 409，
// 这样并发冲突不需要再改一遍路由层的错误映射表就能拿到正确的 409 语义。
export class WetExecutionConflictError extends WetStateError {
  constructor(experimentId: string) {
    super("approved", "executing", "");
    this.message =
      `实验 ${experimentId.slice(0, 8)} 的执行权已经被另一次并发请求抢先声明——本次请求判负，` +
      `不会重复触碰物理/模拟设备（一次 approve 只允许一次真正执行，D-9）。`;
    this.name = "WetExecutionConflictError";
  }
}

// P10-d · D-9：`get()` 发现 metadata 完整性哈希对不上时抛这个——记录可能被绕过
// WetLabLoop、直接用 `RecordStore.update()` 部分改写了 state/approval 等字段。
// 不猜「只是无害的旁路修改」，一律拒绝信任、拒绝继续任何状态机操作。
export class RecordIntegrityError extends Error {
  constructor(experimentId: string) {
    super(
      `湿实验 ${experimentId.slice(0, 8)} 的 metadata 完整性校验失败——` +
        `state / approval / protocolHash 等字段可能被绕过状态机直接改写，拒绝信任该记录。` +
        `如需排查原始内容：RecordStore.get('${experimentId}')（不经过 WetLabLoop 的窄口）。`,
    );
    this.name = "RecordIntegrityError";
  }
}

// 递归排序 object 的 key（数组顺序保留），保证同一份数据不管构造顺序如何都得到同一段 JSON——
// 哈希要防的是「内容变了」，不能因为 key 插入顺序不同就误判。
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// 对整个 meta（除 integrityHash 自己）算 sha256。每次合法 transition() 之后都重算并存回去；
// verifyMetaIntegrity 在读的时候重算一遍做比对。
export function computeMetaIntegrityHash(meta: Omit<WetExperimentMeta, "integrityHash">): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(meta))).digest("hex");
}

// meta 缺 integrityHash（老记录，这个机制上线前就存在的）→ 视为「暂未纳入保护」，放行，
// 不是「已验证安全」。有 integrityHash 就必须对得上，对不上就是被旁路改写过。
export function verifyMetaIntegrity(meta: Partial<WetExperimentMeta>): boolean {
  if (meta.integrityHash == null) return true;
  const { integrityHash, ...rest } = meta;
  void integrityHash;
  return computeMetaIntegrityHash(rest as Omit<WetExperimentMeta, "integrityHash">) === meta.integrityHash;
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
  // P10-d · D-8：**必须显示**——「用户写了但安全门没看见」不能靠翻 JSON 才发现。
  // 放在安全门表格之前：先让人知道安全门到底看到了多少输入，再看它对看到的部分下了什么结论。
  if (view.unconsumedWarnings.length > 0) {
    lines.push("");
    lines.push("## ⚠️ 未被安全门消费的信号");
    lines.push("");
    lines.push(
      "> 编译器在协议原文里看到了这些量纲/试剂/温度类信号，但没有任何一步或任何一条安全规则" +
        "读取它们——安全门检查的是**编译产物**，看不到的东西不可能被拦截。以下不是「已核对通过」，" +
        "是「压根没被核对」。",
    );
    lines.push("");
    for (const warning of view.unconsumedWarnings) lines.push(`- ${warning}`);
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
    lines.push(
      "> 覆盖范围口径（P10-d D-8 收敛）：`chemical_compatibility` 认识中英文常见试剂名/分子式，" +
        "`volume_capacity` 是唯一全程接编译产物核对的规则；`concentration_limit` / `biosafety` " +
        "在自然语言主管线里仍然空转——协议原文里的浓度/生物安全等级描述目前不会被解析进这两条规则，" +
        "有没有漏看，看上面「未被安全门消费的信号」。",
    );
  }
  if (view.approval) {
    lines.push("");
    lines.push("## 审批");
    lines.push("");
    lines.push(`- ✅ ${view.approval.actor} 于 ${view.approval.at} 批准`);
    lines.push(`- 批准的协议 hash: \`${view.approval.protocolHash}\``);
    lines.push(`- decision record: \`${view.approval.decisionRecordId}\``);
    if (view.approval.note) lines.push(`- 备注：${view.approval.note}`);
  } else if (view.consumedApproval) {
    // D-10：approval 在声明执行权那一刻就被消费（置空），这里是审计存档——
    // 「当初是谁批的」不能因为已经开始执行就从正文里消失。
    lines.push("");
    lines.push("## 审批（已消费）");
    lines.push("");
    lines.push(`- ✅ ${view.consumedApproval.actor} 于 ${view.consumedApproval.at} 批准`);
    lines.push(`- 批准的协议 hash: \`${view.consumedApproval.protocolHash}\``);
    lines.push(`- decision record: \`${view.consumedApproval.decisionRecordId}\``);
    lines.push(
      "> 该批准已在声明执行权时一次性消费：这条实验若要重跑，必须重新 compile → safety_check → approve。",
    );
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
