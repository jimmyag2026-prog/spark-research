// W7-C1 · BACKLOG V64 根治：全局 `state.json.currentProject` / `sessions{}` 无锁，
// 两个并发会话互相改写对方的落库目标（R1 双向实锤，双双弃项目重建）。
//
// 修复见 `backend/src/project/manager.ts`：
//   · `state.json` 的每一次 read-modify-write（`setCurrent` / `bindSession` /
//     归档时清全局指针）全部套 `state.json.lock` 文件锁（O_EXCL 创建 + 过期回收，
//     复用 `server/tasks.ts` 的 `isProcessAlive`，见该文件顶部大注释）。
//   · `openProjectResolved` 单点四档解析：--project > env SPARK_RESEARCH_PROJECT >
//     `sessions[sessionId]` > 全局 `currentProject`（单测在 tests/unit/project.test.ts）。
//
// 本文件验证两件事，且都用**真实子进程**（不是同进程内 Promise.allSettled 假并发——
// `ProjectManager` 的锁是同步阻塞的 `Bun.sleepSync` 忙等，会把本线程事件循环堵死，
// 同进程内的定时器/微任务在等待期间根本不会被调度，测不出「真的在等锁」；只有
// 另一个真实操作系统进程才能在本线程阻塞期间照常读写文件）：
//
//   ① 两个真实子进程各自循环 N 次交替「`project use <自己的两个项目之一>` + 写一条
//      record」，断言每条 record 最终落进的项目与该次 `use` 指定的项目一致（零串项目）。
//      两个进程各自在自己名下的两个项目间**逐次切换**（而不是每次都用同一个 slug）：
//      如果只用同一个 slug，`bindSession` 的 read-modify-write 即使发生「丢更新」
//      （lost update：并发写手互相用旧快照覆盖对方刚写完的那份），文件里剩下的值
//      也还是同一个 slug——测不出问题。逐次切换让每一轮期望值都不同，丢更新会立刻
//      表现成「读回的绑定是上一轮的旧值」，可观测、可断言。
//   ② 锁过期回收：伪造一把持锁 pid 已死、且早已超过过期阈值的锁文件，断言后来者
//      立刻（不必等）回收并拿到锁；另测「持锁者仍存活但很快释放」的等待-重试路径，
//      用真实子进程延迟删除锁文件来验证调用方确实在阻塞等待、而不是绕过锁。

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectManager } from "../../backend/src/project/manager";

const REPO_ROOT = join(import.meta.dir, "../..");
const MANAGER_URL = pathToFileURL(join(REPO_ROOT, "backend/src/project/manager.ts")).href;
const CLI_URL = pathToFileURL(join(REPO_ROOT, "backend/src/project/cli.ts")).href;

const dirs: string[] = [];
function tempRoot(prefix = "spark-project-pointer-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// 子进程跑的脚本本身按需生成到系统临时目录（不落进 repo——本 lane 的足迹只允许新增
// 这一个测试文件）。用 file:// 绝对路径 import 仓库源码，跟脚本自己落在哪个目录无关。
function writeWorkerScript(): string {
  const src = `
import { ProjectManager, openProjectResolved } from "${MANAGER_URL}";
import { runProjectCommand } from "${CLI_URL}";

const [root, sessionId, slugEven, slugOdd, iterationsStr] = process.argv.slice(2);
const iterations = Number(iterationsStr);
process.env.SPARK_RESEARCH_SESSION = sessionId;
delete process.env.SPARK_RESEARCH_PROJECT;

const manager = new ProjectManager(root);
const results = [];
for (let i = 0; i < iterations; i++) {
  const expected = i % 2 === 0 ? slugEven : slugOdd;
  const code = runProjectCommand(["use", expected], {
    manager,
    root,
    out: () => {},
    err: () => {},
  });
  if (code !== 0) {
    console.log(JSON.stringify({ fatal: true, iter: i, code }));
    process.exit(1);
  }
  const project = openProjectResolved(manager, undefined);
  const rec = project.records().create({
    type: "observation",
    content: \`worker-\${sessionId}-iter-\${i}\`,
    evidence: "observed",
    metadata: { expectedProject: expected, sessionId, iter: i },
  });
  results.push({ iter: i, expected, resolvedProject: project.slug, ok: project.slug === expected, recordId: rec.id });
  project.close();
}
console.log(JSON.stringify(results));
`;
  const dir = mkdtempSync(join(tmpdir(), "spark-project-pointer-worker-"));
  dirs.push(dir);
  const file = join(dir, "worker.ts");
  writeFileSync(file, src);
  return file;
}

interface WorkerResult {
  iter: number;
  expected: string;
  resolvedProject: string;
  ok: boolean;
  recordId: string;
}

async function runWorker(
  workerScript: string,
  root: string,
  sessionId: string,
  slugEven: string,
  slugOdd: string,
  iterations: number,
): Promise<WorkerResult[] | { fatal: true; iter: number; code: number }> {
  const proc = Bun.spawn(["bun", "run", workerScript, root, sessionId, slugEven, slugOdd, String(iterations)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !stdout.trim()) {
    throw new Error(`worker(${sessionId}) 异常退出 code=${exitCode}\nstderr:\n${stderr}`);
  }
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`worker(${sessionId}) 没有输出\nstderr:\n${stderr}`);
  }
  return JSON.parse(lastLine);
}

interface RaceOutcome {
  okA: boolean;
  okB: boolean;
  root: string;
  resultsA: WorkerResult[];
  resultsB: WorkerResult[];
  badA: WorkerResult[];
  badB: WorkerResult[];
}

// 真正跑两个真实子进程各 N 次交替「project use（自己的两个项目之一）+ 写 record」，
// 断言零串项目。返回详细结果，供正/负对照复用同一段驱动逻辑。
async function runTwoWorkerRace(iterations: number): Promise<RaceOutcome> {
  const root = tempRoot();
  const manager = new ProjectManager(root);
  manager.create("proj-a1", { name: "A1" }).close();
  manager.create("proj-a2", { name: "A2" }).close();
  manager.create("proj-b1", { name: "B1" }).close();
  manager.create("proj-b2", { name: "B2" }).close();

  const workerScript = writeWorkerScript();
  const [resultA, resultB] = await Promise.all([
    runWorker(workerScript, root, "sess-race-a", "proj-a1", "proj-a2", iterations),
    runWorker(workerScript, root, "sess-race-b", "proj-b1", "proj-b2", iterations),
  ]);

  if ("fatal" in resultA || "fatal" in resultB) {
    throw new Error(`worker 提前失败：A=${JSON.stringify(resultA)} B=${JSON.stringify(resultB)}`);
  }
  const resultsA = resultA as WorkerResult[];
  const resultsB = resultB as WorkerResult[];

  const badA = resultsA.filter((r) => !r.ok);
  const badB = resultsB.filter((r) => !r.ok);
  return { okA: badA.length === 0, okB: badB.length === 0, root, resultsA, resultsB, badA, badB };
}

describe("V64 根治 · 两个真实子进程交替 project use + 写 record（零串项目）", () => {
  test("100 次交替：每条 record 的 project 与该次 use 一致，且两进程互不串项目", async () => {
    const iterations = 100;
    const { okA, okB, root, resultsA, resultsB, badA, badB } = await runTwoWorkerRace(iterations);
    expect(badA, `A 进程串项目的迭代：${JSON.stringify(badA)}`).toEqual([]);
    expect(badB, `B 进程串项目的迭代：${JSON.stringify(badB)}`).toEqual([]);
    expect(okA).toBe(true);
    expect(okB).toBe(true);

    // 独立于「worker 自己声称 ok」的二次核验：直接开四个项目各自的 records.db，
    // 逐条核 project 字段 + metadata.expectedProject 是否一致——即便解析逻辑有 bug
    // 让 project.slug 汇报值本身被污染，落进磁盘的 record 行数/归属也不会说谎；
    // 并且断言 A 的两个项目里绝不出现 B 写的 record，反之亦然（跨进程零串项目）。
    const manager = new ProjectManager(root);
    const slugs = ["proj-a1", "proj-a2", "proj-b1", "proj-b2"] as const;
    const countBySlug: Record<string, number> = {};
    for (const slug of slugs) {
      const project = manager.open(slug);
      const records = project.records().list({ limit: iterations + 10 });
      project.close();
      countBySlug[slug] = records.length;
      for (const r of records) {
        expect(r.project).toBe(slug);
        expect((r.metadata as Record<string, unknown>).expectedProject).toBe(slug);
        const sid = (r.metadata as Record<string, unknown>).sessionId;
        // A 的项目只能有 A 写的 record，B 的项目只能有 B 写的 record。
        if (slug.startsWith("proj-a")) expect(sid).toBe("sess-race-a");
        else expect(sid).toBe("sess-race-b");
      }
    }
    // 100 次交替、偶数轮/奇数轮各一半，总数对得上（各进程的两个项目合计 = iterations）。
    expect(countBySlug["proj-a1"]! + countBySlug["proj-a2"]!).toBe(iterations);
    expect(countBySlug["proj-b1"]! + countBySlug["proj-b2"]!).toBe(iterations);

    const idsA = new Set(resultsA.map((r) => r.recordId));
    const idsB = new Set(resultsB.map((r) => r.recordId));
    expect(idsA.size).toBe(iterations);
    expect(idsB.size).toBe(iterations);
    for (const id of idsA) expect(idsB.has(id)).toBe(false);
  }, 60_000);
});

describe("V64 根治 · state.json.lock 过期回收 + 等待-重试", () => {
  test("伪造死 pid 的过期锁：立刻回收，不必等待真正的过期阈值", async () => {
    const root = tempRoot();
    const manager = new ProjectManager(root);
    manager.create("s1");
    manager.create("s2");

    // 造一个「真实存在过、现在已经退出」的 pid——比瞎编一个大数字更贴近「伪造死 pid」
    // 这个要求本身：这个 pid 在 spawn 期间是真实分配过的操作系统 pid。
    const dead = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    const deadPid = dead.pid;

    const lockFile = join(root, "state.json.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: deadPid, acquiredAtMs: Date.now() - 20_000 }));

    const start = Date.now();
    manager.setCurrent("s2");
    const elapsed = Date.now() - start;

    expect(manager.currentSlug()).toBe("s2");
    // 立刻回收：远小于过期阈值（10s），不是傻等到超时。
    expect(elapsed).toBeLessThan(2_000);
    // 用完即释放，没有残留锁文件。
    expect(existsSync(lockFile)).toBe(false);
  });

  test("持锁者仍存活、锁未过期：后来者阻塞等待，锁被真实子进程释放后立刻拿到（不是绕过锁直接写）", async () => {
    const root = tempRoot();
    const manager = new ProjectManager(root);
    manager.create("w1");
    manager.create("w2");

    const lockFile = join(root, "state.json.lock");
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() }));

    // 真实子进程延迟 150ms 后删除锁文件，模拟「另一个正常持有者写完后释放」。
    // 必须是真实子进程：`manager.setCurrent()` 的等待是同步阻塞（`Bun.sleepSync`），
    // 会把本线程事件循环整个堵死，本进程内的 setTimeout 在等待期间不会被调度。
    const releaser = Bun.spawn([
      "bun",
      "-e",
      `await Bun.sleep(150); try { require("node:fs").unlinkSync(${JSON.stringify(lockFile)}); } catch {}`,
    ]);

    const start = Date.now();
    manager.setCurrent("w2");
    const elapsed = Date.now() - start;
    await releaser.exited;

    expect(manager.currentSlug()).toBe("w2");
    // 确实等待过（锁释放前不可能拿到），且没有超过几秒的离谱等待。
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(5_000);
    expect(existsSync(lockFile)).toBe(false);
  }, 15_000);
});
