// CB-4 · Modal 的 SDK 边界（设计 §1.1.6「录制层」）。
//
// 为什么需要这一层：Modal 的 SDK 走 gRPC，`http/fixture.ts` 那套「录一遍 HTTP 响应、
// 回放给 HttpClient」的机制**套不上**——没有 HTTP 请求可拦。所以 adapter 里所有
// SDK 调用都收口到 `ModalGateway` 这一个接口上，测试注入一个假实现或一份录制。
//
// 这个文件里**没有任何真实的 Modal SDK 调用**。本 lane（W5-2 α）在没有 token 的
// 前提下交付：接口 + 录制/回放层 + 契约。真实实现（`createRealModalGateway`）留给
// 拿到 token 之后的那一次接线，它要做的事只有一件：实现下面这九个方法。
// **在那之前，任何「Modal 可用」的说法都是错的**——`modal.ts` 的 `status()` 会
// 如实把这件事报成 `transport: "not_wired"`，见那边的注释。
//
// 与 `http/fixture.ts` 的关系：思想同源（录一遍、回放、CI 零凭据），代码不共享——
// 一个是 HTTP 请求/响应对，一个是方法调用/返回值对，硬塞在一起只会两边都别扭。

import { canonicalJson } from "../../simulation/platform";

/** 卷在沙箱里的挂载点。与 `ComputePlan.cwd` 同一个值（plan.ts 强制 `/workspace`）。 */
export const MODAL_VOLUME_MOUNT = "/workspace";
/** 卷上给编排用的私有目录（不会被 outputs 的 glob 命中：Bun.Glob 默认 dot:false）。 */
export const MODAL_MARKER_DIR = ".spark";
/** 任务侧写下的终态标记。**exit code 的真源是它**，不是控制面（见 modal.ts collect 的对账）。 */
export const MODAL_EXIT_MARKER = `${MODAL_MARKER_DIR}/exit-code`;
export const MODAL_RUNNER_SHIM = `${MODAL_MARKER_DIR}/runner.sh`;
/** 沙箱里指向 exit 标记的环境变量名（shim 用它，不拼接任何 plan 内容）。 */
export const MODAL_EXIT_FILE_ENV = "SPARK_COMPUTE_EXIT_FILE";

// 与 local adapter 的 shim 同一个理由（adapters/local.ts:44-56）：exit-code 必须由
// **任务这一侧**写下来。控制面说「沙箱结束了」和任务说「我跑完了、退出码是 3」是
// 两件事——中间隔着 OOM kill、节点抢占、控制面自己的重试。两边都记下来，收割时对账。
//
// 注意 `"$@"`：被审批的 argv 原样作为参数传进来，**不做第二次 shell 展开**
// （设计 §1.1.3 ①）。shim 内容是常量，不拼接任何 plan 内容。
//
// 刻意**不复用** local.ts 的那份：那份是 private const，而「不改 W5-1 α 的文件」
// 是本 lane 的硬边界。两份内容一致是有意的重复，不是疏忽（devlog 有记）。
export const MODAL_SHIM_SOURCE = `#!/bin/sh
# 由 spark-research modal compute adapter 生成。内容是常量，不含任何被审批的字符串。
"$@"
code=$?
printf '%s' "$code" > "$${MODAL_EXIT_FILE_ENV}.tmp" && mv "$${MODAL_EXIT_FILE_ENV}.tmp" "$${MODAL_EXIT_FILE_ENV}"
exit $code
`;

/** Modal 账户凭据。**只在调用时刻从 CredentialStore 读出来传进工厂，adapter 不持有它**。 */
export interface ModalAuth {
  tokenId: string;
  tokenSecret: string;
  environment: string | null;
}

export interface ModalImageSpec {
  base: string;
  pip: readonly string[];
  /** 有锁文件才可复现；没有就是 null，如实说（不编一个假 digest）。 */
  pipLockDigest: string | null;
}

export interface ModalSandboxSpec {
  appName: string;
  environment: string | null;
  image: ModalImageSpec | null;
  /** argv；不经 shell 展开。第一项是 shim，被审批的命令原样跟在后面。 */
  command: readonly string[];
  workdir: string;
  volumeName: string;
  volumeMountPath: string;
  env: Readonly<Record<string, string>>;
  /**
   * dispatch 时刻解析出来的密钥值。**永远不进录制、不落盘、不进日志**——
   * 录制层会把它整段换成字段名清单（`RecordingModalGateway` 的 redact）。
   */
  secretEnv: Readonly<Record<string, string>>;
  gpu: string | null;
  cpus: number;
  memoryGb: number;
  timeoutSeconds: number;
  network: "none" | "unrestricted";
  tags: Readonly<Record<string, string>>;
}

export const MODAL_SANDBOX_STATES = [
  "starting",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  /** 控制面自己也说不清这个沙箱怎么了——**不许**被读成 succeeded。 */
  "lost",
] as const;
export type ModalSandboxState = (typeof MODAL_SANDBOX_STATES)[number];

export function isModalSandboxTerminal(state: ModalSandboxState): boolean {
  return state !== "starting" && state !== "running";
}

export interface ModalSandboxStatus {
  sandboxId: string;
  state: ModalSandboxState;
  /** 控制面报的退出码；拿不到就是 null（**不许**当 0）。 */
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ModalVolumeEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** 内容一律 base64：录制文件要能原样进 JSON，二进制产物不能只靠 utf8 蒙混过去。 */
export interface ModalVolumeFile extends ModalVolumeEntry {
  contentBase64: string;
}

export interface ModalVolumeWrite {
  path: string;
  contentBase64: string;
  /** 需要可执行时给 0o700（shim）。 */
  mode?: number;
}

export interface ModalLogChunk {
  text: string;
  nextOffset: number;
}

export interface ModalProbeResult {
  ok: boolean;
  reason: string | null;
  detail: Record<string, string | number | boolean | null>;
}

export interface ModalSandboxRef {
  sandboxId: string;
  volumeName: string;
  tags: Record<string, string>;
}

/**
 * adapter 与 Modal 之间**唯一**的边界。设计 §1.1.6 点名了六个方法
 * （createSandbox / getSandbox / readVolume / writeVolume / deleteVolume / listByTag）；
 * 这里另加三个，理由逐条写在方法上，devlog 也有记（不是偷偷扩契约）。
 */
export interface ModalGateway {
  createSandbox(spec: ModalSandboxSpec): Promise<{ sandboxId: string; volumeName: string; startedAt: string }>;
  getSandbox(sandboxId: string): Promise<ModalSandboxStatus | null>;
  /** 设计六方法之外 ①：契约测试要求 `cancel()` 能让运行中的任务终结在 cancelled。 */
  cancelSandbox(sandboxId: string): Promise<void>;
  /** 设计六方法之外 ②：`RunHooks.onLog` 要求日志能增量流回来。 */
  readLogs(sandboxId: string, fromOffset: number): Promise<ModalLogChunk>;
  writeVolume(volumeName: string, files: readonly ModalVolumeWrite[]): Promise<void>;
  readVolume(volumeName: string, globs: readonly string[]): Promise<readonly ModalVolumeFile[]>;
  deleteVolume(volumeName: string): Promise<void>;
  listByTag(tags: Readonly<Record<string, string>>): Promise<readonly ModalSandboxRef[]>;
  /** 设计六方法之外 ③：`ComputeAdapter.check()` 要一个**不产生任何远端资源**的只读探测。 */
  probe(): Promise<ModalProbeResult>;
}

export type ModalGatewayFactory = (auth: ModalAuth) => ModalGateway;

export class ModalGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModalGatewayError";
  }
}

// ── 录制 / 回放 ────────────────────────────────────────────────────────────

export interface ModalTranscriptEntry {
  seq: number;
  method: keyof ModalGateway;
  request: unknown;
  response: unknown;
  error: { name: string; message: string } | null;
}

export interface ModalTranscript {
  schemaVersion: 1;
  /**
   * **这份录制是从哪来的**。整个回放机制的诚实性挂在这一个字段上：
   *   · `"fake-gateway"`：从测试用的假 gateway 录的。它证明 adapter 的调用序列自洽，
   *     **不证明** Modal 真的这样回话。
   *   · `"real-modal"`：对着真实 Modal 账户录的。v0.5 W5-2 α 交付时**一份都没有**。
   * 不许省略、不许写别的值——`tests/unit/compute_modal.test.ts` 有门禁盯着。
   */
  provenance: "fake-gateway" | "real-modal";
  recordedAt: string;
  note: string;
  entries: ModalTranscriptEntry[];
}

const REDACTED = "«redacted»";

function redactSpec(spec: ModalSandboxSpec): unknown {
  const { secretEnv, ...rest } = spec;
  // 只留字段名，永远不留值——与 CredentialStore.describe() 同一条规矩。
  return { ...rest, secretEnv: { redactedKeys: Object.keys(secretEnv).sort() } };
}

/**
 * 录一遍 gateway 的调用序列。
 *
 * 两条纪律写死在这里，不靠调用方自觉：
 *   ① `secretEnv` 整段换成字段名清单；
 *   ② 凡是**曾经流经这个录制器的密钥值**，在之后任何 payload 里出现都换成 `«redacted»`
 *      ——日志是最容易漏的那条路（任务自己 echo 一下密钥，就录进 fixture 了）。
 */
export class RecordingModalGateway implements ModalGateway {
  readonly entries: ModalTranscriptEntry[] = [];
  private readonly seen = new Set<string>();
  private seq = 0;

  constructor(
    private readonly inner: ModalGateway,
    private readonly meta: Pick<ModalTranscript, "provenance" | "note">,
  ) {}

  transcript(now: () => string = () => new Date().toISOString()): ModalTranscript {
    return {
      schemaVersion: 1,
      provenance: this.meta.provenance,
      recordedAt: now(),
      note: this.meta.note,
      entries: this.entries.map((e) => ({ ...e })),
    };
  }

  private scrub<T>(value: T): T {
    if (this.seen.size === 0) return value;
    let text = JSON.stringify(value);
    if (text === undefined) return value;
    for (const secret of this.seen) text = text.split(secret).join(REDACTED);
    return JSON.parse(text) as T;
  }

  private async record<K extends keyof ModalGateway>(
    method: K,
    request: unknown,
    run: () => Promise<unknown>,
  ): Promise<any> {
    const seq = this.seq++;
    try {
      const response = await run();
      this.entries.push({ seq, method, request: this.scrub(request), response: this.scrub(response), error: null });
      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.entries.push({
        seq,
        method,
        request: this.scrub(request),
        response: null,
        error: { name: err.name, message: this.scrub(err.message) },
      });
      throw error;
    }
  }

  createSandbox(spec: ModalSandboxSpec) {
    for (const value of Object.values(spec.secretEnv)) if (value.length >= 4) this.seen.add(value);
    return this.record("createSandbox", redactSpec(spec), () => this.inner.createSandbox(spec));
  }
  getSandbox(sandboxId: string) {
    return this.record("getSandbox", { sandboxId }, () => this.inner.getSandbox(sandboxId));
  }
  cancelSandbox(sandboxId: string) {
    return this.record("cancelSandbox", { sandboxId }, () => this.inner.cancelSandbox(sandboxId));
  }
  readLogs(sandboxId: string, fromOffset: number) {
    return this.record("readLogs", { sandboxId, fromOffset }, () => this.inner.readLogs(sandboxId, fromOffset));
  }
  writeVolume(volumeName: string, files: readonly ModalVolumeWrite[]) {
    return this.record("writeVolume", { volumeName, files }, () => this.inner.writeVolume(volumeName, files));
  }
  readVolume(volumeName: string, globs: readonly string[]) {
    return this.record("readVolume", { volumeName, globs }, () => this.inner.readVolume(volumeName, globs));
  }
  deleteVolume(volumeName: string) {
    return this.record("deleteVolume", { volumeName }, () => this.inner.deleteVolume(volumeName));
  }
  listByTag(tags: Readonly<Record<string, string>>) {
    return this.record("listByTag", { tags }, () => this.inner.listByTag(tags));
  }
  probe() {
    return this.record("probe", {}, () => this.inner.probe());
  }
}

export class ModalReplayMismatchError extends Error {
  constructor(method: string, request: unknown, remaining: number) {
    super(
      `录制里没有匹配的 ${method} 调用（剩余未消费 ${remaining} 条）。\n` +
        `请求：${canonicalJson(request as Record<string, unknown>).slice(0, 400)}\n` +
        `这说明 adapter 的调用序列变了——要么改回去，要么重新录一份 fixture（真实录制需要 token）。`,
    );
    this.name = "ModalReplayMismatchError";
  }
}

/**
 * 回放一份录制。**刻意只被测试使用**（与 `http/fixture.ts` 同一条设计），
 * 但放在生产源码里：它是录制格式的唯一权威解释者，放测试里会长出第二份解释。
 *
 * 匹配规则：方法名 + 归一化后的请求体（同一份 redact 规则），按序优先、否则向后找
 * 第一条未消费的匹配项。**不做模糊匹配**——录制回放一旦开始「大概是这条吧」，
 * 它就不再是证据了。
 */
export class RecordedModalGateway implements ModalGateway {
  private readonly consumed = new Set<number>();

  constructor(private readonly transcript: ModalTranscript) {
    if (transcript.schemaVersion !== 1) {
      throw new ModalGatewayError(`不认识的录制 schemaVersion=${String(transcript.schemaVersion)}`);
    }
  }

  get provenance(): ModalTranscript["provenance"] {
    return this.transcript.provenance;
  }

  /** 还没被消费的条目数——测试可以据此断言「录制被跑完了」。 */
  get remaining(): number {
    return this.transcript.entries.length - this.consumed.size;
  }

  private take(method: keyof ModalGateway, request: unknown): unknown {
    const key = canonicalJson({ method, request } as Record<string, unknown>);
    for (const entry of this.transcript.entries) {
      if (this.consumed.has(entry.seq)) continue;
      if (canonicalJson({ method: entry.method, request: entry.request } as Record<string, unknown>) !== key) continue;
      this.consumed.add(entry.seq);
      if (entry.error) throw new ModalGatewayError(`${entry.error.name}: ${entry.error.message}`);
      return entry.response;
    }
    throw new ModalReplayMismatchError(method, request, this.remaining);
  }

  async createSandbox(spec: ModalSandboxSpec) {
    return this.take("createSandbox", redactSpec(spec)) as { sandboxId: string; volumeName: string; startedAt: string };
  }
  async getSandbox(sandboxId: string) {
    return this.take("getSandbox", { sandboxId }) as ModalSandboxStatus | null;
  }
  async cancelSandbox(sandboxId: string): Promise<void> {
    this.take("cancelSandbox", { sandboxId });
  }
  async readLogs(sandboxId: string, fromOffset: number) {
    return this.take("readLogs", { sandboxId, fromOffset }) as ModalLogChunk;
  }
  async writeVolume(volumeName: string, files: readonly ModalVolumeWrite[]): Promise<void> {
    this.take("writeVolume", { volumeName, files });
  }
  async readVolume(volumeName: string, globs: readonly string[]) {
    return this.take("readVolume", { volumeName, globs }) as readonly ModalVolumeFile[];
  }
  async deleteVolume(volumeName: string): Promise<void> {
    this.take("deleteVolume", { volumeName });
  }
  async listByTag(tags: Readonly<Record<string, string>>) {
    return this.take("listByTag", { tags }) as readonly ModalSandboxRef[];
  }
  async probe() {
    return this.take("probe", {}) as ModalProbeResult;
  }
}

export function parseModalTranscript(json: string): ModalTranscript {
  const parsed = JSON.parse(json) as Partial<ModalTranscript>;
  if (parsed.schemaVersion !== 1) {
    throw new ModalGatewayError(`不认识的录制 schemaVersion=${String(parsed.schemaVersion)}`);
  }
  if (parsed.provenance !== "fake-gateway" && parsed.provenance !== "real-modal") {
    throw new ModalGatewayError(
      `录制缺 provenance（只能是 'fake-gateway' 或 'real-modal'）——` +
        `一份不说明自己从哪来的录制，回放出来的绿色是没有意义的`,
    );
  }
  return {
    schemaVersion: 1,
    provenance: parsed.provenance,
    recordedAt: parsed.recordedAt ?? "",
    note: parsed.note ?? "",
    entries: parsed.entries ?? [],
  };
}
