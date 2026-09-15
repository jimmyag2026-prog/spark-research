import { Hono } from "hono";
import {
  SUB_AGENT_MODEL_CONFIG_TYPES,
  resolveSetting,
  subAgentModelSettingKey,
  type SubAgentModelConfigType,
} from "../../../config";
import { priceFor } from "../../../llm/providers/registry";
import type { ServerContext } from "../../context";
import { configOptions, handleSettingWrite, toItem } from "./general";
import { apiKeyEnvFor, modelsByProvider, providerOf } from "./model_guard";
import { fail, panel, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// models 面板：provider 列表 × 已登记模型 × 单价 × key 是否配置 × 当前默认 / 子代理覆盖。
//
// U6 的原话：「想换个更快的模型，找遍四栏没有任何设置按钮」。这条路由就是那个按钮的后端。
// 写入经 `assertKnownModel`——未登记的模型名写不进去（U5 第三点：不要等到运行时才炸）。

const META: SettingsMeta = {
  level: "full",
  summary: "默认模型与五类子代理的模型覆盖；每个 provider 的 key 配没配、每百万 token 多少钱",
  notes: [
    "未登记的模型名写不进去：router 调不动它，现在就该拒绝，而不是等下一次真调模型时炸",
    "子代理留空 = 退回 defaultModel。「重任务用强模型、检索摘要用快模型」就是靠这五项",
    "单价是内置表里的核实值，会过期；长期漂移用 llmPricingOverridesJson 覆盖",
  ],
};

/** provider → 已登记模型 × 单价 × key 配没配。ε 的下拉框直接吃这一段。 */
function providerCatalog(ctx: ServerContext): Record<string, unknown> {
  const opts = configOptions(ctx);
  const out: Record<string, unknown> = {};
  for (const [provider, models] of Object.entries(modelsByProvider())) {
    const envVar = apiKeyEnvFor(provider);
    let configured = false;
    if (envVar) {
      try {
        configured = resolveSetting(envVar, opts).configured;
      } catch {
        // 这个 provider 的 key 没进 CONFIG_SETTINGS（例如只认 env 的那几个）——
        // 退回直接看环境变量。**只看有没有，不读值。**
        configured = (process.env[envVar] ?? "") !== "";
      }
    }
    out[provider] = {
      apiKeyEnvVar: envVar,
      configured,
      models: models.map((model) => {
        const price = priceFor(provider, model, opts);
        return {
          model,
          inputPerMillionUsd: price?.inputPerMillionUsd ?? null,
          outputPerMillionUsd: price?.outputPerMillionUsd ?? null,
          // 没有单价 ≠ 不能用；只是台账的 costUsd 会是 null。如实标，不编一个数。
          priced: price !== null,
        };
      }),
    };
  }
  return out;
}

function buildItems(ctx: ServerContext): SettingsItem[] {
  const opts = configOptions(ctx);
  const all = Object.values(modelsByProvider()).flat().sort();

  const defaultItem = toItem(resolveSetting("defaultModel", opts));
  const defaultModel = typeof defaultItem.value === "string" ? defaultItem.value : null;
  const items: SettingsItem[] = [
    {
      ...defaultItem,
      label: "默认模型",
      kind: "enum",
      allowed: all,
      extra: {
        ...defaultItem.extra,
        provider: defaultModel ? providerOf(defaultModel) : null,
        providers: providerCatalog(ctx),
      },
    },
  ];

  for (const type of SUB_AGENT_MODEL_CONFIG_TYPES) {
    const item = toItem(resolveSetting(subAgentModelSettingKey(type), opts));
    items.push({
      ...item,
      label: `子代理 · ${type}`,
      kind: "enum",
      allowed: all,
      nextStep: item.value === null ? `留空 = 跟随默认模型（${defaultModel ?? "未设"}）` : item.nextStep,
      extra: { ...item.extra, subAgentType: type },
    });
  }
  return items;
}

export function modelsRoutes(ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/models", (c) => panel(c, "models", buildItems(ctx), META));

  app.put("/models/default", (c) =>
    handleSettingWrite(c, ctx, "models", "defaultModel", META, undefined, ["model"]),
  );

  app.put("/models/subagent/:kind", (c) => {
    const kind = c.req.param("kind");
    if (!(SUB_AGENT_MODEL_CONFIG_TYPES as readonly string[]).includes(kind)) {
      return Promise.resolve(
        fail(
          c,
          404,
          `未知的子代理类型 '${kind}'`,
          `可用：${SUB_AGENT_MODEL_CONFIG_TYPES.join(" / ")}`,
        ),
      );
    }
    const key = subAgentModelSettingKey(kind as SubAgentModelConfigType);
    return handleSettingWrite(c, ctx, "models", key, META, undefined, ["model"]);
  });

  return app;
}
