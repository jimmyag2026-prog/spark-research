// W8-2 · CLI 命令注册表（runtime contract 的 CLI 半边）。
//
// `backend/src/index.ts` 的 `main()` switch 是 CLI 真源，但它是带副作用的入口脚本、不能被 import。
// 这张表把 switch 的每个 case 组（命令 + 别名）登记一遍，并指向各模块**已导出的 HELP 常量**——
// 子命令与旗标全部从 HELP 文本结构化提取（`extractUsage`），不在这里手写第二份。
// 门禁（tests/unit/contract.test.ts）：解析 index.ts 源码里的 `case "…":` 集合，与这张表的
// 命令∪别名集合**逐项相等**——多一个、少一个都红（AD-12 第 10 条：契约与真源对撞）。
// 没有独立 HELP 常量的命令（auth/mcp/server…）只登记 `usage` 行，门禁同样要求它逐字出现在 index.ts 的主 HELP 里。
import { CAPABILITIES_HELP } from "../capabilities/cli";
import { CHEM_HELP } from "../chem/cli";
import { USAGE_HELP } from "../cli/usage";
import { COMPUTE_HELP } from "../compute/cli";
import { CONCLUSION_HELP } from "../conclusion/cli";
import { CONFIG_HELP } from "../config/cli";
import { DATA_HELP } from "../data/cli";
import { DOCTOR_HELP } from "../doctor/cli";
import { EXP_HELP } from "../experiment/cli";
import { EXT_HELP } from "../extensions/cli";
import { IDEA_HELP } from "../ideation/cli";
import { LAB_HELP } from "../lab/cli";
import { LIT_HELP, LIT_SUBCOMMAND_HELP } from "../literature/cli";
import { PROJECT_HELP } from "../project/cli";
import { PROTEIN_HELP } from "../proteins/cli";
import { REPORT_HELP } from "../report/cli";
import { REVIEW_HELP } from "../reviewer/cli";
import { NEW_HELP } from "../scaffold/cli";
import { CONTRACT_HELP } from "./help";

export interface CliCommandSpec {
  command: string;
  aliases: readonly string[];
  /** 一句话（人读）。 */
  summary: string;
  /** 模块导出的 HELP 文本（子命令/旗标从这里提取）。没有独立 HELP 的命令用 `usage`。 */
  help?: string;
  subcommandHelp?: Record<string, string>;
  /** 主 HELP 里的用法行（逐字，门禁要求它出现在 index.ts）。 */
  usage?: readonly string[];
}

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  { command: "welcome", aliases: [], summary: "零参数欢迎页（等价于不带任何参数运行）", usage: [] },
  { command: "auth", aliases: [], summary: "配置 API Key", usage: ["spark-research auth        配置 API Key"] },
  { command: "cli", aliases: ["i", "interactive"], summary: "交互式命令行", usage: [] },
  { command: "chat", aliases: [], summary: "单次对话", usage: ["spark-research chat <msg>  单次对话"] },
  { command: "project", aliases: [], summary: "项目管理", help: PROJECT_HELP },
  { command: "lit", aliases: ["literature"], summary: "文献：检索 / 入库 / 精读 / 综述 / 导出", help: LIT_HELP, subcommandHelp: LIT_SUBCOMMAND_HELP },
  { command: "usage", aliases: [], summary: "用量台账", help: USAGE_HELP },
  { command: "idea", aliases: ["ideation"], summary: "思路：共探 / novelty check", help: IDEA_HELP },
  { command: "exp", aliases: ["experiment"], summary: "干实验（仿真平台）", help: EXP_HELP },
  { command: "lab", aliases: [], summary: "湿实验（compile / approve / simulate / status）", help: LAB_HELP },
  { command: "protein", aliases: [], summary: "蛋白分析", help: PROTEIN_HELP },
  { command: "chem", aliases: [], summary: "化学结构图", help: CHEM_HELP },
  { command: "compute", aliases: [], summary: "远端算力", help: COMPUTE_HELP },
  { command: "conclusion", aliases: ["conclusions"], summary: "结论卡", help: CONCLUSION_HELP },
  { command: "report", aliases: [], summary: "研究报告导出", help: REPORT_HELP },
  { command: "data", aliases: [], summary: "项目数据导出/导入/校验", help: DATA_HELP },
  { command: "review", aliases: [], summary: "findings 状态机", help: REVIEW_HELP },
  { command: "config", aliases: [], summary: "用户配置", help: CONFIG_HELP },
  { command: "new", aliases: [], summary: "脚手架", help: NEW_HELP },
  { command: "capabilities", aliases: ["caps"], summary: "能力自描述", help: CAPABILITIES_HELP },
  { command: "contract", aliases: [], summary: "运行时契约（CLI / HTTP / MCP / 配置 / 导出 manifest schema）", help: CONTRACT_HELP },
  { command: "ext", aliases: [], summary: "扩展装载 + 契约验收", help: EXT_HELP },
  { command: "mcp", aliases: [], summary: "MCP server（stdio）", usage: ["spark-research mcp         以 MCP server 模式运行（stdio），供外部 agent 接入"] },
  { command: "doctor", aliases: [], summary: "环境体检", help: DOCTOR_HELP },
  { command: "init", aliases: [], summary: "首次向导", usage: [] },
  { command: "demo", aliases: [], summary: "离线 demo", usage: [] },
  { command: "info", aliases: [], summary: "模块状态与权限矩阵", usage: ["spark-research info        模块状态与权限矩阵"] },
  { command: "ping", aliases: [], summary: "健康检查", usage: ["spark-research ping        健康检查"] },
  { command: "server", aliases: [], summary: "启动 Web 服务", usage: ["spark-research server      启动 Web 服务（默认 4321）"] },
  { command: "help", aliases: ["--help", "-h"], summary: "显示帮助", usage: ["spark-research help        显示本帮助"] },
  { command: "version", aliases: ["--version", "-v"], summary: "打印版本号", usage: [] },
];

export interface CliUsageEntry {
  command: string;
  subcommand: string | null;
  positionals: string[];
  flags: string[];
}

const USAGE_LINE = /^\s*(?:用法:\s*)?spark-research\s+([a-z][a-z-]*)(?:\s+(.*))?$/;
const FLAG = /--[a-z][a-z0-9-]*/g;

/**
 * 从 HELP 文本提取「用法行」：`spark-research <cmd> [<sub>] <positionals> [--flags]`，
 * 紧跟其后缩进的 `--flag` 说明行归入同一条。纯文本、无副作用、确定性输出（排序去重）。
 */
export function extractUsage(help: string, command: string): CliUsageEntry[] {
  const entries = new Map<string, CliUsageEntry>();
  let current: CliUsageEntry | null = null;
  for (const rawLine of help.split("\n")) {
    const m = USAGE_LINE.exec(rawLine);
    if (m && m[1] === command) {
      const rest = (m[2] ?? "").trim();
      const tokens = rest.split(/\s+/).filter(Boolean);
      let subcommand: string | null = null;
      if (tokens[0] && /^[a-z][a-z-]*$/.test(tokens[0])) subcommand = tokens.shift()!;
      const positionals = tokens.filter((t) => /^<.*>$/.test(t));
      const flags = [...new Set(rest.match(FLAG) ?? [])];
      const key = subcommand ?? "";
      const existing = entries.get(key);
      if (existing) {
        existing.flags = [...new Set([...existing.flags, ...flags])];
        existing.positionals = [...new Set([...existing.positionals, ...positionals])];
        current = existing;
      } else {
        current = { command, subcommand, positionals, flags };
        entries.set(key, current);
      }
      continue;
    }
    // 缩进的旗标说明行（`      --target local|modal   …`）归入上一条用法
    if (current && /^\s+--[a-z]/.test(rawLine)) {
      const flags = rawLine.match(FLAG) ?? [];
      current.flags = [...new Set([...current.flags, ...flags])];
    }
  }
  return [...entries.values()]
    .map((e) => ({ ...e, flags: [...e.flags].sort(), positionals: [...e.positionals] }))
    .sort((a, b) => (a.subcommand ?? "").localeCompare(b.subcommand ?? ""));
}
