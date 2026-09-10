// C1 · 编排：plan → approve → dispatch → poll → collect → release（CB-1/CB-2，设计 §2.5）。
//
// broker 是唯一知道「审批、上传、状态机、adapter」怎么拼在一起的地方。
// 它**没有**一条「跳过审批直接派发」的路径——不是因为没人想要，而是因为那条路径
// 一旦存在，测试就会用它，然后它会活到生产（K-2）。要跑不需要审批的任务，
// 唯一的办法是让 plan 的 approvalRequired 派生为 false（L-3），那是 plan 内容说了算，
// 不是调用方说了算。

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CredentialProvider } from "../connectors/base";
import type { BudgetLedger } from "../llm/budget";
import { ComputeApproval, ApprovalRequiredError } from "./approval";
import {
  ComputeJobConflictError,
  ComputeJobStore,
  type ComputeJobView,
} from "./job_store";
import { isExecutionTerminal, transition, type LifecycleEvent, type LifecycleState } from "./lifecycle";
import { buildPlan, validatePlan, type ComputePlan, type PlanInput, type PricingLookup } from "./plan";
import { preflight } from "./uploads";
import {
  RecoverFailure,
  isTerminalRecoverFailure,
  type AdapterCapabilities,
  type ComputeAdapter,
  type Harvest,
  type RunHooks,
  type TargetKind,
  type TargetRef,
} from "./target";

export class ComputeDispatchConflictError extends Error {
  constructor(readonly jobId: string, detail: string) {
    super(`算力任务 ${jobId} 已经在派发中：${detail}`);
    this.name = "ComputeDispatchConflictError";
  }
}

export class ComputeAdmissionError extends Error {
  constructor(limit: number, running: number) {
    super(
      `同时在跑的算力任务已有 ${running} 个，达到上限 ${limit}——` +
        `**显式失败，不排队**（排队会让「我以为它在跑」变成一小时后的账单）`,
    );
    this.name = "ComputeAdmissionError";
  }
}

export class UnknownTargetError extends Error {
  constructor(kind: string, available: string[]) {
    super(`没有 target '${kind}' 的 adapter（已注册：${available.length ? available.join(" / ") : "无"}）`);
    this.name = "UnknownTargetError";
  }
}

export interface ComputeBrokerDeps {
  jobs: ComputeJobStore;
  adapters: Partial<Record<TargetKind, ComputeAdapter>>;
  approval: ComputeApproval;
  credentials: CredentialProvider;
  pricing: PricingLookup;
  /** 注入 = 花费进账本；不注入 = 只落 job.json。 */
  budget?: Pick<BudgetLedger, "record">;
  /** 默认 2；超出即显式失败，不排队。 */
  admissionLimit?: number;
  now?: () => string;
}

export interface PlanContext {
  projectSlug: string;
  experimentId?: string;
}

/** 查不到单价一律 null（PRICING 纪律）。local 不计费，但仍然要如实说「查不到」而不是「0」。 */
export const NULL_PRICING: PricingLookup = () => ({
  unitPriceUsd: null,
  source: null,
  verifiedDate: null,
});

export class ComputeBroker {
  private readonly jobs: ComputeJobStore;
  private readonly adapters: Partial<Record<TargetKind, ComputeAdapter>>;
  private readonly approval: ComputeApproval;
  private readonly credentials: CredentialProvider;
  private readonly pricing: PricingLookup;
  private readonly budget: Pick<BudgetLedger, "record"> | undefined;
  private readonly admissionLimit: number;
  private readonly now: () => string;

  constructor(deps: ComputeBrokerDeps) {
    this.jobs = deps.jobs;
    this.adapters = deps.adapters;
    this.approval = deps.approval;
    this.credentials = deps.credentials;
    this.pricing = deps.pricing;
    this.budget = deps.budget;
    this.admissionLimit = deps.admissionLimit ?? 2;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  targets(): Array<{
    kind: TargetKind;
    available: boolean;
    reason: string | null;
    capabilities: AdapterCapabilities | null;
  }> {
    const out: Array<{
      kind: TargetKind;
      available: boolean;
      reason: string | null;
      capabilities: AdapterCapabilities | null;
    }> = [];
    for (const kind of ["local", "modal", "ssh"] as const) {
      const adapter = this.adapters[kind];
      if (adapter) {
        out.push({ kind, available: true, reason: null, capabilities: adapter.capabilities() });
      } else if (kind === "ssh") {
        out.push({ kind, available: false, reason: "v0.5 只留槽位（schema 已定，adapter 未实现）", capabilities: null });
      } else {
        out.push({ kind, available: false, reason: "未注册 adapter（缺凭据或本波未实现）", capabilities: null });
      }
    }
    return out;
  }

  private adapterFor(target: TargetRef): ComputeAdapter {
    const adapter = this.adapters[target.kind];
    if (!adapter) throw new UnknownTargetError(target.kind, Object.keys(this.adapters));
    return adapter;
  }

  /** 归一化 + digest + 校验；**零副作用**（不建远端资源、不解析凭据）。 */
  async plan(input: PlanInput, ctx: PlanContext): Promise<ComputeJobView> {
    const adapter = this.adapterFor(input.target);
    const plan = buildPlan(input, adapter.capabilities(), this.pricing);
    const created = this.jobs.create(plan, {
      projectSlug: ctx.projectSlug,
      experimentId: ctx.experimentId ?? null,
      target: input.target,
      now: this.now(),
    });
    if (!plan.approvalRequired) {
      return created;
    }
    // 需要审批的 plan 立刻停在 awaiting_approval——这是「等人点头」的物理位置。
    return this.jobs.patch(
      created.jobId,
      {
        lifecycle: this.step(created.lifecycle, "review", plan),
        message: plan.warning,
      },
      { expectedRev: created.rev },
    );
  }

  /** 重新 plan：digest 变了，旧 approval 当场作废（留 supersededApproval）。 */
  async replan(jobId: string, input: PlanInput): Promise<ComputeJobView> {
    const job = this.jobs.get(jobId);
    if (isExecutionTerminal(job.lifecycle.execution) || job.lifecycle.execution === "queued" ||
        job.lifecycle.execution === "starting" || job.lifecycle.execution === "running") {
      throw new ComputeDispatchConflictError(jobId, `execution=${job.lifecycle.execution} 已经不能重新 plan`);
    }
    const adapter = this.adapterFor(input.target);
    const plan = buildPlan(input, adapter.capabilities(), this.pricing);
    const replaced = this.jobs.replacePlan(jobId, plan, { expectedRev: job.rev });
    const lifecycle: LifecycleState = { ...replaced.lifecycle, execution: "planned" };
    if (!plan.approvalRequired) {
      return this.jobs.patch(jobId, { lifecycle, message: plan.warning });
    }
    return this.jobs.patch(jobId, { lifecycle: this.step(lifecycle, "review", plan), message: plan.warning });
  }

  poll(jobId: string): ComputeJobView {
    return this.jobs.get(jobId);
  }

  list(filter?: Parameters<ComputeJobStore["list"]>[0]): ComputeJobView[] {
    return this.jobs.list(filter);
  }

  /**
   * approved → queued → …。**五步**，一步都不许省（设计 §1.1.4 与 wet_loop.execute 逐条对照）：
   *   ① 状态：只有 approved（或 approvalRequired=false 的 planned）能进
   *   ② approval 存在且未被消费
   *   ③ plan digest 重验（磁盘上的 plan 与被批的那份是否还是同一份）
   *   ④ uploads preflight（逐文件 path/size/sha256 重验）
   *   ⑤ CAS 声明派发权，同一次写入里消费 approval
   */
  async dispatch(jobId: string, hooks: RunHooks = {}): Promise<ComputeJobView> {
    const job = this.jobs.get(jobId);
    const inflight: LifecycleState["execution"][] = ["queued", "starting", "running"];
    if (inflight.includes(job.lifecycle.execution)) {
      // 与湿实验 executing 同一条：分不清「正在被别的请求执行」和「编排进程崩了卡在这」，
      // 两者都不该被这次调用当作「可以推进」。
      throw new ComputeDispatchConflictError(jobId, `execution=${job.lifecycle.execution}`);
    }
    const adapter = this.adapterFor(job.target);
    const caps = adapter.capabilities();

    // ③ 从磁盘读回来的 plan 一律不信任：重跑一遍完整校验（含 digest 自洽）。
    validatePlan(job.plan, caps);

    // admission：**显式失败，不排队**。
    const running = this.jobs.list({ execution: inflight }).filter((j) => j.jobId !== jobId);
    if (running.length >= this.admissionLimit) {
      throw new ComputeAdmissionError(this.admissionLimit, running.length);
    }

    // ④ 上传面重验：审批面上人看到的是这份清单的内容，内容变了就等于批的不是这件事。
    preflight(job.plan.workspaceRoot, job.plan.uploads);
    this.jobs.writeUploadsSnapshot(jobId, job.plan.uploads);

    // ①②⑤：需要审批的走 approval.consume()（CAS + 一次性消费）；
    // 不需要审批的（approvalRequired=false）走 lifecycle 的第二条入边，同样是 CAS。
    let claimed: ComputeJobView;
    try {
      if (job.plan.approvalRequired) {
        claimed = this.approval.consume(jobId, job.plan.digest, job.rev);
      } else {
        if (job.lifecycle.execution !== "planned") {
          throw new ApprovalRequiredError(
            `算力任务 ${jobId} 当前 execution=${job.lifecycle.execution}，不能派发`,
          );
        }
        claimed = this.jobs.patch(
          jobId,
          {
            lifecycle: this.step(job.lifecycle, "dispatch", job.plan),
            dispatchedAt: this.now(),
            message: "派发（这份 plan 不计费、不联网、不用密钥，按 L-3 无需人工审批）",
          },
          { expectedRev: job.rev },
        );
      }
    } catch (error) {
      if (error instanceof ComputeJobConflictError) {
        throw new ComputeDispatchConflictError(jobId, error.message);
      }
      throw error;
    }

    this.stageUploads(claimed);
    return this.runOn(adapter, claimed, hooks, "dispatch");
  }

  /** 重启后接回：按 adapterHandle 走 adapter.recover()；终态类 RecoverFailure 直接标 failed。 */
  async recover(jobId: string, hooks: RunHooks = {}): Promise<ComputeJobView> {
    const job = this.jobs.get(jobId);
    if (isExecutionTerminal(job.lifecycle.execution)) return job;
    if (!job.adapterHandle) {
      return this.jobs.patch(jobId, {
        lifecycle: { ...job.lifecycle, execution: "failed" },
        finishedAt: this.now(),
        message: "没有 adapterHandle，无从接回——这个任务从未真正派发出去",
      });
    }
    const adapter = this.adapterFor(job.target);
    const interrupted = this.jobs.patch(jobId, {
      lifecycle: this.step(job.lifecycle, "interrupt", job.plan),
      message: "编排进程重启，正在接回",
    });
    const spec = this.specOf(interrupted);
    try {
      const result = await adapter.recover(spec, job.adapterHandle, hooks);
      return this.settle(interrupted, result.exitCode, result.timedOut, result.handle, "recover");
    } catch (error) {
      if (error instanceof RecoverFailure) {
        const terminal = isTerminalRecoverFailure(error.kind);
        return this.jobs.patch(jobId, {
          lifecycle: this.step(interrupted.lifecycle, "fail", job.plan),
          finishedAt: this.now(),
          message: `接回失败（${error.kind}${terminal ? "，终态" : "，可重试"}）：${error.message}`,
        });
      }
      throw error;
    }
  }

  async collect(jobId: string): Promise<{ job: ComputeJobView; harvest: Harvest }> {
    const job = this.jobs.get(jobId);
    if (!isExecutionTerminal(job.lifecycle.execution)) {
      throw new Error(`算力任务 ${jobId} 的 execution=${job.lifecycle.execution} 还没到终态，不能收割（L-5）`);
    }
    if (!job.adapterHandle) throw new Error(`算力任务 ${jobId} 没有 adapterHandle，无从收割`);
    const adapter = this.adapterFor(job.target);
    const pending =
      job.lifecycle.delivery === "none"
        ? this.jobs.patch(jobId, { lifecycle: this.step(job.lifecycle, "deliver", job.plan) })
        : job.lifecycle.delivery === "failed"
          ? this.jobs.patch(jobId, { lifecycle: this.step(job.lifecycle, "retry_delivery", job.plan) })
          : job;
    const harvest = await adapter.collect(this.specOf(pending), job.adapterHandle);

    if (pending.lifecycle.delivery !== "pending") {
      // 已经 complete/rejected 的再 collect 一次没有语义，直接把 harvest 交回去。
      return { job: pending, harvest };
    }
    if (harvest.reconcileError) {
      const failed = this.jobs.patch(jobId, {
        lifecycle: this.step(pending.lifecycle, "deliver_fail", job.plan),
        message: `收割对账失败：${harvest.reconcileError}`,
      });
      return { job: failed, harvest };
    }
    const costUsd = this.chargeFor(job, harvest);
    const done = this.jobs.patch(jobId, {
      lifecycle: this.step(pending.lifecycle, "deliver_ok", job.plan),
      actualCostUsd: costUsd,
      message: `已收割 ${harvest.files.length} 个产物`,
    });
    return { job: done, harvest };
  }

  /** 人明确不要这批产物：delivery=rejected，recoverable 随之放下（L-6），之后才允许 release。 */
  discard(jobId: string, reason: string): ComputeJobView {
    const job = this.jobs.get(jobId);
    const pending =
      job.lifecycle.delivery === "none"
        ? this.jobs.patch(jobId, { lifecycle: this.step(job.lifecycle, "deliver", job.plan) })
        : job;
    return this.jobs.patch(jobId, {
      lifecycle: this.step(pending.lifecycle, "deliver_reject", job.plan),
      message: `放弃产物：${reason}`,
    });
  }

  async cancel(jobId: string): Promise<ComputeJobView> {
    const job = this.jobs.get(jobId);
    if (isExecutionTerminal(job.lifecycle.execution)) return job;
    if (job.adapterHandle) {
      await this.adapterFor(job.target).cancel(this.specOf(job), job.adapterHandle);
    }
    return this.jobs.patch(jobId, {
      lifecycle: this.step(job.lifecycle, "cancel", job.plan),
      finishedAt: this.now(),
      message: "人工取消",
    });
  }

  /**
   * 释放远端资源。L-4 守在 lifecycle.transition 里：只要 recoverable 还是 true
   * （产物只有远端那一份），close 就会抛错——这不是可以绕过去的礼貌提醒。
   */
  async release(jobId: string): Promise<ComputeJobView> {
    const job = this.jobs.get(jobId);
    // 先算 lifecycle（会在 recoverable=true 时抛 L-4），**再**去动真实资源：
    // 顺序反了就会变成「资源已经删了，然后才发现不该删」。
    const lifecycle = this.step(job.lifecycle, "close", job.plan);
    if (job.adapterHandle) {
      await this.adapterFor(job.target).release(this.specOf(job), job.adapterHandle);
    }
    return this.jobs.patch(jobId, { lifecycle, message: "远端资源已释放" });
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private step(state: LifecycleState, event: LifecycleEvent, plan: ComputePlan): LifecycleState {
    return transition(state, event, {
      approvalRequired: plan.approvalRequired,
      planDigest: plan.digest,
      approval: null,
    });
  }

  private specOf(job: ComputeJobView) {
    return { jobId: job.jobId, plan: job.plan, jobDir: job.jobDir };
  }

  /** 上传面的物理落点：只有 plan.uploads 里的文件会进 job 的 workspace。 */
  private stageUploads(job: ComputeJobView): void {
    const workspace = join(job.jobDir, "workspace");
    mkdirSync(workspace, { recursive: true });
    for (const entry of job.plan.uploads) {
      const src = join(job.plan.workspaceRoot, entry.path);
      const dest = join(workspace, entry.path);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }

  private async runOn(
    adapter: ComputeAdapter,
    job: ComputeJobView,
    hooks: RunHooks,
    origin: "dispatch" | "recover",
  ): Promise<ComputeJobView> {
    const started = this.jobs.patch(job.jobId, {
      lifecycle: this.step(
        this.step(this.step(job.lifecycle, "resource_start", job.plan), "resource_active", job.plan),
        "start",
        job.plan,
      ),
    });
    const spec = {
      ...this.specOf(started),
      resolveSecret: (ref: string) => {
        const value = this.credentials.get(ref);
        if (!value) {
          throw new Error(`plan 引用了密钥 '${ref}'，但凭据库里没有——请先配置（值永远不进 plan/job）`);
        }
        return value;
      },
    };
    const running = this.jobs.patch(started.jobId, { lifecycle: this.step(started.lifecycle, "run", job.plan) });
    try {
      const result = await adapter.run(spec, hooks);
      return this.settle(running, result.exitCode, result.timedOut, result.handle, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.jobs.get(running.jobId);
      if (isExecutionTerminal(current.lifecycle.execution)) return current;
      return this.jobs.patch(running.jobId, {
        lifecycle: this.step(current.lifecycle, "fail", job.plan),
        finishedAt: this.now(),
        message: `派发失败：${message}`,
      });
    }
  }

  private settle(
    job: ComputeJobView,
    exitCode: number | null,
    timedOut: boolean,
    handle: ComputeJobView["adapterHandle"],
    origin: "dispatch" | "recover",
  ): ComputeJobView {
    // 重新读盘：等待期间可能有人 cancel 了（那已经是终态），这一次就不许再改写它——
    // 「我等到的结果」不该覆盖「人已经做出的决定」。
    const current = this.jobs.get(job.jobId);
    if (isExecutionTerminal(current.lifecycle.execution)) {
      return current.adapterHandle ? current : this.jobs.patch(job.jobId, { adapterHandle: handle });
    }
    const outcome: "succeeded" | "failed" = exitCode === 0 && !timedOut ? "succeeded" : "failed";
    const lifecycle =
      origin === "recover"
        ? transition(current.lifecycle, "recover", {
            approvalRequired: job.plan.approvalRequired,
            planDigest: job.plan.digest,
            recoverOutcome: timedOut ? "failed" : outcome,
          })
        : this.step(current.lifecycle, timedOut ? "timeout" : outcome === "succeeded" ? "succeed" : "fail", job.plan);
    return this.jobs.patch(job.jobId, {
      lifecycle,
      adapterHandle: handle,
      exitCode,
      finishedAt: this.now(),
      message: timedOut
        ? `超时（>${job.plan.resources.timeoutMinutes} 分钟）被终止`
        : outcome === "succeeded"
          ? "执行完成"
          : `执行失败（exit=${exitCode ?? "?"}）`,
    });
  }

  /**
   * 真实花费只在收割之后记账（agent 经 MCP 只能 plan/查状态，从不派发；ToolBus 对
   * compute_* 一律返回 null）。查不到单价就是 null——**绝不当 0**。
   */
  private chargeFor(job: ComputeJobView, harvest: Harvest): number | null {
    const price = job.plan.estimate.unitPriceUsd;
    const seconds = harvest.wallSeconds;
    const costUsd = price === null || seconds === null ? null : Number((price * seconds).toFixed(6));
    this.budget?.record(
      { inputTokens: 0, outputTokens: 0, costUsd, usageUnavailable: costUsd === null },
      {},
    );
    return costUsd;
  }
}

/** job 目录的标准位置：<project>/experiments/compute/jobs（设计 §1.1.5）。 */
export function computeJobsRoot(experimentsDir: string): string {
  return join(experimentsDir, "compute", "jobs");
}

export function ensureComputeRoot(experimentsDir: string): string {
  const root = computeJobsRoot(experimentsDir);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}
