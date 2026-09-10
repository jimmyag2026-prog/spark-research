// C1 · 编排：plan → approve → dispatch → poll → collect → release（CB-1/CB-2，设计 §2.5）。
//
// broker 是唯一知道「审批、上传、状态机、adapter」怎么拼在一起的地方。
// 它**没有**一条「跳过审批直接派发」的路径——不是因为没人想要，而是因为那条路径
// 一旦存在，测试就会用它，然后它会活到生产（K-2）。要跑不需要审批的任务，
// 唯一的办法是让 plan 的 approvalRequired 派生为 false（L-3），那是 plan 内容说了算，
// 不是调用方说了算。

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactStore } from "../artifacts/store";
import type { CredentialProvider } from "../connectors/base";
import type { BudgetLedger } from "../llm/budget";
import type { EvidenceLabel, ResearchRecord } from "../project/models";
import type { RecordStore } from "../project/records";
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
  /**
   * 注入 = 算力产出进证据图（S2）。生产入口一律注入（见 `openComputeScope()`）；
   * 不注入的只有那些本来就不该碰 record 的单测（lifecycle/plan 层）。
   */
  evidence?: ComputeEvidenceRecorder;
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

// ── S2 · 算力产出进证据图（设计 §1.1.8「证据图」行，W5-3 α） ──────────────────
//
// W5-2 末的零上下文外部验收撞死在这里：主线 plan → run → collect 每一步都成功，
// 然后 `report stats` 全是零、`select * from execution_records` 是空的——收割回来的
// `result.json` 只躺在 `jobs/<id>/harvest/`，**没注册成 artifact**。连锁后果是
// `conclusion` 那条「结论引用的观察必须真实存在于执行记录」的确定性校验对算力结果
// 永远无法通过：没有 observation 可引，方案 §6.3 主线的「读回结论」被直接掐断。
//
// 落点为什么在 broker 而不在 cli：`compute collect` 有**两个**生产入口
// （CLI 与 `server/routes/compute.ts` 的 `POST /jobs/:id/collect`，两者都走
// `openComputeScope()` 拿同一个 broker）。写在 cli 里，HTTP 那条路就会静默地不落证据——
// 这正是 V46「同一件事两份手写副本」的形状。所以证据写入挂在 broker 的两个语义点上：
//   · 执行进终态（settle）→ 一条 observation（这次算力**运行**本身的观察）
//   · 收割成功（collect）→ harvest 文件各一条 artifact record + 补边 + 回填 observation
//
// K-3 不变：**不是每次 poll 落一条 record**。整条 job 生命周期只落这两处，
// 与「人做决定（decision）」一起构成算力在证据图上的全部足迹。
//
// **桥路径（experimentId ≠ null）由 `ExperimentLoop` 自己落证据**（设计 §1.1.9），
// 这里一律跳过——否则同一批产出会在图上出现两次。

/**
 * 算力产出 observation 的 `metadata.kind`。
 *
 * **这是与 lane δ（证据图可见性）共享的字面量真源**（§三·补.8.4 第 3 条教训）：
 * 需要按「算力产出」筛 record 的地方一律 `import { COMPUTE_OUTPUT_OBSERVATION_KIND }
 * from "../compute/broker"`，不许两边各写一份 "compute_output" 字符串。
 */
export const COMPUTE_OUTPUT_OBSERVATION_KIND = "compute_output";

/** harvest 文件对应的 artifact record 的 `metadata.kind`（同一份真源，同一条纪律）。 */
export const COMPUTE_OUTPUT_ARTIFACT_KIND = "compute_output_file";

/**
 * 算力产出的证据标签：算出来的，不是看出来的，也不是推出来的 → `computed`。
 * 证据标签是确定性层（`reviewer/conclusion_rules.ts`）的输入，**不许漂**。
 */
export const COMPUTE_OUTPUT_EVIDENCE: EvidenceLabel = "computed";

export interface ComputeHarvestEvidence {
  observationId: string | null;
  artifactRecordIds: string[];
}

/** 没有注入 evidence（或桥路径自己落证据）时的空结果——**不是**「落过但为空」。 */
export const NO_HARVEST_EVIDENCE: ComputeHarvestEvidence = { observationId: null, artifactRecordIds: [] };

export interface ComputeEvidenceDeps {
  records: RecordStore;
  artifacts: ArtifactStore;
  /** artifact 落库时的 project 引用；默认取 RecordStore 绑定的 project。 */
  projectSlug?: string;
  sessionId?: string | null;
}

function renderComputeObservation(job: ComputeJobView, files: Harvest["files"], wallSeconds: number | null): string {
  const lines: string[] = [];
  lines.push(`# 观察 · 算力运行 ${job.jobId}`);
  lines.push("");
  lines.push(`- 目的：${job.plan.purpose}`);
  lines.push(`- 执行地：${job.target.kind}`);
  lines.push(`- 命令：\`${job.plan.command.join(" ")}\``);
  lines.push(`- planDigest：\`${job.plan.digest}\``);
  lines.push(`- 执行状态：${job.lifecycle.execution}（exit=${job.exitCode ?? "?"}）`);
  lines.push(`- 交付状态：${job.lifecycle.delivery}`);
  lines.push(`- 墙钟：${wallSeconds === null ? "未知" : `${wallSeconds}s`}`);
  // 查不到单价就是「未知」，**绝不写成 0**（PRICING 纪律）。
  lines.push(`- 实际花费：${job.actualCostUsd === null ? "未知（查不到单价）" : `$${job.actualCostUsd}`}`);
  lines.push("");
  if (files.length === 0) {
    lines.push("产出文件：（尚未收割）");
  } else {
    lines.push("产出文件：");
    for (const f of files) lines.push(`- \`${f.path}\`（${f.bytes} 字节，sha256 ${f.sha256.slice(0, 12)}）`);
  }
  return lines.join("\n");
}

/**
 * 把一次算力运行写进证据图。**只有两个写入时机**（见上面大注释）。
 *
 * 幂等靠「按 `metadata.computeJobId` 回查 observation」，而不是往 `job.json` 里加字段——
 * `ComputeJobRecord` 的形状归 `job_store.ts` 所有，本 lane 不动它。
 */
export class ComputeEvidenceRecorder {
  private readonly records: RecordStore;
  private readonly artifacts: ArtifactStore;
  private readonly projectSlug: string;
  private readonly sessionId: string | null;

  constructor(deps: ComputeEvidenceDeps) {
    this.records = deps.records;
    this.artifacts = deps.artifacts;
    this.projectSlug = deps.projectSlug ?? deps.records.project;
    this.sessionId = deps.sessionId ?? null;
  }

  /** 已经为这个 job 落过的 observation（幂等判据）。 */
  observationFor(jobId: string): ResearchRecord | null {
    for (const record of this.records.list({ type: "observation" })) {
      const meta = record.metadata as { kind?: unknown; computeJobId?: unknown };
      if (meta.kind === COMPUTE_OUTPUT_OBSERVATION_KIND && meta.computeJobId === jobId) return record;
    }
    return null;
  }

  private decisionRecordIdOf(job: ComputeJobView): string | null {
    return job.consumedApproval?.decisionRecordId ?? job.approval?.decisionRecordId ?? null;
  }

  /** 执行进终态：落这次运行的 observation（此刻还没有产物，文件清单收割后回填）。 */
  recordExecution(job: ComputeJobView): ResearchRecord | null {
    if (job.experimentId) return null; // 桥路径的证据归 ExperimentLoop（设计 §1.1.9）
    const existing = this.observationFor(job.jobId);
    if (existing) return existing;
    const decisionRecordId = this.decisionRecordIdOf(job);
    const observation = this.records.create({
      type: "observation",
      title: `算力运行 · ${job.plan.purpose}`,
      content: renderComputeObservation(job, [], null),
      evidence: COMPUTE_OUTPUT_EVIDENCE,
      origin: { kind: "session", sessionId: this.sessionId, ref: job.jobId },
      metadata: {
        kind: COMPUTE_OUTPUT_OBSERVATION_KIND,
        computeJobId: job.jobId,
        computeTarget: job.target.kind,
        planDigest: job.plan.digest,
        decisionRecordId,
        // 执行锚点：`conclusion_rules.ts` 的 evidence_without_execution 判据读的是
        // runId/experimentId。算力运行的那次执行就是这个 job，如实填它——
        // 不填的话，基于算力结果写的结论会被判「手工登记的观察」。
        runId: job.jobId,
        experimentId: null,
        purpose: job.plan.purpose,
        command: job.plan.command,
        execution: job.lifecycle.execution,
        delivery: job.lifecycle.delivery,
        exitCode: job.exitCode,
        actualCostUsd: job.actualCostUsd,
        wallSeconds: null,
        files: [],
        artifactRecordIds: [],
      },
    });
    if (decisionRecordId && this.records.get(decisionRecordId)) {
      // 这次运行是那次审批的产物：图上要走得通「结论 → 观察 → 谁批的」。
      this.records.link(observation.id, decisionRecordId, "derives_from");
    }
    return observation;
  }

  /** 收割成功：harvest 文件各一条 artifact record，回填 observation 并连边。 */
  recordHarvest(job: ComputeJobView, harvest: Harvest): ComputeHarvestEvidence {
    if (job.experimentId) return { observationId: null, artifactRecordIds: [] };
    // 收割先于「执行 observation 已存在」的情形（如 recover 后另一个进程收割）也要能落。
    const observation = this.observationFor(job.jobId) ?? this.recordExecution(job);
    const artifactRecordIds: string[] = [];
    for (const file of harvest.files) {
      const abs = join(job.jobDir, "harvest", file.path);
      if (!existsSync(abs)) continue;
      const provenance =
        `# 算力运行 ${job.jobId} · target=${job.target.kind}\n` +
        `# planDigest: ${job.plan.digest}\n` +
        `# 命令（argv，被审批的原样）:\n${JSON.stringify(job.plan.command, null, 2)}\n`;
      const saved = this.artifacts.save(
        abs,
        provenance,
        [
          {
            kind: "write",
            file: file.path,
            role: "tool",
            content: `compute ${job.target.kind} job ${job.jobId} 产出（${file.path}）`,
          },
        ],
        { sessionId: job.jobId, runId: job.jobId, target: job.target.kind },
        this.projectSlug,
      );
      const record = this.records.createFromArtifact(saved, {
        title: `算力产出 · ${file.path}`,
        content: `算力任务 ${job.jobId.slice(0, 12)} 的产出：${file.path}（${file.bytes} 字节，sha256 ${file.sha256.slice(0, 12)}）`,
        evidence: COMPUTE_OUTPUT_EVIDENCE,
        metadata: {
          kind: COMPUTE_OUTPUT_ARTIFACT_KIND,
          computeJobId: job.jobId,
          computeTarget: job.target.kind,
          planDigest: job.plan.digest,
          filename: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
        },
      });
      artifactRecordIds.push(record.id);
      if (observation) this.records.link(observation.id, record.id, "derives_from");
    }
    if (observation) {
      // 边方向与干实验一致（observation --derives_from--> artifact），读图的人从观察
      // 一步走到产物；正文与 metadata 一并回填成收割后的样子。
      const meta = observation.metadata as Record<string, unknown>;
      this.records.update(observation.id, {
        content: renderComputeObservation(job, harvest.files, harvest.wallSeconds),
        metadata: {
          ...meta,
          execution: job.lifecycle.execution,
          delivery: job.lifecycle.delivery,
          exitCode: job.exitCode,
          actualCostUsd: job.actualCostUsd,
          wallSeconds: harvest.wallSeconds,
          files: harvest.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
          artifactRecordIds,
        },
      });
    }
    return { observationId: observation?.id ?? null, artifactRecordIds };
  }
}

export class ComputeBroker {
  private readonly jobs: ComputeJobStore;
  private readonly adapters: Partial<Record<TargetKind, ComputeAdapter>>;
  private readonly approval: ComputeApproval;
  private readonly credentials: CredentialProvider;
  private readonly pricing: PricingLookup;
  private readonly budget: Pick<BudgetLedger, "record"> | undefined;
  private readonly evidence: ComputeEvidenceRecorder | undefined;
  private readonly admissionLimit: number;
  private readonly now: () => string;

  constructor(deps: ComputeBrokerDeps) {
    this.jobs = deps.jobs;
    this.adapters = deps.adapters;
    this.approval = deps.approval;
    this.credentials = deps.credentials;
    this.pricing = deps.pricing;
    this.budget = deps.budget;
    this.evidence = deps.evidence;
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
      // 两种完全不同的情形，**不许**用同一句话打发（W5-3 α 的真实 SIGKILL 实测撞到）：
      //   ① 从未派发：dispatchedAt 为空，确实没有可接回的东西；
      //   ② 派发过、执行中途编排进程被杀：adapterHandle 只在 adapter.run() **返回时**
      //      才落盘（CB-2 的现状），所以句柄跟着编排进程一起没了——但任务本身可能仍在跑、
      //      也可能已经跑完，产物就在 <jobDir>/workspace 里。
      // 情形②说成「从未真正派发出去」是**假话**，而且它把 recoverable 留在 false，
      // 于是 release 会毫无阻拦地删掉那份唯一的产物副本（L-4 本该拦住它）。
      const inflight: LifecycleState["execution"][] = ["queued", "starting", "running"];
      const wasDispatched = job.dispatchedAt !== null && inflight.includes(job.lifecycle.execution);
      return this.jobs.patch(jobId, {
        // 走 transition 的 fail 边（而不是手写状态对象）：终态非 cancelled 一律置
        // recoverable=true，产物在 delivery 走完之前不许被 release 掉（L-4/L-6）。
        lifecycle: wasDispatched
          ? this.step(job.lifecycle, "fail", job.plan)
          : { ...job.lifecycle, execution: "failed" },
        finishedAt: this.now(),
        message: wasDispatched
          ? `派发过（${job.dispatchedAt}）但 job.json 里没有 adapterHandle——` +
            `本地 adapter 的句柄只在执行返回时落盘，编排进程在执行中途被杀就会连它一起丢。` +
            `任务本身可能仍在跑、也可能已经跑完：产物与日志请到 ${job.jobDir}/workspace ` +
            `与 ${job.jobDir}/run.log 自行核对。按失败处理，且 recoverable=true（产物可能只剩本地这一份，` +
            `release 前必须先 collect 或显式 --discard）。重跑需要**新的审批**。`
          : "没有 adapterHandle，无从接回——这个任务从未真正派发出去",
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

  /** 这次算力运行在证据图上的 observation（S2）；没落过或没注入 evidence 时为 null。 */
  observationIdFor(jobId: string): string | null {
    return this.evidence?.observationFor(jobId)?.id ?? null;
  }

  async collect(jobId: string): Promise<{ job: ComputeJobView; harvest: Harvest; evidence: ComputeHarvestEvidence }> {
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
      return { job: pending, harvest, evidence: NO_HARVEST_EVIDENCE };
    }
    if (harvest.reconcileError) {
      const failed = this.jobs.patch(jobId, {
        lifecycle: this.step(pending.lifecycle, "deliver_fail", job.plan),
        message: `收割对账失败：${harvest.reconcileError}`,
      });
      return { job: failed, harvest, evidence: NO_HARVEST_EVIDENCE };
    }
    const costUsd = this.chargeFor(job, harvest);
    const done = this.jobs.patch(jobId, {
      lifecycle: this.step(pending.lifecycle, "deliver_ok", job.plan),
      actualCostUsd: costUsd,
      message: `已收割 ${harvest.files.length} 个产物`,
    });
    // S2：收割成功的那一刻产物进证据图。放在这里而不是 CLI 里——CLI 与 HTTP 两个入口
    // 都经过这一行，写在任一入口都会让另一个入口静默地不落证据。
    const evidence = this.evidence?.recordHarvest(done, harvest) ?? NO_HARVEST_EVIDENCE;
    return { job: done, harvest, evidence };
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
    const settled = this.jobs.patch(job.jobId, {
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
    // S2：执行进终态 → 这次运行本身的 observation。失败与超时也落——
    // 「跑过、没跑出来」同样是一条真实的观察，把它藏起来才是不诚实。
    this.evidence?.recordExecution(settled);
    return settled;
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
