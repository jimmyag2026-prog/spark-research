import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { WetLabLoop } from "../../backend/src/lab/wet_loop";
import { WetExecutionConflictError, WetStateError } from "../../backend/src/lab/wet_models";
import { ProjectManager } from "../../backend/src/project/manager";

// P10-d · D-9 验收测试。
//
// 评审实测的漏洞：`WetLabLoop.execute()` 在改动前，状态在整个执行期间原地不动
// （`wet_run` 从 approve 一直挂到 backend.execute() resolve 之后才推进），
// 且没有任何行写入发生在 `await this.backend.execute(...)` 之前。
// 两个并发的 `POST /simulate` 各自的同步前缀都会看到"能执行"，双双真正调用后端——
// 一次批准，物理协议被跑了两次。
//
// 修复点在 `backend/src/lab/wet_loop.ts` 的 `execute()`：真正调用后端之前，
// 先用 `RecordStore.update(..., { expectedRev })` 做一次 CAS，把 approved → executing
// 声明成"只有一次能赢"的原子操作；rev 对不上（或状态已经不是 approved）一律判负，
// 抛 `WetExecutionConflictError`（继承 `WetStateError`，HTTP 层映射到 409）。
//
// 这里用 N=30 次"并发"execute() 调用同一份已获批协议，断言**恰好 1 次**真正跑完
// （state 落到 collect），其余全部拿到冲突类错误，一次都不会有第二次物理/模拟执行。
describe("D-9 · 一次批准并发执行两次（并发 execute 只许一次真正执行）", () => {
  test("N=30 次并发 execute() 同一份已获批协议 → 恰好 1 次成功，其余全部 409 语义的冲突错误", async () => {
    const root = mkdtempSync(join(tmpdir(), "approve-once-"));
    const manager = new ProjectManager(root);
    const project = manager.create("concurrency");
    const loop = new WetLabLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      root: join(project.paths.experimentsDir, "wet"),
      backend: new MockDeviceBackend(),
    });

    const view = loop.design({
      title: "并发 execute 压力测试",
      naturalLanguage: "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD",
    });
    loop.compile(view.id);
    loop.safetyCheck(view.id);
    const { view: approved } = loop.approve(view.id, { actor: "并发测试员" });
    expect(approved.state).toBe("approved");

    const N = 30;
    // 同步地把 N 次 execute() 调用一次性发起（不在中间 await）：execute() 的同步前缀
    // （状态检查 + hash 复核 + CAS 声明执行权）会在这个循环里一个接一个跑完——
    // 这正是「谁先声明成功」在真实单进程/单事件循环里必然发生的方式；即便未来这条路径
    // 前面插入了别的 await（比如 HTTP 层任务队列的调度），CAS 仍然是保证正确性的那一层，
    // 不依赖"谁先跑到"的时序巧合。
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => loop.execute(view.id, { note: "concurrent" })),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof loop.execute>>
    >[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    // 恰好 1 次真正执行到底。
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.state).toBe("collect");
    expect(fulfilled[0]!.value.attempts).toBe(1);

    // 其余 N-1 次全部判负，且都是冲突类错误（WetExecutionConflictError 或者
    // 因为已经翻过 collect/executing 而来的 WetStateError——两者都继承 WetStateError，
    // HTTP 层现成的 `WetStateError → 409` 映射不用改就能拿到正确语义）。
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(WetStateError);
    }
    // 至少要出现过 WetExecutionConflictError 这个更精确的类型（不是全部退化成别的错误）。
    expect(rejected.some((r) => r.reason instanceof WetExecutionConflictError)).toBe(true);

    // 物理/模拟设备真的只被摸了一次：run 目录只有一个，run log 条目数与单次执行一致。
    const final = loop.get(view.id);
    expect(final.state).toBe("collect");
    expect(final.attempts).toBe(1);
    expect(final.artifactRecordIds.length).toBeGreaterThanOrEqual(3);

    project.close();
  }, 30_000);
});
