// W8-2 · runtime contract：`capabilities --json` 的可版本化子集 + 对外集成面的机器可读描述。
//
// 口径（DEVELOPMENT_PLAN_v0.8.md §四）：**全部从真源派生**——
//   CLI   ← `cli_registry.ts`（case 集合门禁对撞 index.ts）+ 各模块 HELP 文本提取
//   HTTP  ← 真实 `createApp().routes`（Hono 路由表，含 route() 挂载的子路由）
//   schema← `schemas.generated.json`（构建期 TS 接口 → JSON Schema，门禁幂等）
//   MCP   ← `MCP_TOOLS`
//   config← `CONFIG_SETTINGS`（不带值，只带 spec；secret 项标 secret）
// 输出必须**确定性**：不带时间戳、所有列表排序，两次生成逐字节相等（SDK 生成器依赖这一点）。
import pkg from "../../../package.json";
import { CONFIG_SETTINGS } from "../config";
import { MANIFEST_SCHEMA_VERSION } from "../data/manifest";
import { MCP_TOOLS } from "../mcp/tools";
import { createApp } from "../server/app";
import type { ServerDeps } from "../server/context";
import { CLI_COMMANDS, extractUsage, type CliUsageEntry } from "./cli_registry";
import schemas from "./schemas.generated.json";

export const CONTRACT_VERSION = 1;

export interface ContractCliCommand {
  command: string;
  aliases: string[];
  summary: string;
  usages: CliUsageEntry[];
}

export interface ContractHttpRoute {
  method: string;
  path: string;
  /** 挂载组：`/api/lit/*` → "lit"。 */
  group: string;
}

export interface ContractMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  longRunning: boolean;
}

export interface ContractConfigSetting {
  key: string;
  type: string;
  envVar: string | null;
  defaultValue: string | number | null;
  allowed: string[] | null;
  summary: string;
  secret: boolean;
}

export interface RuntimeContract {
  contractVersion: typeof CONTRACT_VERSION;
  version: string;
  cli: { commands: ContractCliCommand[] };
  http: {
    routes: ContractHttpRoute[];
    /** 响应/请求类型的 JSON Schema（`server/types.ts` 导出的每个类型一条，$ref 指向 definitions）。 */
    schemas: Record<string, unknown>;
  };
  mcp: { tools: ContractMcpTool[] };
  data: { manifestSchemaVersion: number; manifestSchema: unknown };
  config: { settings: ContractConfigSetting[] };
  definitions: Record<string, unknown>;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function collectHttpRoutes(deps: ServerDeps = {}): ContractHttpRoute[] {
  const app = createApp(deps);
  const seen = new Set<string>();
  const out: ContractHttpRoute[] = [];
  for (const r of app.routes) {
    if (!HTTP_METHODS.has(r.method)) continue; // ALL = 中间件
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = /^\/api\/([a-z-]+)/.exec(r.path);
    out.push({ method: r.method, path: r.path, group: m ? m[1]! : "root" });
  }
  return out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

export function buildContract(options: { serverDeps?: ServerDeps } = {}): RuntimeContract {
  const commands: ContractCliCommand[] = CLI_COMMANDS.map((spec) => {
    const usages: CliUsageEntry[] = [];
    if (spec.help) usages.push(...extractUsage(spec.help, spec.command));
    for (const [, text] of Object.entries(spec.subcommandHelp ?? {})) {
      for (const u of extractUsage(text, spec.command)) {
        const existing = usages.find((e) => e.subcommand === u.subcommand);
        if (existing) {
          existing.flags = [...new Set([...existing.flags, ...u.flags])].sort();
          existing.positionals = [...new Set([...existing.positionals, ...u.positionals])];
        } else usages.push(u);
      }
    }
    for (const line of spec.usage ?? []) usages.push(...extractUsage(line, spec.command));
    return {
      command: spec.command,
      aliases: [...spec.aliases],
      summary: spec.summary,
      usages: usages.sort((a, b) => (a.subcommand ?? "").localeCompare(b.subcommand ?? "")),
    };
  });

  const tools: ContractMcpTool[] = MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    longRunning: t.longRunning === true,
  })).sort((a, b) => a.name.localeCompare(b.name));

  const settings: ContractConfigSetting[] = CONFIG_SETTINGS.map((s) => ({
    key: s.key,
    type: s.type,
    envVar: s.envVar,
    defaultValue: s.secret === true ? null : s.defaultValue,
    allowed: s.allowed ? [...s.allowed] : null,
    summary: s.summary,
    secret: s.secret === true,
  })).sort((a, b) => a.key.localeCompare(b.key));

  const generated = schemas as { groups: Record<string, Record<string, unknown>>; definitions: Record<string, unknown> };
  return {
    contractVersion: CONTRACT_VERSION,
    version: pkg.version,
    cli: { commands: commands.sort((a, b) => a.command.localeCompare(b.command)) },
    http: { routes: collectHttpRoutes(options.serverDeps), schemas: generated.groups.http ?? {} },
    mcp: { tools },
    data: { manifestSchemaVersion: MANIFEST_SCHEMA_VERSION, manifestSchema: generated.groups.data?.ExportManifest ?? null },
    config: { settings },
    definitions: generated.definitions,
  };
}

export function renderContractJson(contract: RuntimeContract): string {
  return JSON.stringify(contract, null, 2) + "\n";
}
