import type {
  SubTask,
  SwarmResult,
  SwarmRunOptions,
  SwarmRunOutput,
  SwarmSummary,
} from "./swarm_types";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 100;
const DEFAULT_MULTI_COUNT = 3;

const COUNT_RE = /(\d+)\s*(个|种|份|条|组|类)/;
const MULTI_RE = /(多个|多种|若干|所有|一批)/;
const TARGET_RE = /多个([\u4e00-\u9fff\w]+)/;
const LIST_SPLIT_RE = /[、，,;；]+/;

interface PoolState {
  nextIndex: number;
  active: number;
  peak: number;
}

export class AgentSwarm {
  decompose(task: string): SubTask[] {
    const trimmed = task.trim();
    const listed = this.decomposeByList(trimmed);
    if (listed) return listed;
    const counted = this.decomposeByCount(trimmed);
    if (counted) return counted;
    const multi = this.decomposeByMulti(trimmed);
    if (multi) return multi;
    return [{ id: "subtask-1", description: trimmed, params: { task: trimmed } }];
  }

  async runParallel(
    subTasks: SubTask[],
    workerFn: (sub: SubTask) => unknown,
    concurrencyLimit: number = DEFAULT_CONCURRENCY,
  ): Promise<SwarmResult[]> {
    const { results } = await this.executeParallel(subTasks, workerFn, concurrencyLimit);
    return results;
  }

  aggregate(results: SwarmResult[]): Record<string, unknown> {
    const failed = results.filter((r) => !r.success);
    const status =
      failed.length === 0 ? "success" : failed.length === results.length ? "failed" : "partial";
    return {
      status,
      total: results.length,
      succeeded: results.length - failed.length,
      failed: failed.map((r) => ({ subTaskId: r.subTaskId, error: r.error })),
      outputs: results.filter((r) => r.success).map((r) => r.output),
    };
  }

  async run(
    task: string,
    workerFn: (sub: SubTask) => unknown,
    options: SwarmRunOptions = {},
  ): Promise<SwarmRunOutput> {
    const concurrencyLimit = options.concurrencyLimit ?? DEFAULT_CONCURRENCY;
    const started = performance.now();
    const subTasks = this.decompose(task);
    const { results, peakConcurrency } = await this.executeParallel(
      subTasks,
      workerFn,
      concurrencyLimit,
    );
    const summary: SwarmSummary = {
      total: subTasks.length,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      durationMs: performance.now() - started,
      maxConcurrency: concurrencyLimit,
      peakConcurrency,
      results,
    };
    return { subTasks, summary, aggregate: this.aggregate(results) };
  }

  private async executeParallel(
    subTasks: SubTask[],
    workerFn: (sub: SubTask) => unknown,
    concurrencyLimit: number,
  ): Promise<{ results: SwarmResult[]; peakConcurrency: number }> {
    const limit = this.validateLimit(concurrencyLimit);
    const results = new Array<SwarmResult>(subTasks.length);
    const state: PoolState = { nextIndex: 0, active: 0, peak: 0 };
    const runners = Array.from({ length: Math.min(limit, subTasks.length) }, () =>
      this.consume(state, subTasks, workerFn, results),
    );
    await Promise.all(runners);
    return { results, peakConcurrency: state.peak };
  }

  private async consume(
    state: PoolState,
    subTasks: SubTask[],
    workerFn: (sub: SubTask) => unknown,
    results: SwarmResult[],
  ): Promise<void> {
    while (true) {
      const i = state.nextIndex++;
      if (i >= subTasks.length) return;
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      const started = performance.now();
      try {
        const output = await workerFn(subTasks[i]);
        results[i] = {
          subTaskId: subTasks[i].id,
          success: true,
          output,
          durationMs: performance.now() - started,
        };
      } catch (err) {
        results[i] = {
          subTaskId: subTasks[i].id,
          success: false,
          output: null,
          error: err instanceof Error ? err.message : String(err),
          durationMs: performance.now() - started,
        };
      } finally {
        state.active--;
      }
    }
  }

  private validateLimit(limit: number): number {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`concurrencyLimit 必须 >= 1，实际为 ${limit}`);
    }
    if (limit > MAX_CONCURRENCY) {
      throw new Error(`concurrencyLimit 不能超过 ${MAX_CONCURRENCY}，实际为 ${limit}`);
    }
    return Math.round(limit);
  }

  private decomposeByList(task: string): SubTask[] | null {
    const parts = task
      .split(LIST_SPLIT_RE)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 2) return null;
    return parts.map((part, i) => ({
      id: `subtask-${i + 1}`,
      description: part,
      params: { task, part, index: i },
    }));
  }

  private decomposeByCount(task: string): SubTask[] | null {
    const match = task.match(COUNT_RE);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    if (n < 2) return null;
    return this.buildTargeted(task, n);
  }

  private decomposeByMulti(task: string): SubTask[] | null {
    if (!MULTI_RE.test(task)) return null;
    return this.buildTargeted(task, DEFAULT_MULTI_COUNT);
  }

  private buildTargeted(task: string, count: number): SubTask[] {
    const targetMatch = task.match(TARGET_RE);
    const target = targetMatch ? targetMatch[1] : "目标";
    return Array.from({ length: count }, (_, i) => ({
      id: `subtask-${i + 1}`,
      description: `${target} #${i + 1}`,
      params: { task, target, index: i, total: count },
    }));
  }
}
