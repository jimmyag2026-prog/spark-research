import type { ArtifactStore } from "../artifacts/store";
import type { ResearchRecord } from "../project/models";
import type { RecordStore } from "../project/records";
import type { SimulationRegistry } from "../simulation/registry";
import type { RunStatus, SimulationOutputs, SimulationPlatform } from "../simulation/models";
import {
  ExperimentNotFoundError,
  ExperimentStateError,
  canTransition,
  isExperimentState,
  renderExperiment,
  renderObservation,
  type ExperimentMeta,
  type ExperimentState,
  type ExperimentView,
  type SummaryValue,
  type TransitionEntry,
} from "./models";

export interface ExperimentLoopOptions {
  records: RecordStore;
  artifacts: ArtifactStore;
  platforms: SimulationRegistry;
  // artifact 落库时的 project 引用；默认取 RecordStore 绑定的 project。
  projectSlug?: string;
  sessionId?: string | null;
  now?: () => string;
}

export interface DesignInput {
  title: string;
  platform: string;
  kind: string;
  params?: Record<string, unknown>;
  hypothesis?: string;
  sessionId?: string | null;
}

export interface ResumeResult {
  view: ExperimentView;
  // 恢复动作，供 CLI 直接打印：
  //   still_running     任务还在跑，接着等
  //   ready_to_collect  任务已完成，可以 collect
  //   marked_failed     任务连同上一个编排进程一起没了，标 failed（可重试）
  //   noop              不在 dry_run 状态，无需恢复
  action: "still_running" | "ready_to_collect" | "marked_failed" | "noop";
  runStatus: RunStatus | null;
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

  constructor(options: ExperimentLoopOptions) {
    this.records = options.records;
    this.artifacts = options.artifacts;
    this.platforms = options.platforms;
    this.projectSlug = options.projectSlug ?? options.records.project;
    this.sessionId = options.sessionId ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  list(filter: { state?: ExperimentState; platform?: string } = {}): ExperimentView[] {
    return this.records
      .list({ type: "experiment" })
      .map((record) => this.toView(record))
      .filter((view) => (filter.state ? view.state === filter.state : true))
      .filter((view) => (filter.platform ? view.platform === filter.platform : true));
  }

  // 支持 id 前缀（CLI 里没人愿意抄完整 uuid）；前缀歧义时报错而不是猜。
  get(ref: string): ExperimentView {
    const exact = this.records.get(ref);
    if (exact && exact.type === "experiment") return this.toView(exact);
    const matches = this.records
      .list({ type: "experiment" })
      .filter((record) => record.id.startsWith(ref));
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
    const runId = await platform.submit(prepared);
    return this.transition(view, "dry_run", `提交仿真 run ${runId}`, (meta) => ({
      ...meta,
      runId,
      specHash: prepared.specHash,
      attempts: meta.attempts + 1,
      lastError: null,
    }));
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
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      record,
    };
  }
}

export { EXPERIMENT_STATES, LEGAL_TRANSITIONS, canTransition, ExperimentStateError, ExperimentNotFoundError } from "./models";
export type { ExperimentState, ExperimentView, ExperimentMeta, TransitionEntry } from "./models";
