import { assertKnownModel } from "../llm/providers/registry";
import {
  CONFIG_SETTINGS,
  configPath,
  loadConfig,
  resolveAll,
  resolveSetting,
  saveConfig,
  settingSpec,
  type ConfigOptions,
  validateSetting,
  SettingValidationError,
} from "./index";

export const CONFIG_HELP = `用法:
  spark-research config list [--json]        列出全部配置项（当前值 / 来源 / 改了影响什么）
  spark-research config get <key>            读取单项
  spark-research config set <key> <value>    写入 config.json
  spark-research config unset <key>          删除 config.json 里的该项（回落到默认）
  spark-research config path                 打印 config.json 路径

优先级：环境变量 > config.json > 默认值。
凭据（*_API_KEY）与设置同文件，但只显示「已设置 / 未设置」，值永不打印。
`;

export interface ConfigCliDeps extends ConfigOptions {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

// 中文按两列宽计：表格不对齐会让「来源」那一列看起来像随机缩进。
function width(text: string): number {
  let visible = 0;
  for (const ch of text) visible += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return visible;
}

function pad(text: string, target: number): string {
  return text + " ".repeat(Math.max(1, target - width(text)));
}

// δ-3（V163）：按**显示宽度**截断（CJK 算 2），超长时以 `…` 收尾。`…` 自身占 1 列，
// 所以留给正文的预算是 max-1。宽度口径与 `width()` 同一份，不另写一套。
export function ellipsize(text: string, max: number): string {
  if (width(text) <= max) return text;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

export function runConfigCommand(args: string[], deps: ConfigCliDeps = {}): number {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const options: ConfigOptions = { root: deps.root, env: deps.env };
  const [sub, ...rest] = args;
  const json = rest.includes("--json") || args.includes("--json");

  switch (sub) {
    case undefined:
    case "list":
    case "ls": {
      const resolved = resolveAll(options);
      if (json) {
        out(
          JSON.stringify(
            {
              path: configPath(options),
              settings: resolved.map((r) => ({
                key: r.key,
                value: r.spec.secret ? null : r.value,
                source: r.source,
                configured: r.configured,
                secret: Boolean(r.spec.secret),
                envVar: r.spec.envVar,
                type: r.spec.type,
                allowed: r.spec.allowed ?? null,
                summary: r.spec.summary,
                effect: r.spec.effect,
              })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      out(`配置文件: ${configPath(options)}`);
      out("");
      out(`${pad("键", 22)}${pad("当前值", 34)}${pad("来源", 10)}说明`);
      out("─".repeat(100));
      for (const r of resolved) {
        const shown = r.spec.secret
          ? r.configured
            ? "（已设置）"
            : "（未设置）"
          : r.value === null
            ? "—"
            : String(r.value);
        // δ-3（V163）：截断要**看得出来被截断了**。原来是裸 slice(0,32)，一个 60 字符的
        // originAllowlist 被砍成 32 字符照样打印成一个完整的值，用户据此以为配置就是这样——
        // 诊断输出撒的谎比不输出更贵。超长时留 31 字符 + `…`，总宽仍是 32。
        out(`${pad(r.key, 22)}${pad(ellipsize(shown, 32), 34)}${pad(r.source, 10)}${r.spec.summary}`);
      }
      out("");
      out("改了影响什么：spark-research config get <key>，或见 docs/EXTENDING.md 第六节。");
      return 0;
    }
    case "get": {
      const key = rest[0];
      if (!key) {
        err("用法: spark-research config get <key>");
        return 1;
      }
      let resolved;
      try {
        resolved = resolveSetting(key, options);
      } catch (error) {
        err(error instanceof Error ? error.message : String(error));
        return 1;
      }
      if (json) {
        out(
          JSON.stringify(
            {
              key: resolved.key,
              value: resolved.spec.secret ? null : resolved.value,
              source: resolved.source,
              configured: resolved.configured,
              secret: Boolean(resolved.spec.secret),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      out(`${resolved.key}`);
      out(`  当前值: ${resolved.spec.secret ? (resolved.configured ? "（已设置，值不打印）" : "（未设置）") : (resolved.value ?? "—")}`);
      out(`  来源:   ${resolved.source}${resolved.spec.envVar ? `（环境变量 ${resolved.spec.envVar} 可覆盖）` : ""}`);
      if (resolved.spec.allowed) out(`  取值:   ${resolved.spec.allowed.join(" / ")}`);
      out(`  说明:   ${resolved.spec.summary}`);
      out(`  影响:   ${resolved.spec.effect}`);
      return 0;
    }
    case "set": {
      const key = rest[0];
      const value = rest[1];
      if (!key || value === undefined) {
        err("用法: spark-research config set <key> <value>");
        return 1;
      }
      const spec = settingSpec(key);
      if (!spec) {
        err(`未知配置项 '${key}'（可用：${CONFIG_SETTINGS.map((s) => s.key).join(", ")}）`);
        return 1;
      }
      // U23（v0.9 R6 P0 / 安全）：凭据不走 config set——命令行参数会进 shell 历史与 ps，
      // 这正是「凭据永不进命令行」要防的。HTTP 那一侧早就 403 了，CLI 这一侧此前却照单全收。
      if (spec.secret) {
        err(`'${key}' 是凭据，不能用 config set 写入（命令行参数会留在 shell 历史与 ps 输出里）。`);
        err(`下一步：spark-research auth（交互录入，不回显），或在 shell 里 export ${spec.envVar}=…（只对当前 shell 生效）。`);
        return 1;
      }
      if (spec.key === "dataDir") {
        err("dataDir 只能用环境变量 SPARK_RESEARCH_DATA_DIR 设置——它决定 config.json 自己在哪里。");
        return 1;
      }
      // 值的校验只有一份（validateSetting）：类型、枚举、正整数、下限（U22）——与设置面 HTTP 写路径同一判据。
      let validated: string | number;
      try {
        validated = validateSetting(key, value);
      } catch (error) {
        if (error instanceof SettingValidationError) {
          err(`${error.message}。下一步：${error.nextStep}`);
          return 1;
        }
        throw error;
      }
      // β-3（U5「顺带」那条）：模型名写入时就校验，而不是等真正调用时才炸。
      // 判据只有一份——`registry.ts` 的 `assertKnownModel()`（router 的 providerForModel
      // 与 lane γ 的设置面 HTTP 路由调的是同一个函数），这里不另写规则。
      // `embeddingModel` 不在此列：它查的是另一张表（EMBEDDING_PRICING），模型名空间不同。
      if (spec.key === "defaultModel" || spec.key.startsWith("subAgentModel_")) {
        let known;
        try {
          known = assertKnownModel(value);
        } catch (error) {
          err(error instanceof Error ? error.message : String(error));
          return 1;
        }
        // 关键词兜底命中不拒绝（与 providerForModel 同口径，否则 CLI 比运行期还严，
        // 会出现「配不进去、但直接调用能跑」的怪事），但必须当着用户的面说出来：
        // 路由与计价都可能不对，这正是 U5 证据四那个坑（kimi-k2.6 / moonshotai/kimi-k2.6）。
        if (known.kind === "keyword") {
          out(`⚠️  '${value}' 未显式登记，按关键词判给 provider ${known.provider}——路由与计价都可能不对。`);
        }
      }
      const config = loadConfig(options);
      config[key] = validated;
      const path = saveConfig(config, options);
      out(`✅ ${key} 已写入 ${path}（= ${validated}）`);
      out(`   影响：${spec.effect}`);
      const resolved = resolveSetting(key, options);
      if (resolved.source === "env") {
        out(`⚠️  当前环境变量 ${spec.envVar} 有值，优先级更高——本次写入要重开 shell 或 unset 后才生效。`);
      }
      return 0;
    }
    case "unset":
    case "rm": {
      const key = rest[0];
      if (!key) {
        err("用法: spark-research config unset <key>");
        return 1;
      }
      const config = loadConfig(options);
      if (config[key] === undefined) {
        out(`config.json 里没有 '${key}'，无需删除。`);
        return 0;
      }
      delete config[key];
      const path = saveConfig(config, options);
      out(`✅ 已从 ${path} 删除 '${key}'`);
      return 0;
    }
    case "path": {
      out(configPath(options));
      return 0;
    }
    case "help":
    case "--help":
    case "-h": {
      out(CONFIG_HELP);
      return 0;
    }
    default: {
      err(`未知子命令 '${sub}'`);
      err(CONFIG_HELP);
      return 1;
    }
  }
}
