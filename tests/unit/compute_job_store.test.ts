import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputeJobConflictError,
  ComputeJobStore,
  UnknownComputeJobError,
  newJobId,
} from "../../backend/src/compute/job_store";
import { buildPlan, type PlanInput } from "../../backend/src/compute/plan";
import type { AdapterCapabilities } from "../../backend/src/compute/target";

// CB-1 · 磁盘真源（设计 §1.1.5 / K-3）。

const CAPS: AdapterCapabilities = {
  billable: false,
  persistentVolume: false,
  recovery: true,
  secretRefs: false,
  network: ["none", "unrestricted"],
  gpus: [],
  uploadLimits: { count: 200, bytes: 1 << 28 },
};

function plan(over: Partial<PlanInput> = {}) {
  const input: PlanInput = {
    target: { kind: "local" },
    purpose: "磁盘真源测试",
    command: ["/bin/echo", "hi"],
    env: {},
    image: null,
    secretRefs: [],
    resources: { gpu: null, cpus: 1, memoryGb: 1, timeoutMinutes: 5 },
    network: "none",
    uploads: [],
    outputs: [],
    workspaceRoot: "/tmp/ws",
    ...over,
  };
  return buildPlan(input, CAPS, () => ({ unitPriceUsd: null, source: null, verifiedDate: null }));
}

function store(): ComputeJobStore {
  return new ComputeJobStore(mkdtempSync(join(tmpdir(), "compute-jobs-")));
}

describe("目录布局与创建", () => {
  test("create 落 plan.json + job.json，并建好 workspace/ 与 harvest/", () => {
    const jobs = store();
    const job = jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" } });
    expect(existsSync(join(job.jobDir, "plan.json"))).toBe(true);
    expect(existsSync(join(job.jobDir, "job.json"))).toBe(true);
    expect(existsSync(join(job.jobDir, "workspace"))).toBe(true);
    expect(existsSync(join(job.jobDir, "harvest"))).toBe(true);
    expect(job.lifecycle).toEqual({ execution: "planned", delivery: "none", resource: "none", recoverable: false });
    expect(job.rev).toBe(1);
  });

  test("jobId 形如 cj-<base36>-<uuid8>（与 runId 同风格）", () => {
    expect(newJobId(() => 1_700_000_000_000)).toMatch(/^cj-[0-9a-z]+-[0-9a-f]{8}$/);
  });

  test("读回来的 plan 与写进去的逐字段一致（digest 尤其）", () => {
    const jobs = store();
    const p = plan();
    const job = jobs.create(p, { projectSlug: "p", experimentId: "exp-1", target: { kind: "local" } });
    const read = jobs.get(job.jobId);
    expect(read.plan).toEqual(p);
    expect(read.experimentId).toBe("exp-1");
  });

  test("不存在的 jobId：read 返回 null，get 抛", () => {
    const jobs = store();
    expect(jobs.read("cj-nope")).toBeNull();
    expect(() => jobs.get("cj-nope")).toThrow(UnknownComputeJobError);
  });
});

describe("原子写 + rev CAS", () => {
  test("patch 每次 rev+1；expectedRev 对不上就抛，且**磁盘上一个字节都没变**", () => {
    const jobs = store();
    const job = jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" } });
    const v2 = jobs.patch(job.jobId, { message: "第一次" }, { expectedRev: 1 });
    expect(v2.rev).toBe(2);
    const before = readFileSync(join(job.jobDir, "job.json"), "utf8");
    expect(() => jobs.patch(job.jobId, { message: "抢先者" }, { expectedRev: 1 })).toThrow(ComputeJobConflictError);
    expect(readFileSync(join(job.jobDir, "job.json"), "utf8")).toBe(before);
  });

  test("不给 expectedRev 就是无条件覆盖（rev 仍 +1）", () => {
    const jobs = store();
    const job = jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" } });
    expect(jobs.patch(job.jobId, { message: "a" }).rev).toBe(2);
    expect(jobs.patch(job.jobId, { message: "b" }).rev).toBe(3);
  });

  test("写完之后目录里不留 .tmp 残渣（原子写用临时文件 + rename）", () => {
    const jobs = store();
    const job = jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" } });
    jobs.patch(job.jobId, { message: "x" });
    expect(readdirSync(job.jobDir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  test("jobId 与 rev 不可被 patch 覆盖", () => {
    const jobs = store();
    const job = jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" } });
    const next = jobs.patch(job.jobId, { message: "x" } as never);
    expect(next.jobId).toBe(job.jobId);
    expect(next.rev).toBe(2);
  });
});

describe("replan / uploads 快照 / list", () => {
  test("replacePlan 换掉 plan.json，旧 approval 进 supersededApproval", () => {
    const jobs = store();
    const job = jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" } });
    const approved = jobs.patch(job.jobId, {
      approval: {
        decisionRecordId: "rec-1",
        actor: "我",
        actorSource: "explicit",
        at: "2026-09-10T00:00:00Z",
        planDigest: job.plan.digest,
        note: null,
      },
    });
    const next = jobs.replacePlan(job.jobId, plan({ command: ["/bin/echo", "changed"] }), { expectedRev: approved.rev });
    expect(next.approval).toBeNull();
    expect(next.supersededApproval?.decisionRecordId).toBe("rec-1");
    expect(next.plan.command).toEqual(["/bin/echo", "changed"]);
    expect(next.plan.digest).not.toBe(job.plan.digest);
  });

  test("uploads 快照单独落盘，读回来一致", () => {
    const jobs = store();
    const job = jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" } });
    expect(jobs.readUploadsSnapshot(job.jobId)).toBeNull();
    const entries = [{ path: "a.py", size: 3, sha256: "d".repeat(64) }];
    jobs.writeUploadsSnapshot(job.jobId, entries);
    expect(jobs.readUploadsSnapshot(job.jobId)!.entries).toEqual(entries);
  });

  test("list 按 experimentId / execution 过滤，按 createdAt 排序", () => {
    const jobs = store();
    const a = jobs.create(plan(), { projectSlug: "p", experimentId: "exp-1", target: { kind: "local" }, now: "2026-01-01T00:00:00Z" });
    const b = jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" }, now: "2026-01-02T00:00:00Z" });
    jobs.patch(b.jobId, { lifecycle: { execution: "running", delivery: "none", resource: "active", recoverable: false } });
    expect(jobs.list().map((j) => j.jobId)).toEqual([a.jobId, b.jobId]);
    expect(jobs.list({ experimentId: "exp-1" }).map((j) => j.jobId)).toEqual([a.jobId]);
    expect(jobs.list({ execution: ["running"] }).map((j) => j.jobId)).toEqual([b.jobId]);
  });

  test("目录里混进无关文件不会让 list 崩（只认有 job.json 的目录）", () => {
    const jobs = store();
    jobs.create(plan(), { projectSlug: "p", experimentId: null, target: { kind: "local" } });
    writeFileSync(join(jobs.root, "README.txt"), "not a job");
    expect(jobs.list()).toHaveLength(1);
  });
});
