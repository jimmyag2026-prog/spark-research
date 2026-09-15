import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// network 面板：`originAllowlist` · `httpTimeoutMs` · `llmTimeoutMs` · `contactEmail` · `userAgent`。
//
// **这条路由只是 general 的投影，不另存一份**——同一批键，同一个 config.json，
// 同一套校验。分出来只是因为 ε 的面板是按用途分的，用户不该为了改超时去 32 键里翻。

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

const FIXTURE: SettingsItem[] = [
  {
    key: "httpTimeoutMs",
    label: "httpTimeoutMs",
    kind: "number",
    value: 30_000,
    source: "default",
    configured: false,
    allowed: null,
    editable: true,
    summary: "单次 connector HTTP 请求的超时上限（毫秒）",
    nextStep: null,
  },
];

export function networkRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/network", (c) => panel(c, "network", FIXTURE, META));

  app.put("/network/:key", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "network", FIXTURE[0]!, META);
  });

  return app;
}
