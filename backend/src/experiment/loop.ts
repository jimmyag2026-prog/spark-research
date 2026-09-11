import type { ArtifactStore } from "../artifacts/store";
import type { ResearchRecord } from "../project/models";
import type { RecordStore } from "../project/records";
import type { SimulationRegistry } from "../simulation/registry";
import type { RunStatus, SimulationOutputs, SimulationPlatform } from "../simulation/models";
import {
  ExperimentNotFoundError,
  ExperimentStateError,
  canTransition,
  isComputeTargetName,
  isExperimentState,
  renderExperiment,
  renderObservation,
  type ComputeTargetName,
  type ExperimentMeta,
  type ExperimentState,
  type ExperimentView,
  type SummaryValue,
  type TransitionEntry,
} from "./models";
import type { ComputeEvidenceFacts, ExperimentComputeDriver } from "./compute_driver";
import type { RunStore } from "../simulation/run_store";

export interface ExperimentLoopOptions {
  records: RecordStore;
  artifacts: ArtifactStore;
  platforms: SimulationRegistry;
  // artifact 落库时的 project 引用；默认取 RecordStore 绑定的 project。
  projectSlug?: string;
  sessionId?: string | null;
  now?: () => string;
  // CB-6：注入 = 这个项目的实验可以把算例送去算力层跑（`exp new --target ...`）。
  // 不注入 = 只有本机子进程那条老路；带 computeTarget 的实验会**显式报错**而不是
  // 悄悄退回本机跑——退回去等于绕过审批门。
  compute?: ExperimentComputeDriver;
}

export interface DesignInput {
  title: string;
  platform: string;
  kind: string;
  params?: Record<string, unknown>;
  hypothesis?: string;
  sessionId?: string | null;
  /** CB-6：算例的执行地。省略/null = 本机子进程（老路径，行为完全不变）。 */
  target?: ComputeTargetName | null;
}

export interface ResumeResult {
  view: ExperimentView;
  // 恢复动作，供 CLI 直接打印：
  //   still_running     任务还在跑，接着等
  //   awaiting_compute  算力任务停在人工审批（CB-6）——**等的是人，不是机器**，
  //                     所以它必须与 still_running 分开：轮询一个等人点头的任务
  //                     只会白白转到超时（而且 run() 会把它读成「还在跑」）。
  //   ready_to_collect  任务已完成，可以 collect
  //   marked_failed     任务连同上一个编排进程一起没了，标 failed（可重试）
  //   noop              不在 dry_run 状态，无需恢复
  action: "still_running" | "awaiting_compute" | "ready_to_collect" | "marked_failed" | "noop";
  runStatus: RunStatus | null;
  // CB-6：算力路径下给人看的下一步（`spark-research compute approve <id> --run`）。
  computeAction?: string | null;
}

export interface RunOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  analysisNote?: string;
  // 每次 poll 后的回调（CLI 用来打进度）。
  onPoll?: (status: RunStatus) => void;
}

const DEFAULT_POLL_MS = 200;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function emptyMeta(input: {
  platform: string;
  kind: string;
  params: Record<string, unknown>;
  hypothesis: string | null;
  iteration: number;
  parentExperimentId: string | null;
  computeTarget: ComputeTargetName | null;
  at: string;
}): ExperimentMeta {
  return {
    kind: "experiment",
    mode: "dry",
    state: "design",
    platform: input.platform,
    simKind: input.kind,
    params: input.params,
    hypothesis: input.hypothesis,
    runId: null,
    specHash: null,
    attempts: 0,
    iteration: input.iteration,
    parentExperimentId: input.parentExperimentId,
    history: [],
    timestamps: { design: input.at },
    summary: null,
    artifactRecordIds: [],
    observationId: null,
    conclusionId: null,
    lastError: null,
    computeTarget: input.computeTarget,
    computeJobId: null,
  };
}

// 干实验闭环引擎（DESIGN 域 B3）。
//
// 三条不变量：
//   1. **状态只在 experiment record 里**（走 RecordStore.update() 窄口回写，P4 定的口径）。
//      内存里不留任何权威状态——否则「进程 kill 后续跑」无从谈起。
//   2. **仿真任务状态在磁盘上**（SubprocessSimulationPlatform 的 RunStore）。
//      所以 resume() 能在一个全新的进程里把 dry_run 中的任务重新接上。
//   3. **非法转移一律拒绝**，不做「顺手纠正」。状态机悄悄自愈等于没有状态机。
export class ExperimentLoop {
  private readonly records: RecordStore;
  private readonly artifacts: ArtifactStore;
  private readonly platforms: SimulationRegistry;
  private readonly projectSlug: string;
  private readonly sessionId: string | null;
  private readonly now: () => string;
  private readonly compute: ExperimentComputeDriver | undefined;

  constructor(options: ExperimentLoopOptions) {
    this.records = options.records;
    this.artifacts = options.artifacts;
    this.platforms = options.platforms;
    this.projectSlug = options.projectSlug ?? options.records.project;
    this.sessionId = options.sessionId ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
    this.compute = options.compute;
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  // P6 起同一个项目里会同时有干实验与湿实验（两张状态机、两套 metadata）。
  // 干实验一侧必须把 `mode="wet"` 的 record 滤掉：否则 toView 会把湿实验的
  // `awaiting_approval` 之类的状态**悄悄降级**成 design，读出来是一条假实验。
  private isDry(record: ResearchRecord): boolean {
    return (record.metadata as { mode?: string }).mode !== "wet";
  }

  list(filter: { state?: ExperimentState; platform?: string } = {}): ExperimentView[] {
    return this.records
      .list({ type: "experiment" })
      .filter((record) => this.isDry(record))
      .map((record) => this.toView(record))
      .filter((view) => (filter.state ? view.state === filter.state : true))
      .filter((view) => (filter.platform ? view.platform === filter.platform : true));
  }

  // 支持 id 前缀（CLI 里没人愿意抄完整 uuid）；前缀歧义时报错而不是猜。
  get(ref: string): ExperimentView {
    const exact = this.records.get(ref);
    if (exact && exact.type === "experiment" && this.isDry(exact)) return this.toView(exact);
    const matches = this.records
      .list({ type: "experiment" })
      .filter((record) => this.isDry(record) && record.id.startsWith(ref));
    if (matches.length === 1) return this.toView(matches[0]!);
    if (matches.length > 1) {
      throw new ExperimentNotFoundError(
        `${ref}（前缀命中 ${matches.length} 条：${matches.map((m) => m.id.slice(0, 12)).join(", ")}）`,
      );
    }
    throw new ExperimentNotFoundError(ref);
  }

  platformFor(view: { platform: string }): SimulationPlatform {
    return this.platforms.get(view.platform);
  }

  // ── design ────────────────────────────────────────────────────────────────

  async design(input: DesignInput): Promise<ExperimentView> {
    const platform = this.platforms.get(input.platform);
    // 在 design 阶段就做参数归一化：把「参数写错了」这件事挡在建 record 之前，
    // 而不是等到 dry_run 才炸——半成品实验记录比没有更糟（同 P4 的纪律）。
    const prepared = await platform.prepare({
      platform: input.platform,
      kind: input.kind,
      params: input.params ?? {},
      label: input.title,
    });
    const at = this.now();
    const meta = emptyMeta({
      platform: input.platform,
      kind: input.kind,
      params: prepared.params,
      hypothesis: input.hypothesis ?? null,
      iteration: 1,
      parentExperimentId: null,
      computeTarget: input.target ?? null,
      at,
    });
    meta.specHash = prepared.specHash;
    return this.createRecord(input.title, meta, input.sessionId ?? this.sessionId);
  }

  // ── dry_run ───────────────────────────────────────────────────────────────

  async dryRun(ref: string): Promise<ExperimentView> {
    const view = this.get(ref);
    this.assertTransition(view.state, "dry_run");
    const platform = this.platforms.get(view.platform);
    const availability = await platform.available();
    if (!availability.ok) {
      throw new Error(`仿真平台 '${view.platform}' 不可用：${availability.reason ?? "未知原因"}`);
    }
    const prepared = await platform.prepare({
      platform: view.platform,
      kind: view.simKind,
      params: view.params,
      label: view.title,
    });

    // ── CB-6 桥：computeTarget 非 null 就走算力层 ────────────────────────────
    //
    // 归一化（prepare）**照旧在本地做**：参数写错该在建 plan 之前就被拒，
    // 而不是花钱起一台远端机器之后才发现。变的只是「谁来执行」。
    if (view.computeTarget) {
      const driver = this.driver(view);
      const snapshot = await driver.submit(prepared, {
        experimentId: view.id,
        target: view.computeTarget,
        title: view.title,
      });
      // 状态**停在 dry_run**：算力任务在等人点头（或已可派发），
      // 干实验状态机不因此多一个状态（设计 §1.1.9 的第 2 条理由）。
      return this.transition(
        view,
        "dry_run",
        `算力任务 ${snapshot.jobId}（${snapshot.target}）已建计划：${snapshot.nextAction}`,
        (meta) => ({
          ...meta,
          // runId 要等收割回填之后才有——现在没有就是没有，不编一个。
          runId: null,
          computeJobId: snapshot.jobId,
          specHash: prepared.specHash,
          attempts: meta.attempts + 1,
          lastError: null,
        }),
      );
    }

    const runId = await platform.submit(prepared);
    return this.transition(view, "dry_run", `提交仿真 run ${runId}`, (meta) => ({
      ...meta,
      runId,
      specHash: prepared.specHash,
      attempts: meta.attempts + 1,
      lastError: null,
    }));
  }

  // 算力驱动的取用口：没注入就**显式失败**。悄悄退回本机跑 = 绕过审批门。
  private driver(view: { id: string; computeTarget: ComputeTargetName | null }): ExperimentComputeDriver {
    if (!this.compute) {
      throw new Error(
        `实验 ${view.id.slice(0, 8)} 的执行地是 '${view.computeTarget}'（算力层），` +
          `但当前上下文没有接算力驱动——请用 spark-research exp 命令（CLI 已接线），` +
          `或者在构造 ExperimentLoop 时注入 compute 驱动。**不会**替你退回本机跑：` +
          `那等于绕过审批门。`,
      );
    }
    return this.compute;
  }

  // 平台的 RunStore（磁盘真源）。桥把 harvest 回填进它，之后 platform.collect() 原样工作。
  private runStoreOf(platform: SimulationPlatform): RunStore {
    const store = (platform as { store?: RunStore }).store;
    if (!store) {
      throw new Error(
        `平台 '${platform.id}' 没有暴露 RunStore（不是 SubprocessSimulationPlatform）——` +
          `CB-6 的桥目前只支持「写 params.json / runner 自己写 done.json」这一类平台`,
      );
    }
    return store;
  }

  // 只读地看一眼仿真任务当前状态，不改 experiment 状态。
  async poll(ref: string): Promise<RunStatus | null> {
    const view = this.get(ref);
    if (!view.runId) return null;
    return this.platforms.get(view.platform).poll(view.runId);
  }

  // ── 断点续跑 ───────────────────────────────────────────────────────────────
  //
  // 这是 P5 的核心：编排进程被 kill 之后，用一个**全新**的 ExperimentLoop
  // 把状态接回来。三种情形都要能区分（DEVELOPMENT_PLAN P5 验证）：
  //   任务仍在跑 / 任务已完成 / 任务已丢失。
  async resume(ref: string): Promise<ResumeResult> {
    const view = this.get(ref);
    if (view.state !== "dry_run") return { view, action: "noop", runStatus: null };
    // CB-6：算力路径的「接回」问的是 broker（磁盘真源 job.json），不是 platform.poll()。
    if (view.computeTarget && view.computeJobId) return this.resumeCompute(view);
    if (!view.runId) {
      // dry_run 却没有 runId：状态写到一半进程就没了。按失败处理，可重试。
      const failed = this.transition(view, "failed", "dry_run 状态缺少 runId（提交过程中断）", (meta) => ({
        ...meta,
        lastError: "提交仿真时中断：experiment 处于 dry_run 但没有 runId",
      }));
      return { view: failed, action: "marked_failed", runStatus: null };
    }

    const platform = this.platforms.get(view.platform);
    let status: RunStatus;
    try {
      status = await platform.poll(view.runId);
    } catch (error) {
      // run 目录都不在了（被清理 / 换了工作目录）：同样按可重试的失败处理。
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.transition(view, "failed", "仿真 run 已丢失", (meta) => ({
        ...meta,
        lastError: message,
      }));
      return { view: failed, action: "marked_failed", runStatus: null };
    }

    if (status.state === "running" || status.state === "pending") {
      return { view, action: "still_running", runStatus: status };
    }
    if (status.state === "completed") {
      return { view, action: "ready_to_collect", runStatus: status };
    }
    const failed = this.transition(view, "failed", status.message ?? "仿真失败", (meta) => ({
      ...meta,
      lastError: status.message ?? "仿真失败（无错误信息）",
    }));
    return { view: failed, action: "marked_failed", runStatus: status };
  }

  // ── CB-6 · 算力路径的接回 ─────────────────────────────────────────────────
  //
  // 与本机路径逐条对照（同样的三种情形，只是问的对象不同）：
  //   还在跑 / 等人批  → still_running / awaiting_compute
  //   已完成           → 收割 + 回填成 runId，然后交给原来的 collect 路径
  //   已丢失/失败      → marked_failed，**如实报 recoverable**
  //
  // 真实 SIGKILL 走的就是最后一条：任务连同 exit-code 标记一起没了，
  // local adapter 的 recover() 抛 RecoverFailure(not_found)，broker 标 failed，
  // 这里把它翻译成实验侧的 failed + lastError，并把 recoverable 一并写进 lastError——
  // **不许**因为「后面还能重跑」就悄悄当成成功。
  private async resumeCompute(view: ExperimentView): Promise<ResumeResult> {
    const driver = this.driver(view);
    const jobId = view.computeJobId!;
    let snapshot;
    try {
      snapshot = driver.status(jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.transition(view, "failed", "算力任务已丢失", (meta) => ({
        ...meta,
        lastError: message,
      }));
      return { view: failed, action: "marked_failed", runStatus: null, computeAction: null };
    }

    // 等人（没批 / 批了没派 / 还没派）——**不是**「还在跑」。
    if (snapshot.awaitingHuman) {
      return { view, action: "awaiting_compute", runStatus: null, computeAction: snapshot.nextAction };
    }
    if (!snapshot.terminal) {
      return { view, action: "still_running", runStatus: null, computeAction: snapshot.nextAction };
    }
    if (snapshot.failed) {
      const detail =
        `${snapshot.message ?? `算力任务 ${jobId} 执行失败`}` +
        `（execution=${snapshot.execution}, exit=${snapshot.exitCode ?? "?"}, ` +
        `recoverable=${snapshot.recoverable}）`;
      const failed = this.transition(view, "failed", "算力任务失败", (meta) => ({
        ...meta,
        lastError: detail,
      }));
      return { view: failed, action: "marked_failed", runStatus: null, computeAction: snapshot.nextAction };
    }

    // 执行成功：收割 → 回填成 RunStore 认得的 run 目录 → 之后 collect 走原路径。
    const platform = this.platforms.get(view.platform);
    const prepared = await platform.prepare({
      platform: view.platform,
      kind: view.simKind,
      params: view.params,
      label: view.title,
    });
    let runId = view.runId;
    if (!runId || snapshot.delivery !== "complete") {
      try {
        runId = await driver.materialize(prepared, jobId, this.runStoreOf(platform));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = this.transition(view, "failed", "算力产物回填失败", (meta) => ({
          ...meta,
          lastError: message,
        }));
        return { view: failed, action: "marked_failed", runStatus: null, computeAction: snapshot.nextAction };
      }
    }
    const withRun = view.runId === runId ? view : this.patchMeta(view, (meta) => ({ ...meta, runId }));
    const status = await platform.poll(runId!);
    if (status.state !== "completed") {
      const failed = this.transition(withRun, "failed", "算力产物回填后仍不是 completed", (meta) => ({
        ...meta,
        lastError: status.message ?? `回填的 run ${runId} 状态是 ${status.state}`,
      }));
      return { view: failed, action: "marked_failed", runStatus: status, computeAction: snapshot.nextAction };
    }
    return { view: withRun, action: "ready_to_collect", runStatus: status, computeAction: null };
  }

  // failed → dry_run 的重试（换一个新 runId 重新提交）。
  async retry(ref: string): Promise<ExperimentView> {
    const view = this.get(ref);
    if (view.state !== "failed") {
      throw new ExperimentStateError(view.state, "dry_run", "retry 只能用于 failed 的实验");
    }
    return this.dryRun(view.id);
  }

  // ── collect ───────────────────────────────────────────────────────────────

  async collect(ref: string): Promise<ExperimentView> {
    const view = this.get(ref);
    this.assertTransition(view.state, "collect");
    if (!view.runId) throw new Error(`实验 ${view.id} 没有 runId，无法回收产出`);
    const platform = this.platforms.get(view.platform);
    const outputs = await platform.collect(view.runId);
    const artifactRecordIds = this.ingestOutputs(view, outputs);
    return this.transition(
      view,
      "collect",
      `回收 ${outputs.files.length} 个产出文件`,
      (meta) => ({
        ...meta,
        summary: outputs.summary,
        artifactRecordIds,
      }),
    );
  }

  // 仿真产出 → artifact store（带 lineage）→ artifact record → derives_from 边。
  // 这一步是「实验产出进证据图」的落点（DESIGN 域 C1 + AD-3）。
  private ingestOutputs(view: ExperimentView, outputs: SimulationOutputs): string[] {
    const ids: string[] = [];
    // CB-6：算力路径的产物必须带上「在哪儿跑的、批的是哪份 plan、谁批的、花了多少」——
    // 否则证据图上看得到文件，却回答不了「这是谁花钱在哪台机器上算出来的」。
    const compute = this.computeFacts(view);
    for (const file of outputs.files) {
      const provenance =
        `# ${view.platform}/${view.simKind} · run ${outputs.runId}\n` +
        `# 产出角色: ${file.role}\n` +
        `# 归一化参数（重放这次实验的完整输入）:\n` +
        JSON.stringify(view.params, null, 2) +
        "\n";
      const saved = this.artifacts.save(
        file.path,
        provenance,
        [
          {
            kind: "write",
            file: file.filename,
            role: "tool",
            content: `simulation ${view.platform}/${view.simKind} run ${outputs.runId} 产出（${file.role}）`,
          },
        ],
        // producingCellId = `${experimentId}:${attempt}`，
        // 于是 artifacts.listBySession(experimentId) 能一次取回这条实验的全部产出。
        { sessionId: view.id, cellIndex: view.attempts, runId: outputs.runId, platform: view.platform },
        this.projectSlug,
      );
      const record = this.records.createFromArtifact(saved, {
        provenanceClass: "derived",
        title: `${view.title} · ${file.filename}`,
        content: `实验 ${view.id.slice(0, 8)} 的仿真产出：${file.filename}（${file.role}，${file.bytes} 字节）`,
        evidence: "computed",
        metadata: {
          kind: "simulation_output",
          role: file.role,
          filename: file.filename,
          experimentId: view.id,
          runId: outputs.runId,
          platform: view.platform,
          simKind: view.simKind,
          bytes: file.bytes,
          ...(compute ?? {}),
        },
      });
      this.records.link(record.id, view.id, "derives_from");
      ids.push(record.id);
    }
    return ids;
  }

  // ── analyze ───────────────────────────────────────────────────────────────

  analyze(ref: string, options: { note?: string; sessionId?: string | null } = {}): ExperimentView {
    const view = this.get(ref);
    this.assertTransition(view.state, "analyze");
    const summary = view.summary ?? {};
    const files = view.artifactRecordIds
      .map((id) => this.records.get(id))
      .filter((record): record is ResearchRecord => record !== null)
      .map((record) => {
        const meta = record.metadata as { filename?: string; role?: string };
        return {
          filename: String(meta.filename ?? record.title.split(" · ").pop() ?? record.title),
          role: String(meta.role ?? "output"),
        };
      });

    const observation = this.records.create({
      type: "observation",
      provenanceClass: "derived",
      title: `${view.title} · 观察`,
      content: renderObservation(view.title, summary, files, options.note ?? null),
      // 仿真结果是算出来的，不是看出来的，也不是推出来的 → computed。
      evidence: "computed",
      origin: {
        kind: "cell",
        sessionId: options.sessionId ?? this.sessionId,
        ref: view.runId ? `${view.id}:${view.runId}` : view.id,
      },
      metadata: {
        kind: "simulation_summary",
        experimentId: view.id,
        runId: view.runId,
        platform: view.platform,
        deterministic: this.platforms.get(view.platform).deterministic,
        simKind: view.simKind,
        params: view.params,
        summary,
        note: options.note ?? null,
        ...(this.computeFacts(view) ?? {}),
      },
    });
    this.records.link(observation.id, view.id, "derives_from");
    for (const artifactRecordId of view.artifactRecordIds) {
      this.records.link(observation.id, artifactRecordId, "derives_from");
    }

    return this.transition(view, "analyze", `产出 observation ${observation.id.slice(0, 8)}`, (meta) => ({
      ...meta,
      observationId: observation.id,
    }));
  }

  // ── conclude / iterate ────────────────────────────────────────────────────

  conclude(
    ref: string,
    options: { claim?: string; limitations?: string; confidence?: string; sessionId?: string | null } = {},
  ): ExperimentView {
    const view = this.get(ref);
    this.assertTransition(view.state, "concluded");
    let conclusionId: string | null = null;
    if (options.claim) {
      // 结论卡的完整形态（含 review 门槛）是域 E2/P8 的范围；
      // 这里只落最小结构，review 状态一律 pending——不给自己发通过证。
      const conclusion = this.records.create({
        type: "conclusion",
        provenanceClass: "user_authored",
        title: `${view.title} · 结论`,
        content: options.claim,
        evidence: "inferred",
        origin: { kind: "session", sessionId: options.sessionId ?? this.sessionId, ref: view.id },
        metadata: {
          kind: "conclusion_card",
          claim: options.claim,
          limitations: options.limitations ?? null,
          confidence: options.confidence ?? null,
          review: "pending",
          experimentId: view.id,
          observationId: view.observationId,
        },
      });
      if (view.observationId) this.records.link(conclusion.id, view.observationId, "derives_from");
      this.records.link(conclusion.id, view.id, "derives_from");
      conclusionId = conclusion.id;
    }
    return this.transition(view, "concluded", options.claim ? "得出结论" : "结束（未给结论卡）", (meta) => ({
      ...meta,
      conclusionId,
    }));
  }

  // 把一条 analyze 中的干实验直接推到终态 `iterated`，**不**新建干实验。
  //
  // P6 的干湿闭环接通点用它：干实验跑完观察之后，接棒的是一条**湿**实验
  //（另一张状态机、另一个 record 类型形态），不是 `iterate()` 能建出来的东西。
  // supersedes 边由调用方（WetLabLoop.deriveFromDry）在建完湿实验后补，方向与 iterate 一致。
  markIterated(ref: string, note: string): ExperimentView {
    const view = this.get(ref);
    this.assertTransition(view.state, "iterated");
    return this.transition(view, "iterated", note, (meta) => meta);
  }

  // 改参数另起一条实验：新 record 走 supersedes 边连回旧的，旧的转入终态 iterated。
  async iterate(
    ref: string,
    options: { params: Record<string, unknown>; title?: string; hypothesis?: string; note?: string },
  ): Promise<{ previous: ExperimentView; next: ExperimentView }> {
    const view = this.get(ref);
    this.assertTransition(view.state, "iterated");
    const platform = this.platforms.get(view.platform);
    // 参数是**增量修改**：只写要改的键，其余沿用上一轮。
    const merged = { ...view.params, ...options.params };
    const prepared = await platform.prepare({
      platform: view.platform,
      kind: view.simKind,
      params: merged,
      label: options.title ?? view.title,
    });
    if (prepared.specHash === view.specHash) {
      throw new Error(
        `iterate 的参数与上一轮完全相同（specHash ${prepared.specHash}）——那不是迭代，是重跑。` +
          `要重跑请用 retry / 新建实验。`,
      );
    }

    const at = this.now();
    const meta = emptyMeta({
      platform: view.platform,
      kind: view.simKind,
      params: prepared.params,
      hypothesis: options.hypothesis ?? view.hypothesis,
      iteration: view.iteration + 1,
      parentExperimentId: view.id,
      // 迭代出来的新实验沿用上一轮的执行地：换 target 是另一次显式决定，不是迭代的副作用。
      computeTarget: view.computeTarget,
      at,
    });
    meta.specHash = prepared.specHash;
    const next = this.createRecord(options.title ?? `${view.title}（第 ${view.iteration + 1} 轮）`, meta, this.sessionId);
    this.records.link(next.id, view.id, "supersedes");
    const previous = this.transition(
      view,
      "iterated",
      options.note ?? `迭代出新实验 ${next.id.slice(0, 8)}`,
      (m) => m,
    );
    return { previous, next: this.get(next.id) };
  }

  // ── 驱动器 ────────────────────────────────────────────────────────────────
  //
  // 把 design/failed → dry_run → collect → analyze 一路推到底。
  // 每一步都从 record 重新读状态，所以中途换进程接上也是同一条路径。
  async run(ref: string, options: RunOptions = {}): Promise<ExperimentView> {
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let view = this.get(ref);

    if (view.state === "design" || view.state === "failed") {
      view = await this.dryRun(view.id);
    }

    if (view.state === "dry_run") {
      const deadline = Date.now() + timeout;
      for (;;) {
        const resumed = await this.resume(view.id);
        view = resumed.view;
        if (resumed.runStatus) options.onPoll?.(resumed.runStatus);
        if (resumed.action === "ready_to_collect") break;
        if (resumed.action === "awaiting_compute") {
          // 等的是**人**：继续轮询只会转到超时，还会把「没人批」报成「跑得慢」。
          throw new Error(
            `算力任务在等人工审批，实验 ${view.id.slice(0, 8)} 停在 dry_run。` +
              `批准并派发后再 \`exp run <id> --resume\` 接回来：${resumed.computeAction ?? "spark-research compute list"}`,
          );
        }
        if (resumed.action === "marked_failed") {
          throw new Error(`仿真失败：${view.lastError ?? "未知原因"}（实验 ${view.id.slice(0, 8)} 状态 failed，可 retry）`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `等待仿真超时（${timeout}ms）。任务仍在跑，状态已持久化——稍后 \`exp run <id> --resume\` 可续上。`,
          );
        }
        await Bun.sleep(interval);
      }
      view = await this.collect(view.id);
    }

    if (view.state === "collect") {
      view = this.analyze(view.id, { note: options.analysisNote });
    }
    return view;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private createRecord(title: string, meta: ExperimentMeta, sessionId: string | null): ExperimentView {
    const record = this.records.create({
      type: "experiment",
      provenanceClass: "user_authored",
      title,
      content: renderExperiment({ ...meta, id: "(pending)", title, createdAt: meta.timestamps.design ?? this.now() }),
      // 实验设计是推出来的；产出的 observation 才是 computed。
      evidence: "inferred",
      origin: { kind: "session", sessionId, ref: null },
      metadata: meta as unknown as Record<string, unknown>,
    });
    // 正文里要带 record id，只能建完再重渲染一次。
    const view = this.toView(record);
    this.records.update(record.id, { content: renderExperiment(view) });
    return this.toView(this.records.get(record.id)!);
  }

  private assertTransition(from: ExperimentState, to: ExperimentState): void {
    if (!canTransition(from, to)) throw new ExperimentStateError(from, to);
  }

  // 算力事实（设计 §1.1.8「证据图」行的五个字段）。本机路径返回 null——
  // 那条路上这些字段没有意义，塞一堆 null 进 metadata 只会让读图的人以为「查过了，是空的」。
  private computeFacts(view: ExperimentView): ComputeEvidenceFacts | null {
    if (!view.computeTarget || !view.computeJobId || !this.compute) return null;
    return this.compute.evidenceFor(view.computeJobId);
  }

  // 只改 metadata、**不**转移状态（dry_run → dry_run 不是合法转移，也不该是）。
  // CB-6 用它把回填出来的 runId 写回实验记录：那不是一次状态变化，是同一个状态里
  // 多知道了一件事。
  private patchMeta(view: ExperimentView, patch: (meta: ExperimentMeta) => ExperimentMeta): ExperimentView {
    const base: ExperimentMeta = {
      kind: "experiment",
      mode: "dry",
      state: view.state,
      platform: view.platform,
      simKind: view.simKind,
      params: view.params,
      hypothesis: view.hypothesis,
      runId: view.runId,
      specHash: view.specHash,
      attempts: view.attempts,
      iteration: view.iteration,
      parentExperimentId: view.parentExperimentId,
      history: view.history,
      timestamps: view.timestamps,
      summary: view.summary,
      artifactRecordIds: view.artifactRecordIds,
      observationId: view.observationId,
      conclusionId: view.conclusionId,
      lastError: view.lastError,
      computeTarget: view.computeTarget,
      computeJobId: view.computeJobId,
    };
    const next = patch(base);
    const nextView: ExperimentView = {
      ...next,
      id: view.id,
      title: view.title,
      createdAt: view.createdAt,
      record: view.record,
    };
    const updated = this.records.update(view.id, {
      content: renderExperiment(nextView),
      metadata: next as unknown as Record<string, unknown>,
    });
    return this.toView(updated);
  }

  private transition(
    view: ExperimentView,
    to: ExperimentState,
    note: string | null,
    patch: (meta: ExperimentMeta) => ExperimentMeta,
  ): ExperimentView {
    this.assertTransition(view.state, to);
    const at = this.now();
    const entry: TransitionEntry = { from: view.state, to, at, note };
    const base: ExperimentMeta = {
      kind: "experiment",
      mode: "dry",
      state: view.state,
      platform: view.platform,
      simKind: view.simKind,
      params: view.params,
      hypothesis: view.hypothesis,
      runId: view.runId,
      specHash: view.specHash,
      attempts: view.attempts,
      iteration: view.iteration,
      parentExperimentId: view.parentExperimentId,
      history: view.history,
      timestamps: view.timestamps,
      summary: view.summary,
      artifactRecordIds: view.artifactRecordIds,
      observationId: view.observationId,
      conclusionId: view.conclusionId,
      lastError: view.lastError,
      computeTarget: view.computeTarget,
      computeJobId: view.computeJobId,
    };
    const next: ExperimentMeta = {
      ...patch(base),
      state: to,
      // 每次转移都留时间戳（DEVELOPMENT_PLAN P5「每个状态转移落 metadata 时间戳」）。
      history: [...view.history, entry],
      timestamps: { ...view.timestamps, [to]: at },
    };
    const nextView: ExperimentView = { ...next, id: view.id, title: view.title, createdAt: view.createdAt, record: view.record };
    const updated = this.records.update(view.id, {
      content: renderExperiment(nextView),
      metadata: next as unknown as Record<string, unknown>,
    });
    return this.toView(updated);
  }

  private toView(record: ResearchRecord): ExperimentView {
    const meta = record.metadata as Partial<ExperimentMeta>;
    const state = isExperimentState(meta.state) ? meta.state : "design";
    return {
      kind: "experiment",
      mode: "dry",
      state,
      platform: String(meta.platform ?? ""),
      simKind: String(meta.simKind ?? ""),
      params: (meta.params as Record<string, unknown>) ?? {},
      hypothesis: meta.hypothesis ?? null,
      runId: meta.runId ?? null,
      specHash: meta.specHash ?? null,
      attempts: Number(meta.attempts ?? 0),
      iteration: Number(meta.iteration ?? 1),
      parentExperimentId: meta.parentExperimentId ?? null,
      history: (meta.history as TransitionEntry[]) ?? [],
      timestamps: (meta.timestamps as Partial<Record<ExperimentState, string>>) ?? {},
      summary: (meta.summary as Record<string, SummaryValue> | null) ?? null,
      artifactRecordIds: (meta.artifactRecordIds as string[]) ?? [],
      observationId: meta.observationId ?? null,
      conclusionId: meta.conclusionId ?? null,
      lastError: meta.lastError ?? null,
      // 老 record 没有这两个字段：缺省 = 本机跑，不迁移（设计 §1.1.9）。
      computeTarget: isComputeTargetName(meta.computeTarget) ? meta.computeTarget : null,
      computeJobId: meta.computeJobId ?? null,
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      record,
    };
  }
}

export { EXPERIMENT_STATES, LEGAL_TRANSITIONS, canTransition, ExperimentStateError, ExperimentNotFoundError } from "./models";
export type { ExperimentState, ExperimentView, ExperimentMeta, TransitionEntry } from "./models";
