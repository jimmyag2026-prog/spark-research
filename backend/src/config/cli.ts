import {
  CONFIG_SETTINGS,
  configPath,
  loadConfig,
  resolveAll,
  resolveSetting,
  saveConfig,
  settingSpec,
  type ConfigOptions,
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

function pad(text: string, width: number): string {
  // 中文按两列宽计：表格不对齐会让「来源」那一列看起来像随机缩进。
  let visible = 0;
  for (const ch of text) visible += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return text + " ".repeat(Math.max(1, width - visible));
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
        out(`${pad(r.key, 22)}${pad(shown.slice(0, 32), 34)}${pad(r.source, 10)}${r.spec.summary}`);
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
      if (spec.key === "dataDir") {
        err("dataDir 只能用环境变量 SPARK_RESEARCH_DATA_DIR 设置——它决定 config.json 自己在哪里。");
        return 1;
      }
      if (spec.allowed && !spec.allowed.includes(value)) {
        err(`'${value}' 不是 ${key} 的合法取值（可用：${spec.allowed.join(" / ")}）`);
        return 1;
      }
      if (spec.type === "number" && !Number.isFinite(Number(value))) {
        err(`${key} 必须是数字，收到 '${value}'`);
        return 1;
      }
      const config = loadConfig(options);
      config[key] = spec.type === "number" ? Number(value) : value;
      const path = saveConfig(config, options);
      // 凭据值不回显（就算用户是自己敲的，回显也会进 shell history 与日志）。
      out(`✅ ${key} 已写入 ${path}${spec.secret ? "" : `（= ${value}）`}`);
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
