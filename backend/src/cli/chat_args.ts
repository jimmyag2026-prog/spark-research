// lane β-2 · `spark-research chat` 的旗标解析（USAGE_LOG U9）。
//
// 现场：`index.ts` 的 `case "chat"` 把 `process.argv.slice(3).join(" ")` **整个**当消息。
// 于是 `spark-research chat --help` 是一次要花钱的模型调用（实测挂两分多钟没有输出，
// 被迫 kill）；`chatOnce` 只传 `sessionId + message`，`chat()` 接受的 `model` /
// `budgetUsd` / `allowUnpriced` 一个都没传——**CLI 的 chat 完全没有预算闸**，
// 而 agent 指南写的是「每条会调 LLM 的命令都带 --budget-usd」。
//
// 三条硬规则（顺序就是判据顺序）：
//   ① `--help` / `-h` 优先：见到就只返回 help，一个字都不发给模型。
//   ② `--` 之后全部当消息：消息本身以 `-` 开头时的唯一出路（"--model" 这种字面量也能发）。
//   ③ **未识别的 `--xxx` 报错退出**，而不是塞进消息——U9 的根因就是「认不出的东西
//      默认当消息」。宁可拒绝，不要猜（与 β-3 对未登记模型名的态度是同一条）。
//
// 这里只做解析，不碰 I/O、不 import 任何重模块：`tests/unit/gate_help_no_llm.test.ts`
// 要能在不起 daemon 的前提下单测它。

export interface ChatArgs {
  /** `--help` / `-h`：调用方打印 CHAT_HELP 后直接退出，不许有任何副作用。 */
  help: boolean;
  /** 拼好的消息（`--` 之后的部分原样保留，含以 `-` 开头的 token）。 */
  message: string;
  /** `--model <name>`：透传给 `orch.chat({ model })`（U10 修好之后它才真的生效）。 */
  model?: string;
  /** `--budget-usd <n>`：透传给 `orch.chat({ budgetUsd })`——CLI chat 此前没有预算闸。 */
  budgetUsd?: number;
  /** `--allow-unpriced`：允许无单价模型在预算闸下放行（与其它子命令同名同义）。 */
  allowUnpriced?: boolean;
  /** `--project <slug>`：显式指定项目（全局指针在并发会话下会互相改写）。 */
  project?: string;
  /** 解析失败的原因。非空时调用方打印它 + CHAT_HELP 并以 1 退出，**不发任何请求**。 */
  error?: string;
}

export const CHAT_HELP = `用法:
  spark-research chat [选项] <消息>

选项:
  --model <name>        本次会话用哪个模型（不给则用 config.json 的 defaultModel）
  --budget-usd <n>      本次会话的预算上限（美元）。超出则拒绝调用，不会静默继续
  --allow-unpriced      允许调用单价表里查不到价的模型（这些调用在 usage 里标 unpriced）
  --project <slug>      显式指定项目（并发多会话时务必带上：当前项目指针是全局的）
  --help, -h            显示本帮助（不产生任何模型调用）
  --                    其后的全部内容原样当作消息（消息以 - 开头时用它）

例:
  spark-research chat "帮我梳理一下这批文献的共同假设"
  spark-research chat --model z-ai/glm-5.3-flash --budget-usd 0.5 --project my-proj "下一步做什么实验"
`;

/** 需要取值的旗标。其余 `--xxx` 一律视为未识别（③）。 */
const VALUE_FLAGS = new Set(["model", "budget-usd", "project"]);
/** 布尔旗标。 */
const BOOL_FLAGS = new Set(["allow-unpriced"]);

export function parseChatArgs(argv: readonly string[]): ChatArgs {
  const result: ChatArgs = { help: false, message: "" };
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    // ① help 优先：哪怕后面还有别的东西，也只打印帮助。
    if (arg === "--help" || arg === "-h" || arg === "help") {
      return { help: true, message: "" };
    }

    // ② `--` 之后全是消息
    if (arg === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }

    // `--name=value` 与 `--name value` 两种写法都认
    const eq = arg.indexOf("=");
    const name = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).trim();
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;

    if (BOOL_FLAGS.has(name)) {
      if (inlineValue !== undefined && inlineValue !== "true" && inlineValue !== "false") {
        return { help: false, message: "", error: `--${name} 是开关，不接受值（收到 '${inlineValue}'）` };
      }
      if (name === "allow-unpriced") result.allowUnpriced = inlineValue !== "false";
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        value = argv[i + 1];
        i++;
      }
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { help: false, message: "", error: `--${name} 需要一个值` };
      }
      if (name === "model") result.model = value;
      else if (name === "project") result.project = value;
      else {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          return { help: false, message: "", error: `--budget-usd 必须是非负数字，收到 '${value}'` };
        }
        result.budgetUsd = n;
      }
      continue;
    }

    // ③ 认不出的旗标：报错，**不塞进消息**（U9 的根因）
    return {
      help: false,
      message: "",
      error: `未知选项 '--${name}'。消息本身以 -- 开头时，请用 'spark-research chat -- <消息>'。`,
    };
  }

  result.message = words.join(" ").trim();
  return result;
}
