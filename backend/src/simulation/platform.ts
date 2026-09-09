import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SimulationRunError,
  SimulationSpecError,
  UnknownRunError,
  isTerminalRunState,
  type PlatformAvailability,
  type PreparedRun,
  type RunStatus,
  type SimulationOutputFile,
  type SimulationOutputs,
  type SimulationPlatform,
  type SimulationSpec,
} from "./models";
import { RunStore, isProcessAlive, type RunRecord } from "./run_store";

export * from "./models";
export { RunStore, isProcessAlive } from "./run_store";
export type { RunRecord, DoneEnvelope } from "./run_store";

// Python 解释器解析：与 kernels/manager 同一口径（SPARK_PYTHON > 仓库 .venv > python3）。
// 刻意不 import kernels/manager —— 那个模块会把 ControlRepl/daemon 一并拖进来，
// 仿真层对 daemon 应当零依赖。
export function resolvePython(): string {
  const env = process.env.SPARK_PYTHON;
  if (env) return env;
  const venv = join(import.meta.dir, "../../../.venv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

// 归一化后按 key 排序再序列化：specHash 不能受 JS 对象字面量书写顺序影响。
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function specHashOf(platform: string, kind: string, params: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson({ platform, kind, params })).digest("hex").slice(0, 16);
}

// 参数取数的小工具：类型不对就抛 SimulationSpecError（宁可当场拒，也不让 runner 收到 NaN）。
export function numberParam(
  params: Record<string, unknown>,
  name: string,
  fallback: number,
  bounds: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const raw = params[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) throw new SimulationSpecError(`参数 '${name}' 必须是有限数字，收到 ${JSON.stringify(raw)}`);
  if (bounds.integer && !Number.isInteger(value)) {
    throw new SimulationSpecError(`参数 '${name}' 必须是整数，收到 ${value}`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new SimulationSpecError(`参数 '${name}' 必须 ≥ ${bounds.min}，收到 ${value}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new SimulationSpecError(`参数 '${name}' 必须 ≤ ${bounds.max}，收到 ${value}`);
  }
  return value;
}

export function enumParam<T extends string>(
  params: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = params[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = String(raw);
  if (!allowed.includes(value as T)) {
    throw new SimulationSpecError(`参数 '${name}' 只能是 ${allowed.join(" / ")}，收到 '${value}'`);
  }
  return value as T;
}

export function boolParam(params: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const raw = params[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const value = String(raw).toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new SimulationSpecError(`参数 '${name}' 必须是布尔值，收到 '${String(raw)}'`);
}

export interface NormalizedSpec {
  params: Record<string, unknown>;
  expectedOutputs: string[];
  warnings?: string[];
}

export interface SubprocessPlatformOptions {
  // 该平台的工作根目录（一般是 <project>/experiments/<platformId>）。
  root: string;
  python?: string;
  // 单次 available() 探测的超时。
  probeTimeoutMs?: number;
}

// 本地子进程型仿真平台的公共骨架：openmm 与 pyref 都是「写 params.json →
// 起一个 python runner → runner 自己写 done.json」，差别只在 runner 与参数归一化。
//
// 这里刻意**不**复用 compute/providers.ts 的 ComputeProvider：那套的 wait() 是阻塞语义、
// 状态全在内存里，跨进程接不上。P5 需要的是「编排进程死了任务还在、重启能接回来」，
// 与 ComputeProvider 的契约不是一回事（见 devlog 决策 D1）。
export abstract class SubprocessSimulationPlatform implements SimulationPlatform {
  abstract readonly id: string;
  abstract readonly description: string;
  // 每个 adapter 支持的任务种类。
  abstract readonly kinds: readonly string[];

  readonly root: string;
  readonly store: RunStore;
  protected readonly python: string;
  protected readonly probeTimeoutMs: number;
  // 只在「本进程亲自 submit 过」时有值。它不是状态真源（磁盘才是），
  // 只用来补一个磁盘看不出来的信息：子进程已退出但没写 done.json（僵尸进程 pid 仍在）。
  private handles = new Map<string, import("bun").Subprocess>();

  constructor(options: SubprocessPlatformOptions) {
    this.root = options.root;
    this.store = new RunStore(join(options.root, "runs"));
    this.python = options.python ?? resolvePython();
    this.probeTimeoutMs = options.probeTimeoutMs ?? 30_000;
  }

  // 子类实现：参数归一化 + 预期产出清单。非法参数抛 SimulationSpecError。
  protected abstract normalize(kind: string, params: Record<string, unknown>): NormalizedSpec;
  // 子类实现：runner 脚本的绝对路径。
  protected abstract entryPointFor(kind: string): string;
  // 子类实现：可用性探测（返回一段 python 代码，跑通即可用）。
  protected abstract probeCode(): string;

  async available(): Promise<PlatformAvailability> {
    const proc = Bun.spawn([this.python, "-c", this.probeCode()], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), this.probeTimeoutMs);
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";
    try {
      [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        reason: `${this.id} 探测失败（python=${this.python}, exit=${exitCode}）：${stderr.trim().split("\n").slice(-3).join(" ")}`,
        detail: { python: this.python, exitCode },
      };
    }
    let detail: Record<string, string | number | boolean | null> = { python: this.python };
    try {
      detail = { ...detail, ...(JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, never>) };
    } catch {
      detail.probe = stdout.trim().slice(0, 200);
    }
    return { ok: true, reason: null, detail };
  }

  async prepare(spec: SimulationSpec): Promise<PreparedRun> {
    if (spec.platform && spec.platform !== this.id) {
      throw new SimulationSpecError(`spec.platform='${spec.platform}' 与平台 '${this.id}' 不匹配`);
    }
    if (!this.kinds.includes(spec.kind)) {
      throw new SimulationSpecError(
        `平台 '${this.id}' 不支持任务种类 '${spec.kind}'（可用：${this.kinds.join(", ")}）`,
      );
    }
    const { params, expectedOutputs, warnings } = this.normalize(spec.kind, spec.params ?? {});
    const specHash = specHashOf(this.id, spec.kind, params);
    const stageDir = join(this.root, "prepared", specHash);
    mkdirSync(stageDir, { recursive: true });
    // 幂等：同一个 spec 重复 prepare 得到同一个 stageDir 与同一份 params.json。
    writeFileSync(join(stageDir, "params.json"), JSON.stringify(params, null, 2) + "\n");
    return {
      platform: this.id,
      kind: spec.kind,
      specHash,
      entryPoint: this.entryPointFor(spec.kind),
      params,
      stageDir,
      expectedOutputs,
      label: spec.label ?? null,
      warnings: warnings ?? [],
    };
  }

  async submit(prepared: PreparedRun): Promise<string> {
    if (prepared.platform !== this.id) {
      throw new SimulationSpecError(`prepared.platform='${prepared.platform}' 与平台 '${this.id}' 不匹配`);
    }
    if (!existsSync(prepared.entryPoint)) {
      throw new SimulationRunError(`runner 脚本不存在: ${prepared.entryPoint}`);
    }
    const runId = `${this.id}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const dir = this.store.dirOf(runId);
    mkdirSync(dir, { recursive: true });
    const paramsPath = join(dir, "params.json");
    copyFileSync(join(prepared.stageDir, "params.json"), paramsPath);

    // stdout/stderr 直接落文件（而不是 pipe）：编排进程被 kill 之后 pipe 就没人读了，
    // 落文件才能在重启后还看得到任务说了什么。
    const outFd = openSync(join(dir, "stdout.log"), "w");
    const errFd = openSync(join(dir, "stderr.log"), "w");
    let proc: import("bun").Subprocess;
    try {
      proc = Bun.spawn([this.python, prepared.entryPoint, "--params", paramsPath, "--outdir", dir], {
        stdout: outFd,
        stderr: errFd,
        stdin: "ignore",
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }

    const record: RunRecord = {
      runId,
      platform: this.id,
      kind: prepared.kind,
      specHash: prepared.specHash,
      label: prepared.label,
      state: "running",
      pid: proc.pid ?? null,
      exitCode: null,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      entryPoint: prepared.entryPoint,
      params: prepared.params,
      expectedOutputs: prepared.expectedOutputs,
      recoverable: false,
    };
    this.store.create(record);
    this.handles.set(runId, proc);
    // 不 await proc.exited：submit 必须非阻塞（契约 #2）。
    proc.exited.catch(() => {});
    return runId;
  }

  async poll(runId: string): Promise<RunStatus> {
    const record = this.store.read(runId);
    if (!record) throw new UnknownRunError(runId);
    if (isTerminalRunState(record.state)) return this.toStatus(record, null);

    // 顺序很重要：**先看 done.json**。任务写完结果才退出，所以只要结果在，
    // 无论 pid 是死是活（僵尸 / PID 复用）都以结果为准。
    const done = this.store.done(runId);
    if (done) {
      const next = this.store.patch(runId, {
        state: done.status,
        exitCode: done.status === "completed" ? 0 : 1,
        message: done.error ?? null,
        finishedAt: done.finishedAt ?? new Date().toISOString(),
        startedAt: done.startedAt ?? record.startedAt,
        recoverable: false,
      })!;
      return this.toStatus(next, null);
    }

    const handle = this.handles.get(runId);
    if (handle && handle.exitCode !== null) {
      // 本进程 submit 的子进程已退出却没写 done.json → 算例中途死了（OOM/被杀/解释器崩溃）。
      const next = this.store.patch(runId, {
        state: "failed",
        exitCode: handle.exitCode,
        message: `runner 进程退出（code=${handle.exitCode}）但没有写出结果`,
        finishedAt: new Date().toISOString(),
        recoverable: true,
      })!;
      return this.toStatus(next, null);
    }

    if (isProcessAlive(record.pid)) {
      return this.toStatus(record, this.readProgress(runId));
    }

    // 进程不在了、结果也没有：典型的「编排进程和任务一起被 kill」。
    // 标 failed 但 recoverable=true —— 这类失败重跑一次就可能好。
    const next = this.store.patch(runId, {
      state: "failed",
      message: `runner 进程（pid=${record.pid ?? "?"}）已消失，且没有写出结果——任务可能随进程一起被杀，可重试`,
      finishedAt: new Date().toISOString(),
      recoverable: true,
    })!;
    return this.toStatus(next, null);
  }

  async collect(runId: string): Promise<SimulationOutputs> {
    const status = await this.poll(runId);
    const record = this.store.read(runId)!;
    if (status.state !== "completed") {
      throw new SimulationRunError(
        `run '${runId}' 状态为 ${status.state}，不能 collect${status.message ? `：${status.message}` : ""}`,
      );
    }
    const done = this.store.done(runId);
    if (!done) throw new SimulationRunError(`run '${runId}' 标记为 completed 但结果文件缺失`);

    const dir = this.store.dirOf(runId);
    const declared = done.files ?? [];
    const files: SimulationOutputFile[] = [];
    for (const entry of declared) {
      const path = join(dir, entry.filename);
      if (!existsSync(path)) {
        throw new SimulationRunError(`run '${runId}' 声明产出 '${entry.filename}' 但文件不存在`);
      }
      files.push({ path, filename: entry.filename, role: entry.role, bytes: statSync(path).size });
    }
    const missing = record.expectedOutputs.filter((name) => !files.some((f) => f.filename === name));
    if (missing.length > 0) {
      throw new SimulationRunError(`run '${runId}' 缺少预期产出: ${missing.join(", ")}`);
    }

    return {
      runId,
      platform: this.id,
      kind: record.kind,
      files,
      summary: done.summary ?? {},
      log: this.store.logTail(runId, "stdout.log"),
      startedAt: done.startedAt ?? record.startedAt,
      finishedAt: done.finishedAt ?? record.finishedAt,
      wallSeconds: done.wallSeconds ?? null,
    };
  }

  async cancel(runId: string): Promise<RunStatus> {
    const record = this.store.read(runId);
    if (!record) throw new UnknownRunError(runId);
    if (isTerminalRunState(record.state)) return this.toStatus(record, null);
    if (record.pid && isProcessAlive(record.pid)) {
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {
        // 进程恰好在这一刻退出：走下面的状态落库即可。
      }
    }
    const next = this.store.patch(runId, {
      state: "failed",
      message: "run 被主动取消",
      finishedAt: new Date().toISOString(),
      recoverable: true,
    })!;
    return this.toStatus(next, null);
  }

  listRuns(): string[] {
    return this.store.list();
  }

  // runner 可选写 progress.json；给不出就是 null，不编造进度条。
  private readProgress(runId: string): number | null {
    const file = join(this.store.dirOf(runId), "progress.json");
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { fraction?: number };
      const value = Number(parsed.fraction);
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
    } catch {
      return null;
    }
  }

  private toStatus(record: RunRecord, progress: number | null): RunStatus {
    return {
      runId: record.runId,
      platform: record.platform,
      state: record.state,
      progress,
      message: record.message,
      pid: record.pid,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      recoverable: record.recoverable,
    };
  }
}
