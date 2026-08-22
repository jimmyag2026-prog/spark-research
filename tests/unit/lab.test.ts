import { describe, test, expect } from "bun:test";
import { ProtocolCompiler, validateProtocol } from "../../backend/src/lab/protocol";
import {
  LabOrchestrator,
  LabSafetyGate,
  LabSafetyError,
} from "../../backend/src/lab/orchestrator";
import {
  OPENTRONS_LIQUID_HANDLER,
  THERMAL_SHAKER,
  PLATE_READER,
  CENTRIFUGE,
  OpentronsDriver,
} from "../../backend/src/lab/devices";
import type { LabDevice, DeviceType } from "../../backend/src/lab/devices";

function mockDevice(id: string, type: DeviceType): LabDevice {
  return {
    id,
    name: id,
    type,
    status: "idle",
    capabilities: { actions: ["*"] },
    async execute(action, params = {}) {
      return { success: true, data: { action, device: id, params } };
    },
  };
}

describe("ProtocolCompiler", () => {
  test("compiles natural language into ordered step sequence", () => {
    const compiler = new ProtocolCompiler();
    const protocol = compiler.compile(
      "配制缓冲液。加入样品。在37度孵育30分钟。以800rpm震荡。离心。读取酶标仪。",
      { name: "standard-assay" },
    );

    expect(protocol.name).toBe("standard-assay");
    expect(protocol.steps.map((s) => s.action)).toEqual([
      "prepareReagent",
      "addSample",
      "incubate",
      "shake",
      "centrifuge",
      "read",
    ]);
    expect(protocol.steps.map((s) => s.device)).toEqual([
      "liquid_handler",
      "liquid_handler",
      "incubator",
      "shaker",
      "centrifuge",
      "plate_reader",
    ]);
    expect(protocol.steps[2].params.temperature).toBe(37);
    expect(protocol.steps[3].params.rpm).toBe(800);
    expect(protocol.steps[5].params.wavelength).toBe(600);
  });

  test("extracts reagents and validateProtocol catches bad order", () => {
    const compiler = new ProtocolCompiler();
    const protocol = compiler.compile("加入盐酸。加入次氯酸钠。", { name: "bad-mix" });
    expect(protocol.steps[0].params.reagents).toEqual([
      { name: "盐酸", reagentId: "strong_acid" },
    ]);

    const badOrder = compiler.compile("离心。加样。", { name: "order" });
    expect(validateProtocol(badOrder).valid).toBe(false);
    expect(validateProtocol(badOrder).issues[0]).toContain("centrifugation");
  });

  test("splits a compound sentence into multiple independent steps", () => {
    const compiler = new ProtocolCompiler();
    const protocol = compiler.compile("配置50mL LB培养基，加入100uL抗生素，在37°C孵育过夜", {
      name: "compound",
    });

    expect(protocol.steps.length).toBeGreaterThanOrEqual(3);
    expect(protocol.steps.map((s) => s.action)).toEqual([
      "prepareReagent",
      "addSample",
      "incubate",
    ]);
    expect(protocol.steps.map((s) => s.device)).toEqual([
      "liquid_handler",
      "liquid_handler",
      "incubator",
    ]);
    expect(protocol.steps[2].params.temperature).toBe(37);
    expect(protocol.steps[2].params.durationSec).toBe(12 * 60 * 60);
  });

  test("extracts temperature, volume, and duration parameters", () => {
    const compiler = new ProtocolCompiler();
    const protocol = compiler.compile(
      "配置50mL LB培养基，加入100uL抗生素，在37°C孵育30分钟，以800rpm震荡",
      { name: "params" },
    );

    expect(protocol.steps[0].params.volume).toBe(50);
    expect(protocol.steps[0].params.unit).toBe("mL");
    expect(protocol.steps[1].params.volume).toBe(100);
    expect(protocol.steps[1].params.unit).toBe("uL");
    expect(protocol.steps[2].params.temperature).toBe(37);
    expect(protocol.steps[2].params.durationSec).toBe(1800);
    expect(protocol.steps[3].params.rpm).toBe(800);
  });
});

describe("LabOrchestrator", () => {
  test("runProtocol dispatches steps to registered devices", async () => {
    const orchestrator = new LabOrchestrator();
    orchestrator.registerDevice(OPENTRONS_LIQUID_HANDLER);
    orchestrator.registerDevice(THERMAL_SHAKER);
    orchestrator.registerDevice(PLATE_READER);
    orchestrator.registerDevice(CENTRIFUGE);
    orchestrator.registerDevice(mockDevice("mock-incubator", "incubator"));

    const protocol = new ProtocolCompiler().compile("加样。读数。", { name: "dispatch" });
    const results = await orchestrator.runProtocol(protocol);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);

    const log = orchestrator.getExecutionLog();
    const stepEntries = log.filter((e) => e.stepId);
    expect(stepEntries).toHaveLength(2);
    expect(stepEntries[0].device).toBe("opentrons-ot2");
    expect(stepEntries[0].action).toBe("addSample");
    expect(stepEntries[1].device).toBe("plate-reader-01");
    expect(stepEntries[1].action).toBe("read");
  });

  test("throws when no device registered for a step type", async () => {
    const orchestrator = new LabOrchestrator();
    const protocol = new ProtocolCompiler().compile("离心。", { name: "orphan" });
    expect(orchestrator.runProtocol(protocol)).rejects.toThrow(
      "no device registered for type: centrifuge",
    );
  });
});

describe("OpentronsDriver", () => {
  test("errors clearly when host is not configured", async () => {
    const driver = new OpentronsDriver();
    await expect(driver.connect({})).rejects.toThrow(/OPENTRONS_HOST/);
  });

  test("executes actions after connect and rejects before connect", async () => {
    const driver = new OpentronsDriver();
    await expect(
      driver.executeAction("addSample", { volume: 10 }),
    ).rejects.toThrow(/not connected/);

    await driver.connect({ host: "192.168.1.50" });
    const result = await driver.executeAction("addSample", { volume: 10, unit: "uL" });
    expect(result.success).toBe(true);
    expect(result.data?.command).toEqual({ command: "addSample", params: { volume: 10, unit: "uL" } });
  });
});

describe("LabSafetyGate", () => {
  test("rejects incompatible chemicals", () => {
    const gate = new LabSafetyGate();
    const protocol = new ProtocolCompiler().compile("加入盐酸。加入次氯酸钠。", {
      name: "unsafe",
    });
    const report = gate.checkProtocol(protocol);

    expect(report.passed).toBe(false);
    const compat = report.checks.find((c) => c.check === "chemical compatibility");
    expect(compat?.passed).toBe(false);
    expect(compat?.detail).toContain("盐酸 + 次氯酸钠");
  });

  test("rejects over-limit concentration", () => {
    const gate = new LabSafetyGate();
    const protocol = new ProtocolCompiler().compile("加入次氯酸钠。", { name: "dilute" });
    protocol.steps[0].params.reagents = [
      { name: "次氯酸钠", reagentId: "hypochlorite", concentration: 500 },
    ];
    const report = gate.checkProtocol(protocol);
    expect(report.checks.find((c) => c.check === "concentration limit")?.passed).toBe(false);
  });

  test("orchestrator blocks execution of rejected protocol", async () => {
    const orchestrator = new LabOrchestrator(new LabSafetyGate());
    orchestrator.registerDevice(OPENTRONS_LIQUID_HANDLER);
    const protocol = new ProtocolCompiler().compile("加入盐酸。加入次氯酸钠。", {
      name: "unsafe-run",
    });

    await expect(orchestrator.runProtocol(protocol)).rejects.toThrow(LabSafetyError);
    const log = orchestrator.getExecutionLog();
    expect(log.some((e) => e.message.includes("safety gate rejected"))).toBe(true);
  });
});

describe("LabOrchestrator.runDryWetLoop", () => {
  test("runs the requested number of dry-wet iterations", async () => {
    const orchestrator = new LabOrchestrator();
    orchestrator.registerDevice(OPENTRONS_LIQUID_HANDLER);
    orchestrator.registerDevice(PLATE_READER);

    let designCount = 0;
    const compiler = new ProtocolCompiler();
    const result = await orchestrator.runDryWetLoop(
      () => {
        designCount++;
        return "加样。读数。";
      },
      (design) => compiler.compile(design, { name: `round-${designCount}` }),
      3,
    );

    expect(designCount).toBe(3);
    expect(result.iterations).toBe(3);
    expect(result.iterationLog).toHaveLength(3);
    for (const it of result.iterationLog) {
      expect(it.results).toHaveLength(2);
      expect(it.protocolId).toMatch(/^protocol-\d+$/);
    }
    expect(result.iterationLog[0].results[1].data).toHaveProperty("od600");
    expect(result.finalData).toHaveLength(2);
  });

  test("passes previous iteration data into the design function", async () => {
    const orchestrator = new LabOrchestrator();
    orchestrator.registerDevice(OPENTRONS_LIQUID_HANDLER);
    orchestrator.registerDevice(PLATE_READER);

    const seenData: unknown[] = [];
    const compiler = new ProtocolCompiler();
    await orchestrator.runDryWetLoop(
      (prev) => {
        seenData.push(prev);
        return "加样。读数。";
      },
      (design) => compiler.compile(design, { name: "round" }),
      2,
    );

    expect(seenData).toHaveLength(2);
    expect(seenData[0]).toBeNull();
    expect(seenData[1]).not.toBeNull();
  });

  test("records protocol steps and data summary per iteration", async () => {
    const orchestrator = new LabOrchestrator();
    orchestrator.registerDevice(OPENTRONS_LIQUID_HANDLER);
    orchestrator.registerDevice(PLATE_READER);

    const compiler = new ProtocolCompiler();
    const result = await orchestrator.runDryWetLoop(
      () => "配置50mL培养基。加样。读数。",
      (design) => compiler.compile(design, { name: "loop" }),
      2,
    );

    expect(result.iterationLog).toHaveLength(2);
    const first = result.iterationLog[0];
    expect(first.protocolSteps).toHaveLength(3);
    expect(first.protocolSteps.map((s) => s.action)).toEqual([
      "prepareReagent",
      "addSample",
      "read",
    ]);
    expect(first.results).toHaveLength(3);
    expect(first.dataSummary).toBeDefined();
    expect(first.dataSummary?.successCount).toBe(3);
    expect(first.dataSummary?.od600).toHaveProperty("mean");
    expect(result.iterationLog[1].protocolSteps).toHaveLength(3);
  });

  test("dispatches to a registered real driver when present", async () => {
    const orchestrator = new LabOrchestrator();
    orchestrator.registerDevice(OPENTRONS_LIQUID_HANDLER);
    const driver = new OpentronsDriver();
    await driver.connect({ host: "opentrons.local" });
    orchestrator.registerDriver(OPENTRONS_LIQUID_HANDLER.id, driver);

    const protocol = new ProtocolCompiler().compile("加入100uL样品。", { name: "driver" });
    const results = await orchestrator.runProtocol(protocol);

    expect(results).toHaveLength(1);
    expect(results[0].data?.driver).toBe("opentrons");
    const command = results[0].data?.command as { command: string } | undefined;
    expect(command?.command).toBe("addSample");
  });
});
