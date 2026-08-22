import type { LabDevice, DeviceActionResult, DeviceDriver } from "./devices";
import type { Protocol, ProtocolStep, SafetyCheckResult } from "./protocol";

export interface ExecutionLogEntry {
  timestamp: string;
  iteration?: number;
  stepId?: string;
  device?: string;
  action?: string;
  message: string;
  success: boolean;
  data?: Record<string, unknown>;
}

export interface SafetyReport {
  passed: boolean;
  checks: SafetyCheckResult[];
}

export interface DryWetIteration {
  iteration: number;
  design: string;
  protocolId: string;
  protocolSteps: ProtocolStep[];
  results: DeviceActionResult[];
  dataSummary?: Record<string, unknown>;
}

export class LabSafetyError extends Error {
  constructor(public report: SafetyReport) {
    super(
      `protocol rejected by safety gate: ${report.checks
        .filter((c) => !c.passed)
        .map((c) => c.check)
        .join(", ")}`,
    );
    this.name = "LabSafetyError";
  }
}

export class LabSafetyGate {
  static readonly MAX_CONCENTRATION: Record<string, number> = {
    hypochlorite: 100,
    ethanol: 95,
    strong_acid: 200,
  };

  static readonly CHEMICAL_COMPATIBILITY: Record<string, string[]> = {
    strong_acid: ["hypochlorite", "hydroxide"],
    hypochlorite: ["strong_acid"],
    hydroxide: ["strong_acid"],
  };

  static readonly MAX_BIOSAFETY_LEVEL = 2;

  checkProtocol(protocol: Protocol): SafetyReport {
    const checks: SafetyCheckResult[] = [];

    const reagents = protocol.steps.flatMap((s) => {
      const list = (s.params.reagents ?? []) as ReagentLike[];
      return list.map((r) => ({ ...r, stepId: s.id }));
    });

    const incompatible: string[] = [];
    for (let i = 0; i < reagents.length; i++) {
      for (let j = i + 1; j < reagents.length; j++) {
        const a = reagents[i];
        const b = reagents[j];
        if (!a.reagentId || !b.reagentId) continue;
        const conflicts =
          (LabSafetyGate.CHEMICAL_COMPATIBILITY[a.reagentId] ?? []).includes(b.reagentId) ||
          (LabSafetyGate.CHEMICAL_COMPATIBILITY[b.reagentId] ?? []).includes(a.reagentId);
        if (conflicts) incompatible.push(`${a.name} + ${b.name}`);
      }
    }
    checks.push({
      check: "chemical compatibility",
      passed: incompatible.length === 0,
      detail: incompatible.length ? `incompatible reagents: ${incompatible.join(", ")}` : undefined,
    });

    const overLimit = reagents.filter(
      (r) =>
        r.reagentId != null &&
        r.concentration != null &&
        (LabSafetyGate.MAX_CONCENTRATION[r.reagentId] ?? Infinity) < r.concentration,
    );
    checks.push({
      check: "concentration limit",
      passed: overLimit.length === 0,
      detail: overLimit.length
        ? `over-limit reagents: ${overLimit.map((r) => `${r.name} (${r.concentration})`).join(", ")}`
        : undefined,
    });

    const biohazardous = protocol.steps.some(
      (s) => Number(s.params.biosafetyLevel ?? 1) > LabSafetyGate.MAX_BIOSAFETY_LEVEL,
    );
    checks.push({
      check: "biosafety",
      passed: !biohazardous,
      detail: biohazardous ? "biosafety level exceeds allowed maximum" : undefined,
    });

    return { passed: checks.every((c) => c.passed), checks };
  }
}

interface ReagentLike {
  name: string;
  reagentId?: string;
  concentration?: number;
}

export class LabOrchestrator {
  private devices = new Map<string, LabDevice>();
  private drivers = new Map<string, DeviceDriver>();
  private executionLog: ExecutionLogEntry[] = [];

  constructor(private safetyGate?: LabSafetyGate) {}

  registerDevice(device: LabDevice): void {
    this.devices.set(device.id, device);
  }

  registerDriver(deviceId: string, driver: DeviceDriver): void {
    this.drivers.set(deviceId, driver);
  }

  getDevice(type: string): LabDevice | undefined {
    for (const device of this.devices.values()) {
      if (device.type === type) return device;
    }
    return undefined;
  }

  listDevices(): Array<{
    id: string;
    name: string;
    type: LabDevice["type"];
    status: LabDevice["status"];
    capabilities: LabDevice["capabilities"];
  }> {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      status: d.status,
      capabilities: d.capabilities,
    }));
  }

  private findDevice(step: ProtocolStep): LabDevice {
    const device = this.getDevice(step.device);
    if (!device) throw new Error(`no device registered for type: ${step.device}`);
    return device;
  }

  async runProtocol(protocol: Protocol): Promise<DeviceActionResult[]> {
    if (this.safetyGate) {
      const report = this.safetyGate.checkProtocol(protocol);
      this.log({
        message: report.passed ? "safety gate passed" : "safety gate rejected protocol",
        success: report.passed,
      });
      if (!report.passed) throw new LabSafetyError(report);
    }

    const results: DeviceActionResult[] = [];
    for (const step of protocol.steps) {
      const device = this.findDevice(step);
      const driver = this.drivers.get(device.id);
      const result = driver
        ? await driver.executeAction(step.action, step.params)
        : await device.execute(step.action, step.params);
      this.log({
        stepId: step.id,
        device: device.id,
        action: step.action,
        message: `${device.name} executed ${step.action}`,
        success: result.success,
        data: result.data,
      });
      results.push(result);
    }
    return results;
  }

  async runDryWetLoop(
    designFn: (previousData: unknown) => string | Promise<string>,
    protocolFn: (design: string) => Protocol | Promise<Protocol>,
    iterations: number,
  ): Promise<{ iterations: number; finalData: unknown; iterationLog: DryWetIteration[] }> {
    const iterationLog: DryWetIteration[] = [];
    let previousData: unknown = null;

    for (let i = 1; i <= iterations; i++) {
      const design = await designFn(previousData);
      const protocol = await protocolFn(design);
      const results = await this.runProtocol(protocol);
      previousData = results.map((r) => r.data);
      iterationLog.push({
        iteration: i,
        design,
        protocolId: protocol.id,
        protocolSteps: protocol.steps,
        results,
        dataSummary: this.summarizeResults(results),
      });
    }

    return { iterations, finalData: previousData, iterationLog };
  }

  private summarizeResults(results: DeviceActionResult[]): Record<string, unknown> {
    const numeric: Record<string, number[]> = {};
    for (const r of results) {
      if (!r.data) continue;
      for (const [key, value] of Object.entries(r.data)) {
        if (typeof value === "number") {
          (numeric[key] ??= []).push(value);
        }
      }
    }
    const summary: Record<string, unknown> = {
      successCount: results.filter((r) => r.success).length,
    };
    for (const [key, values] of Object.entries(numeric)) {
      summary[key] = {
        count: values.length,
        mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)),
      };
    }
    return summary;
  }

  getExecutionLog(): ExecutionLogEntry[] {
    return [...this.executionLog];
  }

  private log(entry: Omit<ExecutionLogEntry, "timestamp">) {
    this.executionLog.push({ timestamp: new Date().toISOString(), ...entry });
  }
}
