// CB-6 · 干实验这一侧的算力驱动（W5-3 α）。
//
// `ExperimentLoop` 不认识 broker、审批、adapter，也不该认识——它只认识一条窄口：
// 「把这次 prepared 送去算力层，然后告诉我它现在到哪一步了，好了就回填成 runId」。
// 这个文件就是那条窄口的唯一实现，算力层的全部 import 都关在这里：
// 换掉执行地、改审批语义、加一个 adapter，`loop.ts` 一行都不用动。
//
// 与 `compute/sim_bridge.ts` 的分工：
//   sim_bridge  两侧数据结构的**翻译**（纯函数 + 文件搬运，不知道 broker 存在）
//   本文件      **编排**（什么时候 plan、什么时候 collect、状态怎么读给实验看）

import { join } from "node:path";
import {
  ComputeBroker,
  NULL_PRICING,
  computeJobsRoot,
  ensureComputeRoot,
} from "../compute/broker";
import { ComputeApproval } from "../compute/approval";
import { ComputeJobStore, UnknownComputeJobError, type ComputeJobView } from "../compute/job_store";
import { isExecutionTerminal, type DeliveryState, type ExecutionState } from "../compute/lifecycle";
import { materializeHarvest, planFromPrepared, type BridgePlanOptions } from "../compute/sim_bridge";
import type { ComputeAdapter, TargetKind, TargetRef } from "../compute/target";
import { defaultComputeAdapters } from "../compute/cli";
import type { CredentialProvider } from "../connectors/base";
import { CredentialStore } from "../daemon/credentials";
import type { Project } from "../project/manager";
import { resolvePython } from "../simulation/platform";
import type { PreparedRun } from "../simulation/models";
import type { RunStore } from "../simulation/run_store";
import type { ComputeTargetName } from "./models";

export class ComputeDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeDriverError";
  }
}

/** 实验侧看得懂的算力任务快照——不暴露三轴状态机的内部形状，只暴露「实验该怎么办」。 */
export interface ComputeJobSnapshot {
  jobId: string;
  target: TargetKind;
  execution: ExecutionState;
  delivery: DeliveryState;
  /** 停在人工审批那一步（`awaiting_approval`）。 */
  awaitingApproval: boolean;
  /**
   * 轮到**人**动手了：`planned`（还没派发）/ `awaiting_approval`（等批）/ `approved`（批了没派）。
   * 这三种都不该被读成「还在跑」——轮询一个等人的任务只会白白转到超时，
   * 而且会把「没人批/没人派」报成「跑得慢」（W5-3 α 实测：第一版把 planned 当
   * still_running，`exp run` 直接挂满 15 分钟的默认超时）。
   */
  awaitingHuman: boolean;
  /** 执行已到终态。 */
  terminal: boolean;
  /** 执行成功且产物还没交付——可以收割。 */
  readyToHarvest: boolean;
  /** 失败/超时/取消。 */
  failed: boolean;
  /**
   * 这次失败重跑一次就可能好（照 `RunStatus.recoverable` 的口径，P5 起就是这个含义）。
   * 真实 SIGKILL 走的正是这条：进程连同 exit-code 标记一起没了 → recoverable=true。
   */
  recoverable: boolean;
  exitCode: number | null;
  message: string | null;
  /** 给人看的下一步命令。 */
  nextAction: string;
}

/** 落进 observation / artifact record metadata 的算力事实（设计 §1.1.8「证据图」行）。 */
export interface ComputeEvidenceFacts {
  computeTarget: TargetKind;
  computeJobId: string;
  planDigest: string;
  decisionRecordId: string | null;
  actualCostUsd: number | null;
}

export interface SubmitContext {
  experimentId: string;
  target: ComputeTargetName;
  title?: string | null;
  gpu?: string | null;
  timeoutMinutes?: number;
}

export interface ExperimentComputeDriver {
  /** 建计划（零副作用：不建远端资源、不解析凭据）。需要审批的会停在 awaiting_approval。 */
  submit(prepared: PreparedRun, ctx: SubmitContext): Promise<ComputeJobSnapshot>;
  status(jobId: string): ComputeJobSnapshot;
  evidenceFor(jobId: string): ComputeEvidenceFacts | null;
  /** 收割 + 回填成 `RunStore` 认得的 run 目录；返回 runId。 */
  materialize(prepared: PreparedRun, jobId: string, runStore: RunStore): Promise<string>;
}

function targetRefOf(name: ComputeTargetName): TargetRef {
  return name === "modal" ? { kind: "modal" } : { kind: "local" };
}

function nextActionFor(job: ComputeJobView): string {
  const short = job.jobId;
  switch (job.lifecycle.execution) {
    case "planned":
      return `spark-research compute run ${short}`;
    case "awaiting_approval":
      return `spark-research compute approve ${short} --run`;
    case "approved":
      return `spark-research compute run ${short}`;
    case "queued":
    case "starting":
    case "running":
      return `spark-research compute status ${short}`;
    default:
      break;
  }
  if (job.lifecycle.delivery === "pending" || job.lifecycle.delivery === "failed") {
    return `spark-research compute collect ${short}`;
  }
  return `spark-research compute status ${short}`;
}

function snapshotOf(job: ComputeJobView): ComputeJobSnapshot {
  const execution = job.lifecycle.execution;
  const terminal = isExecutionTerminal(execution);
  const failed = execution === "failed" || execution === "timed_out" || execution === "cancelled";
  const awaitingHuman = execution === "planned" || execution === "awaiting_approval" || execution === "approved";
  return {
    jobId: job.jobId,
    target: job.target.kind,
    execution,
    delivery: job.lifecycle.delivery,
    awaitingApproval: execution === "awaiting_approval",
    awaitingHuman,
    terminal,
    readyToHarvest: execution === "succeeded" && job.lifecycle.delivery !== "complete",
    failed,
    recoverable: job.lifecycle.recoverable,
    exitCode: job.exitCode,
    message: job.message,
    nextAction: nextActionFor(job),
  };
}

export interface ComputeDriverOptions {
  root?: string;
  credentials?: CredentialProvider;
  adapters?: Partial<Record<TargetKind, ComputeAdapter>>;
  python?: string;
  /** 测试注入：整套 broker（跟 compute CLI 的 `brokerFor` 同一个用途）。 */
  broker?: ComputeBroker;
  jobs?: ComputeJobStore;
}

export class BrokerComputeDriver implements ExperimentComputeDriver {
  private readonly broker: ComputeBroker;
  private readonly jobs: ComputeJobStore;
  private readonly stageRoot: string;
  private readonly python: string;

  constructor(
    private readonly project: Project,
    options: ComputeDriverOptions = {},
  ) {
    const jobsRoot = ensureComputeRoot(project.paths.experimentsDir);
    this.jobs = options.jobs ?? new ComputeJobStore(jobsRoot);
    if (options.broker) {
      this.broker = options.broker;
    } else {
      const credentials = options.credentials ?? new CredentialStore({ root: options.root });
      this.broker = new ComputeBroker({
        jobs: this.jobs,
        adapters: options.adapters ?? defaultComputeAdapters({ credentials, root: options.root }),
        approval: new ComputeApproval({ records: project.records(), jobs: this.jobs }),
        credentials,
        // 单价查不到就是 null（PRICING 纪律）——绝不填 0。
        pricing: NULL_PRICING,
        // 桥路径**刻意不注入 evidence**：这条路上的证据由 ExperimentLoop 落
        //（artifact record 走 ingestOutputs、observation 走 analyze），
        // 两边都落会让同一批产出在图上出现两次（设计 §1.1.9）。
      });
    }
    // 桥的上传工作区与 job 目录同层，`<experiments>/compute/bridge/<specHash>/`。
    this.stageRoot = join(computeJobsRoot(project.paths.experimentsDir), "..", "bridge");
    this.python = options.python ?? resolvePython();
  }

  async submit(prepared: PreparedRun, ctx: SubmitContext): Promise<ComputeJobSnapshot> {
    const opts: BridgePlanOptions = {
      python: this.python,
      stageRoot: this.stageRoot,
      gpu: ctx.gpu ?? null,
      timeoutMinutes: ctx.timeoutMinutes,
      purpose:
        `干实验 ${ctx.experimentId.slice(0, 8)}${ctx.title ? ` · ${ctx.title}` : ""}` +
        `（${prepared.platform}/${prepared.kind}，specHash ${prepared.specHash}）`,
    };
    const input = planFromPrepared(prepared, targetRefOf(ctx.target), opts);
    const job = await this.broker.plan(input, {
      projectSlug: this.project.slug,
      // experimentId 一进 job.json，broker 的通用证据写入就会自觉让路（设计 §1.1.9）。
      experimentId: ctx.experimentId,
    });
    return snapshotOf(job);
  }

  status(jobId: string): ComputeJobSnapshot {
    return snapshotOf(this.read(jobId));
  }

  evidenceFor(jobId: string): ComputeEvidenceFacts | null {
    let job: ComputeJobView;
    try {
      job = this.read(jobId);
    } catch {
      return null;
    }
    return {
      computeTarget: job.target.kind,
      computeJobId: job.jobId,
      planDigest: job.plan.digest,
      decisionRecordId: job.consumedApproval?.decisionRecordId ?? job.approval?.decisionRecordId ?? null,
      actualCostUsd: job.actualCostUsd,
    };
  }

  async materialize(prepared: PreparedRun, jobId: string, runStore: RunStore): Promise<string> {
    const { job, harvest } = await this.broker.collect(jobId);
    if (harvest.reconcileError) {
      // 对账失败**不许**当成成功回填：宁可让实验停在可诊断的失败，也不给一份来路不明的产物。
      throw new ComputeDriverError(
        `算力任务 ${jobId} 收割对账失败：${harvest.reconcileError}（delivery=${job.lifecycle.delivery}）`,
      );
    }
    return materializeHarvest(runStore, prepared, job, harvest);
  }

  private read(jobId: string): ComputeJobView {
    try {
      return this.jobs.get(jobId);
    } catch (error) {
      if (error instanceof UnknownComputeJobError) {
        throw new ComputeDriverError(
          `实验登记的算力任务 ${jobId} 在磁盘上不存在（${this.jobs.root}）——job 目录被清理过？`,
        );
      }
      throw error;
    }
  }
}

/** 生产入口用的构造器：CLI 与（将来的）HTTP 都从这里拿驱动，不各自 new 一套 broker。 */
export function computeDriverFor(project: Project, options: ComputeDriverOptions = {}): ExperimentComputeDriver {
  return new BrokerComputeDriver(project, options);
}
