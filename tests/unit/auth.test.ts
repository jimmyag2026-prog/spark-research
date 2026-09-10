import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authStatus, getApiKey, type AuthStatusEntry, type Config } from "../../backend/src/index";
import { buildDoctorReport } from "../../backend/src/doctor";
import { PROVIDER_API_KEY_ENV } from "../../backend/src/llm/providers/registry";
import { implementedProviders } from "../../backend/src/llm/router";

// V37（docs/BACKLOG.md）：`sr auth` 把 OPENROUTER_API_KEY 报成未配置，而
// `config list` / `doctor` 正确显示已配置——三处读同一份配置却给出矛盾答案。
//
// 真因（主会话已定位）：
//   1. index.ts 曾有一份手写的 KEY_NAMES 副本，只列 kimi + openrouter 两个 provider，
//      而 doctor / capabilities / onboarding 三处都从 PROVIDER_API_KEY_ENV（router.ts
//      的 ADAPTERS 派生）取全部 6 个已实装 provider。
//   2. auth() 显示当前配置时只读 config 文件、完全不看环境变量，而 getApiKey() 自己
//      是 env 优先的——同一个文件里两套判据。
//
// 这份测试文件钉住两件事：
//   A. authStatus()（auth() 的展示层）与 doctor 的 buildDoctorReport().providers 对
//      同一份 env+config 必须给出一致的 configured 判定，且都覆盖全部 6 个 provider。
//   B. index.ts 不许再手写一份 provider→env 名的映射表（P11 修过的手工副本这次在
//      消费方长出了第二现场，不能指望"记得同步"，只能靠断言钉死）。

function tmpRoot(prefix = "spark-auth-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeConfigJson(root: string, data: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), JSON.stringify(data));
}

function entryFor(entries: AuthStatusEntry[], provider: string): AuthStatusEntry {
  const entry = entries.find((e) => e.provider === provider);
  if (!entry) throw new Error(`authStatus() 缺了 provider '${provider}'`);
  return entry;
}

describe("authStatus()（V37 修复：auth 的展示层）", () => {
  test("覆盖全部 6 个已实装 provider，不再只认 kimi/openrouter 两个", () => {
    const entries = authStatus({ env: {}, config: {} });
    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.provider).sort()).toEqual(Object.keys(PROVIDER_API_KEY_ENV).sort());
    expect(entries.map((e) => e.provider).sort()).toEqual([...implementedProviders()].sort());
  });

  test("key 只在环境变量里：configured=true，来源标为 env（此前 auth 只读 config，会误报未设置）", () => {
    const entries = authStatus({ env: { OPENROUTER_API_KEY: "sk-test-not-a-real-key" }, config: {} });
    const or = entryFor(entries, "openrouter");
    expect(or.configured).toBe(true);
    expect(or.source).toBe("env");
  });

  test("key 只在 config 文件里：configured=true，来源标为 config", () => {
    const entries = authStatus({ env: {}, config: { OPENROUTER_API_KEY: "sk-test-not-a-real-key" } });
    const or = entryFor(entries, "openrouter");
    expect(or.configured).toBe(true);
    expect(or.source).toBe("config");
  });

  test("env 与 config 文件都有：configured=true，来源标为 both", () => {
    const entries = authStatus({
      env: { OPENROUTER_API_KEY: "sk-test-env-key" },
      config: { OPENROUTER_API_KEY: "sk-test-config-key" },
    });
    const or = entryFor(entries, "openrouter");
    expect(or.configured).toBe(true);
    expect(or.source).toBe("both");
  });

  test("两处都没有：未设置", () => {
    const entries = authStatus({ env: {}, config: {} });
    const kimi = entryFor(entries, "kimi");
    expect(kimi.configured).toBe(false);
    expect(kimi.source).toBe(null);
  });
});

describe("V37：auth 与 doctor 对同一把 key 口径一致（三种情况各验一遍）", () => {
  const doctorStubs = {
    python: "fake-python",
    probePython: async () => ({ path: "fake-python", ok: true, version: "Python 3.12.0", error: null }),
    probeScience: async () => ({ ok: true, reason: null }),
    probeLab: async () => ({ ok: true, reason: null }),
  };

  test("情况①：key 只在 env", async () => {
    const root = tmpRoot();
    const env = { OPENROUTER_API_KEY: "sk-test-not-a-real-key" };

    const authEntries = authStatus({ env, config: {} });
    const doctorReport = await buildDoctorReport({ root, env, frontendDir: tmpRoot(), ...doctorStubs });

    const authOr = entryFor(authEntries, "openrouter");
    const doctorOr = doctorReport.providers.find((p) => p.id === "openrouter")!;
    expect(authOr.configured).toBe(true);
    expect(doctorOr.configured).toBe(true);
    expect(authOr.configured).toBe(doctorOr.configured);
  });

  test("情况②：key 只在 config 文件", async () => {
    const root = tmpRoot();
    writeConfigJson(root, { OPENROUTER_API_KEY: "sk-test-not-a-real-key" });
    const env: Record<string, string | undefined> = {};

    const authEntries = authStatus({ env, config: { OPENROUTER_API_KEY: "sk-test-not-a-real-key" } });
    const doctorReport = await buildDoctorReport({ root, env, frontendDir: tmpRoot(), ...doctorStubs });

    const authOr = entryFor(authEntries, "openrouter");
    const doctorOr = doctorReport.providers.find((p) => p.id === "openrouter")!;
    expect(authOr.configured).toBe(true);
    expect(doctorOr.configured).toBe(true);
    expect(authOr.configured).toBe(doctorOr.configured);
  });

  test("情况③：env 与 config 文件都有", async () => {
    const root = tmpRoot();
    writeConfigJson(root, { OPENROUTER_API_KEY: "sk-test-config-key" });
    const env = { OPENROUTER_API_KEY: "sk-test-env-key" };

    const authEntries = authStatus({ env, config: { OPENROUTER_API_KEY: "sk-test-config-key" } });
    const doctorReport = await buildDoctorReport({ root, env, frontendDir: tmpRoot(), ...doctorStubs });

    const authOr = entryFor(authEntries, "openrouter");
    const doctorOr = doctorReport.providers.find((p) => p.id === "openrouter")!;
    expect(authOr.configured).toBe(true);
    expect(doctorOr.configured).toBe(true);
    expect(authOr.configured).toBe(doctorOr.configured);
  });
});

describe("V37 门禁：index.ts 不许再手写 provider→env 名映射", () => {
  const INDEX_TS_PATH = join(import.meta.dir, "../../backend/src/index.ts");

  test("provider→env 的真源必须来自 PROVIDER_API_KEY_ENV（llm/providers/registry.ts 派生自 router.ts 的 ADAPTERS）", () => {
    const src = readFileSync(INDEX_TS_PATH, "utf-8");
    expect(src).toContain('from "./llm/providers/registry"');
    expect(src).toContain("PROVIDER_API_KEY_ENV");
  });

  // 核心门禁：这是 P11 收口过的手工副本第二次在消费方长出来的位置——只能靠断言钉死，
  // 不能指望"下次记得同步"。把 KEY_NAMES 那种「provider id: "XXX_API_KEY" 字符串字面量」
  // 的对象重新加回 index.ts，这条必须变红（见 docs/devlog/W5-1-g.md 的阴性对照①）。
  test("不许在 index.ts 里重新声明一份 provider -> \"*_API_KEY\" 字面量表", () => {
    const src = readFileSync(INDEX_TS_PATH, "utf-8");
    const handRolledKeyMap =
      /\b(?:kimi|openrouter|openai|anthropic|deepseek|qwen)\s*:\s*["'][A-Z][A-Z0-9_]*_API_KEY["']/;
    expect(src).not.toMatch(handRolledKeyMap);
  });
});

// ── 收口补（W5-1 η 之后，主会话）────────────────────────────────────────────
//
// 追 η 自报的行为变更（provider 优先级从写死的 [kimi, openrouter] 变成 ADAPTERS
// 声明顺序）时挖出来的：`defaultProvider` 是一个**只写不读**的设置。
//   写：`auth()` 让用户挑并落盘（index.ts:223）· `config set defaultProvider`
//   显示：`auth` 回显「默认 Provider: xxx」
//   读：**没有**。`getApiKey()` 只按声明顺序取第一个有 key 的。
//
// 后果：用户明明选了 kimi，只要 OPENROUTER_API_KEY 也在，走的就是 openrouter，
// 且不留任何痕迹——「用户的显式选择被静默忽略」。这是本项目第 7 次
// 「建好了但没有生产调用方」，只不过这次藏在配置项里而不是模块里。
describe("getApiKey() 必须认 defaultProvider（收口补）", () => {
  const twoKeys = { KIMI_API_KEY: "sk-test-kimi", OPENROUTER_API_KEY: "sk-test-or" };

  test("用户显式选了 kimi，两把 key 都在时必须走 kimi", () => {
    const picked = getApiKey({ env: twoKeys, config: { defaultProvider: "kimi" } as Config });
    expect(picked?.provider).toBe("kimi");
    expect(picked?.key).toBe("sk-test-kimi");
  });

  test("用户显式选了 openrouter，必须走 openrouter", () => {
    const picked = getApiKey({ env: twoKeys, config: { defaultProvider: "openrouter" } as Config });
    expect(picked?.provider).toBe("openrouter");
  });

  test("没设 defaultProvider 时退回声明顺序（不是报错，也不是不选）", () => {
    const picked = getApiKey({ env: twoKeys, config: {} as Config });
    expect(picked?.provider).toBe(Object.keys(PROVIDER_API_KEY_ENV)[0]);
  });

  test("defaultProvider 指向一个没配 key 的 provider 时，退回下一个有 key 的", () => {
    const picked = getApiKey({
      env: { OPENROUTER_API_KEY: "sk-test-or" },
      config: { defaultProvider: "kimi" } as Config,
    });
    expect(picked?.provider).toBe("openrouter");
  });

  test("defaultProvider 是个不存在的 provider 名时不许崩，退回声明顺序", () => {
    const picked = getApiKey({ env: twoKeys, config: { defaultProvider: "nope" } as Config });
    expect(picked?.provider).toBe(Object.keys(PROVIDER_API_KEY_ENV)[0]);
  });
});
