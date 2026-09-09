import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SimulationSpecError,
  UnknownRunError,
  type SimulationPlatform,
  type SimulationSpec,
} from "../../backend/src/simulation/models";

// P5 契约测试套件（DEVELOPMENT_PLAN P5 退出标准：「两个 adapter 实现共用同一契约测试套件」）。
//
// **同一组测试参数化跑在每个实现上**。这是 AD-4 的验收方式：接口如果只有一个实现，
// 它就不是接口，只是那个实现的类型签名。openmm 与 pyref 在这里跑的是逐字节相同的断言。

export interface SimulationContractCase {
  name: string;
  // 每次调用都要产出一个**全新 root** 的平台实例（跨实例重连测试要用）。
  make: (root: string) => SimulationPlatform;
  // 秒级完成的正常算例。
  okSpec: SimulationSpec;
  // 与 okSpec 语义等价、但参数书写不同（顺序/显式写出默认值）→ specHash 必须相同。
  equivalentSpec: SimulationSpec;
  // 与 okSpec 不同的算例 → specHash 必须不同。
  differentSpec: SimulationSpec;
  // 跑得够久、够我们在它运行中做断言的算例。
  slowSpec: SimulationSpec;
  // 参数类型合法、但算例自身会失败（真实失败模式，不是人为的错误开关）。
  failingSpec: SimulationSpec;
  // prepare() 就该拒绝的参数。
  invalidSpec: SimulationSpec;
  expectedOutputs: string[];
  // collect().summary 里必须存在的键。
  summaryKeys: string[];
  runTimeoutMs: number;
  skip?: boolean;
  skipReason?: string;
}

function freshRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `sim-contract-${name}-`));
}

async function waitForTerminal(
  platform: SimulationPlatform,
  runId: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<SimulationPlatform["poll"]>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await platform.poll(runId);
    if (status.state === "completed" || status.state === "failed") return status;
    if (Date.now() > deadline) throw new Error(`等待 run ${runId} 终结超时（${timeoutMs}ms）`);
    await Bun.sleep(60);
  }
}

export function describeSimulationContract(config: SimulationContractCase): void {
  const suite = config.skip ? describe.skip : describe;

  suite(`SimulationPlatform 契约 · ${config.name}`, () => {
    test("平台自述：id / description / 任务种类都不为空", () => {
      const platform = config.make(freshRoot(config.name));
      expect(platform.id).toBe(config.okSpec.platform);
      expect(platform.description.length).toBeGreaterThan(0);
      expect((platform as unknown as { kinds: readonly string[] }).kinds.length).toBeGreaterThan(0);
    });

    test("available() 报告可用，并带上可诊断的 detail", async () => {
      const platform = config.make(freshRoot(config.name));
      const status = await platform.available();
      expect(status.ok).toBe(true);
      expect(status.reason).toBeNull();
      expect(Object.keys(status.detail).length).toBeGreaterThan(0);
    });

    // ── 契约 #1：prepare 是确定性的 ────────────────────────────────────────
    test("prepare 确定性：语义等价的 spec 得到同一个 specHash 与同一份归一化参数", async () => {
      const platform = config.make(freshRoot(config.name));
      const a = await platform.prepare(config.okSpec);
      const b = await platform.prepare(config.equivalentSpec);
      expect(b.specHash).toBe(a.specHash);
      expect(b.params).toEqual(a.params);
      // 归一化必须补齐默认值，而不是原样透传用户给的那几个键。
      expect(Object.keys(a.params).length).toBeGreaterThan(Object.keys(config.okSpec.params ?? {}).length);
      expect(a.expectedOutputs.sort()).toEqual([...config.expectedOutputs].sort());
      expect(existsSync(join(a.stageDir, "params.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(a.stageDir, "params.json"), "utf8"))).toEqual(a.params);
    });

    test("prepare 区分不同算例：参数不同则 specHash 不同", async () => {
      const platform = config.make(freshRoot(config.name));
      const a = await platform.prepare(config.okSpec);
      const c = await platform.prepare(config.differentSpec);
      expect(c.specHash).not.toBe(a.specHash);
    });

    test("prepare 拒绝未知任务种类", async () => {
      const platform = config.make(freshRoot(config.name));
      await expect(platform.prepare({ ...config.okSpec, kind: "no-such-kind" })).rejects.toThrow(
        SimulationSpecError,
      );
    });

    test("prepare 拒绝非法参数（不把 NaN 递给 runner）", async () => {
      const platform = config.make(freshRoot(config.name));
      await expect(platform.prepare(config.invalidSpec)).rejects.toThrow(SimulationSpecError);
    });

    test("prepare 拒绝平台不匹配的 spec", async () => {
      const platform = config.make(freshRoot(config.name));
      await expect(platform.prepare({ ...config.okSpec, platform: "someone-else" })).rejects.toThrow(
        SimulationSpecError,
      );
    });

    // ── 契约 #2/#3/#4：submit → poll → collect ─────────────────────────────
    test(
      "submit 非阻塞 → poll 到 completed → collect 给出产出与摘要",
      async () => {
        const platform = config.make(freshRoot(config.name));
        const prepared = await platform.prepare(config.okSpec);

        const submittedAt = Date.now();
        const runId = await platform.submit(prepared);
        // submit 只负责把任务丢出去；它自己不许等任务算完。
        expect(Date.now() - submittedAt).toBeLessThan(config.runTimeoutMs);
        expect(runId).toContain(platform.id);
        expect(platform.listRuns()).toContain(runId);

        const first = await platform.poll(runId);
        expect(["pending", "running", "completed"]).toContain(first.state);
        expect(first.runId).toBe(runId);
        expect(first.platform).toBe(platform.id);

        const final = await waitForTerminal(platform, runId, config.runTimeoutMs);
        expect(final.state).toBe("completed");
        expect(final.exitCode).toBe(0);
        expect(final.finishedAt).toBeTruthy();
        expect(final.recoverable).toBe(false);

        const outputs = await platform.collect(runId);
        expect(outputs.runId).toBe(runId);
        expect(outputs.files.map((f) => f.filename).sort()).toEqual([...config.expectedOutputs].sort());
        for (const file of outputs.files) {
          expect(existsSync(file.path)).toBe(true);
          expect(file.bytes).toBeGreaterThan(0);
          expect(file.role.length).toBeGreaterThan(0);
        }
        for (const key of config.summaryKeys) expect(outputs.summary).toHaveProperty(key);
        // 摘要只放标量：它会原样进 observation record。
        for (const value of Object.values(outputs.summary)) {
          expect(["string", "number", "boolean", "object"]).toContain(typeof value);
          if (typeof value === "object") expect(value).toBeNull();
        }
        expect(outputs.log.length).toBeGreaterThan(0);
        expect(outputs.wallSeconds).toBeGreaterThan(0);
      },
      config.runTimeoutMs + 30_000,
    );

    // ── 契约 #3 的关键性质：状态在磁盘上，换实例照样接得上 ──────────────────
    test(
      "跨实例重连：换一个平台实例（模拟进程重启）仍能 poll + collect 同一个 run",
      async () => {
        const root = freshRoot(config.name);
        const first = config.make(root);
        const runId = await first.submit(await first.prepare(config.okSpec));

        // 全新实例，不共享任何内存状态——只共享磁盘上的 root。
        const second = config.make(root);
        expect(second.listRuns()).toContain(runId);
        const final = await waitForTerminal(second, runId, config.runTimeoutMs);
        expect(final.state).toBe("completed");
        const outputs = await second.collect(runId);
        expect(outputs.files.length).toBe(config.expectedOutputs.length);
      },
      config.runTimeoutMs + 30_000,
    );

    test("poll / collect 未知 runId 抛 UnknownRunError", async () => {
      const platform = config.make(freshRoot(config.name));
      await expect(platform.poll("no-such-run")).rejects.toThrow(UnknownRunError);
      await expect(platform.collect("no-such-run")).rejects.toThrow(UnknownRunError);
      await expect(platform.cancel("no-such-run")).rejects.toThrow(UnknownRunError);
    });

    // ── 契约 #4：running / failed 一律不给半成品 ───────────────────────────
    test(
      "运行中 collect 抛错（不给半成品结果）",
      async () => {
        const platform = config.make(freshRoot(config.name));
        const runId = await platform.submit(await platform.prepare(config.slowSpec));
        const status = await platform.poll(runId);
        expect(["pending", "running"]).toContain(status.state);
        await expect(platform.collect(runId)).rejects.toThrow(/不能 collect/);
        await platform.cancel(runId);
      },
      config.runTimeoutMs + 30_000,
    );

    test(
      "cancel 把运行中的任务落到 failed（可重试），之后 collect 仍然拒绝",
      async () => {
        const platform = config.make(freshRoot(config.name));
        const runId = await platform.submit(await platform.prepare(config.slowSpec));
        const canceled = await platform.cancel(runId);
        expect(canceled.state).toBe("failed");
        expect(canceled.recoverable).toBe(true);
        expect(canceled.message).toContain("取消");
        // 终态是幂等的：再 poll 一次不会自己变回 running。
        expect((await platform.poll(runId)).state).toBe("failed");
        await expect(platform.collect(runId)).rejects.toThrow(/不能 collect/);
      },
      config.runTimeoutMs + 30_000,
    );

    test(
      "算例自身失败：poll 落 failed 且带出错误信息，collect 拒绝",
      async () => {
        const platform = config.make(freshRoot(config.name));
        const prepared = await platform.prepare(config.failingSpec);
        // 这类算例在 prepare 阶段就该给出警告——参数合法，但大概率跑不通。
        expect(prepared.warnings.length).toBeGreaterThan(0);
        const runId = await platform.submit(prepared);
        const final = await waitForTerminal(platform, runId, config.runTimeoutMs);
        expect(final.state).toBe("failed");
        expect(final.message).toBeTruthy();
        await expect(platform.collect(runId)).rejects.toThrow(/不能 collect/);
      },
      config.runTimeoutMs + 30_000,
    );
  });
}
