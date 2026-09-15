import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// models 面板：provider × 已登记模型 × 单价 × key 是否配置 × 当前默认 / 子代理覆盖。
// 写入经 `assertKnownModel`（见 model_guard.ts）——未登记的模型名写不进去（U5 第三点）。

const META: SettingsMeta = {
  level: "full",
  summary: "默认模型与五类子代理的模型覆盖；provider 的 key 配没配、每百万 token 多少钱",
  notes: ["未登记的模型名写不进去：单价表里没有它就没法计费，台账会出现空成本"],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "defaultModel",
    label: "默认模型",
    kind: "enum",
    value: "moonshotai/kimi-k2.6",
    source: "default",
    configured: false,
    allowed: ["moonshotai/kimi-k2.6"],
    editable: true,
    summary: "所有 LLM 调用的默认模型",
    nextStep: null,
    extra: { provider: "openrouter", providerConfigured: false },
  },
];

export function modelsRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/models", (c) => panel(c, "models", FIXTURE, META));

  app.put("/models/default", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "models", FIXTURE[0]!, META);
  });

  app.put("/models/subagent/:kind", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "models", FIXTURE[0]!, META);
  });

  return app;
}
