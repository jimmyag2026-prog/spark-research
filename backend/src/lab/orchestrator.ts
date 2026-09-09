import type { LabDevice, DeviceActionResult, DeviceDriver } from "./devices";
import type { OpentronsProgram } from "./opentrons_protocol";
import type { Protocol, ProtocolStep } from "./protocol";
import {
  CHEMICAL_COMPATIBILITY,
  MAX_BIOSAFETY_LEVEL,
  MAX_CONCENTRATION,
  runSafetyRules,
  SAFETY_RULES,
  type SafetyReport,
} from "./safety";

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

export type { SafetyReport };
export { SAFETY_RULES } from "./safety";

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

// 安全门的**门面**。规则本体在 `safety.ts`（P6 起每条规则是独立可单测的纯函数）；
// 这里只保留 v0.1 起就在的调用面与那三张表的静态引用，避免上游调用方改口径。
export class LabSafetyGate {
  static readonly MAX_CONCENTRATION: Readonly<Record<string, number>> = MAX_CONCENTRATION;
  static readonly CHEMICAL_COMPATIBILITY: Readonly<Record<string, readonly string[]>> =
    CHEMICAL_COMPATIBILITY;
  static readonly MAX_BIOSAFETY_LEVEL = MAX_BIOSAFETY_LEVEL;
  static readonly RULES = SAFETY_RULES;

  // program 是可选的编译产物：给了就用真实 deck 体积核对孔板容量（规则 4），
  // 不给就只核对协议声明的单次加液（detail 里明说没查什么，不静默放行）。
  checkProtocol(protocol: Protocol, program?: OpentronsProgram | null): SafetyReport {
    return runSafetyRules({ protocol, program: program ?? null });
  }
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
