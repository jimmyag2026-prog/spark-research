import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalComputeAdapter } from "../../backend/src/compute/adapters/local";
import { ComputeApproval } from "../../backend/src/compute/approval";
import {
  ComputeAdmissionError,
  ComputeBroker,
  NULL_PRICING,
  UnknownTargetError,
  computeJobsRoot,
} from "../../backend/src/compute/broker";
import { ComputeJobStore } from "../../backend/src/compute/job_store";
import type { PlanInput } from "../../backend/src/compute/plan";
import {
  RecoverFailure,
  type AdapterCapabilities,
  type AdapterHandle,
  type ComputeAdapter,
  type DispatchSpec,
  type Harvest,
  type ResolvedSpec,
  type RunResult,
} from "../../backend/src/compute/target";
import { BudgetLedger } from "../../backend/src/llm/budget";
import { ProjectManager } from "../../backend/src/project/manager";
import { makeContractFixture } from "../helpers/compute_contract";

// CB-1/CB-2 · broker 编排。这里用一个**可编程的假 adapter** 覆盖 local 跑不出来的分支
// （超时、RecoverFailure 的各种 kind、reconcile 失败、计费）——假 adapter 只替换
// 「执行地」，审批链一步都不少。

interface StubBehaviour {
  result?: RunResult;
  throwOnRun?: Error;
  recoverResult?: RunResult;
  recoverThrow?: Error;
  harvest?: Partial<Harvest>;
  billable?: boolean;
  released?: string[];
  cancelled?: string[];
  seenSecrets?: Record<string, string>;
}

class StubAdapter implements ComputeAdapter {
  readonly kind = "modal" as const;
  readonly description = "测试用的可编程执行地";
  constructor(private readonly behaviour: StubBehaviour) {}

  capabilities(): AdapterCapabilities {
    return {
      billable: this.behaviour.billable ?? true,
      persistentVolume: true,
      recovery: true,
      secretRefs: true,
      network: ["none", "unrestricted"],
      gpus: ["A10G"],
      uploadLimits: { count: 200, bytes: 1 << 28 },
    };
  }

  async check() {
    return { ok: true, reason: null, detail: {} };
  }

  async run(spec: DispatchSpec): Promise<RunResult> {
    for (const ref of spec.plan.secretRefs) Object.assign(this.behaviour.seenSecrets ?? {}, spec.resolveSecret(ref));
    if (this.behaviour.throwOnRun) throw this.behaviour.throwOnRun;
    return this.behaviour.result ?? { exitCode: 0, timedOut: false, handle: { kind: "modal", data: { sandboxId: "sb-1" } } };
  }

  async recover(_spec: ResolvedSpec, handle: AdapterHandle): Promise<RunResult> {
    if (this.behaviour.recoverThrow) throw this.behaviour.recoverThrow;
    return this.behaviour.recoverResult ?? { exitCode: 0, timedOut: false, handle };
  }

  async collect(): Promise<Harvest> {
    return {
      files: [],
      logPath: "/dev/null",
      exitCode: 0,
      wallSeconds: 120,
      reconcileError: null,
      ...this.behaviour.harvest,
    };
  }

  async cancel(spec: ResolvedSpec): Promise<void> {
    this.behaviour.cancelled?.push(spec.jobId);
  }

  async release(spec: ResolvedSpec): Promise<void> {
    this.behaviour.released?.push(spec.jobId);
  }
}

let seq = 0;
function stubFixture(behaviour: StubBehaviour = {}, over: { budget?: BudgetLedger; admissionLimit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), `compute-broker-${seq++}-`));
  const manager = new ProjectManager(join(root, "ws"));
  const project = manager.create("broker");
  const jobs = new ComputeJobStore(computeJobsRoot(project.paths.experimentsDir));
  const records = project.records();
  const approval = new ComputeApproval({ records, jobs });
  const adapter = new StubAdapter(behaviour);
  const broker = new ComputeBroker({
    jobs,
    adapters: { modal: adapter },
    approval,
    credentials: { has: (id) => id === "modal", get: (id) => (id === "modal" ? { MODAL_TOKEN: "tok" } : null) },
    pricing: () => ({ unitPriceUsd: 0.001, source: "https://example.test/pricing", verifiedDate: "2026-09-10" }),
    budget: over.budget,
    admissionLimit: over.admissionLimit,
  });
  const workspaceRoot = join(root, "src");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "train.py"), "print(1)\n");
  const planInput = (o: Partial<PlanInput> = {}): PlanInput => ({
    target: { kind: "modal" },
    purpose: "broker 测试",
    command: ["python", "train.py"],
    env: {},
    image: null,
    secretRefs: [],
    resources: { gpu: null, cpus: 1, memoryGb: 2, timeoutMinutes: 5 },
    network: "none",
    uploads: [],
    outputs: [],
    workspaceRoot,
    ...o,
  });
  return { broker, jobs, approval, records, planInput, adapter };
}

async function approvedJob(fx: ReturnType<typeof stubFixture>, over: Partial<PlanInput> = {}) {
  const planned = await fx.broker.plan(fx.planInput(over), { projectSlug: "broker" });
  expect(planned.lifecycle.execution).toBe("awaiting_approval");
  return fx.approval.approve(planned.jobId, { actor: "审批人" }).job;
}

describe("targets()", () => {
  test("已注册的 available:true 带 capabilities；ssh 恒 available:false（v0.5 只留槽位）", () => {
    const fx = stubFixture();
    const targets = fx.broker.targets();
    expect(targets.map((t) => t.kind)).toEqual(["local", "modal", "ssh"]);
    expect(targets.find((t) => t.kind === "modal")!.available).toBe(true);
    expect(targets.find((t) => t.kind === "modal")!.capabilities!.billable).toBe(true);
    const ssh = targets.find((t) => t.kind === "ssh")!;
    expect(ssh.available).toBe(false);
    expect(ssh.reason).toContain("槽位");
  });

  test("没注册 adapter 的 target 直接拒（不是「先建了再说」）", async () => {
    const fx = stubFixture();
    await expect(
      fx.broker.plan(fx.planInput({ target: { kind: "local" } }), { projectSlug: "broker" }),
    ).rejects.toThrow(UnknownTargetError);
  });
});

describe("dispatch 的五步", () => {
  test("计费 plan 一定停在 awaiting_approval（billable ⇒ approvalRequired，L-3）", async () => {
    const fx = stubFixture();
    const planned = await fx.broker.plan(fx.planInput(), { projectSlug: "broker" });
    expect(planned.plan.approvalRequired).toBe(true);
    expect(planned.lifecycle.execution).toBe("awaiting_approval");
  });

  test("不计费、不联网、不用密钥的 plan 才允许 planned → queued（L-2 的第二条入边）", async () => {
    const fx = stubFixture({ billable: false });
    const planned = await fx.broker.plan(fx.planInput(), { projectSlug: "broker" });
    expect(planned.plan.approvalRequired).toBe(false);
    expect(planned.lifecycle.execution).toBe("planned");
    const ran = await fx.broker.dispatch(planned.jobId);
    expect(ran.lifecycle.execution).toBe("succeeded");
    expect(ran.consumedApproval).toBeNull();
  });

  test("密钥在 dispatch 时刻解析并交给 adapter，plan/job 里只有符号名", async () => {
    const seen: Record<string, string> = {};
    const fx = stubFixture({ seenSecrets: seen });
    const job = await approvedJob(fx, { secretRefs: ["modal"] });
    const ran = await fx.broker.dispatch(job.jobId);
    expect(ran.lifecycle.execution).toBe("succeeded");
    expect(seen.MODAL_TOKEN).toBe("tok");
    expect(JSON.stringify(ran.plan)).not.toContain("tok");
    expect(JSON.stringify({ ...ran, plan: undefined })).not.toContain("tok");
  });

  test("plan 引用了凭据库里没有的密钥 → 派发失败并如实说明（不静默跑一个缺密钥的任务）", async () => {
    const fx = stubFixture();
    const job = await approvedJob(fx, { secretRefs: ["nonexistent"] });
    const ran = await fx.broker.dispatch(job.jobId);
    expect(ran.lifecycle.execution).toBe("failed");
    expect(ran.message).toContain("凭据库里没有");
  });

  test("adapter.run 抛错 → failed，消息里带原因", async () => {
    const fx = stubFixture({ throwOnRun: new Error("沙箱创建失败") });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    expect(ran.lifecycle.execution).toBe("failed");
    expect(ran.message).toContain("沙箱创建失败");
  });

  test("timedOut=true → timed_out（与 failed 是两回事，处置也不同）", async () => {
    const fx = stubFixture({
      result: { exitCode: null, timedOut: true, handle: { kind: "modal", data: { sandboxId: "sb" } } },
    });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    expect(ran.lifecycle.execution).toBe("timed_out");
    expect(ran.message).toContain("超时");
  });

  test("admission limit：超出即显式失败，不排队", async () => {
    const fx = stubFixture({}, { admissionLimit: 1 });
    const a = await approvedJob(fx);
    // 手工把 a 摁在 running（假 adapter 是同步返回的，制造不出「同时在跑」）。
    await fx.broker.dispatch(a.jobId);
    fx.jobs.patch(a.jobId, {
      lifecycle: { execution: "running", delivery: "none", resource: "active", recoverable: false },
    });
    const b = await approvedJob(fx);
    await expect(fx.broker.dispatch(b.jobId)).rejects.toThrow(ComputeAdmissionError);
    // 失败之后 b 的审批**没有**被消费掉——人批过的东西不能因为系统忙就作废。
    expect(fx.jobs.get(b.jobId).approval).not.toBeNull();
  });
});

describe("recover 的分类处置", () => {
  test("RecoverFailure(not_found) → failed，消息带 kind", async () => {
    const fx = stubFixture({ recoverThrow: new RecoverFailure("not_found", "sandbox 不见了") });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    fx.jobs.patch(ran.jobId, { lifecycle: { ...ran.lifecycle, execution: "running" } });
    const recovered = await fx.broker.recover(ran.jobId);
    expect(recovered.lifecycle.execution).toBe("failed");
    expect(recovered.message).toContain("not_found");
    expect(recovered.message).toContain("终态");
  });

  test("RecoverFailure(retryable) 也标 failed，但消息说明可重试", async () => {
    const fx = stubFixture({ recoverThrow: new RecoverFailure("retryable", "上游 503") });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    fx.jobs.patch(ran.jobId, { lifecycle: { ...ran.lifecycle, execution: "running" } });
    const recovered = await fx.broker.recover(ran.jobId);
    expect(recovered.message).toContain("可重试");
  });

  test("recover 成功 → 由 adapter 裁定去向；**重派仍然需要新的审批**", async () => {
    const fx = stubFixture();
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    fx.jobs.patch(ran.jobId, { lifecycle: { ...ran.lifecycle, execution: "running" } });
    const recovered = await fx.broker.recover(ran.jobId);
    expect(recovered.lifecycle.execution).toBe("succeeded");
    await expect(fx.broker.dispatch(ran.jobId)).rejects.toThrow(/未经 approve|没有未消费/);
  });

  test("没有 adapterHandle 的任务无从接回 → failed 并说明原因", async () => {
    const fx = stubFixture();
    const job = await approvedJob(fx);
    const recovered = await fx.broker.recover(job.jobId);
    expect(recovered.lifecycle.execution).toBe("failed");
    expect(recovered.message).toContain("从未真正派发");
  });

  test("已经终态的任务 recover 是幂等的（原样返回）", async () => {
    const fx = stubFixture();
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    expect((await fx.broker.recover(ran.jobId)).rev).toBe(ran.rev);
  });
});

describe("collect / discard / release / 计费", () => {
  test("reconcile 失败 → delivery=failed，可以 retry_delivery 再收一次", async () => {
    const fx = stubFixture({ harvest: { reconcileError: "卷上的 exit-code 与 sandbox 报告不一致" } });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    const first = await fx.broker.collect(ran.jobId);
    expect(first.job.lifecycle.delivery).toBe("failed");
    expect(first.job.lifecycle.recoverable).toBe(true);
    // 换成对得上账的 harvest 再收一次。
    fx.adapter["behaviour"].harvest = { reconcileError: null };
    const second = await fx.broker.collect(ran.jobId);
    expect(second.job.lifecycle.delivery).toBe("complete");
  });

  test("收割成功后记账：单价 × 墙钟秒数；查不到单价就是 null（**绝不 0**）", async () => {
    const budget = new BudgetLedger({});
    const fx = stubFixture({}, { budget });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    const { job: collected } = await fx.broker.collect(ran.jobId);
    expect(collected.actualCostUsd).toBeCloseTo(0.001 * 120, 6);
    expect(budget.snapshot().knownCostUsd).toBeCloseTo(0.12, 6);

    const noPrice = stubFixture({ harvest: { wallSeconds: null } });
    const j2 = await approvedJob(noPrice);
    const r2 = await noPrice.broker.dispatch(j2.jobId);
    const { job: c2 } = await noPrice.broker.collect(r2.jobId);
    expect(c2.actualCostUsd).toBeNull();
  });

  test("execution 还没终态就 collect → 拒（L-5）", async () => {
    const fx = stubFixture();
    const job = await approvedJob(fx);
    await expect(fx.broker.collect(job.jobId)).rejects.toThrow(/终态/);
  });

  test("discard：人明确不要产物 → delivery=rejected，之后才允许 release", async () => {
    const released: string[] = [];
    const fx = stubFixture({ released });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    await expect(fx.broker.release(ran.jobId)).rejects.toThrow(/L-4/);
    const discarded = fx.broker.discard(ran.jobId, "跑错参数了");
    expect(discarded.lifecycle.delivery).toBe("rejected");
    expect(discarded.lifecycle.recoverable).toBe(false);
    const done = await fx.broker.release(ran.jobId);
    expect(done.lifecycle.resource).toBe("closed");
    expect(released).toEqual([ran.jobId]);
  });

  test("L-4 拦下的 release **没有**去动真实资源（顺序：先算状态再动资源）", async () => {
    const released: string[] = [];
    const fx = stubFixture({ released });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    await expect(fx.broker.release(ran.jobId)).rejects.toThrow(/L-4/);
    expect(released).toEqual([]);
  });

  test("cancel 调到 adapter 并终结在 cancelled", async () => {
    const cancelled: string[] = [];
    const fx = stubFixture({ cancelled });
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    fx.jobs.patch(ran.jobId, { lifecycle: { ...ran.lifecycle, execution: "running" } });
    const stopped = await fx.broker.cancel(ran.jobId);
    expect(stopped.lifecycle.execution).toBe("cancelled");
    expect(cancelled).toEqual([ran.jobId]);
  });
});

describe("replan", () => {
  test("换了 plan → digest 变、旧审批作废、重新停在 awaiting_approval", async () => {
    const fx = stubFixture();
    const job = await approvedJob(fx);
    const replanned = await fx.broker.replan(job.jobId, fx.planInput({ command: ["python", "train2.py"] }));
    expect(replanned.plan.digest).not.toBe(job.plan.digest);
    expect(replanned.approval).toBeNull();
    expect(replanned.supersededApproval?.actor).toBe("审批人");
    expect(replanned.lifecycle.execution).toBe("awaiting_approval");
  });

  test("已经在跑/已终态的任务不许 replan", async () => {
    const fx = stubFixture();
    const job = await approvedJob(fx);
    const ran = await fx.broker.dispatch(job.jobId);
    await expect(fx.broker.replan(ran.jobId, fx.planInput())).rejects.toThrow(/不能重新 plan/);
  });
});

describe("local adapter 也走同一个 broker（契约不是给假 adapter 特设的）", () => {
  test("local + 不联网 = 无需审批；local + 联网 = 必须审批", async () => {
    const fx = makeContractFixture(new LocalComputeAdapter({ pollIntervalMs: 20 }));
    const offline = await fx.broker.plan(fx.planInput({ network: "none", command: ["/bin/echo", "x"] }), {
      projectSlug: "contract",
    });
    expect(offline.plan.approvalRequired).toBe(false);
    expect(offline.lifecycle.execution).toBe("planned");

    const online = await fx.broker.plan(fx.planInput({ network: "unrestricted", command: ["/bin/echo", "x"] }), {
      projectSlug: "contract",
    });
    expect(online.plan.approvalRequired).toBe(true);
    expect(online.lifecycle.execution).toBe("awaiting_approval");
  });
});
