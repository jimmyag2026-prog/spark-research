#!/usr/bin/env bun
import { join } from "path";
import { KimiScienceDaemon } from "./daemon/daemon";
import { PERMIT_SETS } from "./daemon/permissions";

const pkg = await Bun.file(join(import.meta.dir, "../../package.json")).json();

const HELP = `Kimi Science v${pkg.version}
开源科学 Agent 平台：干湿闭环 + 自动化实验室

用法:
  kimi-science             显示欢迎信息
  kimi-science info        模块状态与权限矩阵
  kimi-science ping        健康检查
  kimi-science server      启动 API server（开发中）
  kimi-science help        显示本帮助
`;

function welcome() {
  console.log("");
  console.log("  Kimi Science v" + pkg.version);
  console.log("  开源科学 Agent 平台 — 对标 Claude Science");
  console.log("  Daemon 控制核心 + Kernel 管理器（模块 1/2）已就绪");
  console.log("");
  console.log("  运行 kimi-science help 查看可用命令");
}

function info() {
  const daemon = new KimiScienceDaemon();
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
      },
      null,
      2,
    ),
  );
  daemon.kernelManager.dispose();
}

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
    case "welcome":
      welcome();
      break;
    case "info":
      info();
      break;
    case "ping":
      console.log("pong");
      break;
    case "server":
      console.log("server 尚未实现 — 属于后续模块");
      break;
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
