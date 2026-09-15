import { chmodSync } from "node:fs";
import { Hono } from "hono";
import { configPath, configuredSearchSources, loadConfig, saveConfig, type ConfigOptions } from "../../../config";
import { DEFAULT_SEARCH_SOURCES, LITERATURE_SOURCES } from "../../../literature/models";
import { participationNextStep } from "../../../literature/source_state";
import { registerSecret, registerSecrets } from "../../../llm/types";
import type { ServerContext } from "../../context";
import {
  PROVIDER_FIELD,
  allCredentialSpecs,
  fileMode,
  findCredentialSpec,
  providerConfigured,
  type CredentialSpec,
} from "./catalog";
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
import type { CredentialDeleteResponse, SettingsItem, SettingsMeta } from "./types";

// credentials 面板（方案「乙」，用户 2026-09-14 拍板；约束见 AD-18）。
//
// 六条硬约束，缺一条不许合。每一条在下面都能指到具体那一行：
//   ① write-only —— `toItem()` 只产出字段**名**（`fields` / `fieldsSet`），
//      `value` 恒为 null；本文件里没有任何一处把凭据值放进响应或日志。
//   ② loopback 硬限 —— 每个写路由第一件事就是 `isLoopback(c)`，且它**不查
//      `originAllowlist`**、**取不到地址也拒绝**（fail-closed，见 shared.ts 的判定注释）。
//   ③ 永不进 `process.env` —— 写入只经 `CredentialStore.set` / `saveConfig`；
//      本文件不 import `process`，也没有任何 `env[...] = ...`。
//   ④ 脱敏登记 —— 写入成功立刻 `registerSecret()`，此后任何经 `redactSecrets`
//      的输出都按字面量把它打掉（形状匹配认不出的 key 也挡得住）。
//   ⑤ 文件 0600 —— 写后 `fileMode()` 复核，宽了就当场收紧并在响应里如实标注。
//   ⑥ 删除有确认语义 —— `DELETE` 返回 `{ removed, note }`，文案照上游。
//
// 对应 `tests/unit/settings_credentials.test.ts` 的六条。

export const DELETE_NOTE = "只删本机保存的值，不影响外部账户";

const META: SettingsMeta = {
  level: "full",
  summary: "各文献源 / 算力 connector 与各 LLM provider 的凭据：只看得到字段名，看不到值",
  notes: [
    "值写进来之后永不回显——响应、日志、raw、record、usage 里都不会再出现它（AD-18 ①）",
    "只接受本机（loopback）来源的写入；配了 originAllowlist 也不会放开这条路径（AD-18 ②）",
    "凭据不进环境变量：写完就在 daemon 进程内按需取用（AD-18 ③）",
  ],
};

function configOptions(ctx: ServerContext): ConfigOptions {
  return ctx.deps.root ? { root: ctx.deps.root } : {};
}

/** 一条凭据的展示形态。**只有字段名，没有值。** */
function toItem(ctx: ServerContext, spec: CredentialSpec): SettingsItem {
  const fieldsSet =
    spec.category === "connector"
      ? (ctx.credentials().describe(spec.id)?.keys ?? [])
      : providerConfigured(spec.id, configOptions(ctx))
        ? [PROVIDER_FIELD]
        : [];
  const configured = fieldsSet.length > 0;
  return {
    key: spec.id,
    label: spec.label,
    kind: "secret",
    // AD-18 ①：这里永远是 null。谁把它改成返值，settings_credentials 的①会红。
    value: null,
    configured,
    editable: true,
    summary: spec.summary,
    nextStep: configured ? null : spec.nextStep,
    fields: spec.fields,
    fieldsSet,
    extra: { category: spec.category },
  };
}

/** 请求体里的 `fields`：`{ <字段名>: <值> }`。值只在本函数与写入之间存在，不出去。 */
function readFields(body: Record<string, unknown>, spec: CredentialSpec): Record<string, string> | string {
  const raw = body.fields;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return `请求体要有 fields 对象，形如 { "fields": { "${spec.fields[0]}": "..." } }`;
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!spec.fields.includes(name)) {
      // 错误消息里点名的是**字段名**，不是值——这条消息也会进日志。
      return `'${spec.id}' 没有字段 '${name}'（可用：${spec.fields.join(" / ")}）`;
    }
    if (typeof value !== "string" || value.trim() === "") {
      return `字段 '${name}' 必须是非空字符串`;
    }
    out[name] = value.trim();
  }
  if (Object.keys(out).length === 0) return `至少要给一个字段（可用：${spec.fields.join(" / ")}）`;
  return out;
}

/**
 * γ-1：刚写完凭据的这个 id 如果是文献检索源、却不在 `searchSources` 里，给一句下一步。
 *
 * 不是检索源（LLM provider、算力 connector）一律返回 null——它们没有「勾选」这个概念，
 * 硬套一句「去检索源面板勾选」只会把人指到一个根本没有这一行的面板。
 */
function searchSourceNextStep(id: string, opts: ConfigOptions): string | null {
  if (!(LITERATURE_SOURCES as readonly string[]).includes(id)) return null;
  const configured = configuredSearchSources(opts);
  const selected = configured && configured.length > 0 ? configured : [...DEFAULT_SEARCH_SOURCES];
  if (selected.includes(id)) return null;
  return participationNextStep("configured_not_selected", id);
}

export function credentialsRoutes(ctx: ServerContext, options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();
  const isLoopback = loopbackGuard(options);

  app.get("/credentials", (c) =>
    panel(
      c,
      "credentials",
      allCredentialSpecs(ctx).map((spec) => toItem(ctx, spec)),
      META,
    ),
  );

  app.put("/credentials/:id", async (c) => {
    // AD-18 ②：第一道闸，先于解析请求体——非 loopback 的请求连 body 都不该被读。
    if (!isLoopback(c)) {
      return fail(c, 403, LOOPBACK_REJECTION.error, LOOPBACK_REJECTION.nextStep);
    }
    const id = c.req.param("id");
    const spec = findCredentialSpec(ctx, id);
    if (!spec) {
      return fail(
        c,
        404,
        `未知的凭据 id '${id}'`,
        "用 GET /api/settings/credentials 看有哪些 id 可配",
      );
    }
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);

    const fields = readFields(body, spec);
    if (typeof fields === "string") {
      return fail(c, 422, fields, `按 fields 里列出的字段名重发：${spec.fields.join(" / ")}`);
    }

    let path: string;
    if (spec.category === "connector") {
      const store = ctx.credentials();
      // 合并既有字段：只填了 tokenSecret 不该把 tokenId 清掉。
      const existing = store.get(spec.id) ?? {};
      store.set(spec.id, { ...existing, ...fields });
      path = store.path;
    } else {
      const opts = configOptions(ctx);
      const config = loadConfig(opts);
      config[spec.id] = fields[PROVIDER_FIELD]!;
      saveConfig(config, opts);
      path = configPath(opts);
    }

    // AD-18 ④：写成功即登记脱敏。**在返回响应之前**——万一同一个请求里还要落别的日志，
    // 那时候登记表里已经有它了。
    registerSecrets(fields);

    // AD-18 ⑤：写后复核权限。CredentialStore.write / saveConfig 都会 chmod 0600，
    // 这里是「信任但复核」——真出现宽权限（比如被外部进程改过）就当场收紧。
    let mode = fileMode(path);
    if (mode !== "600" && mode !== "-") {
      chmodSync(path, 0o600);
      mode = fileMode(path);
    }

    const item = toItem(ctx, spec);
    // γ-1（V173 / U43 ②）：凭据写进去了，但这个源**不在检索清单里** → 回一句可执行的下一步。
    //
    // U43 现场就是这个形状：用户配了 AMiner 的 key，合理预期是「以后会用它」，
    // 实际还要再去另一个面板勾一次，而没勾的后果（每次检索静默 skip）在任何界面上都看不出来。
    // 写入成功时是唯一一个「用户此刻正想着这个源」的时刻，这句话必须出现在这里。
    const nextStep = searchSourceNextStep(spec.id, configOptions(ctx));
    return written(
      c,
      "credentials",
      { ...item, ...(nextStep ? { nextStep } : {}), extra: { ...item.extra, fileMode: mode } },
      META,
    );
  });

  app.delete("/credentials/:id", (c) => {
    if (!isLoopback(c)) {
      return fail(c, 403, LOOPBACK_REJECTION.error, LOOPBACK_REJECTION.nextStep);
    }
    const id = c.req.param("id");
    const spec = findCredentialSpec(ctx, id);
    if (!spec) {
      return fail(c, 404, `未知的凭据 id '${id}'`, "用 GET /api/settings/credentials 看有哪些 id 可删");
    }
    let removed: boolean;
    if (spec.category === "connector") {
      removed = ctx.credentials().remove(spec.id);
    } else {
      const opts = configOptions(ctx);
      const config = loadConfig(opts);
      removed = config[spec.id] !== undefined;
      delete config[spec.id];
      saveConfig(config, opts);
    }
    // AD-18 ⑥：删除有确认语义——说清楚删掉的是**本机保存的值**，不是外部账户。
    return c.json({
      panel: "credentials",
      removed,
      id: spec.id,
      note: DELETE_NOTE,
      item: toItem(ctx, spec),
    } satisfies CredentialDeleteResponse);
  });

  return app;
}

/**
 * 进程启动时把**已经存在**的凭据登记进脱敏集合（AD-18 ④ 的另一半）。
 *
 * 只登记 connector 类：provider 类的值本来就在 `config.json` 里、且 router 走 env 读，
 * 这里不去碰它们，免得为了脱敏反而把一堆值读进内存。收口把这个函数接进 server 启动路径。
 */
export function registerExistingSecrets(ctx: ServerContext): number {
  const store = ctx.credentials();
  let count = 0;
  for (const meta of store.list()) {
    const values = store.get(meta.connectorId);
    if (!values) continue;
    for (const value of Object.values(values)) {
      registerSecret(value);
      count += 1;
    }
  }
  return count;
}
