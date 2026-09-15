import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_HELP, parseChatArgs } from "../../backend/src/cli/chat_args";
import { buildContract } from "../../backend/src/contract/index";

// 闸门 · 「`--help` 不产生任何模型调用」（USAGE_LOG U9）—— lane β-2。
//
// 现场：`spark-research chat --help` 挂了两分多钟没有任何输出，被迫 kill——
// `case "chat"` 把 `process.argv.slice(3).join(" ")` 整个当消息，`--help` 非空于是
// 成了消息本身，被原样发给模型。**误打一次就是几分钱加两分钟。**
// CHANGELOG 里 V128 记的是「`--help` 无副作用」，那条修复没覆盖到 `chat`。
//
// **为什么是枚举而不是手写清单**：V128 修过一次同名问题却漏了 `chat`，说明靠人记不住。
// 本门禁的命令清单来自 `contract --json` 的真源（`contract/cli_registry.ts` 的
// `CLI_COMMANDS` + 从各模块 HELP 文本提取的子命令），**新增一个命令会自动被纳入**。
// 唯一手写的是下面两张必须带理由的登记表，且都有陈旧检查。
//
// 判据：每个命令起一个真进程跑 `<cmd> [sub] --help`，用 `--preload` 在进程里把
// `LLMRouter.prototype.call` 换成记录器（写一行到 marker 文件并抛错）。
// marker 里出现该命令 = 这次 `--help` 发起了模型调用 = 红。

const REPO_ROOT = join(import.meta.dir, "../..");
const INDEX_TS = join(REPO_ROOT, "backend/src/index.ts");
const ROUTER_TS = join(REPO_ROOT, "backend/src/llm/router.ts");

/**
 * 不跑 `--help` 的命令：常驻进程 / 交互式向导。它们**不是被豁免「--help 无副作用」**，
 * 而是这条判据（起进程、等它自己退出）对它们不适用——每条都必须写清为什么。
 */
const SKIP_NON_TERMINATING: Record<string, string> = {
  cli: "交互式 readline 会话，`--help` 不会让它退出（判据要求进程自行结束）",
  mcp: "MCP stdio server，按协议常驻等待客户端，不会退出",
  server: "HTTP server，启动后常驻监听",
  init: "首次向导：会真的建项目、探测 provider（含网络），不是 help 路径",
  demo: "离线 demo：会跑完整条研究线程，耗时以分钟计，不是 help 路径",
};

/**
 * **等收口**：`--help` 目前确实会调模型，修复落在禁止文件里。
 * 每条都必须写清「等谁接什么」。本表是**自退役**的——下面「登记不许陈旧」那条断言
 * 要求登记的命令此刻必须真的调了模型；收口把它修好之后这条会红，逼着把登记删掉。
 */
const HELP_LLM_PENDING: Record<string, string> = {
};

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 从运行时契约枚举全部命令与子命令（真源 = contract/cli_registry.ts）。 */
async function enumerateCommands(): Promise<string[][]> {
  const contract = await buildContract();
  const out: string[][] = [];
  for (const cmd of contract.cli.commands) {
    if (SKIP_NON_TERMINATING[cmd.command]) continue;
    out.push([cmd.command]);
    const subs = new Set<string>();
    for (const usage of cmd.usages) if (usage.subcommand) subs.add(usage.subcommand);
    for (const sub of [...subs].sort()) out.push([cmd.command, sub]);
  }
  return out;
}

function writeSpy(dir: string): string {
  const path = join(dir, "llm_spy.ts");
  writeFileSync(
    path,
    [
      `import { appendFileSync } from "node:fs";`,
      `import { LLMRouter } from ${JSON.stringify(ROUTER_TS)};`,
      `const marker = process.env.SPARK_LLM_SPY_FILE;`,
      `const label = process.env.SPARK_LLM_SPY_CMD ?? "?";`,
      `LLMRouter.prototype.call = async function (_messages, modelOrOptions = {}) {`,
      `  const model = typeof modelOrOptions === "string" ? modelOrOptions : (modelOrOptions?.model ?? "(default)");`,
      `  if (marker) appendFileSync(marker, label + "\\t" + model + "\\n");`,
      `  throw new Error("GATE_HELP_NO_LLM: --help 期间发起了模型调用");`,
      `};`,
    ].join("\n"),
    "utf8",
  );
  return path;
}

interface RunResult {
  label: string;
  timedOut: boolean;
  calledLlm: boolean;
}

const PER_COMMAND_TIMEOUT_MS = 30_000;

async function runHelp(args: string[], spy: string, dataDir: string, markerDir: string): Promise<RunResult> {
  const label = args.join(" ");
  const marker = join(markerDir, `${label.replace(/\W+/g, "_")}.tsv`);
  writeFileSync(marker, "", "utf8");
  const proc = Bun.spawn({
    cmd: ["bun", "--preload", spy, INDEX_TS, ...args, "--help"],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SPARK_RESEARCH_DATA_DIR: dataDir,
      SPARK_LLM_SPY_FILE: marker,
      SPARK_LLM_SPY_CMD: label,
      // key 必须有：`chat` 在没有 key 时会提前 return，那样即使没修好也「碰巧」不调模型，
      // 门禁就测不出东西了（假绿）。这是占位值，不会被真的发出去——spy 在发请求前就拦住。
      KIMI_API_KEY: "placeholder-not-a-real-key",
      no_proxy: "*",
      NO_PROXY: "*",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, PER_COMMAND_TIMEOUT_MS);
  await proc.exited;
  clearTimeout(timer);
  return { label, timedOut, calledLlm: readFileSync(marker, "utf8").trim().length > 0 };
}

async function runAll(commands: string[][]): Promise<RunResult[]> {
  const spyDir = tmpDir("gate-help-spy-");
  const spy = writeSpy(spyDir);
  const dataDir = tmpDir("gate-help-data-");
  const markerDir = tmpDir("gate-help-marker-");
  const results: RunResult[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < commands.length; i += CONCURRENCY) {
    const batch = commands.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map((args) => runHelp(args, spy, dataDir, markerDir)))));
  }
  return results;
}

const commands = await enumerateCommands();
const results = await runAll(commands);
const byLabel = new Map(results.map((r) => [r.label, r]));

describe("闸门 · 每个子命令的 --help 都不产生模型调用（U9）", () => {
  test(
    "命令清单来自 contract（真源），不是手写：至少覆盖 chat / idea / lit read / lit review",
    () => {
      const labels = results.map((r) => r.label);
      expect(labels).toContain("chat");
      expect(labels).toContain("idea");
      expect(labels).toContain("lit read");
      expect(labels).toContain("lit review");
      expect(labels.length).toBeGreaterThan(50);
    },
    PER_COMMAND_TIMEOUT_MS,
  );

  test("每个 --help 都必须自己退出（挂住 = 和 U9 现场一样的症状）", () => {
    const hung = results.filter((r) => r.timedOut).map((r) => r.label);
    expect(hung, `这些命令的 --help 在 ${PER_COMMAND_TIMEOUT_MS}ms 内没有退出：\n  ${hung.join("\n  ")}`).toEqual([]);
  });

  test("LLMRouter.call 零调用（HELP_LLM_PENDING 里登记的除外，且必须带理由）", () => {
    const offenders = results
      .filter((r) => r.calledLlm && !HELP_LLM_PENDING[r.label]?.trim())
      .map((r) => r.label);
    expect(
      offenders,
      `这些子命令的 \`--help\` 发起了模型调用——误打一次就是真金白银加几分钟等待（U9）：\n  ${offenders.join("\n  ")}\n` +
        `修法：在拼消息/干活之前先解析旗标，见 backend/src/cli/chat_args.ts。`,
    ).toEqual([]);
  });

  test("登记不许陈旧：HELP_LLM_PENDING 里的命令此刻必须真的还在调模型（修好了就删掉本条登记）", () => {
    const stale = Object.keys(HELP_LLM_PENDING).filter((label) => !byLabel.get(label)?.calledLlm);
    expect(
      stale,
      `这些命令的 --help 已经不调模型了，请从 HELP_LLM_PENDING 删除（收口应用 β-2 diff 后就是这一刻）：\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  test("SKIP_NON_TERMINATING 的每一条都必须是真实存在的命令且带理由", async () => {
    const contract = await buildContract();
    const known = new Set(contract.cli.commands.map((c) => c.command));
    for (const [cmd, reason] of Object.entries(SKIP_NON_TERMINATING)) {
      expect(known.has(cmd), `SKIP_NON_TERMINATING 里的 '${cmd}' 不是一个真实命令`).toBe(true);
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("β-2 · parseChatArgs（U9 的修法本体）", () => {
  test("--help / -h 优先：只返回 help，消息为空（一个字都不发给模型）", () => {
    expect(parseChatArgs(["--help"])).toEqual({ help: true, message: "" });
    expect(parseChatArgs(["-h"])).toEqual({ help: true, message: "" });
    // 混在别的东西里也一样——U9 现场就是 `chat --help` 被当成消息发出去
    expect(parseChatArgs(["帮我看看", "--help"]).help).toBe(true);
    expect(parseChatArgs(["--model", "kimi-k3", "--help"]).help).toBe(true);
  });

  test("四个参数都能透传（chatOnce 此前一个都没传：CLI chat 完全没有预算闸）", () => {
    const args = parseChatArgs([
      "--model",
      "z-ai/glm-5.3-flash",
      "--budget-usd",
      "0.5",
      "--allow-unpriced",
      "--project",
      "my-proj",
      "下一步做什么实验",
    ]);
    expect(args).toEqual({
      help: false,
      message: "下一步做什么实验",
      model: "z-ai/glm-5.3-flash",
      budgetUsd: 0.5,
      allowUnpriced: true,
      project: "my-proj",
    });
  });

  test("--name=value 写法等价", () => {
    const args = parseChatArgs(["--model=kimi-k3", "--budget-usd=1.25", "问题"]);
    expect(args.model).toBe("kimi-k3");
    expect(args.budgetUsd).toBe(1.25);
    expect(args.message).toBe("问题");
  });

  test("`--` 之后全部当消息（消息本身以 - 开头时的唯一出路）", () => {
    const args = parseChatArgs(["--model", "kimi-k3", "--", "--help", "这句话本身要发出去"]);
    expect(args.help).toBe(false);
    expect(args.model).toBe("kimi-k3");
    expect(args.message).toBe("--help 这句话本身要发出去");
  });

  test("未识别的 --xxx 报错，**不塞进消息**（U9 的根因就是「认不出的默认当消息」）", () => {
    const args = parseChatArgs(["--modle", "kimi-k3", "问题"]);
    expect(args.error).toContain("未知选项");
    expect(args.message).toBe("");
    expect(args.help).toBe(false);
  });

  test("旗标缺值 / 预算不是数字 → 报错而不是猜", () => {
    expect(parseChatArgs(["--model"]).error).toContain("--model 需要一个值");
    expect(parseChatArgs(["--budget-usd", "很多钱", "问题"]).error).toContain("非负数字");
    expect(parseChatArgs(["--budget-usd", "-1", "问题"]).error).toContain("非负数字");
  });

  test("多个位置参数按空格拼回消息（与现行 argv.join(' ') 行为一致）", () => {
    expect(parseChatArgs(["帮我", "梳理", "这批文献"]).message).toBe("帮我 梳理 这批文献");
    expect(parseChatArgs([]).message).toBe("");
  });

  test("CHAT_HELP 里必须写明这四个旗标与 --（AD-12：帮助文案不许声称没做到的能力）", () => {
    for (const flag of ["--model", "--budget-usd", "--allow-unpriced", "--project", "--help"]) {
      expect(CHAT_HELP).toContain(flag);
    }
  });
});
