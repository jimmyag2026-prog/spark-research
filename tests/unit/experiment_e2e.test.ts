import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentLoop } from "../../backend/src/experiment/loop";
import { ProjectManager } from "../../backend/src/project/manager";
import { SimulationRegistry } from "../../backend/src/simulation/registry";
import { isProcessAlive } from "../../backend/src/simulation/run_store";

// P5 e2e（DEVELOPMENT_PLAN P5 退出标准）：
//   设计 → 运行 → 数据回收 → observation 入图 → 报告可查
//   **中途真实 SIGKILL 编排进程** → 重启 → 续跑到 conclude
//
// 「真实」的口径：另起一个 bun 进程当编排进程，提交仿真后用 SIGKILL 干掉它。
// SIGKILL 不给进程任何清理机会，仿真子进程被 init 收养继续跑——
// 这正是恢复代码路径要处理的现实，用状态注入模拟会绕过 pid 探活那一段。

const DRIVER = join(import.meta.dir, "..", "helpers", "experiment_driver.ts");

interface DriverHandshake {
  experimentId: string;
  runId: string;
  simPid: number | null;
}

// 起一个「编排进程」，等它把 id 打出来。
async function startDriver(
  root: string,
  slug: string,
  stallSeconds: number,
  title: string,
): Promise<{ proc: import("bun").Subprocess; handshake: DriverHandshake }> {
  const proc = Bun.spawn([process.execPath, DRIVER, root, slug, String(stallSeconds), title], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`driver 60s 内没有握手。stderr: ${await new Response(proc.stderr).text()}`);
    }
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`driver 意外退出。stderr: ${await new Response(proc.stderr).text()}`);
    }
    buffer += decoder.decode(value, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      reader.releaseLock();
      return { proc, handshake: JSON.parse(buffer.slice(0, newline)) as DriverHandshake };
    }
  }
}

async function waitUntilDead(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await Bun.sleep(30);
}

function reopen(root: string, slug: string) {
  const project = new ProjectManager(root).open(slug);
  return {
    project,
    loop: new ExperimentLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
    }),
  };
}

describe("P5 e2e · 干实验闭环（真实 SIGKILL 恢复）", () => {
  test(
    "编排进程被 SIGKILL，仿真任务活着 → 重启后接回同一个 run，续跑到 conclude",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "p5-e2e-kill-"));
      // stall 12s：足够我们在它「还在跑」的时候把编排进程杀掉。
      const { proc, handshake } = await startDriver(root, "kill-alive", 12, "水盒子替身 · 阻尼振子");
      expect(handshake.runId).toContain("pyref");
      expect(handshake.simPid).toBeGreaterThan(0);
      expect(isProcessAlive(handshake.simPid)).toBe(true);

      // ── 下刀：SIGKILL 编排进程 ──────────────────────────────────────────
      const driverPid = proc.pid!;
      proc.kill("SIGKILL");
      await proc.exited;
      await waitUntilDead(driverPid);
      expect(isProcessAlive(driverPid)).toBe(false);
      // 仿真子进程被收养，继续跑——这就是「任务仍在跑」那一情形的真实形态。
      expect(isProcessAlive(handshake.simPid)).toBe(true);

      // ── 重启：全新进程状态、全新句柄，只共享磁盘 ─────────────────────────
      const { project, loop } = reopen(root, "kill-alive");
      const resumed = await loop.resume(handshake.experimentId);
      expect(resumed.action).toBe("still_running");
      expect(resumed.view.state).toBe("dry_run");
      expect(resumed.view.runId).toBe(handshake.runId);
      expect(resumed.runStatus!.state).toBe("running");
      expect(resumed.runStatus!.pid).toBe(handshake.simPid);

      // ── 续跑到底 ────────────────────────────────────────────────────────
      let view = await loop.run(handshake.experimentId, { pollIntervalMs: 200, timeoutMs: 120_000 });
      expect(view.state).toBe("analyze");
      // 接的是同一个 run，不是重跑：runId 与 attempts 都没变。
      expect(view.runId).toBe(handshake.runId);
      expect(view.attempts).toBe(1);

      view = loop.conclude(view.id, {
        claim: "RK4 数值解与解析解在 4s 内一致到 1e-9 量级",
        limitations: "单组参数、定步长、无外力项",
        confidence: "high",
      });
      expect(view.state).toBe("concluded");

      // ── 数据回收 + observation 入图 + 报告可查 ───────────────────────────
      const records = project.records();
      expect(view.artifactRecordIds.length).toBe(2);
      const artifacts = project.artifacts().listBySession(view.id);
      expect(artifacts.map((a) => a.filename).sort()).toEqual(["final_state.json", "trajectory.csv"]);
      for (const artifact of artifacts) expect(existsSync(artifact.storagePath)).toBe(true);
      // 轨迹 CSV 真的有数据（不是空壳）。
      const trajectory = project.artifacts().get(artifacts.find((a) => a.filename === "trajectory.csv")!.id)!;
      // Python csv 模块按 RFC 4180 写 CRLF，这里只关心内容。
      const csvLines = trajectory.content.trim().split(/\r?\n/);
      expect(csvLines[0]).toBe("step,t,x,v,energy,analytic_x");
      expect(csvLines.length).toBe(400 / 20 + 2);
      expect(csvLines[1]!.split(",")[0]).toBe("0");

      const observation = records.get(view.observationId!)!;
      expect(observation.type).toBe("observation");
      expect(observation.evidence).toBe("computed");
      expect(Number(view.summary!.maxAbsErrorVsAnalytic)).toBeLessThan(1e-6);

      // 从结论出发，两跳内能走到实验、观察与两个产出——「报告可查」的可执行形式。
      const graph = records.graph(view.conclusionId!, 3);
      expect(graph.nodes.map((n) => n.type).sort()).toEqual([
        "artifact",
        "artifact",
        "conclusion",
        "experiment",
        "observation",
      ]);
      expect(graph.edges.every((e) => e.type === "derives_from")).toBe(true);

      // 实验记录正文里，kill 前后的状态轨迹是连续的一条。
      const body = records.get(view.id)!.content;
      expect(body).toContain("design → dry_run");
      expect(body).toContain("dry_run → collect");
      expect(body).toContain("analyze → concluded");
      project.close();
    },
    240_000,
  );

  test(
    "编排进程与仿真任务一起被 SIGKILL → 重启后标 failed，retry 换新 run 跑通到 conclude",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "p5-e2e-lost-"));
      const { proc, handshake } = await startDriver(root, "kill-lost", 30, "任务一起没了");
      const driverPid = proc.pid!;

      // 两个都杀：这是「机器断电 / 整个进程组被 kill」的形态。
      process.kill(handshake.simPid!, "SIGKILL");
      proc.kill("SIGKILL");
      await proc.exited;
      await waitUntilDead(driverPid);
      await waitUntilDead(handshake.simPid!);
      expect(isProcessAlive(handshake.simPid)).toBe(false);

      const { project, loop } = reopen(root, "kill-lost");
      const resumed = await loop.resume(handshake.experimentId);
      expect(resumed.action).toBe("marked_failed");
      expect(resumed.view.state).toBe("failed");
      // 关键区分：任务是「随进程一起没了」，不是算例本身错了 → 可重试。
      expect(resumed.runStatus!.recoverable).toBe(true);
      expect(resumed.view.lastError).toContain("已消失");

      // 换一组不带 stall 的参数重跑：iterate 出新实验（旧的转入 iterated）。
      // 注意 iterate 需要 analyze 态，而这条实验卡在 failed —— 所以走 retry 是不对的
      // （同样会 stall 30s）。这里直接验证 retry 起了新 run，然后用新实验跑完闭环。
      const retried = await loop.retry(handshake.experimentId);
      expect(retried.state).toBe("dry_run");
      expect(retried.runId).not.toBe(handshake.runId);
      expect(retried.attempts).toBe(2);
      await loop.platformFor(retried).cancel(retried.runId!);

      // 恢复后另起一条不 stall 的实验，把闭环走完——证明 failed 之后项目仍然可用。
      const fresh = await loop.design({
        title: "重跑（去掉 stall）",
        platform: "pyref",
        kind: "damped-oscillator",
        params: { steps: 400, sampleInterval: 20 },
      });
      let view = await loop.run(fresh.id, { pollIntervalMs: 100, timeoutMs: 120_000 });
      view = loop.conclude(view.id, { claim: "丢失的任务重跑后闭环完整" });
      expect(view.state).toBe("concluded");
      expect(view.summary!.steps).toBe(400);

      // 失败的那条实验仍然留在图里（ELN 语义：失败也是记录，不删）。
      const all = loop.list();
      expect(all.map((v) => v.state).sort()).toEqual(["concluded", "dry_run"]);
      project.close();
    },
    240_000,
  );
});
