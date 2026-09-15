import { CredentialStore } from "../daemon/credentials";
import { registerSecrets } from "../llm/types";
import { readHidden, type HiddenInputStreams } from "./hidden_input";

// γ-5（v0.9 · U6）：`spark-research auth --connector <id>`。
//
// 此前 `auth` 只管 **provider** 的 LLM API key（写 config.json）；connector 的 key
// （AMiner / Semantic Scholar / Modal …）根本没有录入命令——`lit sources` 只会说
// 「未配置」，然后让人自己去手写 `~/.spark-research/credentials.json`。
// 数据源面板显示的下一步就是这条命令，所以它必须真的存在、真的能把 key 写进去。
//
// **与 HTTP 写入路径共用同一个 `CredentialStore`**（AD-18 的前提之一）：
// 两条路径各写一份存储，迟早出现「网页端说配了、CLI 说没配」。这里不另起炉灶。

export interface AuthConnectorDeps {
  /** 注入便于单测；默认走真实 `~/.spark-research/credentials.json`。 */
  store?: CredentialStore;
  /** 数据根目录（测试注入 mkdtemp）。 */
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** 不回显读入口；测试注入一个假的。 */
  prompt?: (prompt: string) => Promise<string>;
  streams?: HiddenInputStreams;
}

export const AUTH_CONNECTOR_HELP = `用法: spark-research auth --connector <id> [--field <name>]...

  给一个 connector 录入凭据（**输入不回显**）。值写进 ~/.spark-research/credentials.json（0600）。

  --field <name>   要录入的字段名，可重复；不给则默认 api_key
                   （Modal 用 --field tokenId --field tokenSecret）

  例：
    spark-research auth --connector aminer
    spark-research auth --connector modal --field tokenId --field tokenSecret

  已经配过的字段会显示「已设置」，重新录入会覆盖；**值永远不会被打印出来**。
  想删掉某个 connector 的凭据：把它从 credentials.json 里删掉，或在网页端「凭据」面板删。
`;

export const DEFAULT_CREDENTIAL_FIELD = "api_key";

export interface AuthConnectorArgs {
  connector: string | null;
  fields: string[];
  help: boolean;
}

/** 解析 `auth` 的 argv（已经去掉 `auth` 本身）。 */
export function parseAuthConnectorArgs(argv: string[]): AuthConnectorArgs {
  const args: AuthConnectorArgs = { connector: null, fields: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h" || arg === "help") args.help = true;
    else if (arg === "--connector" && argv[i + 1]) args.connector = argv[++i]!;
    else if (arg === "--field" && argv[i + 1]) args.fields.push(argv[++i]!);
  }
  if (args.fields.length === 0) args.fields = [DEFAULT_CREDENTIAL_FIELD];
  return args;
}

/**
 * 录入一个 connector 的凭据。返回进程退出码。
 *
 * 全部字段都留空 = 什么都不改（不是「清空」）——空回车最常见的意思是「我按错了」，
 * 把它解释成删除会让人一次误操作丢掉 key。要删请显式去删。
 */
export async function runAuthConnector(argv: string[], deps: AuthConnectorDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const args = parseAuthConnectorArgs(argv);

  if (args.help) {
    out(AUTH_CONNECTOR_HELP);
    return 0;
  }
  if (!args.connector) {
    err("缺少 --connector <id>");
    err("下一步：spark-research auth --connector <id>（可用的 id 见 `spark-research capabilities`）");
    return 1;
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(args.connector)) {
    err(`connector id '${args.connector}' 不合法`);
    err("下一步：只能用字母、数字、`-`、`_`，且以字母或数字开头");
    return 1;
  }

  const store = deps.store ?? new CredentialStore(deps.root ? { root: deps.root } : {});
  const existing = store.describe(args.connector);

  out(`为 connector '${args.connector}' 录入凭据（输入不回显）`);
  if (existing) out(`  已设置的字段：${existing.keys.join(", ")}`);

  const prompt =
    deps.prompt ??
    ((label: string) =>
      readHidden(label, deps.streams ?? { input: process.stdin, output: process.stdout }));

  const values: Record<string, string> = {};
  for (const field of args.fields) {
    const marker = existing?.keys.includes(field) ? "（已设置，回车跳过）" : "";
    const value = (await prompt(`  ${field}${marker}: `)).trim();
    if (value !== "") values[field] = value;
  }

  if (Object.keys(values).length === 0) {
    out("没有输入任何值，未做改动。");
    return 0;
  }

  // 合并既有字段：只重录 tokenSecret 不该把 tokenId 清掉。
  const merged = { ...(store.get(args.connector) ?? {}), ...values };
  const meta = store.set(args.connector, merged);

  // AD-18 ④：CLI 这条写入路径同样登记脱敏——两条路径的约束必须一样，
  // 否则「从终端配的 key 会出现在错误消息里、从网页配的不会」这种事就成立了。
  registerSecrets(values);

  const permission = store.checkPermissions();
  // **只打字段名，不打值**（V115 起 auth 连回显都掐掉了，落地后更不能打印）。
  out(`✅ 已写入 ${store.path}`);
  out(`   字段：${meta.keys.join(", ")}（权限 ${permission.mode}）`);
  if (!permission.ok && permission.warning) err(permission.warning);
  out(`   下一步：\`spark-research capabilities\` 里这个源应当已经显示为可用`);
  return 0;
}
