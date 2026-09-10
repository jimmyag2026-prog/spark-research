import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLiteratureReviewContract,
  NoProgressGuard,
  RecordStoreEvidenceQuery,
  type EvidenceQuery,
} from "../../backend/src/agents/contract";
import {
  distillObservation,
  runReplanLoop,
  type Observation,
  type Planner,
  type PlannerContext,
  type RoundExecutor,
  type RoundOutcome,
  type RoundPlan,
} from "../../backend/src/agents/replan";
import type { SubAgentResult } from "../../backend/src/agents/sub_agent";
import { RecordStore } from "../../backend/src/project/records";

// v0.4 P13 波次 W3-a：replan 循环（把「单发管线」变成「真 agent 循环」）。
//
// 这份文件测的是 replan.ts 自己的合同：
//   ① distill() 产出结构化 observation（命中数/新增 record id/错误类型/stopReason），
//      不是 output.slice(0,200)
//   ② runReplanLoop() 严格按伪代码顺序把 planner/execute/distill/evaluateRound 接起来，
//      observation 真的回流进下一轮 planner
//   ③ 三条并行停机条件里的 done/no_progress 完全交给 contract.ts 的 evaluateRound()，
//      本文件不绕开它自己判
//   ④ budget 这第三条停机条件由调用方（`budgetExceeded`）判，但汇总进同一个 StopReason
// 全部用注入的假 planner/execute（不含真 LLM、真子代理），跟 contract.test.ts 一样只用
// 真实的 RecordStore（bun:sqlite 文件）做证据图，不打真实网络/模型。
// 四次阴性对照（①②③见本文件；④ onDelta 见 tests/unit/orchestrator.test.ts）的实跑输出
// 已贴进 docs/devlog/W3-a.md。

const dirs: string[] = [];
function tempRoot(prefix = "spark-replan-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function store(): RecordStore {
  return new RecordStore(join(tempRoot(), "records.db"), "demo");
}

function addPaper(s: RecordStore, title: string) {
  return s.create({ type: "paper", title, content: title, evidence: "sourced" });
}

function addReading(s: RecordStore, paperId: string, title: string) {
  const r = s.create({ type: "reading", title, content: title, evidence: "sourced" });
  s.link(r.id, paperId, "cites");
  return r;
}

const CITATION_KIND = "citation-integrity-review";
function addCitationReview(s: RecordStore, targetRecordId: string, hardFindingCount: number) {
  return s.create({
    type: "observation",
    title: "citation-integrity 核验",
    content: `hard=${hardFindingCount}`,
    evidence: "computed",
    metadata: { kind: CITATION_KIND, checker: "citation-integrity", targetRecordId, hardFindingCount, softFindingCount: 0 },
  });
}

function fakeResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    finalText: "done.",
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, usageUnavailable: false },
    stopReason: "done",
    ...overrides,
  };
}

// ── ① distill：结构化 observation ────────────────────────────────────────────

describe("distillObservation", () => {
  test("命中数/新增 record 按类型分桶，不是 output.slice(0,200) 的截断字符串", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const before = q.snapshot();
    const p1 = addPaper(s, "A");
    const p2 = addPaper(s, "B");
    const r1 = addReading(s, p1.id, "reading of A");

    const longText = "x".repeat(500); // 刻意超过旧版 200 字符截断的长度
    const result = fakeResult({ finalText: longText, stopReason: "done" });
    const obs = distillObservation("t1", "explore", result, before, q);

    expect(obs.taskId).toBe("t1");
    expect(obs.subagentType).toBe("explore");
    expect(obs.stopReason).toBe("done");
    expect([...obs.newRecordIds].sort()).toEqual([p1.id, p2.id, r1.id].sort());
    expect(obs.newRecordIds.length).toBe(3); // 2 paper + 1 reading
    expect(obs.newRecordCountByType.paper).toBe(2);
    expect(obs.newRecordCountByType.reading).toBe(1);
    // 结构化字段能被直接消费，不需要再从一句话里解析——这正是「回流决策」的字面意思。
    expect(typeof obs.newRecordCountByType).toBe("object");
    // finalText 完整保留，不截断。
    expect(obs.finalText).toBe(longText);
    expect(obs.finalText.length).toBe(500);
  });

  test("工具调用的拒绝/失败分别计数，denied 原因也保留", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const before = q.snapshot();
    const result = fakeResult({
      toolCalls: [
        { tool: "lit_add", argsSummary: "{}", ok: false, denied: "not_granted", durationMs: 1, resultSize: 0, timestamp: 1 },
        { tool: "lit_search", argsSummary: "{}", ok: false, denied: "budget_exceeded", durationMs: 1, resultSize: 0, timestamp: 2 },
        { tool: "record_get", argsSummary: "{}", ok: false, durationMs: 1, resultSize: 0, timestamp: 3 }, // 执行了但失败，不是被拒绝
        { tool: "record_get", argsSummary: "{}", ok: true, durationMs: 1, resultSize: 10, timestamp: 4 },
      ],
    });
    const obs = distillObservation("t2", "review", result, before, q);
    expect(obs.toolCallCount).toBe(4);
    expect(obs.deniedCount).toBe(2);
    expect([...obs.deniedReasons].sort()).toEqual(["budget_exceeded", "not_granted"]);
    expect(obs.failedToolCount).toBe(1);
  });

  test("stopReason==='error' 时 errorMessage 携带原始错误；其余情况 undefined（不是空字符串冒充）", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const before = q.snapshot();

    const errObs = distillObservation("t3", "execute", fakeResult({ stopReason: "error", error: "upstream boom" }), before, q);
    expect(errObs.errorMessage).toBe("upstream boom");

    const doneObs = distillObservation("t4", "execute", fakeResult({ stopReason: "done" }), before, q);
    expect(doneObs.errorMessage).toBeUndefined();
  });

  test("degraded 标记如实透传", () => {
    const s = store();
    const q = new RecordStoreEvidenceQuery(s);
    const before = q.snapshot();
    const obs = distillObservation("t5", "lab", fakeResult({ degraded: true, degradedReason: "no tool calling" }), before, q);
    expect(obs.degraded).toBe(true);
  });
});

// ── ②③ runReplanLoop：顺序、observation 回流、停机条件全部交给 evaluateRound() ──────

interface Harness {
  s: RecordStore;
  q: EvidenceQuery;
  plannerCalls: PlannerContext[];
}

function harness(): Harness {
  const s = store();
  return { s, q: new RecordStoreEvidenceQuery(s), plannerCalls: [] };
}

describe("runReplanLoop", () => {
  test("按伪代码顺序执行两轮后 contract.allDone() → stopReason:'done'，第二轮 planner 收到第一轮的 observation", async () => {
    const { s, q, plannerCalls } = harness();
    const contract = createLiteratureReviewContract(q);
    const guard = new NoProgressGuard(q.snapshot(), 2);

    let paperId = "";
    const planner: Planner = async (ctx) => {
      plannerCalls.push(ctx);
      return [{ id: `r${ctx.round}`, subagentType: "explore", task: "go" }];
    };
    const execute: RoundExecutor = async (plan: RoundPlan): Promise<RoundOutcome[]> => {
      const round = plannerCalls.length - 1;
      if (round === 0) {
        const paper = addPaper(s, "P1");
        paperId = paper.id;
      } else {
        const reading = addReading(s, paperId, "R1");
        addCitationReview(s, paperId, 0);
        void reading;
      }
      return plan.map((item) => ({ item, result: fakeResult({ stopReason: "done" }) }));
    };

    const result = await runReplanLoop({ goal: "写一篇综述", contract, q, guard, planner, execute, maxRounds: 10 });

    expect(result.stopReason).toBe("done");
    expect(result.rounds.length).toBe(2);
    expect(plannerCalls.length).toBe(2);

    // 契约②：第一轮的 observation 必须真的回流进第二轮 planner 的输入——不是空数组、
    // 不是又一次从零开始。
    expect(plannerCalls[0]!.lastObservations).toEqual([]);
    expect(plannerCalls[0]!.round).toBe(0);
    const secondRoundObs = plannerCalls[1]!.lastObservations;
    expect(secondRoundObs.length).toBe(1);
    expect(secondRoundObs[0]!.newRecordIds).toContain(paperId);
    expect(plannerCalls[1]!.round).toBe(1);
    // 第二轮 planner 看到的 report 应该反映第一轮之后仍未完成的 stage（read_cards/citations_verified）。
    expect(plannerCalls[1]!.report.incomplete.map((st) => st.id).sort()).toEqual(["citations_verified", "read_cards"].sort());

    expect(result.finalReport.allDone).toBe(true);
  });

  test("连续两轮无新增证据 → stopReason:'no_progress'，不是 'done'（evaluateRound() 判的，不是循环自己瞎猜）", async () => {
    const { q, plannerCalls } = harness();
    const contract = createLiteratureReviewContract(q);
    const guard = new NoProgressGuard(q.snapshot(), 2);

    const planner: Planner = async (ctx) => {
      plannerCalls.push(ctx);
      return [{ id: `r${ctx.round}`, subagentType: "explore", task: "go" }];
    };
    // execute() 什么都不往证据图里加——模拟子代理反复尝试但拿不到任何新证据。
    const execute: RoundExecutor = async (plan) => plan.map((item) => ({ item, result: fakeResult({ stopReason: "done" }) }));

    const result = await runReplanLoop({ goal: "写一篇综述", contract, q, guard, planner, execute, maxRounds: 10 });

    expect(result.stopReason).toBe("no_progress");
    expect(result.stopReason).not.toBe("done");
    expect(result.rounds.length).toBe(2); // 阈值 2：第 2 轮触发
    expect(result.finalReport.allDone).toBe(false);
  });

  test("budgetExceeded() 触发 → stopReason:'budget'，即便契约还没完成也不误报 'done'", async () => {
    const { s, q } = harness();
    const contract = createLiteratureReviewContract(q);
    const guard = new NoProgressGuard(q.snapshot(), 5);

    const planner: Planner = async (ctx) => [{ id: `r${ctx.round}`, subagentType: "explore", task: "go" }];
    const execute: RoundExecutor = async (plan) => {
      addPaper(s, "keeps making progress"); // 有新增证据，不会被 no_progress 误抓
      return plan.map((item) => ({ item, result: fakeResult({ stopReason: "done" }) }));
    };

    const result = await runReplanLoop({
      goal: "goal",
      contract,
      q,
      guard,
      planner,
      execute,
      maxRounds: 10,
      budgetExceeded: () => true, // 第一轮结束就报预算耗尽
    });

    expect(result.stopReason).toBe("budget");
    expect(result.stopReason).not.toBe("done");
    expect(result.rounds.length).toBe(1);
  });

  test("命中 maxRounds 安全阀 → stopReason:'budget'（宁可报没做完，不假装完成）", async () => {
    const { q } = harness();
    const contract = createLiteratureReviewContract(q);
    // 阈值拉到远大于 maxRounds，保证不是 no_progress 先触发——纯粹靠 maxRounds 兜底停下，
    // 隔离出「安全阀」这一条路径单独验证。
    const guard = new NoProgressGuard(q.snapshot(), 100);
    const planner: Planner = async (ctx) => [{ id: `r${ctx.round}`, subagentType: "explore", task: "go" }];
    const execute: RoundExecutor = async (plan) => plan.map((item) => ({ item, result: fakeResult({ stopReason: "done" }) }));
    const result = await runReplanLoop({ goal: "goal", contract, q, guard, planner, execute, maxRounds: 3 });
    expect(result.stopReason).toBe("budget");
    expect(result.rounds.length).toBe(3);
  });
});
