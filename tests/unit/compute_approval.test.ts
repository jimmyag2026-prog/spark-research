import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRequiredError, ComputeApproval } from "../../backend/src/compute/approval";
import { ComputeJobConflictError, ComputeJobStore } from "../../backend/src/compute/job_store";
import { transition } from "../../backend/src/compute/lifecycle";
import { buildPlan, type ComputePlan, type PlanInput } from "../../backend/src/compute/plan";
import type { AdapterCapabilities } from "../../backend/src/compute/target";
import { ProjectManager } from "../../backend/src/project/manager";

// CB-1 · 审批语义（K-2 / X-1）。与 wet_loop.ts:371-560 逐条对照（设计 §1.1.4）。

const CAPS: AdapterCapabilities = {
  billable: true, // 计费 → approvalRequired 派生为 true
  persistentVolume: true,
  recovery: true,
  secretRefs: true,
  network: ["none", "unrestricted"],
  gpus: [],
  uploadLimits: { count: 200, bytes: 1 << 28 },
};

function makePlan(over: Partial<PlanInput> = {}): ComputePlan {
  const input: PlanInput = {
    target: { kind: "modal" },
    purpose: "审批语义测试",
    command: ["python", "train.py"],
    env: {},
    image: null,
    secretRefs: [],
    resources: { gpu: null, cpus: 1, memoryGb: 2, timeoutMinutes: 5 },
    network: "none",
    uploads: [],
    outputs: [],
    workspaceRoot: "/tmp/ws",
    ...over,
  };
  return buildPlan(input, CAPS, () => ({
    unitPriceUsd: 0.0001,
    source: "https://example.test/pricing",
    verifiedDate: "2026-09-10",
  }));
}

interface Fixture {
  jobs: ComputeJobStore;
  approval: ComputeApproval;
  records: ReturnType<ReturnType<ProjectManager["create"]>["records"]>;
  awaiting: (over?: Partial<PlanInput>) => ReturnType<ComputeJobStore["get"]>;
}

let seq = 0;
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `compute-approval-${seq++}-`));
  const manager = new ProjectManager(root);
  const project = manager.create("approval");
  const jobs = new ComputeJobStore(join(project.paths.experimentsDir, "compute", "jobs"));
  const records = project.records();
  const approval = new ComputeApproval({ records, jobs, sessionId: "sess-1" });
  const awaiting = (over: Partial<PlanInput> = {}) => {
    const plan = makePlan(over);
    const job = jobs.create(plan, { projectSlug: "approval", experimentId: null, target: plan.target });
    return jobs.patch(job.jobId, {
      lifecycle: transition(job.lifecycle, "review", { approvalRequired: true, planDigest: plan.digest }),
    });
  };
  return { jobs, approval, records, awaiting };
}

describe("approve", () => {
  test("落一条 decision record：inferred / manual / kind=approval / 带 planDigest 与 jobId", () => {
    const fx = fixture();
    const job = fx.awaiting();
    const { job: approved, decisionId } = fx.approval.approve(job.jobId, { actor: "研究员甲", note: "预算内" });
    expect(approved.lifecycle.execution).toBe("approved");
    expect(approved.approval).toMatchObject({ actor: "研究员甲", planDigest: job.plan.digest, note: "预算内" });

    const record = fx.records.get(decisionId)!;
    expect(record.type).toBe("decision");
    expect(record.evidence).toBe("inferred");
    expect(record.origin.kind).toBe("manual");
    expect(record.origin.sessionId).toBe("sess-1");
    expect(record.metadata).toMatchObject({
      kind: "approval",
      decision: "approve",
      actor: "研究员甲",
      actorSource: "explicit",
      planDigest: job.plan.digest,
      jobId: job.jobId,
      target: "modal",
      warningShown: true,
      uploadsCount: 0,
      uploadBytes: 0,
    });
    // 「批的是哪一版、花多少钱」必须在 record 里查得到，不用回头翻 job 目录。
    expect(record.content).toContain(job.plan.digest);
    expect(record.content).toContain("费用上界");
  });

  test("actor 必填（谁批的是这条 record 的核心内容）", () => {
    const fx = fixture();
    const job = fx.awaiting();
    expect(() => fx.approval.approve(job.jobId, { actor: "   " })).toThrow(ApprovalRequiredError);
    // 拒绝之后不许留下半条 decision record。
    expect(fx.records.list({ type: "decision" })).toHaveLength(0);
  });

  test("只有停在 awaiting_approval 的任务能被批准", () => {
    const fx = fixture();
    const job = fx.awaiting();
    fx.approval.approve(job.jobId, { actor: "甲" });
    expect(() => fx.approval.approve(job.jobId, { actor: "乙" })).toThrow(/awaiting_approval/);
  });

  test("experimentId 存在时，decision 用 derives_from 边挂到实验上", () => {
    const fx = fixture();
    const plan = makePlan();
    const exp = fx.records.create({ type: "experiment", title: "干实验", content: "x" });
    const created = fx.jobs.create(plan, { projectSlug: "approval", experimentId: exp.id, target: plan.target });
    const job = fx.jobs.patch(created.jobId, {
      lifecycle: transition(created.lifecycle, "review", { approvalRequired: true, planDigest: plan.digest }),
    });
    const { decisionId } = fx.approval.approve(job.jobId, { actor: "甲" });
    const edges = fx.records.edgesOf(decisionId).outgoing;
    expect(edges.map((e) => `${e.targetId}:${e.type}`)).toContain(`${exp.id}:derives_from`);
  });
});

describe("reject", () => {
  test("落 decision record、approval 置 null、终结在 rejected", () => {
    const fx = fixture();
    const job = fx.awaiting();
    const { job: rejected, decisionId } = fx.approval.reject(job.jobId, { actor: "乙", reason: "上传里有原始数据" });
    expect(rejected.lifecycle.execution).toBe("rejected");
    expect(rejected.approval).toBeNull();
    expect(rejected.rejection?.reason).toBe("上传里有原始数据");
    expect(fx.records.get(decisionId)!.metadata.decision).toBe("reject");
  });

  test("reject 必须给理由", () => {
    const fx = fixture();
    const job = fx.awaiting();
    expect(() => fx.approval.reject(job.jobId, { actor: "乙", reason: " " })).toThrow(/理由/);
  });
});

describe("consume · 一次性消费 + 执行前重验（本 lane 的心脏）", () => {
  test("消费成功：approval → consumedApproval，同一次写里推进到 queued", () => {
    const fx = fixture();
    const job = fx.awaiting();
    const { job: approved, decisionId } = fx.approval.approve(job.jobId, { actor: "甲" });
    const claimed = fx.approval.consume(approved.jobId, approved.plan.digest, approved.rev);
    expect(claimed.lifecycle.execution).toBe("queued");
    expect(claimed.approval).toBeNull();
    expect(claimed.consumedApproval?.decisionRecordId).toBe(decisionId);
    expect(claimed.dispatchedAt).not.toBeNull();
  });

  test("**重启后不能凭旧 approval 重派**：消费过一次就不能再消费", () => {
    const fx = fixture();
    const job = fx.awaiting();
    const { job: approved } = fx.approval.approve(job.jobId, { actor: "甲" });
    const claimed = fx.approval.consume(approved.jobId, approved.plan.digest, approved.rev);

    // 模拟「编排进程崩了」：任务被人工拨回 approved，但 approval 已经不在磁盘上。
    const rewound = fx.jobs.patch(claimed.jobId, {
      lifecycle: { ...claimed.lifecycle, execution: "approved" },
    });
    expect(rewound.approval).toBeNull();
    expect(() => fx.approval.consume(rewound.jobId, rewound.plan.digest, rewound.rev)).toThrow(
      /没有未消费的审批记录/,
    );

    // 全新的 store 实例（真的重启）读到的也是同一个事实。
    const reopened = new ComputeJobStore(fx.jobs.root).get(claimed.jobId);
    expect(reopened.approval).toBeNull();
    expect(reopened.consumedApproval).not.toBeNull();
  });

  test("digest 不符 → 标 failed 并抛（plan 在审批之后变了，批的就不是这件事）", () => {
    const fx = fixture();
    const job = fx.awaiting();
    const { job: approved } = fx.approval.approve(job.jobId, { actor: "甲" });
    expect(() => fx.approval.consume(approved.jobId, "f".repeat(64), approved.rev)).toThrow(/审批之后变了/);
    const after = fx.jobs.get(approved.jobId);
    expect(after.lifecycle.execution).toBe("failed");
    expect(after.approval).toBeNull();
    expect(after.supersededApproval).not.toBeNull();
  });

  test("状态不是 approved → 拒（未经 approve 不能派发）", () => {
    const fx = fixture();
    const job = fx.awaiting();
    expect(() => fx.approval.consume(job.jobId, job.plan.digest, job.rev)).toThrow(/未经 approve/);
  });

  test("rev 对不上 → CAS 判负（别的请求抢先了）", () => {
    const fx = fixture();
    const job = fx.awaiting();
    const { job: approved } = fx.approval.approve(job.jobId, { actor: "甲" });
    expect(() => fx.approval.consume(approved.jobId, approved.plan.digest, approved.rev - 1)).toThrow(
      ComputeJobConflictError,
    );
  });

  test("N=30 次并发 consume 同一份审批 → 恰好 1 次成功（照 approve_once 的形状）", () => {
    const fx = fixture();
    const job = fx.awaiting();
    const { job: approved } = fx.approval.approve(job.jobId, { actor: "甲" });
    const results = Array.from({ length: 30 }, () => {
      try {
        return { ok: true as const, job: fx.approval.consume(approved.jobId, approved.plan.digest, approved.rev) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toMatchObject({ ok: false });
    }
    expect(fx.jobs.get(approved.jobId).lifecycle.execution).toBe("queued");
  });
});
