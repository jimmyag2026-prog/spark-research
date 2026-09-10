import { HttpTimeoutError } from "../../http/client";
import { redactSecrets } from "../types";
import {
  embedFailure,
  embedOk,
  type EmbedRequest,
  type EmbedResponse,
  type EmbeddingAdapter,
} from "./types";

// OpenAI 兼容的 embedding 端点：`POST {baseUrl}/embeddings`
//   请求  { "model": "...", "input": ["...", "..."] }
//   响应  { "object": "list", "data": [{ "object": "embedding", "index": 0, "embedding": [...] }],
//           "model": "...", "usage": { "prompt_tokens": n, "total_tokens": n } }
//
// 这一套形状覆盖 openai / qwen(DashScope 兼容模式) / ollama / vLLM / 任意自建服务。
//
// **Ollama 的兼容层已在本机实测**（lane β 开工第一件事，v0.5 §1.2.1 要求）：
//   ollama 0.12.10 + nomic-embed-text，`POST /v1/embeddings` 返回 HTTP 200，
//   形状与上面完全一致（object=list，data[i].embedding 768 维，带 usage.prompt_tokens）。
//   核过了 ⇒ **不需要 `ollama_native.ts`**（`/api/embed` 那条路不实现），见 devlog W5-1-b。
//
// 与 `providers/openai_compat.ts`（chat）的关系：形状同源、代码不共用。
// chat 那条走裸 `fetchImpl`，这里走 `HttpClient` —— 因为 embedding 的真实调用必须能被
// `FixtureHttp` 录下来给 CI 回放（§1.2.3），而 fetchImpl 那条路没有录制层。

interface WireEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export interface OpenAiCompatEmbeddingOptions {
  id: string;
  /** 一次请求最多几条文本。默认 64：OpenAI 允许 2048，但小批量对本地端点更友好且 fixture 更小。 */
  batchLimit?: number;
  extraHeaders?: Record<string, string>;
}

export const DEFAULT_EMBED_BATCH_LIMIT = 64;

export class OpenAiCompatEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: string;
  private readonly limit: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAiCompatEmbeddingOptions) {
    this.id = options.id;
    this.limit = options.batchLimit ?? DEFAULT_EMBED_BATCH_LIMIT;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  batchLimit(): number {
    return this.limit;
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    const { model, input, apiKey, timeoutMs } = request;
    const fail = (kind: Parameters<typeof embedFailure>[0]["kind"], message: string, retryable = false) =>
      embedFailure({ provider: this.id, model, kind, message, retryable });

    if (input.length === 0) {
      return fail("unsupported", "input 为空：没有要嵌入的文本");
    }
    if (input.length > this.limit) {
      return fail("unsupported", `一次最多 ${this.limit} 条文本（收到 ${input.length} 条）；请由调用方分批`);
    }
    if (input.some((t) => t.trim() === "")) {
      // 空串在不同 provider 上行为不一（有的报 400、有的回全零向量）。全零向量是最危险的
      // 一种：它会让余弦恒为 0 而看起来「算过了」。当场拒绝，不让它进到向量层。
      return fail("unsupported", "input 里有空字符串：空文本没有可用的语义向量，请由调用方过滤");
    }

    const url = `${request.baseUrl.replace(/\/$/, "")}/embeddings`;
    const body = JSON.stringify({ model, input });

    let response;
    try {
      response = await request.http.request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // 本地端点允许空 key —— 不发一个空 Bearer 头，免得个别服务器把它当格式错误的凭据拒绝。
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...this.extraHeaders,
        },
        body,
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof HttpTimeoutError) {
        return fail("timeout", `请求超过 ${error.timeoutMs}ms 未返回`, true);
      }
      const message = error instanceof Error ? error.message : String(error);
      return fail("upstream", `网络层失败：${redactSecrets(message)}`, true);
    }

    if (!response.ok) {
      // 响应体可能回显请求内容（含鉴权头），过一遍脱敏再截断。
      const preview = redactSecrets((await response.text()).slice(0, 200));
      const kind =
        response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 429
            ? "rate_limit"
            : "upstream";
      return fail(
        kind,
        `HTTP ${response.status}${preview ? `: ${preview}` : ""}`,
        response.status === 429 || response.status >= 500,
      );
    }

    let data: WireEmbeddingResponse;
    try {
      data = (await response.json()) as WireEmbeddingResponse;
    } catch (error) {
      return fail("parse", `上游返回的不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, true);
    }

    const rows = data.data;
    if (!Array.isArray(rows)) {
      return fail("parse", "上游响应缺 `data` 数组");
    }
    if (rows.length !== input.length) {
      // 少一条就静默补零/错位是最难查的一类 bug：第 k 条 claim 会拿到第 k+1 条的向量。
      return fail("parse", `上游返回 ${rows.length} 条向量，与请求的 ${input.length} 条不符`);
    }

    // `index` 是 OpenAI 规范里给出的顺序字段——不假设数组本身有序。
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors: number[][] = [];
    for (let i = 0; i < ordered.length; i++) {
      const raw = ordered[i]!.embedding;
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((v) => typeof v === "number" && Number.isFinite(v))) {
        return fail("parse", `第 ${i} 条向量不是非空的有限数值数组`);
      }
      vectors.push(raw as number[]);
    }
    const dims = vectors[0]!.length;
    if (vectors.some((v) => v.length !== dims)) {
      return fail("parse", "同一次请求返回了维度不一致的向量");
    }

    const tokens = data.usage?.total_tokens ?? data.usage?.prompt_tokens;
    return embedOk({
      provider: this.id,
      model,
      vectors,
      usage:
        typeof tokens === "number"
          ? { tokens, costUsd: null, usageUnavailable: false }
          : // 上游没报 usage。**不填 0 冒充免费**（同 llm/types.ts 的纪律）。
            { tokens: 0, costUsd: null, usageUnavailable: true },
    });
  }
}
