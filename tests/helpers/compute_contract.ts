import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeApproval, ApprovalRequiredError } from "../../backend/src/compute/approval";
import {
  ComputeBroker,
  ComputeDispatchConflictError,
  NULL_PRICING,
  computeJobsRoot,
} from "../../backend/src/compute/broker";
import { ComputeJobStore } from "../../backend/src/compute/job_store";
import type { PlanInput } from "../../backend/src/compute/plan";
import type { ComputeAdapter } from "../../backend/src/compute/target";
import { UploadChangedError, collectUploads } from "../../backend/src/compute/uploads";
import type { CredentialProvider } from "../../backend/src/connectors/base";
import { ProjectManager } from "../../backend/src/project/manager";

// CB-1 契约测试套件（设计 §1.1.1 / §6.1 任务 9；形状照 tests/helpers/simulation_contract.ts）。
//
// **同一组断言参数化跑在每个 ComputeAdapter 上**。这是 AD-4 的验收方式：接口如果只有
// 一个实现，它就不是接口，只是那个实现的类型签名。CB-4 的 modal adapter 要过的是
// 与 local 逐字节相同的这套断言（录制回放档）。
//
// 这套断言里**没有任何一条**可以在「跳过审批」的前提下通过——审批链是契约本身的一部分
// （K-2）：任何 adapter 的产品化路径都必须是 plan → review → approve → dispatch（消费）。

export interface ComputeContractCase {
  name: string;
  /** 每次调用产出一个全新的 adapter 实例（跨实例接回的用例要用）。 */
  makeAdapter: () => ComputeAdapter;
  /** 秒级完成、并把 stdout 写进某个产物文件的 argv。 */
  okCommand: (outputName: string) => string[];
  /** 非零退出的 argv。 */
  failCommand: () => string[];
  /** 跑得够久、够我们在运行中做断言的 argv（秒）。 */
  slowCommand: (seconds: number) => string[];
  /** 把某个 env 变量的值打到 stdout 的 argv——用来验证「密钥到了子进程但不落盘」。 */
  secretEchoCommand?: (envName: string) => string[];
  /** 收割超时（毫秒）。 */
  timeoutMs: number;
  skip?: boolean;
  skipReason?: string;
}

export interface ContractFixture {
  broker: ComputeBroker;
  jobs: ComputeJobStore;
  approval: ComputeApproval;
  workspaceRoot: string;
  jobsRoot: string;
  records: ReturnType<ReturnType<ProjectManager["create"]>["records"]>;
  planInput: (over?: Partial<PlanInput>) => PlanInput;
}

let seq = 0;

export function makeContractFixture(
  adapter: ComputeAdapter,
  options: { secrets?: Record<string, Record<string, string>>; admissionLimit?: number } = {},
): ContractFixture {
  const root = mkdtempSync(join(tmpdir(), `compute-contract-${seq++}-`));
  const manager = new ProjectManager(join(root, "workspace"));
  const project = manager.create("contract");
  const jobsRoot = computeJobsRoot(project.paths.experimentsDir);
  const jobs = new ComputeJobStore(jobsRoot);
  const records = project.records();
  const approval = new ComputeApproval({ records, jobs, sessionId: "contract" });
  const credentials: CredentialProvider = {
    has: (id) => Boolean(options.secrets?.[id]),
    get: (id) => options.secrets?.[id] ?? null,
  };
  const broker = new ComputeBroker({
    jobs,
    adapters: { [adapter.kind]: adapter },
    approval,
    credentials,
    pricing: NULL_PRICING,
    admissionLimit: options.admissionLimit ?? 2,
  });

  const workspaceRoot = join(root, "src");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "input.txt"), "hello compute\n");

  const planInput = (over: Partial<PlanInput> = {}): PlanInput => ({
    target: { kind: adapter.kind } as PlanInput["target"],
    purpose: "契约测试",
    command: ["/bin/echo", "ok"],
    env: {},
    image: null,
    secretRefs: [],
    resources: { gpu: null, cpus: 1, memoryGb: 1, timeoutMinutes: 5 },
    // 默认要审批：契约测试的主干是审批链，不是「怎么绕过它」。
    network: "unrestricted",
    uploads: collectUploads(workspaceRoot, ["input.txt"]).entries,
    outputs: ["out.txt"],
    workspaceRoot,
    ...over,
  });

  return { broker, jobs, approval, workspaceRoot, jobsRoot, records, planInput };
}

export function describeComputeContract(config: ComputeContractCase): void {
  const suite = config.skip ? describe.skip : describe;
  suite(`ComputeAdapter 契约 · ${config.name}${config.skipReason ? `（${config.skipReason}）` : ""}`, () => {
    test("capabilities() 自洽：network 非空、上传限额为正、gpus 是数组", () => {
      const caps = config.makeAdapter().capabilities();
      expect(caps.network.length).toBeGreaterThan(0);
      expect(caps.uploadLimits.count).toBeGreaterThan(0);
      expect(caps.uploadLimits.bytes).toBeGreaterThan(0);
      expect(Array.isArray(caps.gpus)).toBe(true);
    });

    test("plan() 零副作用地停在 awaiting_approval，且 warning 明文写清「用谁的账户、上界多少」", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const job = await fx.broker.plan(fx.planInput(), { projectSlug: "contract" });
      expect(job.lifecycle.execution).toBe("awaiting_approval");
      expect(job.plan.approvalRequired).toBe(true);
      expect(job.plan.warning).not.toBe("");
      expect(job.approval).toBeNull();
      // 零副作用：没有 decision record、没有 adapterHandle。
      expect(fx.records.list({ type: "decision" })).toHaveLength(0);
      expect(job.adapterHandle).toBeNull();
    });

    test("digest 排除 workspaceRoot，但包含 command / estimate", async () => {
      const fxA = makeContractFixture(config.makeAdapter());
      const a = await fxA.broker.plan(fxA.planInput(), { projectSlug: "contract" });
      const fxB = makeContractFixture(config.makeAdapter());
      // 同样的内容、不同的绝对路径 → 同一个 digest。
      const bInput = fxB.planInput({
        uploads: a.plan.uploads,
      });
      const b = await fxB.broker.plan(bInput, { projectSlug: "contract" });
      expect(b.plan.digest).toBe(a.plan.digest);

      const c = await fxB.broker.plan(fxB.planInput({ command: ["/bin/echo", "different"], uploads: a.plan.uploads }), {
        projectSlug: "contract",
      });
      expect(c.plan.digest).not.toBe(a.plan.digest);
    });

    test("未经 approve 不能派发（AD-6 同构）", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const job = await fx.broker.plan(fx.planInput(), { projectSlug: "contract" });
      await expect(fx.broker.dispatch(job.jobId)).rejects.toThrow(ApprovalRequiredError);
      expect(fx.jobs.get(job.jobId).lifecycle.execution).toBe("awaiting_approval");
    });

    test("完整审批链：plan → approve（落 decision）→ dispatch（消费）→ succeeded → collect", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(
        fx.planInput({ command: config.okCommand("out.txt"), outputs: ["out.txt"] }),
        { projectSlug: "contract" },
      );
      const { job: approved, decisionId } = fx.approval.approve(planned.jobId, {
        actor: "契约测试员",
        note: "跑一次",
      });
      expect(approved.lifecycle.execution).toBe("approved");
      expect(approved.approval?.planDigest).toBe(planned.plan.digest);

      const decision = fx.records.get(decisionId)!;
      expect(decision.type).toBe("decision");
      expect(decision.evidence).toBe("inferred");
      expect(decision.origin.kind).toBe("manual");
      expect(decision.metadata.kind).toBe("approval");
      expect(decision.metadata.planDigest).toBe(planned.plan.digest);
      expect(decision.metadata.jobId).toBe(planned.jobId);
      expect(decision.metadata.warningShown).toBe(true);

      const ran = await fx.broker.dispatch(approved.jobId);
      expect(ran.lifecycle.execution).toBe("succeeded");
      expect(ran.exitCode).toBe(0);
      // 一次性消费：approval 已经不在，consumedApproval 留档。
      expect(ran.approval).toBeNull();
      expect(ran.consumedApproval?.decisionRecordId).toBe(decisionId);
      // 终态但还没收割 → 远端持有唯一副本。
      expect(ran.lifecycle.recoverable).toBe(true);

      const { job: collected, harvest } = await fx.broker.collect(ran.jobId);
      expect(harvest.reconcileError).toBeNull();
      expect(harvest.files.map((f) => f.path)).toContain("out.txt");
      expect(collected.lifecycle.delivery).toBe("complete");
      expect(collected.lifecycle.recoverable).toBe(false);
      expect(existsSync(join(collected.jobDir, "harvest", "out.txt"))).toBe(true);
    }, config.timeoutMs);

    test("approval 只能消费一次：dispatch 之后再 dispatch 必须拒（不许凭旧审批重派）", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(fx.planInput({ command: config.okCommand("out.txt") }), {
        projectSlug: "contract",
      });
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      await fx.broker.dispatch(planned.jobId);
      await expect(fx.broker.dispatch(planned.jobId)).rejects.toThrow(ApprovalRequiredError);
    }, config.timeoutMs);

    test("上传清单在审批之后被改一个字节 → dispatch 必须拒（input_changed）", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(fx.planInput({ command: config.okCommand("out.txt") }), {
        projectSlug: "contract",
      });
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      writeFileSync(join(fx.workspaceRoot, "input.txt"), "hello computf\n"); // 同长度，一个字节之差
      await expect(fx.broker.dispatch(planned.jobId)).rejects.toThrow(UploadChangedError);
    });

    test("只有 plan.uploads 里的文件会进工作区（没点名的不会跟着走）", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      writeFileSync(join(fx.workspaceRoot, "not-requested.txt"), "should stay home\n");
      const planned = await fx.broker.plan(fx.planInput({ command: config.okCommand("out.txt") }), {
        projectSlug: "contract",
      });
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      const ran = await fx.broker.dispatch(planned.jobId);
      expect(existsSync(join(ran.jobDir, "workspace", "input.txt"))).toBe(true);
      expect(existsSync(join(ran.jobDir, "workspace", "not-requested.txt"))).toBe(false);
    }, config.timeoutMs);

    test("失败的任务如实标 failed，且仍可收割（日志与残留产物是排查的全部依据）", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(fx.planInput({ command: config.failCommand(), outputs: ["out.txt"] }), {
        projectSlug: "contract",
      });
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      const ran = await fx.broker.dispatch(planned.jobId);
      expect(ran.lifecycle.execution).toBe("failed");
      expect(ran.exitCode).not.toBe(0);
      const { harvest } = await fx.broker.collect(ran.jobId);
      expect(harvest.exitCode).not.toBe(0);
      expect(existsSync(harvest.logPath)).toBe(true);
    }, config.timeoutMs);

    test("reject 落 decision record、approval 置 null、任务终结在 rejected", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(fx.planInput(), { projectSlug: "contract" });
      const { job, decisionId } = fx.approval.reject(planned.jobId, { actor: "把关的人", reason: "上传里有原始数据" });
      expect(job.lifecycle.execution).toBe("rejected");
      expect(job.approval).toBeNull();
      expect(job.rejection?.reason).toBe("上传里有原始数据");
      expect(fx.records.get(decisionId)!.metadata.decision).toBe("reject");
      await expect(fx.broker.dispatch(planned.jobId)).rejects.toThrow(ApprovalRequiredError);
    });

    test("plan 在审批之后被换掉（replan）→ 旧 approval 作废，必须重新批", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(fx.planInput({ command: config.okCommand("out.txt") }), {
        projectSlug: "contract",
      });
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      const replanned = await fx.broker.replan(
        planned.jobId,
        fx.planInput({ command: config.okCommand("other.txt"), outputs: ["other.txt"] }),
      );
      expect(replanned.approval).toBeNull();
      expect(replanned.supersededApproval?.actor).toBe("契约测试员");
      expect(replanned.lifecycle.execution).toBe("awaiting_approval");
      await expect(fx.broker.dispatch(planned.jobId)).rejects.toThrow(ApprovalRequiredError);
    });

    test("编排进程重启后接回：新 broker 实例按 adapterHandle 走 recover()", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(
        fx.planInput({ command: config.okCommand("out.txt"), outputs: ["out.txt"] }),
        { projectSlug: "contract" },
      );
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      const ran = await fx.broker.dispatch(planned.jobId);
      expect(ran.lifecycle.execution).toBe("succeeded");

      // 「重启」：全新的 store + broker + adapter，只有磁盘是共享的。
      const jobs2 = new ComputeJobStore(fx.jobsRoot);
      const adapter2 = config.makeAdapter();
      const broker2 = new ComputeBroker({
        jobs: jobs2,
        adapters: { [adapter2.kind]: adapter2 },
        approval: new ComputeApproval({ records: fx.records, jobs: jobs2 }),
        credentials: { has: () => false, get: () => null },
        pricing: NULL_PRICING,
      });
      const reread = broker2.poll(planned.jobId);
      expect(reread.lifecycle.execution).toBe("succeeded");
      // 重启后 approval 已经不在——想再跑一次必须重新批（D-10 同构）。
      expect(reread.approval).toBeNull();
      await expect(broker2.dispatch(planned.jobId)).rejects.toThrow(ApprovalRequiredError);
      const { harvest } = await broker2.collect(planned.jobId);
      expect(harvest.files.map((f) => f.path)).toContain("out.txt");
    }, config.timeoutMs);

    test("L-4：产物只有远端那一份时不许 release；收割或显式放弃之后才许", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(
        fx.planInput({ command: config.okCommand("out.txt"), outputs: ["out.txt"] }),
        { projectSlug: "contract" },
      );
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      const ran = await fx.broker.dispatch(planned.jobId);
      expect(ran.lifecycle.recoverable).toBe(true);
      await expect(fx.broker.release(planned.jobId)).rejects.toThrow(/L-4/);
      await fx.broker.collect(planned.jobId);
      const released = await fx.broker.release(planned.jobId);
      expect(released.lifecycle.resource).toBe("closed");
    }, config.timeoutMs);

    test("cancel 让运行中的任务终结在 cancelled", async () => {
      const fx = makeContractFixture(config.makeAdapter());
      const planned = await fx.broker.plan(fx.planInput({ command: config.slowCommand(30) }), {
        projectSlug: "contract",
      });
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      const controller = new AbortController();
      const running = fx.broker.dispatch(planned.jobId, { signal: controller.signal });
      // 等它真的进 running 再取消——否则测的是「取消一个还没起来的任务」。
      for (let i = 0; i < 200 && fx.jobs.get(planned.jobId).lifecycle.execution !== "running"; i++) {
        await Bun.sleep(20);
      }
      expect(fx.jobs.get(planned.jobId).lifecycle.execution).toBe("running");
      const cancelled = await fx.broker.cancel(planned.jobId);
      expect(cancelled.lifecycle.execution).toBe("cancelled");
      controller.abort();
      await running.catch(() => undefined);
    }, config.timeoutMs);

    test("admission limit 超出即显式失败，不排队", async () => {
      const fx = makeContractFixture(config.makeAdapter(), { admissionLimit: 1 });
      const a = await fx.broker.plan(fx.planInput({ command: config.slowCommand(20) }), { projectSlug: "contract" });
      fx.approval.approve(a.jobId, { actor: "契约测试员" });
      const controller = new AbortController();
      const first = fx.broker.dispatch(a.jobId, { signal: controller.signal });
      for (let i = 0; i < 200 && fx.jobs.get(a.jobId).lifecycle.execution !== "running"; i++) await Bun.sleep(20);

      const b = await fx.broker.plan(fx.planInput({ command: config.okCommand("out.txt") }), {
        projectSlug: "contract",
      });
      fx.approval.approve(b.jobId, { actor: "契约测试员" });
      await expect(fx.broker.dispatch(b.jobId)).rejects.toThrow(/上限/);

      await fx.broker.cancel(a.jobId);
      controller.abort();
      await first.catch(() => undefined);
    }, config.timeoutMs);

    // 只在 adapter 真的支持 secretRefs 时**注册**这条用例——不注册一条被 skip 的用例
    // （方案 §6.1 的 0 skip 基线：skip 是「看起来跑了」，那正是我们不要的东西）。
    if (config.secretEchoCommand && config.makeAdapter().capabilities().secretRefs) {
    test("密钥只在 dispatch 时刻解析，job 目录里 grep 不到（AD-2）", async () => {
      const needle = "s3cr3t-needle-do-not-persist";
      const fx = makeContractFixture(config.makeAdapter(), { secrets: { demo: { DEMO_SECRET: needle } } });
      const planned = await fx.broker.plan(
        fx.planInput({
          command: config.secretEchoCommand!("DEMO_SECRET"),
          secretRefs: ["demo"],
          outputs: [],
        }),
        { projectSlug: "contract" },
      );
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      const ran = await fx.broker.dispatch(planned.jobId);
      expect(ran.lifecycle.execution).toBe("succeeded");
      for (const file of ["plan.json", "job.json", "uploads.json"]) {
        const path = join(ran.jobDir, file);
        if (!existsSync(path)) continue;
        expect(readFileSync(path, "utf8")).not.toContain(needle);
      }
      // 反向对照：密钥**确实**进了子进程（否则这条断言测的是「什么都没发生」）。
      // 日志里出现是可以接受的——run.log 是任务自己的输出，不是我们替它存的凭据。
      const { harvest } = await fx.broker.collect(ran.jobId);
      expect(readFileSync(harvest.logPath, "utf8")).toContain(needle);
    }, config.timeoutMs);
    }

    test("并发 dispatch 同一个 approved 任务：恰好 1 次赢，其余全是冲突类错误", async () => {
      const fx = makeContractFixture(config.makeAdapter(), { admissionLimit: 64 });
      const planned = await fx.broker.plan(fx.planInput({ command: config.okCommand("out.txt") }), {
        projectSlug: "contract",
      });
      fx.approval.approve(planned.jobId, { actor: "契约测试员" });
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => fx.broker.dispatch(planned.jobId)),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      expect(ok).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]) {
        const isConflict =
          r.reason instanceof ComputeDispatchConflictError || r.reason instanceof ApprovalRequiredError;
        expect(isConflict).toBe(true);
      }
    }, config.timeoutMs);
  });
}
