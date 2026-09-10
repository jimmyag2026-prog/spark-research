import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CredentialStore } from "../../backend/src/daemon/credentials";
import {
  MODAL_CONNECTOR_ID,
  MODAL_GPU_CATALOG,
  ModalComputeAdapter,
  modalVolumeName,
  RUN_LOG,
} from "../../backend/src/compute/adapters/modal";
import {
  MODAL_EXIT_MARKER,
  MODAL_RUNNER_SHIM,
  MODAL_SHIM_SOURCE,
  MODAL_VOLUME_MOUNT,
  RecordedModalGateway,
  RecordingModalGateway,
  parseModalTranscript,
  type ModalGateway,
  type ModalLogChunk,
  type ModalProbeResult,
  type ModalSandboxRef,
  type ModalSandboxSpec,
  type ModalSandboxState,
  type ModalSandboxStatus,
  type ModalTranscript,
  type ModalVolumeFile,
  type ModalVolumeWrite,
} from "../../backend/src/compute/adapters/modal_gateway";
import { NULL_PRICING } from "../../backend/src/compute/broker";
import { buildPlan, type PlanInput } from "../../backend/src/compute/plan";
import type { CredentialProvider } from "../../backend/src/connectors/base";
import { isProcessAlive } from "../../backend/src/simulation/run_store";
import { describeComputeContract, makeContractFixture } from "../helpers/compute_contract";

// CB-4 · Modal adapter（W5-2 α，「无 token 的降级交付」）。
//
// **这个文件里没有一次真实的 Modal 调用。** 交付边界见 DEVELOPMENT_PLAN_v0.5_MODULES.md
// §三·补.7：gateway 接口 + 录制层 + check() + 用**假 gateway** 过全部契约测试。
// 真实录制留到用户拿到 token 之后手动补一次（清单见 docs/devlog/W5-2-a.md）。
//
// 假 gateway 干的事：把「远端」这件事在本地演一遍——持久卷是一个目录、沙箱是一个
// 子进程、挂载点 /workspace 被翻译成那个目录。它足够真实到能撑起契约的每一条断言
// （审批链、一次性消费、跨实例接回、取消、收割、release），**但它不能证明 Modal
// 真的这样回话**——那件事只有真实录制能证明，所以有下面「约束三」的那道门禁。
//
// 凭据一律用假值，且从不进 repo 之外的任何地方（全局纪律：凭据永不入 repo/文档/命令行）。

const FAKE_TOKEN_ID = "modal-test-token-not-real";
const FAKE_TOKEN_SECRET = "modal-test-secret-not-real";

function creds(values: Record<string, string> | null): CredentialProvider {
  return {
    has: () => values !== null,
    get: (id) => (id === MODAL_CONNECTOR_ID && values ? { ...values } : null),
  };
}

// ── 假 gateway：本地演一遍「远端」 ─────────────────────────────────────────

interface FakeSandboxRecord {
  sandboxId: string;
  volumeName: string;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  state: ModalSandboxState;
  exitCode: number | null;
  tags: Record<string, string>;
}

class FakeModalCloud implements ModalGateway {
  constructor(private readonly root: string) {
    mkdirSync(join(root, "volumes"), { recursive: true });
    mkdirSync(join(root, "sandboxes"), { recursive: true });
    mkdirSync(join(root, "logs"), { recursive: true });
  }

  private volDir(name: string): string {
    return join(this.root, "volumes", name);
  }
  private sbxPath(id: string): string {
    return join(this.root, "sandboxes", `${id}.json`);
  }
  private logPath(id: string): string {
    return join(this.root, "logs", `${id}.log`);
  }
  private readRecord(id: string): FakeSandboxRecord | null {
    const path = this.sbxPath(id);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as FakeSandboxRecord;
  }
  private writeRecord(record: FakeSandboxRecord): void {
    writeFileSync(this.sbxPath(record.sandboxId), JSON.stringify(record, null, 2));
  }

  /** 「挂载」就是这一步：把 /workspace/... 翻译成本地卷目录。 */
  private mountTranslate(text: string, spec: ModalSandboxSpec): string {
    return text.split(spec.volumeMountPath).join(this.volDir(spec.volumeName));
  }

  async createSandbox(spec: ModalSandboxSpec): Promise<{ sandboxId: string; volumeName: string; startedAt: string }> {
    const sandboxId = `sb-${randomUUID().slice(0, 8)}`;
    const volDir = this.volDir(spec.volumeName);
    mkdirSync(volDir, { recursive: true });
    // 上一轮的终态标记必须清掉，否则接回时会看到旧的 exit-code（local adapter 同一条）。
    rmSync(join(volDir, MODAL_EXIT_MARKER), { force: true });

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(spec.env)) env[key] = this.mountTranslate(value, spec);
    // 密钥只在这一刻进子进程环境，和真实 Modal 的 Secret 注入同一位置。
    for (const [key, value] of Object.entries(spec.secretEnv)) env[key] = value;

    const argv = spec.command.map((a) => this.mountTranslate(a, spec));
    // stdout/stderr 落文件而不是 pipe：编排进程被 kill 之后 pipe 就没人读了。
    const out = openSync(this.logPath(sandboxId), "w");
    let pid: number | null = null;
    try {
      const proc = Bun.spawn(argv, {
        cwd: volDir,
        env,
        stdin: "ignore",
        stdout: out,
        stderr: out,
      });
      pid = proc.pid ?? null;
    } finally {
      closeSync(out);
    }
    const startedAt = new Date().toISOString();
    this.writeRecord({
      sandboxId,
      volumeName: spec.volumeName,
      pid,
      startedAt,
      finishedAt: null,
      state: "running",
      exitCode: null,
      tags: { ...spec.tags },
    });
    return { sandboxId, volumeName: spec.volumeName, startedAt };
  }

  async getSandbox(sandboxId: string): Promise<ModalSandboxStatus | null> {
    const record = this.readRecord(sandboxId);
    if (!record) return null;
    if (record.state === "cancelled" || record.state === "timeout") return this.view(record);
    const markerPath = join(this.volDir(record.volumeName), MODAL_EXIT_MARKER);
    if (existsSync(markerPath)) {
      const raw = readFileSync(markerPath, "utf8").trim();
      const code = /^\d+$/.test(raw) ? Number(raw) : null;
      record.exitCode = code;
      record.state = code === 0 ? "succeeded" : "failed";
      record.finishedAt = record.finishedAt ?? new Date(statSync(markerPath).mtimeMs).toISOString();
      this.writeRecord(record);
      return this.view(record);
    }
    if (isProcessAlive(record.pid)) return this.view(record);
    // 进程没了、标记也没有：控制面自己也说不清——**不许**读成 succeeded。
    record.state = "lost";
    record.finishedAt = record.finishedAt ?? new Date().toISOString();
    this.writeRecord(record);
    return this.view(record);
  }

  private view(record: FakeSandboxRecord): ModalSandboxStatus {
    return {
      sandboxId: record.sandboxId,
      state: record.state,
      exitCode: record.exitCode,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }

  async cancelSandbox(sandboxId: string): Promise<void> {
    const record = this.readRecord(sandboxId);
    if (!record) return;
    if (record.pid !== null && isProcessAlive(record.pid)) {
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {
        /* 竞态：刚好自己退了 */
      }
    }
    record.state = "cancelled";
    record.finishedAt = new Date().toISOString();
    this.writeRecord(record);
  }

  async readLogs(sandboxId: string, fromOffset: number): Promise<ModalLogChunk> {
    const path = this.logPath(sandboxId);
    if (!existsSync(path)) return { text: "", nextOffset: fromOffset };
    const buf = readFileSync(path);
    return { text: buf.subarray(fromOffset).toString("utf8"), nextOffset: buf.length };
  }

  async writeVolume(volumeName: string, files: readonly ModalVolumeWrite[]): Promise<void> {
    const volDir = this.volDir(volumeName);
    for (const file of files) {
      const dest = join(volDir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(file.contentBase64, "base64"));
      if (file.mode !== undefined) chmodSync(dest, file.mode);
    }
  }

  async readVolume(volumeName: string, globs: readonly string[]): Promise<readonly ModalVolumeFile[]> {
    const volDir = this.volDir(volumeName);
    if (!existsSync(volDir)) return [];
    const seen = new Map<string, ModalVolumeFile>();
    for (const pattern of globs) {
      const glob = new Bun.Glob(pattern);
      // dot:true —— gateway 是通用文件面，「点目录算不算产物」是 adapter 的事
      // （modal.ts 的 collect 会把 .spark/ 过滤掉）。
      for (const rel of glob.scanSync({ cwd: volDir, onlyFiles: true, dot: true })) {
        const posix = rel.split("\\").join("/");
        if (seen.has(posix)) continue;
        const content = readFileSync(join(volDir, rel));
        seen.set(posix, {
          path: posix,
          bytes: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          contentBase64: content.toString("base64"),
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async deleteVolume(volumeName: string): Promise<void> {
    rmSync(this.volDir(volumeName), { recursive: true, force: true });
  }

  async listByTag(tags: Readonly<Record<string, string>>): Promise<readonly ModalSandboxRef[]> {
    const dir = join(this.root, "sandboxes");
    const out: ModalSandboxRef[] = [];
    for (const entry of readdirSync(dir)) {
      const record = JSON.parse(readFileSync(join(dir, entry), "utf8")) as FakeSandboxRecord;
      if (Object.entries(tags).every(([k, v]) => record.tags[k] === v)) {
        out.push({ sandboxId: record.sandboxId, volumeName: record.volumeName, tags: record.tags });
      }
    }
    return out;
  }

  async probe(): Promise<ModalProbeResult> {
    return { ok: true, reason: null, detail: { gateway: "fake", realService: false } };
  }
}

const CLOUD_ROOT = mkdtempSync(join(tmpdir(), "modal-fake-cloud-"));

function makeFakeAdapter(): ModalComputeAdapter {
  return new ModalComputeAdapter({
    credentials: creds({ tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET }),
    gatewayFactory: () => new FakeModalCloud(CLOUD_ROOT),
    pollIntervalMs: 20,
  });
}

// ── ① 契约：与 local 逐字节相同的那一套断言 ────────────────────────────────
//
// AD-4 的验收方式：接口如果只有一个实现，它就不是接口。modal adapter 过的是
// tests/helpers/compute_contract.ts 里那份**同一套**断言，一条都没改、一条都没关。

describeComputeContract({
  name: "modal（假 gateway 回放；真实链路未验证）",
  makeAdapter: makeFakeAdapter,
  okCommand: (out) => ["/usr/bin/tee", out],
  failCommand: () => ["/usr/bin/false"],
  slowCommand: (seconds) => ["/bin/sleep", String(seconds)],
  secretEchoCommand: (envName) => ["/usr/bin/printenv", envName],
  timeoutMs: 30_000,
});

// ── ② 约束一：启用 Modal 必须零代码改动、零重新编译 ────────────────────────

describe("CB-4 约束一 · 「Modal 能不能用」只由运行期配置决定", () => {
  test("同一个 adapter 实例：凭据文件在运行期被写入后，答案当场改变（不重启、不重编译）", () => {
    const root = mkdtempSync(join(tmpdir(), "modal-cred-"));
    // 真的用 CredentialStore（§1.1.7：复用既有存储，不为 compute 另起一套）。
    const store = new CredentialStore({ root, warn: () => undefined });
    const adapter = new ModalComputeAdapter({
      credentials: store,
      gatewayFactory: () => new FakeModalCloud(CLOUD_ROOT),
    });

    const before = adapter.status();
    expect(before.availability).toBe("needs_credential");
    expect(before.credentialConfigured).toBe(false);

    // 用户唯一要做的动作：把 token 写进 ~/.spark-research/credentials.json 的 connectors.modal。
    store.set(MODAL_CONNECTOR_ID, { tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET });

    const after = adapter.status();
    expect(after.availability).toBe("available");
    expect(after.credentialConfigured).toBe(true);
    // 判定若来自任何编译期常量（或构造时缓存），这两次调用不可能给出不同答案。
    expect(after.availability).not.toBe(before.availability);
    rmSync(root, { recursive: true, force: true });
  });

  test("环境同样是运行期读的：config 变了，status() 当场跟着变", () => {
    let environment: string | null = null;
    const adapter = new ModalComputeAdapter({
      credentials: creds({ tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET }),
      config: () => ({ environment }),
      gatewayFactory: () => new FakeModalCloud(CLOUD_ROOT),
    });
    expect(adapter.status().environment).toBeNull();
    environment = "research";
    expect(adapter.status().environment).toBe("research");
  });

  test("凭据被撤掉后当场变回「未配置」（可用性不是单调的）", () => {
    let values: Record<string, string> | null = { tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET };
    const adapter = new ModalComputeAdapter({
      credentials: { has: () => values !== null, get: () => (values ? { ...values } : null) },
      gatewayFactory: () => new FakeModalCloud(CLOUD_ROOT),
    });
    expect(adapter.status().availability).toBe("available");
    values = null;
    expect(adapter.status().availability).toBe("needs_credential");
  });

  test("GPU 清单不参与可用性判定（它只收窄能选什么，别和被禁的 build-time 开关混为一谈）", () => {
    const adapter = new ModalComputeAdapter({ credentials: creds(null), gpus: [] });
    expect(adapter.capabilities().gpus).toEqual([]);
    // 没凭据 → 仍然是「未配置」，与 GPU 清单是否为空无关。
    expect(adapter.status().availability).toBe("needs_credential");
    expect(makeFakeAdapter().capabilities().gpus).toEqual([...MODAL_GPU_CATALOG]);
  });
});

// ── ③ 约束二：没配 token 的口径是「未配置」，不是「不可用」也不是「可用」 ───

describe("CB-4 约束二 · 未配置的口径与配置指引", () => {
  const bare = () => new ModalComputeAdapter({ credentials: creds(null), gatewayFactory: () => new FakeModalCloud(CLOUD_ROOT) });

  test("check() 如实报 credentialConfigured:false，且不报「可用」", async () => {
    const result = await bare().check();
    expect(result.ok).toBe(false);
    expect(result.detail.credentialConfigured).toBe(false);
    expect(result.detail.status).toBe("needs_credential");
    // 「可用」是 AD-12 明令禁止的形状（本仓库刚因为这个修了 V34 与二进制的「技能 0 个」）。
    expect(result.detail.status).not.toBe("available");
    // 「不可用」也不对：能力在、审批链在，只差一把钥匙——和 openmm 没装不是一回事。
    expect(result.detail.status).not.toBe("unavailable");
    expect(String(result.reason)).toContain("未配置");
  });

  test("配置指引说全「该做什么」：凭据文件 + 字段名 + 0600 + config.json 的两个键 + 不必改代码", async () => {
    const report = bare().status();
    const guidance = report.howToConfigure.join("\n");
    expect(report.howToConfigure.length).toBeGreaterThan(0);
    expect(guidance).toContain("credentials.json");
    expect(guidance).toContain(`connectors.${MODAL_CONNECTOR_ID}`);
    expect(guidance).toContain("tokenId");
    expect(guidance).toContain("tokenSecret");
    expect(guidance).toContain("chmod 600");
    expect(guidance).toContain("config.json");
    expect(guidance).toContain("computeTarget");
    expect(guidance).toContain("modalEnvironment");
    expect(guidance).toContain("不需要改代码");
    // 如实告知：本版本只填 token 还跑不起来（真实 gateway 未实现）。
    const noTransport = new ModalComputeAdapter({ credentials: creds(null) }).status();
    expect(noTransport.howToConfigure.join("\n")).toContain("真实 gateway");
  });

  test("只配了一半：missingKeys 精确到字段名，且消息里没有任何凭据值", () => {
    const half = new ModalComputeAdapter({
      credentials: creds({ tokenId: FAKE_TOKEN_ID }),
      gatewayFactory: () => new FakeModalCloud(CLOUD_ROOT),
    });
    const report = half.status();
    expect(report.availability).toBe("needs_credential");
    expect(report.missingKeys).toEqual(["tokenSecret"]);
    const text = [report.reason ?? "", ...report.howToConfigure].join("\n");
    expect(text).not.toContain(FAKE_TOKEN_ID);
    expect(text).not.toContain(FAKE_TOKEN_SECRET);
  });

  test("凭据齐了但真实 gateway 没接线 → 报 unavailable（**不许**报 available）", async () => {
    const wired = new ModalComputeAdapter({
      credentials: creds({ tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET }),
      gatewayFactory: null,
    });
    const report = wired.status();
    expect(report.credentialConfigured).toBe(true);
    expect(report.transport).toBe("not_wired");
    expect(report.availability).toBe("unavailable");
    expect(report.availability).not.toBe("available");
    expect(String(report.reason)).toContain("真实 gateway 尚未实现");
    const check = await wired.check();
    expect(check.ok).toBe(false);
    expect(check.detail.transport).toBe("not_wired");
  });

  test("未配置时派发会当场失败，且失败消息自带配置指引（不产生任何远端资源）", async () => {
    const adapter = new ModalComputeAdapter({ credentials: creds(null), gatewayFactory: () => new FakeModalCloud(CLOUD_ROOT) });
    const fx = makeContractFixture(adapter);
    const planned = await fx.broker.plan(fx.planInput({ command: ["/usr/bin/tee", "out.txt"] }), {
      projectSlug: "contract",
    });
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);
    expect(ran.lifecycle.execution).toBe("failed");
    expect(ran.message).toContain("未配置");
    expect(ran.message).toContain("credentials.json");
    expect(existsSync(join(CLOUD_ROOT, "volumes", modalVolumeName(planned.jobId)))).toBe(false);
  }, 30_000);

  test("check() 在配齐之后才走真实探测（探测本身零副作用）", async () => {
    const result = await makeFakeAdapter().check();
    expect(result.ok).toBe(true);
    expect(result.detail.credentialConfigured).toBe(true);
    expect(result.detail.status).toBe("available");
    // 假 gateway 如实自报家门——这条 detail 就是「别把绿色当成真实链路」的提醒。
    expect(result.detail.realService).toBe(false);
  });
});

// ── ④ modal adapter 的自有行为 ────────────────────────────────────────────

describe("CB-4 · modal adapter 的自有行为", () => {
  test("只有 plan.uploads 点名的文件会上卷；shim 是常量、被审批的 argv 不再经过一次 shell 展开", async () => {
    const fx = makeContractFixture(makeFakeAdapter());
    writeFileSync(join(fx.workspaceRoot, "not-requested.txt"), "should stay home\n");
    const planned = await fx.broker.plan(
      fx.planInput({ command: ["/bin/echo", "$(id -u) && rm -rf /"], outputs: [] }),
      { projectSlug: "contract" },
    );
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);
    expect(ran.lifecycle.execution).toBe("succeeded");

    const volDir = join(CLOUD_ROOT, "volumes", modalVolumeName(planned.jobId));
    expect(existsSync(join(volDir, "input.txt"))).toBe(true);
    expect(existsSync(join(volDir, "not-requested.txt"))).toBe(false);
    const shim = readFileSync(join(volDir, MODAL_RUNNER_SHIM), "utf8");
    expect(shim).toBe(MODAL_SHIM_SOURCE);
    expect(shim).not.toContain("id -u");
    await fx.broker.collect(ran.jobId);
    expect(readFileSync(join(ran.jobDir, RUN_LOG), "utf8")).toContain("$(id -u) && rm -rf /");
  }, 30_000);

  test("handle 带着 sandboxId/volumeName/tags，且里面没有任何凭据", async () => {
    const fx = makeContractFixture(makeFakeAdapter());
    const planned = await fx.broker.plan(fx.planInput({ command: ["/usr/bin/tee", "out.txt"] }), {
      projectSlug: "contract",
    });
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);
    const data = ran.adapterHandle!.data;
    expect(ran.adapterHandle!.kind).toBe("modal");
    expect(String(data.sandboxId)).toMatch(/^sb-/);
    expect(data.volumeName).toBe(modalVolumeName(planned.jobId));
    expect(JSON.parse(String(data.tags)).planDigest).toBe(planned.plan.digest);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(FAKE_TOKEN_ID);
    expect(serialized).not.toContain(FAKE_TOKEN_SECRET);
  }, 30_000);

  test("recover() 先看卷上的 exit 标记再看控制面：控制面记错了也以任务侧为准", async () => {
    const adapter = makeFakeAdapter();
    const fx = makeContractFixture(adapter);
    const planned = await fx.broker.plan(fx.planInput({ command: ["/usr/bin/tee", "out.txt"] }), {
      projectSlug: "contract",
    });
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);

    // 把控制面那条记录改成「还在跑」——卷上的标记应当压过它。
    const sbxPath = join(CLOUD_ROOT, "sandboxes", `${String(ran.adapterHandle!.data.sandboxId)}.json`);
    const record = JSON.parse(readFileSync(sbxPath, "utf8"));
    writeFileSync(sbxPath, JSON.stringify({ ...record, state: "running", exitCode: null, pid: 999_999 }));

    const spec = { jobId: ran.jobId, plan: ran.plan, jobDir: ran.jobDir };
    const result = await adapter.recover(spec, ran.adapterHandle!, {});
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("卷上没标记、控制面也查不到 → RecoverFailure(not_found)，**不许**猜成功", async () => {
    const adapter = makeFakeAdapter();
    const fx = makeContractFixture(adapter);
    const planned = await fx.broker.plan(fx.planInput({ command: ["/usr/bin/tee", "out.txt"] }), {
      projectSlug: "contract",
    });
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);

    rmSync(join(CLOUD_ROOT, "volumes", modalVolumeName(planned.jobId), MODAL_EXIT_MARKER), { force: true });
    rmSync(join(CLOUD_ROOT, "sandboxes", `${String(ran.adapterHandle!.data.sandboxId)}.json`), { force: true });
    const spec = { jobId: ran.jobId, plan: ran.plan, jobDir: ran.jobDir };
    await expect(adapter.recover(spec, ran.adapterHandle!, {})).rejects.toThrow(/not_found|查不到/);
  }, 30_000);

  test("收割对账：控制面与任务侧退出码打架 → reconcileError 非空（delivery 标 failed）", async () => {
    const adapter = makeFakeAdapter();
    const fx = makeContractFixture(adapter);
    const planned = await fx.broker.plan(
      fx.planInput({ command: ["/usr/bin/tee", "out.txt"], outputs: ["out.txt"] }),
      { projectSlug: "contract" },
    );
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);

    const sbxPath = join(CLOUD_ROOT, "sandboxes", `${String(ran.adapterHandle!.data.sandboxId)}.json`);
    const record = JSON.parse(readFileSync(sbxPath, "utf8"));
    // 控制面说「被杀了，137」，任务侧的标记却写着 0——真实世界里这是抢占/OOM 后
    // 最容易出现的一种分歧，也正是「不许猜」的那条纪律要接住的场景。
    writeFileSync(sbxPath, JSON.stringify({ ...record, state: "cancelled", exitCode: 137 }));

    const { job, harvest } = await fx.broker.collect(ran.jobId);
    expect(harvest.reconcileError).toContain("退出码对不上");
    expect(job.lifecycle.delivery).toBe("failed");
  }, 30_000);

  test("release 删远端卷，但本地 harvest/ 与 run.log 一个都不动", async () => {
    const fx = makeContractFixture(makeFakeAdapter());
    const planned = await fx.broker.plan(
      fx.planInput({ command: ["/usr/bin/tee", "out.txt"], outputs: ["out.txt"] }),
      { projectSlug: "contract" },
    );
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);
    await fx.broker.collect(ran.jobId);
    const released = await fx.broker.release(ran.jobId);
    expect(existsSync(join(CLOUD_ROOT, "volumes", modalVolumeName(planned.jobId)))).toBe(false);
    expect(existsSync(join(released.jobDir, "harvest", "out.txt"))).toBe(true);
    expect(existsSync(join(released.jobDir, RUN_LOG))).toBe(true);
  }, 30_000);

  test("墙钟超时：deadline 过了就终止并如实报 timedOut（不假装它还在跑）", async () => {
    const adapter = makeFakeAdapter();
    const fx = makeContractFixture(adapter);
    const planned = await fx.broker.plan(fx.planInput({ command: ["/bin/sleep", "30"], outputs: [] }), {
      projectSlug: "contract",
    });
    fx.approval.approve(planned.jobId, { actor: "测试员" });

    // 直接对 adapter 做单元级验证：把 handle 的 startedAt 拨到很久以前，
    // awaitTerminal 的 deadline 从它起算，于是这一轮就该判超时。
    // （不引入任何「测试专用的超时倍率」开关：那种开关就是后门。）
    const gateway = new FakeModalCloud(CLOUD_ROOT);
    const jobDir = fx.jobs.dirOf(planned.jobId);
    const volumeName = modalVolumeName(`${planned.jobId}-timeout`);
    await gateway.writeVolume(volumeName, [
      { path: MODAL_RUNNER_SHIM, contentBase64: Buffer.from(MODAL_SHIM_SOURCE).toString("base64"), mode: 0o700 },
    ]);
    const created = await gateway.createSandbox({
      appName: "spark-research",
      environment: null,
      image: null,
      command: ["/bin/sh", `${MODAL_VOLUME_MOUNT}/${MODAL_RUNNER_SHIM}`, "/bin/sleep", "30"],
      workdir: MODAL_VOLUME_MOUNT,
      volumeName,
      volumeMountPath: MODAL_VOLUME_MOUNT,
      env: { SPARK_COMPUTE_EXIT_FILE: `${MODAL_VOLUME_MOUNT}/${MODAL_EXIT_MARKER}` },
      secretEnv: {},
      gpu: null,
      cpus: 1,
      memoryGb: 1,
      timeoutSeconds: 1800,
      network: "none",
      tags: {},
    });
    const handle = {
      kind: "modal" as const,
      data: {
        sandboxId: created.sandboxId,
        volumeName,
        appName: "spark-research",
        environment: null,
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
        tags: "{}",
      },
    };
    const timedOutAdapter = new ModalComputeAdapter({
      credentials: creds({ tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET }),
      gatewayFactory: () => gateway,
      pollIntervalMs: 20,
    });
    const result = await timedOutAdapter.recover({ jobId: planned.jobId, plan: planned.plan, jobDir }, handle, {});
    expect(result.timedOut).toBe(true);
    expect((await gateway.getSandbox(created.sandboxId))!.state).toBe("cancelled");
  }, 30_000);

  test("listByTag 按 jobId 找得回沙箱（重启后靠 tag 兜底的那条路）", async () => {
    const fx = makeContractFixture(makeFakeAdapter());
    const planned = await fx.broker.plan(fx.planInput({ command: ["/usr/bin/tee", "out.txt"] }), {
      projectSlug: "contract",
    });
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);
    const found = await new FakeModalCloud(CLOUD_ROOT).listByTag({ jobId: planned.jobId });
    expect(found.map((f) => f.sandboxId)).toEqual([String(ran.adapterHandle!.data.sandboxId)]);
  }, 30_000);
});

// ── ⑤ 录制层：redaction 与回放 ────────────────────────────────────────────

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/compute/modal");
const SMOKE_FIXTURE = join(FIXTURE_DIR, "sandbox-run.fake.json");

/**
 * 录制回放用的脚本 gateway：确定性地演一遍「一次成功的运行」。
 * 它比 FakeModalCloud 更简单也更死板——录制文件要能逐字节复现，就不能带进程调度的抖动。
 */
class ScriptedModalGateway implements ModalGateway {
  private readonly volumes = new Map<string, Map<string, string>>();
  private log = "";
  private readonly sandboxId = "sb-fixture-0001";
  private readonly startedAt = "2026-09-10T00:00:00.000Z";
  private readonly finishedAt = "2026-09-10T00:00:02.000Z";

  async createSandbox(spec: ModalSandboxSpec) {
    const vol = this.volumes.get(spec.volumeName) ?? new Map<string, string>();
    // 「跑完了」：任务侧写下 exit 标记与产物，stdout 进日志。
    vol.set(MODAL_EXIT_MARKER, Buffer.from("0").toString("base64"));
    vol.set("out.txt", Buffer.from("hello compute\n").toString("base64"));
    this.volumes.set(spec.volumeName, vol);
    this.log = "hello compute\n";
    return { sandboxId: this.sandboxId, volumeName: spec.volumeName, startedAt: this.startedAt };
  }
  async getSandbox(sandboxId: string): Promise<ModalSandboxStatus | null> {
    return {
      sandboxId,
      state: "succeeded",
      exitCode: 0,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }
  async cancelSandbox(): Promise<void> {}
  async readLogs(_id: string, fromOffset: number): Promise<ModalLogChunk> {
    const buf = Buffer.from(this.log);
    return { text: buf.subarray(fromOffset).toString("utf8"), nextOffset: buf.length };
  }
  async writeVolume(volumeName: string, files: readonly ModalVolumeWrite[]): Promise<void> {
    const vol = this.volumes.get(volumeName) ?? new Map<string, string>();
    for (const file of files) vol.set(file.path, file.contentBase64);
    this.volumes.set(volumeName, vol);
  }
  async readVolume(volumeName: string, globs: readonly string[]): Promise<readonly ModalVolumeFile[]> {
    const vol = this.volumes.get(volumeName) ?? new Map<string, string>();
    const out: ModalVolumeFile[] = [];
    for (const [path, contentBase64] of vol) {
      if (!globs.some((g) => new Bun.Glob(g).match(path))) continue;
      const content = Buffer.from(contentBase64, "base64");
      out.push({
        path,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        contentBase64,
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  async deleteVolume(volumeName: string): Promise<void> {
    this.volumes.delete(volumeName);
  }
  async listByTag(): Promise<readonly ModalSandboxRef[]> {
    return [];
  }
  async probe(): Promise<ModalProbeResult> {
    return { ok: true, reason: null, detail: { gateway: "scripted", realService: false } };
  }
}

/** 固定 jobId / 固定上传内容 → plan.digest 与 gateway 请求体逐字节确定。 */
const FIXTURE_JOB_ID = "cj-fixture-0001";

function fixtureSpec(jobDir: string, secretEnv = false) {
  const workspace = join(jobDir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "input.txt"), "hello compute\n");
  const content = Buffer.from("hello compute\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const planInput: PlanInput = {
    target: { kind: "modal" },
    purpose: "录制回放骨架",
    command: ["/usr/bin/tee", "out.txt"],
    env: {},
    image: null,
    secretRefs: secretEnv ? ["demo"] : [],
    resources: { gpu: null, cpus: 1, memoryGb: 1, timeoutMinutes: 5 },
    network: "unrestricted",
    uploads: [{ path: "input.txt", size: content.length, sha256 }],
    outputs: ["out.txt"],
    workspaceRoot: workspace,
  };
  const plan = buildPlan(planInput, makeFakeAdapter().capabilities(), NULL_PRICING);
  return {
    jobId: FIXTURE_JOB_ID,
    plan,
    jobDir,
    resolveSecret: (_ref: string) => ({ DEMO_SECRET: "s3cr3t-needle-do-not-persist" }),
  };
}

async function recordFixtureRun(): Promise<ModalTranscript> {
  const jobDir = mkdtempSync(join(tmpdir(), "modal-record-"));
  const recorder = new RecordingModalGateway(new ScriptedModalGateway(), {
    provenance: "fake-gateway",
    note: "从脚本 gateway 录的确定性回放骨架。**不是**真实 Modal 流量：拿到 token 后必须补一份 provenance:'real-modal' 的录制。",
  });
  const adapter = new ModalComputeAdapter({
    credentials: creds({ tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET }),
    gatewayFactory: () => recorder,
    pollIntervalMs: 1,
  });
  const spec = fixtureSpec(jobDir);
  const result = await adapter.run(spec, {});
  await adapter.collect({ jobId: spec.jobId, plan: spec.plan, jobDir }, result.handle);
  rmSync(jobDir, { recursive: true, force: true });
  return recorder.transcript(() => "2026-09-10T00:00:00.000Z");
}

describe("CB-4 录制层 · redaction 与回放", () => {
  test("录制里绝不出现密钥：secretEnv 只留字段名，日志里的密钥值也被抹掉", async () => {
    const needle = "s3cr3t-needle-do-not-persist";
    const jobDir = mkdtempSync(join(tmpdir(), "modal-redact-"));
    const scripted = new ScriptedModalGateway();
    const recorder = new RecordingModalGateway(scripted, { provenance: "fake-gateway", note: "redaction 用例" });
    const adapter = new ModalComputeAdapter({
      credentials: creds({ tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET }),
      gatewayFactory: () => recorder,
      pollIntervalMs: 1,
    });
    const spec = fixtureSpec(jobDir, true);
    await adapter.run(spec, {});
    // 日志这条路最容易漏：任务自己 echo 一下密钥，就录进 fixture 了。
    await recorder.readLogs("sb-fixture-0001", 0).catch(() => undefined);
    const text = JSON.stringify(recorder.transcript());
    expect(text).not.toContain(needle);
    expect(text).toContain("redactedKeys");
    expect(text).toContain("DEMO_SECRET"); // 字段名留着，值没了
    rmSync(jobDir, { recursive: true, force: true });
  });

  test("录制文件必须自报 provenance：没有它，回放出来的绿色没有意义", () => {
    expect(() => parseModalTranscript(JSON.stringify({ schemaVersion: 1, entries: [] }))).toThrow(/provenance/);
    const parsed = parseModalTranscript(readFileSync(SMOKE_FIXTURE, "utf8"));
    expect(parsed.provenance).toBe("fake-gateway");
  });

  test("回放：committed fixture 能原样驱动一次成功的 run + collect，且整份录制被跑完", async () => {
    const transcript = parseModalTranscript(readFileSync(SMOKE_FIXTURE, "utf8"));
    const replay = new RecordedModalGateway(transcript);
    const adapter = new ModalComputeAdapter({
      credentials: creds({ tokenId: FAKE_TOKEN_ID, tokenSecret: FAKE_TOKEN_SECRET }),
      gatewayFactory: () => replay,
      pollIntervalMs: 1,
    });
    const jobDir = mkdtempSync(join(tmpdir(), "modal-replay-"));
    const spec = fixtureSpec(jobDir);
    const result = await adapter.run(spec, {});
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const harvest = await adapter.collect({ jobId: spec.jobId, plan: spec.plan, jobDir }, result.handle);
    expect(harvest.reconcileError).toBeNull();
    expect(harvest.files.map((f) => f.path)).toEqual(["out.txt"]);
    expect(readFileSync(join(jobDir, "harvest", "out.txt"), "utf8")).toBe("hello compute\n");
    expect(replay.remaining).toBe(0);
    rmSync(jobDir, { recursive: true, force: true });
  });

  test("fixture 与当前 adapter 的调用序列一致（重录一遍应当逐条相同）", async () => {
    // 重录：`MODAL_FIXTURE_MODE=record bun test tests/unit/compute_modal.test.ts`
    // （沿用 http/fixture.ts 的 record/replay 约定；这里的「record」录的仍然是**脚本
    // gateway**，不是 Modal——真实录制要等 token，见 docs/devlog/W5-2-a.md）。
    const fresh = await recordFixtureRun();
    if (process.env.MODAL_FIXTURE_MODE === "record") {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(SMOKE_FIXTURE, JSON.stringify(fresh, null, 2) + "\n");
    }
    const committed = parseModalTranscript(readFileSync(SMOKE_FIXTURE, "utf8"));
    expect(fresh.entries).toEqual(committed.entries);
  });

  test("回放对不上就报错，不「大概是这条吧」", async () => {
    const transcript = parseModalTranscript(readFileSync(SMOKE_FIXTURE, "utf8"));
    const replay = new RecordedModalGateway(transcript);
    await expect(replay.getSandbox("sb-does-not-exist")).rejects.toThrow(/录制里没有匹配/);
  });
});

// ── ⑥ 约束三：假 gateway 不许成为永久替身 ─────────────────────────────────

describe("CB-4 约束三 · 「等真实录制」这笔债必须一直在册", () => {
  const PARITY = join(import.meta.dir, "narrative_parity.test.ts");
  const MARKER = "等真实录制";

  test("只要 fixture 里还没有一份真实录制，narrative_parity 里的「等真实录制」登记就必须在", () => {
    const transcripts = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => parseModalTranscript(readFileSync(join(FIXTURE_DIR, f), "utf8")));
    expect(transcripts.length).toBeGreaterThan(0);
    const hasReal = transcripts.some((t) => t.provenance === "real-modal");
    const registered = readFileSync(PARITY, "utf8").includes(MARKER);

    if (!hasReal) {
      expect(
        registered,
        `tests/fixtures/compute/modal 里一份真实录制都没有（全是 provenance:"fake-gateway"），\n` +
          `那么 tests/unit/narrative_parity.test.ts 里必须留着「${MARKER}」这条登记。\n` +
          `它是**唯一**一处会提醒发布前「Modal 的真实链路从未验证过」的地方——\n` +
          `删掉它，假 gateway 就会活到发布（设计 §三·补.7 约束三）。\n` +
          `注：如果是因为 lane β 接线导致 ALLOWED_ORPHANS 条目被移除，请照本仓库既有做法\n` +
          `把这条债以「曾在此登记 / 仍欠一次真实录制」的注释形式留在同一个文件里。`,
      ).toBe(true);
    } else {
      expect(
        registered,
        `已经有 provenance:"real-modal" 的录制了——请把 narrative_parity 里的「${MARKER}」登记删掉（对称检查）。`,
      ).toBe(false);
    }
  });

  test("adapter 自己也如实说：description 不宣称「支持 Modal」", () => {
    const adapter = makeFakeAdapter();
    expect(adapter.description).toContain("真实链路未验证");
  });
});
