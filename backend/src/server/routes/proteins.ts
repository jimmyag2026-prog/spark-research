import { Hono } from "hono";
import { ProteinAnalysis, ProteinAnalysisError } from "../../proteins/analysis";
import { HttpError, type ServerContext } from "../context";
import { jsonBody, projectSlug, requireString } from "./shared";

// 蛋白结构调研端点（P5 `backend/src/proteins/analysis.ts` 的 HTTP 投影）。
//
// R-d-2（v0.4 P11 lane R-d）补的入口：protein-analysis 技能在 D-12 门禁的可达性核实里
// 被发现是 CLI / HTTP / MCP 三个入口全无的唯一技能——见 tests/unit/narrative_parity.test.ts
// 的「技能可达性」断言与 docs/BACKLOG.md V22。这里只做「解析 → 调用 → 序列化」，
// 业务全在 ProteinAnalysis 里（与 exp / lab 域端点同一套纪律）。
//
// 只有一个端点：这条链路本身就是「查询 → 报告」的单步操作，不像 exp/lab 有多阶段状态机。

export function proteinRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/analyze", async (c) => {
    const body = await jsonBody(c);
    const query = requireString(body, "query");
    // 默认落 observation record（与 CLI 同口径）；{"persist": false} 时只看报告不落库。
    const persist = body.persist !== false;

    return ctx.withProject(projectSlug(c), async (scope) => {
      const analysis = new ProteinAnalysis({ registry: ctx.connectors, records: scope.project.records() });
      try {
        const result = await analysis.analyze(query, { persist });
        return c.json({ project: scope.project.slug, result });
      } catch (error) {
        if (error instanceof ProteinAnalysisError) {
          // 查询本身不够收敛（UniProt 没有唯一匹配）是调用方的错，不是服务端故障。
          throw new HttpError(422, error.message);
        }
        throw error;
      }
    });
  });

  return app;
}
