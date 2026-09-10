import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SETTINGS } from "../../backend/src/config/index";

// G-1（v0.6）门禁：**可写入的配置项必须有读者**。
//
// 形状来源（BACKLOG V40）：`defaultProvider` 曾是「auth 让用户挑、config set 能设、
// auth 还回显——但没有任何代码用它来选 provider」。孤儿模块有叙事门禁抓，
// 孤儿**配置项**在这之前没人抓，V40 是第 7 次「建好了但没有生产调用方」。
// 本轮（G-1）又抓到同一形状的第 8 次：`defaultModel` 在 CLI 入口整条没被读。
//
// 判据（如实说明能力边界）：
// - 每个 CONFIG_SETTINGS key 必须在下面的 READERS 表登记读者证据，二选一：
//   · `{ text }`  ——该文本在 backend/src 里 config/index.ts **之外**至少出现一次
//     （适用于 key 字面量直读，如 resolveSetting("originAllowlist")，或 env 名直读）
//   · `{ helper }`——config/index.ts 导出该 helper，且它在 config/index.ts 之外
//     至少有一个调用点（适用于 stringOr 封装读法，key 字面量只在 config 层出现）
// - 「key → helper 的绑定是否正确」本测试**核不了**（那要解析函数体），靠 review；
//   本测试的牙齿是：新增设置项不登记读者 → 红；登记的读者没有任何调用点 → 红。
//   V40/本轮的两个案例都会被第二条咬住。

const BACKEND_SRC = join(import.meta.dir, "../../backend/src");
const CONFIG_INDEX = join(BACKEND_SRC, "config/index.ts");

type ReaderEvidence = { text: string } | { helper: string };

const READERS: Record<string, ReaderEvidence> = {
  defaultModel: { helper: "configuredDefaultModel" },
  defaultProvider: { text: "defaultProvider" },
  contactEmail: { text: "contactEmail" },
  userAgent: { text: "userAgent" },
  wetBackend: { helper: "configuredWetBackend" },
  simulationPlatform: { helper: "configuredSimulationPlatform" },
  computeTarget: { helper: "configuredComputeTarget" },
  modalEnvironment: { helper: "configuredModalEnvironment" },
  dataDir: { helper: "dataDir" },
  originAllowlist: { text: '"originAllowlist"' },
  httpTimeoutMs: { helper: "configuredHttpTimeoutMs" },
  llmTimeoutMs: { helper: "configuredLlmTimeoutMs" },
  kernelTimeoutMs: { helper: "configuredKernelTimeoutMs" },
  taskTimeoutMs: { helper: "configuredTaskTimeoutMs" },
  mcpTimeoutMs: { helper: "configuredMcpTimeoutMs" },
  // 凭据类：key 本身就是 env 变量名，读者是 router 的 ADAPTERS envKey / local 端点常量。
  KIMI_API_KEY: { text: "KIMI_API_KEY" },
  OPENROUTER_API_KEY: { text: "OPENROUTER_API_KEY" },
  OPENAI_API_KEY: { text: "OPENAI_API_KEY" },
  ANTHROPIC_API_KEY: { text: "ANTHROPIC_API_KEY" },
  DEEPSEEK_API_KEY: { text: "DEEPSEEK_API_KEY" },
  QWEN_API_KEY: { text: "QWEN_API_KEY" },
  SPARK_LOCAL_LLM_BASE_URL: { text: "SPARK_LOCAL_LLM_BASE_URL" },
  SPARK_LOCAL_LLM_API_KEY: { text: "SPARK_LOCAL_LLM_API_KEY" },
  embeddingModel: { text: '"embeddingModel"' },
  llmPricingOverridesJson: { text: '"llmPricingOverridesJson"' },
};

// 动态 key 族：`subAgentModel_<type>` 由 subAgentModelSettingKey() 生成，
// 逐个登记字面量既做不到也没意义——族级读者是 configuredSubAgentModel。
function evidenceFor(key: string): ReaderEvidence | undefined {
  if (key.startsWith("subAgentModel_")) return { helper: "configuredSubAgentModel" };
  return READERS[key];
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const nonConfigSources = walkTsFiles(BACKEND_SRC)
  .filter((f) => f !== CONFIG_INDEX)
  .map((f) => ({ path: f, content: readFileSync(f, "utf8") }));
const configSource = readFileSync(CONFIG_INDEX, "utf8");

function appearsOutsideConfig(needle: string): boolean {
  return nonConfigSources.some((f) => f.content.includes(needle));
}

describe("config_reader_parity（G-1 门禁：可写配置项必须有读者）", () => {
  test("每个设置项都登记了读者证据", () => {
    const missing = CONFIG_SETTINGS.map((s) => s.key).filter((k) => !evidenceFor(k));
    expect(missing).toEqual([]);
  });

  test("登记表没有多余条目（防止设置项删了、表忘了清）", () => {
    const keys = new Set(CONFIG_SETTINGS.map((s) => s.key));
    const stale = Object.keys(READERS).filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });

  for (const spec of CONFIG_SETTINGS) {
    const evidence = evidenceFor(spec.key);
    if (!evidence) continue; // 上面的 missing 断言已经抓它，这里不重复红
    if ("helper" in evidence) {
      test(`'${spec.key}' 的读者 helper '${evidence.helper}' 真实存在且有调用点`, () => {
        expect(configSource).toContain(`export function ${evidence.helper}`);
        expect(appearsOutsideConfig(`${evidence.helper}(`)).toBe(true);
      });
    } else {
      test(`'${spec.key}' 的读者文本 '${evidence.text}' 在 config 层之外出现`, () => {
        expect(appearsOutsideConfig(evidence.text)).toBe(true);
      });
    }
  }
});
