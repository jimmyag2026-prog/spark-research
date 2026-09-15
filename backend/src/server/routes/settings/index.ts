import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { computeRoutes } from "./compute";
import { credentialsRoutes } from "./credentials";
import { extensionsRoutes } from "./extensions";
import { generalRoutes } from "./general";
import { localRoutes } from "./local";
import { modelsRoutes } from "./models";
import { networkRoutes } from "./network";
import { permissionsRoutes } from "./permissions";
import { scientificToolsRoutes } from "./scientific-tools";
import type { SettingsRouteOptions } from "./shared";
import { storageRoutes } from "./storage";

export type { SettingsRouteOptions } from "./shared";
export * from "./types";

// 设置面的挂载点（U6）。`app.ts` 里只有一行：
//   app.route("/api/settings", settingsRoutes(ctx));
//
// 一面板一文件，每个模块自己声明完整的子路径（`/general`、`/models/default`……），
// 所以在这里统一挂在 `/`——看某个面板有哪些路由，只要打开那一个文件。
export function settingsRoutes(ctx: ServerContext, options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();
  app.route("/", generalRoutes(ctx, options));
  app.route("/", modelsRoutes(ctx, options));
  app.route("/", localRoutes(ctx, options));
  app.route("/", scientificToolsRoutes(ctx, options));
  app.route("/", credentialsRoutes(ctx, options));
  app.route("/", extensionsRoutes(ctx, options));
  app.route("/", computeRoutes(ctx, options));
  app.route("/", networkRoutes(ctx, options));
  app.route("/", storageRoutes(ctx, options));
  app.route("/", permissionsRoutes(ctx, options));
  return app;
}
