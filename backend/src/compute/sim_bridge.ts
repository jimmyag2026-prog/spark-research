// CB-6 · 仿真层与算力层之间的**桥**（设计 §1.1.9 / §2.6，W5-3 α）。
//
// ── 为什么是桥，不是继承，也不是新状态 ─────────────────────────────────────
//
// K-1：`SimulationPlatform`（学科域契约：归一化参数 / 预期产出 / deterministic 位）与
// `ComputeAdapter`（执行地契约：哪台机器 / 怎么审批 / 怎么收割）是**并列**的两层。
// 把 target 塞进 `SimulationPlatform.submit()` 会当场破坏它的契约 #2「submit 非阻塞
// 立刻返回 runId」——审批门横在中间，submit 根本不可能立刻返回。
//
// 而给干实验状态机加一个 `awaiting_compute_approval` 会触发纪律 13 的全套消费方清扫
// （前端状态名字符串比较、MCP 描述、llms.txt、SKILL.md）——v0.3.0 就是这么回归的。
// 所以本文件只做两次**翻译**，两侧的契约与状态机一个字都不改：
//
//   planFromPrepared()   PreparedRun ──翻译──► ComputePlan 的入参（一份可被人审批的纸）
//   materializeHarvest() <job>/harvest/ ──翻译──► RunStore 认得的 <runs>/<runId>/
//
// 翻译完之后，`platform.collect(runId)` 与 `ExperimentLoop.ingestOutputs()` **原样工作**：
// `simulation/**` 本 lane **只读**（§1.1.9 / §三·补.8.3 的足迹表），零改动。

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { PreparedRun } from "../simulation/models";
import type { DoneEnvelope, RunRecord, RunStore } from "../simulation/run_store";
import type { ComputeJobView } from "./job_store";
import type { PlanInput } from "./plan";
import type { Harvest, TargetRef } from "./target";
import { collectUploads } from "./uploads";

/** runner 之外还要一并收回来的东西：终态信封、进度、日志。 */
export const BRIDGE_EXTRA_OUTPUTS: readonly string[] = ["done.json", "progress.json", "stdout.log"];

export class SimBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimBridgeError";
  }
}

export interface BridgePlanOptions {
  /** 远端/本机用哪个解释器跑 runner（默认 `resolvePython()` 的结果由调用方给）。 */
  python: string;
  /** 组装上传工作区的根目录（一般是 `<experimentsDir>/compute/bridge`）。 */
  stageRoot: string;
  gpu?: string | null;
  timeoutMinutes?: number;
  cpus?: number;
  memoryGb?: number;
  /** 写进 plan.purpose 的人话说明。 */
  purpose?: string;
}

function walkFiles(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  const stat = lstatSync(abs);
  if (stat.isDirectory()) {
    for (const child of readdirSync(abs).sort()) walkFiles(root, rel === "" ? child : `${rel}/${child}`, out);
    return;
  }
  if (stat.isFile()) out.push(rel);
}

function copyTree(srcRoot: string, destRoot: string, rel: string): void {
  const src = join(srcRoot, rel);
  const stat = lstatSync(src);
  if (stat.isDirectory()) {
    // `__pycache__` 是本机字节码，跨执行地毫无意义（而且 uploads 的 deny-list 也会拒它）。
    if (rel.split("/").includes("__pycache__")) return;
    mkdirSync(join(destRoot, rel), { recursive: true });
    for (const child of readdirSync(src).sort()) copyTree(srcRoot, destRoot, rel === "" ? child : `${rel}/${child}`);
    return;
  }
  if (!stat.isFile()) return; // symlink 一律不跟（与 uploads 同一条纪律）
  mkdirSync(dirname(join(destRoot, rel)), { recursive: true });
  copyFileSync(src, join(destRoot, rel));
}

/**
 * 组装桥的上传工作区。
 *
 * 为什么必须**先落一个真实目录**再 `collectUploads()`：`ComputePlan.uploads` 是
 * 「相对同一个 workspaceRoot 的一组路径 + size + sha256」，而 runner 的包树
 * （`materializeAssetTree()` 解出来的临时目录）与归一化参数（`prepared.stageDir/params.json`）
 * 本来在**两个不同的根**下面。不合并成一个根，`preflight()` 就没有可重验的对象——
 * 而 preflight 正是「人批的那份清单和真正上传的东西是不是同一份」的唯一判据。
 *
 * 幂等：同一个 specHash 反复组装得到同一份内容（stageDir 与 specHash 一一对应）。
 */
export function stageBridgeWorkspace(prepared: PreparedRun, stageRoot: string): { root: string; entryRel: string } {
  const entry = resolve(prepared.entryPoint);
  if (!existsSync(entry)) {
    throw new SimBridgeError(`runner 脚本不存在：${entry}——平台 '${prepared.platform}' 的资产没解包成功？`);
  }
  // runner 自己 `sys.path.insert(0, parents[2])`（见 simulation/pyref/runner.py），
  // 所以包树的根就是 entryPoint 往上三级。桥照抄这个约定，而不是另立一套。
  const pkgRoot = resolve(entry, "../../..");
  const entryRel = relative(pkgRoot, entry).split("\\").join("/");
  if (entryRel.startsWith("..")) {
    throw new SimBridgeError(
      `runner '${entry}' 不在它自己的包树里（推出的包根 ${pkgRoot}）——桥无法确定要上传哪些文件`,
    );
  }
  const root = join(stageRoot, prepared.specHash);
  mkdirSync(root, { recursive: true });
  copyTree(pkgRoot, root, "");

  const params = join(prepared.stageDir, "params.json");
  if (!existsSync(params)) {
    throw new SimBridgeError(`prepared.stageDir 里没有 params.json（${prepared.stageDir}）`);
  }
  copyFileSync(params, join(root, "params.json"));
  return { root, entryRel };
}

/**
 * `PreparedRun` → `PlanInput`。
 *
 * 三处刻意的选择：
 *   · `command` 是 argv（`[python, runner.py, --params, params.json, --outdir, .]`），
 *     不是 shell 字符串——被审批的东西不该再经过一次 shell 展开（设计 §1.1.3 ①）。
 *   · `network: "none"`：仿真算例不需要联网；需要就得显式改，于是 approvalRequired
 *     按 L-3 派生为 true。「本地」不等于「不需要人点头」。
 *   · `outputs` = 平台声明的 expectedOutputs + done.json/progress.json/stdout.log：
 *     少收 done.json，`RunStore` 那边就永远判不出终态。
 */
export function planFromPrepared(prepared: PreparedRun, target: TargetRef, opts: BridgePlanOptions): PlanInput {
  const { root, entryRel } = stageBridgeWorkspace(prepared, opts.stageRoot);
  const files: string[] = [];
  walkFiles(root, "", files);
  // 逐个文件显式点名（而不是给一个目录让它递归展开）：显式路径不受 gitignore 影响，
  // 上传清单因此完全由这里决定，不取决于运行时恰好在哪个仓库里。
  const scan = collectUploads(root, files);

  const outputs = [...new Set([...prepared.expectedOutputs, ...BRIDGE_EXTRA_OUTPUTS])];
  return {
    target,
    purpose:
      opts.purpose ??
      `仿真 ${prepared.platform}/${prepared.kind}（specHash ${prepared.specHash}）${prepared.label ? ` · ${prepared.label}` : ""}`,
    command: [opts.python, entryRel, "--params", "params.json", "--outdir", "."],
    env: {},
    image: null,
    secretRefs: [],
    resources: {
      gpu: opts.gpu ?? null,
      cpus: opts.cpus ?? 1,
      memoryGb: opts.memoryGb ?? 1,
      timeoutMinutes: opts.timeoutMinutes ?? 30,
    },
    network: "none",
    uploads: scan.entries,
    outputs,
    workspaceRoot: root,
  };
}

function readDone(dir: string): DoneEnvelope | null {
  const file = join(dir, "done.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DoneEnvelope;
    // 与 RunStore.done() 同一条纪律：只认明确写出的两种终态，半写的文件不算终态。
    if (parsed.status !== "completed" && parsed.status !== "failed") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 桥回填出来的 runId 长这样——一眼看得出它来自哪个算力任务。 */
export function bridgeRunId(prepared: PreparedRun, jobId: string): string {
  return `${prepared.platform}-compute-${jobId}`;
}

/**
 * `<job>/harvest/` → `<runs>/<runId>/`：把收割结果回填成 `RunStore` 认得的形状，
 * 让 `platform.collect(runId)` 与 `ExperimentLoop.ingestOutputs()` **原样工作**。
 *
 * 不做的事：**不编造终态**。harvest 里没有 done.json 就写 `state:"failed"` 并把原因
 * 写进 message（远端跑没跑完无法确认），而不是「大概是成功了吧」。
 */
export function materializeHarvest(
  runStore: RunStore,
  prepared: PreparedRun,
  job: ComputeJobView,
  harvest: Harvest,
): string {
  const runId = bridgeRunId(prepared, job.jobId);
  const dir = runStore.dirOf(runId);
  mkdirSync(dir, { recursive: true });

  const harvestRoot = join(job.jobDir, "harvest");
  for (const file of harvest.files) {
    const src = join(harvestRoot, file.path);
    if (!existsSync(src)) continue;
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
  // 归一化参数一并落进 run 目录：`<runs>/<runId>/` 应当是这次运行的完整现场
  // （RunStore 的布局约定，run_store.ts 顶部注释），少一份 params.json 就不完整。
  const params = join(prepared.stageDir, "params.json");
  if (existsSync(params) && !existsSync(join(dir, "params.json"))) copyFileSync(params, join(dir, "params.json"));
  // run.log 是算力侧的 stdout（local adapter 落在 jobDir 而不是 workspace，
  // 所以它不在 outputs glob 里）；回填成 stdout.log，排障时看得到任务说了什么。
  if (existsSync(harvest.logPath) && !existsSync(join(dir, "stdout.log"))) {
    copyFileSync(harvest.logPath, join(dir, "stdout.log"));
  }

  const done = readDone(dir);
  const now = new Date().toISOString();
  const record: RunRecord = {
    runId,
    platform: prepared.platform,
    kind: prepared.kind,
    specHash: prepared.specHash,
    label: prepared.label,
    state: done ? done.status : "failed",
    // 算力任务不是本进程的子进程：pid 一律 null，别让 poll 去查一个无关的 pid。
    pid: null,
    exitCode: harvest.exitCode,
    message: done
      ? (done.error ?? null)
      : `算力任务 ${job.jobId} 的收割结果里没有 done.json（exit=${harvest.exitCode ?? "?"}）——` +
        `远端是否真的跑完无法确认，按失败处理`,
    startedAt: done?.startedAt ?? job.dispatchedAt,
    finishedAt: done?.finishedAt ?? job.finishedAt ?? now,
    entryPoint: prepared.entryPoint,
    params: prepared.params,
    expectedOutputs: prepared.expectedOutputs,
    // 产物已经落到本地 run 目录了，这次运行不再依赖远端那一份。
    recoverable: false,
  };
  runStore.create(record);
  if (!existsSync(join(dir, "run.json"))) {
    // create() 已经写过；这一步只是把「写没写成」暴露出来，不吞掉。
    writeFileSync(join(dir, "run.json"), JSON.stringify(record, null, 2) + "\n");
  }
  return runId;
}
