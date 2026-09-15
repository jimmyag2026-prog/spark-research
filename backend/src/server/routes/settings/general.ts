import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// general 面板：`config list` 的 32 键在网页端的投影（U6 修改方向 A）。
//
// 凭据类 key（`CONFIG_SETTINGS` 里 `secret: true` 的那些）在这里**只返 configured**，
// PUT/DELETE 一律 403 并指向 `/api/settings/credentials`——凭据只有一条写入路径（AD-18）。

const META: SettingsMeta = {
  level: "full",
  summary: "所有非密配置项：值、来源（env / config.json / 默认）、改了影响什么",
  notes: [
    "env 设过的项会盖住 config.json——这里如实标 source，改 config.json 不会立刻生效",
    "凭据类项在本面板只读，写入走「凭据」面板",
  ],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "defaultModel",
    label: "defaultModel",
    kind: "string",
    value: "moonshotai/kimi-k2.6",
    source: "default",
    configured: false,
    allowed: null,
    editable: true,
    summary: "所有 LLM 调用的默认模型（provider 由模型名推断）",
    nextStep: null,
  },
];

export function generalRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/general", (c) => panel(c, "general", FIXTURE, META));

  app.put("/general/:key", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "general", FIXTURE[0]!, META);
  });

  app.delete("/general/:key", (c) => written(c, "general", FIXTURE[0]!, META));

  return app;
}
