import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToOpentrons } from "../../backend/src/lab/opentrons_protocol";
import { ProtocolCompiler } from "../../backend/src/lab/protocol";
import { OpentronsSimulatorBackend, type WetRunLogEntry } from "../../backend/src/lab/wet_backend";
import { WetLabLoop } from "../../backend/src/lab/wet_loop";
import { ProjectManager, type Project } from "../../backend/src/project/manager";

// P6 e2e：**真实** `opentrons.simulate.simulate()`（DEVELOPMENT_PLAN P6 退出标准）。
//
// 两类协议：
//   A 移液 + 孵育 + 读数（Heater-Shaker 控温 + 吸光度读板模块 600 nm）
//   B 梯度稀释（多步转移 + 逐级混匀）
// 都断言 run log 的**关键步骤序列**，不是「跑完没报错」。
//
// 与 mock 后端的分工：mock 验管线，真模拟器验**协议合不合法**。
// 一个 opentrons 拒绝解析的脚本在 mock 后端一样会「跑成功」——那是最危险的假绿。

const PROTOCOL_A = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";
const PROTOCOL_B = "配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次";

const backend = new OpentronsSimulatorBackend();
const availability = await backend.available();
if (!availability.ok) {
  console.warn(`⚠️  跳过 P6 e2e：${availability.reason}`);
}
const suite = availability.ok ? describe : describe.skip;

function newProject(slug: string): { manager: ProjectManager; project: Project } {
  const root = mkdtempSync(join(tmpdir(), "wet-e2e-"));
  const manager = new ProjectManager(root);
  return { manager, project: manager.create(slug) };
}

function loopFor(project: Project): WetLabLoop {
  return new WetLabLoop({
    records: project.records(),
    artifacts: project.artifacts(),
    root: join(project.paths.experimentsDir, "wet"),
    backend,
  });
}

// run log 里某一步的命令类型序列（不含 step_marker 本身）。
function typesOfStep(entries: WetRunLogEntry[], stepId: string): string[] {
  return entries.filter((e) => e.stepId === stepId && e.type !== "step_marker").map((e) => e.type);
}

suite("Opentrons 真模拟器 · 协议 A（移液 + 孵育 + 读数）", () => {
  test("run log 的关键步骤序列正确", async () => {
    const protocol = new ProtocolCompiler().compile(PROTOCOL_A, { name: "A", protocolId: "e2e-a" });
    const program = compileToOpentrons(protocol);
    const result = await backend.execute(program, { root: mkdtempSync(join(tmpdir(), "runA-")) });

    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.backend).toBe("opentrons_simulate");
    expect(String(result.detail.opentronsVersion)).toMatch(/^\d+\./);

    // ① 加样：取一个 tip → 吸 50 µL → 打 50 µL → 丢 tip
    const step1 = typesOfStep(result.entries, "step-1");
    expect(step1).toEqual(["transfer", "pick_up_tip", "aspirate", "dispense", "drop_tip"]);
    const aspirate = result.entries.find((e) => e.stepId === "step-1" && e.type === "aspirate")!;
    expect(aspirate.volume).toBe(50);
    expect(aspirate.location).toContain("NEST 12 Well Reservoir");
    const dispense = result.entries.find((e) => e.stepId === "step-1" && e.type === "dispense")!;
    expect(dispense.volume).toBe(50);
    expect(dispense.location).toContain("Corning 96 Well Plate");
    expect(dispense.location).toContain("Heater-Shaker");

    // ② 孵育：设温 → 等温 → 延时 3600 s → 关加热
    expect(typesOfStep(result.entries, "step-2")).toEqual([
      "set_temperature",
      "wait_temperature",
      "delay",
      "deactivate",
    ]);
    const setTemp = result.entries.find((e) => e.type === "set_temperature")!;
    expect(setTemp.temperature).toBe(37);
    const delay = result.entries.find((e) => e.type === "delay")!;
    expect(delay.seconds).toBe(3600);

    // ③ 读数：开锁 → 板搬进读板器 → 读 → 搬回来 → 结果
    const step3 = typesOfStep(result.entries, "step-3");
    expect(step3.filter((t) => t === "move_labware")).toHaveLength(2);
    expect(step3.at(-1)).toBe("read_result");
    const reading = result.entries.find((e) => e.type === "read_result")!;
    expect((reading.reading as { wavelength: number }).wavelength).toBe(600);
    expect((reading.reading as { stepId: string }).stepId).toBe("step-3");
    // 真读板模块给了 96 个孔的读数（不是我们编的）
    const wells = (reading.reading as { wells: Record<string, { wells: number }> }).wells;
    expect(wells["600"]!.wells).toBe(96);

    // 摘要：只放可判定的量
    expect(result.summary.protocolSteps).toBe(3);
    expect(result.summary.dispensedUl).toBe(50);
    expect(result.summary.delaySeconds).toBe(3600);
    expect(result.summary.maxTemperatureC).toBe(37);
    expect(result.summary.readings).toBe(1);

    // 落盘的脚本与执行的是同一份
    const files = Object.fromEntries(result.files.map((f) => [f.filename, f]));
    expect(Object.keys(files).sort()).toEqual(["protocol.py", "runlog.json", "runlog.txt"]);
    expect(readFileSync(files["protocol.py"]!.path, "utf8")).toBe(program.source);
    expect(readFileSync(files["runlog.txt"]!.path, "utf8")).toContain("Aspirating 50.0 uL");
  }, 60_000);
});

suite("Opentrons 真模拟器 · 协议 B（梯度稀释）", () => {
  test("run log 体现 6 级稀释：5 次级间转移，每次换 tip 并混匀 3 遍", async () => {
    const protocol = new ProtocolCompiler().compile(PROTOCOL_B, { name: "B", protocolId: "e2e-b" });
    const program = compileToOpentrons(protocol);
    const result = await backend.execute(program, { root: mkdtempSync(join(tmpdir(), "runB-")) });

    expect(result.status).toBe("completed");
    // step-1 是离机配液：只该有一条 note，一滴液体都不该动。
    expect(typesOfStep(result.entries, "step-1")).toEqual(["note"]);

    const dilution = result.entries.filter((e) => e.stepId === "step-2");
    // 5 次级间转移各一个新 tip（+ 分装稀释液 1 个 + 原液 1 个 = 7）
    expect(dilution.filter((e) => e.type === "pick_up_tip")).toHaveLength(7);
    expect(dilution.filter((e) => e.type === "drop_tip")).toHaveLength(7);
    expect(dilution.filter((e) => e.type === "mix")).toHaveLength(5);
    for (const mix of dilution.filter((e) => e.type === "mix")) {
      expect(mix.repetitions).toBe(3);
      expect(mix.volume).toBe(80);
    }

    // 级间转移的孔位序列：A1→A2→A3→A4→A5→A6
    const serial = dilution.filter(
      (e) => e.type === "dispense" && e.depth === 0 && e.parentType !== "mix",
    );
    expect(serial).toHaveLength(5);
    for (const [index, entry] of serial.entries()) {
      expect(entry.volume).toBe(100);
      expect(entry.location).toContain(`A${index + 2} of Corning`);
    }

    // 摘要：500（稀释液）+ 200（原液）+ 5×100（级间）= 1200 µL，混匀不计入
    expect(result.summary.dispensedUl).toBe(1200);
    expect(result.summary.mixes).toBe(5);
    expect(result.summary.readings).toBe(0);
    expect(result.summary.moveLabware).toBe(0);
  }, 60_000);
});

suite("Opentrons 真模拟器 · 拒绝非法协议", () => {
  test("模拟器解析不了的脚本 → failed 信封 + 错误原文，不假装成功", async () => {
    const protocol = new ProtocolCompiler().compile(PROTOCOL_A, { name: "bad", protocolId: "e2e-bad" });
    const program = compileToOpentrons(protocol);
    // 换成一个 Opentrons 一定不认识的 labware：真实的失败模式，不是人为的错误开关。
    const broken = {
      ...program,
      source: program.source.replace("corning_96_wellplate_360ul_flat", "totally_not_a_labware"),
    };
    const result = await backend.execute(broken, { root: mkdtempSync(join(tmpdir(), "runBad-")) });
    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
    expect(result.entries).toHaveLength(0);
  }, 60_000);
});

suite("P6 e2e · 自然语言 → 编译 → 安全门 → approve → 模拟执行 → observation → conclude", () => {
  test("全链路一遍走完，证据图与决策记录都对得上", async () => {
    const { project } = newProject("p6-e2e");
    const loop = loopFor(project);

    // ① 自然语言协议
    const designed = loop.design({
      title: "样品孵育后 OD600 测定",
      naturalLanguage: PROTOCOL_A,
      hypothesis: "37 °C 孵育 1 小时后 OD600 相对起始值上升",
    });
    expect(designed.state).toBe("design");

    // ② 编译
    const compiled = loop.compile(designed.id).view;
    expect(compiled.state).toBe("compile");
    expect(compiled.protocolHash).toHaveLength(16);

    // ③ 安全门 → 停在 awaiting_approval
    const { view: waiting, report } = loop.safetyCheck(designed.id);
    expect(report.passed).toBe(true);
    expect(waiting.state).toBe("awaiting_approval");

    // ④ 未 approve 不许执行
    await expect(loop.execute(designed.id)).rejects.toThrow(/未经 approve/);

    // ⑤ approve → decision record 落图
    const { view: approved, decisionId } = loop.approve(designed.id, {
      actor: "王五",
      note: "试剂与体积均已复核",
    });
    expect(approved.state).toBe("approved");
    const decision = project.records().get(decisionId)!;
    expect(decision.type).toBe("decision");
    expect((decision.metadata as { protocolHash: string }).protocolHash).toBe(compiled.protocolHash!);

    // ⑥ 真模拟器执行 + 回收
    const collected = await loop.execute(designed.id);
    expect(collected.state).toBe("collect");
    expect(collected.summary?.protocolSteps).toBe(3);
    expect(collected.runLogEntryCount).toBeGreaterThan(10);

    // ⑦ run log 进 observation（evidence=observed）
    const analyzed = loop.analyze(designed.id, { note: "首轮基线" });
    const observation = project.records().get(analyzed.observationId!)!;
    expect(observation.evidence).toBe("observed");
    expect(observation.content).toContain("Opentrons 官方**模拟器**");
    expect(observation.content).toContain(compiled.protocolHash!);
    const stepTrace = (observation.metadata as { stepTrace: Array<{ stepId: string; entries: number }> })
      .stepTrace;
    expect(stepTrace.map((s) => s.stepId)).toEqual(["step-1", "step-2", "step-3"]);
    expect(stepTrace.every((s) => s.entries > 0)).toBe(true);
    const readings = (observation.metadata as { readings: unknown[] }).readings;
    expect(readings).toHaveLength(1);

    // ⑧ conclude
    const concluded = loop.conclude(designed.id, {
      claim: "模拟执行确认协议可跑通；OD600 读数已采集，真机验证待排期",
      limitations: "硬件为模拟，读数不代表真实生物学信号",
    });
    expect(concluded.state).toBe("concluded");

    // 证据图：结论 ← observation ← artifact/实验 ← decision
    const graph = project.records().graph(concluded.conclusionId!, 3);
    const kinds = new Set(graph.nodes.map((n) => n.type));
    expect([...kinds].sort()).toEqual(["artifact", "conclusion", "decision", "experiment", "observation"]);
    // run log artifact 真的存得下来且能读回
    const runlogRecord = collected.artifactRecordIds
      .map((id) => project.records().get(id)!)
      .find((r) => (r.metadata as { filename: string }).filename === "runlog.json")!;
    const artifact = project.artifacts().get(runlogRecord.artifactId!)!;
    const parsed = JSON.parse(artifact.content) as { entries: WetRunLogEntry[] };
    expect(parsed.entries.length).toBe(collected.runLogEntryCount!);
    project.close();
  }, 120_000);
});
