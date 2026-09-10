import { join } from "node:path";
import { Hono } from "hono";
import { UsageStore } from "../../usage/ledger";
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
export function usageRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  // G-3 的 LLM 用量台账（usage.jsonl）：按项目，走 ?project= 与其余域端点同一惯例。
  app.get("/", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const store = new UsageStore(join(scope.project.paths.root, "usage.jsonl"));
      const totals = store.totals();
      return c.json({ project: scope.project.slug, ...totals, corruptLines: store.corruptLines() });
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
    return c.json({ ...totals, corruptLines: store.corruptLines() });
  });

  return app;
}
