import { Hono } from "hono";
import { computeTargetViews, defaultComputeAdapters } from "../../../compute/cli";
import { configuredComputeTarget, resolveSetting } from "../../../config";
import type { ServerContext } from "../../context";
import { configOptions, handleSettingWrite, toItem } from "./general";
import { panel, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// compute 面板：执行地列表 × 可用性 × Modal 凭据配没配 × `computeTarget` 当前值。
//
// **plan / approve / run / release 不加 HTTP**（V47 / AD-6）：派发与审批是花钱动作，
// 刻意只留 CLI，**这是设计不是缺陷**。e2e 用例⑰「算力面板无派发按钮」钉着这一条，
// 所以这里连一个看起来像派发的路由都不要有。

const META: SettingsMeta = {
  level: "reduced",
  summary: "算力执行地：默认派到哪、各执行地可用不可用、为什么",
  notes: [
    "只改默认执行地。派发（plan / approve / run / release）刻意不走 HTTP——花钱动作由人在终端做（V47 / AD-6）",
    "改成 modal 本身不会让 Modal 可用：还要在「凭据」面板配 Modal token",
  ],
};

function buildItems(ctx: ServerContext): SettingsItem[] {
  const opts = configOptions(ctx);
  const current = configuredComputeTarget("local", opts);
  const views = computeTargetViews({
    adapters: defaultComputeAdapters(),
    credentials: ctx.credentials(),
    defaultTarget: current,
  });

  // 第一条是可写的那一项（默认执行地），其余每个执行地一条只读信息。
  const items: SettingsItem[] = [toItem(resolveSetting("computeTarget", opts))];
  for (const view of views) {
    items.push({
      key: `target:${view.kind}`,
      label: view.kind,
      kind: "info",
      value: view.availability,
      editable: false,
      summary: view.description,
      // availability 的三档口径（§三·补.7）：needs_credential 是「没凭据」，
      // unavailable 是「装载不了」，两者不是一回事，这里原样透出不做合并。
      nextStep:
        view.availability === "needs_credential"
          ? "在「凭据」面板配 Modal token，或在终端执行 `spark-research auth --connector modal`"
          : view.reason,
      extra: {
        availability: view.availability,
        reason: view.reason,
        credentialConfigured: view.credentialConfigured,
        billable: view.billable,
        isDefault: view.isDefault,
        uploadLimits: view.uploadLimits,
      },
    });
  }
  return items;
}

export function computeRoutes(ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/compute", (c) => panel(c, "compute", buildItems(ctx), META));

  app.put("/compute/target", (c) => handleSettingWrite(c, ctx, "compute", "computeTarget", META, undefined, ["target"]));

  return app;
}
