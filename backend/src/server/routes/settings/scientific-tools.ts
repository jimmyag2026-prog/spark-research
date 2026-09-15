import { Hono } from "hono";
import { buildCapabilities } from "../../../capabilities";
import { SettingValidationError, configuredSearchSources, resolveSetting, writeSetting } from "../../../config";
import { DEFAULT_SEARCH_SOURCES, LITERATURE_SOURCES } from "../../../literature/models";
import { describeSourceState } from "../../../literature/source_state";
import type { ServerContext } from "../../context";
import { configOptions, toItem } from "./general";
import { BAD_BODY, fail, panel, queryFlag, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// scientific-tools 面板：`capabilities --json` 的 connector / platform / wetBackend / rule
// 四段，`?probe=1` 走真探（spawn 子进程问本地仿真平台 / 湿实验后端装没装）。
//
// 写的那一半是 `PUT /api/settings/sources`：勾选默认检索源 → 写 `searchSources`。
// 勾掉一个源之后，不带 `--sources` 的检索**真的不再查它**（不是查了再丢结果）。

const META: SettingsMeta = {
  level: "full",
  summary: "文献源、仿真平台、湿实验后端、评审规则：各自可用不可用，为什么",
  notes: [
    "?probe=1 才会 spawn 子进程真探本地平台；不带它是零 I/O 的静态清单",
    "需要 key 的源显示 `spark-research auth --connector <id>`，也可以在「凭据」面板直填",
    "勾掉一个源之后，不给 --sources 的检索真的不再查它；`lit add` 按标识符取单篇不受影响",
  ],
};

/**
 * 当前勾选的检索源。
 *
 * 不能直接用 `literature/search.ts` 的 `configuredDefaultSources()`——那个函数读的是
 * **进程级** dataDir，而 server 可能跑在注入的 `deps.root` 上（测试就是这么跑的）。
 * 这里按同一套规则（未知 id 丢掉、空了回默认集）读本 server 自己的配置。
 */
function selectedSources(ctx: ServerContext): string[] {
  const configured = configuredSearchSources(configOptions(ctx));
  if (!configured) return [...DEFAULT_SEARCH_SOURCES];
  const known = new Set<string>(LITERATURE_SOURCES);
  const valid = configured.filter((id) => known.has(id));
  return valid.length > 0 ? valid : [...DEFAULT_SEARCH_SOURCES];
}

/** 可用性 → 一句可执行的下一步。U6 点名过：只显示状态不说去哪做，违反本项目自己的约定。 */
function nextStepFor(availability: string, id: string, reason: string | null): string | null {
  if (availability === "needs_credential") {
    return `在「凭据」面板直填，或在终端执行 \`spark-research auth --connector ${id}\``;
  }
  if (availability === "available") return null;
  return reason;
}

async function buildItems(ctx: ServerContext, probe: boolean): Promise<SettingsItem[]> {
  const opts = configOptions(ctx);
  const manifest = await buildCapabilities({
    ...opts,
    probe,
    connectors: ctx.connectors,
    credentials: ctx.credentials(),
  });

  const selected = selectedSources(ctx);
  const literatureIds = new Set<string>(LITERATURE_SOURCES);

  const sourcesItem: SettingsItem = {
    ...toItem(resolveSetting("searchSources", opts)),
    label: "默认检索源",
    kind: "enum",
    allowed: [...LITERATURE_SOURCES],
    nextStep: null,
    extra: {
      selected,
      // 每个可选源的可用性一并给出来：ε 的勾选框要能在「需要 key」的那几个旁边
      // 直接显示下一步，而不是勾上之后才发现每次检索都 skipped。
      options: manifest.connectors
        .filter((connector) => literatureIds.has(connector.id))
        .map((connector) => {
          // γ-1（V173 / U43）：三态在这里算齐——「勾没勾」「有没有凭据」「本次会不会真查」。
          // 第三件事是前两件的合取，此前没有任何地方算过，于是「配了 key 的源从不参与检索」
          // 这件事在界面上完全看不出来。合取只有 literature/source_state.ts 一份。
          const state = describeSourceState(connector.id, {
            selected: selected.includes(connector.id),
            apiKeyRequired: connector.apiKeyRequired,
            // capabilities 的 credentialConfigured 对免 key 的源是 null（「不适用」）。
            // 三态只问「有没有」，null 与 false 在这里同义——但**不许**把 null 悄悄
            // 当成 false 传下去，那会让 source_state 的入参类型说谎。
            credentialConfigured: connector.credentialConfigured === true,
          });
          return {
            ...state,
            availability: connector.availability,
            caveat: connector.caveat,
            // 凭据缺失时优先给三态自己的下一步（它点名的是这个源），
            // 其余情况退回可用性那条（可能说的是「上游挂了」这类与勾选无关的原因）。
            nextStep:
              state.participationNextStep ?? nextStepFor(connector.availability, connector.id, connector.reason),
          };
        }),
    },
  };

  const items: SettingsItem[] = [sourcesItem];

  for (const connector of manifest.connectors) {
    items.push({
      key: `connector:${connector.id}`,
      label: connector.id,
      kind: "info",
      value: connector.availability,
      editable: false,
      summary: connector.description,
      nextStep: nextStepFor(connector.availability, connector.id, connector.reason),
      extra: {
        category: "connector",
        domain: connector.domain,
        apiKeyRequired: connector.apiKeyRequired,
        credentialConfigured: connector.credentialConfigured,
        reason: connector.reason,
        caveat: connector.caveat,
        isSearchSource: literatureIds.has(connector.id),
      },
    });
  }

  for (const platform of manifest.simulationPlatforms) {
    items.push({
      key: `platform:${platform.id}`,
      label: platform.id,
      kind: "info",
      value: platform.availability,
      editable: false,
      summary: platform.description,
      nextStep: platform.availability === "available" ? null : platform.reason,
      extra: {
        category: "platform",
        // deterministic 决定下游结论能不能说「逐位一致」——摆出来，不要让人去猜。
        deterministic: platform.deterministic,
        isDefault: platform.isDefault,
        reason: platform.reason,
        probeCache: platform.probeCache ?? null,
        // 真探过才有 `probe`：前端（ε）只在这个键存在时显示「探通了 / 没探通」徽标；
        // 静态清单不放它——静态清单说「可用」不等于探过（AD-12）。
        probe: probe ? { ok: platform.availability === "available", note: platform.reason } : null,
      },
    });
  }

  for (const backend of manifest.wetBackends) {
    items.push({
      key: `wetBackend:${backend.id}`,
      label: backend.id,
      kind: "info",
      value: backend.availability,
      editable: false,
      summary: backend.description,
      nextStep: backend.availability === "available" ? null : backend.reason,
      extra: {
        category: "wetBackend",
        isDefault: backend.isDefault,
        reason: backend.reason,
        probe: probe ? { ok: backend.availability === "available", note: backend.reason } : null,
      },
    });
  }

  for (const rule of manifest.rules) {
    items.push({
      key: `rule:${rule.id}`,
      label: rule.id,
      kind: "info",
      value: rule.severity,
      editable: false,
      summary: rule.description,
      nextStep: null,
      extra: { category: "rule", kind: rule.kind, severity: rule.severity },
    });
  }

  items.push({
    ...toItem(resolveSetting("simulationPlatform", opts)),
    label: "默认仿真平台",
  });
  items.push({
    ...toItem(resolveSetting("wetBackend", opts)),
    label: "默认湿实验后端",
  });

  return items;
}

export function scientificToolsRoutes(ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/scientific-tools", async (c) =>
    panel(c, "scientific-tools", await buildItems(ctx, queryFlag(c, "probe")), META),
  );

  app.put("/sources", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    const raw = body.ids ?? body.value;
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
      return fail(
        c,
        400,
        "请求体要有 ids 字符串数组",
        `重发形如 { "ids": ["openalex", "arxiv"] } 的请求体`,
      );
    }
    const ids = (raw as string[]).map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) {
      return fail(c, 422, "至少要留一个检索源", "全不勾等于一次都不检索；要恢复默认请勾回内置那几个");
    }
    // 未知 id 当场 422——写进去只会在下一次检索时变成一个静默跳过的源。
    const unknown = ids.filter((id) => !(LITERATURE_SOURCES as readonly string[]).includes(id));
    if (unknown.length > 0) {
      return fail(
        c,
        422,
        `未知的检索源：${unknown.join(", ")}`,
        `可用：${LITERATURE_SOURCES.join(" / ")}`,
      );
    }
    try {
      const resolved = writeSetting("searchSources", ids.join(","), configOptions(ctx));
      return written(
        c,
        "scientific-tools",
        { ...toItem(resolved), label: "默认检索源", extra: { selected: selectedSources(ctx) } },
        META,
      );
    } catch (error) {
      if (error instanceof SettingValidationError) {
        return fail(c, error.status, error.message, error.nextStep);
      }
      throw error;
    }
  });

  return app;
}
