import { describe, test, expect } from "bun:test";
import { AgentSwarm } from "../../backend/src/agents/swarm";
import type { SubTask } from "../../backend/src/agents/swarm_types";

describe("AgentSwarm.decompose", () => {
  test("分解'分析多个蛋白质序列'为多个子任务", () => {
    const swarm = new AgentSwarm();
    const subTasks = swarm.decompose("分析多个蛋白质序列");

    expect(subTasks.length).toBeGreaterThan(1);
    expect(subTasks.every((s) => s.description.includes("蛋白质"))).toBe(true);
    const ids = new Set(subTasks.map((s) => s.id));
    expect(ids.size).toBe(subTasks.length);
  });

  test("普通任务不分解，只生成单个子任务", () => {
    const swarm = new AgentSwarm();
    const subTasks = swarm.decompose("运行分子动力学模拟");

    expect(subTasks).toHaveLength(1);
    expect(subTasks[0].params).toHaveProperty("task");
  });
});

describe("AgentSwarm.runParallel", () => {
  test("遵守并发上限，并发峰值不超过 limit", async () => {
    const swarm = new AgentSwarm();
    const subTasks: SubTask[] = Array.from({ length: 12 }, (_, i) => ({
      id: `t-${i + 1}`,
      description: `task ${i + 1}`,
      params: {},
    }));
    let active = 0;
    let peak = 0;
    const workerFn = async (sub: SubTask) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(10);
      active--;
      return `done:${sub.id}`;
    };

    const results = await swarm.runParallel(subTasks, workerFn, 4);

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(results).toHaveLength(12);
    expect(results.every((r) => r.success)).toBe(true);
  });

  test("失败子任务被正确记录", async () => {
    const swarm = new AgentSwarm();
    const subTasks: SubTask[] = Array.from({ length: 4 }, (_, i) => ({
      id: `t-${i + 1}`,
      description: `task ${i + 1}`,
      params: {},
    }));
    const workerFn = async (sub: SubTask) => {
      if (sub.id === "t-3") throw new Error("模拟失败");
      return `ok:${sub.id}`;
    };

    const results = await swarm.runParallel(subTasks, workerFn, 2);

    const failed = results.filter((r) => !r.success);
    expect(failed).toHaveLength(1);
    expect(failed[0].subTaskId).toBe("t-3");
    expect(failed[0].error).toContain("模拟失败");
    expect(results.filter((r) => r.success)).toHaveLength(3);
  });
});

describe("AgentSwarm.aggregate", () => {
  test("返回正确聚合结果", () => {
    const swarm = new AgentSwarm();
    const results = [
      { subTaskId: "a", success: true, output: "A", durationMs: 1 },
      { subTaskId: "b", success: true, output: "B", durationMs: 1 },
      { subTaskId: "c", success: false, output: null, error: "boom", durationMs: 1 },
    ];

    const agg = swarm.aggregate(results);

    expect(agg.status).toBe("partial");
    expect(agg.succeeded).toBe(2);
    expect(agg.failed).toHaveLength(1);
    expect(agg.outputs).toEqual(["A", "B"]);
  });
});

describe("AgentSwarm.run", () => {
  test("完整流程 decompose → runParallel → aggregate", async () => {
    const swarm = new AgentSwarm();
    const output = await swarm.run(
      "分析多个蛋白质序列",
      async (sub) => ({ analyzed: sub.id }),
      { concurrencyLimit: 4 },
    );

    expect(output.subTasks.length).toBeGreaterThan(1);
    expect(output.summary.total).toBe(output.subTasks.length);
    expect(output.summary.succeeded).toBe(output.subTasks.length);
    expect(output.summary.failed).toBe(0);
    expect(output.summary.durationMs).toBeGreaterThan(0);
    expect(output.aggregate.status).toBe("success");
  });
});

describe("AgentSwarm 并发上限校验", () => {
  test("concurrencyLimit=100 允许，超过 100 报错", async () => {
    const swarm = new AgentSwarm();
    const subTasks: SubTask[] = [{ id: "t-1", description: "x", params: {} }];

    const results = await swarm.runParallel(subTasks, async () => "ok", 100);
    expect(results).toHaveLength(1);

    expect(swarm.runParallel(subTasks, async () => "ok", 101)).rejects.toThrow(/100/);
  });
});
