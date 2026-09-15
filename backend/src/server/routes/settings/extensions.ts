import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { listExtensionCapabilities } from "../../../extensions/capabilities";
import { extensionDir } from "../../../extensions/paths";
import { verifyExtension } from "../../../extensions/verify";
import { loadSkills } from "../../../skills/frontmatter";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// extensions 面板：已装的第三方扩展（MCP / connector）+ 内建技能与触发词。
//
// **授权动作不走 HTTP**（AD-6，与算力面板的 plan/approve/run 同一口径）：
// `--trust` 装载、`ext grant`、`ext revoke` 三个留在终端。本面板的
// `POST /extensions/mcp` 等价于**不带 `--trust`** 的 `ext add-mcp`：写下扩展目录，
// 然后如实告诉用户「还没信任，去终端加 --trust 重跑一次才会连那个 server」。
//
// 为什么不顺手把 trust 也做了：启动任意 command 等价于本地任意命令执行。
// 一个能从网页点出来的「信任并连接」按钮，就是把这件事的门槛降到一次点击。
// 任务书给的可砍项（通用审批令牌）本轮**砍掉**——退回「只读 + 无 trust 的 add-mcp」，
// 这条路径的授权半边维持 CLI，面板的 `meta.level` 如实标 `reduced`。

const META: SettingsMeta = {
  level: "reduced",
  summary: "已装扩展（MCP / connector）与内建技能；装载、验证、卸载",
  notes: [
    "装载一律不带 --trust：启动任意 command 等价于本地任意命令执行，信任必须是人在终端做的动作（AD-6）",
    "授予 / 撤销凭据与工具权限请在终端执行 `spark-research ext grant` / `ext revoke`",
    "技能是内建的，不能在这里增删——它们随二进制一起发布",
  ],
};

function pathOptions(ctx: ServerContext): { root?: string } {
  return ctx.deps.root ? { root: ctx.deps.root } : {};
}

async function buildItems(ctx: ServerContext): Promise<SettingsItem[]> {
  const items: SettingsItem[] = [];

  for (const ext of await listExtensionCapabilities(pathOptions(ctx))) {
    items.push({
      key: `ext:${ext.name}`,
      label: ext.name,
      kind: "info",
      value: ext.status,
      editable: false,
      summary: ext.description ?? `${ext.kind ?? "未知类型"} 扩展`,
      nextStep:
        ext.status === "available"
          ? null
          : (ext.reason ??
            `在终端执行 \`spark-research ext verify ${ext.name}\` 看具体哪一条没过`),
      extra: {
        category: "extension",
        kind: ext.kind,
        version: ext.version,
        status: ext.status,
        reason: ext.reason,
        // 「声明需要什么」与「实际被授了什么」分开摆——两者不等时用户一眼看得到差额。
        requires: ext.requires,
        granted: ext.granted,
        origin: ext.origin ?? null,
        mcpTools: ext.mcpTools ?? null,
        mcpDiscoveredAt: ext.mcpDiscoveredAt ?? null,
      },
    });
  }

  for (const skill of loadSkills()) {
    const fm = skill.frontmatter;
    items.push({
      key: `skill:${skill.name}`,
      label: skill.name,
      kind: "info",
      value: null,
      editable: false,
      summary: fm.description,
      nextStep: null,
      extra: {
        category: "skill",
        // 触发词是「这个技能什么时候会被用上」的唯一线索，面板里必须看得到。
        triggers: fm.triggers,
        domain: fm.domain,
        connectors: fm.connectors,
        platforms: fm.platforms,
      },
    });
  }

  return items;
}

function extensionItem(name: string, status: string, summary: string, nextStep: string | null): SettingsItem {
  return {
    key: `ext:${name}`,
    label: name,
    kind: "info",
    value: status,
    editable: false,
    summary,
    nextStep,
    extra: { category: "extension" },
  };
}

export function extensionsRoutes(ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/extensions", async (c) => panel(c, "extensions", await buildItems(ctx), META));

  // = `ext add-mcp <name> --cmd "..."`，**不带 --trust**。
  app.post("/extensions/mcp", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const cmd = typeof body.cmd === "string" ? body.cmd.trim() : "";
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      return fail(c, 422, `扩展名 '${name}' 不合法`, "只能用字母、数字、`-`、`_`，且以字母或数字开头");
    }
    // 朴素的空白切分，**不是**完整 shell 解析——与 CLI 的 add-mcp 同一条边界
    // （StdioClientTransport 本身就是 shell:false），如实标注，不假装支持 shell 语法。
    const cmdParts = cmd.split(/\s+/).filter(Boolean);
    if (cmdParts.length === 0) {
      return fail(c, 422, "cmd 不能为空", '给一条形如 "npx -y some-mcp-server" 的命令');
    }
    const envRaw = body.env;
    if (envRaw !== undefined && (!Array.isArray(envRaw) || envRaw.some((v) => typeof v !== "string"))) {
      return fail(c, 422, "env 必须是字符串数组", '形如 { "env": ["HOME", "PATH"] }');
    }
    const [command, ...args] = cmdParts;
    const dir = extensionDir(name, pathOptions(ctx));
    if (existsSync(join(dir, "extension.json"))) {
      return fail(
        c,
        409,
        `扩展 '${name}' 已经存在`,
        `先删掉它（DELETE /api/settings/extensions/${name}）再重新装，或换一个名字`,
      );
    }
    mkdirSync(dir, { recursive: true });
    const description =
      typeof body.description === "string" && body.description.trim() !== ""
        ? body.description.trim()
        : `外部 MCP server（command="${command}"）`;
    writeFileSync(
      join(dir, "extension.json"),
      JSON.stringify(
        { kind: "mcp_client", name, version: "0.1.0", description, requires: { credentials: [], tools: [] } },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({ command, args, env: (envRaw as string[] | undefined) ?? [], credentials: [] }, null, 2) + "\n",
    );

    return written(
      c,
      "extensions",
      extensionItem(
        name,
        "untrusted",
        description,
        `扩展目录已写好，但**还没信任**。确认 command/args/env 可信后，在终端执行 ` +
          `\`spark-research ext add-mcp ${name} --cmd "${cmd}" --trust\` 才会连一次那个 server 并发现它的工具。`,
      ),
      META,
    );
  });

  app.post("/extensions/:name/verify", async (c) => {
    const name = c.req.param("name");
    const dir = extensionDir(name, pathOptions(ctx));
    if (!existsSync(join(dir, "extension.json"))) {
      return fail(c, 404, `没有装 '${name}' 这个扩展`, "用 GET /api/settings/extensions 看装了哪些");
    }
    const result = await verifyExtension(dir);
    return written(
      c,
      "extensions",
      {
        ...extensionItem(
          name,
          result.ok ? "available" : "failed",
          `ext verify: ${result.ok ? "PASS" : "FAIL"}`,
          result.ok ? null : "看 checks 里哪一条 FAIL；修好后重新 verify",
        ),
        extra: { category: "extension", checks: result.checks, kind: result.kind },
      },
      META,
    );
  });

  app.delete("/extensions/:name", (c) => {
    const name = c.req.param("name");
    const dir = extensionDir(name, pathOptions(ctx));
    if (!existsSync(join(dir, "extension.json"))) {
      return fail(c, 404, `没有装 '${name}' 这个扩展`, "用 GET /api/settings/extensions 看装了哪些");
    }
    rmSync(dir, { recursive: true, force: true });
    return written(
      c,
      "extensions",
      extensionItem(
        name,
        "removed",
        "已卸载",
        // 授权记录是全局一份（.grants.json），不随目录删除而消失——如实说清楚。
        `扩展目录已删。它此前拿到的授权仍记在 .grants.json 里，要一并撤销请在终端执行 \`spark-research ext revoke ${name}\``,
      ),
      META,
    );
  });

  return app;
}
