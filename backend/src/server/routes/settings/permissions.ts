import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { listExtensionCapabilities } from "../../../extensions/capabilities";
import { MCP_WITHHELD } from "../../../mcp/tools";
import type { ServerContext } from "../../context";
import { panel, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// permissions 面板：谁被授了什么。
//
// **只读**。撤销是授权动作，走终端（`spark-research ext revoke`）——与 extensions
// 面板同一条口径（AD-6）。把「谁被授了什么」摆出来看得见，本身就是这个面板的全部价值：
// 授权记录此前只有 `.grants.json` 这一个落盘文件，没有任何界面读得到它。

const META: SettingsMeta = {
  level: "readonly",
  summary: "谁被授了什么：扩展的凭据与工具授权、刻意不暴露给 agent 的动作、有效审批令牌",
  notes: [
    "只读面板。授予 / 撤销请在终端执行 `spark-research ext grant` / `ext revoke`",
    "「刻意不暴露」那一段是设计不是缺陷：审批类动作必须由人来做（AD-6）",
    "审批令牌只计数——令牌原文只在签发那一刻出现一次，落盘的是哈希，这里也读不到",
  ],
};

interface StoredTokenLike {
  expiresAt?: string;
  used?: boolean;
}

/**
 * 某个项目下当前**仍然有效**（没用过且没过期）的审批令牌数。
 *
 * `compute/approval_token.ts` 与 `lab/approval_token.ts` 都没有导出「列一下」的 API
 * （它们只导出 `issue` / `consume`），而那两个文件不在本 lane 的足迹里。这里按它们的
 * 落盘格式只读地数一遍，**不碰令牌哈希、也不判定有效性之外的任何东西**。
 * 收口建议：给那两个模块各加一个 `countActive(projectRoot)`，把这段镜像逻辑删掉。
 */
function activeTokenCount(projectRoot: string, kind: "compute" | "lab"): number {
  const file = join(projectRoot, kind, "approval_tokens.json");
  if (!existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tokens?: StoredTokenLike[] };
    const now = Date.now();
    return (parsed.tokens ?? []).filter(
      (t) => t.used !== true && Date.parse(t.expiresAt ?? "") > now,
    ).length;
  } catch {
    return 0;
  }
}

async function buildItems(ctx: ServerContext): Promise<SettingsItem[]> {
  const items: SettingsItem[] = [];
  const pathOptions = ctx.deps.root ? { root: ctx.deps.root } : {};

  // ① 各扩展的授权矩阵：声明需要什么 vs 实际被授了什么。
  for (const ext of await listExtensionCapabilities(pathOptions)) {
    const missingCredentials = ext.requires.credentials.filter((id) => !ext.granted.credentials.includes(id));
    const missingTools = ext.requires.tools.filter((id) => !ext.granted.tools.includes(id));
    items.push({
      key: `grant:${ext.name}`,
      label: ext.name,
      kind: "info",
      value: missingCredentials.length + missingTools.length === 0 ? "granted" : "partial",
      editable: false,
      summary: `凭据 ${ext.granted.credentials.length}/${ext.requires.credentials.length} · 工具 ${ext.granted.tools.length}/${ext.requires.tools.length}`,
      nextStep:
        missingCredentials.length + missingTools.length === 0
          ? null
          : `在终端执行 \`spark-research ext grant ${ext.name}\` 补齐：` +
            `${[...missingCredentials, ...missingTools].join(", ")}`,
      extra: {
        category: "grant",
        requires: ext.requires,
        granted: ext.granted,
        missing: { credentials: missingCredentials, tools: missingTools },
      },
    });
  }

  // ② 刻意不暴露给外部 agent 的动作（AD-6 / AD-14）。
  for (const withheld of MCP_WITHHELD) {
    items.push({
      key: `withheld:${withheld.name}`,
      label: withheld.name,
      kind: "info",
      value: "withheld",
      editable: false,
      summary: withheld.reason,
      // 「不提供入口可以，但要把去哪做说清楚」——U6 结尾点名的那条约定。
      nextStep: withheld.humanAction,
      extra: { category: "withheld" },
    });
  }

  // ③ 当前有效的审批令牌数（按项目）。
  for (const meta of ctx.projects.list({ includeArchived: true })) {
    const root = ctx.projects.pathsFor(meta.slug).root;
    const compute = activeTokenCount(root, "compute");
    const lab = activeTokenCount(root, "lab");
    if (compute + lab === 0) continue; // 没有令牌的项目不占版面
    items.push({
      key: `tokens:${meta.slug}`,
      label: meta.slug,
      kind: "info",
      value: compute + lab,
      editable: false,
      summary: `有效审批令牌：算力 ${compute} · 湿实验 ${lab}`,
      nextStep: "令牌 10 分钟后自动失效；用掉一次即作废，不需要手动清理",
      extra: { category: "token", compute, lab },
    });
  }

  return items;
}

export function permissionsRoutes(ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/permissions", async (c) => panel(c, "permissions", await buildItems(ctx), META));

  return app;
}
