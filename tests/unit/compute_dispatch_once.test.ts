import { describe, expect, test } from "bun:test";
import { ApprovalRequiredError } from "../../backend/src/compute/approval";
import { LocalComputeAdapter } from "../../backend/src/compute/adapters/local";
import { ComputeDispatchConflictError } from "../../backend/src/compute/broker";
import { makeContractFixture } from "../helpers/compute_contract";

// 「一次批准并发派发两次」的对抗测试——照 tests/concurrency/approve_once.test.ts（P10-d · D-9）
// 的形状，只是把湿实验换成算力。
//
// 评审在湿实验那边实测过的漏洞长这样：状态在整个执行期间原地不动，且没有任何行写入
// 发生在真正调用后端之前——两个并发请求的同步前缀都会看到「能执行」，双双真正跑起来。
// 一次批准，真钱被花了两次。
//
// 这里的防线有两道，缺一不可：
//   ① approval 一次性消费（approval → consumedApproval 在同一次写里完成）
//   ② 那一次写是 CAS（job.json 的 rev 对不上就判负）
// 阴性对照（见 devlog）：去掉 CAS 的 expectedRev，这个文件必须红。

describe("D-9 同构 · 一次批准并发派发（并发 dispatch 只许一次真正派发）", () => {
  test("N=30 次并发 dispatch 同一个 approved 任务 → 恰好 1 次成功，其余全是冲突/审批类错误", async () => {
    const fx = makeContractFixture(new LocalComputeAdapter({ pollIntervalMs: 10 }), { admissionLimit: 64 });
    const planned = await fx.broker.plan(
      fx.planInput({ command: ["/bin/sleep", "1"], outputs: [] }),
      { projectSlug: "contract" },
    );
    const { job: approved } = fx.approval.approve(planned.jobId, { actor: "并发测试员" });
    expect(approved.lifecycle.execution).toBe("approved");

    const N = 30;
    // 同步地把 N 次 dispatch() 一次性发起（中间不 await）：dispatch 的同步前缀
    // （状态检查 → digest 重验 → uploads preflight → CAS 消费审批）会在这个循环里
    // 一个接一个跑完，这正是「谁先声明成功」在单事件循环里必然发生的方式。
    const results = await Promise.allSettled(Array.from({ length: N }, () => fx.broker.dispatch(planned.jobId)));

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof fx.broker.dispatch>>
    >[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.lifecycle.execution).toBe("succeeded");
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) {
      const conflict =
        r.reason instanceof ComputeDispatchConflictError || r.reason instanceof ApprovalRequiredError;
      expect(conflict).toBe(true);
    }

    // 审批只被消费了一次，磁盘上留下的也只有一份 consumedApproval。
    const final = fx.jobs.get(planned.jobId);
    expect(final.approval).toBeNull();
    expect(final.consumedApproval?.actor).toBe("并发测试员");
    // 只落了一条 decision record（approve 那一次）——并发的失败尝试不该污染证据图。
    expect(fx.records.list({ type: "decision" })).toHaveLength(1);
  }, 60_000);

  test("赢家跑完之后，输家拿着旧 approval 再试一次仍然必须被拒（approval 不能复活）", async () => {
    const fx = makeContractFixture(new LocalComputeAdapter({ pollIntervalMs: 10 }), { admissionLimit: 64 });
    const planned = await fx.broker.plan(fx.planInput({ command: ["/bin/echo", "x"], outputs: [] }), {
      projectSlug: "contract",
    });
    const { job: approved } = fx.approval.approve(planned.jobId, { actor: "并发测试员" });
    const stale = { ...approved };
    await fx.broker.dispatch(planned.jobId);
    // 手里还攥着「approved 且 rev=N」的旧视图，照样派不出去。
    expect(() => fx.approval.consume(stale.jobId, stale.plan.digest, stale.rev)).toThrow(ApprovalRequiredError);
  }, 60_000);
});
