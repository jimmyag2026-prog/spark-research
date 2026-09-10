import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_SETTINGS,
  applyConfigEnvDefaults,
  checkConfigPermissions,
  configPath,
  configuredMcpTimeoutMs,
  configuredSimulationPlatform,
  configuredWetBackend,
  enforceConfigPermissions,
  loadConfig,
  resolveAll,
  resolveSetting,
  saveConfig,
} from "../../backend/src/config";
import { runConfigCommand } from "../../backend/src/config/cli";
import { DEFAULT_MODEL, implementedProviders } from "../../backend/src/llm/router";
import { DEFAULT_WET_BACKEND, WET_BACKEND_IDS } from "../../backend/src/lab/wet_backend";
import { DEFAULT_SIMULATION_PLATFORM, SIMULATION_PLATFORM_IDS } from "../../backend/src/simulation/registry";
import {
  CONTACT_EMAIL_ENV,
  PLACEHOLDER_CONTACT_EMAIL,
  USER_AGENT_ENV,
} from "../../backend/src/connectors/politeness";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-config-"));
}

function capture(): { lines: string[]; out: (l: string) => void } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l) };
}

describe("配置面 · 设置表是单一真源", () => {
  // 设置表里的默认值刻意与各模块常量分离（config 层不反向依赖 lab/simulation/llm），
  // 一致性只能靠测试钉住——常量改了设置表不改，这里立刻红。
  test("默认值与各模块的 DEFAULT_* 常量一致", () => {
    const byKey = Object.fromEntries(CONFIG_SETTINGS.map((s) => [s.key, s]));
    expect(byKey.defaultModel!.defaultValue).toBe(DEFAULT_MODEL);
    expect(byKey.wetBackend!.defaultValue).toBe(DEFAULT_WET_BACKEND);
    expect(byKey.simulationPlatform!.defaultValue).toBe(DEFAULT_SIMULATION_PLATFORM);
    expect(byKey.contactEmail!.defaultValue).toBe(PLACEHOLDER_CONTACT_EMAIL);
    expect(byKey.contactEmail!.envVar).toBe(CONTACT_EMAIL_ENV);
    expect(byKey.userAgent!.envVar).toBe(USER_AGENT_ENV);
  });

  test("enum 项的 allowed 与真实注册表一致", () => {
    const byKey = Object.fromEntries(CONFIG_SETTINGS.map((s) => [s.key, s]));
    expect([...byKey.wetBackend!.allowed!].sort()).toEqual([...WET_BACKEND_IDS].sort());
    expect([...byKey.simulationPlatform!.allowed!].sort()).toEqual([...SIMULATION_PLATFORM_IDS].sort());
  });

  // R-c-3：defaultProvider.allowed 之前只有 ["kimi","openrouter"]，但 R-a（P11-a）
  // 已经把 openai/deepseek/qwen 填进 router.ts 的 ADAPTERS（真的能发请求的清单）——
  // 「声明支持」与「真的实现了」又要分家一次。这条钉住两者的集合恒等，
  // 谁改了 ADAPTERS 忘了同步这里，测试会红（不依赖具体顺序，只比集合）。
  test("defaultProvider.allowed 与 implementedProviders()（真实实现的 ADAPTERS）集合一致", () => {
    const byKey = Object.fromEntries(CONFIG_SETTINGS.map((s) => [s.key, s]));
    expect([...byKey.defaultProvider!.allowed!].sort()).toEqual([...implementedProviders()].sort());
  });

  test("每一项都写了 summary 与 effect（改了影响什么不许缺）", () => {
    for (const spec of CONFIG_SETTINGS) {
      expect(spec.summary.length).toBeGreaterThan(4);
      expect(spec.effect.length).toBeGreaterThan(8);
    }
  });
});

describe("配置面 · 优先级 env > config.json > 默认值", () => {
  test("三档来源各自可辨", () => {
    const root = tmpRoot();
    // 默认档
    expect(resolveSetting("wetBackend", { root, env: {} })).toMatchObject({
      value: DEFAULT_WET_BACKEND,
      source: "default",
      configured: false,
    });
    // config 档
    saveConfig({ wetBackend: "mock_devices" }, { root });
    expect(resolveSetting("wetBackend", { root, env: {} })).toMatchObject({
      value: "mock_devices",
      source: "config",
      configured: true,
    });
    // env 档压过 config
    expect(
      resolveSetting("wetBackend", { root, env: { SPARK_RESEARCH_WET_BACKEND: "opentrons_simulate" } }),
    ).toMatchObject({ value: "opentrons_simulate", source: "env" });
  });

  test("空字符串不算配置（视同未设置）", () => {
    const root = tmpRoot();
    saveConfig({ defaultModel: "" }, { root });
    expect(resolveSetting("defaultModel", { root, env: { SPARK_RESEARCH_MODEL: "" } })).toMatchObject({
      value: DEFAULT_MODEL,
      source: "default",
    });
  });

  test("坏掉的 config.json 不让 CLI 起不来（读成空配置）", () => {
    const root = tmpRoot();
    saveConfig({}, { root });
    writeFileSync(configPath({ root }), "{ 这不是 JSON");
    expect(loadConfig({ root })).toEqual({});
    expect(resolveSetting("wetBackend", { root, env: {} }).value).toBe(DEFAULT_WET_BACKEND);
  });

  test("下游窄口取值遵循同一优先级", () => {
    const root = tmpRoot();
    saveConfig({ wetBackend: "mock_devices", simulationPlatform: "openmm", mcpTimeoutMs: 1234 }, { root });
    expect(configuredWetBackend(DEFAULT_WET_BACKEND, { root, env: {} })).toBe("mock_devices");
    expect(configuredSimulationPlatform(DEFAULT_SIMULATION_PLATFORM, { root, env: {} })).toBe("openmm");
    expect(configuredMcpTimeoutMs(300_000, { root, env: {} })).toBe(1234);
  });
});

describe("配置面 · 凭据不泄漏（AD-2 延伸）", () => {
  test("secret 项的值在解析结果里恒为 null，只回 configured", () => {
    const root = tmpRoot();
    saveConfig({ KIMI_API_KEY: "sk-should-never-appear" }, { root });
    const resolved = resolveSetting("KIMI_API_KEY", { root, env: {} });
    expect(resolved.configured).toBe(true);
    expect(resolved.value).toBeNull();
  });

  test("config list / --json 的输出里没有凭据值", () => {
    const root = tmpRoot();
    saveConfig({ KIMI_API_KEY: "sk-should-never-appear", OPENROUTER_API_KEY: "sk-or-secret" }, { root });
    for (const args of [["list"], ["list", "--json"], ["get", "KIMI_API_KEY"]]) {
      const { lines, out } = capture();
      expect(runConfigCommand(args, { root, env: {}, out, err: out })).toBe(0);
      const text = lines.join("\n");
      expect(text).not.toContain("sk-should-never-appear");
      expect(text).not.toContain("sk-or-secret");
    }
  });

  test("applyConfigEnvDefaults 只搬非凭据项，且不覆盖已有 env", () => {
    const root = tmpRoot();
    saveConfig(
      {
        contactEmail: "me@lab.example",
        userAgent: "custom-agent/1.0",
        KIMI_API_KEY: "sk-should-never-appear",
        dataDir: "/somewhere/else",
      },
      { root },
    );
    const env: Record<string, string | undefined> = { [USER_AGENT_ENV]: "already-set" };
    const applied = applyConfigEnvDefaults({ root, env });
    expect(env[CONTACT_EMAIL_ENV]).toBe("me@lab.example");
    // 已有 env 不被覆盖
    expect(env[USER_AGENT_ENV]).toBe("already-set");
    // 凭据永不进 env
    expect(env.KIMI_API_KEY).toBeUndefined();
    // dataDir 决定 config.json 自己在哪儿，倒过来设没有意义
    expect(env.SPARK_RESEARCH_DATA_DIR).toBeUndefined();
    expect(applied).toEqual([CONTACT_EMAIL_ENV]);
  });
});

describe("配置面 · R-c-3 新增设置项（R-a 留下的收口缺口）", () => {
  test("OPENAI_API_KEY / DEEPSEEK_API_KEY / QWEN_API_KEY / SPARK_LOCAL_LLM_API_KEY 都标 secret", () => {
    const byKey = Object.fromEntries(CONFIG_SETTINGS.map((s) => [s.key, s]));
    for (const key of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "QWEN_API_KEY", "SPARK_LOCAL_LLM_API_KEY"]) {
      expect(byKey[key], `${key} 应该存在于 CONFIG_SETTINGS`).toBeDefined();
      expect(byKey[key]!.secret).toBe(true);
      expect(byKey[key]!.envVar).toBe(key);
    }
  });

  test("secret 项配置后只报 configured，值不出现在 resolveSetting 结果里", () => {
    const root = tmpRoot();
    saveConfig({ OPENAI_API_KEY: "sk-should-never-appear", QWEN_API_KEY: "sk-qwen-secret" }, { root });
    const openai = resolveSetting("OPENAI_API_KEY", { root, env: {} });
    expect(openai.configured).toBe(true);
    expect(openai.value).toBeNull();
    const qwen = resolveSetting("QWEN_API_KEY", { root, env: {} });
    expect(qwen.configured).toBe(true);
    expect(qwen.value).toBeNull();
  });

  test("config list / --json 不泄漏这几个新 key 的值", () => {
    const root = tmpRoot();
    saveConfig(
      { OPENAI_API_KEY: "sk-should-never-appear", DEEPSEEK_API_KEY: "sk-ds-secret", SPARK_LOCAL_LLM_API_KEY: "sk-local-secret" },
      { root },
    );
    for (const args of [["list"], ["list", "--json"]]) {
      const { lines, out } = capture();
      expect(runConfigCommand(args, { root, env: {}, out, err: out })).toBe(0);
      const text = lines.join("\n");
      expect(text).not.toContain("sk-should-never-appear");
      expect(text).not.toContain("sk-ds-secret");
      expect(text).not.toContain("sk-local-secret");
    }
  });

  test("SPARK_LOCAL_LLM_BASE_URL 不是 secret，且是「先有目录才有文件」之外唯一走 config.json→env 桥接的本 lane 新增项", () => {
    const byKey = Object.fromEntries(CONFIG_SETTINGS.map((s) => [s.key, s]));
    expect(byKey.SPARK_LOCAL_LLM_BASE_URL!.secret).toBeFalsy();
    const root = tmpRoot();
    saveConfig({ SPARK_LOCAL_LLM_BASE_URL: "http://localhost:11434" }, { root });
    const env: Record<string, string | undefined> = {};
    const applied = applyConfigEnvDefaults({ root, env });
    expect(env.SPARK_LOCAL_LLM_BASE_URL).toBe("http://localhost:11434");
    expect(applied).toContain("SPARK_LOCAL_LLM_BASE_URL");
  });

  test("SPARK_LOCAL_LLM_API_KEY 是 secret，不会被 applyConfigEnvDefaults 桥接（AD-2：凭据永不进 env）", () => {
    const root = tmpRoot();
    saveConfig({ SPARK_LOCAL_LLM_API_KEY: "sk-should-never-appear" }, { root });
    const env: Record<string, string | undefined> = {};
    applyConfigEnvDefaults({ root, env });
    expect(env.SPARK_LOCAL_LLM_API_KEY).toBeUndefined();
  });

  test("llmPricingOverridesJson 存在、非 secret、能通过 env 覆盖被读到", () => {
    const byKey = Object.fromEntries(CONFIG_SETTINGS.map((s) => [s.key, s]));
    expect(byKey.llmPricingOverridesJson).toBeDefined();
    expect(byKey.llmPricingOverridesJson!.secret).toBeFalsy();
    expect(byKey.llmPricingOverridesJson!.envVar).toBe("SPARK_LLM_PRICING_JSON");
    const resolved = resolveSetting("llmPricingOverridesJson", {
      root: tmpRoot(),
      env: { SPARK_LLM_PRICING_JSON: '{"x:y":{"inputPerMillionUsd":1,"outputPerMillionUsd":1}}' },
    });
    expect(resolved.value).toContain("inputPerMillionUsd");
  });
});

describe("配置面 · config.json 权限（D-6，与 credentials.json 同等保护）", () => {
  // config.json 装着 KIMI_API_KEY / OPENROUTER_API_KEY——项目里最值钱的密钥。
  // 保护不能弱于 connector 凭据（daemon/credentials.ts 的 0600）。
  test("saveConfig 写入后文件权限是 0600", () => {
    const root = tmpRoot();
    saveConfig({ defaultProvider: "kimi" }, { root });
    const mode = statSync(configPath({ root })).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // 最容易漏的一条路径：writeFileSync 的 mode 只在**创建**文件时生效。
  // 一个已经以 0644 存在的文件（例如老版本留下的、或被别的工具重建过）
  // 必须在下一次写入时被**显式 chmod** 收紧，而不是继续带着旧权限。
  test("文件已存在且是 0644 → 写入后被收紧到 0600", () => {
    const root = tmpRoot();
    saveConfig({ defaultProvider: "kimi" }, { root });
    const path = configPath({ root });
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    saveConfig({ defaultProvider: "kimi", defaultModel: "x" }, { root });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    // 内容也确实是新写入的，不是权限修了但数据没变。
    expect(JSON.parse(readFileSync(path, "utf8")).defaultModel).toBe("x");
  });

  test("checkConfigPermissions：不存在的文件视为 ok（不阻断首次运行）", () => {
    const root = tmpRoot();
    const result = checkConfigPermissions({ root });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("-");
  });

  test("checkConfigPermissions：0600 判定为 ok，过宽（0644）判定为不 ok 并带告警文案", () => {
    const root = tmpRoot();
    saveConfig({}, { root });
    expect(checkConfigPermissions({ root }).ok).toBe(true);

    chmodSync(configPath({ root }), 0o644);
    const result = checkConfigPermissions({ root });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("644");
    expect(result.warning).toContain("644");
    // 只读检测：不该顺手把文件改了——那是 enforceConfigPermissions 的职责。
    expect(statSync(configPath({ root })).mode & 0o777).toBe(0o644);
  });

  test("enforceConfigPermissions：发现权限过宽 → 立即收紧到 0600 并报告发现时的状态", () => {
    const root = tmpRoot();
    saveConfig({}, { root });
    chmodSync(configPath({ root }), 0o644);

    const result = enforceConfigPermissions({ root });
    expect(result.ok).toBe(false);
    expect(result.warning).toBeTruthy();
    // 收紧已经发生（这才是启动自检要的效果，不是仅仅报告）。
    expect(statSync(configPath({ root })).mode & 0o777).toBe(0o600);
  });

  test("loadConfig 在读取时触发同样的自检收紧，并把告警交给注入的 warn", () => {
    const root = tmpRoot();
    saveConfig({ defaultProvider: "kimi" }, { root });
    chmodSync(configPath({ root }), 0o644);

    const warnings: string[] = [];
    const config = loadConfig({ root, warn: (m) => warnings.push(m) });

    expect(config.defaultProvider).toBe("kimi");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("644");
    expect(statSync(configPath({ root })).mode & 0o777).toBe(0o600);
  });

  test("loadConfig 权限已经是 0600 时不告警", () => {
    const root = tmpRoot();
    saveConfig({}, { root });
    const warnings: string[] = [];
    loadConfig({ root, warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(0);
  });
});

describe("配置面 · CLI", () => {
  test("set 校验 enum 与数字，拒绝未知键", () => {
    const root = tmpRoot();
    const bad = capture();
    expect(runConfigCommand(["set", "wetBackend", "nope"], { root, env: {}, out: bad.out, err: bad.out })).toBe(1);
    expect(bad.lines.join("\n")).toContain("合法取值");

    const unknown = capture();
    expect(runConfigCommand(["set", "nosuch", "x"], { root, env: {}, out: unknown.out, err: unknown.out })).toBe(1);

    const num = capture();
    expect(runConfigCommand(["set", "mcpTimeoutMs", "abc"], { root, env: {}, out: num.out, err: num.out })).toBe(1);

    const ok = capture();
    expect(runConfigCommand(["set", "mcpTimeoutMs", "60000"], { root, env: {}, out: ok.out, err: ok.out })).toBe(0);
    expect(JSON.parse(readFileSync(configPath({ root }), "utf8")).mcpTimeoutMs).toBe(60000);
  });

  test("dataDir 不许写进 config.json（先有目录才有文件）", () => {
    const root = tmpRoot();
    const { lines, out } = capture();
    expect(runConfigCommand(["set", "dataDir", "/tmp/x"], { root, env: {}, out, err: out })).toBe(1);
    expect(lines.join("\n")).toContain("SPARK_RESEARCH_DATA_DIR");
  });

  test("set 时若 env 已有更高优先级的值，明确告警", () => {
    const root = tmpRoot();
    const { lines, out } = capture();
    runConfigCommand(["set", "wetBackend", "mock_devices"], {
      root,
      env: { SPARK_RESEARCH_WET_BACKEND: "opentrons_simulate" },
      out,
      err: out,
    });
    expect(lines.join("\n")).toContain("优先级更高");
  });

  test("unset 后回落默认；path 打印真实路径", () => {
    const root = tmpRoot();
    saveConfig({ wetBackend: "mock_devices" }, { root });
    const { lines, out } = capture();
    expect(runConfigCommand(["unset", "wetBackend"], { root, env: {}, out, err: out })).toBe(0);
    expect(resolveSetting("wetBackend", { root, env: {} }).source).toBe("default");
    const p = capture();
    runConfigCommand(["path"], { root, env: {}, out: p.out, err: p.out });
    expect(p.lines[0]).toBe(configPath({ root }));
  });

  test("list --json 覆盖设置表全部条目", () => {
    const root = tmpRoot();
    const { lines, out } = capture();
    runConfigCommand(["list", "--json"], { root, env: {}, out, err: out });
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.settings).toHaveLength(CONFIG_SETTINGS.length);
    expect(parsed.settings.every((s: { effect: string }) => s.effect.length > 0)).toBe(true);
    expect(resolveAll({ root, env: {} })).toHaveLength(CONFIG_SETTINGS.length);
  });
});
