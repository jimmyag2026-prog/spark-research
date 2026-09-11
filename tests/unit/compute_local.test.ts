import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalComputeAdapter } from "../../backend/src/compute/adapters/local";
import { ComputeApproval } from "../../backend/src/compute/approval";
import { RecoverFailure } from "../../backend/src/compute/target";
import { describeComputeContract, makeContractFixture } from "../helpers/compute_contract";

// CB-2 · local adapter。**它承担全部契约测试**（CI 零凭据，设计 §1.1.6）。

// 用 /bin/sh -c 会被 validatePlan 拒（argv 纪律），所以这里用真实的可执行文件 + argv。
// tee 把 stdout 同时写进产物文件，既产出 out.txt 又留下日志。
const OK = (out: string): string[] => ["/usr/bin/tee", out];
const FAIL = (): string[] => ["/usr/bin/false"];
const SLOW = (seconds: number): string[] => ["/bin/sleep", String(seconds)];

describeComputeContract({
  name: "local（本机子进程）",
  makeAdapter: () => new LocalComputeAdapter({ pollIntervalMs: 20 }),
  okCommand: OK,
  failCommand: FAIL,
  slowCommand: SLOW,
  // printenv 把密钥写进 stdout → 我们能验证「密钥真的到了子进程」，
  // 同时验证「密钥没有落进 plan.json / job.json / uploads.json」。
  secretEchoCommand: (envName) => ["/usr/bin/printenv", envName],
  timeoutMs: 30_000,
});

describe("CB-2 · local adapter 的自有行为", () => {
  test("recover() 先看 exit-code 文件再看 pid：pid 早已复用/消失也以标记为准", async () => {
    const fx = makeContractFixture(new LocalComputeAdapter({ pollIntervalMs: 20 }));
    const planned = await fx.broker.plan(fx.planInput({ command: OK("out.txt") }), { projectSlug: "contract" });
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);
    expect(existsSync(join(ran.jobDir, "exit-code"))).toBe(true);

    // 把 pid 改成一个几乎肯定不存在的值：exit-code 在，就该以它为准。
    const patched = fx.jobs.patch(ran.jobId, {
      lifecycle: { ...ran.lifecycle, execution: "running" },
      adapterHandle: { kind: "local", data: { ...ran.adapterHandle!.data, pid: 999_999 } },
    });
    const recovered = await fx.broker.recover(patched.jobId);
    expect(recovered.lifecycle.execution).toBe("succeeded");
    expect(recovered.exitCode).toBe(0);
  }, 30_000);

  test("exit-code 丢了 + 进程也没了 → 抛 RecoverFailure(not_found)，broker 标 failed（**不许**猜成功）", async () => {
    const adapter = new LocalComputeAdapter({ pollIntervalMs: 20 });
    const fx = makeContractFixture(adapter);
    const planned = await fx.broker.plan(fx.planInput({ command: OK("out.txt") }), { projectSlug: "contract" });
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);

    rmSync(join(ran.jobDir, "exit-code"), { force: true });
    const spec = { jobId: ran.jobId, plan: ran.plan, jobDir: ran.jobDir };
    const handle = { kind: "local" as const, data: { ...ran.adapterHandle!.data, pid: 999_999 } };
    await expect(adapter.recover(spec, handle, {})).rejects.toThrow(RecoverFailure);

    const patched = fx.jobs.patch(ran.jobId, {
      lifecycle: { ...ran.lifecycle, execution: "running" },
      adapterHandle: handle,
    });
    const recovered = await fx.broker.recover(patched.jobId);
    expect(recovered.lifecycle.execution).toBe("failed");
    expect(recovered.message).toContain("not_found");
  }, 30_000);

  test("shim 是常量：被审批的 argv 不经过第二次 shell 展开", async () => {
    const fx = makeContractFixture(new LocalComputeAdapter({ pollIntervalMs: 20 }));
    // 这个参数里有 shell 元字符。如果 adapter 把 argv 拼成 shell 字符串跑，
    // `$(id -u)` 会被展开成数字；正确的实现会原样把这串字符交给 tee。
    const planned = await fx.broker.plan(
      fx.planInput({ command: ["/bin/echo", "$(id -u) && rm -rf /"], outputs: [] }),
      { projectSlug: "contract" },
    );
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);
    expect(ran.lifecycle.execution).toBe("succeeded");
    const log = readFileSync(join(ran.jobDir, "run.log"), "utf8");
    expect(log).toContain("$(id -u) && rm -rf /");
    const shim = readFileSync(join(ran.jobDir, "runner.sh"), "utf8");
    expect(shim).not.toContain("id -u");
  }, 30_000);

  test("墙钟超时：deadline 过了就杀掉并如实报 timedOut（不假装它还在跑）", async () => {
    const adapter = new LocalComputeAdapter({ pollIntervalMs: 20 });
    const fx = makeContractFixture(adapter);
    const planned = await fx.broker.plan(fx.planInput({ command: SLOW(30), outputs: [] }), {
      projectSlug: "contract",
    });
    // 直接对 adapter 做单元级验证：起一个真实的长任务，把 handle 的 startedAt 拨到
    // 很久以前——awaitTerminal 的 deadline 从 handle.startedAt 起算，于是这一轮就该判超时。
    // （不引入任何「测试专用的超时倍率」开关：那种开关就是后门。）
    const jobDir = fx.jobs.dirOf(planned.jobId);
    const child = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const handle = {
      kind: "local" as const,
      data: { pid: child.pid ?? null, startedAt: new Date(Date.now() - 3_600_000).toISOString() },
    };
    const result = await adapter.recover({ jobId: planned.jobId, plan: planned.plan, jobDir }, handle, {});
    expect(result.timedOut).toBe(true);
    await Bun.sleep(50);
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 30_000);

  test("check() 如实报告本机能力", async () => {
    const result = await new LocalComputeAdapter().check();
    expect(result.ok).toBe(true);
    expect(result.detail.shell).toBe("/bin/sh");
  });

  test("release 删工作区但**留下** harvest 与 run.log（释放的是资源，不是证据）", async () => {
    const fx = makeContractFixture(new LocalComputeAdapter({ pollIntervalMs: 20 }));
    const planned = await fx.broker.plan(fx.planInput({ command: OK("out.txt"), outputs: ["out.txt"] }), {
      projectSlug: "contract",
    });
    fx.approval.approve(planned.jobId, { actor: "测试员" });
    const ran = await fx.broker.dispatch(planned.jobId);
    await fx.broker.collect(ran.jobId);
    const released = await fx.broker.release(ran.jobId);
    expect(existsSync(join(released.jobDir, "workspace"))).toBe(false);
    expect(existsSync(join(released.jobDir, "harvest", "out.txt"))).toBe(true);
    expect(existsSync(join(released.jobDir, "run.log"))).toBe(true);
  }, 30_000);

  // V48（BACKLOG）：adapterHandle 原来只在 adapter.run() **返回时**才写 job.json——
  // 编排进程在执行期中途被 SIGKILL，句柄跟着一起丢，既不能 recover() 接回，release 还
  // 会因为 recoverable 判不出来而删掉唯一的产物。这里只做**同进程**能验的那一半：
  // handle 必须在 spawn 成功、pid 到手的那一刻就出现在 job.json 里，不必等到任务终态。
  // 真正的「编排进程死了、任务活下来、新进程接回并收割」那条完整路径要求「旧编排进程」
  // 是一个真的、已经不存在的独立 OS 进程——同一个 JS 进程里"造一个 broker 实例然后不
  // await它" 并不能让它停止运行（它仍是同一个事件循环里的一个挂起 promise，后台还在跑），
  // 会跟"新" broker 对同一个 job.json 产生真实的并发写竞争，不是可靠的模拟；这条更完整
  // 的验收挪到了 compute_e2e.test.ts 的「真实 SIGKILL · 只杀编排进程」用例，那边跟现有
  // 「三刀齐下」SIGKILL 用例一样真的 spawn 一个独立进程再真 kill -9（见该文件）。
  test("V48：handle 在 spawn 成功那一刻就落盘，不等 run() 返回（同进程可验的那一半）", async () => {
    const adapter = new LocalComputeAdapter({ pollIntervalMs: 20 });
    const fx = makeContractFixture(adapter);
    const planned = await fx.broker.plan(fx.planInput({ command: SLOW(2), outputs: [] }), {
      projectSlug: "contract",
    });
    fx.approval.approve(planned.jobId, { actor: "测试员" });

    const dispatched = fx.broker.dispatch(planned.jobId);
    // 轮询 job.json：handle 必须在 2 秒 sleep 结束之前就出现——旧代码（handle 只在
    // run() 返回时才写）要等到 dispatch() 整个 resolve，也就是 2 秒之后才写得进去，
    // 这条断言等不到就会超时（阴性对照见 docs/devlog/W7-E.md「E-2」）。
    const deadline = Date.now() + 1500;
    let sawHandleWhileRunning = false;
    while (Date.now() < deadline) {
      const current = fx.jobs.get(planned.jobId);
      if (current.adapterHandle !== null) {
        sawHandleWhileRunning = current.lifecycle.execution === "running";
        break;
      }
      await Bun.sleep(10);
    }
    expect(sawHandleWhileRunning, "spawn 成功后 handle 应该在任务仍处于 running 时就已经落盘").toBe(true);

    // 收尾：让这次真实 dispatch() 正常跑完（sleep 2s 后以 exit=0 终结），不留后台任务。
    const settled = await dispatched;
    expect(settled.lifecycle.execution).toBe("succeeded");
  }, 15_000);
});
