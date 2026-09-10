// C1 · 审批语义（CB-1，K-2 / 异议 X-1）。
//
// 这一层**前移进 CB-1 而不是留给 CB-5 接线**，理由（设计 §0.1 K-2）：
// `planned → awaiting_approval → approved → queued` 是 lifecycle 的主干；
// 若先造一个「无审批也能派发」的 broker，必然需要一个测试后门，后门会活到生产。
//
// 与 `WetLabLoop`（已在生产里验证过的同一机制）逐条对照，见设计 §1.1.4：
//   approve()  只在 awaiting_approval；缺 digest 拒；actor 必填；落 decision record
//   consume()  执行前重验 digest + 在**同一次 CAS** 里 approval → consumedApproval
//   reject()   落 decision record，approval 置 null
//
// **只做语义，不做入口**：TTY 门 / HTTP actor / MCP 扣留都是 W5-2 β 的接线面。

import type { RecordStore } from "../project/records";
import type { ComputeApprovalMeta, ComputeJobStore, ComputeJobView } from "./job_store";
import { transition } from "./lifecycle";

export interface ApproveInput {
  actor: string;
  actorSource?: string;
  note?: string;
}

export interface RejectInput {
  actor: string;
  actorSource?: string;
  reason: string;
}

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

export interface ComputeApprovalDeps {
  records: Pick<RecordStore, "create" | "link">;
  jobs: ComputeJobStore;
  sessionId?: string;
  now?: () => string;
}

function renderDecision(args: {
  decision: "approve" | "reject";
  actor: string;
  at: string;
  job: ComputeJobView;
  reason: string | null;
}): string {
  const { job } = args;
  const plan = job.plan;
  const lines = [
    `# ${args.decision === "approve" ? "批准" : "拒绝"}算力任务 · ${job.jobId}`,
    "",
    `- 决定：${args.decision === "approve" ? "approve" : "reject"}`,
    `- 决定人：${args.actor}`,
    `- 时间：${args.at}`,
    `- 执行地：${plan.target.kind}`,
    `- plan digest：${plan.digest}`,
    `- 用途：${plan.purpose}`,
    `- 命令：${JSON.stringify(plan.command)}`,
    `- 资源：cpus=${plan.resources.cpus} memoryGb=${plan.resources.memoryGb} ` +
      `gpu=${plan.resources.gpu ?? "无"} timeoutMinutes=${plan.resources.timeoutMinutes}`,
    `- 网络：${plan.network}`,
    `- 密钥引用：${plan.secretRefs.length ? plan.secretRefs.join(", ") : "无"}`,
    `- 上传：${plan.uploads.length} 个文件 / ${plan.uploadBytes} 字节`,
    `- 费用上界：${plan.estimate.upperBoundUsd === null ? "未知（查不到单价）" : `$${plan.estimate.upperBoundUsd}`}`,
    `- 警告原文：${plan.warning}`,
    "",
    "## 上传清单",
    ...(plan.uploads.length ? plan.uploads.map((u) => `- ${u.path}（${u.size} 字节，sha256 ${u.sha256.slice(0, 12)}）`) : ["- （无）"]),
    "",
    `## ${args.decision === "approve" ? "备注" : "拒绝理由"}`,
    args.reason ?? "（无）",
  ];
  return lines.join("\n");
}

export class ComputeApproval {
  private readonly records: Pick<RecordStore, "create" | "link">;
  private readonly jobs: ComputeJobStore;
  private readonly sessionId: string | undefined;
  private readonly now: () => string;

  constructor(deps: ComputeApprovalDeps) {
    this.records = deps.records;
    this.jobs = deps.jobs;
    this.sessionId = deps.sessionId;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** awaiting_approval → approved；落 decision record；写 job.json.approval。 */
  approve(jobId: string, input: ApproveInput): { job: ComputeJobView; decisionId: string } {
    const job = this.jobs.get(jobId);
    if (job.lifecycle.execution !== "awaiting_approval") {
      throw new ApprovalRequiredError(
        `算力任务 ${jobId} 当前 execution=${job.lifecycle.execution}，只有停在 awaiting_approval 的任务能被批准`,
      );
    }
    if (!job.plan.digest) {
      throw new ApprovalRequiredError(`算力任务 ${jobId} 没有 plan digest，无从批准——先重新 plan`);
    }
    if (!input.actor.trim()) {
      // 与湿实验同一条：approve 必须记名，「谁批的」是这条 decision record 的核心内容。
      throw new ApprovalRequiredError("approve 必须记名：谁批的是这条 decision record 的核心内容");
    }
    const at = this.now();
    const decision = this.records.create({
      type: "decision",
      title: `批准算力任务 · ${job.plan.purpose}`,
      content: renderDecision({ decision: "approve", actor: input.actor, at, job, reason: input.note ?? null }),
      // 审批是人的判断，不是观察/计算/文献 → inferred（与 wet_loop.ts:387-418 同形）。
      evidence: "inferred",
      origin: { kind: "manual", sessionId: this.sessionId, ref: job.jobId },
      metadata: {
        kind: "approval",
        decision: "approve",
        actor: input.actor,
        actorSource: input.actorSource ?? "explicit",
        at,
        planDigest: job.plan.digest,
        jobId: job.jobId,
        target: job.plan.target.kind,
        estimate: job.plan.estimate,
        warningShown: true,
        uploadsCount: job.plan.uploads.length,
        uploadBytes: job.plan.uploadBytes,
        note: input.note ?? null,
      },
      createdAt: at,
    });
    if (job.experimentId) this.records.link(decision.id, job.experimentId, "derives_from");

    const approval: ComputeApprovalMeta = {
      decisionRecordId: decision.id,
      actor: input.actor,
      actorSource: input.actorSource ?? "explicit",
      at,
      planDigest: job.plan.digest,
      note: input.note ?? null,
    };
    const next = this.jobs.patch(
      jobId,
      {
        lifecycle: transition(job.lifecycle, "approve", {
          approvalRequired: job.plan.approvalRequired,
          planDigest: job.plan.digest,
        }),
        approval,
        rejection: null,
        message: `${input.actor} 批准执行（plan digest ${job.plan.digest.slice(0, 12)}）`,
      },
      { expectedRev: job.rev },
    );
    return { job: next, decisionId: decision.id };
  }

  reject(jobId: string, input: RejectInput): { job: ComputeJobView; decisionId: string } {
    const job = this.jobs.get(jobId);
    if (job.lifecycle.execution !== "awaiting_approval") {
      throw new ApprovalRequiredError(
        `算力任务 ${jobId} 当前 execution=${job.lifecycle.execution}，只有停在 awaiting_approval 的任务能被拒绝`,
      );
    }
    if (!input.reason.trim()) {
      throw new ApprovalRequiredError("reject 必须给理由——「不批」而不说为什么，下一轮无从改起");
    }
    const at = this.now();
    const decision = this.records.create({
      type: "decision",
      title: `拒绝算力任务 · ${job.plan.purpose}`,
      content: renderDecision({ decision: "reject", actor: input.actor, at, job, reason: input.reason }),
      evidence: "inferred",
      origin: { kind: "manual", sessionId: this.sessionId, ref: job.jobId },
      metadata: {
        kind: "approval",
        decision: "reject",
        actor: input.actor,
        actorSource: input.actorSource ?? "explicit",
        at,
        planDigest: job.plan.digest,
        jobId: job.jobId,
        target: job.plan.target.kind,
        estimate: job.plan.estimate,
        warningShown: true,
        uploadsCount: job.plan.uploads.length,
        uploadBytes: job.plan.uploadBytes,
        reason: input.reason,
      },
      createdAt: at,
    });
    if (job.experimentId) this.records.link(decision.id, job.experimentId, "derives_from");

    const next = this.jobs.patch(
      jobId,
      {
        lifecycle: transition(job.lifecycle, "reject", {
          approvalRequired: job.plan.approvalRequired,
          planDigest: job.plan.digest,
        }),
        approval: null,
        rejection: {
          decisionRecordId: decision.id,
          actor: input.actor,
          actorSource: input.actorSource ?? "explicit",
          at,
          planDigest: job.plan.digest,
          note: null,
          reason: input.reason,
        },
        finishedAt: at,
        message: `${input.actor} 拒绝执行：${input.reason}`,
      },
      { expectedRev: job.rev },
    );
    return { job: next, decisionId: decision.id };
  }

  /**
   * 执行前重验 + **一次性消费**。由 broker.dispatch() 调用，不对外暴露成入口。
   *
   * digest 相符 → 同一次 CAS 写入里 approval → consumedApproval，并走 lifecycle 的
   * `dispatch` 转移（approved → queued）。为什么必须是同一次写：这一步之前的所有检查
   * 都只是「看起来能派发」，只有这一次写成功了才是「真的抢到了派发权」（湿实验 D-9）。
   *
   * digest 不符 → 标 failed 并抛 ApprovalRequiredError（照 wet_loop.ts:522-538）：
   * plan 在审批之后变了，那批的就不是这件事。
   */
  consume(jobId: string, currentDigest: string, expectedRev: number): ComputeJobView {
    const job = this.jobs.get(jobId);
    if (job.lifecycle.execution !== "approved") {
      throw new ApprovalRequiredError(
        `算力任务 ${jobId} 当前 execution=${job.lifecycle.execution}，未经 approve 不能派发（AD-6 同构）。` +
          `合法路径：plan → review → approve → dispatch`,
      );
    }
    if (!job.approval) {
      throw new ApprovalRequiredError(
        `算力任务 ${jobId} 处于 approved 但没有未消费的审批记录——拒绝派发` +
          `（approval 只能被消费一次；重启后要重派必须重新 approve）`,
      );
    }
    if (job.approval.planDigest !== currentDigest) {
      const detail =
        `审批的 plan digest 是 ${job.approval.planDigest.slice(0, 12)}，当前是 ${currentDigest.slice(0, 12)}` +
        `——plan 在审批之后变了。必须重新 plan → approve。`;
      this.jobs.patch(jobId, {
        lifecycle: { ...job.lifecycle, execution: "failed" },
        approval: null,
        supersededApproval: job.approval,
        finishedAt: this.now(),
        message: detail,
      });
      throw new ApprovalRequiredError(detail);
    }
    // CAS：rev 对不上说明别的请求抢先派发了，这一次判负（ComputeJobConflictError 往外抛，
    // broker 会把它翻成 409 语义的 ComputeDispatchConflictError）。
    return this.jobs.patch(
      jobId,
      {
        lifecycle: transition(job.lifecycle, "dispatch", {
          approvalRequired: job.plan.approvalRequired,
          planDigest: currentDigest,
          approval: job.approval,
        }),
        approval: null,
        consumedApproval: job.approval,
        dispatchedAt: this.now(),
        message: `派发（审批 ${job.approval.decisionRecordId.slice(0, 8)} 已一次性消费）`,
      },
      { expectedRev },
    );
  }
}
