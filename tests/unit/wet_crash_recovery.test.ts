import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { WetLabLoop } from "../../backend/src/lab/wet_loop";
import { ApprovalRequiredError, WetExecutionConflictError } from "../../backend/src/lab/wet_models";
import { ProjectManager } from "../../backend/src/project/manager";

// P10-d · D-10 e2e（真实 SIGKILL 恢复，参考 P5 的 experiment_driver.ts / experiment_e2e.test.ts
// 那套「另起一个真实 bun 进程扮演编排进程，握手后 SIGKILL」的写法）。
//
// 覆盖的两个问题：
//   1. `wet_run` 一个状态同时表示"已批准待执行"和"执行中"——拆成 `approved` / `executing`。
//   2. approval 跨进程崩溃存活 → 重启后可以免审批整体重跑——改成 approval 一次性消费：
//      声明执行权（approved → executing）那一刻就被消费掉，重启后无法凭空恢复。
//
// 「真实」的口径：另起一个 bun 进程做编排，approve 之后发起 execute()（不等它），
// 打印握手后立刻被 SIGKILL——execute() 内部原子声明执行权那一步是同步的，
// SIGKILL 之前必然已经落盘，这就是真实的「编排进程在执行期间消失」现场。

const DRIVER = join(import.meta.dir, "..", "helpers", "wet_driver.ts");

interface Handshake {
  experimentId: string;
  decisionId: string;
}

async function startDriver(root: string, slug: string): Promise<{ proc: import("bun").Subprocess; handshake: Handshake }> {
  const proc = Bun.spawn([process.execPath, DRIVER, root, slug], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`driver 30s 内没有握手。stderr: ${await new Response(proc.stderr).text()}`);
    }
    const { value, done } = await reader.read();
    if (done) {
      throw new Error(`driver 意外退出。stderr: ${await new Response(proc.stderr).text()}`);
    }
    buffer += decoder.decode(value, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      reader.releaseLock();
      return { proc, handshake: JSON.parse(buffer.slice(0, newline)) as Handshake };
    }
  }
}

function reopen(root: string, slug: string) {
  const project = new ProjectManager(root).open(slug);
  return {
    project,
    loop: new WetLabLoop({
      records: project.records(),
      artifacts: project.artifacts(),
      root: join(project.paths.experimentsDir, "wet"),
      backend: new MockDeviceBackend(),
    }),
  };
}

describe("D-10 e2e · 湿实验 approval 一次性消费（真实 SIGKILL 恢复）", () => {
  test(
    "批准 → 声明执行权落盘（approval 一次性消费）→ 编排进程被 SIGKILL → 重启后必须重新审批才能执行",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "wet-crash-"));
      const { proc, handshake } = await startDriver(root, "crash");

      // ── 下刀：SIGKILL 编排进程（这里没有独立的仿真子进程要处理——
      //    execute() 是同步 await 模型，没有 P5 那种"任务被 init 收养继续跑"的分叉）───
      const driverPid = proc.pid!;
      proc.kill("SIGKILL");
      await proc.exited;
      expect(proc.killed).toBe(true);
      void driverPid;

      // ── 重启：全新进程状态、全新句柄，只共享磁盘 ─────────────────────────────
      const { project, loop } = reopen(root, "crash");

      // 磁盘上已经是「正在执行、approval 已消费」——这就是 D-10 第 2 点的落点：
      // approval 不是等执行结束才清，是声明执行权那一刻就清。
      const stuck = loop.get(handshake.experimentId);
      expect(stuck.state).toBe("executing");
      expect(stuck.approval).toBeNull();
      expect(stuck.consumedApproval?.actor).toBe("driver");

      // 重启后第一次 execute()：executing 状态本身就是"判负"的信号
      // （不猜它是不是崩溃了——正在被并发请求执行 与 编排进程已经崩了 从状态本身分不出来，
      // 一律拒绝，绝不重复触碰设备）。
      await expect(loop.execute(handshake.experimentId)).rejects.toThrow(WetExecutionConflictError);
      // 免审批重跑不可能：state 仍是 executing，approval 仍是 null，再调也是同样的拒绝。
      const stillStuck = loop.get(handshake.experimentId);
      expect(stillStuck.state).toBe("executing");
      expect(stillStuck.approval).toBeNull();
      await expect(loop.execute(handshake.experimentId)).rejects.toThrow(WetExecutionConflictError);

      // 唯一的出路：显式 compile()（executing → compile 是 D-10 特意留的恢复边），
      // 然后完整重走 compile → safety_check → approve → execute。
      loop.compile(handshake.experimentId, {
        naturalLanguage: "取样品80µL加入96孔板，37°C孵育1小时，600nm读取OD",
      });
      // 中间态：还没重新 approve，execute 仍然被拒——这是"必须重新审批"的直接证明。
      await expect(loop.execute(handshake.experimentId)).rejects.toThrow(ApprovalRequiredError);

      loop.safetyCheck(handshake.experimentId);
      const reapproved = loop.approve(handshake.experimentId, { actor: "李四" });
      expect(reapproved.view.state).toBe("approved");
      expect(reapproved.decisionId).not.toBe(handshake.decisionId);

      const executed = await loop.execute(handshake.experimentId);
      expect(executed.state).toBe("collect");
      expect(executed.attempts).toBe(1);

      project.close();
    },
    60_000,
  );
});
