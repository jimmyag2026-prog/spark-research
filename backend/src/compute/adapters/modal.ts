// CB-4 · 第二个 ComputeAdapter：Modal 远端沙箱（设计 §1.1.6 / §三·补.7）。
//
// **先说这个文件不是什么**（AD-12 的口径纪律，v0.5 已经因为这一条修过两处：
// V34 的默认源、单二进制里的「技能 0 个」）：
//
//   它**不是**一个已经能跑起来的 Modal 客户端。本 lane（W5-2 α）交付时用户还没有
//   token，所以交付边界是「gateway 接口 + 录制层 + check() + 用假 gateway 过全部契约
//   测试」，**真实 Modal 从未被调用过一次**。`ModalGateway` 的真实实现（gRPC/SDK）
//   还不存在，`status()` 会把这件事如实报成 `transport: "not_wired"`。
//
//   所以对外材料里正确的说法是：**算力抽象层与审批链已落地并有 local 实现；
//   Modal adapter 的契约已立、真实链路未验证**。不许说「支持 Modal 远端算力」。
//
// **三条硬约束**（设计 §三·补.7，用户 2026-09-10 拍板），逐条落在这个文件里：
//
//   约束一（零代码改动启用）：「Modal 能不能用」的判定**只读运行期状态**——
//     `CredentialProvider`（就是 `~/.spark-research/credentials.json` 的
//     `connectors.modal`，复用既有 CredentialStore，不另起存储）+ 运行期 config。
//     这个文件里**没有任何编译期常量参与那个判定**：`status()` 每次调用都重新读，
//     同一个 adapter 实例在凭据写入前后给出的答案不同（测试盯着这一点）。
//     下面的 `MODAL_GPU_CATALOG` 是**能选哪些 GPU**的清单，不参与可用性判定——
//     别把它和被禁止的那种 build-time 开关搞混。
//
//   约束二（没配 token 的口径是「未配置」）：不是「不可用」，也不是「可用」。
//     `needs_credential` 与 `unavailable` 是两个不同的值：能力在、只是没凭据，
//     和「openmm 没装」不是一回事。并且必须给出配置指引（质量对照 `lab approve`
//     的 V19 拒绝消息与 `lit add` 的 V36 失败消息：为什么 → 是什么机制 → 该做什么）。
//
//   约束三（假 gateway 不许成为永久替身）：`tests/unit/narrative_parity.test.ts` 的
//     ALLOWED_ORPHANS 里有一条「等真实录制」登记，`tests/unit/compute_modal.test.ts`
//     有一条门禁盯着它——只要 fixture 里还没有一份 `provenance: "real-modal"` 的录制，
//     那条登记就必须在。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CredentialProvider } from "../../connectors/base";
import { UPLOAD_BYTES_LIMIT, UPLOAD_COUNT_LIMIT } from "../uploads";
import {
  RecoverFailure,
  type AdapterCapabilities,
  type AdapterHandle,
  type ComputeAdapter,
  type DispatchSpec,
  type Harvest,
  type ResolvedSpec,
  type RunHooks,
  type RunResult,
} from "../target";
import {
  MODAL_EXIT_FILE_ENV,
  MODAL_EXIT_MARKER,
  MODAL_MARKER_DIR,
  MODAL_RUNNER_SHIM,
  MODAL_SHIM_SOURCE,
  MODAL_VOLUME_MOUNT,
  isModalSandboxTerminal,
  type ModalAuth,
  type ModalGateway,
  type ModalGatewayFactory,
  type ModalSandboxSpec,
  type ModalSandboxStatus,
} from "./modal_gateway";

/** credentials.json 里的键。与 connector 层同一个命名空间（`connectors.modal`）。 */
export const MODAL_CONNECTOR_ID = "modal";
/** 只有字段名，永远没有值——与 CredentialStore.describe() 同一条规矩。 */
export const MODAL_REQUIRED_CREDENTIAL_KEYS = ["tokenId", "tokenSecret"] as const;
export const MODAL_DEFAULT_APP = "spark-research";
export const RUN_LOG = "run.log";

/**
 * 可选 GPU 型号。**这份清单未经真实核实**——本 lane 没有 token、也没有对着 Modal
 * 的定价页核对过。有 token 之后的第一批任务里就有「照定价页核对型号与单价」这一条
 * （devlog 的清单）。在那之前它的作用只是**收窄**：plan 里写了不在清单里的型号会被
 * `validatePlan` 当场拒掉（fail-closed），而不是带着一个错型号跑到远端去。
 *
 * 它**不参与**「Modal 能不能用」的判定（约束一）——那件事只由运行期凭据/配置决定。
 */
export const MODAL_GPU_CATALOG = ["T4", "L4", "A10G", "A100", "A100-80GB", "L40S", "H100"] as const;

/** 与 `capabilities/index.ts` 的 `Availability` 用同一套字面量（刻意不 import：算力层不该反向依赖自描述层）。 */
export type ModalAvailability = "available" | "needs_credential" | "unavailable";

export interface ModalStatusReport {
  availability: ModalAvailability;
  /** §2.11 的字段。没配就是 false——**不许**报 true，也不许含糊成 null。 */
  credentialConfigured: boolean;
  /** 缺哪些字段（只有字段名）。 */
  missingKeys: string[];
  /** 运行期 config 里的 modalEnvironment（W5-2 β 所有权）；没配 = null。 */
  environment: string | null;
  /** 真实 gateway 接上了没有。`not_wired` = 代码还没写，**不是**用户配置问题。 */
  transport: "ready" | "not_wired";
  reason: string | null;
  /** 配置指引：为什么 → 是什么机制 → 该做什么（V19/V36 的质量口径）。 */
  howToConfigure: string[];
}

/** 运行期配置视图。lane β 从 `config.json` 读出来注入；本 lane 不碰 config 层。 */
export interface ModalRuntimeConfig {
  environment: string | null;
}

export interface ModalAdapterDeps {
  /** `CredentialStore` 结构上满足这个接口（connectors/base.ts:31-34）。 */
  credentials: CredentialProvider;
  /** **每次调用都会重新执行**——这是「改配置不用重新编译」的物理保证。 */
  config?: () => ModalRuntimeConfig;
  /**
   * 真实 gateway 的工厂。没有它 = 传输层还没接线（transport:"not_wired"）。
   * 注意签名：token 是**参数**，不是 adapter 的字段——adapter 从不持有凭据值。
   */
  gatewayFactory?: ModalGatewayFactory | null;
  appName?: string;
  gpus?: readonly string[];
  pollIntervalMs?: number;
  now?: () => number;
}

export class ModalNotConfiguredError extends Error {
  constructor(readonly report: ModalStatusReport) {
    super([report.reason ?? "modal target 当前不可用", ...report.howToConfigure].join("\n"));
    this.name = "ModalNotConfiguredError";
  }
}

export function modalVolumeName(jobId: string): string {
  return `spark-${jobId}`;
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 配置指引。内容由**本次实际发生的事**推出来，不是万能套话（V36 的教训）。 */
function guidanceFor(missingKeys: string[], transport: ModalStatusReport["transport"]): string[] {
  const lines: string[] = [];
  if (missingKeys.length > 0) {
    lines.push("下一步:");
    lines.push(
      `  · 在 ~/.spark-research/credentials.json 的 connectors.${MODAL_CONNECTOR_ID} 下填入字段 ` +
        `${missingKeys.join(" / ")}（去 Modal 控制台的 API Tokens 页生成；凭据值只在本机读取，` +
        `不会进入 plan / job.json / 日志 / 录制）`,
    );
    lines.push("      文件权限须为 0600（chmod 600 ~/.spark-research/credentials.json）");
    lines.push(
      `  · 要指定 Modal environment，把 modalEnvironment 写进 config.json；` +
        `要把 modal 设成默认执行地，把 computeTarget 写成 "modal"。两件事都是**改配置**，` +
        `不需要改代码、不需要重新编译。`,
    );
  }
  if (transport === "not_wired") {
    lines.push(
      `  · **注意（如实告知）**：本版本只交付了 Modal 的契约与录制层，` +
        `真实 gateway（Modal SDK 客户端）尚未实现——所以**只填 token 还跑不起来**。` +
        `进度见 docs/devlog/W5-2-a.md 的「有 token 之后还需要做什么」。`,
    );
  }
  return lines;
}

export class ModalComputeAdapter implements ComputeAdapter {
  readonly kind = "modal" as const;
  readonly description =
    "Modal 远端沙箱（计费、持久卷、可接回）——**本版本契约已立、真实链路未验证**，见 status().transport";

  private readonly credentials: CredentialProvider;
  private readonly readConfig: () => ModalRuntimeConfig;
  private readonly gatewayFactory: ModalGatewayFactory | null;
  private readonly appName: string;
  private readonly gpus: readonly string[];
  private readonly pollIntervalMs: number;

  constructor(deps: ModalAdapterDeps) {
    this.credentials = deps.credentials;
    this.readConfig = deps.config ?? (() => ({ environment: null }));
    this.gatewayFactory = deps.gatewayFactory ?? null;
    this.appName = deps.appName ?? MODAL_DEFAULT_APP;
    this.gpus = deps.gpus ?? MODAL_GPU_CATALOG;
    this.pollIntervalMs = deps.pollIntervalMs ?? 200;
  }

  capabilities(): AdapterCapabilities {
    return {
      // 花的是用户 Modal 账户的钱 → approvalRequired 恒为 true（L-3）。
      billable: true,
      persistentVolume: true,
      recovery: true,
      secretRefs: true,
      network: ["none", "unrestricted"],
      gpus: this.gpus,
      uploadLimits: { count: UPLOAD_COUNT_LIMIT, bytes: UPLOAD_BYTES_LIMIT },
    };
  }

  /**
   * 「Modal 现在是什么状态」的**唯一**判据。约束一的落点：
   * 每次调用都重新读凭据与 config，**没有任何编译期常量参与**，
   * 也不缓存到实例字段上——把答案缓存进构造函数就等于要求用户重启进程。
   */
  status(): ModalStatusReport {
    const values = this.credentials.get(MODAL_CONNECTOR_ID) ?? {};
    const missingKeys = MODAL_REQUIRED_CREDENTIAL_KEYS.filter(
      (key) => typeof values[key] !== "string" || values[key]!.trim() === "",
    ).map((k) => String(k));
    const environment = this.readConfig().environment;
    const transport: ModalStatusReport["transport"] = this.gatewayFactory ? "ready" : "not_wired";

    if (missingKeys.length > 0) {
      // 约束二：缺凭据的口径是**未配置**，不是「不可用」。能力在，只是没钥匙。
      return {
        availability: "needs_credential",
        credentialConfigured: false,
        missingKeys,
        environment,
        transport,
        reason:
          `modal 未配置凭据：~/.spark-research/credentials.json 的 connectors.${MODAL_CONNECTOR_ID} ` +
          `缺字段 ${missingKeys.join(" / ")}。这不是「Modal 不可用」——能力在、审批链在，只差一把钥匙。`,
        howToConfigure: guidanceFor(missingKeys, transport),
      };
    }
    if (transport === "not_wired") {
      // 凭据齐了但传输层根本没写——这时候报「可用」就是 AD-12 明令禁止的形状。
      return {
        availability: "unavailable",
        credentialConfigured: true,
        missingKeys: [],
        environment,
        transport,
        reason:
          "modal 凭据已配置，但**真实 gateway 尚未实现**（本版本只交付契约与录制层）——" +
          "现在派发会当场失败，不会产生任何远端资源、也不会产生账单。",
        howToConfigure: guidanceFor([], transport),
      };
    }
    return {
      availability: "available",
      credentialConfigured: true,
      missingKeys: [],
      environment,
      transport,
      reason: null,
      howToConfigure: [],
    };
  }

  async check(): Promise<{
    ok: boolean;
    reason: string | null;
    detail: Record<string, string | number | boolean | null>;
  }> {
    const report = this.status();
    const detail: Record<string, string | number | boolean | null> = {
      status: report.availability,
      credentialConfigured: report.credentialConfigured,
      missingKeys: report.missingKeys.join(",") || null,
      environment: report.environment,
      transport: report.transport,
      guidance: report.howToConfigure.join("\n") || null,
    };
    if (report.availability !== "available") {
      return { ok: false, reason: report.reason, detail };
    }
    // 只读探测：不建任何远端资源（设计 §2.3 的 check() 契约）。
    const gateway = this.gatewayOrThrow(report);
    const probe = await gateway.probe();
    return {
      ok: probe.ok,
      reason: probe.reason,
      detail: { ...detail, ...probe.detail },
    };
  }

  async run(spec: DispatchSpec, hooks: RunHooks): Promise<RunResult> {
    const report = this.status();
    const gateway = this.gatewayOrThrow(report);
    const volumeName = modalVolumeName(spec.jobId);
    const mount = MODAL_VOLUME_MOUNT;

    // ① 卷：常量 shim + **只有 plan.uploads 里点名的文件**（broker 已经把它们 stage
    //    进 <jobDir>/workspace 并逐条 preflight 过；adapter 一律读 stage 后的那份，
    //    不回头去碰 workspaceRoot——那是审批之后可能又被改过的地方）。
    const workspace = join(spec.jobDir, "workspace");
    const files = [
      { path: MODAL_RUNNER_SHIM, contentBase64: Buffer.from(MODAL_SHIM_SOURCE).toString("base64"), mode: 0o700 },
    ];
    for (const entry of spec.plan.uploads) {
      const src = join(workspace, entry.path);
      const content = readFileSync(src);
      files.push({ path: entry.path, contentBase64: content.toString("base64"), mode: 0o600 });
    }
    await gateway.writeVolume(volumeName, files);

    // ② 密钥只在这一刻解析，交给 gateway 注入沙箱环境；**不落任何文件、不进录制**。
    const secretEnv: Record<string, string> = {};
    for (const ref of spec.plan.secretRefs) Object.assign(secretEnv, spec.resolveSecret(ref));

    const target = spec.plan.target;
    const sandboxSpec: ModalSandboxSpec = {
      appName: this.appName,
      // 优先用 plan 里被审批过的 environment；plan 没写才回落到运行期 config。
      environment: (target.kind === "modal" ? target.environment : undefined) ?? report.environment,
      image: spec.plan.image
        ? { base: spec.plan.image.base, pip: spec.plan.image.pip, pipLockDigest: spec.plan.image.pipLock?.digest ?? null }
        : null,
      command: ["/bin/sh", `${mount}/${MODAL_RUNNER_SHIM}`, ...spec.plan.command],
      workdir: mount,
      volumeName,
      volumeMountPath: mount,
      // 刻意**不**把本地 process.env 带上去：本机环境是本机的事，远端沙箱只拿被审批的那些。
      env: {
        ...spec.plan.env,
        PYTHONUNBUFFERED: "1",
        [MODAL_EXIT_FILE_ENV]: `${mount}/${MODAL_EXIT_MARKER}`,
      },
      secretEnv,
      gpu: spec.plan.resources.gpu,
      cpus: spec.plan.resources.cpus,
      memoryGb: spec.plan.resources.memoryGb,
      timeoutSeconds: spec.plan.resources.timeoutMinutes * 60,
      network: spec.plan.network,
      tags: { jobId: spec.jobId, planDigest: spec.plan.digest, app: this.appName },
    };

    const created = await gateway.createSandbox(sandboxSpec);
    const handle: AdapterHandle = {
      kind: "modal",
      data: {
        sandboxId: created.sandboxId,
        volumeName: created.volumeName,
        appName: this.appName,
        environment: sandboxSpec.environment,
        startedAt: created.startedAt,
        // AdapterHandle.data 是扁平的（string|number|null），tags 序列化后再放。
        tags: JSON.stringify(sandboxSpec.tags),
      },
    };
    hooks.onState?.({ execution: "running" });
    return this.awaitTerminal(spec, handle, hooks, gateway, 0);
  }

  async recover(spec: ResolvedSpec, handle: AdapterHandle, hooks: RunHooks): Promise<RunResult> {
    const gateway = this.gatewayOrThrow(this.status());
    const { sandboxId, volumeName } = this.handleOf(handle);

    // 顺序与 local 一致（adapters/local.ts:152-157）：**先看任务侧的标记，再看控制面**。
    // 任务写完标记才退出，所以只要标记在，无论控制面把这个沙箱记成什么都以标记为准。
    const marker = await this.readExitMarker(gateway, volumeName);
    if (marker !== null) {
      return { exitCode: marker, timedOut: false, handle };
    }
    const status = await gateway.getSandbox(sandboxId);
    if (!status) {
      throw new RecoverFailure(
        "not_found",
        `Modal 控制面查不到沙箱 ${sandboxId}，卷 ${volumeName} 上也没有 exit-code 标记——` +
          `任务是否跑完无从确认。重跑一次可能就好，但重跑需要**新的审批**。`,
      );
    }
    if (status.state === "lost") {
      throw new RecoverFailure(
        "retryable",
        `Modal 控制面把沙箱 ${sandboxId} 报成 lost（它自己也说不清），且卷上没有 exit-code 标记`,
      );
    }
    if (isModalSandboxTerminal(status.state)) {
      return { exitCode: status.exitCode, timedOut: status.state === "timeout", handle };
    }
    return this.awaitTerminal(spec, handle, hooks, gateway, 0);
  }

  async collect(spec: ResolvedSpec, handle: AdapterHandle): Promise<Harvest> {
    const gateway = this.gatewayOrThrow(this.status());
    const { sandboxId, volumeName } = this.handleOf(handle);

    // ① 日志整段拉回本地。**不依赖沙箱还活着**——日志与产物都在卷上/控制面上。
    const logPath = join(spec.jobDir, RUN_LOG);
    let logText = "";
    try {
      logText = (await gateway.readLogs(sandboxId, 0)).text;
    } catch {
      // 日志拉不回来不该让收割整体失败：产物比日志重要，缺日志会体现在 run.log 为空。
    }
    writeFileSync(logPath, logText);

    // ② 产物按 **plan.outputs 的 glob** 收割——一条都不多、一条都不少。
    const harvestDir = join(spec.jobDir, "harvest");
    mkdirSync(harvestDir, { recursive: true });
    const files: Harvest["files"] = [];
    const seen = new Set<string>();
    const fetched = spec.plan.outputs.length > 0 ? await gateway.readVolume(volumeName, spec.plan.outputs) : [];
    for (const file of fetched) {
      const posix = file.path.split("\\").join("/");
      // 编排自己的私有目录不是产物（shim 与 exit 标记）。
      if (posix === MODAL_MARKER_DIR || posix.startsWith(`${MODAL_MARKER_DIR}/`)) continue;
      if (seen.has(posix)) continue;
      seen.add(posix);
      const bytes = Buffer.from(file.contentBase64, "base64");
      const dest = join(harvestDir, posix);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      files.push({ path: posix, bytes: bytes.length, sha256: sha256(bytes) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    // ③ 对账：任务侧的标记 vs 控制面的说法。**不许猜**——「大概是成功了吧」
    //    是这类系统最贵的一句话（与 local 同一条纪律，理由更强：这里隔着一个网络）。
    const marker = await this.readExitMarker(gateway, volumeName);
    let status: ModalSandboxStatus | null = null;
    try {
      status = await gateway.getSandbox(sandboxId);
    } catch {
      status = null;
    }
    let reconcileError: string | null = null;
    if (marker === null) {
      reconcileError =
        `卷 ${volumeName} 上没有 exit-code 标记：任务是否真的跑完无法确认（${spec.jobId}）` +
        (status ? `；控制面把沙箱报成 ${status.state}` : "；控制面也查不到这个沙箱");
    } else if (status && status.exitCode !== null && status.exitCode !== marker) {
      reconcileError =
        `退出码对不上：任务侧标记 ${marker}，控制面报 ${status.exitCode}（沙箱 ${sandboxId}）——` +
        `两边说法不一致时一律按失败处理，由人看日志裁定`;
    }

    const startedAt = Date.parse(String(handle.data.startedAt ?? ""));
    const finishedAt = status?.finishedAt ? Date.parse(status.finishedAt) : NaN;
    const wallSeconds =
      Number.isFinite(startedAt) && Number.isFinite(finishedAt)
        ? Math.max(0, Number(((finishedAt - startedAt) / 1000).toFixed(3)))
        : null;

    return { files, logPath, exitCode: marker ?? status?.exitCode ?? null, wallSeconds, reconcileError };
  }

  async cancel(_spec: ResolvedSpec, handle: AdapterHandle): Promise<void> {
    const gateway = this.gatewayOrThrow(this.status());
    const { sandboxId } = this.handleOf(handle);
    const status = await gateway.getSandbox(sandboxId);
    if (!status || isModalSandboxTerminal(status.state)) return;
    await gateway.cancelSandbox(sandboxId);
  }

  async release(_spec: ResolvedSpec, handle: AdapterHandle): Promise<void> {
    const gateway = this.gatewayOrThrow(this.status());
    const { volumeName } = this.handleOf(handle);
    // 删的是**远端卷**。本地的 harvest/ 与 run.log 一个都不动——
    // release 释放的是资源，不是证据（与 local 同一条）。
    await gateway.deleteVolume(volumeName);
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private gatewayOrThrow(report: ModalStatusReport): ModalGateway {
    if (report.availability !== "available" || !this.gatewayFactory) {
      throw new ModalNotConfiguredError(report);
    }
    const values = this.credentials.get(MODAL_CONNECTOR_ID) ?? {};
    // token 从凭据库读出来**直接交给工厂**，不经过 adapter 的任何字段、不进日志。
    const auth: ModalAuth = {
      tokenId: values.tokenId!,
      tokenSecret: values.tokenSecret!,
      environment: report.environment,
    };
    return this.gatewayFactory(auth);
  }

  private handleOf(handle: AdapterHandle): { sandboxId: string; volumeName: string } {
    const sandboxId = typeof handle.data.sandboxId === "string" ? handle.data.sandboxId : null;
    const volumeName = typeof handle.data.volumeName === "string" ? handle.data.volumeName : null;
    if (!sandboxId || !volumeName) {
      throw new RecoverFailure(
        "invalid_request",
        `modal 的 adapterHandle 缺 sandboxId/volumeName：${JSON.stringify(handle.data)}`,
      );
    }
    return { sandboxId, volumeName };
  }

  private async readExitMarker(gateway: ModalGateway, volumeName: string): Promise<number | null> {
    let found: readonly { path: string; contentBase64: string }[];
    try {
      found = await gateway.readVolume(volumeName, [MODAL_EXIT_MARKER]);
    } catch {
      return null;
    }
    const entry = found.find((f) => f.path === MODAL_EXIT_MARKER);
    if (!entry) return null;
    const raw = Buffer.from(entry.contentBase64, "base64").toString("utf8").trim();
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  }

  /** run() 与 recover() 共用的等待循环。 */
  private async awaitTerminal(
    spec: ResolvedSpec,
    handle: AdapterHandle,
    hooks: RunHooks,
    gateway: ModalGateway,
    fromOffset: number,
  ): Promise<RunResult> {
    const { sandboxId, volumeName } = this.handleOf(handle);
    const logPath = join(spec.jobDir, RUN_LOG);
    const startedAt = Date.parse(String(handle.data.startedAt ?? ""));
    const deadline =
      (Number.isFinite(startedAt) ? startedAt : Date.now()) + spec.plan.resources.timeoutMinutes * 60_000;
    let offset = fromOffset;
    if (!existsSync(logPath)) writeFileSync(logPath, "");

    const pumpLog = async (): Promise<void> => {
      try {
        const chunk = await gateway.readLogs(sandboxId, offset);
        if (chunk.text) {
          // 日志一边流一边落本地：编排进程被 kill 之后，已经拿到的那部分不该跟着没。
          writeFileSync(logPath, readFileSync(logPath, "utf8") + chunk.text);
          if (hooks.onLog) for (const line of chunk.text.split("\n")) if (line !== "") hooks.onLog(line);
        }
        offset = chunk.nextOffset;
      } catch {
        /* 日志拉取失败不影响判定终态：终态的真源是 exit 标记与控制面 */
      }
    };

    for (;;) {
      await pumpLog();
      const status = await gateway.getSandbox(sandboxId);
      if (status && isModalSandboxTerminal(status.state)) {
        const marker = await this.readExitMarker(gateway, volumeName);
        return {
          // 任务侧标记优先（同 recover 的理由）。
          exitCode: marker ?? status.exitCode,
          timedOut: status.state === "timeout",
          handle,
        };
      }
      if (!status) {
        const marker = await this.readExitMarker(gateway, volumeName);
        if (marker !== null) return { exitCode: marker, timedOut: false, handle };
        throw new RecoverFailure("not_found", `Modal 控制面查不到沙箱 ${sandboxId}（等待期间消失）`);
      }
      if (hooks.signal?.aborted) {
        await gateway.cancelSandbox(sandboxId).catch(() => undefined);
        await pumpLog();
        return { exitCode: await this.readExitMarker(gateway, volumeName), timedOut: false, handle };
      }
      if (Date.now() > deadline) {
        // 墙钟超时：**我们这边**主动终止并如实报 timedOut，不等控制面的超时。
        await gateway.cancelSandbox(sandboxId).catch(() => undefined);
        await pumpLog();
        return { exitCode: await this.readExitMarker(gateway, volumeName), timedOut: true, handle };
      }
      await Bun.sleep(this.pollIntervalMs);
    }
  }
}
