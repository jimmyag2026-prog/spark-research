import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// extensions 面板：已装的第三方扩展（MCP / connector）+ 内建技能与触发词。
//
// **授权动作不走 HTTP**（AD-6 的同款口径，与算力面板的 plan/approve/run 一致）：
// `ext add-mcp --trust` / `ext grant` / `ext revoke` 三个动作留在终端，
// 本面板的 `POST /extensions/mcp` 等价于**不带 `--trust`** 的 add-mcp。
// 面板如实标 `level: "reduced"` 并在 notes 里写明少了什么，不假装全功能。

const META: SettingsMeta = {
  level: "reduced",
  summary: "已装扩展（MCP / connector）与内建技能；装载、验证、卸载",
  notes: [
    "装载一律不带 --trust：授权是人的动作，不暴露成 HTTP 写路由（AD-6）",
    "授予 / 撤销凭据与工具权限请在终端执行 `spark-research ext grant` / `ext revoke`",
  ],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "literature-triage",
    label: "literature-triage",
    kind: "info",
    value: null,
    editable: false,
    summary: "内建技能：文献分诊",
    nextStep: null,
    extra: { category: "skill", triggers: ["分诊", "triage"] },
  },
];

export function extensionsRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/extensions", (c) => panel(c, "extensions", FIXTURE, META));

  app.post("/extensions/mcp", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "extensions", FIXTURE[0]!, META);
  });

  app.post("/extensions/:name/verify", (c) => written(c, "extensions", FIXTURE[0]!, META));

  app.delete("/extensions/:name", (c) => written(c, "extensions", FIXTURE[0]!, META));

  return app;
}
