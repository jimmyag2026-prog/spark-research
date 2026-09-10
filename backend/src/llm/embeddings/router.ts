import { configuredLlmTimeoutMs, resolveSetting, type ConfigOptions } from "../../config";
import { NativeHttp, type HttpClient } from "../../http/client";
import { PROVIDER_API_KEY_ENV } from "../providers/registry";
import { OpenAiCompatEmbeddingAdapter } from "./openai_compat";
import { embedFailure, embedOk, type EmbedResponse, type EmbeddingAdapter } from "./types";

// C4 · EmbeddingRouter（v0.5 §1.2.1 / §2.8）。
//
// 配置项 `embeddingModel` 形如 `openai/text-embedding-3-small` / `local/nomic-embed-text`：
// **第一段是 provider，其余是发给上游的真实模型名**（与 chat 侧 `local/<model>` 的显式前缀
// 路由同一套写法）。不配 = null = novelty 走词面（§1.2.4）。

/** provider → embedding 端点 baseUrl。 */
export const EMBEDDING_BASE_URLS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  // 阿里云 DashScope 的 OpenAI 兼容模式（中国大陆网关，与 chat 侧 router.ts 同一个）。
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
};

/**
 * 这张表**不是** chat 侧 `llm/router.ts` 那张 `ADAPTERS` 的副本，两者刻意分开：
 *
 *   ① 「能聊天」不蕴含「能算向量」。anthropic 至今**没有** embedding API（官方文档指向
 *      第三方）；deepseek / openrouter 同样不提供 `/v1/embeddings`。把 chat 的 provider
 *      列表直接拿来当 embedding 列表，等于对着一个不存在的端点发请求，然后拿一个
 *      404 去解释成「模型不支持」。这里只登记**确实有这个端点**的 provider，
 *      其余走可见的 `unsupported` 失败，写明支持哪几个。
 *   ② 凭据环境变量仍从**真源派生**（`PROVIDER_API_KEY_ENV` ← chat router 的 ADAPTERS），
 *      不手抄第二份 —— 那正是 P11 收口踩过的坑。
 *
 * **已核实程度（如实）**：`local`（Ollama 兼容层）在本机实测过 `/v1/embeddings`；
 * `openai` / `qwen` 两条按各自公开文档的兼容端点写，本 lane **没有 key、未实测**，
 * 也因此不会给它们登记语义阈值（未标定 ⇒ novelty 强制词面，见 calibration.ts）。
 */
const LOCAL_PROVIDER = "local";
const LOCAL_BASE_URL_ENV = "SPARK_LOCAL_LLM_BASE_URL";
const LOCAL_API_KEY_ENV = "SPARK_LOCAL_LLM_API_KEY";

export const EMBEDDING_MODEL_SETTING_KEY = "embeddingModel";

export interface ParsedEmbeddingModel {
  provider: string;
  /** 剥掉 provider 前缀后发给上游的模型名。 */
  wireModel: string;
}

/** `"<provider>/<model>"` → 两段。没有 `/` 或任一段为空 → null（不猜 provider）。 */
export function parseEmbeddingModelId(modelId: string): ParsedEmbeddingModel | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  const provider = modelId.slice(0, slash).trim();
  const wireModel = modelId.slice(slash + 1).trim();
  if (!provider || !wireModel) return null;
  return { provider, wireModel };
}

export function supportedEmbeddingProviders(): string[] {
  return [LOCAL_PROVIDER, ...Object.keys(EMBEDDING_BASE_URLS)].sort();
}

export interface EmbeddingRouterOptions extends ConfigOptions {
  http?: HttpClient;
  /** 兼容 §2.8 的签名；给了就包成 HttpClient（生产路径一律走 HttpClient，见 types.ts 注释）。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 显式覆盖 config 的 embeddingModel（测试注入用；生产路径不传）。 */
  modelId?: string | null;
}

export class EmbeddingRouter {
  private readonly env: Record<string, string | undefined>;
  private readonly http: HttpClient;
  private readonly timeoutMs: number;
  private readonly configOptions: ConfigOptions;
  private readonly overrideModelId: string | null | undefined;

  constructor(opts: EmbeddingRouterOptions = {}) {
    this.env = opts.env ?? process.env;
    this.http = opts.http ?? (opts.fetchImpl ? fetchBackedHttp(opts.fetchImpl) : new NativeHttp());
    this.configOptions = { root: opts.root, env: this.env, warn: opts.warn };
    this.timeoutMs = opts.timeoutMs ?? configuredLlmTimeoutMs(120_000, this.configOptions);
    this.overrideModelId = opts.modelId;
  }

  /** config `embeddingModel` 解析结果；null = 未配置（novelty 走词面）。 */
  modelId(): string | null {
    if (this.overrideModelId !== undefined) return this.overrideModelId;
    const resolved = resolveSetting(EMBEDDING_MODEL_SETTING_KEY, this.configOptions);
    return typeof resolved.value === "string" && resolved.value.trim() !== "" ? resolved.value.trim() : null;
  }

  configured(): boolean {
    return this.modelId() !== null;
  }

  /** provider 的 API key 环境变量名（本地端点用 SPARK_LOCAL_LLM_API_KEY）。未登记的 provider 为 null。 */
  static apiKeyEnvFor(provider: string): string | null {
    if (provider === LOCAL_PROVIDER) return LOCAL_API_KEY_ENV;
    return PROVIDER_API_KEY_ENV[provider] ?? null;
  }

  async embed(texts: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<EmbedResponse> {
    const modelId = this.modelId();
    if (modelId === null) {
      return embedFailure({
        provider: "none",
        model: "",
        kind: "unsupported",
        message:
          `未配置 embeddingModel（env SPARK_RESEARCH_EMBEDDING_MODEL 或 config.json 的 ` +
          `${EMBEDDING_MODEL_SETTING_KEY}）——本机没有语义相似度能力`,
      });
    }

    const parsed = parseEmbeddingModelId(modelId);
    if (!parsed) {
      return embedFailure({
        provider: "unknown",
        model: modelId,
        kind: "unsupported",
        message: `embeddingModel '${modelId}' 不是 '<provider>/<model>' 形状（例如 local/nomic-embed-text）`,
      });
    }

    const { provider, wireModel } = parsed;
    let baseUrl: string;
    let apiKey: string | null;

    if (provider === LOCAL_PROVIDER) {
      const configured = this.env[LOCAL_BASE_URL_ENV];
      if (!configured) {
        return embedFailure({
          provider,
          model: modelId,
          kind: "auth",
          message:
            `embeddingModel '${modelId}' 以 local/ 开头，但没设置 ${LOCAL_BASE_URL_ENV}——` +
            "本地端点（ollama / vLLM / 任意自建 OpenAI 兼容服务）需要先设这个环境变量指向其 baseUrl",
        });
      }
      baseUrl = configured;
      // 本地端点允许空 key（很多本地服务不校验）。
      apiKey = this.env[LOCAL_API_KEY_ENV] ?? null;
    } else {
      const registered = EMBEDDING_BASE_URLS[provider];
      if (!registered) {
        return embedFailure({
          provider,
          model: modelId,
          kind: "unsupported",
          message:
            `provider '${provider}' 没有 OpenAI 兼容的 embedding 端点。` +
            `本仓库支持：${supportedEmbeddingProviders().join(" / ")}`,
        });
      }
      baseUrl = registered;
      const envVar = EmbeddingRouter.apiKeyEnvFor(provider);
      const key = envVar ? this.env[envVar] : undefined;
      if (!key) {
        return embedFailure({
          provider,
          model: modelId,
          kind: "auth",
          message: `provider '${provider}' 需要 ${envVar ?? "API key"}，当前未配置`,
        });
      }
      apiKey = key;
    }

    if (texts.length === 0) {
      return embedOk({ provider, model: modelId, vectors: [] });
    }

    const adapter: EmbeddingAdapter = new OpenAiCompatEmbeddingAdapter({ id: provider });
    const chunks = chunkByCharBudget(texts, adapter.batchLimit(), EMBED_BATCH_CHARS);
    const vectors: number[][] = [];
    let tokens = 0;
    let usageUnavailable = false;

    for (let batch = 0; batch < chunks.length; batch++) {
      const chunk = chunks[batch]!;
      const response = await adapter.embed({
        model: wireModel,
        input: chunk,
        apiKey,
        baseUrl,
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
        http: this.http,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!response.ok) {
        // 分批里任何一批失败 ⇒ **整次失败**。半批向量拼出来的相似度矩阵是残缺的，
        // 而残缺处会静默变成「不相似」，那正是 AD-13 要禁止的「失败还报成功」。
        return embedFailure({
          provider,
          model: modelId,
          kind: response.error.kind,
          message:
            chunks.length > 1
              ? `第 ${batch + 1} 批（共 ${chunks.length} 批）失败：${response.error.message}`
              : response.error.message,
          retryable: response.error.retryable,
        });
      }
      vectors.push(...response.vectors);
      tokens += response.usage.tokens;
      if (response.usage.usageUnavailable) usageUnavailable = true;
    }

    const dims = vectors[0]?.length ?? 0;
    if (vectors.some((v) => v.length !== dims)) {
      return embedFailure({
        provider,
        model: modelId,
        kind: "parse",
        message: "跨批返回了维度不一致的向量（上游可能在中途换了模型）",
      });
    }

    // `model` 一律回报**带 provider 前缀的完整 id**：阈值登记表（calibration.ts）用的是
    // 这个 id，回报 wireModel 会让「用哪个模型标定的」在下游对不上。
    return embedOk({
      provider,
      model: modelId,
      vectors,
      usage: { tokens, costUsd: null, usageUnavailable: usageUnavailable || tokens === 0 },
    });
  }
}

/**
 * 一批请求的**字符预算**。
 *
 * 这不是拍的：本机 Ollama（0.12.10 + bge-m3）在「一次塞 4 条 1000+ 字符的标题+摘要」时
 * 会让模型 runner 进程直接死掉，端点回 `HTTP 500 ... /embedding: EOF`——即上游的批大小
 * 限制是**按 token 总量**而不是按条数算的，只卡 `batchLimit` 条数根本挡不住。
 * 3000 字符 ≈ 1000 token 量级，实测 40 篇论文 + 30 条 claim 全量录制零失败。
 *
 * 单条超预算时**不切分文本**（截断会悄悄改变语义，标定就白做了），单独成一批发出去。
 */
export const EMBED_BATCH_CHARS = 3000;

/** 按「条数上限 + 字符预算」双约束分批；单条超预算时自己成一批。确定性：同一个输入永远切成同一批。 */
export function chunkByCharBudget(texts: string[], countLimit: number, charBudget: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of texts) {
    const wouldExceed = current.length > 0 && (current.length >= countLimit || chars + text.length > charBudget);
    if (wouldExceed) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 只在调用方按 §2.8 传了 `fetchImpl` 时用：把裸 fetch 包成 HttpClient。 */
function fetchBackedHttp(fetchImpl: typeof fetch): HttpClient {
  return {
    async request(url, init = {}) {
      const response = await fetchImpl(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      const contentType = response.headers.get("content-type");
      if (contentType !== null) headers["content-type"] = contentType;
      const { BufferedResponse } = await import("../../http/client");
      return new BufferedResponse({ status: response.status, headers, url, body });
    },
  };
}
