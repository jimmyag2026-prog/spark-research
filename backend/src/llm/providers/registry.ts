import { resolveSetting, type ConfigOptions } from "../../config";
import { providerApiKeyEnv } from "../router";

// R-c-1：provider 单价表 + provider 元数据。
//
// 现状（R-a 留下的诚实占位）：`Usage.costUsd` 恒为 `null`——openai_compat.ts 的
// `usageOf()` 拿到了 token 数也不填价格，注释写明「单价表由 lane R-c 接入 registry」。
// 这份文件不改 openai_compat.ts（不属于本 lane 所有权）：`costUsd` 的计算发生在
// `../budget.ts` 的 `BudgetLedger.record()` 里——它拿到一次 `Usage`（可能已带
// `inputTokens`/`outputTokens` 但 `costUsd:null`）之后，查这张表把 token 换算成美元。
// 这样 `LlmResponse` 本身继续保持「诚实的 null」，而账本在事后核算，两者不冲突。
//
// **铁律**：查不到单价（provider/model 不在表里，或表里的数字本身就没写来源）一律
// 返回 `null`，绝不返回 0 或猜一个近似值——一个没有出处的数字比 `null` 更危险，
// 因为它看起来像「已核实」。

export interface ModelPricing {
  /** 每 100 万 input token 的美元价。 */
  inputPerMillionUsd: number;
  /** 每 100 万 output token 的美元价。 */
  outputPerMillionUsd: number;
  /** 定价页 URL，供复核——没有来源的数字不许进这张表。 */
  source: string;
  /** WebSearch 核实的日期（ISO date）。定价会变，没写核实日期的数字比 null 更糟。 */
  verifiedDate: string;
  /** 核实时发现的注意事项（如「取峰值价作保守估计」），会被 budget.ts 忽略但留给人读。 */
  note?: string;
}

// ── 内置单价表 ──────────────────────────────────────────────────────────────
//
// 全部于 2026-09-10 用 WebSearch 核实（OpenAI 官方文档页 WebFetch 直接抓取；
// DeepSeek 官方 api-docs 页 WebFetch 直接抓取；Kimi/Moonshot 与 Qwen/DashScope
// 因官方逐模型定价子页需要登录/反爬无法直接抓取全文，交叉核对了多篇独立聚合站
// 数据后取的一致值，标注为「多源交叉核实」而非「官方页直读」）。
//
// **已知的模型清单陈旧问题**（如实记录，不在本 lane 修复——`PROVIDER_MODELS` 在
// `router.ts`，不属于本 lane 所有权）：
//   - `PROVIDER_MODELS.kimi` = ["kimi-k2", "moonshot-v1-32k", "moonshot-v1-8k"]。
//     WebSearch 核实：这三个模型名已于 2026-08-31 被 Moonshot 官方**全部退役**（现在
//     请求会 404）。给一个已经 404 的模型名编报价毫无意义——本表改为对 Moonshot 直连
//     API **当前在售**的模型名（`kimi-k2.6` / `kimi-k3`）定价，因为 `providerForModel()`
//     的启发式兜底（`low.includes("kimi")`）会让任何带 "kimi" 的模型名路由到 kimi
//     provider，所以这两个名字实际可达。`PROVIDER_MODELS.kimi` 里那三个死名字则不收录
//     （查不到就是查不到，不编造）。已记入 docs/devlog/P11-c.md 交给主会话处理模型清单。
//   - `PROVIDER_MODELS.qwen` = ["qwen3", "qwen-max"]。"qwen3" 不是一个可计价的具体
//     SKU——DashScope 把它拆成 qwen3-235b-a22b / qwen3-32b / qwen3-30b-a3b / ... 一堆
//     不同尺寸型号，且部分还分 thinking/non-thinking 两档输出价。没有单一「qwen3」价格
//     可查，本表对 "qwen3" 不收录（同样如实返回 null，不用任何一个子型号的价格去顶替）。
export const PRICING: Readonly<Record<string, Readonly<Record<string, ModelPricing>>>> = {
  openai: {
    "gpt-4o": {
      inputPerMillionUsd: 2.5,
      outputPerMillionUsd: 10,
      source: "https://developers.openai.com/api/docs/pricing",
      verifiedDate: "2026-09-10",
    },
    "gpt-4o-mini": {
      inputPerMillionUsd: 0.15,
      outputPerMillionUsd: 0.6,
      source: "https://developers.openai.com/api/docs/pricing",
      verifiedDate: "2026-09-10",
    },
    "o4-mini": {
      inputPerMillionUsd: 1.1,
      outputPerMillionUsd: 4.4,
      source: "https://developers.openai.com/api/docs/pricing",
      verifiedDate: "2026-09-10",
    },
  },
  deepseek: {
    // 官方页原文只有 deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp
    // 三个模型，且是峰谷分时计价（01:00-04:00、06:00-10:00 UTC 为峰值，其余为谷值，
    // 谷值=峰值的一半）。`ModelPricing` 只能存一个数——这里**取峰值价**（更贵的那档）
    // 作保守估计：BudgetLedger 是用来防超支的，宁可把成本算高，也不要因为谷值时段
    // 算出的低价而低估真实花费触发不了预算上限。cache-hit 价也不收录（Usage 类型没有
    // 区分 cache 命中与否，一律按 cache-miss 计，同样是保守方向）。
    // `deepseek-chat`/`deepseek-reasoner` 是 `PROVIDER_MODELS.deepseek` 里的旧别名，
    // 三方信源称已计划于 2026-07-24 退役并指向 v4-flash 的非思考/思考两档——退役状态
    // 未被官方页正面确认，这里按「大概率仍可用、指向 v4-flash」处理，取 v4-flash 峰值价。
    "deepseek-chat": {
      inputPerMillionUsd: 0.44,
      outputPerMillionUsd: 1.32,
      source: "https://api-docs.deepseek.com/quick_start/pricing/",
      verifiedDate: "2026-09-10",
      note: "取峰值（06:00-10:00/01:00-04:00 UTC）价作保守估计；deepseek-chat 是旧别名，按指向 deepseek-v4-flash 处理，谷值价为此价的一半。",
    },
    "deepseek-reasoner": {
      inputPerMillionUsd: 0.44,
      outputPerMillionUsd: 1.32,
      source: "https://api-docs.deepseek.com/quick_start/pricing/",
      verifiedDate: "2026-09-10",
      note: "取峰值价作保守估计；deepseek-reasoner 是旧别名，按指向 deepseek-v4-flash（思考模式）处理——官方页未区分思考/非思考两档价格，两者用同一单价。",
    },
    "deepseek-v4-flash": {
      inputPerMillionUsd: 0.44,
      outputPerMillionUsd: 1.32,
      source: "https://api-docs.deepseek.com/quick_start/pricing/",
      verifiedDate: "2026-09-10",
      note: "取峰值价作保守估计，谷值价为此价的一半。",
    },
    "deepseek-v4-pro": {
      inputPerMillionUsd: 1.32,
      outputPerMillionUsd: 3.96,
      source: "https://api-docs.deepseek.com/quick_start/pricing/",
      verifiedDate: "2026-09-10",
      note: "取峰值价作保守估计，谷值价为此价的一半。",
    },
  },
  kimi: {
    // 见上方大注释：PROVIDER_MODELS.kimi 里的三个模型名已退役，这里改为对当前在售的
    // kimi-k2.6 / kimi-k3 定价（多篇独立聚合站交叉核实，非官方页直读，如实标注）。
    "kimi-k2.6": {
      inputPerMillionUsd: 0.95,
      outputPerMillionUsd: 4.0,
      source: "https://platform.kimi.ai/docs/pricing（逐模型定价子页需登录，未能直接抓取；已用 openrouter.ai/moonshotai/kimi-k2.6、pricepertoken.com、tokenmix.ai 等多源交叉核实一致）",
      verifiedDate: "2026-09-10",
      note: "多源交叉核实，非 Moonshot 官方页直接抓取；官方页若与此不符以官方为准。",
    },
    "kimi-k3": {
      inputPerMillionUsd: 3.0,
      outputPerMillionUsd: 15.0,
      source: "https://platform.kimi.ai/docs/pricing（逐模型定价子页需登录，未能直接抓取；已用 benchlm.ai、wan27.org 等多源交叉核实一致）",
      verifiedDate: "2026-09-10",
      note: "多源交叉核实，非 Moonshot 官方页直接抓取；官方页若与此不符以官方为准。",
    },
  },
  qwen: {
    // "qwen3" 不收录（见上方大注释）。qwen-max 用国际（新加坡）网关基础档价——
    // 官方页有超长上下文的阶梯加价（32K-128K / 128K-256K 更贵），这里只存基础档，
    // BudgetLedger 按基础档估算，长上下文请求的真实成本会被低估，如实记录这个已知简化。
    "qwen-max": {
      inputPerMillionUsd: 1.6,
      outputPerMillionUsd: 6.4,
      source: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
      verifiedDate: "2026-09-10",
      note: "国际（新加坡）网关基础档（<32K 上下文）价；32K-128K 涨到 $2.4/$12，128K-256K 涨到 $3/$15，本表不按上下文分档，是已知简化。",
    },
  },
  // openrouter：转发层，同一个模型名背后可能路由到不同上游主机，价格因模型而异，
  // 没有「一张表覆盖所有模型」这回事。这里只收 DEFAULT_MODEL 这一个已核实条目
  // （直接源自 OpenRouter 自己的模型页，不是从 Moonshot 官方页转手）——
  // 其余任何经 openrouter 请求的模型一律查不到，`priceFor` 返回 null，
  // 比照抄一个不对应的模型价格更诚实。
  openrouter: {
    "moonshotai/kimi-k2.6": {
      inputPerMillionUsd: 0.58,
      outputPerMillionUsd: 3.4,
      source: "https://openrouter.ai/moonshotai/kimi-k2.6",
      verifiedDate: "2026-09-10",
      note: "OpenRouter 自己挂牌价，与 Moonshot 直连 API 价不同（转发层通常有独立定价），按各自 provider+model 组合分别存放，不混用。",
    },
    "z-ai/glm-5.3-flash": {
      // 挂牌价 $0.075/$0.25 × 1.055：OpenRouter 充值收 5.5% 手续费，摊进单价作保守
      // 估计（对齐 deepseek 条目「取峰值价作保守估计」的先例）。BudgetLedger 用这里的
      // 数判 maxCostUsd，宁可略高估不可低估——预算闸的语义是「确定没超」。
      inputPerMillionUsd: 0.0791,
      outputPerMillionUsd: 0.2638,
      source: "https://openrouter.ai/z-ai/glm-5.3-flash",
      verifiedDate: "2026-09-11",
      note: "挂牌价 $0.075/M 输入、$0.25/M 输出，另含 5.5% 充值手续费摊入（×1.055）。v0.6 B2 轮次的指定模型。",
    },
  },
  // V94（v0.8 G-4）：anthropic 五条，2026-09-11 WebFetch 直读官方定价页
  // https://platform.claude.com/docs/en/about-claude/pricing 的 Model pricing 表（基础价，非 batch/cache）。
  // 注意：Claude 4.7 及之后模型（Opus 5 / Sonnet 5）用新 tokenizer，同一文本约多出 30% token——
  // usage 按 API 回报的 token 数计价不受影响，但 `estimateCallCostUsd` 的字符启发式对它们会偏低估。
  anthropic: {
    "claude-opus-5": {
      inputPerMillionUsd: 5,
      outputPerMillionUsd: 25,
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      verifiedDate: "2026-09-11",
      note: "官方页直读。Fast mode（speed:\"fast\"）为 $10/$50，本适配器不发该参数。",
    },
    "claude-sonnet-5": {
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 10,
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      verifiedDate: "2026-09-11",
      note: "官方页直读；页面注明 $2/$10 的上市价已成为标准价，原定 2026-09-01 涨到 $3/$15 取消。",
    },
    "claude-haiku-4-5-20251001": {
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 5,
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      verifiedDate: "2026-09-11",
    },
    "claude-sonnet-4-5": {
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      verifiedDate: "2026-09-11",
      note: "PROVIDER_MODELS 里沿用的别名；官方页仍列为在售。",
    },
    "claude-opus-4-5": {
      inputPerMillionUsd: 5,
      outputPerMillionUsd: 25,
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      verifiedDate: "2026-09-11",
      note: "PROVIDER_MODELS 里沿用的别名；官方页仍列为在售。",
    },
  },
  // kimi/openrouter 之外的 provider（如未来的 anthropic）由各自的 lane 在合入时补充；
  // 本地端点（`local/<model>`）不进这张表——自建/本地服务器没有统一定价，价格是
  // 用户自己的硬件成本，`priceFor("local", ...)` 恒返回 null。
};

/**
 * provider → 用于鉴权的环境变量名。与 `router.ts` 里 `ADAPTERS[provider].envKey`
 * 的真实取值**手工保持同步**（`router.ts` 的 `ADAPTERS` 是私有的，没有导出这张映射，
 * 而本 lane 不允许改 router.ts——见 docs/devlog/P11-a.md 的 provider/envKey 表格）。
 * 这是本 lane 已知的、有意为之的一处小重复：`tests/unit/capabilities.test.ts` 的
 * 一致性测试只能核对「provider id 集合」而不能核对「id → envKey 对不对」，
 * 如果 router.ts 未来给某个 provider 换一个不同的 envKey 名字，这里会静默过期——
 * 已记入 docs/devlog/P11-c.md，交给主会话评估是否值得为此单独导出一个只读映射。
 */
// **不再手工维护**：这张映射的真源是 router 的 ADAPTERS（provider 注册表本身）。
// P11 收口实证：手工副本在接线 anthropic 时立刻失同步，capabilities 的一致性断言当场变红。
// 从真源派生之后，「加了 provider 忘了更新映射」在结构上不可能发生。
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = providerApiKeyEnv();

/**
 * 单价可被 config 覆盖（`SPARK_LLM_PRICING_JSON`，见 `config/index.ts` 的
 * `llmPricingOverridesJson` 设置项）——定价会变，内置表有核实日期但终究会过期，
 * 长期漂移应该靠覆盖一个 JSON 而不是等下一次 lane 改代码。
 *
 * 格式：`{"<provider>:<model>": {"inputPerMillionUsd": n, "outputPerMillionUsd": n}}`。
 * `source`/`verifiedDate` 在覆盖项里可选——覆盖就是用户自己核实过的，不强制格式对称。
 *
 * **格式错误时的处理**：解析失败（不是合法 JSON，或某一项缺 input/output 数字）→
 * 整个覆盖被忽略，退回内置表，**不是**部分生效、也不是让 `costUsd` 变成一个基于
 * 半解析数据算出的可疑数字。`parsePricingOverridesJson` 把这个决定暴露出来
 * （`ok:false` 时调用方能看到具体原因），不是纯粹静默吞掉。
 */
export interface PricingOverridesResult {
  ok: boolean;
  overrides: Readonly<Record<string, ModelPricing>>;
  error: string | null;
}

export function parsePricingOverridesJson(raw: string | null | undefined): PricingOverridesResult {
  if (!raw) return { ok: true, overrides: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      overrides: {},
      error: `SPARK_LLM_PRICING_JSON 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, overrides: {}, error: "SPARK_LLM_PRICING_JSON 必须是一个对象（键为 \"provider:model\"）" };
  }
  const overrides: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as Record<string, unknown>).inputPerMillionUsd !== "number" ||
      typeof (value as Record<string, unknown>).outputPerMillionUsd !== "number"
    ) {
      return {
        ok: false,
        overrides: {},
        error: `SPARK_LLM_PRICING_JSON 的键 '${key}' 缺 inputPerMillionUsd/outputPerMillionUsd（均须为 number）`,
      };
    }
    const v = value as { inputPerMillionUsd: number; outputPerMillionUsd: number; source?: unknown; verifiedDate?: unknown; note?: unknown };
    overrides[key] = {
      inputPerMillionUsd: v.inputPerMillionUsd,
      outputPerMillionUsd: v.outputPerMillionUsd,
      source: typeof v.source === "string" ? v.source : "config 覆盖（SPARK_LLM_PRICING_JSON），未提供来源",
      verifiedDate: typeof v.verifiedDate === "string" ? v.verifiedDate : "未提供",
      ...(typeof v.note === "string" ? { note: v.note } : {}),
    };
  }
  return { ok: true, overrides, error: null };
}

const PRICING_OVERRIDE_SETTING_KEY = "llmPricingOverridesJson";

/**
 * 查一个 provider/model 的单价。**查不到就是 null，不返回 0，不模糊匹配猜相近型号**
 * ——config 覆盖优先于内置表；覆盖 JSON 格式错误时静默降级回内置表（错误原因见
 * `parsePricingOverridesJson`，`priceFor` 本身不抛异常，保持「查价格不该让调用方
 * 多包一层 try/catch」）。
 */
export function priceFor(provider: string, model: string, options: ConfigOptions = {}): ModelPricing | null {
  const rawOverride = resolveSetting(PRICING_OVERRIDE_SETTING_KEY, options);
  const overrideRaw = typeof rawOverride.value === "string" ? rawOverride.value : null;
  const { overrides } = parsePricingOverridesJson(overrideRaw);
  const key = `${provider}:${model}`;
  if (overrides[key]) return overrides[key]!;
  return PRICING[provider]?.[model] ?? null;
}

// ── W8-1 ζ：embedding 单价表 ─────────────────────────────────────────────────
//
// 与上面的 `PRICING`（chat，input/output 两档）刻意分开：embedding 调用只有一个
// token 计数（`llm/embeddings/types.ts` 的 `EmbedUsage.tokens`，OpenAI 兼容响应的
// `usage.total_tokens`），没有 input/output 之分，硬塞进 `ModelPricing` 会让
// `outputPerMillionUsd` 变成一个没有意义、迟早被误读的字段。

export interface EmbeddingPricing {
  /** 每 100 万 token 的美元价。 */
  perMillionUsd: number;
  /** 定价页 URL，供复核——没有来源的数字不许进这张表。 */
  source: string;
  /** WebSearch/WebFetch 核实的日期（ISO date）。 */
  verifiedDate: string;
  note?: string;
}

// 2026-09-12 WebFetch 直读官方定价页 Embedding models 一节（Standard 价，非 batch）。
// `llm/embeddings/router.ts` 的 `EMBEDDING_BASE_URLS` 目前只登记了 openai / qwen 两个云端
// provider（+ local）；qwen（DashScope）官方定价页没有单列 text-embedding 系列的美元单价子页，
// 多方聚合站也查不到一致数字——**查不到就是查不到，不编造**，本表不收录 qwen，`embeddingPriceFor`
// 对它恒返回 null（不是免费）。`local` 端点同 chat 侧 `PRICING` 的惯例，恒不收录（用户自己的硬件成本）。
export const EMBEDDING_PRICING: Readonly<Record<string, Readonly<Record<string, EmbeddingPricing>>>> = {
  openai: {
    "text-embedding-3-small": {
      perMillionUsd: 0.02,
      source: "https://developers.openai.com/api/docs/pricing",
      verifiedDate: "2026-09-12",
    },
    "text-embedding-3-large": {
      perMillionUsd: 0.13,
      source: "https://developers.openai.com/api/docs/pricing",
      verifiedDate: "2026-09-12",
    },
  },
};

/**
 * 查一个 provider/model 的 embedding 单价。**查不到就是 null，不返回 0**——同 `priceFor` 的铁律。
 * `model` 传裸模型名（不带 provider 前缀），即 `llm/embeddings/router.ts` 的 `wireModel`，
 * 不是 `EmbedResponse.model` 回报的 `"<provider>/<model>"` 完整 id——调用方（`llm/embeddings.ts`）
 * 负责用 `parseEmbeddingModelId` 拆开后再查。
 *
 * **没有 config 覆盖机制**（与 `priceFor` 不同）：`priceFor` 的 `SPARK_LLM_PRICING_JSON` 覆盖
 * 要经 `resolveSetting()`，而那要求 key 先注册进 `config/index.ts` 的 `CONFIG_SETTINGS`——
 * `config/index.ts` 不在本 lane 允许改动的文件列表里（见 docs/devlog/W8-zeta.md），加一个新覆盖项
 * 需要先在那边注册 key/envVar，属于收口范围。任务书本身也没要求 embedding 单价可覆盖，
 * 所以这里先做成纯静态查表，覆盖能力留给收口按需决定要不要补。
 */
export function embeddingPriceFor(provider: string, model: string): EmbeddingPricing | null {
  return EMBEDDING_PRICING[provider]?.[model] ?? null;
}

/**
 * embedding「能力位」：哪些 provider 有 OpenAI 兼容的 `/embeddings` 端点。
 *
 * **已知的手工重复，有意为之**：真源是 `llm/embeddings/router.ts` 的 `EMBEDDING_BASE_URLS`
 * （+ 它另外硬编码的 `"local"`）。这里不 import 它——`embeddings/router.ts` 已经反过来 import
 * 本文件的 `PROVIDER_API_KEY_ENV`（拿 chat provider 的鉴权环境变量名），两边互相 import
 * 会成环。两难之下选择手工同步 + 如实记录风险（与上面 `PROVIDER_API_KEY_ENV` 那段注释同一个
 * 决策模式），而不是为了消除一处重复去拆真源模块引入不必要的重构半径。
 * 改 `EMBEDDING_BASE_URLS` 的 provider 集合时记得同步这里——`tests/unit/w8_zeta_embeddings.test.ts`
 * 有一条一致性断言，两边 provider 集合对不上就红。
 */
export const EMBEDDING_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(["openai", "qwen", "local"]);

export function supportsEmbeddings(provider: string): boolean {
  return EMBEDDING_CAPABLE_PROVIDERS.has(provider);
}
