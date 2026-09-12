import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  SimulationRunError,
  SimulationSpecError,
  UnknownRunError,
  isTerminalRunState,
  type PlatformAvailability,
  type PreparedRun,
  type RunStatus,
  type SimRunState,
  type SimulationOutputFile,
  type SimulationOutputs,
  type SimulationPlatform,
  type SimulationSpec,
} from "./models";
import { RunStore, isProcessAlive, getProcessStartTime, type RunRecord } from "./run_store";
import { USER_OWNED_LICENSE } from "../provenance/policy";
import { JsonlRawSink, globalRawSink, redact, type RawSink } from "../raw";

export * from "./models";
export { RunStore, isProcessAlive, getProcessStartTime } from "./run_store";
export type { RunRecord, DoneEnvelope } from "./run_store";

// Python 解释器解析：与 kernels/manager 同一口径（SPARK_PYTHON > 仓库 .venv > python3）。
// 刻意不 import kernels/manager —— 那个模块会把 ControlRepl/daemon 一并拖进来，
// 仿真层对 daemon 应当零依赖。
//
// V75（V61 家族）：编译产物里 `import.meta.dir` 是 /$bunfs 虚拟路径，拼出来的 .venv
// 永远 existsSync=false → 二进制在仓库目录里也找不到 .venv，全部科学平台被**误报
// 不可用**（实测 .venv 四个平台俱全、源码模式全 ✅、二进制全 ❌）。二进制场景改用
// `process.execPath`（真实二进制路径，dist/ 在仓库内 → 上一级就是仓库根）推导。
export function resolvePython(): string {
  const env = process.env.SPARK_PYTHON;
  if (env) return env;
  const candidates = [join(import.meta.dir, "../../../.venv/bin/python")];
  if (import.meta.dir.startsWith("/$bunfs")) {
    candidates.push(join(dirname(process.execPath), "../.venv/bin/python"));
  }
  for (const venv of candidates) {
    if (existsSync(venv)) return venv;
  }
  return "python3";
}

// 归一化后按 key 排序再序列化：specHash 不能受 JS 对象字面量书写顺序影响。
export function canonicalJson(value: unknown): string {
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
  /**
   * V85（v0.8 W8-1 β）：prepare/submit/collect 落 raw/simulation/ 用的 sink。
   * 现有生产调用方（experiment/loop.ts 的 design()/dryRun()/collect()）不在本 lane
   * 足迹内，改不了它们的调用参数去显式传项目 raw sink——所以这里**默认自动推导**：
   * 不传就按 `root` 反推项目根（`root` 的形状恒为 `<projectRoot>/experiments/<platformId>`，
   * 见 registry.ts 的 `join(this.root, id)`），推导不出（没有 project.json，比如
   * capabilities/doctor 那两个探测用途的 registry）就落全局兜底 `globalRawSink()`——
   * 与 kernels/manager.ts 的 `raw?.sink ?? globalRawSink()` 同一条兜底纪律。
   * 显式传入仍然优先（测试/未来接线用）。
   */
  raw?: { sink: RawSink; project?: string | null; sessionId?: string | null; command?: string | null };
}

/**
 * `platformRoot` 反推项目 raw sink：`<projectRoot>/experiments/<platformId>` → `<projectRoot>/raw`。
 * 与 project/manager.ts 的 `pathsFor()`（`experimentsDir: join(root,"experiments")`,
 * `rawDir: join(root,"raw")`）逐字节同构，但这里不 import Project/ProjectManager——
 * simulation/ 对 project/ 保持零依赖（与本文件其余部分同一条边界纪律）。用
 * `project.json` 的存在性核验「这确实是个项目根」，不是瞎猜：capabilities/index.ts
 * 与 doctor/index.ts 那两个用临时目录 / 探测专用 root 构造的 registry 只调
 * `available()`，从不走到 prepare/submit/collect，但万一将来有人接上，也不会把
 * raw 行错写进一个不存在项目元数据的目录。
 */
function deriveProjectRawSink(platformRoot: string): { sink: RawSink; project: string | null } {
  const experimentsDir = dirname(platformRoot);
  const projectRoot = dirname(experimentsDir);
  if (basename(experimentsDir) === "experiments" && existsSync(join(projectRoot, "project.json"))) {
    const project = basename(projectRoot);
    return { sink: new JsonlRawSink(join(projectRoot, "raw"), { project }), project };
  }
  return { sink: globalRawSink(), project: null };
}

// W7-C2（V3）：poll() 里「本进程没有活句柄、但 pid 看着还活着」这条路径专用的核验。
// 返回 orphaned 原因；null 表示核验不出问题（继续按 running 处理——查不出来不等于
// 查出来有问题，安全方向仍是「只多报不少报」）。
function crossCheckPidIdentity(pid: number | null, recordedStartedAt: string | null, startTimeUnavailable: boolean): string | null {
  if (pid == null) return null;
  if (startTimeUnavailable || recordedStartedAt === null) return null; // 只能核存在性，存在就继续信。
  const currentStartedAt = getProcessStartTime(pid);
  if (currentStartedAt === null) return null; // 这次探测失败：不要用「测不到」误判成 orphaned。
  if (currentStartedAt !== recordedStartedAt) {
    return `pid=${pid} 仍存活，但启动时间对不上（记录=${recordedStartedAt}，此刻=${currentStartedAt}）——pid 已被复用，原进程已经不在了，结果不确定`;
  }
  return null;
}

// 本地子进程型仿真平台的公共骨架：openmm 与 pyref 都是「写 params.json →
// 起一个 python runner → runner 自己写 done.json」，差别只在 runner 与参数归一化。
//
// 这里刻意**不**复用 v0.1 的 `compute/providers.ts`（ComputeProvider）：那套的 wait() 是阻塞
// 语义、状态全在内存里，跨进程接不上。P5 需要的是「编排进程死了任务还在、重启能接回来」，
// 与 ComputeProvider 的契约不是一回事（见 devlog P5 决策 D1）。
// P8-G6：该模块已连同 v0.1 测试一并删除，此处保留这段说明是为了记住**为什么**另起契约。
export abstract class SubprocessSimulationPlatform implements SimulationPlatform {
  abstract readonly id: string;
  abstract readonly description: string;
  abstract readonly deterministic: boolean;
  // 每个 adapter 支持的任务种类。
  abstract readonly kinds: readonly string[];

  readonly root: string;
  readonly store: RunStore;
  protected readonly python: string;
  protected readonly probeTimeoutMs: number;
  // 只在「本进程亲自 submit 过」时有值。它不是状态真源（磁盘才是），
  // 只用来补一个磁盘看不出来的信息：子进程已退出但没写 done.json（僵尸进程 pid 仍在）。
  private handles = new Map<string, import("bun").Subprocess>();
  private readonly rawOptions: SubprocessPlatformOptions["raw"];

  constructor(options: SubprocessPlatformOptions) {
    this.root = options.root;
    this.store = new RunStore(join(options.root, "runs"));
    this.python = options.python ?? resolvePython();
    this.probeTimeoutMs = options.probeTimeoutMs ?? 30_000;
    this.rawOptions = options.raw;
  }

  // V85：prepare/submit/collect 的唯一落地点。与 kernels/manager.ts 的 appendRaw() 同口径——
  // 写盘失败不打断仿真本身，系统性漏记由门禁 G1 对账抓；sink **每次现算**（不缓存单例），
  // 与 raw/index.ts 头部注释、api_ledger.ts 的既有纪律一致（单测里同进程切换
  // SPARK_RESEARCH_DATA_DIR 时不会读到构造期缓存的旧路径）。
  private appendRaw(
    stage: "prepare" | "submit" | "collect",
    input: {
      runId: string | null;
      specHash: string | null;
      simKind: string;
      params?: Record<string, unknown> | null;
      status?: string | null;
      summaryText?: string | null;
      files?: { filename: string; role: string; bytes: number }[] | null;
    },
  ): void {
    try {
      const derived = this.rawOptions?.sink ? null : deriveProjectRawSink(this.root);
      const sink = this.rawOptions?.sink ?? derived!.sink;
      const project = this.rawOptions ? (this.rawOptions.project ?? undefined) : (derived!.project ?? undefined);
      sink.append({
        kind: "simulation",
        project,
        sessionId: this.rawOptions?.sessionId ?? null,
        command: this.rawOptions?.command ?? null,
        provenanceClass: "derived",
        license: USER_OWNED_LICENSE,
        payload: {
          platform: this.id,
          simKind: input.simKind,
          stage,
          runId: input.runId,
          specHash: input.specHash,
          params: input.params ? redact(input.params) : null,
          status: input.status ?? null,
          summary: input.summaryText != null ? sink.body(input.summaryText) : null,
          files: input.files ?? null,
        },
      });
    } catch {
      // 见上：raw 落盘失败不打断仿真执行本身。
    }
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
    const prepared: PreparedRun = {
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
    // V85：prepare 阶段落一行——runId 还没有（submit 才产生），specHash 把三个阶段串起来。
    this.appendRaw("prepare", { runId: null, specHash, simKind: spec.kind, params });
    return prepared;
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

    // W7-C2（V3）：submit() 落盘那一刻就把子进程的启动时间记下来——poll() 读回（尤其是
    // 「本进程没有活句柄」那条跨进程路径）时要拿它跟同一个 pid 此刻的启动时间再比一次。
    const pidStartedAt = getProcessStartTime(proc.pid ?? null);
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
      pidStartedAt,
      startTimeUnavailable: pidStartedAt === null,
    };
    this.store.create(record);
    this.handles.set(runId, proc);
    // 不 await proc.exited：submit 必须非阻塞（契约 #2）。
    proc.exited.catch(() => {});
    // V85：submit 阶段落一行——params 已经在 prepare 行里记过，这里不重复记，
    // 只落 runId/specHash/初始状态（串联三阶段用的是 specHash + runId）。
    this.appendRaw("submit", { runId, specHash: prepared.specHash, simKind: prepared.kind, status: record.state });
    return runId;
  }

  async poll(runId: string): Promise<RunStatus> {
    const record = this.store.read(runId);
    if (!record) throw new UnknownRunError(runId);
    // W7-C2（V3）：`orphaned` 是本 lane 加的第五态，只存在于 `RunRecord.state`（run_store.ts，
    // 比 models.ts 的 `SimRunState` 宽一个值），单独短路掉——既是「一旦判定就不会再变回
    // running，跟 completed/failed 一样不用重查」，也是让下面 `isTerminalRunState()` 拿到
    // 的 `record.state` 收窄回 `SimRunState`，类型对得上（models.ts 不在本 lane 足迹内）。
    if (record.state === "orphaned") return this.toStatus(record, null);
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
      if (!handle) {
        // W7-C2（V3）：本进程没有这个 runId 的活句柄——不是这个 `SubprocessSimulationPlatform`
        // 实例自己 submit 的（另一个 CLI/server 实例 submit 的，或本进程重启过）。pid 存活
        // 不代表「就是当年那个进程」——这正是 V3 的原始投诉：pid 可能已经被系统回收又
        // 分配给一个完全无关的新进程。本进程亲手 submit 的（`handle` 非空）不用查，我们
        // 手上就攥着真正的子进程句柄，ground truth 不需要靠 pid 猜。
        const orphanReason = crossCheckPidIdentity(
          record.pid,
          record.pidStartedAt ?? null,
          record.startTimeUnavailable === true,
        );
        if (orphanReason) {
          const orphaned = this.store.patch(runId, {
            state: "orphaned",
            message: orphanReason,
            finishedAt: new Date().toISOString(),
            recoverable: false,
          })!;
          return this.toStatus(orphaned, null);
        }
      }
      return this.toStatus(record, this.readProgress(runId));
    }

    // 进程不在了、结果也没有：典型的「编排进程和任务一起被 kill」。
    // 标 failed 但 recoverable=true —— 这类失败重跑一次就可能好。
    //
    // W7-C2（V3）：这条既有分支特意保持不变——把它也并入 orphaned 会牵动
    // `backend/src/experiment/loop.ts`（禁止修改）与 `tests/unit/experiment*.test.ts`
    // （不在本 lane 足迹内）里对「pid 不存在 → failed + recoverable=true +『已消失』文案」
    // 的既有断言（`process.kill(pid,'SIGKILL')` 之后期待 `lastError` 含「已消失」）。
    // V3 真正投诉的是「pid 复用误判」——上面 `!handle` 分支已经补上；这条「pid 干脆不在了」
    // 的分支本来就没有复用歧义（不存在就是不存在），沿用既有口径，diff 见报告。
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

    const outputs: SimulationOutputs = {
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
    // V85：collect 阶段落一行——摘要与产出清单（不含绝对路径，只留文件名/角色/字节数）。
    this.appendRaw("collect", {
      runId,
      specHash: record.specHash,
      simKind: record.kind,
      status: status.state,
      summaryText: JSON.stringify(outputs.summary),
      files: files.map((f) => ({ filename: f.filename, role: f.role, bytes: f.bytes })),
    });
    return outputs;
  }

  async cancel(runId: string): Promise<RunStatus> {
    const record = this.store.read(runId);
    if (!record) throw new UnknownRunError(runId);
    // W7-C2（V3）：同 poll() 里的说明——orphaned 比 models.ts 的 SimRunState 宽一个值，
    // 单独短路掉再把 record.state 收窄回 SimRunState 给 isTerminalRunState()。
    if (record.state === "orphaned") return this.toStatus(record, null);
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
      // W7-C2（V3）：`record.state` 的类型是 `SimRunState | "orphaned"`（run_store.ts），
      // `RunStatus.state` 的类型仍是 models.ts 原本的 `SimRunState`（models.ts 不在本 lane
      // 足迹内，没有改它）——这里的类型断言是已知、刻意留下的缺口：运行时这个字段确实
      // 可能是字符串 `"orphaned"`，静态类型看不出来。收口时把 `SIM_RUN_STATES` /
      // `RunStatus.state` 加上 `"orphaned"` 就能去掉这处断言，diff 见报告。
      state: record.state as SimRunState,
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
