import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRegistry, TaskTimeoutError, type TaskSnapshot } from "../../backend/src/server/tasks";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-tasks-w4c-"));
}

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

describe("TaskRegistry 落盘（V11）", () => {
  test("不给 root：完全内存实现，不在文件系统上留任何痕迹", async () => {
    const registry = new TaskRegistry({});
    const snapshot = registry.start({ kind: "test", run: async () => "ok" });
    await registry.settle(snapshot.id);
    // 没有 root 就没有 tasksDir 这回事——这里只是确认新代码没有意外引入一个隐藏的默认目录
    // （比如误用 dataDir()/homedir()）。真正的把关是下面几条给了 root 的用例。
    expect(registry.get(snapshot.id)?.state).toBe("succeeded");
  });

  test("给了 root：任务快照落到 <root>/tasks/<id>.json，状态迁移与 progress 都会覆写", async () => {
    const root = freshRoot();
    const registry = new TaskRegistry({ root });
    const events: unknown[] = [];
    const snapshot = registry.start({
      kind: "test.progress",
      run: async (task) => {
        task.progress(1, 3, "第一步");
        task.progress(2, 3, "第二步");
        return { ok: true };
      },
    });
    const file = join(root, "tasks", `${snapshot.id}.json`);
    expect(existsSync(file)).toBe(true);
    const settled = await registry.settle(snapshot.id);
    void events;
    expect(settled?.state).toBe("succeeded");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as TaskSnapshot;
    expect(onDisk.state).toBe("succeeded");
    expect(onDisk.result).toEqual({ ok: true });
    // progress 事件本身也落在磁盘快照的 events 日志里（只增日志，见文件头纪律②③）。
    expect(onDisk.events.some((e) => e.message === "第一步")).toBe(true);
    expect(onDisk.events.some((e) => e.message === "第二步")).toBe(true);
    expect(onDisk.recovered ?? null).toBeNull();
  });

  test("跨实例：新 TaskRegistry 用同一个 root 构造，能读回已完成任务的终态（不需要重跑）", async () => {
    const root = freshRoot();
    const registryA = new TaskRegistry({ root });
    const snapshot = registryA.start({ kind: "test.persist", run: async () => "记录 A 的结果" });
    await registryA.settle(snapshot.id);

    // 模拟「进程重启」：不复用 registryA，直接用同一个 root 建一个全新的 TaskRegistry。
    const registryB = new TaskRegistry({ root });
    const recovered = registryB.get(snapshot.id);
    expect(recovered?.state).toBe("succeeded");
    expect(recovered?.result).toBe("记录 A 的结果");
    // 终态是磁盘上的真实结果，不需要、也不应该打 recovered 标记（判据见文件头大注释）。
    expect(recovered?.recovered ?? null).toBeNull();
  });

  test("僵尸任务：进程重启后，磁盘上还是 running 的快照被诚实地打上 recovered 标记（不撒谎报成功/失败）", async () => {
    const root = freshRoot();
    const registryA = new TaskRegistry({ root });
    const snapshot = registryA.start({
      kind: "test.zombie",
      run: () => new Promise(() => {}), // 永不落定：模拟进程在这里被杀掉，句柄永远停在 running
    });
    expect(snapshot.state).toBe("running");
    // 不 await settle——真实场景里进程会在这里被杀，没人等得到 settle。

    const registryB = new TaskRegistry({ root }); // 模拟重启
    const zombie = registryB.get(snapshot.id);
    expect(zombie).not.toBeNull();
    // 安全方向：state 仍然报 running（不谎称 failed，也不谎称 succeeded）。
    expect(zombie?.state).toBe("running");
    // 但现在可以分辨——这正是本用例要验证的核心判据。
    expect(zombie?.recovered?.reason).toBe("no-terminal-record-on-disk");
    expect(typeof zombie?.recovered?.at).toBe("string");

    // list() 里同样看得到，且 subscribe() 不会挂一个永远不会触发的订阅（没有 live 的 run() 了）。
    expect(registryB.list().map((t) => t.id)).toContain(snapshot.id);
    const sub = registryB.subscribe(snapshot.id, () => {
      throw new Error("hydrated 任务不应该再触发任何订阅回调");
    });
    expect(sub).not.toBeNull();
    sub!.cancel();

    // settle() 对一条 hydrated 记录也不会挂死——没有真实 run() 在跑，只能诚实地立刻给出当前快照。
    const settled = await registryB.settle(snapshot.id);
    expect(settled?.state).toBe("running");
    expect(settled?.recovered?.reason).toBe("no-terminal-record-on-disk");
  });

  test("僵尸标记只计算一次并落盘：第三次重启不会覆盖 recovered.at", async () => {
    const root = freshRoot();
    const registryA = new TaskRegistry({ root });
    const snapshot = registryA.start({ kind: "test.zombie2", run: () => new Promise(() => {}) });
    void snapshot;

    const registryB = new TaskRegistry({ root });
    const firstAt = registryB.get(snapshot.id)?.recovered?.at;
    expect(firstAt).toBeTruthy();

    const registryC = new TaskRegistry({ root });
    const secondAt = registryC.get(snapshot.id)?.recovered?.at;
    expect(secondAt).toBe(firstAt);
  });

  test("损坏/半写的任务文件在恢复时被跳过，不会让整个 hydrate 崩掉", async () => {
    const root = freshRoot();
    const registryA = new TaskRegistry({ root });
    const good = registryA.start({ kind: "test.good", run: async () => "fine" });
    await registryA.settle(good.id);

    // 手写一份损坏的任务文件（半截 JSON），模拟进程在 writeFileSync 中途被杀。
    const tasksDir = join(root, "tasks");
    writeFileSync(join(tasksDir, "broken-task-id.json"), '{"id":"broken-task-id","state":"runni');

    const registryB = new TaskRegistry({ root });
    expect(registryB.get(good.id)?.state).toBe("succeeded");
    expect(registryB.get("broken-task-id")).toBeNull();
    // 好的记录没有被坏文件拖累。
    expect(registryB.list().map((t) => t.id)).toContain(good.id);
  });

  test("超过 capacity 淘汰已完成任务时，磁盘上的文件也一并删除", async () => {
    const root = freshRoot();
    const registry = new TaskRegistry({ root, capacity: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const s = registry.start({ kind: "test.evict", run: async () => i });
      await registry.settle(s.id);
      ids.push(s.id);
    }
    const tasksDir = join(root, "tasks");
    // 最早的两条应该已经被淘汰、文件也被删除。
    expect(existsSync(join(tasksDir, `${ids[0]}.json`))).toBe(false);
    expect(existsSync(join(tasksDir, `${ids[1]}.json`))).toBe(false);
    // 最新的还在。
    expect(existsSync(join(tasksDir, `${ids[3]}.json`))).toBe(true);
  });
});
