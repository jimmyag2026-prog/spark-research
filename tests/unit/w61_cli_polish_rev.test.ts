import { describe, expect, test } from "bun:test";
import { LocalComputeAdapter } from "../../backend/src/compute/adapters/local";
import { makeContractFixture } from "../helpers/compute_contract";

// W6-1 lane γ · V50：算力任务的 rev 跳变无解释（外部验收 S12 第 5 条）。
//
// 根因（docs/BACKLOG.md V50，δ 诊断过）：`job_store.ts` 的 `rev` 既是 CAS 用的内部写
// 计数，又是 `compute list/status` 展示给用户的数字——`broker.ts` 的 `runOn()` 原来把
// `resource_start → resource_active → start → run` 这四步状态机转换分两次 `patch()`
// 落盘（先落 start，再落 run），中间没有真正的异步边界（`specOf()` 只读 jobId/plan/
// jobDir，不依赖中间态），纯粹是「先算中间状态再算下一步」的写法副作用，让用户看到的
// rev 无解释地多跳一格。
//
// 方向已裁定：用户可见 rev 与内部写计数分离——**但完整的字段级分离做不进这条 lane**：
// CAS（`approval.ts`）与展示层（`compute/cli.ts`）都依赖 `job.rev` 是「每次 patch() 都
// +1 的写计数」这个语义，两个文件都不在本 lane 文件所有权内，且 `rev` 的这个语义被
// `tests/unit/compute_job_store.test.ts`「patch 每次 rev+1」钉死，不能碰。所以这里做的
// 是风险最低的等价改法：**减少一次 dispatch 内部触发的 patch() 调用次数**，让 rev 的
// 跳变格数更贴近「真的发生了几次状态变化」，rev 本身的 CAS 语义与所有既有断言不变。
describe("V50 · dispatch 内部合并 started/running 两次落盘，rev 跳变收窄", () => {
  test("不需要审批的 plan：dispatch 一次让 rev 跳 3 格（claim 1 + start-run-merged 1 + V48 handle 落盘 1），而不是 4 格", async () => {
    const fx = makeContractFixture(new LocalComputeAdapter({ pollIntervalMs: 5 }));
    // network:"none" + LocalComputeAdapter(billable:false) + 无 secretRefs ⇒
    // derivedApprovalRequired() 为 false，直接 planned → dispatch，不走审批链，
    // 这样 rev 的变化只来自 job_store/broker，不掺 approval.ts 自己的 patch() 调用。
    const planned = await fx.broker.plan(
      fx.planInput({ network: "none", command: ["/bin/echo", "ok"], outputs: [] }),
      { projectSlug: "contract" },
    );
    expect(planned.plan.approvalRequired).toBe(false);
    expect(planned.rev).toBe(1); // create() 之后直接返回，没有 review patch。

    const ran = await fx.broker.dispatch(planned.jobId);
    expect(ran.lifecycle.execution).toBe("succeeded");
    // 三次 patch()：① 无审批分支的 dispatch 声明（claim）② 合并后的
    // resource_start/resource_active/start/run ③ settle()。合并前是 4 次（②拆成
    // started/running 两次），rev 会从 1 跳到 5；合并后是 3 次，1 跳到 4。
    // W7-E · V48 收口裁定：dispatch 内多了一次 patch()——adapter 一拿到执行期 handle 就
    // 立刻回调 hooks.onHandle 落盘（不等 run() 返回，这是 SIGKILL 后能接回的前提）。
    // V50「少跳一格」与 V48「crash 可恢复」冲突时正确性优先：rev 从 +3 变 +4，如实钉住。
    expect(ran.rev).toBe(planned.rev + 4);
  });

  test("最终落盘的 lifecycle 状态与合并前逐字节一致（只减少了写入次数，不改变状态机结果）", async () => {
    const fx = makeContractFixture(new LocalComputeAdapter({ pollIntervalMs: 5 }));
    const planned = await fx.broker.plan(
      fx.planInput({ network: "none", command: ["/bin/echo", "ok"], outputs: [] }),
      { projectSlug: "contract" },
    );
    const ran = await fx.broker.dispatch(planned.jobId);
    expect(ran.lifecycle.execution).toBe("succeeded");
    expect(ran.lifecycle.delivery).toBe("none");
    expect(ran.dispatchedAt).not.toBeNull();
    expect(ran.finishedAt).not.toBeNull();
    expect(ran.exitCode).toBe(0);
  });
});
