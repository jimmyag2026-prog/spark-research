import { Hono } from "hono";
import { depictSmiles } from "../../chem/depict";
import { HttpError, type ServerContext } from "../context";
import { jsonBody, projectSlug, requireString } from "./shared";

// SMILES → 2D 结构图端点（C5-②，DEVELOPMENT_PLAN_v0.5_MODULES.md §1.3/§2.9 的 HTTP 投影）。
// 风格与 proteins.ts 一致：解析 → 调用 → 序列化，业务全在 depictSmiles 里。
// 只有一个端点：一次 depict 是单步操作，不像 exp/lab 有多阶段状态机。

export function chemRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/depict", async (c) => {
    const body = await jsonBody(c);
    const smiles = requireString(body, "smiles");
    const name = typeof body.name === "string" ? body.name : undefined;
    const width = typeof body.width === "number" ? body.width : undefined;
    const height = typeof body.height === "number" ? body.height : undefined;

    return ctx.withProject(projectSlug(c), async (scope) => {
      const result = await depictSmiles(
        { smiles, name, width, height },
        {
          artifacts: scope.project.artifacts(),
          records: scope.project.records(),
          projectSlug: scope.project.slug,
        },
      );
      if (!result.ok) {
        // 非法 SMILES / rdkit 缺失 / 超时都是调用方或环境的问题，不是服务端故障——
        // 422 而不是 500（与 proteins.ts 的「查询不够收敛 → 422」同一口径）。
        throw new HttpError(422, result.error.message, { kind: result.error.kind });
      }
      return c.json({ project: scope.project.slug, result });
    });
  });

  return app;
}
