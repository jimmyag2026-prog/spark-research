import { ComputeApproval, ApprovalRequiredError } from "./approval";
import {
  ComputeAdmissionError,
  ComputeBroker,
  ComputeDispatchConflictError,
  ComputeEvidenceRecorder,
  NULL_PRICING,
  UnknownTargetError,
  ensureComputeRoot,
} from "./broker";
import { ComputeJobStore, UnknownComputeJobError, type ComputeJobView } from "./job_store";
import {
  ComputeStateError,
  EXECUTION_STATES,
  isExecutionTerminal,
  type ExecutionState,
} from "./lifecycle";
import { PlanValidationError, type PlanInput } from "./plan";
import { TARGET_KINDS, type ComputeAdapter, type TargetKind, type TargetRef } from "./target";
import {
  UPLOAD_BYTES_LIMIT,
  UPLOAD_COUNT_LIMIT,
  UploadChangedError,
  UploadDeniedError,
  UploadLimitError,
  collectUploads,
} from "./uploads";
import { LocalComputeAdapter } from "./adapters/local";
// 收口(W5-2)：接上 lane α 的 Modal adapter（β 写这段时它还不存在）。
import {
  MODAL_CONNECTOR_ID,
  MODAL_REQUIRED_CREDENTIAL_KEYS,
  ModalComputeAdapter,
  type ModalStatusReport,
} from "./adapters/modal";
import {
  ApprovalGateError,
  COMPUTE_APPROVAL_GATE,
  mergeApprovalNote,
  requireApprovalGate,
} from "../approval/gate";
import { configuredComputeTarget, configuredModalEnvironment } from "../config";
import type { CredentialProvider } from "../connectors/base";
import { CredentialStore } from "../daemon/credentials";
import { ProjectError, ProjectManager, type Project } from "../project/manager";

// `spark-research compute ...` 子命令（CB-5 接线，设计 §1.1.8）。
//
// ── 这个文件是「接线」，不是「实现」 ───────────────────────────────────────
//
// 算力层的全部语义（三轴状态机、审批一次性消费、上传重验、admission）都在
// `compute/{lifecycle,plan,approval,job_store,uploads,broker}.ts` 里，W5-1 α 已经交付。
// 本文件只做三件事：解析参数、构造 broker、把结果打印出来。
//
// **本文件里没有、也不许有任何一条「跳过审批」的路径**：broker 不提供 force 参数、
// dispatch 只有两条入边（L-2），所以「无审批派发」在结构上没有落脚点。如果接线时
// 发现需要一个后门才能跑通，那是接法有问题，不是契约有问题——后门会活到生产（K-2）。
//
// 审批门（TTY）走 `approval/gate.ts`：与 `lab approve` **同一份代码**，只是旁路 env
// 名不同（`SPARK_RESEARCH_COMPUTE_CI_BYPASS_TOKEN`）——配了 CI 能批湿实验的流水线，
// 不该顺带获得「花钱跑 GPU」的权限。

export const COMPUTE_HELP = `用法:
  spark-research compute targets [--json]
                                 列出执行地及其可用性（local / modal / ssh）
  spark-research compute plan --purpose "<干什么>" [选项] -- <argv...>
                                 生成一份**待审批**的算力计划（零副作用：不建远端资源、不解析凭据）。
                                 命令写在 \`--\` 之后，按 argv 传（**不是 shell 字符串**：
                                 被审批的东西不该再经过一次 shell 展开）。
      --target local|modal       执行地（默认取 config 的 computeTarget，代码默认 local）
      --upload <相对路径>         要带上去的文件/目录，可重复（deny-list + gitignore + 双限额）
      --output <glob>            要收割回来的产物，可重复
      --env K=V                  非密钥环境变量，可重复（密钥样 key 一律拒）
      --secret <符号名>           密钥引用，可重复（值永不进 plan/job）
      --gpu <型号>                GPU 型号；--cpus/--memory-gb/--timeout 资源上限
      --network none|unrestricted 默认 none
      --workspace <目录>          上传的根目录（默认当前目录）
  spark-research compute approve <jobId> [--actor 谁] [--note 备注] [--run] [--json]
                                 人工批准（AD-6 同构）。落 decision record，记 plan digest。

  什么时候需要审批（S4：外部验收反映这条到处都没写）：
    审批门**按后果开**，不是无条件开。以下三者任一成立就停在 awaiting_approval：
      · 计费（billable，如 target=modal）
      · 联网（--network 不是 none）
      · 用到密钥（--secret）
    三者都不成立（典型是 target=local + network=none + 无 secret）→ 直接 planned，
    可以直接 compute run。plan 的输出会明说走哪条，不用自己推。
                                 **必须来自真实交互终端**（会现场要求输入 'yes'）；
                                 非交互环境（脚本/CI/Bash 工具）默认拒绝，除非同时给出
                                 --ci-bypass-token <与 SPARK_RESEARCH_COMPUTE_CI_BYPASS_TOKEN 一致>
                                 与 --ci-bypass-reason "<理由>"（旁路会写进 decision record）。
                                 --run：批准后顺带派发（审批在这一次里被一次性消费）
  spark-research compute reject <jobId> --reason <理由> [--actor 谁] [--json]
                                 人工拒绝。同样落 decision record，同样受终端门约束
  spark-research compute run <jobId> [--json]
                                 派发已批准的任务（消费 approval → 执行到终态）
  spark-research compute status <jobId> [--json]
                                 三轴状态 + approval/consumedApproval/supersededApproval 三段
  spark-research compute list [--state <execution 状态>] [--json]
  spark-research compute collect <jobId> [--json]
                                 收割产物到 <job>/harvest/（delivery: pending → complete）
  spark-research compute recover <jobId> [--json]
                                 编排进程被杀之后接回这个任务（读 job.json + 问 adapter）。
                                 接不回来的会**如实**标 failed 并说清产物在哪儿，不假装成功
  spark-research compute cancel <jobId> [--json]
  spark-research compute release <jobId> [--discard "<放弃产物的理由>"] [--json]
                                 释放远端资源。产物只剩远端那一份时（recoverable）会被拒——
                                 先 collect，或用 --discard 显式放弃
`;

export interface ComputeCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** 测试注入：整套 broker（含 jobs/approval），不走默认构造。 */
  brokerFor?: (project: Project) => ComputeScope;
  /** 测试注入：只换 adapter 注册表（默认只有 local）。 */
  adapters?: Partial<Record<TargetKind, ComputeAdapter>>;
  credentials?: CredentialProvider;
  actor?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** V19 终端门探测（省略 = 真实 isTTY 探测）。 */
  approvalIsInteractiveTty?: () => boolean;
  approvalConfirm?: (prompt: string) => Promise<string | null>;
}

export interface ComputeScope {
  broker: ComputeBroker;
  jobs: ComputeJobStore;
  approval: ComputeApproval;
}

/**
 * 默认 adapter 注册表。
 *
 * **收口(W5-2)接上了 modal**：β 与 α 并行，β 写这段时 `compute/adapters/modal.ts`
 * 还不存在，所以它只注册了 local 并留言「α 落地后在这里加一行即可」。这里就是那一行。
 *
 * ⚠️ 但**不能只加这一行**：β 原来的判定是「有 adapter + 配了凭据 → available」，
 * 而 α 的 adapter 因为真实 gateway 还没实现，`status().transport` 是 `not_wired`。
 * 只注册不改判定 → 配了 token 就会报「modal 可用」，**正是 AD-12 禁止的形状**。
 * 所以 `computeTargetViews()` 改成**问 adapter 自己的 status()**，不再自己猜。
 * 两条 lane 各自都对，合起来才会说谎——这类缺陷只在收口暴露。
 *
 * 判定仍然只来自运行期读凭据与 config（§三·补.7 约束一）：没有任何编译期常量参与。
 */
export function defaultComputeAdapters(deps: {
  credentials?: CredentialProvider;
  root?: string;
  env?: Record<string, string | undefined>;
} = {}): Partial<Record<TargetKind, ComputeAdapter>> {
  const credentials = deps.credentials ?? new CredentialStore({ root: deps.root });
  return {
    local: new LocalComputeAdapter(),
    modal: new ModalComputeAdapter({
      credentials,
      config: () => ({ environment: configuredModalEnvironment(null, { root: deps.root, env: deps.env }) }),
    }),
  };
}

/**
 * Modal 凭据在 `credentials.json` 的 `connectors.modal`（设计 §1.1.10，复用 CredentialStore）。
 *
 * 收口(W5-2)：改成从 adapter 那边 re-export，**不再在这里另写一份**。
 * 原因是收口时真抓到了：β 照设计文档写 `token_id`/`token_secret`，
 * α 照 Modal SDK 的 `ModalClientParams` 写 `tokenId`/`tokenSecret`——两边对不上，
 * 后果是**用户照提示填完，adapter 永远报「未配置」**。
 * 同一件事两份手写副本，这是 V34/V37 同一种病，所以按同样的办法治：只留一个真源。
 */
export const MODAL_CREDENTIAL_ID = MODAL_CONNECTOR_ID;

export const MODAL_SETUP_HINT =
  `把 Modal token 写进 ~/.spark-research/credentials.json 的 connectors.${MODAL_CONNECTOR_ID} ` +
  // 字段名从 adapter 的真源派生：手写一份就会和真正读它的代码漂开（收口实测踩到过）。
  `（${MODAL_REQUIRED_CREDENTIAL_KEYS.join(" / ")}，文件 0600），再 \`spark-research config set computeTarget modal\`。` +
  "凭据永不进 plan/job/record。";

export type ComputeTargetAvailability = "available" | "needs_credential" | "placeholder" | "unavailable";

export interface ComputeTargetView {
  kind: TargetKind;
  description: string;
  availability: ComputeTargetAvailability;
  reason: string | null;
  /** modal: 有没有配凭据；local/ssh: null（它们不需要凭据）。 */
  credentialConfigured: boolean | null;
  billable: boolean;
  persistentVolume: boolean;
  recovery: boolean;
  uploadLimits: { count: number; bytes: number };
  isDefault: boolean;
  /** 未配置时的**配置指引**（V36 的质量要求）：说清楚缺什么、怎么补。 */
  setupHint: string | null;
}

/**
 * 执行地的可用性口径。**CLI / HTTP / capabilities 三处共用这一份**——
 * 这三个面各自手写一遍判定，就是 V34「默认源」与二进制「技能 0 个」那类漂移的成因。
 *
 * 三条不许违反的口径（§三·补.7 约束二）：
 *   ① 没配 Modal 凭据 = **未配置**（needs_credential），不是「不可用」也不是「可用」；
 *   ② 注册表里没有 adapter 就**永远不许**报 available——哪怕凭据配好了；
 *   ③ ssh 恒 placeholder（schema 已定、adapter 明确不建）。
 */
export function computeTargetViews(options: {
  adapters: Partial<Record<TargetKind, ComputeAdapter>>;
  credentials: Pick<CredentialProvider, "has">;
  defaultTarget?: string;
}): ComputeTargetView[] {
  const defaultTarget = options.defaultTarget ?? "local";
  return TARGET_KINDS.map((kind) => {
    const adapter = options.adapters[kind];
    const caps = adapter?.capabilities() ?? null;
    const base = {
      kind,
      description: adapter?.description ?? DEFAULT_TARGET_DESCRIPTIONS[kind],
      credentialConfigured: kind === "modal" ? options.credentials.has(MODAL_CREDENTIAL_ID) : null,
      billable: caps?.billable ?? kind === "modal",
      persistentVolume: caps?.persistentVolume ?? kind === "modal",
      recovery: caps?.recovery ?? false,
      uploadLimits: caps?.uploadLimits ?? { count: UPLOAD_COUNT_LIMIT, bytes: UPLOAD_BYTES_LIMIT },
      isDefault: kind === defaultTarget,
    };

    if (kind === "ssh") {
      return {
        ...base,
        availability: "placeholder" as const,
        reason: "v0.5 只留槽位：SshHost schema 与校验已定，adapter 明确不建",
        setupHint: null,
      };
    }
    if (kind === "modal") {
      // 收口(W5-2)：**adapter 在场时，一切非可用情形都由它的 status() 说了算**。
      // 放在凭据分支之前，是因为「没配凭据」和「真实 gateway 没实现」会同时成立——
      // 只报前者的话，用户会去申请 token、填上、然后才发现还是跑不起来。
      // 一次把两件事都说清楚，才是 V19/V36 要求的那种「失败消息给下一步」。
      const modalReport = adapter && typeof (adapter as { status?: unknown }).status === "function"
        ? (adapter as unknown as { status: () => ModalStatusReport }).status()
        : null;
      if (modalReport && modalReport.availability !== "available") {
        return {
          ...base,
          credentialConfigured: modalReport.credentialConfigured,
          availability: modalReport.availability,
          reason: modalReport.reason,
          setupHint: modalReport.howToConfigure.length > 0 ? modalReport.howToConfigure.join("\n") : MODAL_SETUP_HINT,
        };
      }
      if (base.credentialConfigured !== true) {
        return {
          ...base,
          availability: "needs_credential" as const,
          // 「未配置」≠「不可用」：能力在，只是没凭据（和 openmm 没装是两回事）。
          reason: "未配置 Modal 凭据（credentials.json 的 connectors.modal 里没有条目）",
          setupHint: MODAL_SETUP_HINT,
        };
      }
      if (!adapter) {
        return {
          ...base,
          availability: "unavailable" as const,
          reason:
            "凭据已配置，但本版本没有装载 Modal adapter——算力抽象层与审批链已落地并有 local 实现，" +
            "Modal adapter 的契约已立、真实链路未验证（不要读成「支持 Modal 远端算力」）",
          setupHint: null,
        };
      }
      return { ...base, availability: "available" as const, reason: null, setupHint: null };
    }
    // local
    if (!adapter) {
      return {
        ...base,
        availability: "unavailable" as const,
        reason: "注册表里没有 local adapter（构造 broker 时被显式排除）",
        setupHint: null,
      };
    }
    return { ...base, availability: "available" as const, reason: null, setupHint: null };
  });
}

const DEFAULT_TARGET_DESCRIPTIONS: Record<TargetKind, string> = {
  local: "本机子进程（零凭据、不计费）",
  modal: "Modal 云端沙箱（计费；需要 token）",
  ssh: "自有 SSH 主机（v0.5 只留槽位）",
};

// ── 参数解析 ────────────────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  /** 单值 flag（后出现的覆盖先出现的）。 */
  flags: Record<string, string | true>;
  /** 可重复 flag 的全部取值，按出现顺序。 */
  repeated: Record<string, string[]>;
  /** 裸 `--` 之后的全部内容：被审批的 argv，**不做任何再解析**。 */
  argv: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const repeated: Record<string, string[]> = {};
  let argv: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      argv = args.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && next !== "--" && !next.startsWith("--")) {
      flags[name] = next;
      (repeated[name] ??= []).push(next);
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags, repeated, argv };
}

function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function flagInt(value: string | true | undefined, fallback: number, label: string): number {
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new PlanValidationError(`${label} 必须是正整数，收到 '${value}'`);
  return n;
}

function flagNumber(value: string | true | undefined, fallback: number, label: string): number {
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new PlanValidationError(`${label} 必须是正数，收到 '${value}'`);
  return n;
}

function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new PlanValidationError(`--env 必须写成 K=V，收到 '${pair}'`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

function parseTarget(
  raw: string | undefined,
  modalEnvironment: string | null,
): TargetRef {
  const kind = raw ?? "local";
  if (kind === "local") return { kind: "local" };
  if (kind === "modal") return modalEnvironment ? { kind: "modal", environment: modalEnvironment } : { kind: "modal" };
  if (kind === "ssh") {
    throw new PlanValidationError("target 'ssh' 在 v0.5 只有 schema 槽位，没有 adapter——不能派发");
  }
  throw new PlanValidationError(`未知 target '${kind}'（可选：${TARGET_KINDS.join(" / ")}）`);
}

// ── broker 构造 ─────────────────────────────────────────────────────────────

export function openComputeScope(project: Project, deps: ComputeCliDeps = {}): ComputeScope {
  if (deps.brokerFor) return deps.brokerFor(project);
  const jobs = new ComputeJobStore(ensureComputeRoot(project.paths.experimentsDir));
  const approval = new ComputeApproval({ records: project.records(), jobs });
  const credentials = deps.credentials ?? new CredentialStore({ root: deps.root });
  const broker = new ComputeBroker({
    jobs,
    adapters: deps.adapters ?? defaultComputeAdapters(),
    approval,
    credentials,
    // 单价查不到就是 null（PRICING 纪律）。**绝不填 0**——0 会被读成「这次真的免费」。
    pricing: NULL_PRICING,
    // S2（W5-3 α）：算力产出进证据图。**这一行是 CLI 与 HTTP 共同的接线点**——
    // 两个入口都经过 openComputeScope()，所以证据不会只在其中一条路上出现。
    // 没有它，一次成功的 execution 会在 `report stats` 里留下一整排零（W5-2 末验收实测）。
    evidence: new ComputeEvidenceRecorder({ records: project.records(), artifacts: project.artifacts(), projectSlug: project.slug }),
  });
  return { broker, jobs, approval };
}

function resolveActor(deps: ComputeCliDeps, flag: string | undefined): { actor: string; source: string } {
  // 与 lab CLI 同一口径：落到 $USER 是诚实的（**就是**这个人在这台机器上敲的命令），
  // 但 source 要记下来，审计时能分清「显式署名」与「取自环境」。
  const env = deps.env ?? process.env;
  if (flag) return { actor: flag, source: "explicit" };
  if (deps.actor) return { actor: deps.actor, source: "explicit" };
  if (env.SPARK_ACTOR) return { actor: env.SPARK_ACTOR, source: "env:SPARK_ACTOR" };
  if (env.USER) return { actor: env.USER, source: "env:USER" };
  return { actor: "unknown", source: "unknown" };
}

// ── 呈现 ────────────────────────────────────────────────────────────────────

export function jobJson(job: ComputeJobView): Record<string, unknown> {
  return {
    jobId: job.jobId,
    projectSlug: job.projectSlug,
    experimentId: job.experimentId,
    target: job.target,
    lifecycle: job.lifecycle,
    rev: job.rev,
    approval: job.approval,
    consumedApproval: job.consumedApproval,
    supersededApproval: job.supersededApproval,
    rejection: job.rejection,
    adapterHandle: job.adapterHandle,
    createdAt: job.createdAt,
    dispatchedAt: job.dispatchedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    message: job.message,
    actualCostUsd: job.actualCostUsd,
    jobDir: job.jobDir,
    plan: job.plan,
  };
}

function printJob(job: ComputeJobView, out: (line: string) => void): void {
  const l = job.lifecycle;
  out(`[${job.jobId}] ${job.plan.purpose}`);
  out(`    execution=${l.execution} · delivery=${l.delivery} · resource=${l.resource} · recoverable=${l.recoverable}`);
  out(`    执行地 ${job.plan.target.kind} · digest ${job.plan.digest.slice(0, 12)} · rev ${job.rev}`);
  out(`    命令 ${JSON.stringify(job.plan.command)}`);
  out(
    `    上传 ${job.plan.uploads.length} 个 / ${job.plan.uploadBytes} 字节 · 产物 ${
      job.plan.outputs.length ? job.plan.outputs.join(", ") : "（无）"
    }`,
  );
  out(`    ⚠️  ${job.plan.warning}`);
  if (job.approval) {
    out(`    ✅ ${job.approval.actor} @ ${job.approval.at} 批准 ${job.approval.planDigest.slice(0, 12)}（未消费）`);
  }
  if (job.consumedApproval) {
    out(
      `    🔒 已消费的审批：${job.consumedApproval.actor} @ ${job.consumedApproval.at}` +
        `（decision ${job.consumedApproval.decisionRecordId.slice(0, 8)}）`,
    );
  }
  if (job.supersededApproval) {
    out(`    ♻️  已作废的审批：${job.supersededApproval.actor} @ ${job.supersededApproval.at}（plan 变过）`);
  }
  if (job.rejection) out(`    ❌ ${job.rejection.actor} 拒绝：${job.rejection.reason}`);
  if (job.exitCode !== null) out(`    exit=${job.exitCode}`);
  if (job.actualCostUsd !== null) out(`    实际花费 $${job.actualCostUsd}`);
  // message 在 plan 阶段就等于 warning（broker 把它抄进去了），别打印两遍。
  if (job.message && job.message !== job.plan.warning) out(`    ${job.message}`);
}

/** plan 之后给人的下一步——把人拉回环里，不让调用方自己发明「可以跑了」。 */
export function nextActionFor(job: ComputeJobView): string {
  if (job.lifecycle.execution === "awaiting_approval") {
    return `等待人工审批：spark-research compute approve ${job.jobId} --run`;
  }
  if (job.lifecycle.execution === "approved") return `spark-research compute run ${job.jobId}`;
  if (job.lifecycle.execution === "planned") return `spark-research compute run ${job.jobId}（这份 plan 无需审批）`;
  // 收割是**另一步**（L-5）：执行到终态之后 delivery 还是 none，产物仍只在远端那一份。
  // 有 adapterHandle 才谈得上收割——rejected / 从未派发的任务没有可收的东西。
  if (
    job.adapterHandle &&
    isExecutionTerminal(job.lifecycle.execution) &&
    (job.lifecycle.delivery === "none" || job.lifecycle.delivery === "pending" || job.lifecycle.delivery === "failed")
  ) {
    return `spark-research compute collect ${job.jobId}`;
  }
  if (job.lifecycle.delivery === "complete" && job.lifecycle.resource !== "closed") {
    return `spark-research compute release ${job.jobId}`;
  }
  return `spark-research compute status ${job.jobId}`;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

export async function runComputeCommand(args: string[], deps: ComputeCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const env = deps.env ?? process.env;
  const [sub, ...rest] = args;
  const { positional, flags, repeated, argv } = parseArgs(rest);
  const json = flags.json === true;

  let project: Project | null = null;
  try {
    switch (sub) {
      case "targets": {
        const views = computeTargetViews({
          adapters: deps.adapters ?? defaultComputeAdapters(),
          credentials: deps.credentials ?? new CredentialStore({ root: deps.root }),
          defaultTarget: configuredComputeTarget("local", { root: deps.root, env }),
        });
        if (json) {
          out(JSON.stringify({ targets: views }, null, 2));
        } else {
          out("执行地：");
          for (const t of views) {
            out(
              `  ${t.availability === "available" ? "✅" : t.availability === "needs_credential" ? "🔑" : "·"} ` +
                `${t.kind}${t.isDefault ? "（默认）" : ""} — ${t.description}`,
            );
            out(`      可用性 ${t.availability}${t.reason ? ` · ${t.reason}` : ""}`);
            if (t.setupHint) out(`      配置指引：${t.setupHint}`);
          }
        }
        return 0;
      }

      case "plan": {
        const purpose = flagString(flags.purpose);
        if (!purpose || argv.length === 0) {
          err("用法: spark-research compute plan --purpose \"<干什么>\" [选项] -- <argv...>");
          err("（命令必须写在裸 `--` 之后，按 argv 传：被审批的东西不该再经过一次 shell 展开）");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const workspaceRoot = flagString(flags.workspace) ?? deps.cwd ?? process.cwd();
        const scan = collectUploads(workspaceRoot, repeated.upload ?? []);
        const network = (flagString(flags.network) ?? "none") as "none" | "unrestricted";
        if (network !== "none" && network !== "unrestricted") {
          throw new PlanValidationError(`--network 只能是 none 或 unrestricted，收到 '${network}'`);
        }
        const input: PlanInput = {
          target: parseTarget(
            flagString(flags.target) ?? configuredComputeTarget("local", { root: deps.root, env }),
            configuredModalEnvironment(null, { root: deps.root, env }),
          ),
          purpose,
          command: argv,
          env: parseEnvPairs(repeated.env ?? []),
          image: null,
          secretRefs: repeated.secret ?? [],
          resources: {
            gpu: flagString(flags.gpu) ?? null,
            cpus: flagInt(flags.cpus, 1, "--cpus"),
            memoryGb: flagNumber(flags["memory-gb"], 1, "--memory-gb"),
            timeoutMinutes: flagInt(flags.timeout, 30, "--timeout"),
          },
          network,
          uploads: scan.entries,
          outputs: repeated.output ?? [],
          workspaceRoot,
        };
        const job = await scope.broker.plan(input, { projectSlug: project.slug });
        if (json) {
          out(JSON.stringify({ job: jobJson(job), skippedUploads: scan.skipped, next: nextActionFor(job) }, null, 2));
        } else {
          // S3（W5-2 末外部验收）：**人类输出必须打印目标项目**。
          // 验收者建完新项目后直接 plan，任务静默落进了一个他从没打开过的既有项目——
          // 因为 `project new` 不切当前项目、`compute plan` 又不说自己写到哪儿去了。
          // 对照：同一个 CLI 的 `lit add` 就打印「✅ 已入库（项目 xxx）」。
          // 一个把「可审计证据链」当核心卖点的产品，**证据静默落进错误项目而用户收不到任何信号**
          // 是直接的信任损伤。
          out(`📋 已生成算力计划（项目 ${job.projectSlug}）（零副作用：没有建任何远端资源，也没有解析任何凭据）`);
          printJob(job, out);
          for (const s of scan.skipped) out(`    ↷ 跳过 ${s.path}（${s.reason}）`);
          out(`下一步：${nextActionFor(job)}`);
          // S4：把「为什么这次不用审批」直接印出来。验收者读 llms.txt 以为审批门无条件在，
          // 结果 local 任务直接 planned，摸索了一阵才发现触发条件是 --network。
          // 判据本身是合理的（不计费/不联网/无密钥 = 没有需要人担责的后果），
          // **缺的只是把判据说出来**。
          if (!job.plan.approvalRequired) {
            out(
              `      （本次免审批：执行地 ${job.plan.target.kind} 不计费 · network=${job.plan.network} · 无 secret——` +
                "三者任一成立才需要人点头)",
            );
          }
        }
        return 0;
      }

      case "approve": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research compute approve <jobId> [--actor 谁] [--run]");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const signer = resolveActor(deps, flagString(flags.actor));
        // 终端门在**落 decision record 之前**：没过门就没有任何审批痕迹。
        const gate = await requireApprovalGate(COMPUTE_APPROVAL_GATE, ref, "approve", deps, flags, env);
        const { job, decisionId } = scope.approval.approve(ref, {
          actor: signer.actor,
          actorSource: signer.source,
          note: mergeApprovalNote(flagString(flags.note), gate.bypassNote),
        });
        let final = job;
        if (flags.run === true) {
          final = await scope.broker.dispatch(job.jobId, hooksFor(out, json));
        }
        if (json) {
          out(JSON.stringify({ job: jobJson(final), decisionId, next: nextActionFor(final) }, null, 2));
        } else {
          out(`✅ 已批准（decision record ${decisionId.slice(0, 8)}）`);
          printJob(final, out);
          out(`下一步：${nextActionFor(final)}`);
        }
        return 0;
      }

      case "reject": {
        const ref = positional[0];
        const reason = flagString(flags.reason);
        if (!ref || !reason) {
          err("用法: spark-research compute reject <jobId> --reason <理由>");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const signer = resolveActor(deps, flagString(flags.actor));
        const gate = await requireApprovalGate(COMPUTE_APPROVAL_GATE, ref, "reject", deps, flags, env);
        const { job, decisionId } = scope.approval.reject(ref, {
          actor: signer.actor,
          actorSource: signer.source,
          reason: mergeApprovalNote(reason, gate.bypassNote) ?? reason,
        });
        if (json) {
          out(JSON.stringify({ job: jobJson(job), decisionId }, null, 2));
        } else {
          out(`❌ 已拒绝（decision record ${decisionId.slice(0, 8)}）`);
          printJob(job, out);
        }
        return 0;
      }

      case "run": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research compute run <jobId>");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const job = await scope.broker.dispatch(ref, hooksFor(out, json));
        // S2：执行进终态时 broker 已经落了这次运行的 observation。把 id 打出来——
        // 「证据落在哪儿」不该只有翻数据库才知道（W5-2 末验收正是靠 sqlite3 才发现洞的）。
        const observationId = scope.broker.observationIdFor(job.jobId);
        if (json) {
          out(JSON.stringify({ job: jobJson(job), observationId, next: nextActionFor(job) }, null, 2));
        } else {
          printJob(job, out);
          if (observationId) out(`    observation: ${observationId}（证据图 · kind=compute_output）`);
          out(`下一步：${nextActionFor(job)}`);
        }
        return job.lifecycle.execution === "succeeded" ? 0 : 1;
      }

      case "status": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research compute status <jobId>");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const job = scope.broker.poll(ref);
        if (json) {
          out(JSON.stringify({ job: jobJson(job), next: nextActionFor(job) }, null, 2));
        } else {
          printJob(job, out);
          out(`下一步：${nextActionFor(job)}`);
        }
        return 0;
      }

      case "list": {
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const state = flagString(flags.state);
        if (state && !(EXECUTION_STATES as readonly string[]).includes(state)) {
          err(`未知状态 '${state}'（可用：${EXECUTION_STATES.join(", ")}）`);
          return 1;
        }
        const jobs = scope.broker.list(state ? { execution: [state as ExecutionState] } : undefined);
        if (json) {
          out(JSON.stringify({ project: project.slug, jobs: jobs.map(jobJson) }, null, 2));
        } else if (jobs.length === 0) {
          out("（没有算力任务）");
        } else {
          for (const job of jobs) printJob(job, out);
        }
        return 0;
      }

      case "collect": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research compute collect <jobId>");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const { job, harvest, evidence } = await scope.broker.collect(ref);
        if (json) {
          out(JSON.stringify({ job: jobJson(job), harvest, evidence }, null, 2));
        } else {
          out(`📦 收割 ${harvest.files.length} 个产物 → ${job.jobDir}/harvest/`);
          for (const f of harvest.files) out(`    ${f.path}（${f.bytes} 字节，sha256 ${f.sha256.slice(0, 12)}）`);
          if (harvest.reconcileError) out(`    ⚠️  对账失败：${harvest.reconcileError}`);
          // S2：收割不等于进证据图。这两行是「进图了」的可见回执。
          if (evidence.artifactRecordIds.length > 0) {
            out(`🧾 已登记 ${evidence.artifactRecordIds.length} 条 artifact record 进证据图`);
            for (const id of evidence.artifactRecordIds) out(`    ${id}`);
          }
          if (evidence.observationId) out(`    observation: ${evidence.observationId}`);
          out("    用 spark-research report stats 复核证据图");
          printJob(job, out);
        }
        return harvest.reconcileError ? 1 : 0;
      }

      // `broker.recover()` 在 W5-2 交付时**零生产调用方**（grep 实核）：状态机里
      // 「编排进程重启后接回」这条边建好了，但没有任何入口能触发它——于是编排进程一被杀，
      // 任务就永远卡在 running，连人工都没有办法把它推进终态。这个子命令就是那个入口。
      case "recover": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research compute recover <jobId>");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const job = await scope.broker.recover(ref, hooksFor(out, json));
        if (json) {
          out(JSON.stringify({ job: jobJson(job), next: nextActionFor(job) }, null, 2));
        } else {
          printJob(job, out);
          out(`下一步：${nextActionFor(job)}`);
        }
        return isExecutionTerminal(job.lifecycle.execution) && job.lifecycle.execution !== "succeeded" ? 1 : 0;
      }

      case "cancel": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research compute cancel <jobId>");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const job = await scope.broker.cancel(ref);
        if (json) out(JSON.stringify({ job: jobJson(job) }, null, 2));
        else printJob(job, out);
        return 0;
      }

      case "release": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research compute release <jobId> [--discard \"<理由>\"]");
          return 1;
        }
        project = manager.defaultProject();
        const scope = openComputeScope(project, deps);
        const discard = flagString(flags.discard);
        // 放弃产物是一次**显式的人的决定**，不是资源清理的副作用（W5-1 α 的 D-1/D-2）。
        if (discard) scope.broker.discard(ref, discard);
        const job = await scope.broker.release(ref);
        if (json) out(JSON.stringify({ job: jobJson(job) }, null, 2));
        else {
          out("🧹 远端资源已释放");
          printJob(job, out);
        }
        return 0;
      }

      case "help":
      case "--help":
      case "-h":
        out(COMPUTE_HELP);
        return sub === undefined ? 1 : 0;

      default:
        err(`未知的 compute 子命令 '${sub ?? ""}'`);
        err(COMPUTE_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ApprovalGateError) {
      // 终端门没过——不是「状态机不允许」，是「这次调用没有可信的人工确认」。
      err(`🚫 ${error.message}`);
      return 1;
    }
    if (error instanceof ApprovalRequiredError) {
      err(`🚫 ${error.message}`);
      return 1;
    }
    if (error instanceof ComputeStateError) {
      err(`🚫 ${error.message}`);
      return 1;
    }
    if (error instanceof ComputeDispatchConflictError || error instanceof ComputeAdmissionError) {
      err(`⛔ ${error.message}`);
      return 1;
    }
    if (
      error instanceof UploadDeniedError ||
      error instanceof UploadLimitError ||
      error instanceof UploadChangedError
    ) {
      err(`🚫 ${error.message}`);
      return 1;
    }
    if (error instanceof PlanValidationError || error instanceof UnknownTargetError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    if (error instanceof UnknownComputeJobError || error instanceof ProjectError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    err(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    project?.close();
  }
}

function hooksFor(out: (line: string) => void, json: boolean) {
  // --json 时不往 stdout 混日志：调用方要解析这一整段输出。
  return json ? {} : { onLog: (line: string) => out(`    │ ${line}`) };
}
