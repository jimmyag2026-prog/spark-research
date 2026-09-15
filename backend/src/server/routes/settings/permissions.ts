import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { panel, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// permissions 面板：`info` 的权限矩阵 + 各扩展的 credential / tool 授权 + 当前有效的审批令牌数。
//
// **只读**。撤销是授权动作，走终端（`spark-research ext revoke`）——与 extensions 面板同一条
// 口径（AD-6）。把「谁被授了什么」摆出来看得见，本身就是这个面板的全部价值。

const META: SettingsMeta = {
  level: "readonly",
  summary: "谁被授了什么：扩展的凭据与工具授权、刻意不暴露给 agent 的动作、有效审批令牌",
  notes: [
    "只读面板。授予 / 撤销请在终端执行 `spark-research ext grant` / `ext revoke`",
    "「刻意不暴露」那一段是设计不是缺陷：审批类动作必须由人来做（AD-6）",
  ],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "withheld:lab_approve",
    label: "lab_approve",
    kind: "info",
    value: null,
    editable: false,
    summary: "刻意不暴露给外部 agent 的动作",
    nextStep: "在终端执行 `spark-research lab approve <id>`",
    extra: { category: "withheld" },
  },
];

export function permissionsRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/permissions", (c) => panel(c, "permissions", FIXTURE, META));

  return app;
}
