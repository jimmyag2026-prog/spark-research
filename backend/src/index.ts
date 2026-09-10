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
import { runChemCommand } from "./chem/cli";
import { runDoctorCommand } from "./doctor/cli";
import { runReviewCommand } from "./reviewer/cli";
// V37 收口：provider → 鉴权环境变量名的**单一真源**是 `llm/router.ts` 的 `ADAPTERS`，
// `providers/registry.ts` 的 `PROVIDER_API_KEY_ENV` 从它派生导出。`doctor` /
// `capabilities` / `onboarding/providers.ts` 三处都消费这张表——此文件此前有一份
// 手写的 `KEY_NAMES`（只列 kimi + openrouter 两个），是 P11 收口过的同一类手工副本
// 漂移在这个消费方长出的第二现场（见 docs/BACKLOG.md V37 / docs/devlog/W5-1-g.md）。
// 该副本已删除：`getApiKey()`/`auth()` 都直接从这张真源表派生，不许再在本文件里
// 重新声明一份 "provider: \"XXX_API_KEY\"" 形状的字面量
// （tests/unit/auth_key_source.test.ts 的门禁断言钉死这一点）。
import { PROVIDER_API_KEY_ENV } from "./llm/providers/registry";
// W2-d（B-b/B-c）：向导 + 离线 demo。所有权在 backend/src/onboarding/**；
// 这里只加两个 case 分支接进去，不动零参数（welcome）行为（W1-d 所有权）。
import { runInit } from "./onboarding/init";
import { runDemo } from "./onboarding/demo";
// W2-c（P15）：扩展装载与 ext verify。所有权在 backend/src/extensions/**。
import { runExtCommand } from "./extensions/cli";
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
  spark-research ext         扩展装载 + 契约验收（list / verify / load / grant / revoke）
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

export interface Config {
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

// 只是展示用的友好标签——**不是**「provider → 鉴权环境变量名」的映射（那张表
// 唯一真源是上面导入的 `PROVIDER_API_KEY_ENV`）。值不是 `*_API_KEY` 形状的字符串，
// 门禁断言（tests/unit/auth_key_source.test.ts）不会把这张表误判成手写副本。
// 缺条目时回退显示 provider id 本身（见 `providerLabel`），不会漏掉未来新增的 provider。
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  kimi: "Kimi (api.moonshot.ai) - 国内访问快",
  openrouter: "OpenRouter (openrouter.ai) - 支持多个模型",
  anthropic: "Anthropic（Claude 原生 API）",
  openai: "OpenAI（GPT）",
  deepseek: "DeepSeek",
  qwen: "Qwen / DashScope（阿里云）",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export function getApiKey(
  options: { env?: Record<string, string | undefined>; config?: Config } = {},
): { provider: string; key: string } | null {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig();

  // 收口补（W5-1 η 之后）：**先认用户显式选的 `defaultProvider`**。
  //
  // 在这之前它是一个「只写不读」的设置——`auth()` 让用户挑（`:223` 写盘）、
  // `config set defaultProvider` 能设、`auth` 还回显它，但**没有任何代码用它来选
  // provider**：这里只是按声明顺序取第一个有 key 的。用户明明选了 kimi，只要
  // `OPENROUTER_API_KEY` 也在，走的就是 openrouter，而且不留任何痕迹。
  //
  // 本项目栽过 6 次「建好了但没有生产调用方」，这是第 7 次，只不过藏在配置项里
  // 而不是模块里。η 把优先级从写死的 `[kimi, openrouter]` 换成 ADAPTERS 声明顺序
  // 之后，这个潜伏的 bug 才真的会咬人——所以在收口一并修掉，而不是记进 BACKLOG。
  const preferred = config.defaultProvider;
  const order = preferred && preferred in PROVIDER_API_KEY_ENV
    ? [preferred, ...Object.keys(PROVIDER_API_KEY_ENV).filter((p) => p !== preferred)]
    : Object.keys(PROVIDER_API_KEY_ENV);

  for (const provider of order) {
    const envName = PROVIDER_API_KEY_ENV[provider]!;
    const envKey = env[envName];
    if (envKey) return { provider, key: envKey };
    const configKey = config[envName];
    if (configKey) return { provider, key: configKey };
  }
  return null;
}

// V37：`getApiKey()` 是 env 优先的（上面），但 `auth()` 改之前显示配置时**只读
// config 文件**——key 只在 env 里时，`getApiKey()` 其实能拿到，`auth` 却报「未设置」，
// 与同一份 key 在 `config list`/`doctor` 下的正确显示矛盾。这个类型把「配没配」
// 和「从哪配的」分开表达，`auth()` 用它来标明来源，不再让用户靠猜。
export type AuthKeySource = "env" | "config" | "both" | null;

export interface AuthStatusEntry {
  provider: string;
  envVar: string;
  configured: boolean;
  source: AuthKeySource;
}

/**
 * 每个已实装 provider 的当前配置状态：env 与 config 文件都看，并标明来源。
 * 导出供测试直接 DI（不依赖真实 stdin/交互终端），`auth()` 本身只是把这份结果打印出来。
 */
export function authStatus(
  options: { env?: Record<string, string | undefined>; config?: Config } = {},
): AuthStatusEntry[] {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig();
  return Object.entries(PROVIDER_API_KEY_ENV).map(([provider, envVar]) => {
    const inEnv = Boolean(env[envVar]);
    const inConfig = Boolean(config[envVar]);
    const source: AuthKeySource = inEnv && inConfig ? "both" : inEnv ? "env" : inConfig ? "config" : null;
    return { provider, envVar, configured: inEnv || inConfig, source };
  });
}

function describeAuthSource(source: AuthKeySource): string {
  switch (source) {
    case "both":
      return "已设置（环境变量优先；config 文件里也存了一份）";
    case "env":
      return "已设置（来源：环境变量）";
    case "config":
      return "已设置（来源：config 文件）";
    default:
      return "未设置";
  }
}

async function auth() {
  const config = loadConfig();

  console.log("Spark Research API Key 配置\n");
  console.log("当前配置:");
  for (const entry of authStatus({ config })) {
    console.log(`  ${entry.envVar}: ${describeAuthSource(entry.source)}`);
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
    const providerIds = Object.keys(PROVIDER_API_KEY_ENV);
    console.log("选择 Provider:");
    providerIds.forEach((id, i) => {
      console.log(`  ${i + 1}. ${providerLabel(id)}`);
    });
    const choice = await question(`选择 [1-${providerIds.length}]: `);

    const provider = providerIds[Number(choice) - 1];
    if (!provider) {
      console.log("无效选择");
      return;
    }

    const envName = PROVIDER_API_KEY_ENV[provider]!;
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
  console.log("可用技能: literature, protein, genomics, chemistry, lab");
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
    // §三·补.3：lane γ 的 chem 分支由收口接上（γ 持有 chem/**，η 持有本文件，
    // 两条 lane 不许写同一个文件——这一行是分界处，接线是收口的活）。
    case "chem": {
      runChemCommand(process.argv.slice(3)).then((code) => {
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
    case "ext": {
      runExtCommand(process.argv.slice(3)).then((code) => {
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
    // W2-d：init 向导（建项目 → 探测 provider/本地 Ollama → 一次真实文献检索 →
    // 证据图 → 下一步命令）。参数极简，全部可选：不传 slug 就用时间戳生成一个。
    case "init": {
      const initArgs = process.argv.slice(3);
      const initFlags: Record<string, string> = {};
      const initPositional: string[] = [];
      for (let i = 0; i < initArgs.length; i++) {
        const arg = initArgs[i]!;
        if (arg.startsWith("--")) {
          const name = arg.slice(2);
          const next = initArgs[i + 1];
          if (next !== undefined && !next.startsWith("--")) {
            initFlags[name] = next;
            i++;
          }
        } else {
          initPositional.push(arg);
        }
      }
      runInit({
        slug: initPositional[0],
        query: initFlags.query,
        name: initFlags.name,
        description: initFlags.description,
      }).then((code) => {
        if (code !== 0) process.exitCode = code;
      });
      break;
    }
    // W2-d：离线示例项目（零网络、零 API key，fixture 驱动的完整研究线索）。
    case "demo": {
      const demoArgs = process.argv.slice(3);
      const outIndex = demoArgs.indexOf("--out");
      const outFile = outIndex >= 0 ? demoArgs[outIndex + 1] : undefined;
      runDemo({ outFile }).then((code) => {
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
