// C1 · 算力执行状态的**磁盘真源**（CB-1，设计 §1.1.5 / K-3）。
//
// 为什么不是 record（K-3）：v0.4 W3 收口真实踩过——记账类 record 一进证据图，
// `NoProgressGuard` 永远看到「有新增」，防烧钱的停机条件被静默废掉
// （agents/contract.ts:137-152）。算力 job 每次 poll 落一条 record 会重演同一件事。
// 所以进图的只有两处：人做决定（decision）与结果进图（observation + artifact）。
//
//   <root>/<jobId>/plan.json      审批对象本体（plan() 时写，之后只读）
//                  job.json       三轴状态 + rev + 三段 approval + adapterHandle
//                  uploads.json   preflight 时刻的 {path,size,sha256} 快照
//                  workspace/     adapter 的工作目录（local adapter 直接在这里跑）
//                  run.log        远端 tee 回本地
//                  exit-code      终态标记
//                  harvest/       收割下来的 outputs

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionState, LifecycleState } from "./lifecycle";
import { initialLifecycle } from "./lifecycle";
import type { ComputePlan, UploadEntry } from "./plan";
import type { AdapterHandle, TargetRef } from "./target";

export interface ComputeApprovalMeta {
  decisionRecordId: string;
  actor: string;
  /** "explicit" | "http:explicit" | …，照 AD-6 P7 口径。 */
  actorSource: string;
  at: string;
  planDigest: string;
  note: string | null;
}

export interface ComputeJobRecord {
  jobId: string;
  projectSlug: string;
  /** 桥路径（CB-6）才有。 */
  experimentId: string | null;
  target: TargetRef;
  lifecycle: LifecycleState;
  /** CAS；照 project/records.ts:344-370 的语义。 */
  rev: number;
  approval: ComputeApprovalMeta | null;
  consumedApproval: ComputeApprovalMeta | null;
  supersededApproval: ComputeApprovalMeta | null;
  rejection: (ComputeApprovalMeta & { reason: string }) | null;
  adapterHandle: AdapterHandle | null;
  createdAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  message: string | null;
  /** harvest 后填；查不到单价 = null（绝不 0）。 */
  actualCostUsd: number | null;
}

export type ComputeJobView = ComputeJobRecord & { plan: ComputePlan; jobDir: string };

export class ComputeJobConflictError extends Error {
  constructor(
    readonly jobId: string,
    readonly expectedRev: number,
    readonly actualRev: number | null,
  ) {
    super(
      `算力任务 ${jobId} 的并发写入冲突：期望 rev=${expectedRev}，实际 rev=${actualRev ?? "(已不存在)"}` +
        `——别的请求抢先了，这一次判负`,
    );
    this.name = "ComputeJobConflictError";
  }
}

export class UnknownComputeJobError extends Error {
  constructor(readonly jobId: string) {
    super(`没有这个算力任务：${jobId}`);
    this.name = "UnknownComputeJobError";
  }
}

function writeAtomic(path: string, content: string): void {
  // 临时文件 + rename：rename 在同一文件系统内是原子的，读者永远看不到半个 JSON。
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function newJobId(now: () => number = Date.now): string {
  // 与 RunStore 的 runId 同风格（platform.ts:211）。
  return `cj-${now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export class ComputeJobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  dirOf(jobId: string): string {
    return join(this.root, jobId);
  }

  create(
    plan: ComputePlan,
    init: Pick<ComputeJobRecord, "projectSlug" | "experimentId" | "target"> & { jobId?: string; now?: string },
  ): ComputeJobView {
    const jobId = init.jobId ?? newJobId();
    const dir = this.dirOf(jobId);
    if (existsSync(join(dir, "job.json"))) {
      throw new Error(`算力任务 ${jobId} 已存在——jobId 必须唯一`);
    }
    mkdirSync(join(dir, "workspace"), { recursive: true });
    mkdirSync(join(dir, "harvest"), { recursive: true });
    const record: ComputeJobRecord = {
      jobId,
      projectSlug: init.projectSlug,
      experimentId: init.experimentId,
      target: init.target,
      lifecycle: initialLifecycle(),
      rev: 1,
      approval: null,
      consumedApproval: null,
      supersededApproval: null,
      rejection: null,
      adapterHandle: null,
      createdAt: init.now ?? new Date().toISOString(),
      dispatchedAt: null,
      finishedAt: null,
      exitCode: null,
      message: null,
      actualCostUsd: null,
    };
    writeAtomic(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
    writeAtomic(join(dir, "job.json"), JSON.stringify(record, null, 2));
    return { ...record, plan, jobDir: dir };
  }

  read(jobId: string): ComputeJobView | null {
    const dir = this.dirOf(jobId);
    const jobPath = join(dir, "job.json");
    if (!existsSync(jobPath)) return null;
    const record = JSON.parse(readFileSync(jobPath, "utf8")) as ComputeJobRecord;
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as ComputePlan;
    return { ...record, plan, jobDir: dir };
  }

  get(jobId: string): ComputeJobView {
    const view = this.read(jobId);
    if (!view) throw new UnknownComputeJobError(jobId);
    return view;
  }

  /**
   * 原子写 + CAS。`expectedRev` 不给就是无条件覆盖（last-write-wins，rev 仍 +1）；
   * 给了就是「只有 rev 还没被人动过才写得进去」——派发权的声明必须走这一支
   * （照湿实验 D-9 的做法：检查完之后、真正动手之前，可能已经被别的请求抢先）。
   */
  patch(
    jobId: string,
    patch: Partial<Omit<ComputeJobRecord, "jobId" | "rev">>,
    opts: { expectedRev?: number } = {},
  ): ComputeJobView {
    const current = this.read(jobId);
    if (!current) throw new UnknownComputeJobError(jobId);
    if (opts.expectedRev !== undefined && current.rev !== opts.expectedRev) {
      throw new ComputeJobConflictError(jobId, opts.expectedRev, current.rev);
    }
    const { plan, jobDir, ...record } = current;
    const next: ComputeJobRecord = { ...record, ...patch, jobId, rev: record.rev + 1 };
    writeAtomic(join(jobDir, "job.json"), JSON.stringify(next, null, 2));
    return { ...next, plan, jobDir };
  }

  /** 重新 plan：plan.json 换一份，旧 approval 作废并留档（设计 §1.1.4）。 */
  replacePlan(jobId: string, plan: ComputePlan, opts: { expectedRev?: number } = {}): ComputeJobView {
    const current = this.read(jobId);
    if (!current) throw new UnknownComputeJobError(jobId);
    if (opts.expectedRev !== undefined && current.rev !== opts.expectedRev) {
      throw new ComputeJobConflictError(jobId, opts.expectedRev, current.rev);
    }
    writeAtomic(join(current.jobDir, "plan.json"), JSON.stringify(plan, null, 2));
    return this.patch(jobId, {
      supersededApproval: current.approval ?? current.supersededApproval,
      approval: null,
    });
  }

  writeUploadsSnapshot(jobId: string, entries: readonly UploadEntry[]): void {
    writeAtomic(
      join(this.dirOf(jobId), "uploads.json"),
      JSON.stringify({ takenAt: new Date().toISOString(), entries }, null, 2),
    );
  }

  readUploadsSnapshot(jobId: string): { takenAt: string; entries: UploadEntry[] } | null {
    const path = join(this.dirOf(jobId), "uploads.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as { takenAt: string; entries: UploadEntry[] };
  }

  list(filter: { experimentId?: string; execution?: ExecutionState[] } = {}): ComputeJobView[] {
    if (!existsSync(this.root)) return [];
    const out: ComputeJobView[] = [];
    for (const entry of readdirSync(this.root)) {
      const dir = join(this.root, entry);
      if (!statSync(dir).isDirectory()) continue;
      const view = this.read(entry);
      if (!view) continue;
      if (filter.experimentId !== undefined && view.experimentId !== filter.experimentId) continue;
      if (filter.execution && !filter.execution.includes(view.lifecycle.execution)) continue;
      out.push(view);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
  }
}
