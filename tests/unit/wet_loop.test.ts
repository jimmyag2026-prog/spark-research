import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentLoop } from "../../backend/src/experiment/loop";
import { LabSafetyError } from "../../backend/src/lab/orchestrator";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { WetLabLoop } from "../../backend/src/lab/wet_loop";
import {
  ApprovalRequiredError,
  WET_EXPERIMENT_STATES,
  WET_LEGAL_TRANSITIONS,
  WetExperimentNotFoundError,
  WetStateError,
  canWetTransition,
  isWetExperimentState,
  type WetExperimentState,
} from "../../backend/src/lab/wet_models";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import { SimulationRegistry } from "../../backend/src/simulation/registry";

// P6 湿实验状态机 + approve gate 单测（AD-6）。
//
// 执行后端一律用 mock：本文件要验的是**状态机与审批**，不是 opentrons 能不能跑
//（那是 wet_e2e.test.ts 用真模拟器验的）。两件事混在一个文件里，
// 一旦 opentrons 环境有问题，approve gate 的回归就跟着一起哑掉。

const PROTOCOL_A = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";
const PROTOCOL_B = "配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次";

function newWorkspace(): { manager: ProjectManager; project: Project; root: string } {
  const root = mkdtempSync(join(tmpdir(), "wet-test-"));
  const manager = new ProjectManager(root);
  const project = manager.create("p6");
  return { manager, project, root };
}

function loopFor(project: Project): WetLabLoop {
  return new WetLabLoop({
    records: project.records(),
    artifacts: project.artifacts(),
    root: join(project.paths.experimentsDir, "wet"),
    backend: new MockDeviceBackend(),
  });
}

function restart(manager: ProjectManager, project: Project): { project: Project; loop: WetLabLoop } {
  project.close();
  const reopened = new ProjectManager(manager.root).open(project.slug);
  return { project: reopened, loop: loopFor(reopened) };
}

// 推到 awaiting_approval（编译 + 安全门），approve **不**在这里做。
function upToApproval(loop: WetLabLoop, protocol = PROTOCOL_A, title = "OD 测定") {
  const view = loop.design({ title, naturalLanguage: protocol, hypothesis: "孵育后 OD 上升" });
  loop.compile(view.id);
  return loop.safetyCheck(view.id).view;
}

describe("湿实验状态机 · 转移表", () => {
  test("合法转移全覆盖", () => {
    let legal = 0;
    for (const from of WET_EXPERIMENT_STATES) {
      for (const to of WET_LEGAL_TRANSITIONS[from]) {
        expect(canWetTransition(from, to)).toBe(true);
        legal++;
      }
    }
    expect(legal).toBe(18);
  });

  test("表外一律拒绝（穷举 11×11）", () => {
    let rejected = 0;
    for (const from of WET_EXPERIMENT_STATES) {
      for (const to of WET_EXPERIMENT_STATES) {
        if (WET_LEGAL_TRANSITIONS[from].includes(to)) continue;
        expect(canWetTransition(from, to)).toBe(false);
        rejected++;
      }
    }
    expect(rejected).toBe(WET_EXPERIMENT_STATES.length ** 2 - 18);
  });

  test("concluded / iterated 是终态", () => {
    expect(WET_LEGAL_TRANSITIONS.concluded).toEqual([]);
    expect(WET_LEGAL_TRANSITIONS.iterated).toEqual([]);
  });

  test("**只有 awaiting_approval 能进 wet_run** —— AD-6 在转移表层面的落点", () => {
    const doors = WET_EXPERIMENT_STATES.filter((s) => WET_LEGAL_TRANSITIONS[s].includes("wet_run"));
    expect(doors).toEqual(["awaiting_approval"]);
  });

  test("isWetExperimentState 认全部状态、不认别的", () => {
    for (const state of WET_EXPERIMENT_STATES) expect(isWetExperimentState(state)).toBe(true);
    expect(isWetExperimentState("dry_run")).toBe(false);
    expect(isWetExperimentState(42)).toBe(false);
  });

  test("湿实验状态机与 P5 干实验状态机互不干扰（两张表分开）", async () => {
    const { project } = newWorkspace();
    const dry = new ExperimentLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
    });
    const dryView = await dry.design({
      title: "振子",
      platform: "pyref",
      kind: "damped-oscillator",
      params: { steps: 50 },
    });
    const wet = loopFor(project);
    // 干实验不出现在湿实验清单里，反之亦然。
    expect(wet.list()).toHaveLength(0);
    wet.design({ title: "湿", naturalLanguage: PROTOCOL_A });
    expect(wet.list()).toHaveLength(1);
    expect(dry.list()).toHaveLength(1);
    expect(dry.get(dryView.id).state).toBe("design");
    project.close();
  });
});

describe("compile → safety_check → awaiting_approval", () => {
  test("design 必须有自然语言协议原文", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    expect(() => loop.design({ title: "空", naturalLanguage: "   " })).toThrow(/协议原文/);
    project.close();
  });

  test("编译把 Opentrons 产物落进 record metadata", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = loop.design({ title: "A", naturalLanguage: PROTOCOL_A });
    const { view: compiled, program } = loop.compile(view.id);
    expect(compiled.state).toBe("compile");
    expect(compiled.protocolHash).toBe(program.protocolHash);
    expect(compiled.apiLevel).toBe("2.21");
    expect(compiled.robotType).toBe("Flex");
    expect(compiled.compiledSteps.map((s) => s.action)).toEqual(["addSample", "incubate", "read"]);
    expect(compiled.deck.some((d) => d.role === "reader")).toBe(true);
    project.close();
  });

  test("安全门通过后**停在 awaiting_approval**，绝不自动进 wet_run", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loopFor(project));
    void loop;
    expect(view.state).toBe("awaiting_approval");
    expect(view.safetyPassed).toBe(true);
    expect(view.approval).toBeNull();
    // 两条转移都留痕：「门过了」与「停下来等人」在证据图上分得开。
    const tail = view.history.slice(-2).map((h) => `${h.from}->${h.to}`);
    expect(tail).toEqual(["compile->safety_check", "safety_check->awaiting_approval"]);
    project.close();
  });

  test("安全门不过 → 标 failed 并抛 LabSafetyError，不进 awaiting_approval", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = loop.design({ title: "危险", naturalLanguage: "加入10uL盐酸，加入10uL次氯酸钠" });
    loop.compile(view.id);
    expect(() => loop.safetyCheck(view.id)).toThrow(LabSafetyError);
    const after = loop.get(view.id);
    expect(after.state).toBe("failed");
    expect(after.safetyPassed).toBe(false);
    expect(after.lastError).toContain("chemical compatibility");
    // failed 之后允许改协议重来。
    expect(canWetTransition("failed", "compile")).toBe(true);
    project.close();
  });

  test("被安全门拦下的协议改好后可以重新编译并通过", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = loop.design({ title: "改", naturalLanguage: "加入10uL盐酸，加入10uL次氯酸钠" });
    loop.compile(view.id);
    expect(() => loop.safetyCheck(view.id)).toThrow(LabSafetyError);
    loop.compile(view.id, { naturalLanguage: PROTOCOL_A });
    const fixed = loop.safetyCheck(view.id).view;
    expect(fixed.state).toBe("awaiting_approval");
    expect(fixed.safetyChecks.every((c) => c.passed)).toBe(true);
    project.close();
  });

  test("get 支持 id 前缀；找不到时报错而不是猜", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = loop.design({ title: "A", naturalLanguage: PROTOCOL_A });
    expect(loop.get(view.id.slice(0, 8)).id).toBe(view.id);
    expect(() => loop.get("zzzzzzzz")).toThrow(WetExperimentNotFoundError);
    project.close();
  });
});

describe("approve gate（AD-6）· API 层", () => {
  test("未 approve 的实验拒绝执行，且给出合法路径", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    expect(view.state).toBe("awaiting_approval");
    await expect(loop.execute(view.id)).rejects.toThrow(ApprovalRequiredError);
    await expect(loop.execute(view.id)).rejects.toThrow(/未经 approve 不能执行/);
    // 被拒之后状态没有被偷偷推进。
    expect(loop.get(view.id).state).toBe("awaiting_approval");
    project.close();
  });

  test("每一个 wet_run 之前的状态都不能直接执行", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const design = loop.design({ title: "A", naturalLanguage: PROTOCOL_A });
    await expect(loop.execute(design.id)).rejects.toThrow(ApprovalRequiredError);
    loop.compile(design.id);
    await expect(loop.execute(design.id)).rejects.toThrow(ApprovalRequiredError);
    loop.safetyCheck(design.id);
    await expect(loop.execute(design.id)).rejects.toThrow(ApprovalRequiredError);
    project.close();
  });

  test("approve 落 decision record：谁 / 何时 / 批了哪个协议 hash", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    const { view: approved, decisionId } = loop.approve(view.id, { actor: "张三", note: "剂量合理" });

    expect(approved.state).toBe("wet_run");
    expect(approved.approval?.actor).toBe("张三");
    expect(approved.approval?.protocolHash).toBe(view.protocolHash!);
    expect(approved.approval?.decisionRecordId).toBe(decisionId);

    const decision = project.records().get(decisionId)!;
    expect(decision.type).toBe("decision");
    expect(decision.evidence).toBe("inferred");
    expect((decision.metadata as { decision: string }).decision).toBe("approve");
    expect((decision.metadata as { protocolHash: string }).protocolHash).toBe(view.protocolHash!);
    // decision 在证据图上挂到实验下。
    const edges = project.records().edgesOf(decisionId);
    expect(edges.outgoing.map((e) => `${e.type}:${e.targetId}`)).toContain(`derives_from:${view.id}`);
    // 正文里必须能看到批的是哪些步骤（不是只有一个 hash）。
    expect(decision.content).toContain(view.protocolHash!);
    expect(decision.content).toContain("step-1");
    project.close();
  });

  test("approve 必须记名", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    expect(() => loop.approve(view.id, { actor: "  " })).toThrow(ApprovalRequiredError);
    project.close();
  });

  test("不在 awaiting_approval 的实验不能被 approve", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = loop.design({ title: "A", naturalLanguage: PROTOCOL_A });
    expect(() => loop.approve(view.id, { actor: "张三" })).toThrow(WetStateError);
    loop.compile(view.id);
    expect(() => loop.approve(view.id, { actor: "张三" })).toThrow(WetStateError);
    project.close();
  });

  test("重复 approve 被拒（已经在 wet_run 了）", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.approve(view.id, { actor: "张三" });
    expect(() => loop.approve(view.id, { actor: "李四" })).toThrow(WetStateError);
    project.close();
  });

  test("reject 落 decision record 并进 rejected；理由是必填", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    expect(() => loop.reject(view.id, { actor: "张三", reason: "" })).toThrow(ApprovalRequiredError);
    const { view: rejected, decisionId } = loop.reject(view.id, {
      actor: "张三",
      reason: "样品量不足，先补样",
    });
    expect(rejected.state).toBe("rejected");
    expect(rejected.approval).toBeNull();
    expect(rejected.rejection?.reason).toContain("补样");
    const decision = project.records().get(decisionId)!;
    expect((decision.metadata as { decision: string }).decision).toBe("reject");
    project.close();
  });

  test("被拒之后不能执行，但可以改协议重来", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.reject(view.id, { actor: "张三", reason: "剂量存疑" });
    await expect(loop.execute(view.id)).rejects.toThrow(ApprovalRequiredError);
    const recompiled = loop.compile(view.id, { naturalLanguage: PROTOCOL_B }).view;
    expect(recompiled.state).toBe("compile");
    expect(recompiled.rejection).toBeNull();
    project.close();
  });
});

describe("approve gate · 协议 hash 变了要重新走一遍", () => {
  test("approve 后重新编译 → approve 作废，回到 compile", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    const approved = loop.approve(view.id, { actor: "张三" }).view;
    expect(approved.state).toBe("wet_run");

    const recompiled = loop.compile(view.id, { naturalLanguage: PROTOCOL_B }).view;
    expect(recompiled.state).toBe("compile");
    expect(recompiled.approval).toBeNull();
    expect(recompiled.safetyPassed).toBeNull();
    expect(recompiled.safetyChecks).toEqual([]);
    expect(recompiled.protocolHash).not.toBe(approved.protocolHash);
    expect(recompiled.history.at(-1)?.note).toContain("作废先前的 approve");
    project.close();
  });

  test("作废之后必须重新走 safety_check + approve 才能执行", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.approve(view.id, { actor: "张三" });
    loop.compile(view.id, { naturalLanguage: PROTOCOL_B });
    await expect(loop.execute(view.id)).rejects.toThrow(ApprovalRequiredError);
    const rechecked = loop.safetyCheck(view.id).view;
    expect(rechecked.state).toBe("awaiting_approval");
    await expect(loop.execute(view.id)).rejects.toThrow(ApprovalRequiredError);
    const reapproved = loop.approve(view.id, { actor: "李四" }).view;
    expect(reapproved.approval?.protocolHash).toBe(rechecked.protocolHash!);
    const executed = await loop.execute(view.id);
    expect(executed.state).toBe("collect");
    project.close();
  });

  test("**状态机之外**改了协议同样拦得住（execute 前二次核对 hash）", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.approve(view.id, { actor: "张三" });
    // 模拟「有人直接改了 record」：状态仍是 wet_run、审批还在，但协议原文被换了。
    project.records().update(view.id, { metadata: { naturalLanguage: PROTOCOL_B } });
    await expect(loop.execute(view.id)).rejects.toThrow(ApprovalRequiredError);
    const after = loop.get(view.id);
    expect(after.state).toBe("failed");
    expect(after.approval).toBeNull();
    expect(after.lastError).toContain("协议在审批之后变了");
    project.close();
  });

  test("同一份协议重复编译 hash 不变（不因为重编译就无端失效）", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = loop.design({ title: "A", naturalLanguage: PROTOCOL_A });
    const first = loop.compile(view.id).view.protocolHash;
    const second = loop.compile(view.id).view.protocolHash;
    expect(second).toBe(first);
    project.close();
  });
});

describe("执行 → collect → analyze → conclude", () => {
  test("全链路：产出进 artifact、observation 是 observed", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.approve(view.id, { actor: "张三" });

    const collected = await loop.execute(view.id);
    expect(collected.state).toBe("collect");
    expect(collected.attempts).toBe(1);
    expect(collected.runId).toBeTruthy();
    expect(collected.artifactRecordIds.length).toBeGreaterThanOrEqual(3);
    expect(collected.summary?.protocolSteps).toBe(3);

    // 产出 record：evidence=observed（执行记录是被观察到的，不是算出来的）
    for (const id of collected.artifactRecordIds) {
      const record = project.records().get(id)!;
      expect(record.type).toBe("artifact");
      expect(record.evidence).toBe("observed");
    }
    const filenames = collected.artifactRecordIds.map(
      (id) => (project.records().get(id)!.metadata as { filename: string }).filename,
    );
    expect(filenames).toContain("protocol.py");
    expect(filenames).toContain("runlog.json");

    const analyzed = loop.analyze(collected.id, { note: "首轮基线" });
    expect(analyzed.state).toBe("analyze");
    const observation = project.records().get(analyzed.observationId!)!;
    expect(observation.type).toBe("observation");
    expect(observation.evidence).toBe("observed");
    expect(observation.content).toContain("步骤执行轨迹");
    expect((observation.metadata as { stepTrace: unknown[] }).stepTrace).toHaveLength(3);

    const concluded = loop.conclude(analyzed.id, { claim: "孵育后 OD 显著上升" });
    expect(concluded.state).toBe("concluded");
    const conclusion = project.records().get(concluded.conclusionId!)!;
    expect((conclusion.metadata as { review: string }).review).toBe("pending");

    // 证据图：结论 → observation / experiment → artifact
    const graph = project.records().graph(concluded.conclusionId!, 3);
    const types = graph.nodes.map((n) => n.type).sort();
    expect(types).toContain("conclusion");
    expect(types).toContain("observation");
    expect(types).toContain("experiment");
    expect(types).toContain("artifact");
    expect(types).toContain("decision");
    expect(graph.edges.every((e) => e.type === "derives_from")).toBe(true);
    project.close();
  });

  test("collect 之前不能 analyze；analyze 之前不能 conclude", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.approve(view.id, { actor: "张三" });
    expect(() => loop.analyze(view.id)).toThrow(WetStateError);
    const collected = await loop.execute(view.id);
    expect(() => loop.conclude(collected.id, { claim: "x" })).toThrow(WetStateError);
    project.close();
  });

  test("执行过的实验不能就地重编译（改协议要另起一条）", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.approve(view.id, { actor: "张三" });
    await loop.execute(view.id);
    expect(() => loop.compile(view.id, { naturalLanguage: PROTOCOL_B })).toThrow(WetStateError);
    project.close();
  });

  test("iterate 另起一条并连 supersedes；协议不变时拒绝", async () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.approve(view.id, { actor: "张三" });
    const analyzed = loop.analyze((await loop.execute(view.id)).id);
    expect(() => loop.iterate(analyzed.id, { naturalLanguage: PROTOCOL_A })).toThrow(/重跑不是迭代/);
    const { previous, next } = loop.iterate(analyzed.id, { naturalLanguage: PROTOCOL_B });
    expect(previous.state).toBe("iterated");
    expect(next.state).toBe("design");
    expect(next.iteration).toBe(2);
    expect(next.parentExperimentId).toBe(view.id);
    const edges = project.records().edgesOf(next.id);
    expect(edges.outgoing.some((e) => e.type === "supersedes" && e.targetId === view.id)).toBe(true);
    project.close();
  });
});

describe("状态只在 record 里（换进程接得回来）", () => {
  test("重开项目后状态、审批、编译产物全在", async () => {
    const { manager, project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    loop.approve(view.id, { actor: "张三", note: "已核对试剂" });

    const reopened = restart(manager, project);
    const after = reopened.loop.get(view.id);
    expect(after.state).toBe("wet_run");
    expect(after.approval?.actor).toBe("张三");
    expect(after.approval?.protocolHash).toBe(view.protocolHash!);
    expect(after.compiledSteps).toHaveLength(3);
    // 换了进程照样能执行，而且执行的是当初批的那一版。
    const collected = await reopened.loop.execute(view.id);
    expect(collected.state).toBe("collect");
    reopened.project.close();
  });

  test("record 正文里能读出状态轨迹与审批（撕下来也认得出）", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    const view = upToApproval(loop);
    const approved = loop.approve(view.id, { actor: "张三" }).view;
    const content = approved.record.content;
    expect(content).toContain("状态：**wet_run**");
    expect(content).toContain("张三");
    expect(content).toContain("安全门通过 ≠ 可以执行");
    expect(content).toContain("design → compile");
    project.close();
  });
});

describe("干湿闭环接通", () => {
  async function dryReadyFor(project: Project) {
    const dry = new ExperimentLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
    });
    const view = await dry.design({
      title: "阻尼振子",
      platform: "pyref",
      kind: "damped-oscillator",
      params: { steps: 200, sampleInterval: 20 },
      hypothesis: "能量单调衰减",
    });
    const done = await dry.run(view.id, { timeoutMs: 60_000 });
    expect(done.state).toBe("analyze");
    return { dry, dryView: done };
  }

  test("干实验 analyze → 派生湿实验：干线转 iterated，湿线 supersedes 接棒", async () => {
    const { project } = newWorkspace();
    const { dry, dryView } = await dryReadyFor(project);
    const wet = loopFor(project);
    const derived = await wet.deriveFromDry(dry, dryView.id, {
      title: "湿实验验证",
      naturalLanguage: PROTOCOL_A,
    });
    expect(derived.dry.state).toBe("iterated");
    expect(dry.get(dryView.id).state).toBe("iterated");
    expect(derived.wet.derivedFromDryExperimentId).toBe(dryView.id);
    const edges = project.records().edgesOf(derived.wet.id);
    expect(edges.outgoing.some((e) => e.type === "supersedes" && e.targetId === dryView.id)).toBe(true);
    expect(edges.outgoing.some((e) => e.type === "derives_from" && e.targetId === dryView.id)).toBe(true);
    project.close();
  }, 60_000);

  test("干实验 concluded → 派生湿实验：只连 derives_from，干实验保持终态", async () => {
    const { project } = newWorkspace();
    const { dry, dryView } = await dryReadyFor(project);
    dry.conclude(dryView.id, { claim: "能量按预期衰减" });
    const wet = loopFor(project);
    const derived = await wet.deriveFromDry(dry, dryView.id, {
      title: "湿实验验证",
      naturalLanguage: PROTOCOL_A,
    });
    expect(derived.dry.state).toBe("concluded");
    const edges = project.records().edgesOf(derived.wet.id);
    expect(edges.outgoing.some((e) => e.type === "derives_from" && e.targetId === dryView.id)).toBe(true);
    expect(edges.outgoing.some((e) => e.type === "supersedes")).toBe(false);
    project.close();
  }, 60_000);

  test("还没跑出观察的干实验不能派生湿实验", async () => {
    const { project } = newWorkspace();
    const dry = new ExperimentLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
    });
    const dryView = await dry.design({
      title: "还没跑",
      platform: "pyref",
      kind: "damped-oscillator",
      params: { steps: 50 },
    });
    const wet = loopFor(project);
    await expect(
      wet.deriveFromDry(dry, dryView.id, { title: "湿", naturalLanguage: PROTOCOL_A }),
    ).rejects.toThrow(/只有 analyze \/ concluded/);
    project.close();
  });
});

describe("list / 过滤", () => {
  test("按状态过滤只回该状态的湿实验", () => {
    const { project } = newWorkspace();
    const loop = loopFor(project);
    upToApproval(loop, PROTOCOL_A, "A");
    loop.design({ title: "B", naturalLanguage: PROTOCOL_B });
    expect(loop.list()).toHaveLength(2);
    expect(loop.list({ state: "awaiting_approval" as WetExperimentState })).toHaveLength(1);
    expect(loop.list({ state: "design" as WetExperimentState })).toHaveLength(1);
    expect(loop.list({ state: "wet_run" as WetExperimentState })).toHaveLength(0);
    project.close();
  });
});
