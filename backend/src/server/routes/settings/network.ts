import { Hono } from "hono";
import { resolveSetting } from "../../../config";
import type { ServerContext } from "../../context";
import { configOptions, handleSettingWrite, toItem } from "./general";
import { panel, type SettingsRouteOptions } from "./shared";
import type { SettingsMeta } from "./types";

// network 面板：`originAllowlist` · `httpTimeoutMs` · `llmTimeoutMs` · `contactEmail` · `userAgent`。
//
// **这条路由只是 general 的投影，不另存一份**——同一批键、同一个 config.json、
// 同一套校验（写入直接复用 general 的 `handleSettingWrite`）。分出来只是因为 ε 的面板
// 是按用途分的：用户要调一个超时，不该先在 32 个键里翻。
//
// 两份键清单会漂移吗？不会：下面这张表里的每个名字都会被 `resolveSetting` 拿去解析，
// 拼错一个立刻抛「未知配置项」，`settings_panels.test.ts` 的 GET 断言当场红。

export const NETWORK_KEYS = [
  "originAllowlist",
  "httpTimeoutMs",
  "llmTimeoutMs",
  "contactEmail",
  "userAgent",
] as const;

const META: SettingsMeta = {
  level: "full",
  summary: "对外请求的礼貌头、超时上限与可信 Origin 白名单",
  notes: [
    "这些键与「通用」面板是同一批值，改哪边都一样——本面板只是按用途挑出来的投影",
    "originAllowlist 放开不会放开凭据写入：那条路径恒只认 loopback（AD-18 ②）",
  ],
};

export function networkRoutes(ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/network", (c) =>
    panel(
      c,
      "network",
      NETWORK_KEYS.map((key) => toItem(resolveSetting(key, configOptions(ctx)))),
      META,
    ),
  );

  app.put("/network/:key", (c) =>
    handleSettingWrite(c, ctx, "network", c.req.param("key"), META, NETWORK_KEYS),
  );

  return app;
}
