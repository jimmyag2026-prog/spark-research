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
});
