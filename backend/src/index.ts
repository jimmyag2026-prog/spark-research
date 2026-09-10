#!/usr/bin/env bun
import { join } from "path";
import { createInterface } from "readline";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { SparkResearchDaemon } from "./daemon/daemon";
import { PERMIT_SETS } from "./daemon/permissions";
import { OrchestratorAgent } from "./agents/orchestrator";
import { startServer } from "./server/server";
import { DEFAULT_FRONTEND_DIR } from "./server/app";
import { ProjectManager } from "./project/manager";
import { runProjectCommand } from "./project/cli";
import { runLitCommand } from "./literature/cli";
import { runIdeaCommand } from "./ideation/cli";
import { runExpCommand } from "./experiment/cli";
import { runLabCommand } from "./lab/cli";
import { runConclusionCommand } from "./conclusion/cli";
import { runReportCommand } from "./report/cli";
import { runConfigCommand } from "./config/cli";
import { applyConfigEnvDefaults, dataDir, enforceConfigPermissions } from "./config";
import { runCapabilitiesCommand } from "./capabilities/cli";
import { runNewCommand } from "./scaffold/cli";
import { runMcpStdio } from "./mcp/server";
import { MCP_TOOLS } from "./mcp/tools";
import { runProteinCommand } from "./proteins/cli";
import { runDoctorCommand } from "./doctor/cli";
import { runReviewCommand } from "./reviewer/cli";
// W1-d（B-a 打包分发）：原先是 `await Bun.file(join(import.meta.dir, "../../package.json")).json()`——
// `bun build --compile` 产出的单二进制里 `import.meta.dir` 指向虚拟的 `/$bunfs/root/`，
// 运行期拼路径读不到真实的 package.json（ENOENT，`--version`/`--help`/`capabilities` 全部炸）。
// 改成静态 import：Bun 的打包器能分析到这个引用，把 JSON 内容直接编译进二进制，
// 编译产物和 `bun backend/src/index.ts` 直接跑两种模式都不再依赖运行期文件系统。
import pkg from "../../package.json";

const HELP = `Spark Research v${pkg.version}
开源科学 Agent 平台：干湿闭环 + 自动化实验室

用法:
  spark-research             交互式 CLI（类似 opencode）
  spark-research auth        配置 API Key
  spark-research project     项目管理（new / list / open / archive）
  spark-research lit         文献域（search / add / list / pdf / read / review / export / sources）
  spark-research idea        思路库（new / list / check —— Co-explore + Novelty check）
  spark-research exp         干实验闭环（new / run / status / list / platforms）
  spark-research protein <query>  蛋白结构调研（UniProt → RCSB PDB → AlphaFold）
  spark-research lab         湿实验（compile / approve / reject / simulate / status / backends）
  spark-research conclusion  结论卡（list / show / review —— 只有 approved 进报告结论区）
  spark-research review      findings 状态机（findings [--open] / mark-addressed <id>）
  spark-research report      研究报告导出（export —— 证据图 → Markdown）
  spark-research capabilities 能力自描述（--json 给 agent，不带则给人看的表格）
  spark-research doctor      环境体检（bun / Python 三档依赖 / provider key / 前端产物），缺什么给修复命令
  spark-research config      用户配置（list / get / set / unset / path）
  spark-research new         脚手架（new skill|connector|platform <name>）
  spark-research mcp         以 MCP server 模式运行（stdio），供外部 agent 接入
  spark-research info        模块状态与权限矩阵
  spark-research ping        健康检查
  spark-research server      启动 Web 服务（默认 4321）
  spark-research chat <msg>  单次对话
  spark-research help        显示本帮助
`;

// R-d-4（v0.4 P11 lane R-d）：CONFIG_DIR 曾经硬编码 `~/.spark-research`，不认
// `SPARK_RESEARCH_DATA_DIR`——同一个工作区根目录，CLI 的 auth/config.json 走一套解析
// （硬编码），其余一切（projects/、credentials.json、日志）走 `config/index.ts` 的
// `dataDir()`（env > 默认值）。改了 SPARK_RESEARCH_DATA_DIR 之后，`auth` 存的 key
// 与其余数据会落进两个不同目录——这里改成同一套解析，消掉这个漂移面。
const CONFIG_DIR = dataDir();
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// D-6：这里落盘的是 LLM API key（KIMI_API_KEY / OPENROUTER_API_KEY）——与
// daemon/credentials.ts 里的 connector 凭据同等敏感，理应同等保护（0600）。
// 照抄 credentials.ts 的写法：目录 0700 / 文件 0600 / 写入后显式 chmod。
const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

interface Config {
  [key: string]: string | undefined;
  defaultProvider?: string;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: CONFIG_DIR_MODE });
  // writeFileSync 的 mode 只在创建新文件时生效；已存在的文件（例如从 0644 升级而来）
  // 要显式 chmod 才会真的被收紧。
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: CONFIG_FILE_MODE });
  chmodSync(CONFIG_FILE, CONFIG_FILE_MODE);
}

const KEY_NAMES = {
  kimi: "KIMI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

function getApiKey(): { provider: string; key: string } | null {
  const config = loadConfig();
  const providers = ["kimi", "openrouter"] as const;

  for (const provider of providers) {
    const envKey = process.env[KEY_NAMES[provider]];
    if (envKey) return { provider, key: envKey };
    const configKey = config[KEY_NAMES[provider]];
    if (configKey) return { provider, key: configKey };
  }
  return null;
}

async function auth() {
  const config = loadConfig();

  console.log("Spark Research API Key 配置\n");
  console.log("当前配置:");
  for (const [name, envName] of Object.entries(KEY_NAMES)) {
    console.log(`  ${envName}: ${config[envName] ? "已设置" : "未设置"}`);
  }
  console.log(`  默认 Provider: ${config.defaultProvider || "未设置"}`);
  console.log("");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer.trim()));
    });
  };

  try {
    console.log("选择 Provider:");
    console.log("  1. Kimi (api.moonshot.cn) - 推荐，国内访问快");
    console.log("  2. OpenRouter (openrouter.ai) - 支持多个模型");
    const choice = await question("选择 [1/2]: ");

    const provider = choice === "1" ? "kimi" : choice === "2" ? "openrouter" : null;
    if (!provider) {
      console.log("无效选择");
      return;
    }

    const envName = KEY_NAMES[provider];
    const key = await question(`输入 ${envName}: `);
    if (key) {
      config[envName] = key;
      config.defaultProvider = provider;
    }

    saveConfig(config);
    console.log(`\n✅ 配置已保存到 ${CONFIG_FILE}`);
  } finally {
    rl.close();
  }
}

// W1-d（B-a 打包分发）：零参数行为。
//
// 方案 §4.4/P14 说零参数该"起 server + 开浏览器"——但那是向导/demo 的形态（读
// docs/DEVELOPMENT_PLAN_v0.4.md §5·补.2，B-b/B-c 记在 W2-d，不在这条 lane 的任务书里）。
// 这里判断：一个刚 `npx spark-research` 装完、什么都没配置过的人，此刻最需要的不是
// 被直接扔进一个还没配好 key 的 Web UI，而是**看清楚当前状态 + 该敲哪条命令**——
// 抢先起 server 会在 W2-d 真正做向导时产生两套"第一屏"设计，先把浅层的引导做对，
// 深层的向导留给 W2-d 去接。保持零参数路径**快**（不 spawn 子进程探测 Python，
// 那是 `doctor` 的活）、**不报错**（现在已经这样，这里只是把"下一步"从一句话
// 扩成几条具体命令），符合任务书第 5 条的要求。
// 参数全部可选、全部有默认值：不传就是真实的零参数行为；传了就是
// tests/unit/cli_entry.test.ts 用来断言「引导内容随状态变化」与「打包产物缺失时不炸」的钩子
// （阴性对照②：frontendBuilt:false 时输出必须给出 `bun run build:web`，不许报错或吞掉信息）。
export interface WelcomeOptions {
  out?: (line: string) => void;
  auth?: { provider: string; key: string } | null;
  frontendBuilt?: boolean;
  configDir?: string;
  version?: string;
}

export function welcome(options: WelcomeOptions = {}): void {
  const out = options.out ?? ((line: string) => console.log(line));
  const auth = options.auth !== undefined ? options.auth : getApiKey();
  const frontendBuilt = options.frontendBuilt ?? existsSync(join(DEFAULT_FRONTEND_DIR, "index.html"));
  const configDir = options.configDir ?? CONFIG_DIR;
  const version = options.version ?? pkg.version;

  out("");
  out("  Spark Research v" + version);
  out("  开源科学 Agent 平台 — 对标 Claude Science");
  out("");
  out("  当前状态");
  out(`    API Key   ${auth ? `${auth.provider}（已配置）` : "未配置"}`);
  out(`    Web 前端  ${frontendBuilt ? "已构建" : "未构建（不影响 CLI/API，只影响 Web UI）"}`);
  out(`    数据目录  ${configDir}`);
  out("");
  out("  下一步");
  if (!auth) {
    out("    spark-research auth              配置 API Key（第一步，其余功能都要它）");
  }
  out("    spark-research doctor             环境体检：Python 三档依赖 / provider key / 前端产物，缺什么给修复命令");
  out("    spark-research project new <名字> 新建一个研究项目");
  out("    spark-research help               完整命令列表");
  out("");
}

function info() {
  const daemon = new SparkResearchDaemon();
  const python = daemon.kernelManager.createKernel("python");
  const repl = daemon.kernelManager.createKernel("control_repl");
  const permits: Record<string, readonly string[]> = {};
  for (const key of Object.keys(PERMIT_SETS) as (keyof typeof PERMIT_SETS)[]) {
    permits[key] = PERMIT_SETS[key];
  }
  console.log(
    JSON.stringify(
      {
        version: pkg.version,
        daemon: "ready",
        permits,
        kernels: { python, control_repl: repl },
        api: getApiKey() ? { provider: getApiKey()!.provider, configured: true } : { configured: false },
      },
      null,
      2,
    ),
  );
  daemon.kernelManager.dispose();
}

async function interactive() {
  const auth = getApiKey();
  if (!auth) {
    console.log("❌ 未配置 API Key。运行 spark-research auth 进行配置。");
    process.exitCode = 1;
    return;
  }

  const projects = new ProjectManager();
  const daemon = new SparkResearchDaemon({ projects });
  const orch = new OrchestratorAgent(daemon, { projects });
  const sessionId = `cli_${Date.now()}`;
  const project = orch.projectForSession(sessionId);

  console.log("Spark Research CLI（输入 exit 退出）");
  console.log(`API: ${auth.provider}`);
  console.log(`项目: ${project?.slug ?? "未绑定"}`);
  console.log("可用技能: literature, protein, genomics, chemistry, compute, lab");
  console.log("");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "spark> ",
  });

  rl.prompt();

  for await (const line of rl) {
    const msg = line.trim();
    if (!msg || msg === "exit" || msg === "quit") break;

    try {
      const result = await orch.chat({ sessionId, message: msg });
      console.log(result.response);
      if (result.review && !result.review.approved) {
        console.log(`\n⚠️  Reviewer vetoed: ${result.review.findings.length} finding(s)`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
    rl.prompt();
  }

  rl.close();
  daemon.kernelManager.dispose();
}

async function chatOnce(message: string) {
  const auth = getApiKey();
  if (!auth) {
    console.log("❌ 未配置 API Key。运行 spark-research auth 进行配置。");
    process.exitCode = 1;
    return;
  }

  const projects = new ProjectManager();
  const daemon = new SparkResearchDaemon({ projects });
  const orch = new OrchestratorAgent(daemon, { projects });
  const sessionId = `oneshot_${Date.now()}`;
  try {
    const result = await orch.chat({ sessionId, message });
    console.log(result.response);
    if (result.review && !result.review.approved) {
      console.log(`\n⚠️  Reviewer vetoed: ${result.review.findings.length} finding(s)`);
    }
  } finally {
    daemon.kernelManager.dispose();
  }
}

function main() {
  // config.json 里的非凭据设置补进 env（已有 env 不动）——礼貌头这类在很深的调用栈里
  // 只读 env 的配置靠这一步生效，优先级仍是 env > config.json（P9 配置面收口）。
  applyConfigEnvDefaults();
  // D-6：启动时权限自检——config.json 里可能躺着 LLM API key，发现权限过宽（非 0600）
  // 立即收紧并告警，而不是等下一次 `config set`/`auth` 写入才顺带修复。
  const permCheck = enforceConfigPermissions();
  if (!permCheck.ok && permCheck.warning) {
    console.warn(`⚠️  ${permCheck.warning}`);
  }
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
    case "welcome":
      welcome();
      break;
    case "auth": {
      auth();
      break;
    }
    case "cli":
    case "i":
    case "interactive": {
      interactive();
      break;
    }
    case "chat": {
      const msg = process.argv.slice(3).join(" ");
      if (!msg) {
        console.log("用法: spark-research chat <消息>");
        process.exitCode = 1;
        break;
      }
      chatOnce(msg);
      break;
    }
    case "project": {
      const code = runProjectCommand(process.argv.slice(3));
      if (code !== 0) process.exitCode = code;
      break;
    }
    case "lit":
    case "literature": {
      runLitCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "idea":
    case "ideation": {
      runIdeaCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "exp":
    case "experiment": {
      runExpCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "lab": {
      runLabCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "protein": {
      runProteinCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "conclusion":
    case "conclusions": {
      runConclusionCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "report": {
      runReportCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "review": {
      runReviewCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "config": {
      const code = runConfigCommand(process.argv.slice(3));
      if (code !== 0) process.exitCode = code;
      break;
    }
    case "new": {
      const code = runNewCommand(process.argv.slice(3));
      if (code !== 0) process.exitCode = code;
      break;
    }
    case "capabilities":
    case "caps": {
      runCapabilitiesCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "mcp": {
      // stdio 传输：**绝不能往 stdout 写任何非协议内容**，否则客户端解析 JSON-RPC 会挂。
      // 提示信息一律走 stderr。
      console.error(`Spark Research MCP server v${pkg.version}（stdio）— 暴露 ${MCP_TOOLS.length} 个工具`);
      runMcpStdio().catch((error) => {
        console.error(`MCP server 启动失败: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
      break;
    }
    case "doctor": {
      runDoctorCommand(process.argv.slice(3)).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    case "info":
      info();
      break;
    case "ping":
      console.log("pong");
      break;
    case "server": {
      const auth = getApiKey();
      if (!auth) {
        console.log("⚠️  未配置 API Key，服务将返回错误。运行 spark-research auth 进行配置。");
      }
      const port = Number(process.argv[3]) || 4321;
      // 工作台前端是构建产物，不入 git。缺了就明说该跑什么，而不是让用户
      // 打开一个 503 页面自己猜（API 这时是好的，只有 UI 没有）。
      if (!existsSync(join(DEFAULT_FRONTEND_DIR, "index.html"))) {
        console.log("⚠️  工作台前端尚未构建，Web UI 不可用（API 正常）。先跑一次：bun run build:web");
      }
      const server = startServer(port);
      console.log(`Spark Research server listening at http://127.0.0.1:${server.port}`);
      console.log("Press Ctrl+C to stop");
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    // W1-d：单二进制/npx 分发的实测三条路径之一（另两条是 --help 与 capabilities --json）。
    // 之前完全没有这个 case——裸 `--version` 会落进 default，打印整份 HELP 还 exitCode 1，
    // 对脚本化探测（CI/安装脚本判断版本号）不友好。
    case "--version":
    case "-v":
    case "version":
      console.log(pkg.version);
      break;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

// W1-d：`import.meta.main` 只在这个文件是真正的运行入口时为 true——被
// tests/unit/cli_entry.test.ts `import` 来测 `welcome()` 时是 false，不会把
// `main()`（含 `applyConfigEnvDefaults()`/`enforceConfigPermissions()` 这类真实
// 文件系统副作用）在导入期间跑一遍。真实运行方式（`bun backend/src/index.ts` /
// 编译产物 / npx）不受影响，行为与之前完全一致。
if (import.meta.main) {
  main();
}
