// Replan 循环（v0.4 P13 波次 W3-a；方案 §4.3.2 / v0.3 文档 §4.3.2 的原始伪代码）。
//
// contract.ts（W2-b 交付）钉死了「契约怎么判」——三条并行停机条件里的 `done`/`no_progress`
// 两条，以及 `EvidenceQuery` 这扇只读窗口。本文件钉死「谁来跑轮次循环」：
//
//   round = 0
//   while round < maxRounds:
//       plan         = planner(goal, contract.progress(), lastObservations)
//       outcomes     = execute(plan)              # 走 W2-a 的真子代理（runSubAgentOfType）
//       observations = distill(outcomes)          # 结构化对象，不是 output.slice(0,200)
//       evaluation   = evaluateRound(contract, guard, query)
//       if evaluation.stopReason: break
//       round += 1
//
// 三条并行停机条件全部用 W2-b 的 `evaluateRound()`（done / no_progress）加调用方自己持有的
// 预算判据（budget，见 `ReplanLoopDeps.budgetExceeded`）——本文件不重新发明其中任何一条：
// `done`/`no_progress` 完全交给 `evaluateRound()`，`budget` 由调用方判但汇总进同一个
// `StopReason` 类型，三者共享同一套「停了就如实报告，不假装完成」的文案（`describeStop`）。
//
// `planner`/`execute` 两个函数本身**不在本文件里**——它们需要 LLM + 真子代理依赖
// （orchestrator.ts 才有），本文件只钉死「这三个函数按什么顺序、用什么数据形状接起来」。

import type { RecordType } from "../project/models";
import type { SubAgentResult, SubAgentStopReason, SubAgentType } from "./sub_agent";
import type { ToolDenialReason } from "./toolbus";
import {
  evaluateRound,
  type ContractReport,
  type EvidenceQuery,
  type EvidenceSnapshot,
  type NoProgressGuard,
  type ResearchContract,
  type RoundEvaluation,
  type StopReason,
} from "./contract";

// ── distill：子代理产出 → 结构化 observation ────────────────────────────────────
//
// 评审骂的是「措辞过强的 research agent」——喂给下一轮 planner 的东西如果只是
// `outcome.output.slice(0, 200)`，那这句吐槽就是对的：一段被腰斩的自然语言，decision-making
// 没有任何抓手。这里的 `Observation` 反过来：命中数（新增 record，按类型分桶）、
// 子代理自己的 `stopReason`（denied/budget/timeout/error 各自意味着不同的下一步动作）、
// 工具调用的被拒/失败计数、以及（仅在 `stopReason === "error"` 时）原始错误信息——
// 全部是可以被 planner 的下一次决策直接消费的字段，不是一句拍扁的话。
// `finalText` 保留**完整正文**（不截断）：任务产出必须能回流决策，腰斩一次就是弄丢一次证据。
export interface Observation {
  taskId: string;
  subagentType: SubAgentType;
  /** 子代理这一次运行的真实结束原因——如实回流，不是「看起来跑完了」。 */
  stopReason: SubAgentStopReason;
  toolCallCount: number;
  /** 被 ToolBus 拒绝的调用数（not_granted / withheld / budget_exceeded 三种原因之一）。 */
  deniedCount: number;
  deniedReasons: ToolDenialReason[];
  /** 工具真的执行了但返回 `ok:false` 的次数（区别于「被拒绝」）。 */
  failedToolCount: number;
  /** 本轮相对 round 开始前的证据图快照新增的 record id——planner 判「有没有新证据」的唯一输入。 */
  newRecordIds: string[];
  newRecordCountByType: Partial<Record<RecordType, number>>;
  /** stopReason === "error" 时的原始错误信息；其余情况 undefined。 */
  errorMessage?: string;
  degraded: boolean;
  /** 子代理这一轮的完整输出正文——不截断。 */
  finalText: string;
}

/**
 * 单个子代理运行结果 → 结构化 observation。`before` 是这次子代理开始执行**之前**的
 * 证据图快照（由调用方在 execute() 里、真正调子代理之前拍下），`q` 是当前（子代理跑完后）
 * 的证据图——两者的 record id 集合差就是这次运行的「新证据」，与 contract.ts 的
 * `NoProgressGuard`/`newSince` 同一套「按集合差，不按时间戳」的纪律，不重新发明判据。
 */
export function distillObservation(
  taskId: string,
  subagentType: SubAgentType,
  result: SubAgentResult,
  before: EvidenceSnapshot,
  q: EvidenceQuery,
): Observation {
  const newRecords = q.newSince(before);
  const newRecordCountByType: Partial<Record<RecordType, number>> = {};
  for (const r of newRecords) {
    newRecordCountByType[r.type] = (newRecordCountByType[r.type] ?? 0) + 1;
  }

  let deniedCount = 0;
  let failedToolCount = 0;
  const deniedReasons: ToolDenialReason[] = [];
  for (const entry of result.toolCalls) {
    if (entry.denied) {
      deniedCount += 1;
      deniedReasons.push(entry.denied);
    } else if (!entry.ok) {
      failedToolCount += 1;
    }
  }

  return {
    taskId,
    subagentType,
    stopReason: result.stopReason,
    toolCallCount: result.toolCalls.length,
    deniedCount,
    deniedReasons,
    failedToolCount,
    newRecordIds: newRecords.map((r) => r.id),
    newRecordCountByType,
    errorMessage: result.stopReason === "error" ? result.error : undefined,
    degraded: result.degraded === true,
    finalText: result.finalText,
  };
}

// ── planner / execute 的接口形状（实现在 orchestrator.ts，本文件只钉死签名） ──────

export interface RoundPlanItem {
  id: string;
  subagentType: SubAgentType;
  /** 给该子代理的具体指令——planner 应结合 `report.incomplete` 与 `lastObservations` 生成。 */
  task: string;
}

export type RoundPlan = RoundPlanItem[];

export interface PlannerContext {
  goal: string;
  /** `contract.progress()` 的落地——即 `contract.evaluate(q)`，每轮重新对图跑一遍，不缓存。 */
  report: ContractReport;
  /** 上一轮 distill() 产出的 observation；第一轮为空数组（不是 null——「没有」用空集合表达）。 */
  lastObservations: Observation[];
  /** 从 0 开始的轮次号（即将执行的这一轮）。 */
  round: number;
}

export type Planner = (ctx: PlannerContext) => Promise<RoundPlan>;

export interface RoundOutcome {
  item: RoundPlanItem;
  result: SubAgentResult;
}

/** 执行一整轮 plan——通常是「对 plan 里每一项调 runSubAgentOfType()」，具体并发/串行策略由调用方决定。 */
export type RoundExecutor = (plan: RoundPlan) => Promise<RoundOutcome[]>;

// ── 循环本体 ─────────────────────────────────────────────────────────────────

export interface RoundLogEntry {
  round: number;
  plan: RoundPlan;
  observations: Observation[];
  evaluation: RoundEvaluation;
}

export interface ReplanLoopDeps {
  goal: string;
  contract: ResearchContract;
  q: EvidenceQuery;
  guard: NoProgressGuard;
  planner: Planner;
  execute: RoundExecutor;
  /** 安全阀：即便预算/停机条件配置得很宽松也不允许无限循环（与 sub_agent.ts 的
   * DEFAULT_MAX_ROUNDS 同一类考量，命中时视为 "budget"——宁可报「没做完」，不假装完成）。 */
  maxRounds: number;
  /**
   * 第三条并行停机条件：预算。判据在调用方（W2-b devlog 原话：「预算状态由调用方持有，
   * 本文件只需要保证 StopReason 里有这个值可用」）——本文件只在 `evaluateRound()` 判定
   * 「还没有 done/no_progress」之后才去问一次，`done` 优先于 `budget`（哪怕预算同时也超了，
   * 一次成功的收官不该被误报成「被迫停下」，与 contract.ts 里 `allDone` 优先于
   * `noProgress` 的同一条纪律）。
   */
  budgetExceeded?: () => boolean;
  /** 每轮结束后的旁路回调（供调用方写执行日志/UI），不影响循环本身的判据。 */
  onRound?: (entry: RoundLogEntry) => void;
}

export interface ReplanLoopResult {
  rounds: RoundLogEntry[];
  /** "done" | "no_progress"（均来自 evaluateRound()）| "budget"（安全阀或调用方预算判据）。 */
  stopReason: StopReason;
  finalReport: ContractReport;
}

/**
 * replan 循环本体：把伪代码原样实现。**不自己判 done/no_progress**——那两条完全交给
 * `evaluateRound()`（见文件顶部大段注释），本函数只负责按顺序把 planner/execute/distill/
 * evaluateRound 接起来，并汇总 budget 这第三条停机条件。
 */
export async function runReplanLoop(deps: ReplanLoopDeps): Promise<ReplanLoopResult> {
  const { goal, contract, q, guard, planner, execute, maxRounds } = deps;
  const rounds: RoundLogEntry[] = [];
  let lastObservations: Observation[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const report = contract.evaluate(q);
    const plan = await planner({ goal, report, lastObservations, round });

    const before = q.snapshot();
    const outcomes = await execute(plan);
    const observations = outcomes.map(({ item, result }) => distillObservation(item.id, item.subagentType, result, before, q));
    lastObservations = observations;

    // 三条并行停机条件之二（done / no_progress）——不绕开、不自己另判。
    const evaluation = evaluateRound(contract, guard, q);
    const entry: RoundLogEntry = { round, plan, observations, evaluation };
    rounds.push(entry);
    deps.onRound?.(entry);

    if (evaluation.stopReason) {
      return { rounds, stopReason: evaluation.stopReason, finalReport: evaluation.report };
    }
    // 第三条：budget。done 已经在上面处理完（evaluation.stopReason==="done" 会先 return），
    // 所以走到这里时 report 一定还没完成——预算耗尽时报 "budget"，不是笼统的「未完成」。
    if (deps.budgetExceeded?.()) {
      return { rounds, stopReason: "budget", finalReport: evaluation.report };
    }
  }

  // 命中安全阀（maxRounds）：宁可报「预算内没做完」，不假装完成——与 sub_agent.ts 的
  // DEFAULT_MAX_ROUNDS 同一条纪律，归入同一个 "budget" 语义（跑了多少轮 vs 花了多少钱，
  // 触发条件不同，但对使用者而言都是「没能在预算内做完」）。
  const finalReport = contract.evaluate(q);
  return { rounds, stopReason: "budget", finalReport };
}
