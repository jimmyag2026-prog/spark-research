// C1 · 远端算力的三轴状态机（CB-1）。
//
// **零 IO、零仓库内 import**（设计 §1.1.1）：这一层只是一张表加一个纯函数，
// 谁都可以拿它推导投影（/api/compute/machine 由 approvalGate()/dispatchGate() 推导，
// 不许手写；AD-12 ③）。
//
// 三轴的理由（COMPUTE_DESIGN §1.5 + 设计 §1.1.2）：
//   execution   任务本身跑到哪了
//   delivery    结果收割到哪了——远端跑完 ≠ 产物已经到手
//   resource    远端资源（卷/工作目录）还在不在
// 外加一个 `recoverable` 位：远端是否仍持有产物的**唯一**可恢复副本。
//
// 相对上游的一处偏离（设计 §1.1.2）：`awaiting_approval → queued` 中间插入 `approved`。
// 「批了」与「动手了」必须是两个状态，approval 在 `approved → queued` 那一次转移里被
// **一次性消费**——崩溃重启后 approval 已经不在，无法凭空重派（与湿实验 D-10 同构）。

export const EXECUTION_STATES = [
  "planned",
  "awaiting_approval",
  "approved",
  "rejected",
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const DELIVERY_STATES = ["none", "pending", "complete", "rejected", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const RESOURCE_STATES = ["none", "starting", "active", "closed", "unknown"] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const LIFECYCLE_EVENTS = [
  "review",
  "approve",
  "reject",
  "dispatch",
  "start",
  "run",
  "succeed",
  "fail",
  "timeout",
  "cancel",
  "interrupt",
  "recover",
  "deliver",
  "deliver_ok",
  "deliver_reject",
  "deliver_fail",
  "retry_delivery",
  "resource_start",
  "resource_active",
  "close",
  "lose",
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

const EXECUTION_TERMINAL: readonly ExecutionState[] = [
  "rejected",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
];

export interface LifecycleState {
  execution: ExecutionState;
  delivery: DeliveryState;
  resource: ResourceState;
  /** 远端仍持有唯一可恢复产物副本；为 true 时 close 必须抛错（L-4）。 */
  recoverable: boolean;
}

export interface TransitionContext {
  /** plan.approvalRequired 的派生值（L-3）；dispatch 从 planned 直出只在 false 时合法（L-2）。 */
  approvalRequired: boolean;
  /** dispatch 时必须携带且 digest 相符（L-2）；其余事件忽略。 */
  approval?: { planDigest: string } | null;
  planDigest: string;
  /** recover 后 adapter 裁定的去向。 */
  recoverOutcome?: "running" | "succeeded" | "failed";
}

// 三张转移表。**这是唯一真源**：测试用一张独立手写的期望表跟它对撞（L-7），
// 任何人往这里偷加一条边（比如 planned --dispatch--> queued 的无条件版本）都会红。
export const EXECUTION_TRANSITIONS: Readonly<
  Record<ExecutionState, Partial<Record<LifecycleEvent, ExecutionState>>>
> = Object.freeze({
  // planned --dispatch--> queued 只在 approvalRequired === false 时合法（守卫在 transition() 里，L-2）。
  planned: { review: "awaiting_approval", dispatch: "queued", cancel: "cancelled" },
  awaiting_approval: { approve: "approved", reject: "rejected", cancel: "cancelled" },
  // approved --dispatch--> queued 必须携带未消费且 digest 相符的 approval（L-2）。
  approved: { dispatch: "queued", cancel: "cancelled" },
  rejected: {},
  queued: { start: "starting", fail: "failed", cancel: "cancelled" },
  starting: { run: "running", fail: "failed", timeout: "timed_out", cancel: "cancelled", interrupt: "interrupted" },
  running: {
    succeed: "succeeded",
    fail: "failed",
    timeout: "timed_out",
    cancel: "cancelled",
    interrupt: "interrupted",
  },
  succeeded: {},
  failed: {},
  timed_out: {},
  cancelled: {},
  // recover 的去向由 adapter 裁定（ctx.recoverOutcome）；表里写 running 只是占位，
  // 合法去向集合是 {running, succeeded, failed}，见 transition()。
  interrupted: { recover: "running", fail: "failed", cancel: "cancelled" },
});

export const DELIVERY_TRANSITIONS: Readonly<
  Record<DeliveryState, Partial<Record<LifecycleEvent, DeliveryState>>>
> = Object.freeze({
  // L-5：deliver 只能在 execution 进终态之后发（守卫在 transition() 里）。
  none: { deliver: "pending" },
  pending: { deliver_ok: "complete", deliver_reject: "rejected", deliver_fail: "failed" },
  complete: {},
  rejected: {},
  failed: { retry_delivery: "pending" },
});

export const RESOURCE_TRANSITIONS: Readonly<
  Record<ResourceState, Partial<Record<LifecycleEvent, ResourceState>>>
> = Object.freeze({
  none: { resource_start: "starting" },
  starting: { resource_active: "active", close: "closed", lose: "unknown" },
  active: { close: "closed", lose: "unknown" },
  closed: {},
  unknown: { close: "closed" },
});

export class ComputeStateError extends Error {
  constructor(
    readonly from: LifecycleState,
    readonly event: LifecycleEvent,
    reason: string,
  ) {
    super(
      `算力任务状态 (execution=${from.execution}, delivery=${from.delivery}, resource=${from.resource}) ` +
        `不接受事件 '${event}'：${reason}`,
    );
    this.name = "ComputeStateError";
  }
}

export function initialLifecycle(): LifecycleState {
  return { execution: "planned", delivery: "none", resource: "none", recoverable: false };
}

export function isExecutionTerminal(s: ExecutionState): boolean {
  return EXECUTION_TERMINAL.includes(s);
}

/** 这两个函数是 HTTP `/api/compute/machine` 的推导源，不许手写投影（AD-12 ③）。 */
export function approvalGate(): { from: "awaiting_approval"; to: "approved"; requires: ["actor"] } {
  return { from: "awaiting_approval", to: "approved", requires: ["actor"] };
}

export function dispatchGate(): {
  from: "approved";
  to: "queued";
  consumesApproval: true;
  verifies: ["planDigest", "uploads"];
} {
  return { from: "approved", to: "queued", consumesApproval: true, verifies: ["planDigest", "uploads"] };
}

type Axis = "execution" | "delivery" | "resource";

// 每个事件**恰好属于一根轴**（三张表的 key 集合互不相交）——这条性质由测试对撞，
// 不靠自觉：事件名一旦被两根轴同时认领，转移就会变成「顺手也改了另一根轴」的隐式行为。
const DELIVERY_EVENTS: readonly LifecycleEvent[] = [
  "deliver",
  "deliver_ok",
  "deliver_reject",
  "deliver_fail",
  "retry_delivery",
];
const RESOURCE_EVENTS: readonly LifecycleEvent[] = ["resource_start", "resource_active", "close", "lose"];

export function axisOf(event: LifecycleEvent): Axis {
  if (DELIVERY_EVENTS.includes(event)) return "delivery";
  if (RESOURCE_EVENTS.includes(event)) return "resource";
  return "execution";
}

/**
 * 纯函数：非法转移一律 throw ComputeStateError；**不做顺手纠正**（P5 纪律 / L-1）。
 *
 * 守卫（不变式）就在这里，不在调用方——调用方会有很多个，守卫只该有一份：
 *   L-2 dispatch 两条入边：approved（携带 digest 相符的未消费 approval）
 *       或 planned（仅当 approvalRequired === false）
 *   L-4 recoverable === true 时不许 close
 *   L-5 delivery 离开 none 必须在 execution 终态之后
 *   L-6 execution 终态后 recoverable 只能由 delivery 终态（complete / rejected）置 false
 */
export function transition(
  state: LifecycleState,
  event: LifecycleEvent,
  ctx: TransitionContext,
): LifecycleState {
  const axis = axisOf(event);

  if (axis === "execution") {
    const next = EXECUTION_TRANSITIONS[state.execution][event];
    if (!next) {
      throw new ComputeStateError(state, event, `execution=${state.execution} 上没有这条边`);
    }
    if (event === "dispatch") {
      if (state.execution === "planned") {
        // L-2 的第二条入边：只有「不需要审批」的 plan 才能从 planned 直出。
        if (ctx.approvalRequired) {
          throw new ComputeStateError(
            state,
            event,
            "这份 plan 需要人工审批（approvalRequired=true），必须先 review → approve；" +
              "planned → queued 只对 approvalRequired=false 的 plan 开放（L-2）",
          );
        }
      } else {
        // L-2 的第一条入边：必须携带未消费且与当前 plan digest 相符的 approval。
        if (!ctx.approval) {
          throw new ComputeStateError(
            state,
            event,
            "处于 approved 但没有未消费的审批记录——拒绝派发（approval 已被消费或从未存在）",
          );
        }
        if (ctx.approval.planDigest !== ctx.planDigest) {
          throw new ComputeStateError(
            state,
            event,
            `审批的是 plan ${ctx.approval.planDigest.slice(0, 12)}，当前 plan 是 ` +
              `${ctx.planDigest.slice(0, 12)}——plan 在审批之后变了，必须重新 approve`,
          );
        }
      }
    }
    let execution = next;
    if (event === "recover") {
      const outcome = ctx.recoverOutcome ?? "running";
      if (outcome !== "running" && outcome !== "succeeded" && outcome !== "failed") {
        throw new ComputeStateError(state, event, `recoverOutcome='${outcome}' 不是合法去向`);
      }
      execution = outcome;
    }
    // 进入非 cancelled 的终态时，产物此刻只在远端/job 目录里 → 标记为可恢复，
    // 直到 delivery 走完（L-6）。cancelled 没有产物，不置位。
    const recoverable =
      event === "interrupt" || (isExecutionTerminal(execution) && execution !== "cancelled" && execution !== "rejected")
        ? true
        : state.recoverable;
    return { ...state, execution, recoverable };
  }

  if (axis === "delivery") {
    const next = DELIVERY_TRANSITIONS[state.delivery][event];
    if (!next) {
      throw new ComputeStateError(state, event, `delivery=${state.delivery} 上没有这条边`);
    }
    if (event === "deliver" && !isExecutionTerminal(state.execution)) {
      throw new ComputeStateError(
        state,
        event,
        `execution=${state.execution} 还没到终态，收割无从谈起（L-5）`,
      );
    }
    // L-6：只有 delivery 走到 complete（产物已落地）或 rejected（人明确不要了）
    // 才允许把 recoverable 放下——这两种情况下远端副本不再是唯一副本。
    const recoverable = next === "complete" || next === "rejected" ? false : state.recoverable;
    return { ...state, delivery: next, recoverable };
  }

  const next = RESOURCE_TRANSITIONS[state.resource][event];
  if (!next) {
    throw new ComputeStateError(state, event, `resource=${state.resource} 上没有这条边`);
  }
  if (event === "close" && state.recoverable) {
    throw new ComputeStateError(
      state,
      event,
      "不许关掉持有唯一可恢复产物副本的资源（L-4）：先 collect（deliver_ok）或显式放弃（deliver_reject）",
    );
  }
  return { ...state, resource: next };
}
