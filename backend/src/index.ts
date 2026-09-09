#!/usr/bin/env bun
import { join } from "path";
import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { SparkResearchDaemon } from "./daemon/daemon";
import { PERMIT_SETS } from "./daemon/permissions";
import { OrchestratorAgent } from "./agents/orchestrator";
import { startServer } from "./server/server";
import { ProjectManager } from "./project/manager";
import { runProjectCommand } from "./project/cli";
import { runLitCommand } from "./literature/cli";
import { runIdeaCommand } from "./ideation/cli";
import { runExpCommand } from "./experiment/cli";
import { runLabCommand } from "./lab/cli";

const pkg = await Bun.file(join(import.meta.dir, "../../package.json")).json();

const HELP = `Spark Research v${pkg.version}
开源科学 Agent 平台：干湿闭环 + 自动化实验室

用法:
  spark-research             交互式 CLI（类似 opencode）
  spark-research auth        配置 API Key
  spark-research project     项目管理（new / list / open / archive）
  spark-research lit         文献域（search / add / list / pdf / read / review / export / sources）
  spark-research idea        思路库（new / list / check —— Co-explore + Novelty check）
  spark-research exp         干实验闭环（new / run / status / list / platforms）
  spark-research lab         湿实验（compile / approve / reject / simulate / status / backends）
  spark-research info        模块状态与权限矩阵
  spark-research ping        健康检查
  spark-research server      启动 Web 服务（默认 4321）
  spark-research chat <msg>  单次对话
  spark-research help        显示本帮助
`;

const CONFIG_DIR = join(homedir(), ".spark-research");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

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
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
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
    console.log("\n✅ 配置已保存到 ~/.spark-research/config.json");
  } finally {
    rl.close();
  }
}

function welcome() {
  const auth = getApiKey();
  console.log("");
  console.log("  Spark Research v" + pkg.version);
  console.log("  开源科学 Agent 平台 — 对标 Claude Science");
  console.log("");
  if (auth) {
    console.log(`  API: ${auth.provider} (已配置)`);
  } else {
    console.log("  API: 未配置 — 运行 spark-research auth 设置");
  }
  console.log("");
  console.log("  运行 spark-research help 查看可用命令");
  console.log("");
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
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main();
