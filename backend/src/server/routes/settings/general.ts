import { Hono } from "hono";
import {
  CONFIG_SETTINGS,
  SettingValidationError,
  clearSetting,
  resolveSetting,
  settingSpec,
  writeSetting,
  type ConfigOptions,
  type ResolvedSetting,
  type SettingSpec,
} from "../../../config";
import type { ServerContext } from "../../context";
import { assertKnownModel } from "./model_guard";
import {
  BAD_BODY,
  LOOPBACK_REJECTION,
  fail,
  loopbackGuard,
  panel,
  settingsBody,
  written,
  type SettingsRouteOptions,
} from "./shared";
import type { SettingsItem, SettingsItemKind, SettingsMeta, SettingsPanelId } from "./types";

// general 面板：`config list` 的 32 键在网页端的投影（U6 修改方向 A）。
//
// U6 的原话：「32 个配置项，网页端一个也够不着」。这条路由就是那个「够得着」。
// 凭据类 key 在这里**只读**（`configured` 看得到，值看不到），写入走凭据面板——
// 凭据只有一条写入路径，这是 AD-18 的前提。

const META: SettingsMeta = {
  level: "full",
  summary: "所有配置项：当前值、值从哪来（env / config.json / 默认）、改了影响什么",
  notes: [
    "env 设过的项会盖住 config.json——这里如实标 source，改 config.json 不会立刻生效",
    "凭据类项在本面板只读，写入走「凭据」面板",
  ],
};

export function configOptions(ctx: ServerContext): ConfigOptions {
  return ctx.deps.root ? { root: ctx.deps.root } : {};
}

function kindOf(spec: SettingSpec): SettingsItemKind {
  if (spec.secret) return "secret";
  if (spec.type === "number") return "number";
  if (spec.type === "enum") return "enum";
  return "string";
}

/**
 * 一个配置项 → 一条 item。
 *
 * `summary` / `effect` **直接用 `CONFIG_SETTINGS` 里的原文**，不另写一份给 UI 看的说明。
 * U6 证据段点名过这件事：「每个键的说明文字 `config list` 里已经有了，直接用，不要另写一份」。
 */
export function toItem(resolved: ResolvedSetting): SettingsItem {
  const { spec } = resolved;
  const editable = !spec.secret && spec.key !== "dataDir";
  return {
    key: spec.key,
    label: spec.key,
    kind: kindOf(spec),
    // secret 的 value 由 resolveSetting 保证是 null（既有行为），这里不额外做手脚。
    value: resolved.value,
    source: resolved.source,
    configured: resolved.configured,
    allowed: spec.allowed ? [...spec.allowed] : null,
    editable,
    summary: spec.summary,
    effect: spec.effect,
    nextStep: nextStepFor(resolved, editable),
    ...(spec.envVar ? { extra: { envVar: spec.envVar } } : {}),
  };
}

function nextStepFor(resolved: ResolvedSetting, editable: boolean): string | null {
  const { spec } = resolved;
  if (spec.secret) {
    return resolved.configured
      ? null
      : `在「凭据」面板直填，或设环境变量 ${spec.envVar ?? spec.key}`;
  }
  if (spec.key === "dataDir") {
    return "换工作区请设环境变量 SPARK_RESEARCH_DATA_DIR 后重启 server（不能写进 config.json）";
  }
  if (!editable) return "这一项只能在终端改";
  // env 盖住 config.json 时必须说清楚：不说的话用户会在网页端改了半天没反应。
  if (resolved.source === "env") {
    return `当前值来自环境变量 ${spec.envVar}——在这里改会写进 config.json，但要 unset 掉那个环境变量才会生效`;
  }
  return null;
}

/** 写入前的额外校验：config 层判不了的（模型名有没有登记）在这里补。 */
function assertWritable(key: string, value: unknown): void {
  if (key === "defaultModel" || key.startsWith("subAgentModel_") || key === "embeddingModel") {
    if (key === "embeddingModel") return; // embedding 模型名不在 PROVIDER_MODELS 里，形状是 <provider>/<model>
    assertKnownModel(String(value));
  }
}

/** general / network / storage 三个面板共用的写入处理——它们都是同一批配置键的投影。 */
export async function handleSettingWrite(
  c: Parameters<typeof settingsBody>[0],
  ctx: ServerContext,
  panelId: SettingsPanelId,
  key: string,
  meta: SettingsMeta,
  allowedKeys?: readonly string[],
  // 请求体里读哪个字段当值。任务书给各面板定了各自的名字（compute 是 `{ target }`、
  // models 是 `{ model }`），通用的写路由是 `{ value }`——两者都认，先到先得。
  bodyKeys: readonly string[] = ["value"],
): Promise<Response> {
  if (allowedKeys && !allowedKeys.includes(key)) {
    return fail(
      c,
      404,
      `'${key}' 不属于「${panelId}」面板`,
      `这一项在「通用」面板改：PUT /api/settings/general/${key}`,
    );
  }
  const body = await settingsBody(c);
  if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
  const present = [...bodyKeys, "value"].find((name) => body[name] !== undefined);
  if (present === undefined) {
    return fail(
      c,
      400,
      `请求体缺少字段 '${bodyKeys[0]}'`,
      `重发形如 { "${bodyKeys[0]}": "..." } 的请求体`,
    );
  }
  const value = body[present];
  try {
    assertWritable(key, value);
    const resolved = writeSetting(key, value, configOptions(ctx));
    return written(c, panelId, toItem(resolved), meta);
  } catch (error) {
    if (error instanceof SettingValidationError) {
      return fail(c, error.status, error.message, error.nextStep);
    }
    throw error;
  }
}

export function generalRoutes(ctx: ServerContext, options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();
  const isLoopback = loopbackGuard(options);

  app.get("/general", (c) =>
    panel(
      c,
      "general",
      CONFIG_SETTINGS.map((spec) => toItem(resolveSetting(spec.key, configOptions(ctx)))),
      META,
    ),
  );

  app.put("/general/:key", async (c) => {
    const key = c.req.param("key");
    // AD-18 ②：凭据键在这条路径上一律 403（下面 writeSetting 也会拒，但那是 config 层的
    // 结构性拒绝；这里先按「凭据路径」处理，连 loopback 都要求，口径与凭据面板一致）。
    if (settingSpec(key)?.secret) {
      if (!isLoopback(c)) {
        return fail(c, 403, LOOPBACK_REJECTION.error, LOOPBACK_REJECTION.nextStep);
      }
      return fail(
        c,
        403,
        `'${key}' 是凭据，不在这条路径写`,
        `改用 PUT /api/settings/credentials/${key}，或在终端执行 \`spark-research auth\``,
      );
    }
    return handleSettingWrite(c, ctx, "general", key, META);
  });

  app.delete("/general/:key", (c) => {
    const key = c.req.param("key");
    if (settingSpec(key)?.secret && !isLoopback(c)) {
      return fail(c, 403, LOOPBACK_REJECTION.error, LOOPBACK_REJECTION.nextStep);
    }
    try {
      return written(c, "general", toItem(clearSetting(key, configOptions(ctx))), META);
    } catch (error) {
      if (error instanceof SettingValidationError) {
        return fail(c, error.status, error.message, error.nextStep);
      }
      throw error;
    }
  });

  return app;
}
