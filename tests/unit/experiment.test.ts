import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentLoop } from "../../backend/src/experiment/loop";
import {
  EXPERIMENT_STATES,
  ExperimentNotFoundError,
  ExperimentStateError,
  LEGAL_TRANSITIONS,
  canTransition,
  isExperimentState,
  renderExperiment,
  type ExperimentState,
} from "../../backend/src/experiment/models";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import { SimulationRegistry } from "../../backend/src/simulation/registry";
import { SimulationSpecError } from "../../backend/src/simulation/models";
import { RunStore, isProcessAlive } from "../../backend/src/simulation/run_store";

// P5 状态机单测（DEVELOPMENT_PLAN P5 验证：「状态机转移全覆盖、断点恢复、adapter 契约」）。
//
// 仿真一律用 pyref（零依赖、秒级、确定性）。断点恢复用**真实子进程 + 真实 kill**，
// 不是 mock：恢复代码路径读的是磁盘上的 run.json / done.json / pid，
// 用假对象打桩等于把要验的东西绕过去了。

const roots: string[] = [];

function newWorkspace(): { manager: ProjectManager; project: Project; root: string } {
  const root = mkdtempSync(join(tmpdir(), "exp-test-"));
  roots.push(root);
  const manager = new ProjectManager(root);
  const project = manager.create("p5");
  return { manager, project, root };
}

function loopFor(project: Project): ExperimentLoop {
  return new ExperimentLoop({
    records: project.records(),
    artifacts: project.artifacts(),
    platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
  });
}

// 模拟「进程重启」：关掉全部存储句柄，用新的 ProjectManager 重新打开。
// 这是本进程内能做到的最接近重启的事——所有状态都必须从磁盘重读。
function restart(manager: ProjectManager, project: Project): { project: Project; loop: ExperimentLoop } {
  project.close();
  const reopened = new ProjectManager(manager.root).open(project.slug);
  return { project: reopened, loop: loopFor(reopened) };
}

const FAST = { steps: 200, sampleInterval: 20 };
const SLOW = { steps: 100, stallSeconds: 20 };

async function designed(loop: ExperimentLoop, params: Record<string, unknown> = FAST, title = "阻尼振子") {
  return loop.design({ title, platform: "pyref", kind: "damped-oscillator", params, hypothesis: "能量单调衰减" });
}

afterAll(() => {
  // 兜底：把可能还在跑的 stall 子进程收掉，别把它们留到测试进程之后。
  for (const root of roots) {
    const runsRoot = join(root, "projects", "p5", "experiments", "pyref", "runs");
    if (!existsSync(runsRoot)) continue;
    const store = new RunStore(runsRoot);
    for (const runId of store.list()) {
      const record = store.read(runId);
      if (record?.pid && isProcessAlive(record.pid)) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch {
          /* 已经退出了 */
        }
      }
    }
  }
});

describe("闭环状态机 · 转移表", () => {
  test("合法转移全覆盖：表里写的每一条都通过", () => {
    let checked = 0;
    for (const from of EXPERIMENT_STATES) {
      for (const to of LEGAL_TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true);
        checked++;
      }
    }
    // design→dry_run, dry_run→collect|failed, collect→analyze, analyze→concluded|iterated, failed→dry_run
    expect(checked).toBe(7);
  });

  test("非法转移全拒绝：表外的 state × state 组合一条都不许通过", () => {
    let rejected = 0;
    for (const from of EXPERIMENT_STATES) {
      for (const to of EXPERIMENT_STATES) {
        if (LEGAL_TRANSITIONS[from].includes(to)) continue;
        expect(canTransition(from, to)).toBe(false);
        rejected++;
      }
    }
    // 7×7 全组合减去 7 条合法边。
    expect(rejected).toBe(EXPERIMENT_STATES.length * EXPERIMENT_STATES.length - 7);
  });

  test("终态没有任何出边", () => {
    expect(LEGAL_TRANSITIONS.concluded).toEqual([]);
    expect(LEGAL_TRANSITIONS.iterated).toEqual([]);
  });

  test("自环一律非法（重跑要走 retry / 新建实验，不是原地打转）", () => {
    for (const state of EXPERIMENT_STATES) expect(canTransition(state, state)).toBe(false);
  });

  test("isExperimentState 只认这 7 个", () => {
    for (const state of EXPERIMENT_STATES) expect(isExperimentState(state)).toBe(true);
    for (const bad of ["", "running", "done", "DESIGN", null, 42]) expect(isExperimentState(bad)).toBe(false);
  });

  test("ExperimentStateError 的消息把「当前只能去哪」说清楚", () => {
    const error = new ExperimentStateError("design", "analyze");
    expect(error.message).toContain("design → analyze");
    expect(error.message).toContain("dry_run");
    expect(new ExperimentStateError("concluded", "dry_run").message).toContain("无（终态）");
  });
});

describe("闭环状态机 · design", () => {
  test("design 建 experiment record，参数归一化后落库", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await designed(loop);

    expect(view.state).toBe("design");
    expect(view.record.type).toBe("experiment");
    expect(view.record.evidence).toBe("inferred");
    expect(view.iteration).toBe(1);
    expect(view.attempts).toBe(0);
    expect(view.runId).toBeNull();
    expect(view.specHash).toMatch(/^[0-9a-f]{16}$/);
    // 归一化：只给了 2 个参数，落库的是补齐默认值的完整参数集。
    expect(Object.keys(view.params).length).toBeGreaterThan(5);
    expect(view.params.dt).toBe(0.01);
    expect(view.timestamps.design).toBeTruthy();
    expect(view.record.content).toContain("阻尼振子");
    expect(view.record.content).toContain(view.id);
    project.close();
  });

  test("design 阶段就拒绝非法参数（不建半成品 record）", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    await expect(
      loop.design({ title: "坏参数", platform: "pyref", kind: "damped-oscillator", params: { steps: 0 } }),
    ).rejects.toThrow(SimulationSpecError);
    expect(loop.list().length).toBe(0);
    project.close();
  });

  test("design 拒绝未知平台", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    await expect(
      loop.design({ title: "x", platform: "vasp", kind: "whatever" }),
    ).rejects.toThrow(/未知仿真平台/);
    project.close();
  });

  test("get 支持前缀；歧义与缺失分别报错", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await designed(loop);
    expect(loop.get(view.id.slice(0, 8)).id).toBe(view.id);
    expect(loop.get(view.id).id).toBe(view.id);
    expect(() => loop.get("ffffffff")).toThrow(ExperimentNotFoundError);
    // 空前缀命中所有实验 → 歧义（多于一条时）。
    await designed(loop, { ...FAST, damping: 0.5 }, "第二条");
    expect(() => loop.get("")).toThrow(/前缀命中 2 条/);
    project.close();
  });
});

describe("闭环状态机 · 非法转移全拒绝（行为层）", () => {
  test("design 状态下不能 collect / analyze / conclude / iterate", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await designed(loop);
    await expect(loop.collect(view.id)).rejects.toThrow(ExperimentStateError);
    expect(() => loop.analyze(view.id)).toThrow(ExperimentStateError);
    expect(() => loop.conclude(view.id, { claim: "x" })).toThrow(ExperimentStateError);
    await expect(loop.iterate(view.id, { params: { damping: 0.9 } })).rejects.toThrow(ExperimentStateError);
    // 一次失败的转移不许留下任何痕迹。
    expect(loop.get(view.id).state).toBe("design");
    expect(loop.get(view.id).history.length).toBe(0);
    project.close();
  });

  test("dry_run 状态下不能重复 dryRun，也不能直接 analyze", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await loop.dryRun((await designed(loop, SLOW)).id);
    expect(view.state).toBe("dry_run");
    await expect(loop.dryRun(view.id)).rejects.toThrow(ExperimentStateError);
    expect(() => loop.analyze(view.id)).toThrow(ExperimentStateError);
    await loop.platformFor(view).cancel(view.runId!);
    project.close();
  });

  test("终态之后什么都不能做", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    let view = await loop.run((await designed(loop)).id, { pollIntervalMs: 40 });
    view = loop.conclude(view.id, { claim: "能量确实单调衰减" });
    expect(view.state).toBe("concluded");
    await expect(loop.dryRun(view.id)).rejects.toThrow(ExperimentStateError);
    await expect(loop.collect(view.id)).rejects.toThrow(ExperimentStateError);
    expect(() => loop.conclude(view.id, { claim: "再来一次" })).toThrow(ExperimentStateError);
    await expect(loop.iterate(view.id, { params: { damping: 0.9 } })).rejects.toThrow(ExperimentStateError);
    project.close();
  });

  test("retry 只对 failed 有效", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await designed(loop);
    await expect(loop.retry(view.id)).rejects.toThrow(/retry 只能用于 failed/);
    project.close();
  });
});

describe("闭环状态机 · 全链路与证据图", () => {
  test("design → dry_run → collect → analyze → conclude：状态、时间戳、证据边全部落库", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const records = project.records();
    let view = await designed(loop);

    view = await loop.dryRun(view.id);
    expect(view.state).toBe("dry_run");
    expect(view.attempts).toBe(1);
    expect(view.runId).toBeTruthy();

    // 等到仿真终结再 collect。
    const platform = loop.platformFor(view);
    for (let i = 0; i < 200; i++) {
      const status = await platform.poll(view.runId!);
      if (status.state === "completed") break;
      await Bun.sleep(40);
    }

    view = await loop.collect(view.id);
    expect(view.state).toBe("collect");
    expect(view.artifactRecordIds.length).toBe(2);
    expect(view.summary?.steps).toBe(200);
    // 仿真跑对了没有：与解析解的最大偏差必须是数值噪声量级。
    expect(Number(view.summary?.maxAbsErrorVsAnalytic)).toBeLessThan(1e-6);

    // 产出确实进了 artifact store，且能连回这条实验。
    const artifacts = project.artifacts().listBySession(view.id);
    expect(artifacts.length).toBe(2);
    expect(artifacts.map((a) => a.filename).sort()).toEqual(["final_state.json", "trajectory.csv"]);
    expect(existsSync(artifacts[0]!.storagePath)).toBe(true);
    for (const artifactRecordId of view.artifactRecordIds) {
      const record = records.get(artifactRecordId)!;
      expect(record.type).toBe("artifact");
      expect(record.evidence).toBe("computed");
      expect(record.artifactId).toBeTruthy();
      const edges = records.edgesOf(artifactRecordId).outgoing;
      expect(edges.some((e) => e.targetId === view.id && e.type === "derives_from")).toBe(true);
    }

    view = loop.analyze(view.id, { note: "阻尼比 0.05，欠阻尼" });
    expect(view.state).toBe("analyze");
    const observation = records.get(view.observationId!)!;
    expect(observation.type).toBe("observation");
    expect(observation.evidence).toBe("computed");
    expect(observation.content).toContain("阻尼比 0.05，欠阻尼");
    expect(observation.content).toContain("maxAbsErrorVsAnalytic");
    // observation 连实验 + 连每个产出。
    const outgoing = records.edgesOf(observation.id).outgoing;
    expect(outgoing.filter((e) => e.type === "derives_from").length).toBe(3);

    view = loop.conclude(view.id, { claim: "RK4 与解析解一致到 1e-9", limitations: "只跑了一组参数", confidence: "high" });
    expect(view.state).toBe("concluded");
    const conclusion = records.get(view.conclusionId!)!;
    expect(conclusion.type).toBe("conclusion");
    // 结论卡的 review 门槛是 P8 的事；这里一律 pending，不给自己发通过证。
    expect((conclusion.metadata as { review: string }).review).toBe("pending");

    // 时间戳：每个到过的状态都留了一条。
    for (const state of ["design", "dry_run", "collect", "analyze", "concluded"] as ExperimentState[]) {
      expect(view.timestamps[state]).toBeTruthy();
    }
    expect(view.history.map((h) => h.to)).toEqual(["dry_run", "collect", "analyze", "concluded"]);
    for (const entry of view.history) {
      expect(new Date(entry.at).toString()).not.toBe("Invalid Date");
      expect(entry.note).toBeTruthy();
    }

    // 证据子图两跳内能从结论走到产出。
    const graph = records.graph(conclusion.id, 3);
    expect(graph.nodes.map((n) => n.type).sort()).toEqual([
      "artifact",
      "artifact",
      "conclusion",
      "experiment",
      "observation",
    ]);
    project.close();
  }, 60_000);

  test("conclude 不给 claim 时只推状态，不造结论卡", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    let view = await loop.run((await designed(loop)).id, { pollIntervalMs: 40 });
    view = loop.conclude(view.id);
    expect(view.state).toBe("concluded");
    expect(view.conclusionId).toBeNull();
    expect(project.records().list({ type: "conclusion" }).length).toBe(0);
    project.close();
  }, 60_000);

  test("iterate：新实验 supersedes 旧实验，参数为增量合并，旧实验转入 iterated", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const records = project.records();
    const first = await loop.run((await designed(loop)).id, { pollIntervalMs: 40 });

    const { previous, next } = await loop.iterate(first.id, { params: { damping: 0.9 }, note: "加大阻尼" });
    expect(previous.state).toBe("iterated");
    expect(previous.history.at(-1)!.note).toBe("加大阻尼");
    expect(next.state).toBe("design");
    expect(next.iteration).toBe(2);
    expect(next.parentExperimentId).toBe(first.id);
    // 增量合并：只改了 damping，其余沿用上一轮。
    expect(next.params.damping).toBe(0.9);
    expect(next.params.steps).toBe(first.params.steps);
    expect(next.specHash).not.toBe(first.specHash);
    const edges = records.edgesOf(next.id).outgoing;
    expect(edges.some((e) => e.targetId === first.id && e.type === "supersedes")).toBe(true);
    project.close();
  }, 60_000);

  test("iterate 参数没变时拒绝（那是重跑，不是迭代）", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const first = await loop.run((await designed(loop)).id, { pollIntervalMs: 40 });
    await expect(loop.iterate(first.id, { params: { steps: FAST.steps } })).rejects.toThrow(/那不是迭代，是重跑/);
    expect(loop.get(first.id).state).toBe("analyze");
    project.close();
  }, 60_000);

  test("list 按状态与平台过滤", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    await designed(loop, FAST, "A");
    const b = await designed(loop, { ...FAST, damping: 0.4 }, "B");
    await loop.run(b.id, { pollIntervalMs: 40 });
    expect(loop.list().length).toBe(2);
    expect(loop.list({ state: "design" }).map((v) => v.title)).toEqual(["A"]);
    expect(loop.list({ state: "analyze" }).map((v) => v.title)).toEqual(["B"]);
    expect(loop.list({ platform: "openmm" }).length).toBe(0);
    project.close();
  }, 60_000);

  test("renderExperiment 把状态、参数、摘要、轨迹都写进正文（正文由代码渲染）", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await loop.run((await designed(loop)).id, { pollIntervalMs: 40 });
    const text = renderExperiment(view);
    expect(text).toContain("状态：**analyze**");
    expect(text).toContain("pyref / damped-oscillator");
    expect(text).toContain("能量单调衰减");
    expect(text).toContain("| dampingRatio |");
    expect(text).toContain("design → dry_run");
    project.close();
  }, 60_000);
});

// ── 断点续跑：三种情形（DEVELOPMENT_PLAN P5 验证要求逐条覆盖）────────────────
describe("闭环状态机 · 断点恢复", () => {
  test("情形一 · 任务仍在跑：重启后 resume 接回同一个 run，续跑到 conclude", async () => {
    const { manager, project } = newWorkspace();
    const loop = loopFor(project);
    // 先起一个会 stall 的任务，保证「重启」时它确实还在跑。
    const started = await loop.dryRun((await designed(loop, { steps: 200, stallSeconds: 2 })).id);
    const runId = started.runId!;

    const restarted = restart(manager, project);
    const resumed = await restarted.loop.resume(started.id);
    expect(resumed.action).toBe("still_running");
    expect(resumed.view.state).toBe("dry_run");
    expect(resumed.view.runId).toBe(runId);
    expect(resumed.runStatus!.state).toBe("running");

    // 续跑：不重新提交，接着等同一个 run 结束。
    const finished = await restarted.loop.run(started.id, { pollIntervalMs: 100, timeoutMs: 60_000 });
    expect(finished.state).toBe("analyze");
    expect(finished.runId).toBe(runId);
    // attempts 仍是 1：恢复不是重跑。
    expect(finished.attempts).toBe(1);
    const concluded = restarted.loop.conclude(finished.id, { claim: "kill 之后接上了同一个 run" });
    expect(concluded.state).toBe("concluded");
    restarted.project.close();
  }, 90_000);

  test("情形二 · 任务已完成：重启后 resume 直接进 collect", async () => {
    const { manager, project } = newWorkspace();
    const loop = loopFor(project);
    const started = await loop.dryRun((await designed(loop)).id);
    const runId = started.runId!;
    // 等它在「编排进程不在」的这段时间里自己跑完。
    const store = new RunStore(join(project.paths.experimentsDir, "pyref", "runs"));
    for (let i = 0; i < 200 && !store.done(runId); i++) await Bun.sleep(40);
    expect(store.done(runId)!.status).toBe("completed");

    const restarted = restart(manager, project);
    const resumed = await restarted.loop.resume(started.id);
    expect(resumed.action).toBe("ready_to_collect");
    expect(resumed.view.state).toBe("dry_run");
    expect(resumed.runStatus!.state).toBe("completed");

    const collected = await restarted.loop.collect(started.id);
    expect(collected.state).toBe("collect");
    expect(collected.artifactRecordIds.length).toBe(2);
    restarted.project.close();
  }, 60_000);

  test("情形三 · 任务已丢失：resume 标 failed（可重试），retry 换新 run 跑通", async () => {
    const { manager, project } = newWorkspace();
    const loop = loopFor(project);
    const started = await loop.dryRun((await designed(loop, { steps: 200, stallSeconds: 30 })).id);
    const lostRunId = started.runId!;

    // 真实地把仿真子进程杀掉——模拟「编排进程和任务一起没了」。
    const store = new RunStore(join(project.paths.experimentsDir, "pyref", "runs"));
    const pid = store.read(lostRunId)!.pid!;
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 100 && isProcessAlive(pid); i++) await Bun.sleep(30);
    expect(isProcessAlive(pid)).toBe(false);
    expect(store.done(lostRunId)).toBeNull();

    const restarted = restart(manager, project);
    const resumed = await restarted.loop.resume(started.id);
    expect(resumed.action).toBe("marked_failed");
    expect(resumed.view.state).toBe("failed");
    expect(resumed.view.lastError).toContain("已消失");
    expect(resumed.runStatus!.recoverable).toBe(true);

    // 可重试：failed → dry_run，换一个新 runId。
    const retried = await restarted.loop.retry(started.id);
    expect(retried.state).toBe("dry_run");
    expect(retried.runId).not.toBe(lostRunId);
    expect(retried.attempts).toBe(2);
    // 重试用的是同一份参数（还带着 stallSeconds 30），等它跑完没有意义。
    // 确认新进程真的起来了即可——这就是「可重试」的实质。
    expect(isProcessAlive(store.read(retried.runId!)!.pid)).toBe(true);
    await restarted.loop.platformFor(retried).cancel(retried.runId!);
    restarted.project.close();
  }, 90_000);

  test("情形三变体 · dry_run 但没有 runId（提交过程中断）：同样标 failed 可重试", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await designed(loop);
    const records = project.records();
    // 手工注入「状态写到一半」：state 已是 dry_run，runId 还没写进去。
    records.update(view.id, {
      metadata: { ...(view.record.metadata as Record<string, unknown>), state: "dry_run", runId: null },
    });
    const resumed = await loop.resume(view.id);
    expect(resumed.action).toBe("marked_failed");
    expect(resumed.view.lastError).toContain("没有 runId");
    const retried = await loop.retry(view.id);
    expect(retried.state).toBe("dry_run");
    expect(retried.runId).toBeTruthy();
    project.close();
  }, 60_000);

  test("情形三变体 · run 目录整个不见了：resume 不炸，标 failed", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await designed(loop);
    const records = project.records();
    records.update(view.id, {
      metadata: { ...(view.record.metadata as Record<string, unknown>), state: "dry_run", runId: "pyref-gone-12345678" },
    });
    const resumed = await loop.resume(view.id);
    expect(resumed.action).toBe("marked_failed");
    expect(resumed.view.state).toBe("failed");
    expect(resumed.view.lastError).toContain("unknown run");
    project.close();
  });

  test("非 dry_run 状态 resume 是 no-op（不乱推状态）", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await designed(loop);
    const resumed = await loop.resume(view.id);
    expect(resumed.action).toBe("noop");
    expect(resumed.view.state).toBe("design");
    expect(resumed.view.history.length).toBe(0);
    project.close();
  });

  test("仿真自身失败：run() 抛错但状态持久化为 failed，可重试成功", async () => {
    const { manager, project } = newWorkspace();
    const loop = loopFor(project);
    // dt=5 远大于固有周期 → RK4 发散，runner 明确报 failed。
    const view = await designed(loop, { dt: 5, steps: 200 }, "发散算例");
    await expect(loop.run(view.id, { pollIntervalMs: 40 })).rejects.toThrow(/仿真失败/);

    const restarted = restart(manager, project);
    const failed = restarted.loop.get(view.id);
    expect(failed.state).toBe("failed");
    expect(failed.lastError).toContain("发散");
    expect(failed.timestamps.failed).toBeTruthy();

    // 改参数重试要走 iterate；这里验证的是「同参数重试仍然失败且状态不乱」。
    const retried = await restarted.loop.retry(view.id);
    expect(retried.attempts).toBe(2);
    await expect(restarted.loop.run(retried.id, { pollIntervalMs: 40 })).rejects.toThrow(/仿真失败/);
    expect(restarted.loop.get(view.id).state).toBe("failed");
    restarted.project.close();
  }, 60_000);

  test("run() 超时不丢状态：任务还在跑，稍后能续上", async () => {
    const { manager, project } = newWorkspace();
    const loop = loopFor(project);
    const view = await designed(loop, { steps: 200, stallSeconds: 3 });
    await expect(loop.run(view.id, { pollIntervalMs: 50, timeoutMs: 300 })).rejects.toThrow(/等待仿真超时/);

    const restarted = restart(manager, project);
    expect(restarted.loop.get(view.id).state).toBe("dry_run");
    const finished = await restarted.loop.run(view.id, { pollIntervalMs: 100, timeoutMs: 60_000 });
    expect(finished.state).toBe("analyze");
    expect(finished.attempts).toBe(1);
    restarted.project.close();
  }, 90_000);
});

describe("闭环状态机 · 状态只在 record 里", () => {
  test("重启后所有状态字段逐一还原（内存里不留权威状态）", async () => {
    const { manager, project } = newWorkspace();
    const loop = loopFor(project);
    let view = await loop.run((await designed(loop)).id, { pollIntervalMs: 40 });
    view = loop.conclude(view.id, { claim: "落库的状态可以完整还原" });

    const restarted = restart(manager, project);
    const reloaded = restarted.loop.get(view.id);
    expect(reloaded.state).toBe(view.state);
    expect(reloaded.runId).toBe(view.runId);
    expect(reloaded.specHash).toBe(view.specHash);
    expect(reloaded.summary).toEqual(view.summary);
    expect(reloaded.history).toEqual(view.history);
    expect(reloaded.timestamps).toEqual(view.timestamps);
    expect(reloaded.artifactRecordIds).toEqual(view.artifactRecordIds);
    expect(reloaded.observationId).toBe(view.observationId);
    expect(reloaded.conclusionId).toBe(view.conclusionId);
    restarted.project.close();
  }, 60_000);

  test("状态回写只走 update() 窄口：type/evidence/origin/createdAt 全程不变", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const before = (await designed(loop)).record;
    const after = (await loop.run(before.id, { pollIntervalMs: 40 })).record;
    expect(after.id).toBe(before.id);
    expect(after.type).toBe(before.type);
    expect(after.evidence).toBe(before.evidence);
    expect(after.origin).toEqual(before.origin);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.artifactId).toBe(before.artifactId);
    // 变的只有 content 与 metadata。
    expect(after.content).not.toBe(before.content);
    project.close();
  }, 60_000);

  test("run 目录里的 run.json 就是磁盘真源，能被外部读到", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await loop.run((await designed(loop)).id, { pollIntervalMs: 40 });
    const runDir = join(project.paths.experimentsDir, "pyref", "runs", view.runId!);
    const record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { state: string; params: unknown };
    expect(record.state).toBe("completed");
    expect(record.params).toEqual(view.params);
    expect(existsSync(join(runDir, "done.json"))).toBe(true);
    expect(existsSync(join(runDir, "stdout.log"))).toBe(true);
    project.close();
  }, 60_000);

  test("done.json 半写（进程正好在写的时候被杀）不算终态", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = await loop.dryRun((await designed(loop, { steps: 200, stallSeconds: 20 })).id);
    const runDir = join(project.paths.experimentsDir, "pyref", "runs", view.runId!);
    writeFileSync(join(runDir, "done.json"), '{"status": "comple');
    const store = new RunStore(join(project.paths.experimentsDir, "pyref", "runs"));
    expect(store.done(view.runId!)).toBeNull();
    // 任务还活着，所以仍然是 still_running，不会被半写文件骗成完成。
    expect((await loop.resume(view.id)).action).toBe("still_running");
    await loop.platformFor(view).cancel(view.runId!);
    project.close();
  }, 60_000);
});
