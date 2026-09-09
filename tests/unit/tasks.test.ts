import { describe, expect, test } from "bun:test";
import { TaskRegistry, TaskTimeoutError } from "../../backend/src/server/tasks";

// D-2（P10-b）：TaskRegistry 是长任务的最后一道兜底——即便任务体自己没有任何超时
// 逻辑（旧代码路径、第三方库内部裸调用），也不能让 `GET /api/tasks/:id` 或
// `{"await":true}` 的调用方永远停在 "running"。

describe("TaskRegistry 超时（D-2）", () => {
  test("永不 resolve 的任务体在 timeoutMs 内落到 state=failed，error.timeout=true", async () => {
    const registry = new TaskRegistry({ timeoutMs: 200 });
    const snapshot = registry.start({
      kind: "test",
      run: () => new Promise(() => {}), // 永不 resolve/reject
    });
    expect(snapshot.state).toBe("running");

    const started = Date.now();
    const settled = await registry.settle(snapshot.id);
    const elapsed = Date.now() - started;

    expect(settled?.state).toBe("failed");
    expect(settled?.error?.timeout).toBe(true);
    expect(settled?.error?.message).toContain("timed out");
    expect(elapsed).toBeLessThan(5_000);
  });

  test("per-task timeoutMs 覆盖 registry 默认值", async () => {
    const registry = new TaskRegistry({ timeoutMs: 60_000 });
    const snapshot = registry.start({
      kind: "test",
      run: () => new Promise(() => {}),
      timeoutMs: 150,
    });
    const started = Date.now();
    const settled = await registry.settle(snapshot.id);
    expect(settled?.state).toBe("failed");
    expect(settled?.error?.timeout).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("正常完成的任务不受超时机制干扰，且 error 上没有 timeout 标记", async () => {
    const registry = new TaskRegistry({ timeoutMs: 5_000 });
    const snapshot = registry.start({
      kind: "test",
      run: async () => ({ ok: true }),
    });
    const settled = await registry.settle(snapshot.id);
    expect(settled?.state).toBe("succeeded");
    expect(settled?.result).toEqual({ ok: true });
    expect(settled?.error).toBeNull();
  });

  test("任务体自己抛出的错误仍然是 error.timeout 未设置（能与超时区分）", async () => {
    const registry = new TaskRegistry({ timeoutMs: 5_000 });
    const snapshot = registry.start({
      kind: "test",
      run: async () => {
        throw new Error("upstream exploded");
      },
    });
    const settled = await registry.settle(snapshot.id);
    expect(settled?.state).toBe("failed");
    expect(settled?.error?.message).toBe("upstream exploded");
    expect(settled?.error?.timeout).toBeUndefined();
  });

  test("timeoutMs<=0 显式关闭超时", async () => {
    const registry = new TaskRegistry({ timeoutMs: 0 });
    const snapshot = registry.start({
      kind: "test",
      run: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "done";
      },
    });
    const settled = await registry.settle(snapshot.id);
    expect(settled?.state).toBe("succeeded");
    expect(settled?.result).toBe("done");
  });

  test("TaskTimeoutError 可被 instanceof 识别", () => {
    const err = new TaskTimeoutError(100);
    expect(err).toBeInstanceOf(Error);
    expect(err.timeout).toBe(true);
    expect(err.timeoutMs).toBe(100);
  });
});
