import { join } from "node:path";
import { Hono } from "hono";
import { UsageStore, type UsageTotals } from "../../usage/ledger";
import { ApiCallStore, apiCallStorePath } from "../../usage/api_ledger";
import type { ServerContext } from "../context";
import { projectSlug } from "./shared";

// W6-1（v0.6）：给 lane β 工作台「用量」面板消费的只读契约。
//
// 两个端点分别对应两份台账，字段名与各自的 CLI `--json` 出口逐字段一致——
// `spark-research usage --json` 与 GET /api/usage 同形状，`usage api --json`
// 与 GET /api/usage/api 同形状。UI 与 CLI 读同一份数字、同一套聚合逻辑
// （UsageStore.totals() / ApiCallStore.totals()），不在这层重新计算一遍
// （DEVELOPMENT_PLAN_v0.6.md §W6-1 lane β 纪律：「两处算同一数字」是 V37 的形状）。

type CostBucket = { calls: number; knownCostUsd: number; unknownCostCalls: number };

function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    knownCostUsd: 0,
    unknownCostCalls: 0,
    unpricedCalls: 0,
    byCommand: {},
    byModel: {},
  };
}

function mergeBuckets(into: Record<string, CostBucket>, from: Record<string, CostBucket>): void {
  for (const [key, bucket] of Object.entries(from)) {
    const target = (into[key] ??= { calls: 0, knownCostUsd: 0, unknownCostCalls: 0 });
    target.calls += bucket.calls;
    target.knownCostUsd += bucket.knownCostUsd;
    target.unknownCostCalls += bucket.unknownCostCalls;
  }
}

/**
 * V130：`/api/usage` 不带 `?project=` 时**汇总全部项目**，而不是悄悄返回当前项目。
 *
 * A7 抓到的形状：用户在网页端看「用量」，看到的是当前项目指针恰好指着的那个项目的
 * 数字，界面上却没有任何东西说这是某一个项目的账——于是「这个月花了多少」这个问题
 * 被一个看起来像全局数字的东西回答错了。现在两种口径都在，且响应里带 `scope`
 * 明说是哪一种。
 *
 * 聚合仍然只用 `UsageStore.totals()` 这一套算法（V37 纪律：两处算同一数字），
 * 这里做的只是把每个项目的结果加起来。
 */
function aggregateAll(ctx: ServerContext): { totals: UsageTotals; projects: string[]; corruptLines: number } {
  const totals = emptyTotals();
  const projects: string[] = [];
  let corruptLines = 0;
  // 归档项目也要算进去：钱已经花掉了，归档不会把它退回来。
  for (const meta of ctx.projects.list({ includeArchived: true })) {
    const root = ctx.projects.pathsFor(meta.slug).root;
    const store = new UsageStore(join(root, "usage.jsonl"));
    const t = store.totals();
    if (t.calls === 0 && store.corruptLines() === 0) continue;
    projects.push(meta.slug);
    totals.calls += t.calls;
    totals.inputTokens += t.inputTokens;
    totals.outputTokens += t.outputTokens;
    totals.knownCostUsd += t.knownCostUsd;
    totals.unknownCostCalls += t.unknownCostCalls;
    totals.unpricedCalls += t.unpricedCalls;
    mergeBuckets(totals.byCommand, t.byCommand);
    mergeBuckets(totals.byModel, t.byModel);
    corruptLines += store.corruptLines();
  }
  return { totals, projects, corruptLines };
}

export function usageRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  // G-3 的 LLM 用量台账（usage.jsonl）。
  // `?project=<slug>` → 该项目；不给 → 全局汇总（V130）。`scope` 字段说清是哪一种。
  app.get("/", async (c) => {
    const slug = projectSlug(c);
    if (slug === undefined) {
      const { totals, projects, corruptLines } = aggregateAll(ctx);
      return c.json({ scope: "global", project: null, projects, ...totals, corruptLines });
    }
    return ctx.withProject(slug, (scope) => {
      const store = new UsageStore(join(scope.project.paths.root, "usage.jsonl"));
      const totals = store.totals();
      return c.json({
        scope: "project",
        project: scope.project.slug,
        projects: [scope.project.slug],
        ...totals,
        corruptLines: store.corruptLines(),
      });
    });
  });

  // lane α 的 connector 调用台账（api_calls.jsonl）：全局，不分项目——connector 层
  // 没有项目概念（connectors/base.ts 的既有边界，usage/api_ledger.ts 顶部注释同理）。
  // 这里如实反映，不接受、也不消费 ?project=。
  //
  // `ctx.deps.root` 只在测试注入 mkdtemp 时存在，与 usage/ledger.ts 的项目路径无关；
  // 复用它替代 dataDir() 是与 server/context.ts TaskRegistry 相同的既有惯例
  // （测试用的临时工作区根目录，同时充当「这次测试的 dataDir()」）。
  app.get("/api", (c) => {
    const store = new ApiCallStore(apiCallStorePath(ctx.deps.root ? { root: ctx.deps.root } : {}));
    const totals = store.totals();
    return c.json({ scope: "global", ...totals, corruptLines: store.corruptLines() });
  });

  return app;
}
