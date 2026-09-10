import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPUTE_OUTPUT_ARTIFACT_KIND,
  COMPUTE_OUTPUT_EVIDENCE,
  COMPUTE_OUTPUT_OBSERVATION_KIND,
} from "../../backend/src/compute/broker";
import { runComputeCommand } from "../../backend/src/compute/cli";
import { ComputeJobStore } from "../../backend/src/compute/job_store";
import { ConclusionStore } from "../../backend/src/conclusion/store";
import { runExpCommand } from "../../backend/src/experiment/cli";
import { ExperimentLoop } from "../../backend/src/experiment/loop";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import { reportFor } from "../../backend/src/report/cli";
import { dataConsistency } from "../../backend/src/reviewer/conclusion_rules";
import { resolvePython } from "../../backend/src/simulation/platform";
import { SimulationRegistry } from "../../backend/src/simulation/registry";

// W5-3 α · CB-6 桥 + S2（算力产出进证据图）+ 真实 SIGKILL 的端到端用例。
//
// 三条纪律，与 experiment.test.ts 一脉相承：
//   1. **真跑，不打桩**：真的起子进程、真的 kill -9、真的读回 SQLite 里的 record。
//      S2 这个洞当初就是靠 `sqlite3 artifacts.db` 才被外部验收发现的——所以断言必须落在
//      「证据图里查得到」，而不是「某个函数被调用过」。函数调用了但没落库，正是这次的病。
//   2. 断言走**生产入口**（`runComputeCommand` / `runExpCommand`），不绕到内部方法上，
//      否则接线断了测试照样绿。
//   3. 失败路径与成功路径同等重要：被 kill 掉的任务必须**如实报**，不许静默当成成功。

const roots: string[] = [];

// 一个真实的算例：先把自己的 pid 写下来（SIGKILL 用例要凭它确认「真的有进程在跑」），
// 再按参数拖一会儿，最后写产物。零第三方依赖。
const TASK_PY = `import json, os, sys, time
with open("started.pid", "w") as fh:
    fh.write(str(os.getpid()))
seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 0.0
deadline = time.time() + seconds
while time.time() < deadline:
    time.sleep(0.05)
with open("result.json", "w") as fh:
    json.dump({"answer": 42, "seconds": seconds}, fh)
print("task done")
`;

interface Harness {
  root: string;
  manager: ProjectManager;
  workspace: string;
  out: string[];
  err: string[];
  text: () => string;
  errText: () => string;
  compute: (args: string[]) => Promise<number>;
  exp: (args: string[]) => Promise<number>;
  open: () => Project;
}

function harness(slug = "s2"): Harness {
  const root = mkdtempSync(join(tmpdir(), "compute-e2e-"));
  roots.push(root);
  const manager = new ProjectManager(root);
  manager.create(slug);
  const workspace = mkdtempSync(join(tmpdir(), "compute-ws-"));
  roots.push(workspace);
  writeFileSync(join(workspace, "task.py"), TASK_PY);
  const out: string[] = [];
  const err: string[] = [];
  return {
    root,
    manager,
    workspace,
    out,
    err,
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
    compute: (args) =>
      runComputeCommand(args, { manager, root, out: (l) => out.push(l), err: (l) => err.push(l) }),
    exp: (args) =>
      runExpCommand(args, { manager, root, out: (l) => out.push(l), err: (l) => err.push(l), pollIntervalMs: 50 }),
    open: () => manager.open(slug),
  };
}

function lastJson(h: Harness): any {
  // CLI 的 --json 输出是**一整行**推进 out 的（JSON.stringify 的结果只调一次 out）。
  for (let i = h.out.length - 1; i >= 0; i--) {
    const line = h.out[i]!;
    if (line.startsWith("{")) return JSON.parse(line);
  }
  throw new Error(`CLI 没有输出 JSON：\n${h.text()}\n${h.errText()}`);
}

/** plan → run → collect 一整条通用路径（不带实验），返回 jobId。 */
async function runOnce(h: Harness, seconds = "0"): Promise<string> {
  expect(
    await h.compute([
      "plan",
      "--purpose",
      "算一个 42",
      "--workspace",
      h.workspace,
      "--upload",
      "task.py",
      "--output",
      "result.json",
      "--json",
      "--",
      resolvePython(),
      "task.py",
      seconds,
    ]),
  ).toBe(0);
  const jobId = lastJson(h).job.jobId as string;
  expect(jobId).toBeTruthy();
  return jobId;
}

afterAll(() => {
  for (const root of roots) {
    try {
      require("node:fs").rmSync(root, { recursive: true, force: true });
    } catch {
      /* 清理失败不该让测试红 */
    }
  }
});

describe("S2 · 算力产出进证据图（通用路径）", () => {
  test("compute run 落 observation、compute collect 落 artifact record —— 都是证据图里查得到的东西", async () => {
    const h = harness("s2a");
    const jobId = await runOnce(h);

    // local + network=none + 无密钥 → approvalRequired 派生为 false（L-3），无需人工审批。
    expect(await h.compute(["run", jobId])).toBe(0);

    // ── 断言①：**执行进终态就该有一条 observation**，不必等收割 ──────────────
    let project = h.open();
    let records = project.records();
    const observations = records.list({ type: "observation" });
    expect(observations.length).toBe(1);
    const observation = observations[0]!;
    expect((observation.metadata as { kind?: string }).kind).toBe(COMPUTE_OUTPUT_OBSERVATION_KIND);
    expect((observation.metadata as { computeJobId?: string }).computeJobId).toBe(jobId);
    // 执行锚点：没有它，基于这条观察写的结论会被 conclusion_rules 判成「手工登记的观察」。
    expect((observation.metadata as { runId?: string }).runId).toBe(jobId);
    // 收割之前不该有产物 record——产物这会儿还在远端/工作目录里。
    expect(records.list({ type: "artifact" })).toEqual([]);
    project.close();

    expect(await h.compute(["collect", jobId])).toBe(0);

    // ── 断言②：harvest 文件各一条 artifact record，且真的指向 artifacts 表 ────
    project = h.open();
    records = project.records();
    const artifactRecords = records.list({ type: "artifact" });
    expect(artifactRecords.length).toBe(1);
    const artifactRecord = artifactRecords[0]!;
    expect((artifactRecord.metadata as { kind?: string }).kind).toBe(COMPUTE_OUTPUT_ARTIFACT_KIND);
    expect((artifactRecord.metadata as { filename?: string }).filename).toBe("result.json");
    expect(artifactRecord.artifactId).toBeTruthy();
    // AD-3：artifact record 必须能顺着 artifactId 取回真实内容，不能是断链的空壳。
    const stored = project.artifacts().get(artifactRecord.artifactId!);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!.content).answer).toBe(42);

    // ── 断言③：图上连得起来 observation --derives_from--> artifact ────────────
    const outgoing = records.edgesOf(observation.id).outgoing.filter((e) => e.type === "derives_from");
    expect(outgoing.map((e) => e.targetId)).toContain(artifactRecord.id);
    project.close();
  }, 60_000);

  test("observation 的 evidence 标签是 computed（确定性层的输入，不许漂）", async () => {
    const h = harness("s2b");
    const jobId = await runOnce(h);
    expect(await h.compute(["run", jobId])).toBe(0);
    expect(await h.compute(["collect", jobId])).toBe(0);
    const project = h.open();
    const records = project.records();
    const observation = records.list({ type: "observation" })[0]!;
    expect(observation.evidence).toBe(COMPUTE_OUTPUT_EVIDENCE);
    expect(observation.evidence).toBe("computed");
    for (const record of records.list({ type: "artifact" })) {
      expect(record.evidence).toBe("computed");
    }
    project.close();
  }, 60_000);

  test("report stats 里算力产出不再是一排零（W5-2 末外部验收撞死的那一幕）", async () => {
    const h = harness("s2c");
    const jobId = await runOnce(h);
    expect(await h.compute(["run", jobId])).toBe(0);
    expect(await h.compute(["collect", jobId])).toBe(0);
    const project = h.open();
    const report = reportFor(project, { now: "2026-09-10T00:00:00.000Z" });
    expect(report.counts.observations).toBe(1);
    project.close();
  }, 60_000);

  test("基于一次算力运行可以写出一条**能过确定性校验**的结论", async () => {
    const h = harness("s2d");
    const jobId = await runOnce(h);
    expect(await h.compute(["run", jobId])).toBe(0);
    expect(await h.compute(["collect", jobId])).toBe(0);

    const project = h.open();
    const records = project.records();
    const observation = records.list({ type: "observation" })[0]!;
    const card = new ConclusionStore(records).create({
      claim: "算例给出 answer=42",
      evidenceIds: [observation.id],
    });
    const { findings, resolved } = dataConsistency({ card, lookup: records });
    // 这正是验收者说「对算力结果永远无法通过」的那条 hard 校验。
    expect(findings.filter((f) => f.severity === "hard")).toEqual([]);
    expect(resolved[0]!.ok).toBe(true);
    // 执行锚点在 → 不是「手工登记的观察」，连 soft 都不该有。
    expect(findings.filter((f) => f.message.includes("evidence_without_execution"))).toEqual([]);
    project.close();
  }, 60_000);
});

describe("CB-6 桥 · 干实验把算例送去算力层", () => {
  test("exp new --target local → 停在等派发 → compute run → exp run --resume 收割，产出带算力足迹", async () => {
    const h = harness("bridge");
    expect(await h.exp(["new", "算力上的阻尼振子", "--target", "local", "--param", "steps=200", "--param", "sampleInterval=20", "--json"])).toBe(0);
    const designed = lastJson(h);
    expect(designed.computeTarget).toBe("local");
    const expId: string = designed.id;

    // 第一次 exp run：只把算力计划建出来，**不替人把钱花出去**。
    expect(await h.exp(["run", expId])).toBe(0);
    expect(h.text()).toContain("等人批准/派发");

    const project = h.open();
    const loop = new ExperimentLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
    });
    const staged = loop.get(expId);
    expect(staged.state).toBe("dry_run");
    expect(staged.computeJobId).toBeTruthy();
    // 还没派发 → 还没有 runId（不编一个假的）。
    expect(staged.runId).toBeNull();
    const jobId = staged.computeJobId!;
    project.close();

    // 人来派发（这一步是计费动作的物理位置）。
    expect(await h.compute(["run", jobId])).toBe(0);

    // 接回来：收割 → 回填成 RunStore 认得的 run → collect → analyze。
    expect(await h.exp(["run", expId, "--resume", "--json"])).toBe(0);

    const after = h.open();
    const records = after.records();
    const loop2 = new ExperimentLoop({
      records,
      artifacts: after.artifacts(),
      platforms: new SimulationRegistry({ root: after.paths.experimentsDir }),
    });
    const view = loop2.get(expId);
    expect(view.state).toBe("analyze");
    expect(view.runId).toContain(jobId);
    expect(view.artifactRecordIds.length).toBeGreaterThan(0);
    expect(view.observationId).toBeTruthy();

    // 桥路径的证据必须带算力足迹（设计 §1.1.8「证据图」行的五个字段）。
    const observation = records.get(view.observationId!)!;
    const meta = observation.metadata as Record<string, unknown>;
    expect(meta.kind).toBe("simulation_summary");
    expect(meta.computeTarget).toBe("local");
    expect(meta.computeJobId).toBe(jobId);
    expect(typeof meta.planDigest).toBe("string");
    expect((meta.planDigest as string).length).toBe(64);
    // 查不到单价就是 null——**绝不是 0**（PRICING 纪律）。
    expect(meta.actualCostUsd).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(meta, "decisionRecordId")).toBe(true);

    const artifactRecord = records.get(view.artifactRecordIds[0]!)!;
    const artifactMeta = artifactRecord.metadata as Record<string, unknown>;
    expect(artifactMeta.computeJobId).toBe(jobId);
    expect(artifactMeta.computeTarget).toBe("local");

    // 桥路径的产物**只登记一次**：broker 的通用证据写入必须给 ExperimentLoop 让路，
    // 否则同一批文件会在图上出现两次（一次 simulation_output，一次 compute_output_file）。
    const computeOwned = records
      .list({ type: "artifact" })
      .filter((r) => (r.metadata as { kind?: string }).kind === COMPUTE_OUTPUT_ARTIFACT_KIND);
    expect(computeOwned).toEqual([]);
    const computeObservations = records
      .list({ type: "observation" })
      .filter((r) => (r.metadata as { kind?: string }).kind === COMPUTE_OUTPUT_OBSERVATION_KIND);
    expect(computeObservations).toEqual([]);
    after.close();
  }, 120_000);

  test("没接算力驱动就跑带 computeTarget 的实验 → 显式报错，**不**悄悄退回本机跑", async () => {
    const h = harness("nodriver");
    const project = h.open();
    const loop = new ExperimentLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
      // 刻意不注入 compute
    });
    const view = await loop.design({
      title: "无驱动",
      platform: "pyref",
      kind: "damped-oscillator",
      params: { steps: 200, sampleInterval: 20 },
      target: "local",
    });
    expect(view.computeTarget).toBe("local");
    await expect(loop.dryRun(view.id)).rejects.toThrow(/没有接算力驱动/);
    // 退回本机跑 = 绕过审批门，所以状态必须原地不动。
    expect(loop.get(view.id).state).toBe("design");
    project.close();
  }, 60_000);
});

describe("真实 SIGKILL · 编排进程与任务一起被 kill -9", () => {
  test("接回时如实报 failed + recoverable，绝不静默当成成功；产物没被 release 掉", async () => {
    const h = harness("sigkill");
    const jobId = await runOnce(h, "60"); // 任务会跑 60 秒，足够我们在中途下手

    // 编排进程放在**另一个真实进程**里——被 SIGKILL 的必须是一个真的进程，
    // 不是一个假装被杀的 mock。
    const script = join(h.root, "orchestrator.ts");
    const repo = join(import.meta.dir, "../..");
    writeFileSync(
      script,
      `import { runComputeCommand } from ${JSON.stringify(join(repo, "backend/src/compute/cli.ts"))};\n` +
        `import { ProjectManager } from ${JSON.stringify(join(repo, "backend/src/project/manager.ts"))};\n` +
        `const [root, jobId] = process.argv.slice(2);\n` +
        `const manager = new ProjectManager(root);\n` +
        `await runComputeCommand(["run", jobId], { manager, root, out: () => {}, err: () => {} });\n`,
    );
    const child = Bun.spawn([process.execPath, script, h.root, jobId], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });

    const jobs = new ComputeJobStore(join(h.open().paths.experimentsDir, "compute", "jobs"));
    const pidFile = join(jobs.dirOf(jobId), "workspace", "started.pid");
    const deadline = Date.now() + 30_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(50);
    expect(existsSync(pidFile)).toBe(true); // 任务真的起来了
    const taskPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(taskPid)).toBe(true);

    // 三刀齐下：编排进程 + shim（/bin/sh） + 算例本身，都 kill -9，
    // 于是**谁也没来得及写 exit-code 标记**——这正是「任务跑到一半连人带机器一起没了」。
    const ppid = Number(
      Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(taskPid)]).stdout.toString().trim(),
    );
    process.kill(child.pid, "SIGKILL");
    if (Number.isInteger(ppid) && ppid > 1) {
      try {
        process.kill(ppid, "SIGKILL");
      } catch {
        /* 竞态：已经没了 */
      }
    }
    try {
      process.kill(taskPid, "SIGKILL");
    } catch {
      /* 同上 */
    }
    await child.exited;
    await Bun.sleep(200);

    // 磁盘真源上这个任务还停在「在跑」——因为没有任何人来得及收尾。
    expect(jobs.get(jobId).lifecycle.execution).toBe("running");
    expect(existsSync(join(jobs.dirOf(jobId), "exit-code"))).toBe(false);

    // 全新的进程视角接回来（`compute recover` 是 broker.recover() 的生产入口）。
    expect(await h.compute(["recover", jobId])).toBe(1);

    const recovered = jobs.get(jobId);
    // ① 不许静默当成成功。
    expect(recovered.lifecycle.execution).toBe("failed");
    expect(recovered.lifecycle.execution).not.toBe("succeeded");
    // ② 如实报 recoverable：产物可能只剩本地 job 目录这一份。
    expect(recovered.lifecycle.recoverable).toBe(true);
    // ③ 说清楚发生了什么、东西在哪儿——不许用「从未真正派发出去」这种假话打发。
    expect(recovered.message).toContain("派发过");
    expect(recovered.message).toContain(recovered.jobDir);
    expect(recovered.message).not.toContain("从未真正派发出去");

    // ④ recoverable 是**有牙齿的**：release 会被 L-4 拦下来，唯一的产物副本删不掉。
    const before = h.err.length;
    expect(await h.compute(["release", jobId])).toBe(1);
    expect(h.err.slice(before).join("\n")).toContain("不许关掉持有唯一可恢复产物副本的资源");
    expect(existsSync(join(jobs.dirOf(jobId), "workspace"))).toBe(true);
  }, 120_000);
});
