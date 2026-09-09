// 干实验（in silico）仿真平台的数据模型（DESIGN 域 B1 + AD-4）。
//
// AD-4：仿真 adapter **独立于 connector**。connector 是数据读取（幂等、一问一答），
// 仿真是长任务生命周期（prepare/submit/poll/collect），两者契约不同，硬塞进
// 一个抽象里只会把两边都做坏。

export const SIM_RUN_STATES = ["pending", "running", "completed", "failed"] as const;
export type SimRunState = (typeof SIM_RUN_STATES)[number];

export function isTerminalRunState(state: SimRunState): boolean {
  return state === "completed" || state === "failed";
}

// 用户/agent 递给平台的任务描述。params 由各 adapter 自己解释与校验。
export interface SimulationSpec {
  // adapter id（"pyref" / "openmm"）。由调用方选平台，platform 自己不猜。
  platform: string;
  // 任务种类，adapter 内部的分支键（如 "damped-oscillator" / "water-box-md"）。
  kind: string;
  params?: Record<string, unknown>;
  label?: string;
}

// prepare() 的产出：**归一化后**的任务描述 + 落盘的输入。
// specHash 是归一化 params 的确定性摘要——同一个 spec 必然得到同一个 hash，
// 这是「同一次实验能不能重放」的判据。
export interface PreparedRun {
  platform: string;
  kind: string;
  specHash: string;
  // adapter 的执行入口（本地进程型 adapter 就是 runner 脚本的绝对路径）。
  entryPoint: string;
  // 归一化后的参数（补齐默认值、类型收敛）。
  params: Record<string, unknown>;
  // 落盘的输入目录（params.json 在这里）。
  stageDir: string;
  // 预期产出的文件名（collect 按这个清单核对）。
  expectedOutputs: string[];
  label: string | null;
  warnings: string[];
}

export interface RunStatus {
  runId: string;
  platform: string;
  state: SimRunState;
  // 0..1；adapter 给不出就是 null（不要编造进度条）。
  progress: number | null;
  message: string | null;
  pid: number | null;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  // 进程消失但没留结果时为 true：这类失败重跑一次就可能好，与「算例本身跑挂了」不同。
  recoverable: boolean;
}

export interface SimulationOutputFile {
  // 绝对路径。
  path: string;
  filename: string;
  // 语义角色："trajectory" / "final_state" / "result" / "log"。
  role: string;
  bytes: number;
}

export interface SimulationOutputs {
  runId: string;
  platform: string;
  kind: string;
  files: SimulationOutputFile[];
  // 标量摘要，直接进 observation record；只放能一眼看懂的数字/字符串。
  summary: Record<string, string | number | boolean | null>;
  // stdout 尾部（截断），排障用。
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
  wallSeconds: number | null;
}

export interface PlatformAvailability {
  ok: boolean;
  // 不可用时给出**可操作**的原因（缺哪个包、装哪条命令），不要只说 "not available"。
  reason: string | null;
  detail: Record<string, string | number | boolean | null>;
}

// P5 的核心契约（AD-4）。两个参考实现（openmm / pyref）共用同一套契约测试套件。
//
// 生命周期不变量（契约测试逐条守）：
//   1. prepare 是确定性的：同一个 spec → 同一个 specHash、同一份归一化 params
//   2. submit 非阻塞：立刻返回 runId，任务在别的进程里跑
//   3. poll 只读且可跨进程：**状态在磁盘上**，换一个平台实例（乃至换一个进程）照样能接上
//   4. collect 只在 completed 时给结果；running/failed 一律抛错，不给半成品
export interface SimulationPlatform {
  readonly id: string;
  readonly description: string;
  available(): Promise<PlatformAvailability>;
  prepare(spec: SimulationSpec): Promise<PreparedRun>;
  submit(prepared: PreparedRun): Promise<string>;
  poll(runId: string): Promise<RunStatus>;
  collect(runId: string): Promise<SimulationOutputs>;
  cancel(runId: string): Promise<RunStatus>;
  listRuns(): string[];
}

export class SimulationSpecError extends Error {
  constructor(message: string) {
    super(`SimulationSpec: ${message}`);
    this.name = "SimulationSpecError";
  }
}

export class SimulationRunError extends Error {
  constructor(message: string) {
    super(`SimulationRun: ${message}`);
    this.name = "SimulationRunError";
  }
}

export class UnknownRunError extends SimulationRunError {
  constructor(runId: string) {
    super(`unknown run '${runId}'`);
    this.name = "UnknownRunError";
  }
}
