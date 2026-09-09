import { describe, expect, test } from "bun:test";
import { TaskRegistry } from "../../backend/src/server/tasks";

// D-2（P10-b）验收 4/4：server 长任务路径。
//
// `backend/src/server/routes/shared.ts` 的 `taskResponse()`（不在本 lane 改动范围，
// 只读）统一经 `ServerContext.tasks`（一个 TaskRegistry 实例）跑长任务：异步模式
// 202 + 轮询 `/api/tasks/:id`，同步模式 `{"await":true}` 直接 `ctx.tasks.settle(id)`。
// 两条路径共同的风险点是同一个：`options.run(handle)` 本身没有任何超时逻辑时
// （比如内部调过一个没设超时的第三方库),那整个任务句柄会永远停在 "running"，
// 轮询和 `await` 模式都会挂死。TaskRegistry.start() 现在给 run() 套了一层兜底
// 超时，这里直接对 TaskRegistry 验证（不需要起 HTTP server），断言短超时内任务
// 落到 state=failed 且 error.timeout=true。

describe("D-2 验收：server 长任务路径不会挂死", () => {
  test("永不 resolve 的任务体在短超时内落定为可见的超时失败", async () => {
    const registry = new TaskRegistry({ timeoutMs: 200 });
    const snapshot = registry.start({
      kind: "test-long-task",
      run: () => new Promise(() => {}),
    });
    expect(snapshot.state).toBe("running");

    const started = Date.now();
    const settled = await registry.settle(snapshot.id);
    const elapsed = Date.now() - started;

    expect(settled?.state).toBe("failed");
    expect(settled?.error?.timeout).toBe(true);
    expect(settled?.error?.message).toContain("timed out");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3_000);

    // 轮询路径（GET /api/tasks/:id）同样能看到落定后的终态，不需要额外等待。
    expect(registry.get(snapshot.id)?.state).toBe("failed");
  });
});
