import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// compute 面板：执行地列表 × 可用性 × Modal 凭据配没配 × `computeTarget` 当前值。
//
// **plan / approve / run / release 不加 HTTP**（V47 / AD-6）：派发与审批是花钱动作，
// 刻意只留 CLI，这是设计不是缺陷。e2e 用例⑰「算力面板无派发按钮」钉着这一条。

const META: SettingsMeta = {
  level: "reduced",
  summary: "算力执行地：默认派到哪、各执行地可用不可用",
  notes: [
    "只改默认执行地。派发（plan / approve / run / release）刻意不走 HTTP——花钱动作由人在终端做（V47 / AD-6）",
    "改成 modal 本身不会让 Modal 可用：还要在「凭据」面板配 modal token",
  ],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "computeTarget",
    label: "默认执行地",
    kind: "enum",
    value: "local",
    source: "default",
    configured: false,
    allowed: ["local", "modal"],
    editable: true,
    summary: "`compute plan` 不给 --target 时的默认执行地",
    nextStep: null,
    extra: { availability: "available" },
  },
];

export function computeRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/compute", (c) => panel(c, "compute", FIXTURE, META));

  app.put("/compute/target", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "compute", FIXTURE[0]!, META);
  });

  return app;
}
