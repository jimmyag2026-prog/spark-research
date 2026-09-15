import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigCommand } from "../../backend/src/config/cli";
import { PROVIDER_MODELS, SUPPORTED_PROVIDERS, providerForModel, type Provider } from "../../backend/src/llm/router";
import {
  MODELS_BY_PROVIDER,
  PRICING,
  UnknownModelError,
  assertKnownModel,
  keywordProviderFor,
  unknownModelError,
} from "../../backend/src/llm/providers/registry";

// lane β-3 · 模型清单对撞门禁（USAGE_LOG U5）。
//
// U5 证据三：「这个模型属于哪一家」这同一个事实有两份手写副本——`router.ts` 的
// `PROVIDER_MODELS`（决定请求发给谁）与 `providers/registry.ts` 的单价表（决定怎么计费），
// 两边没有任何门禁对撞，实测已经漂移。
// U5 证据一：认不出的模型名一律 `return "kimi"`，用 Moonshot 的 baseUrl 发请求，不报错不告警。
//
// 本文件盯三件事：
//   ① 派生正确：`MODELS_BY_PROVIDER` 必须逐 provider 等于单价表的键集合（单价表是唯一真源）。
//   ② 对撞：`PROVIDER_MODELS` 与派生清单的差集必须**全部登记在 LEGACY_UNPRICED_MODELS 里并写明理由**；
//      任何新的漂移（谁改了一边没改另一边）当场红。
//   ③ 认不出就抛：`assertKnownModel()` 对未登记名抛 `unsupported`，关键词兜底命中要留一行 warn。
//
// **收口顺序提示**：β-3 的收口 diff 会把 `router.ts` 的 `PROVIDER_MODELS` 改成
// `import { MODELS_BY_PROVIDER as PROVIDER_MODELS }`。那一刻两份清单完全相等，
// 下面 `LEGACY_UNPRICED_MODELS` 的四条 + `PROVIDER_ONLY_MODELS` 的四条会全部变成
// 「登记了但已不再是差集」——**必须在同一个 commit 里删掉它们**（陈旧检查会红）。
// 同理「U5 现状复现」那条 `providerForModel` 静默兜底的用例届时要改成断言抛错。

/** 单价表里有、`PROVIDER_MODELS` 里没有的模型名（U5 实测差集）。登记必须写清为什么。 */
const PRICED_ONLY_MODELS: Record<string, string> = {
  "deepseek:deepseek-v4-flash": "单价表按官方页当前在售型号定价；PROVIDER_MODELS 还停在 deepseek-chat/reasoner 两个旧别名——靠关键词兜底侥幸落对 provider",
  "deepseek:deepseek-v4-pro": "同上",
  "kimi:kimi-k2.6": "单价表按 Moonshot 当前在售型号定价；PROVIDER_MODELS.kimi 的三个名字已于 2026-08-31 全部退役（见 registry.ts 顶部注释）",
  "kimi:kimi-k3": "同上",
};

/** `PROVIDER_MODELS` 里有、单价表里没有的模型名。 */
const PROVIDER_ONLY_MODELS: Record<string, string> = {
  "kimi:kimi-k2": "已于 2026-08-31 被 Moonshot 退役（现在请求 404），给死名字编报价没有意义，单价表不收录",
  "kimi:moonshot-v1-32k": "同上（已退役）",
  "kimi:moonshot-v1-8k": "同上（已退役）",
  "qwen:qwen3": "不是可计价的具体 SKU（DashScope 拆成 qwen3-235b-a22b / qwen3-32b / … 一堆型号，还分 thinking 档），查不到单一价格就不收录",
};

function pairsOf(table: Readonly<Record<string, readonly string[]>>): Set<string> {
  const out = new Set<string>();
  for (const [provider, models] of Object.entries(table)) for (const m of models) out.add(`${provider}:${m}`);
  return out;
}

describe("β-3 ① 模型清单从单价表派生", () => {
  test("MODELS_BY_PROVIDER 逐 provider 等于单价表的键集合（派生，不是第三份手写副本）", () => {
    for (const [provider, models] of Object.entries(PRICING)) {
      expect(MODELS_BY_PROVIDER[provider as Provider]).toEqual(Object.keys(models).sort());
    }
  });

  test("SUPPORTED_PROVIDERS 的每一家都在派生清单里有键（router.listModels() 会逐个索引它）", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(Array.isArray(MODELS_BY_PROVIDER[provider])).toBe(true);
    }
    expect(Object.keys(MODELS_BY_PROVIDER).sort()).toEqual([...SUPPORTED_PROVIDERS].sort());
  });

  test("派生清单是只读的（冻结）——防止有人在运行期 push 一个名字进去当「登记」", () => {
    expect(Object.isFrozen(MODELS_BY_PROVIDER)).toBe(true);
    expect(Object.isFrozen(MODELS_BY_PROVIDER.kimi)).toBe(true);
  });
});

describe("β-3 ② 两份清单对撞（U5 证据三）", () => {
  const derived = pairsOf(MODELS_BY_PROVIDER);
  const router = pairsOf(PROVIDER_MODELS);

  test("单价表有、PROVIDER_MODELS 没有的，必须逐条登记在 PRICED_ONLY_MODELS 并带理由", () => {
    const diff = [...derived].filter((k) => !router.has(k)).sort();
    const unregistered = diff.filter((k) => !PRICED_ONLY_MODELS[k]?.trim());
    expect(
      unregistered,
      `这些模型在单价表里登记了、router 的 PROVIDER_MODELS 却不认识——两份清单又漂移了。\n` +
        `要么两边都登记，要么在 PRICED_ONLY_MODELS 写清为什么只在一边：\n  ${unregistered.join("\n  ")}`,
    ).toEqual([]);
  });

  test("PROVIDER_MODELS 有、单价表没有的，必须逐条登记在 PROVIDER_ONLY_MODELS 并带理由", () => {
    const diff = [...router].filter((k) => !derived.has(k)).sort();
    const unregistered = diff.filter((k) => !PROVIDER_ONLY_MODELS[k]?.trim());
    expect(
      unregistered,
      `这些模型 router 会路由、单价表却查不到价（预算闸对它们等于失灵）：\n  ${unregistered.join("\n  ")}`,
    ).toEqual([]);
  });

  test("登记不许陈旧：两张表里的每一条都必须确实还是差集（收口合并两份清单后必须删空）", () => {
    const stalePriced = Object.keys(PRICED_ONLY_MODELS).filter((k) => !derived.has(k) || router.has(k));
    const staleProvider = Object.keys(PROVIDER_ONLY_MODELS).filter((k) => !router.has(k) || derived.has(k));
    expect(
      [...stalePriced, ...staleProvider],
      `这些条目已不再是差集，请删除（收口把 PROVIDER_MODELS 改成 import MODELS_BY_PROVIDER 之后，两张表都该删空）`,
    ).toEqual([]);
  });
});

describe("β-3 ③ 认不出的模型名：抛错，不静默当 Kimi（U5 证据一/二）", () => {
  test("未登记名 → assertKnownModel 抛 UnknownModelError，kind 是 unsupported", () => {
    let caught: unknown;
    try {
      assertKnownModel("totally-made-up-model-v9");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownModelError);
    expect((caught as UnknownModelError).kind).toBe("unsupported");
    expect((caught as UnknownModelError).retryable).toBe(false);
  });

  test("错误消息列出已登记模型、并指向 config set defaultModel 与单价表（能照着修，不是「不支持」三个字）", () => {
    const message = unknownModelError("totally-made-up-model-v9").message;
    expect(message).toContain("totally-made-up-model-v9");
    expect(message).toContain("spark-research config set defaultModel");
    expect(message).toContain("registry.ts");
    // 每个 provider 分组都在，且至少能看到默认模型
    for (const provider of SUPPORTED_PROVIDERS) expect(message).toContain(`${provider}:`);
    expect(message).toContain("moonshotai/kimi-k2.6");
  });

  test("显式登记名 → registered，并报出它属于哪一家", () => {
    expect(assertKnownModel("z-ai/glm-5.3-flash")).toEqual({ kind: "registered", provider: "openrouter" });
    expect(assertKnownModel("kimi-k2.6")).toEqual({ kind: "registered", provider: "kimi" });
    // U5 证据四：两个近似串各有各的归属与单价，派生之后它们都是显式登记，不再是「一个显式一个兜底」。
    expect(assertKnownModel("moonshotai/kimi-k2.6")).toEqual({ kind: "registered", provider: "openrouter" });
  });

  test("local/ 前缀 → local，不抛（本地端点的模型名是用户自己起的，不该要求登记）", () => {
    expect(assertKnownModel("local/llama3.1")).toEqual({ kind: "local" });
    expect(assertKnownModel("local:qwen2.5-7b")).toEqual({ kind: "local" });
  });

  test("关键词兜底命中 → 返回 keyword 且 console.warn 一行（自动降级必须留痕），同名只警告一次", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(keywordProviderFor("deepseek-r1-distill-32b")).toBe("deepseek");
      expect(assertKnownModel("deepseek-r1-distill-32b")).toEqual({ kind: "keyword", provider: "deepseek" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("未显式登记");
      expect(String(warn.mock.calls[0]![0])).toContain("deepseek");
      // 同一个名字第二次不再刷屏（每次调用刷一行会淹掉真正的日志）
      assertKnownModel("deepseek-r1-distill-32b");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("关键词认不出的名字（U5 那个具体的坑：z-ai/glm 一个关键词都不含）→ null", () => {
    expect(keywordProviderFor("z-ai/glm-6-preview")).toBeNull();
    expect(() => assertKnownModel("z-ai/glm-6-preview")).toThrow(UnknownModelError);
  });

  // ── U5 现状复现：收口应用 β-3 diff 后，本条必须改成 `expect(() => …).toThrow()` ──
  test("U5 现状复现（收口后必须改）：stock providerForModel 对认不出的名字仍然静默返回 kimi", () => {
    expect(providerForModel("z-ai/glm-6-preview")).toBe("kimi");
  });
});

describe("β-3 ④ config set 写入时校验模型名（U5「顺带」那条）", () => {
  function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), "spark-beta3-config-"));
  }
  function capture() {
    const lines: string[] = [];
    return { lines, sink: (l: string) => lines.push(l) };
  }

  test("未登记的模型名 → 拒绝写入，config.json 一个字都没动", () => {
    const root = tmpRoot();
    const { lines, sink } = capture();
    const code = runConfigCommand(["set", "defaultModel", "z-ai/glm-6-preview"], { root, env: {}, out: sink, err: sink });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("未登记");
    expect(lines.join("\n")).toContain("config set defaultModel");
    expect(existsSync(join(root, "config.json"))).toBe(false);
  });

  test("已登记的模型名 → 正常写入", () => {
    const root = tmpRoot();
    const { sink } = capture();
    expect(runConfigCommand(["set", "defaultModel", "z-ai/glm-5.3-flash"], { root, env: {}, out: sink, err: sink })).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).defaultModel).toBe("z-ai/glm-5.3-flash");
  });

  test("subAgentModel_* 走同一个判据（V16：子代理模型也是模型名，不该只校验 defaultModel）", () => {
    const root = tmpRoot();
    const { sink } = capture();
    expect(runConfigCommand(["set", "subAgentModel_literature", "made-up-sub-model"], { root, env: {}, out: sink, err: sink })).toBe(1);
    expect(existsSync(join(root, "config.json"))).toBe(false);
    expect(runConfigCommand(["set", "subAgentModel_literature", "claude-sonnet-5"], { root, env: {}, out: sink, err: sink })).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).subAgentModel_literature).toBe("claude-sonnet-5");
  });

  test("关键词兜底命中 → 放行但当面告警（与 providerForModel 同口径，不比运行期更严）", () => {
    const root = tmpRoot();
    const { lines, sink } = capture();
    expect(runConfigCommand(["set", "defaultModel", "kimi-k2.7-preview"], { root, env: {}, out: sink, err: sink })).toBe(0);
    expect(lines.join("\n")).toContain("未显式登记");
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).defaultModel).toBe("kimi-k2.7-preview");
  });

  test("非模型类设置项不受影响（embeddingModel 查的是另一张表，不用 chat 的判据）", () => {
    const root = tmpRoot();
    const { sink } = capture();
    expect(runConfigCommand(["set", "embeddingModel", "text-embedding-3-large"], { root, env: {}, out: sink, err: sink })).toBe(0);
  });
});
