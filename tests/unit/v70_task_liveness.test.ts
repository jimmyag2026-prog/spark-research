import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRegistry, getProcessStartTime, type TaskSnapshot } from "../../backend/src/server/tasks";

// BACKLOG V70 + V3：`server/tasks.ts` 的「僵尸任务」判据（V11）只回答「这条记录是不是从
// 磁盘读回来的」（`recovered`），从来不回答「持有它 run() 闭包的进程现在到底还在不在」。
// V70 的原始投诉：kill 掉那个进程之后，`lit tasks` 会永久显示 running，没有 liveness 判据。
// V3 补一层：只核 pid 存在性不够——pid 会被系统回收又分配给一个完全无关的新进程
// （所谓 pid 复用），得再核一次「启动时间对不对得上」才能确认「就是当年那个进程」。
//
// 这份文件测的是 `TaskRegistry.get()`/`list()` 里新加的 `applyLiveness()` 判据本身：
// 本文件不通过 `start()` 走「本进程亲手在跑」的路径（那条路径的 pid 就是测试进程自己，
// 永远存活，测不出「死了」的分支）——而是直接往磁盘写一份「本该由另一个进程的 start()
// 写出」的快照，再用一个全新的 TaskRegistry 去读，模拟「进程重启后读回一条别的进程
// 留下的记录」这个 V70/V3 原本要处理的场景。

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-tasks-w70-"));
}

function writeSnapshot(root: string, snapshot: TaskSnapshot): void {
  const tasksDir = join(root, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2) + "\n");
}

function baseSnapshot(id: string, overrides: Partial<TaskSnapshot>): TaskSnapshot {
  const now = new Date().toISOString();
  return {
    id,
    kind: "test.liveness",
    project: null,
    state: "running",
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    progress: null,
    result: null,
    error: null,
    events: [],
    recovered: null,
    pid: null,
    pidStartedAt: null,
    startTimeUnavailable: false,
    orphanReason: null,
    ...overrides,
  };
}

describe("TaskRegistry liveness（V70 + V3）", () => {
  test("① kill -9 真实子进程后，读回状态为 orphaned（pid 不存在）", async () => {
    const root = freshRoot();
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    // 给 ps 一点时间把新起的子进程登记进进程表——spawn 后立刻查在某些机器上可能还没出现。
    await new Promise((resolve) => setTimeout(resolve, 80));
    const pidStartedAt = getProcessStartTime(child.pid);

    writeSnapshot(
      root,
      baseSnapshot("fake-task-killed", {
        pid: child.pid,
        pidStartedAt,
        startTimeUnavailable: pidStartedAt === null,
      }),
    );

    child.kill(9);
    await child.exited;

    const registry = new TaskRegistry({ root });
    const read = registry.get("fake-task-killed");
    expect(read).not.toBeNull();
    expect(read?.state).toBe("orphaned");
    expect(read?.orphanReason).toContain(String(child.pid));
    expect(read?.orphanReason).toContain("不存在");

    // list() 走的是同一份判据，结果必须一致。
    const listed = registry.list().find((t) => t.id === "fake-task-killed");
    expect(listed?.state).toBe("orphaned");
  });

  test("② pid 复用假阳性：pid 此刻存活，但启动时间对不上 → orphaned 而不是 running", () => {
    const root = freshRoot();
    // 用测试进程自己的 pid（此刻必然存活）配一个伪造的启动时间——模拟「这个 pid 现在
    // 被一个完全无关的新进程占着，不是当年那个进程」。
    const fakeStartedAt = new Date(0).toISOString();
    writeSnapshot(
      root,
      baseSnapshot("fake-task-reused-pid", {
        pid: process.pid,
        pidStartedAt: fakeStartedAt,
        startTimeUnavailable: false,
      }),
    );

    const registry = new TaskRegistry({ root });
    const read = registry.get("fake-task-reused-pid");
    expect(read?.state).toBe("orphaned");
    expect(read?.orphanReason).toContain("复用");
    // 光核 pid 存在性会把这条误判成 running——下面这个只是把判据的两个输入摆在一起看，
    // 真正的「拆掉会红」对照跑在 docs/devlog/W7-C2.md 里记录的阴性对照（手工改代码复跑），
    // 不在这里重复断言实现细节。
    expect(read?.state).not.toBe("running");
  });

  test("③ 正常存活（pid 一致、启动时间吻合）→ running 不变", () => {
    const root = freshRoot();
    const pidStartedAt = getProcessStartTime(process.pid);
    expect(pidStartedAt).not.toBeNull(); // 本机应该能查到自己的启动时间。

    writeSnapshot(
      root,
      baseSnapshot("fake-task-alive", {
        pid: process.pid,
        pidStartedAt,
        startTimeUnavailable: false,
      }),
    );

    const registry = new TaskRegistry({ root });
    const read = registry.get("fake-task-alive");
    expect(read?.state).toBe("running");
    expect(read?.orphanReason ?? null).toBeNull();
  });

  test("④ 取不到启动时间的平台路径：退化为只核 pid 存在，并标注 startTimeUnavailable", () => {
    const root = freshRoot();

    // ④a：pid 存活、但 startTimeUnavailable=true（平台/权限探测不到启动时间）——
    // 只能核存在性，存在就继续报 running，不能编一个可能错的时间去比对。
    writeSnapshot(
      root,
      baseSnapshot("fake-task-alive-no-starttime", {
        pid: process.pid,
        pidStartedAt: null,
        startTimeUnavailable: true,
      }),
    );
    const registryA = new TaskRegistry({ root });
    const alive = registryA.get("fake-task-alive-no-starttime");
    expect(alive?.state).toBe("running");
    expect(alive?.startTimeUnavailable).toBe(true);

    // ④b：pid 干脆不存在了，即便 startTimeUnavailable=true，pid 存在性这一核还是能做——
    // 退化判据不等于完全放弃判据，pid 消失依然是确凿信号。
    writeSnapshot(
      root,
      baseSnapshot("fake-task-dead-no-starttime", {
        pid: 999_999, // 几乎不可能是真实存活的 pid
        pidStartedAt: null,
        startTimeUnavailable: true,
      }),
    );
    const registryB = new TaskRegistry({ root });
    const dead = registryB.get("fake-task-dead-no-starttime");
    expect(dead?.state).toBe("orphaned");
    expect(dead?.startTimeUnavailable).toBe(true);
  });

  test("旧快照（V70 之前落盘、没有 pid 字段）：查不了，维持既有『只多报不少报』口径，仍是 running", () => {
    const root = freshRoot();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    // 故意不写 pid/pidStartedAt/startTimeUnavailable 字段，模拟 V70 之前的旧快照格式。
    const legacy = {
      id: "legacy-task",
      kind: "test.legacy",
      project: null,
      state: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: null,
      result: null,
      error: null,
      events: [],
      recovered: null,
    };
    writeFileSync(join(tasksDir, "legacy-task.json"), JSON.stringify(legacy, null, 2) + "\n");

    const registry = new TaskRegistry({ root });
    const read = registry.get("legacy-task");
    expect(read?.state).toBe("running");
  });
});
