import { mkdirSync } from "node:fs";
import type { ArtifactStore } from "../artifacts/store";
import type { ExperimentLoop } from "../experiment/loop";
import type { ResearchRecord } from "../project/models";
import type { RecordStore } from "../project/records";
import { LabSafetyError } from "./orchestrator";
import { compileToOpentrons, type OpentronsProgram } from "./opentrons_protocol";
import { ProtocolCompiler, type Protocol } from "./protocol";
import { runSafetyRules, type SafetyReport } from "./safety";
import {
  DEFAULT_WET_BACKEND,
  wetBackend,
  type WetLabBackend,
  type WetRunLogEntry,
  type WetRunResult,
  type WetSummaryValue,
} from "./wet_backend";
import {
  ApprovalRequiredError,
  WetExperimentNotFoundError,
  WetStateError,
  canWetTransition,
  isWetExperimentState,
  renderDecision,
  renderWetExperiment,
  renderWetObservation,
  type WetExperimentMeta,
  type WetExperimentState,
  type WetExperimentView,
  type WetTransitionEntry,
} from "./wet_models";

// 湿实验闭环引擎（DESIGN 域 B2/B3 · AD-6）。
//
// 四条不变量：
//   1. **状态只在 experiment record 里**，走 `RecordStore.update()` 窄口回写（P4/P5 同一口径）。
//   2. **唯一进入 `wet_run` 的门是 `approve()`**。安全门通过只把实验推到 `awaiting_approval`。
//   3. **执行前二次核对协议 hash**：`approve` 批的是某一版协议；只要 hash 对不上就拒绝执行。
//      这是给状态机之外的路径（有人直接改了 record、或并发编译）留的第二道防线。
//   4. **非法转移一律拒绝，不做「顺手纠正」**。

export interface WetLabLoopOptions {
  records: RecordStore;
  artifacts: ArtifactStore;
  // 湿实验 run 目录的根，一般是 `<project>/experiments/wet`。
  root: string;
  backend?: WetLabBackend;
  compiler?: ProtocolCompiler;
  projectSlug?: string;
  sessionId?: string | null;
  now?: () => string;
}

export interface WetDesignInput {
  title: string;
  naturalLanguage: string;
  hypothesis?: string;
  sessionId?: string | null;
  derivedFromDryExperimentId?: string | null;
}

export interface ApproveInput {
  actor: string;
  // 署名来源："explicit"（调用方显式给出，默认）/ "env:SPARK_ACTOR" / "env:USER" / "unknown"。
  // 审计时用于分清「显式署名」与「取自环境」。
  actorSource?: string;
  note?: string;
}

export interface RejectInput {
  actor: string;
  actorSource?: string;
  reason: string;
}

function emptyWetMeta(input: {
  backend: string;
  naturalLanguage: string;
  hypothesis: string | null;
  iteration: number;
  parentExperimentId: string | null;
  derivedFromDryExperimentId: string | null;
  at: string;
}): WetExperimentMeta {
  return {
    kind: "experiment",
    mode: "wet",
    state: "design",
    backend: input.backend,
    naturalLanguage: input.naturalLanguage,
    hypothesis: input.hypothesis,
    protocolId: null,
    protocolName: null,
    protocolHash: null,
    apiLevel: null,
    robotType: null,
    deck: [],
    compiledSteps: [],
    compileWarnings: [],
    safetyChecks: [],
    safetyPassed: null,
    approval: null,
    rejection: null,
    runId: null,
    runDir: null,
    attempts: 0,
    iteration: input.iteration,
    parentExperimentId: input.parentExperimentId,
    derivedFromDryExperimentId: input.derivedFromDryExperimentId,
    history: [],
    timestamps: { design: input.at },
    summary: null,
    runLogEntryCount: null,
    artifactRecordIds: [],
    observationId: null,
    conclusionId: null,
    lastError: null,
  };
}

export class WetLabLoop {
  private readonly records: RecordStore;
  private readonly artifacts: ArtifactStore;
  private readonly root: string;
  private readonly backend: WetLabBackend;
  private readonly compiler: ProtocolCompiler;
  private readonly projectSlug: string;
  private readonly sessionId: string | null;
  private readonly now: () => string;

  constructor(options: WetLabLoopOptions) {
    this.records = options.records;
    this.artifacts = options.artifacts;
    this.root = options.root;
    this.backend = options.backend ?? wetBackend(DEFAULT_WET_BACKEND);
    this.compiler = options.compiler ?? new ProtocolCompiler();
    this.projectSlug = options.projectSlug ?? options.records.project;
    this.sessionId = options.sessionId ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get backendId(): string {
    return this.backend.id;
  }

  async available() {
    return this.backend.available();
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  list(filter: { state?: WetExperimentState } = {}): WetExperimentView[] {
    return this.records
      .list({ type: "experiment" })
      .filter((record) => (record.metadata as { mode?: string }).mode === "wet")
      .map((record) => this.toView(record))
      .filter((view) => (filter.state ? view.state === filter.state : true));
  }

  // 支持 id 前缀（与 P5 的 exp 一致）；前缀歧义时报错而不是猜。
  get(ref: string): WetExperimentView {
    const exact = this.records.get(ref);
    if (exact && exact.type === "experiment" && (exact.metadata as { mode?: string }).mode === "wet") {
      return this.toView(exact);
    }
    const matches = this.records
      .list({ type: "experiment" })
      .filter((r) => (r.metadata as { mode?: string }).mode === "wet")
      .filter((r) => r.id.startsWith(ref));
    if (matches.length === 1) return this.toView(matches[0]!);
    if (matches.length > 1) {
      throw new WetExperimentNotFoundError(
        `${ref}（前缀命中 ${matches.length} 条：${matches.map((m) => m.id.slice(0, 12)).join(", ")}）`,
      );
    }
    throw new WetExperimentNotFoundError(ref);
  }

  // ── design ────────────────────────────────────────────────────────────────

  design(input: WetDesignInput): WetExperimentView {
    if (!input.naturalLanguage.trim()) {
      throw new Error("湿实验必须给出自然语言协议原文——没有原文就无从审计编译对不对");
    }
    const at = this.now();
    const meta = emptyWetMeta({
      backend: this.backend.id,
      naturalLanguage: input.naturalLanguage.trim(),
      hypothesis: input.hypothesis ?? null,
      iteration: 1,
      parentExperimentId: null,
      derivedFromDryExperimentId: input.derivedFromDryExperimentId ?? null,
      at,
    });
    const view = this.createRecord(input.title, meta, input.sessionId ?? this.sessionId);
    if (input.derivedFromDryExperimentId) {
      // 干湿闭环：湿实验从干实验的结论派生 → `derives_from` 边（P5 已定的方向口径）。
      this.records.link(view.id, input.derivedFromDryExperimentId, "derives_from");
    }
    return this.get(view.id);
  }

  // 干湿闭环接通点（DESIGN 域 B3）。
  //
  // 两条路径，语义不同、边也不同：
  //   干实验在 `analyze` → 走 P5 的 iterate 语义：那条线到此为止，湿实验接棒 → `supersedes`；
  //   干实验已 `concluded` → 结论成立、要拿去湿实验验证 → `derives_from`。
  async deriveFromDry(
    dryLoop: ExperimentLoop,
    dryRef: string,
    input: Omit<WetDesignInput, "derivedFromDryExperimentId">,
  ): Promise<{ dry: { id: string; state: string }; wet: WetExperimentView }> {
    const dry = dryLoop.get(dryRef);
    if (dry.state !== "analyze" && dry.state !== "concluded") {
      throw new Error(
        `干实验 ${dry.id.slice(0, 8)} 当前状态 ${dry.state}，只有 analyze / concluded 的干实验能派生湿实验` +
          `（还没跑出观察就谈湿实验验证，验证的是什么？）`,
      );
    }
    const wet = this.design({ ...input, derivedFromDryExperimentId: dry.id });
    if (dry.state === "analyze") {
      // analyze → iterated：干线收尾，湿线接棒。supersedes 边（新 → 旧）与 P5 的 iterate 同向。
      this.records.link(wet.id, dry.id, "supersedes");
      const iterated = dryLoop.markIterated(dry.id, `派生湿实验 ${wet.id.slice(0, 8)}`);
      return { dry: { id: dry.id, state: iterated.state }, wet: this.get(wet.id) };
    }
    return { dry: { id: dry.id, state: dry.state }, wet };
  }

  // ── compile ───────────────────────────────────────────────────────────────

  // 编译自然语言协议 → Opentrons Python Protocol API v2 脚本。
  //
  // **进入 compile 一律清掉已有的 approve/reject**：重新编译意味着方案在改，
  // 旧的批准绝不能跨版本存活（AD-6）。这是「approve 后协议变了要重新走一遍」的落点。
  compile(ref: string, options: { naturalLanguage?: string } = {}): {
    view: WetExperimentView;
    program: OpentronsProgram;
  } {
    const view = this.get(ref);
    if (view.state === "wet_run" && view.runId) {
      throw new WetStateError(
        view.state,
        "compile",
        "这条实验已经执行过了，不能就地重编译——改协议请另起一条（iterate）",
      );
    }
    this.assertTransition(view.state, "compile");
    const naturalLanguage = options.naturalLanguage?.trim() || view.naturalLanguage;
    const protocol = this.compiler.compile(naturalLanguage, {
      name: view.title,
      // protocolId 固定成 record id：同一条实验重复编译得到同一个 id，
      // 从而同一份协议文本 → 同一个 protocolHash（approve 才有意义）。
      protocolId: `wet-${view.id}`,
    });
    const program = compileToOpentrons(protocol);
    const hadApproval = view.approval !== null;
    const next = this.transition(
      view,
      "compile",
      `编译出 ${program.steps.length} 步 Opentrons 协议（hash ${program.protocolHash}）` +
        (hadApproval ? "；已作废先前的 approve" : ""),
      (meta) => ({
        ...meta,
        naturalLanguage,
        protocolId: protocol.id,
        protocolName: protocol.name,
        protocolHash: program.protocolHash,
        apiLevel: program.apiLevel,
        robotType: program.robotType,
        deck: program.deck,
        compiledSteps: program.steps,
        compileWarnings: program.warnings,
        // 重新编译 = 重新走安全门 + 重新审批。两个字段一起清，不留半截状态。
        safetyChecks: [],
        safetyPassed: null,
        approval: null,
        rejection: null,
        lastError: null,
      }),
    );
    return { view: next, program };
  }

  // 把当前 record 里的编译产物重新还原成 program（execute 前的 hash 复核要用）。
  programOf(view: WetExperimentView): OpentronsProgram {
    const protocol = this.compiler.compile(view.naturalLanguage, {
      name: view.title,
      protocolId: `wet-${view.id}`,
    });
    return compileToOpentrons(protocol);
  }

  // ── safety_check ──────────────────────────────────────────────────────────

  // 安全门。通过 → `compile → safety_check → awaiting_approval`（**两条**转移都留痕：
  // 「门过了」与「停在人工确认」是两件事，证据图上要分得开）。
  // 不通过 → `compile → failed` 并抛 LabSafetyError。
  safetyCheck(ref: string): { view: WetExperimentView; report: SafetyReport } {
    const view = this.get(ref);
    this.assertTransition(view.state, "safety_check");
    const protocol: Protocol = this.compiler.compile(view.naturalLanguage, {
      name: view.title,
      protocolId: `wet-${view.id}`,
    });
    const program = compileToOpentrons(protocol);
    const report = runSafetyRules({ protocol, program });

    if (!report.passed) {
      const blocked = report.checks.filter((c) => !c.passed).map((c) => c.check);
      const failed = this.transition(view, "failed", `安全门拦截：${blocked.join(", ")}`, (meta) => ({
        ...meta,
        safetyChecks: report.checks,
        safetyPassed: false,
        lastError: `安全门拦截：${report.checks
          .filter((c) => !c.passed)
          .map((c) => `${c.check}（${c.detail ?? "无详情"}）`)
          .join("；")}`,
      }));
      void failed;
      throw new LabSafetyError(report);
    }

    const passed = this.transition(view, "safety_check", "安全门全部通过", (meta) => ({
      ...meta,
      safetyChecks: report.checks,
      safetyPassed: true,
    }));
    // AD-6：安全门通过 ≠ 自动执行。**必须**停在这里等人。
    const waiting = this.transition(
      passed,
      "awaiting_approval",
      "安全门是必要非充分条件——等人工 approve（AD-6）",
      (meta) => meta,
    );
    return { view: waiting, report };
  }

  // ── approve / reject（AD-6） ──────────────────────────────────────────────

  // **唯一**能把实验推进 `wet_run` 的动作。落一条 decision record：谁、何时、批了哪个协议 hash。
  approve(ref: string, input: ApproveInput): { view: WetExperimentView; decisionId: string } {
    const view = this.get(ref);
    if (view.state !== "awaiting_approval") {
      throw new WetStateError(
        view.state,
        "wet_run",
        "只有停在 awaiting_approval 的实验能被批准（先编译并通过安全门）",
      );
    }
    if (!view.protocolHash) {
      throw new ApprovalRequiredError("实验没有 protocolHash，无从批准——先 compile");
    }
    if (!input.actor.trim()) {
      throw new ApprovalRequiredError("approve 必须记名：谁批的是这条 decision record 的核心内容");
    }
    const at = this.now();
    const decision = this.records.create({
      type: "decision",
      title: `批准执行湿实验 · ${view.title}`,
      content: renderDecision({
        decision: "approve",
        actor: input.actor,
        at,
        protocolHash: view.protocolHash,
        experimentId: view.id,
        experimentTitle: view.title,
        steps: view.compiledSteps,
        safetyChecks: view.safetyChecks,
        reason: input.note ?? null,
      }),
      // 审批是人的判断，不是观察/计算/文献 → inferred。
      evidence: "inferred",
      origin: { kind: "manual", sessionId: this.sessionId, ref: view.id },
      metadata: {
        kind: "approval",
        decision: "approve",
        actor: input.actor,
        actorSource: input.actorSource ?? "explicit",
        at,
        protocolHash: view.protocolHash,
        experimentId: view.id,
        safetyChecks: view.safetyChecks,
        note: input.note ?? null,
      },
      createdAt: at,
    });
    this.records.link(decision.id, view.id, "derives_from");

    const next = this.transition(
      view,
      "wet_run",
      `${input.actor} 批准执行（协议 hash ${view.protocolHash}）`,
      (meta) => ({
        ...meta,
        approval: {
          decisionRecordId: decision.id,
          actor: input.actor,
          at,
          protocolHash: view.protocolHash!,
          note: input.note ?? null,
        },
        rejection: null,
      }),
    );
    return { view: next, decisionId: decision.id };
  }

  reject(ref: string, input: RejectInput): { view: WetExperimentView; decisionId: string } {
    const view = this.get(ref);
    if (view.state !== "awaiting_approval") {
      throw new WetStateError(view.state, "rejected", "只有停在 awaiting_approval 的实验能被拒绝");
    }
    if (!input.reason.trim()) {
      throw new ApprovalRequiredError("reject 必须给理由——「不批」而不说为什么，下一轮无从改起");
    }
    const at = this.now();
    const decision = this.records.create({
      type: "decision",
      title: `拒绝执行湿实验 · ${view.title}`,
      content: renderDecision({
        decision: "reject",
        actor: input.actor,
        at,
        protocolHash: view.protocolHash ?? "(未编译)",
        experimentId: view.id,
        experimentTitle: view.title,
        steps: view.compiledSteps,
        safetyChecks: view.safetyChecks,
        reason: input.reason,
      }),
      evidence: "inferred",
      origin: { kind: "manual", sessionId: this.sessionId, ref: view.id },
      metadata: {
        kind: "approval",
        decision: "reject",
        actor: input.actor,
        actorSource: input.actorSource ?? "explicit",
        at,
        protocolHash: view.protocolHash ?? null,
        experimentId: view.id,
        reason: input.reason,
      },
      createdAt: at,
    });
    this.records.link(decision.id, view.id, "derives_from");
    const next = this.transition(view, "rejected", `${input.actor} 拒绝：${input.reason}`, (meta) => ({
      ...meta,
      rejection: {
        decisionRecordId: decision.id,
        actor: input.actor,
        at,
        protocolHash: view.protocolHash ?? "",
        reason: input.reason,
      },
      approval: null,
    }));
    return { view: next, decisionId: decision.id };
  }

  // ── wet_run → collect ─────────────────────────────────────────────────────

  // 执行 + 回收。**三道门**依次守：
  //   ① 状态必须是 wet_run（唯一入口是 approve）；
  //   ② meta 里必须有 approval；
  //   ③ approval 批的 hash 必须等于当前编译产物的 hash。
  // ③ 看起来与 ① 冗余（compile 会清 approval），但它防的是状态机之外的路径：
  //    有人直接改了 record、或者两个进程并发编译。物理世界的操作值得一道冗余的锁。
  async execute(ref: string, options: { timeoutMs?: number; note?: string } = {}): Promise<WetExperimentView> {
    const view = this.get(ref);
    if (view.state !== "wet_run") {
      throw new ApprovalRequiredError(
        `实验 ${view.id.slice(0, 8)} 当前状态 ${view.state}，未经 approve 不能执行湿实验（AD-6）。` +
          `合法路径：compile → safety_check → approve → execute`,
      );
    }
    if (!view.approval) {
      throw new ApprovalRequiredError(
        `实验 ${view.id.slice(0, 8)} 处于 wet_run 但没有审批记录——拒绝执行`,
      );
    }
    const program = this.programOf(view);
    if (view.approval.protocolHash !== program.protocolHash) {
      const stale = this.transition(
        view,
        "failed",
        "协议 hash 与审批不符，拒绝执行",
        (meta) => ({
          ...meta,
          approval: null,
          lastError:
            `审批的协议 hash 是 ${view.approval!.protocolHash}，当前协议 hash 是 ${program.protocolHash}——` +
            `协议在审批之后变了。必须重新 compile → safety_check → approve。`,
        }),
      );
      throw new ApprovalRequiredError(stale.lastError!);
    }

    mkdirSync(this.root, { recursive: true });
    let result: WetRunResult;
    try {
      result = await this.backend.execute(program, { root: this.root, timeoutMs: options.timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transition(view, "failed", "湿实验执行失败", (meta) => ({
        ...meta,
        attempts: meta.attempts + 1,
        lastError: message,
      }));
      throw error;
    }

    if (result.status !== "completed") {
      this.transition(view, "failed", "模拟器拒绝执行协议", (meta) => ({
        ...meta,
        attempts: meta.attempts + 1,
        runId: result.runId,
        runDir: result.runDir,
        lastError: result.error ?? "模拟器返回 failed 但没有错误信息",
      }));
      throw new Error(
        `Opentrons 模拟执行失败（run ${result.runId}）：${result.error ?? "无错误信息"}`,
      );
    }

    const artifactRecordIds = this.ingestRun(view, result);
    return this.transition(
      view,
      "collect",
      `执行完成（${result.entries.length} 条 run log，${result.files.length} 个产出）`,
      (meta) => ({
        ...meta,
        attempts: meta.attempts + 1,
        runId: result.runId,
        runDir: result.runDir,
        summary: result.summary,
        runLogEntryCount: result.entries.length,
        artifactRecordIds,
        lastError: null,
      }),
    );
  }

  private ingestRun(view: WetExperimentView, result: WetRunResult): string[] {
    const ids: string[] = [];
    for (const file of result.files) {
      const provenance =
        `# 湿实验 ${view.title} · run ${result.runId}\n` +
        `# 后端: ${result.backend}\n` +
        `# 协议 hash: ${result.protocolHash}\n` +
        `# 审批: ${view.approval?.actor ?? "?"} @ ${view.approval?.at ?? "?"}\n` +
        `# 产出角色: ${file.role}\n`;
      const saved = this.artifacts.save(
        file.path,
        provenance,
        [
          {
            kind: "write",
            file: file.filename,
            role: "tool",
            content: `湿实验 ${result.backend} run ${result.runId} 产出（${file.role}）`,
          },
        ],
        // producingCellId = `${experimentId}:${attempt}`（与 P5 同一约定）。
        {
          sessionId: view.id,
          cellIndex: view.attempts + 1,
          runId: result.runId,
          backend: result.backend,
        },
        this.projectSlug,
      );
      const record = this.records.createFromArtifact(saved, {
        title: `${view.title} · ${file.filename}`,
        content: `湿实验 ${view.id.slice(0, 8)} 的执行产出：${file.filename}（${file.role}，${file.bytes} 字节）`,
        // 执行产出是被观察到的（run log 记录的是设备做了什么），不是算出来的。
        evidence: "observed",
        metadata: {
          kind: "wet_run_output",
          role: file.role,
          filename: file.filename,
          experimentId: view.id,
          runId: result.runId,
          backend: result.backend,
          protocolHash: result.protocolHash,
          bytes: file.bytes,
        },
      });
      this.records.link(record.id, view.id, "derives_from");
      ids.push(record.id);
    }
    return ids;
  }

  // ── analyze ───────────────────────────────────────────────────────────────

  // 产出 observation record，`evidence=observed`（DEVELOPMENT_PLAN P6 的明确要求）：
  // 这是**执行后被观察到的**结果，不是计算出来的。模拟器执行同样算 observed，
  // 但正文里明写「硬件为模拟」——数据来源必须能被读图的人分辨。
  analyze(ref: string, options: { note?: string; sessionId?: string | null } = {}): WetExperimentView {
    const view = this.get(ref);
    this.assertTransition(view.state, "analyze");
    const entries = this.readRunLog(view);
    const stepTrace = this.stepTrace(view, entries);
    const readings = entries
      .filter((e) => e.type === "read_result")
      .map((e) => ({ stepId: e.stepId ?? null, reading: e.reading ?? null }));

    const observation = this.records.create({
      type: "observation",
      title: `${view.title} · 观察`,
      content: renderWetObservation({
        title: view.title,
        backend: view.backend,
        protocolHash: view.protocolHash ?? "(未知)",
        summary: view.summary ?? {},
        stepTrace,
        readings,
        note: options.note ?? null,
      }),
      evidence: "observed",
      origin: {
        kind: "cell",
        sessionId: options.sessionId ?? this.sessionId,
        ref: view.runId ? `${view.id}:${view.runId}` : view.id,
      },
      metadata: {
        kind: "wet_run_observation",
        experimentId: view.id,
        runId: view.runId,
        backend: view.backend,
        protocolHash: view.protocolHash,
        simulated: view.backend !== "physical_device",
        summary: view.summary ?? {},
        stepTrace,
        readings,
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

  // run log 从 **artifact 存储里的 runlog.json** 读回来（不留在内存里）：
  // 与 P5 「状态真源在磁盘」同一条纪律——重启进程照样能 analyze。
  private readRunLog(view: WetExperimentView): WetRunLogEntry[] {
    for (const recordId of view.artifactRecordIds) {
      const record = this.records.get(recordId);
      if (!record) continue;
      const meta = record.metadata as { filename?: string };
      if (meta.filename !== "runlog.json" || !record.artifactId) continue;
      const artifact = this.artifacts.get(record.artifactId);
      if (!artifact) continue;
      try {
        const parsed = JSON.parse(artifact.content) as { entries?: WetRunLogEntry[] };
        return parsed.entries ?? [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private stepTrace(
    view: WetExperimentView,
    entries: WetRunLogEntry[],
  ): Array<{ stepId: string; action: string; entries: number }> {
    return view.compiledSteps.map((step) => ({
      stepId: step.stepId,
      action: step.action,
      // 不含 step_marker 本身：数的是「这一步真的做了几件事」。
      entries: entries.filter((e) => e.stepId === step.stepId && e.type !== "step_marker").length,
    }));
  }

  // ── conclude / iterate ────────────────────────────────────────────────────

  conclude(
    ref: string,
    options: { claim?: string; limitations?: string; confidence?: string; sessionId?: string | null } = {},
  ): WetExperimentView {
    const view = this.get(ref);
    this.assertTransition(view.state, "concluded");
    let conclusionId: string | null = null;
    if (options.claim) {
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
          // 湿实验同样不给自己发通过证（P5 D10 同一口径，完整门槛在域 E2/P8）。
          review: "pending",
          experimentId: view.id,
          observationId: view.observationId,
          mode: "wet",
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

  // 改协议另起一条：新 record 走 supersedes 边连回旧的，旧的转入终态 iterated。
  iterate(
    ref: string,
    options: { naturalLanguage: string; title?: string; hypothesis?: string; note?: string },
  ): { previous: WetExperimentView; next: WetExperimentView } {
    const view = this.get(ref);
    this.assertTransition(view.state, "iterated");
    if (options.naturalLanguage.trim() === view.naturalLanguage.trim()) {
      throw new Error("iterate 的协议与上一轮完全相同——那是重跑不是迭代");
    }
    const at = this.now();
    const meta = emptyWetMeta({
      backend: this.backend.id,
      naturalLanguage: options.naturalLanguage.trim(),
      hypothesis: options.hypothesis ?? view.hypothesis,
      iteration: view.iteration + 1,
      parentExperimentId: view.id,
      derivedFromDryExperimentId: view.derivedFromDryExperimentId,
      at,
    });
    const next = this.createRecord(
      options.title ?? `${view.title}（第 ${view.iteration + 1} 轮）`,
      meta,
      this.sessionId,
    );
    this.records.link(next.id, view.id, "supersedes");
    const previous = this.transition(
      view,
      "iterated",
      options.note ?? `迭代出新湿实验 ${next.id.slice(0, 8)}`,
      (m) => m,
    );
    return { previous, next: this.get(next.id) };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private createRecord(title: string, meta: WetExperimentMeta, sessionId: string | null): WetExperimentView {
    const record = this.records.create({
      type: "experiment",
      title,
      content: "",
      // 实验设计是推出来的；执行产出的 observation 才是 observed。
      evidence: "inferred",
      origin: { kind: "session", sessionId, ref: null },
      metadata: meta as unknown as Record<string, unknown>,
    });
    const view = this.toView(record);
    this.records.update(record.id, { content: renderWetExperiment(view) });
    return this.toView(this.records.get(record.id)!);
  }

  private assertTransition(from: WetExperimentState, to: WetExperimentState): void {
    if (!canWetTransition(from, to)) throw new WetStateError(from, to);
  }

  private transition(
    view: WetExperimentView,
    to: WetExperimentState,
    note: string | null,
    patch: (meta: WetExperimentMeta) => WetExperimentMeta,
  ): WetExperimentView {
    this.assertTransition(view.state, to);
    const at = this.now();
    const entry: WetTransitionEntry = { from: view.state, to, at, note };
    const { id: _id, title: _title, createdAt: _createdAt, record: _record, ...base } = view;
    const next: WetExperimentMeta = {
      ...patch(base as WetExperimentMeta),
      state: to,
      history: [...view.history, entry],
      timestamps: { ...view.timestamps, [to]: at },
    };
    const nextView: WetExperimentView = {
      ...next,
      id: view.id,
      title: view.title,
      createdAt: view.createdAt,
      record: view.record,
    };
    const updated = this.records.update(view.id, {
      content: renderWetExperiment(nextView),
      metadata: next as unknown as Record<string, unknown>,
    });
    return this.toView(updated);
  }

  private toView(record: ResearchRecord): WetExperimentView {
    const meta = record.metadata as Partial<WetExperimentMeta>;
    const state = isWetExperimentState(meta.state) ? meta.state : "design";
    return {
      kind: "experiment",
      mode: "wet",
      state,
      backend: String(meta.backend ?? this.backend.id),
      naturalLanguage: String(meta.naturalLanguage ?? ""),
      hypothesis: meta.hypothesis ?? null,
      protocolId: meta.protocolId ?? null,
      protocolName: meta.protocolName ?? null,
      protocolHash: meta.protocolHash ?? null,
      apiLevel: meta.apiLevel ?? null,
      robotType: meta.robotType ?? null,
      deck: meta.deck ?? [],
      compiledSteps: meta.compiledSteps ?? [],
      compileWarnings: meta.compileWarnings ?? [],
      safetyChecks: meta.safetyChecks ?? [],
      safetyPassed: meta.safetyPassed ?? null,
      approval: meta.approval ?? null,
      rejection: meta.rejection ?? null,
      runId: meta.runId ?? null,
      runDir: meta.runDir ?? null,
      attempts: Number(meta.attempts ?? 0),
      iteration: Number(meta.iteration ?? 1),
      parentExperimentId: meta.parentExperimentId ?? null,
      derivedFromDryExperimentId: meta.derivedFromDryExperimentId ?? null,
      history: meta.history ?? [],
      timestamps: meta.timestamps ?? {},
      summary: (meta.summary as Record<string, WetSummaryValue> | null) ?? null,
      runLogEntryCount: meta.runLogEntryCount ?? null,
      artifactRecordIds: meta.artifactRecordIds ?? [],
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

export {
  WET_EXPERIMENT_STATES,
  WET_LEGAL_TRANSITIONS,
  canWetTransition,
  isWetExperimentState,
  ApprovalRequiredError,
  WetStateError,
  WetExperimentNotFoundError,
} from "./wet_models";
export type { WetExperimentState, WetExperimentView, WetExperimentMeta } from "./wet_models";
