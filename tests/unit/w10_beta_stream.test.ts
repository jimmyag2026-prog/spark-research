// v0.10 lane β · 流式可见的门禁（β-1 progress 时间字段 / β-2 partial / β-3 delta / β-4 取消）。
//
// 纪律（_COMMON.md §纪律 3）：**门禁钉「接线」而不只钉「内容」**。所以每一节除了测
// 数据形状，还各有一条「它真的被转出去 / 真的被调用到」的断言——U40/U47 的教训是
// 判据存在但没人读到，测试照样绿。
//
// 接线点里属于**收口专属**的两个文件（`routes/session.ts` 的 SSE 出口、
// `orchestrator.ts` 的回调透传）本 lane 一行不碰，diff 写在 `docs/devlog/W10-beta.md`
// 「收口 diff」段；这里能钉的是收口之前就该成立的那一半：事件产生端与契约。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProgressEmitter, createRevisionCounter, cardTarget, type ProgressEvent } from "../../backend/src/agents/progress";

const ROOT = join(import.meta.dir, "..", "..");
const SCHEMAS = JSON.parse(readFileSync(join(ROOT, "backend/src/contract/schemas.generated.json"), "utf8")) as {
  groups: Record<string, Record<string, unknown>>;
  definitions: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
};

/** 可控时钟：eta 是个算出来的数，用真实时间测它只能测「非负」，测不到「算得对」。 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("β-1 · progress 补 ts / elapsedMs / etaMs", () => {
  test("每一条 progress 都带 ts 与 elapsedMs；elapsedMs 单调不减且与时钟对得上", () => {
    const clock = fakeClock();
    const events: ProgressEvent[] = [];
    const emitter = createProgressEmitter((e) => events.push(e), { now: clock.now });
    emitter.planStarted();
    clock.advance(3_000);
    emitter.planned(2);
    clock.advance(1_000);
    emitter.taskCompleted({ kind: "analysis" });
    clock.advance(1_000);
    emitter.taskCompleted({ kind: "analysis" });
    clock.advance(500);
    emitter.summarizing();
    emitter.reviewed({ approved: true, hardFindings: 0 });

    expect(events.length).toBe(6);
    for (const e of events) {
      expect(typeof e.ts, `progress 事件缺 ts：${e.message}`).toBe("number");
      expect(typeof e.elapsedMs, `progress 事件缺 elapsedMs：${e.message}`).toBe("number");
    }
    expect(events.map((e) => e.elapsedMs)).toEqual([0, 3_000, 4_000, 5_000, 5_500, 5_500]);
    expect(events[2]!.ts).toBe(1_004_000);
  });

  test("etaMs：execute 段有样本才给，按已完成任务的平均耗时外推；其余阶段一律不给", () => {
    const clock = fakeClock();
    const events: ProgressEvent[] = [];
    const emitter = createProgressEmitter((e) => events.push(e), { now: clock.now });
    emitter.planStarted();
    clock.advance(10_000); // 一次很慢的 plan：不许污染 eta
    emitter.planned(4);
    clock.advance(2_000);
    emitter.taskCompleted({ kind: "analysis" }); // 1/4，execute 段已用 2s → 剩 3 个 ≈ 6s
    clock.advance(2_000);
    emitter.taskCompleted({ kind: "analysis" }); // 2/4，4s/2 = 2s/个 → 剩 2 个 ≈ 4s

    const plan = events.filter((e) => e.stage === "plan");
    expect(plan.every((e) => e.etaMs === undefined), "plan 段没有可外推的样本，不许给 eta").toBe(true);
    const exec = events.filter((e) => e.stage === "execute");
    expect(exec.map((e) => e.etaMs)).toEqual([6_000, 4_000]);

    // 最后一个任务完成（complete === total）：没有「剩余」可估，字段必须消失而不是 0。
    clock.advance(2_000);
    emitter.taskCompleted({ kind: "analysis" });
    clock.advance(2_000);
    emitter.taskCompleted({ kind: "analysis" });
    expect(events[events.length - 1]!.etaMs).toBeUndefined();

    clock.advance(1_000);
    emitter.summarizing();
    emitter.reviewed({ approved: true, hardFindings: 0 });
    for (const e of events.filter((x) => x.stage === "summarize" || x.stage === "review")) {
      expect(e.etaMs, "summarize / review 段不给 eta（拿不准就不给字段）").toBeUndefined();
    }
  });

  test("β-1 的老不变式没被破坏：complete ≤ total（含修正轮）", () => {
    const events: ProgressEvent[] = [];
    const emitter = createProgressEmitter((e) => events.push(e));
    emitter.planStarted();
    emitter.planned(2);
    emitter.taskCompleted();
    emitter.taskCompleted();
    emitter.reviewed({ approved: false, hardFindings: 1 });
    emitter.repairing(2);
    emitter.taskCompleted();
    emitter.taskCompleted();
    emitter.reviewed({ approved: true, hardFindings: 0 });
    expect(events.every((e) => e.complete <= e.total)).toBe(true);
  });

  // 接线门禁：类型改了但没转进 `server/types.ts` → contract 与 SDK 看不到 →
  // lane ε 没法按类型渲染耗时。所以钉的是**生成出来的契约文件**，不是 TS 源码。
  test("接线：contract schema 里的 ProgressEvent 必含 ts / elapsedMs（required）与可选 etaMs", () => {
    const def = SCHEMAS.definitions.ProgressEvent;
    expect(def, "ProgressEvent 没进 schemas.generated.json —— server/types.ts 没转出去").toBeTruthy();
    expect(Object.keys(def!.properties ?? {})).toEqual(
      expect.arrayContaining(["stage", "complete", "total", "message", "ts", "elapsedMs", "etaMs"]),
    );
    expect(def!.required).toEqual(expect.arrayContaining(["ts", "elapsedMs"]));
    expect(def!.required).not.toContain("etaMs");
    expect(Object.keys(SCHEMAS.groups.http ?? {})).toContain("ProgressEvent");
  });

  test("接线：协议只增不改——六个老事件名一个不少，只多一个 partial", () => {
    const names = SCHEMAS.definitions.StreamEventName ?? (SCHEMAS.groups.http?.StreamEventName as typeof SCHEMAS.definitions.StreamEventName);
    const json = JSON.stringify(names);
    for (const name of ["start", "progress", "delta", "result", "done", "error", "partial"]) {
      expect(json, `StreamEventName 少了 '${name}'`).toContain(`"${name}"`);
    }
  });
});

describe("β-3 · delta 的 target / revision（形状与计数器）", () => {
  test("revision 从 1 起，按 target 各自递增，互不干扰", () => {
    const rev = createRevisionCounter();
    expect(rev.current("summary")).toBe(1);
    expect(rev.current("summary")).toBe(1);
    expect(rev.bump("summary")).toBe(2);
    expect(rev.current("review")).toBe(1); // 另一个 target 不受影响
    expect(rev.bump("review")).toBe(2);
    expect(rev.current("summary")).toBe(2);
  });

  test("cardTarget 拼的是 `card:<paperId>` 前缀", () => {
    expect(cardTarget("p-123")).toBe("card:p-123");
  });

  test("接线：contract schema 里的 DeltaEvent 必含 target 与 revision", () => {
    const def = SCHEMAS.definitions.DeltaEvent;
    expect(def, "DeltaEvent 没进 schemas.generated.json").toBeTruthy();
    expect(def!.required).toEqual(expect.arrayContaining(["chunk", "target", "revision"]));
  });
});
