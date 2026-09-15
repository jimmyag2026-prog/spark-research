import { describe, expect, test } from "bun:test";
import { createProgressEmitter, type ProgressEvent } from "../../backend/src/agents/progress";

// lane α-3（USAGE_LOG U4）：三段结构化进度。
// 被测的是**发射器的状态机**，不是 orchestrator——接线点在 orchestrator.ts 与
// routes/session.ts，两者都是收口专属文件（本 lane 一行不碰），以 ≤10 行 diff 交收口。
// 所以这里用一个「按真实管线顺序驱动 emitter」的替身，把不变式钉死。

function collect(): { events: ProgressEvent[]; emitter: ReturnType<typeof createProgressEmitter> } {
  const events: ProgressEvent[] = [];
  const emitter = createProgressEmitter((e) => events.push(e));
  return { events, emitter };
}

/** 复刻 `processRequestWithTools` 的调用顺序（orchestrator.ts:584-611）。 */
function runPipeline(
  emitter: ReturnType<typeof createProgressEmitter>,
  opts: { tasks: number; repairRounds?: number; fixesPerRound?: number },
): void {
  emitter.planStarted();
  emitter.planned(opts.tasks);
  for (let i = 0; i < opts.tasks; i++) emitter.taskCompleted({ kind: "analysis", description: `task ${i}` });
  emitter.summarizing();
  const rounds = opts.repairRounds ?? 0;
  const fixes = opts.fixesPerRound ?? 2;
  for (let r = 0; r < rounds; r++) {
    emitter.reviewed({ approved: false, hardFindings: 1 });
    emitter.repairing(fixes);
    for (let i = 0; i < fixes; i++) emitter.taskCompleted({ kind: "analysis", description: `fix ${i}` });
    emitter.summarizing();
  }
  emitter.reviewed({ approved: true, hardFindings: 0 });
}

describe("α-3 · 三段结构化进度", () => {
  test("plan / execute / summarize / review 四段各至少发一次事件", () => {
    const { events, emitter } = collect();
    runPipeline(emitter, { tasks: 3 });
    for (const stage of ["plan", "execute", "summarize", "review"] as const) {
      expect(
        events.filter((e) => e.stage === stage).length,
        `阶段 ${stage} 一次事件都没发——U4 的病就是「只发一次、之后界面不动」`,
      ).toBeGreaterThan(0);
    }
  });

  test("execute 每完成一个任务发一次，complete 单调递增且与任务数对齐", () => {
    const { events, emitter } = collect();
    runPipeline(emitter, { tasks: 4 });
    const exec = events.filter((e) => e.stage === "execute");
    expect(exec.length).toBe(4);
    expect(exec.map((e) => e.complete)).toEqual([1, 2, 3, 4]);
    expect(exec.every((e) => e.total === 4)).toBe(true);
  });

  test("complete ≤ total 恒成立（含修正轮）", () => {
    for (const repairRounds of [0, 1, 2]) {
      const { events, emitter } = collect();
      runPipeline(emitter, { tasks: 3, repairRounds, fixesPerRound: 2 });
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.complete, `complete=${e.complete} > total=${e.total}（stage=${e.stage}，修正轮 ${repairRounds}）`).toBeLessThanOrEqual(
          e.total,
        );
      }
    }
  });

  test("review 有硬 finding 进修正轮：decision=repair 且 total 变大", () => {
    const { events, emitter } = collect();
    runPipeline(emitter, { tasks: 3, repairRounds: 1, fixesPerRound: 2 });
    const repair = events.filter((e) => e.decision === "repair");
    expect(repair.length).toBeGreaterThan(0);
    const totalsBefore = events.filter((e) => e.stage === "execute")[0]!.total;
    const totalAfter = events.at(-1)!.total;
    expect(totalsBefore).toBe(3);
    expect(totalAfter, "修正轮必须把修正任务数加进 total，否则进度条会停在 100% 继续跑").toBe(5);
  });

  test("review 通过时最后一个事件 decision=ready", () => {
    const { events, emitter } = collect();
    runPipeline(emitter, { tasks: 2 });
    expect(events.at(-1)!.stage).toBe("review");
    expect(events.at(-1)!.decision).toBe("ready");
  });

  test("每条事件都带非空 message —— 前端只消费这一个字段", () => {
    const { events, emitter } = collect();
    runPipeline(emitter, { tasks: 2, repairRounds: 1 });
    for (const e of events) {
      expect(typeof e.message).toBe("string");
      expect(e.message.trim().length, `stage=${e.stage} 的 message 是空的`).toBeGreaterThan(0);
    }
  });

  test("不传 onProgress 时是完整空操作（CLI 路径与既有测试的行为不变）", () => {
    const emitter = createProgressEmitter();
    expect(() => runPipeline(emitter, { tasks: 2, repairRounds: 1 })).not.toThrow();
    // 状态仍然维护，只是没有人听。
    expect(emitter.snapshot()).toEqual({ stage: "review", complete: 4, total: 4 });
  });

  test("兜底：接线点漏调 repairing() 时 total 被抬平，绝不发出 3/2 这种事件", () => {
    const { events, emitter } = collect();
    emitter.planStarted();
    emitter.planned(2);
    emitter.taskCompleted();
    emitter.taskCompleted();
    // 故意漏掉 repairing()，直接又执行了一个修正任务。
    emitter.taskCompleted();
    const last = events.at(-1)!;
    expect(last.complete).toBe(3);
    expect(last.total).toBe(3);
  });

  test("任务描述过长时截断进 message，不把整段 prompt 推给前端", () => {
    const { events, emitter } = collect();
    emitter.planStarted();
    emitter.planned(1);
    emitter.taskCompleted({ kind: "analysis", description: "x".repeat(500) });
    expect(events.at(-1)!.message.length).toBeLessThan(120);
  });
});
