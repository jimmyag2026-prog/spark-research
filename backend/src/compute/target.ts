// C1 · 执行地契约（CB-1，设计 §2.3）。
//
// `ComputeAdapter` 是**执行地**契约（哪台机器 / 什么环境 / 怎么审批 / 怎么收割），
// 与 `SimulationPlatform` 的**学科域**契约并列而非包含（K-1）：把 target 塞进
// SimulationPlatform.submit() 会破坏它「submit 非阻塞立刻返回 runId」的契约 #2——
// 审批门横在中间，submit 根本不可能立刻返回。

import type { LifecycleState } from "./lifecycle";
import type { ComputePlan } from "./plan";

export type TargetRef =
  | { kind: "local" }
  | { kind: "modal"; environment?: string }
  | { kind: "ssh"; hostId: string }; // v0.5 仅占位，available:false

export const TARGET_KINDS = ["local", "modal", "ssh"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface AdapterCapabilities {
  billable: boolean;
  persistentVolume: boolean;
  recovery: boolean;
  secretRefs: boolean;
  network: readonly ("none" | "unrestricted")[];
  /** 可选 GPU 型号；local 为 []。 */
  gpus: readonly string[];
  uploadLimits: { count: number; bytes: number };
}

export interface RunHooks {
  onLog?: (line: string) => void;
  onState?: (patch: Partial<LifecycleState>) => void;
  /**
   * V48：adapter 一旦拿到执行期 handle（比如本地子进程 spawn 成功、pid 到手）就立刻回调，
   * **不等** `run()`/`recover()` 整体返回。broker 借这个回调把 handle 落盘——编排进程在
   * 执行期中途被杀，句柄仍然留在磁盘上，重启后 `recover()` 才有东西可接。
   * 在此之前 `adapterHandle` 只在 `run()` 返回时才写进 job.json（broker.ts 的 `settle()`），
   * 编排进程死在执行期中途会把句柄跟着一起丢——release 还会因此删掉唯一的产物副本。
   */
  onHandle?: (handle: AdapterHandle) => void;
  signal?: AbortSignal;
}

/** adapter 持有的远端句柄；整体落 job.json.adapterHandle，重启后原样交回 recover()。 */
export interface AdapterHandle {
  kind: TargetKind;
  /** local: { pid, startedAt }；modal: { sandboxId, volumeName, appName, tags } */
  data: Record<string, string | number | null>;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  handle: AdapterHandle;
}

export interface Harvest {
  /** 已落到 <job>/harvest/ 的文件。 */
  files: Array<{ path: string; bytes: number; sha256: string }>;
  logPath: string;
  exitCode: number | null;
  wallSeconds: number | null;
  /** 远端报的退出码与卷上标记不一致时非空（reconcile），调用方标 delivery=failed。 */
  reconcileError: string | null;
}

export interface DispatchSpec {
  jobId: string;
  plan: ComputePlan;
  /** <project>/experiments/compute/jobs/<jobId> */
  jobDir: string;
  /** 只在 dispatch 时刻由 broker 解析；adapter 用完即弃，不得写入任何文件。 */
  resolveSecret: (ref: string) => Record<string, string>;
}

/** recover/collect/cancel/release 拿不到凭据解析器：这些路径不该有机会把密钥写出去。 */
export type ResolvedSpec = Omit<DispatchSpec, "resolveSecret">;

export interface ComputeAdapter {
  readonly kind: TargetKind;
  readonly description: string;
  capabilities(): AdapterCapabilities;
  /** 凭据连通性探测（capabilities --probe 档）；不产生任何远端资源。 */
  check(): Promise<{ ok: boolean; reason: string | null; detail: Record<string, string | number | boolean | null> }>;
  /** 派发并等到执行终态；日志经 hooks 流回。返回后 delivery 仍是 pending——收割是另一步。 */
  run(spec: DispatchSpec, hooks: RunHooks): Promise<RunResult>;
  /** 编排进程重启后：还在跑 → 重挂并等终态；已完成 → 直接返回；已丢失 → 抛 RecoverFailure。 */
  recover(spec: ResolvedSpec, handle: AdapterHandle, hooks: RunHooks): Promise<RunResult>;
  /** 从持久卷/工作目录收割 outputs；**不依赖沙箱还活着**。 */
  collect(spec: ResolvedSpec, handle: AdapterHandle): Promise<Harvest>;
  cancel(spec: ResolvedSpec, handle: AdapterHandle): Promise<void>;
  /** 删远端卷/工作目录；调用前 broker 已按 L-4 保证 recoverable=false。 */
  release(spec: ResolvedSpec, handle: AdapterHandle): Promise<void>;
}

export type RecoverFailureKind =
  | "retryable"
  | "unauthorized"
  | "quota"
  | "ownership_mismatch"
  | "invalid_request"
  | "not_found";

export class RecoverFailure extends Error {
  constructor(
    readonly kind: RecoverFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "RecoverFailure";
  }
}

/** 只有 retryable 值得再试一次；其余都是「再试一百次也一样」的终态失败。 */
export function isTerminalRecoverFailure(kind: RecoverFailureKind): boolean {
  return kind !== "retryable";
}

// ── ssh：v0.5 只留槽位（设计 §1.1.6） ───────────────────────────────────────
//
// 明确**不建** adapters/ssh.ts。这里只有 schema 与校验：把「哪些字段是必须钉死的」
// 先写下来，比先写一个能跑但 host key 不验的实现安全得多。

export interface SshHost {
  id: string;
  host: string;
  port: number;
  user: string;
  hostKeyFingerprint: `SHA256:${string}`;
  hostKey: string;
  identityPath: string;
  proxyJump: string[];
  concurrency: number;
  scheduler: "none" | "slurm" | "pbs";
}

export class SshHostValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshHostValidationError";
  }
}

const SCHEDULERS = ["none", "slurm", "pbs"] as const;
// identity 路径禁 `%` 与 `$`：ssh 的 %-token 与 shell 变量都会在别处被再展开一次。
const IDENTITY_FORBIDDEN = /[%$]/;
// user 禁 `@`：`user@host` 形式会让 -l 参数与 destination 互相打架。
const USER_FORBIDDEN = /[@\s]/;

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new SshHostValidationError(`ssh host 字段 '${key}' 必须是非空字符串`);
  }
  return value;
}

/** 只校验，不实现（`targets()` 会把 ssh 标成 available:false）。 */
export function validateSshHost(input: unknown): SshHost {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SshHostValidationError("ssh host 必须是对象");
  }
  const raw = input as Record<string, unknown>;
  const id = str(raw, "id");
  const host = str(raw, "host");
  const user = str(raw, "user");
  if (USER_FORBIDDEN.test(user)) {
    throw new SshHostValidationError(`ssh host '${id}' 的 user 不能含 '@' 或空白`);
  }
  const port = raw.port === undefined ? 22 : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshHostValidationError(`ssh host '${id}' 的 port 必须是 1..65535 的整数`);
  }
  const fingerprint = str(raw, "hostKeyFingerprint");
  if (!fingerprint.startsWith("SHA256:")) {
    // 指纹必须钉死：不钉死就等于 StrictHostKeyChecking=no，中间人零成本。
    throw new SshHostValidationError(
      `ssh host '${id}' 的 hostKeyFingerprint 必须是 'SHA256:...' 形式（不许省略主机指纹）`,
    );
  }
  const hostKey = str(raw, "hostKey");
  const identityPath = str(raw, "identityPath");
  if (IDENTITY_FORBIDDEN.test(identityPath)) {
    throw new SshHostValidationError(`ssh host '${id}' 的 identityPath 不能含 '%' 或 '$'`);
  }
  const proxyJumpRaw = raw.proxyJump ?? [];
  if (!Array.isArray(proxyJumpRaw) || proxyJumpRaw.some((h) => typeof h !== "string" || h.trim() === "")) {
    throw new SshHostValidationError(`ssh host '${id}' 的 proxyJump 必须是非空字符串数组`);
  }
  const concurrency = raw.concurrency === undefined ? 1 : Number(raw.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new SshHostValidationError(`ssh host '${id}' 的 concurrency 必须是 1..100 的整数`);
  }
  const scheduler = (raw.scheduler ?? "none") as SshHost["scheduler"];
  if (!SCHEDULERS.includes(scheduler)) {
    throw new SshHostValidationError(`ssh host '${id}' 的 scheduler 只能是 ${SCHEDULERS.join(" / ")}`);
  }
  return {
    id,
    host,
    port,
    user,
    hostKeyFingerprint: fingerprint as `SHA256:${string}`,
    hostKey,
    identityPath,
    proxyJump: proxyJumpRaw as string[],
    concurrency,
    scheduler,
  };
}
