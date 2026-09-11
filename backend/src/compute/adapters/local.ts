// C1 · 第一个 ComputeAdapter：本地子进程（CB-2，设计 §1.1.6）。
//
// 它不是「给测试用的假 adapter」——**它承担全部契约测试**（CI 零凭据），
// 并且走的是与 modal 完全相同的审批链：plan → review → approve → dispatch（消费审批）
// → run → collect。CB-4 的 modal adapter 要过的是这里同一套断言。
//
// 与 `SubprocessSimulationPlatform` 的关系：思想同源（磁盘真源、落文件不 pipe、
// poll 先看结果文件再看 pid），**代码不共享**——契约不同就别硬塞（AD-4 的教训）。

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isProcessAlive } from "../../simulation/run_store";
import {
  RecoverFailure,
  type AdapterCapabilities,
  type AdapterHandle,
  type ComputeAdapter,
  type DispatchSpec,
  type Harvest,
  type ResolvedSpec,
  type RunHooks,
  type RunResult,
} from "../target";
import { UPLOAD_BYTES_LIMIT, UPLOAD_COUNT_LIMIT } from "../uploads";

const EXIT_CODE_FILE = "exit-code";
const RUN_LOG = "run.log";
const SHIM = "runner.sh";

// 为什么要一个 shim：exit-code 必须由**任务这一侧**写下来。如果由编排进程在
// `await proc.exited` 之后写，那么编排进程被 SIGKILL 的那一刻，一个已经跑完的任务
// 会被后来的 recover() 误判成「丢了」。shim 让「跑完了」这件事留在磁盘上。
//
// 注意 `"$@"`：被审批的 argv 原样作为参数传进来，**不做第二次 shell 展开**
// （设计 §1.1.3 ①）。shim 内容是常量，不拼接任何 plan 内容。
const SHIM_SOURCE = `#!/bin/sh
# 由 spark-research local compute adapter 生成。内容是常量，不含任何被审批的字符串。
"$@"
code=$?
printf '%s' "$code" > "$SPARK_COMPUTE_EXIT_FILE.tmp" && mv "$SPARK_COMPUTE_EXIT_FILE.tmp" "$SPARK_COMPUTE_EXIT_FILE"
exit $code
`;

export interface LocalAdapterOptions {
  /** 轮询 exit-code / 日志的间隔。 */
  pollIntervalMs?: number;
  now?: () => number;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readExitCode(jobDir: string): number | null {
  const path = join(jobDir, EXIT_CODE_FILE);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export class LocalComputeAdapter implements ComputeAdapter {
  readonly kind = "local" as const;
  readonly description = "本机子进程（零凭据、不计费；用于开发、CI 与「先在本地跑通再上远端」）";
  private readonly pollIntervalMs: number;

  constructor(private readonly options: LocalAdapterOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
  }

  capabilities(): AdapterCapabilities {
    return {
      billable: false,
      persistentVolume: false,
      // 编排进程死了任务还在、重启能接回来——这是 P5 就定下的判据。
      recovery: true,
      // 本机进程确实能拿到 env 里的密钥，如实声明（值只在 dispatch 时刻解析，用完即弃）。
      secretRefs: true,
      // 本机进程的网络**事实上**不受限。声明 "none" 表示这次运行不需要网络；
      // 声明 "unrestricted" 表示需要，于是 approvalRequired 派生为 true（L-3）——
      // 「本地」不等于「不需要人点头」。
      network: ["none", "unrestricted"],
      gpus: [],
      uploadLimits: { count: UPLOAD_COUNT_LIMIT, bytes: UPLOAD_BYTES_LIMIT },
    };
  }

  async check(): Promise<{ ok: boolean; reason: string | null; detail: Record<string, string | number | boolean | null> }> {
    const ok = existsSync("/bin/sh");
    return {
      ok,
      reason: ok ? null : "/bin/sh 不存在——local adapter 需要它来落 exit-code 标记",
      detail: { platform: process.platform, shell: "/bin/sh" },
    };
  }

  async run(spec: DispatchSpec, hooks: RunHooks): Promise<RunResult> {
    const workspace = join(spec.jobDir, "workspace");
    mkdirSync(workspace, { recursive: true });
    const shimPath = join(spec.jobDir, SHIM);
    writeFileSync(shimPath, SHIM_SOURCE);
    chmodSync(shimPath, 0o700);
    // 上一轮的终态标记必须清掉，否则 recover() 会看到旧的 exit-code。
    rmSync(join(spec.jobDir, EXIT_CODE_FILE), { force: true });

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...spec.plan.env,
      PYTHONUNBUFFERED: "1",
      SPARK_COMPUTE_EXIT_FILE: join(spec.jobDir, EXIT_CODE_FILE),
    };
    // 密钥只在这一刻解析，注入子进程环境；**不落任何文件**（AD-2 / 设计 §1.1.10）。
    for (const ref of spec.plan.secretRefs) {
      Object.assign(env, spec.resolveSecret(ref));
    }

    // stdout/stderr 落文件而不是 pipe：编排进程被 kill 之后 pipe 就没人读了，
    // 落文件才能在重启后还看得到任务说了什么（platform.ts:218-233 同一理由）。
    const logPath = join(spec.jobDir, RUN_LOG);
    const outFd = openSync(logPath, "w");
    let proc: import("bun").Subprocess;
    try {
      proc = Bun.spawn(["/bin/sh", shimPath, ...spec.plan.command], {
        cwd: workspace,
        stdout: outFd,
        stderr: outFd,
        stdin: "ignore",
        env,
      });
    } finally {
      closeSync(outFd);
    }
    const handle: AdapterHandle = {
      kind: "local",
      data: { pid: proc.pid ?? null, startedAt: new Date().toISOString(), logPath, workspace },
    };
    // V48：spawn 成功、拿到 pid 的这一刻立刻回调——这是「handle 存在」这件事第一次成立
    // 的时间点。**先**于 awaitTerminal()（后面可能跑几分钟才返回）调用，broker 借这个
    // 回调把 handle 落盘，编排进程在等待期间被杀也不会把它带走。
    hooks.onHandle?.(handle);
    hooks.onState?.({ execution: "running" });
    return this.awaitTerminal(spec, handle, hooks, proc);
  }

  async recover(spec: ResolvedSpec, handle: AdapterHandle, hooks: RunHooks): Promise<RunResult> {
    // 顺序照 platform.ts:258-300：**先看 exit-code 文件再看 pid**。
    // 任务写完标记才退出，所以只要标记在，无论 pid 是死是活（僵尸 / PID 复用）
    // 都以标记为准。
    const exitCode = readExitCode(spec.jobDir);
    if (exitCode !== null) {
      return { exitCode, timedOut: false, handle };
    }
    const pid = typeof handle.data.pid === "number" ? handle.data.pid : null;
    if (isProcessAlive(pid)) {
      return this.awaitTerminal(spec, handle, hooks, null);
    }
    throw new RecoverFailure(
      "not_found",
      `local 任务的进程（pid=${pid ?? "?"}）已消失，且没有留下 exit-code 标记——` +
        `任务可能随编排进程一起被杀。这类失败重跑一次就可能好，但重跑需要**新的审批**。`,
    );
  }

  async collect(spec: ResolvedSpec, handle: AdapterHandle): Promise<Harvest> {
    const workspace = join(spec.jobDir, "workspace");
    const harvestDir = join(spec.jobDir, "harvest");
    mkdirSync(harvestDir, { recursive: true });
    const files: Harvest["files"] = [];
    const seen = new Set<string>();
    for (const pattern of spec.plan.outputs) {
      const glob = new Bun.Glob(pattern);
      for (const rel of glob.scanSync({ cwd: workspace, onlyFiles: true, dot: false })) {
        const posix = rel.split("\\").join("/");
        if (seen.has(posix)) continue;
        seen.add(posix);
        const src = join(workspace, rel);
        const dest = join(harvestDir, posix);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        files.push({ path: posix, bytes: statSync(dest).size, sha256: sha256File(dest) });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    const exitCode = readExitCode(spec.jobDir);
    const startedAt = typeof handle.data.startedAt === "string" ? Date.parse(handle.data.startedAt) : NaN;
    const exitPath = join(spec.jobDir, EXIT_CODE_FILE);
    const finishedAt = existsSync(exitPath) ? statSync(exitPath).mtimeMs : NaN;
    const wallSeconds =
      Number.isFinite(startedAt) && Number.isFinite(finishedAt)
        ? Math.max(0, Number(((finishedAt - startedAt) / 1000).toFixed(3)))
        : null;

    // reconcile：任务侧的标记与我们手上的记录对不上，就如实报出来，让调用方标
    // delivery=failed。**不许猜**——「大概是成功了吧」是这类系统最贵的一句话。
    let reconcileError: string | null = null;
    if (exitCode === null) {
      reconcileError = `工作目录里没有 exit-code 标记：任务是否真的跑完无法确认（${spec.jobId}）`;
    }
    return {
      files,
      logPath: join(spec.jobDir, RUN_LOG),
      exitCode,
      wallSeconds,
      reconcileError,
    };
  }

  async cancel(_spec: ResolvedSpec, handle: AdapterHandle): Promise<void> {
    const pid = typeof handle.data.pid === "number" ? handle.data.pid : null;
    if (pid === null || !isProcessAlive(pid)) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经不在了就算了 */
    }
  }

  async release(spec: ResolvedSpec, _handle: AdapterHandle): Promise<void> {
    // local 的「远端卷」就是 job 目录下的 workspace。harvest/ 与 run.log 是产物与审计，
    // **不删**——release 释放的是资源，不是证据。
    rmSync(join(spec.jobDir, "workspace"), { recursive: true, force: true });
  }

  // ── 等待终态：run() 与 recover() 共用 ──────────────────────────────────
  private async awaitTerminal(
    spec: ResolvedSpec,
    handle: AdapterHandle,
    hooks: RunHooks,
    proc: import("bun").Subprocess | null,
  ): Promise<RunResult> {
    const timeoutMs = spec.plan.resources.timeoutMinutes * 60_000;
    const startedAt =
      typeof handle.data.startedAt === "string" ? Date.parse(handle.data.startedAt) : Date.now();
    const deadline = startedAt + timeoutMs;
    const pid = typeof handle.data.pid === "number" ? handle.data.pid : null;
    const logPath = join(spec.jobDir, RUN_LOG);
    let logOffset = 0;
    let timedOut = false;

    const pumpLog = (): void => {
      if (!hooks.onLog || !existsSync(logPath)) return;
      const size = statSync(logPath).size;
      if (size <= logOffset) return;
      const text = readFileSync(logPath, "utf8").slice(logOffset);
      logOffset = size;
      for (const line of text.split("\n")) if (line !== "") hooks.onLog(line);
    };

    const kill = (): void => {
      if (pid !== null && isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 竞态：刚好自己退了 */
        }
      }
      proc?.kill(9);
    };

    for (;;) {
      const exitCode = readExitCode(spec.jobDir);
      if (exitCode !== null) {
        pumpLog();
        return { exitCode, timedOut, handle };
      }
      if (hooks.signal?.aborted) {
        kill();
        pumpLog();
        return { exitCode: readExitCode(spec.jobDir), timedOut, handle };
      }
      if (Date.now() > deadline) {
        timedOut = true;
        kill();
        pumpLog();
        return { exitCode: readExitCode(spec.jobDir), timedOut: true, handle };
      }
      if (proc !== null && proc.exitCode !== null && readExitCode(spec.jobDir) === null) {
        // 子进程退了却没留下标记 → shim 本身被杀（OOM / SIGKILL）。如实返回它的退出码，
        // 由 broker 判 failed；**不假装成功**。
        pumpLog();
        return { exitCode: proc.exitCode, timedOut, handle };
      }
      if (proc === null && pid !== null && !isProcessAlive(pid) && readExitCode(spec.jobDir) === null) {
        throw new RecoverFailure(
          "not_found",
          `重挂的 local 任务（pid=${pid}）在等待期间消失且没有留下 exit-code 标记`,
        );
      }
      pumpLog();
      await Bun.sleep(this.pollIntervalMs);
    }
  }
}
