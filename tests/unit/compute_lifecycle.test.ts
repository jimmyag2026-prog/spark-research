import { describe, expect, test } from "bun:test";
import {
  ComputeStateError,
  DELIVERY_STATES,
  EXECUTION_STATES,
  LIFECYCLE_EVENTS,
  RESOURCE_STATES,
  approvalGate,
  axisOf,
  dispatchGate,
  initialLifecycle,
  isExecutionTerminal,
  transition,
  type DeliveryState,
  type ExecutionState,
  type LifecycleEvent,
  type LifecycleState,
  type ResourceState,
  type TransitionContext,
} from "../../backend/src/compute/lifecycle";

// CB-1 · 三轴状态机的不变式 L-1…L-7（设计 §1.1.2）。
//
// **这个文件里的期望表是独立手写的**，不是从 lifecycle.ts 的表推导出来的。
// 那正是它的价值：谁往 EXECUTION_TRANSITIONS 里偷加一条边（比如无条件的
// planned --dispatch--> queued），下面的穷举对撞就会红。从真源推导出来的期望表
// 永远是绿的，那种测试只是把实现抄了一遍。

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

function ctx(over: Partial<TransitionContext> = {}): TransitionContext {
  return { approvalRequired: true, planDigest: DIGEST, approval: null, ...over };
}

function state(over: Partial<LifecycleState> = {}): LifecycleState {
  return { ...initialLifecycle(), ...over };
}

// ── 独立手写的期望表 ────────────────────────────────────────────────────
// 形式：[from, event, to]。守卫（需要额外条件才合法的边）单列在 GUARDED 里。
const EXPECTED_EXECUTION: Array<[ExecutionState, LifecycleEvent, ExecutionState]> = [
  ["planned", "review", "awaiting_approval"],
  ["planned", "cancel", "cancelled"],
  ["awaiting_approval", "approve", "approved"],
  ["awaiting_approval", "reject", "rejected"],
  ["awaiting_approval", "cancel", "cancelled"],
  ["approved", "cancel", "cancelled"],
  ["queued", "start", "starting"],
  ["queued", "fail", "failed"],
  ["queued", "cancel", "cancelled"],
  ["starting", "run", "running"],
  ["starting", "fail", "failed"],
  ["starting", "timeout", "timed_out"],
  ["starting", "cancel", "cancelled"],
  ["starting", "interrupt", "interrupted"],
  ["running", "succeed", "succeeded"],
  ["running", "fail", "failed"],
  ["running", "timeout", "timed_out"],
  ["running", "cancel", "cancelled"],
  ["running", "interrupt", "interrupted"],
  ["interrupted", "recover", "running"],
  ["interrupted", "fail", "failed"],
  ["interrupted", "cancel", "cancelled"],
];

// 两条 dispatch 入边**都**带守卫，所以不在上表里（上表是「无条件合法」的边）。
const GUARDED_DISPATCH: Array<{ from: ExecutionState; ctx: TransitionContext; to: ExecutionState }> = [
  { from: "planned", ctx: ctx({ approvalRequired: false }), to: "queued" },
  { from: "approved", ctx: ctx({ approval: { planDigest: DIGEST } }), to: "queued" },
];

const EXPECTED_DELIVERY: Array<[DeliveryState, LifecycleEvent, DeliveryState]> = [
  ["pending", "deliver_ok", "complete"],
  ["pending", "deliver_reject", "rejected"],
  ["pending", "deliver_fail", "failed"],
  ["failed", "retry_delivery", "pending"],
];
// none --deliver--> pending 带守卫（execution 必须已终态，L-5）。

const EXPECTED_RESOURCE: Array<[ResourceState, LifecycleEvent, ResourceState]> = [
  ["none", "resource_start", "starting"],
  ["starting", "resource_active", "active"],
  ["starting", "lose", "unknown"],
  ["active", "lose", "unknown"],
];
// 所有 close 边带守卫（recoverable 必须是 false，L-4）。
const GUARDED_CLOSE: ResourceState[] = ["starting", "active", "unknown"];

describe("L-7 · 三轴 × 事件的穷举对撞（合法集合 = 独立手写的显式表）", () => {
  test("execution 轴：笛卡尔积里除了显式表与两条带守卫的 dispatch 边，全部必须抛 ComputeStateError", () => {
    const legal = new Map<string, ExecutionState>();
    for (const [from, event, to] of EXPECTED_EXECUTION) legal.set(`${from}|${event}`, to);

    let checked = 0;
    for (const from of EXECUTION_STATES) {
      for (const event of LIFECYCLE_EVENTS) {
        if (axisOf(event) !== "execution") continue;
        checked += 1;
        const key = `${from}|${event}`;
        const before = state({ execution: from });
        if (legal.has(key)) {
          expect(transition(before, event, ctx()).execution).toBe(legal.get(key)!);
          continue;
        }
        const guarded = GUARDED_DISPATCH.find((g) => g.from === from && event === "dispatch");
        if (guarded) {
          // 带守卫的边：守卫满足时合法，守卫不满足时必须抛（不许「顺手纠正」）。
          expect(transition(before, event, guarded.ctx).execution).toBe(guarded.to);
          expect(() => transition(before, event, ctx())).toThrow(ComputeStateError);
          continue;
        }
        expect(() => transition(before, event, ctx({ approvalRequired: false }))).toThrow(ComputeStateError);
      }
    }
    // 12 个 execution 状态 × 12 个 execution 事件
    expect(checked).toBe(EXECUTION_STATES.length * 12);
  });

  test("delivery 轴：同样穷举，deliver 只在 execution 终态时合法（L-5）", () => {
    const legal = new Map<string, DeliveryState>();
    for (const [from, event, to] of EXPECTED_DELIVERY) legal.set(`${from}|${event}`, to);

    for (const execution of EXECUTION_STATES) {
      for (const from of DELIVERY_STATES) {
        for (const event of LIFECYCLE_EVENTS) {
          if (axisOf(event) !== "delivery") continue;
          const before = state({ execution, delivery: from });
          const key = `${from}|${event}`;
          if (event === "deliver" && from === "none") {
            if (isExecutionTerminal(execution)) {
              expect(transition(before, event, ctx()).delivery).toBe("pending");
            } else {
              expect(() => transition(before, event, ctx())).toThrow(ComputeStateError);
            }
            continue;
          }
          if (legal.has(key)) {
            expect(transition(before, event, ctx()).delivery).toBe(legal.get(key)!);
          } else {
            expect(() => transition(before, event, ctx())).toThrow(ComputeStateError);
          }
        }
      }
    }
  });

  test("resource 轴：同样穷举，close 在 recoverable=true 时必须抛（L-4）", () => {
    const legal = new Map<string, ResourceState>();
    for (const [from, event, to] of EXPECTED_RESOURCE) legal.set(`${from}|${event}`, to);

    for (const from of RESOURCE_STATES) {
      for (const event of LIFECYCLE_EVENTS) {
        if (axisOf(event) !== "resource") continue;
        for (const recoverable of [false, true]) {
          const before = state({ resource: from, recoverable });
          const key = `${from}|${event}`;
          if (event === "close") {
            if (!GUARDED_CLOSE.includes(from)) {
              expect(() => transition(before, event, ctx())).toThrow(ComputeStateError);
            } else if (recoverable) {
              expect(() => transition(before, event, ctx())).toThrow(/L-4/);
            } else {
              expect(transition(before, event, ctx()).resource).toBe("closed");
            }
            continue;
          }
          if (legal.has(key)) {
            expect(transition(before, event, ctx()).resource).toBe(legal.get(key)!);
          } else {
            expect(() => transition(before, event, ctx())).toThrow(ComputeStateError);
          }
        }
      }
    }
  });

  test("每个事件恰好属于一根轴（轴之间没有暗中共享的事件名）", () => {
    const axes = LIFECYCLE_EVENTS.map(axisOf);
    expect(axes.filter((a) => a === "execution")).toHaveLength(12);
    expect(axes.filter((a) => a === "delivery")).toHaveLength(5);
    expect(axes.filter((a) => a === "resource")).toHaveLength(4);
    expect(LIFECYCLE_EVENTS.length).toBe(21);
  });
});

describe("L-2 · dispatch 的两条入边（审批消费是状态机本体，不是接线面的礼貌）", () => {
  test("需要审批的 plan 不许 planned → queued（**这是本 lane 最重要的一条断言**）", () => {
    expect(() => transition(state(), "dispatch", ctx({ approvalRequired: true }))).toThrow(ComputeStateError);
    expect(() => transition(state(), "dispatch", ctx({ approvalRequired: true }))).toThrow(/L-2/);
  });

  test("不需要审批的 plan 可以 planned → queued", () => {
    expect(transition(state(), "dispatch", ctx({ approvalRequired: false })).execution).toBe("queued");
  });

  test("approved 但 approval 已被消费（null）→ 拒绝派发", () => {
    const before = state({ execution: "approved" });
    expect(() => transition(before, "dispatch", ctx({ approval: null }))).toThrow(/没有未消费的审批记录/);
  });

  test("approval 的 digest 与当前 plan 不符 → 拒绝派发（plan 在审批之后变了）", () => {
    const before = state({ execution: "approved" });
    expect(() => transition(before, "dispatch", ctx({ approval: { planDigest: OTHER_DIGEST } }))).toThrow(
      /审批之后变了/,
    );
  });

  test("approvalRequired=false 也不能让 approved 绕过 approval 校验", () => {
    const before = state({ execution: "approved" });
    expect(() => transition(before, "dispatch", ctx({ approvalRequired: false, approval: null }))).toThrow(
      ComputeStateError,
    );
  });
});

describe("L-4 / L-6 · recoverable 的置位与放下", () => {
  test("非 cancelled 的终态把 recoverable 置 true（产物此刻只在远端）", () => {
    const running = state({ execution: "running" });
    expect(transition(running, "succeed", ctx()).recoverable).toBe(true);
    expect(transition(running, "fail", ctx()).recoverable).toBe(true);
    expect(transition(running, "timeout", ctx()).recoverable).toBe(true);
    expect(transition(running, "interrupt", ctx()).recoverable).toBe(true);
    expect(transition(running, "cancel", ctx()).recoverable).toBe(false);
  });

  test("只有 delivery 到 complete 或 rejected 才放下 recoverable（L-6）", () => {
    const pending = state({ execution: "succeeded", delivery: "pending", recoverable: true });
    expect(transition(pending, "deliver_ok", ctx()).recoverable).toBe(false);
    expect(transition(pending, "deliver_reject", ctx()).recoverable).toBe(false);
    expect(transition(pending, "deliver_fail", ctx()).recoverable).toBe(true);
  });

  test("L-4：产物只有远端一份时 close 抛错；收割完就放行", () => {
    const active = state({ execution: "succeeded", delivery: "pending", resource: "active", recoverable: true });
    expect(() => transition(active, "close", ctx())).toThrow(/L-4/);
    const delivered = transition(active, "deliver_ok", ctx());
    expect(transition(delivered, "close", ctx()).resource).toBe("closed");
  });
});

describe("L-1 / recover / 投影", () => {
  test("recover 的去向由 adapter 裁定，非法去向抛错", () => {
    const interrupted = state({ execution: "interrupted" });
    expect(transition(interrupted, "recover", ctx({ recoverOutcome: "succeeded" })).execution).toBe("succeeded");
    expect(transition(interrupted, "recover", ctx({ recoverOutcome: "failed" })).execution).toBe("failed");
    expect(transition(interrupted, "recover", ctx({ recoverOutcome: "running" })).execution).toBe("running");
    expect(() =>
      transition(interrupted, "recover", ctx({ recoverOutcome: "queued" as "running" })),
    ).toThrow(ComputeStateError);
  });

  test("transition 是纯函数：不改入参", () => {
    const before = state({ execution: "running" });
    const frozen = JSON.stringify(before);
    transition(before, "succeed", ctx());
    expect(JSON.stringify(before)).toBe(frozen);
  });

  test("initialLifecycle 是 planned/none/none/false", () => {
    expect(initialLifecycle()).toEqual({ execution: "planned", delivery: "none", resource: "none", recoverable: false });
  });

  test("HTTP /machine 的两个门由函数推导（不许手写投影）", () => {
    expect(approvalGate()).toEqual({ from: "awaiting_approval", to: "approved", requires: ["actor"] });
    expect(dispatchGate()).toEqual({
      from: "approved",
      to: "queued",
      consumesApproval: true,
      verifies: ["planDigest", "uploads"],
    });
  });

  test("终态集合就是这五个", () => {
    expect(EXECUTION_STATES.filter(isExecutionTerminal)).toEqual([
      "rejected",
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
    ]);
  });
});
