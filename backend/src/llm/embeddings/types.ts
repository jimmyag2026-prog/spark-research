import type { HttpClient } from "../../http/client";
import type { LlmError, LlmErrorKind } from "../types";
import { redactSecrets } from "../types";

// C4 · embedding 适配层的类型面（v0.5 §1.2.1 / §2.8）。
//
// **与 `ProviderAdapter` 同层，不同契约。** 刻意不让 `EmbeddingAdapter extends
// ProviderAdapter`：`ProviderRequest` 带 `messages/options/tools`，embedding 一个都用不上，
// 硬套只会造出一个「messages 恒空」的假请求。复用的是**基础设施而不是形状**：
//   - AD-13 的可辨识联合（`ok:false ⇒ vectors === null`，且 `error` 必填）
//   - `redactSecrets`（错误消息里绝不能出现凭据）
//   - `HttpClient`（走 `http/client.ts` 而不是裸 fetch —— `http/fixture.ts` 的录制回放
//     零改动可用，CI 因此不依赖网络；请求头永远不落盘，凭据结构上进不了 fixture）
//
// AD-13 在这里的具体形态：`ok:false` 分支的 `vectors` 类型是**字面量 `null`**、
// `dims` 是 `null`、`usage.tokens` 是字面量 `0`。于是「失败了但带着一批向量」
// 在编译期就构造不出来——下游不可能把失败当成一批可用的向量拿去算余弦。

export interface EmbedRequest {
  model: string;
  input: string[];
  /** 本地端点为 null（很多本地服务不校验凭据，此时不发 Authorization 头）。 */
  apiKey: string | null;
  baseUrl: string;
  timeoutMs: number;
  /** http/client.ts 的可注入 HTTP 层 —— 让 FixtureHttp 可注入。 */
  http: HttpClient;
  signal?: AbortSignal;
}

export interface EmbedUsage {
  tokens: number;
  /** 查不到单价就是 null。**绝不填 0 冒充免费**（同 llm/types.ts 的 Usage 纪律）。 */
  costUsd: number | null;
  /** 上游没报 usage 时为 true —— 让下游能区分「免费」与「不知道」。 */
  usageUnavailable?: boolean;
}

export type EmbedResponse =
  | {
      ok: true;
      provider: string;
      model: string;
      vectors: number[][];
      dims: number;
      usage: EmbedUsage;
      error?: undefined;
    }
  | {
      ok: false;
      provider: string;
      model: string;
      vectors: null;
      dims: null;
      usage: { tokens: 0; costUsd: null; usageUnavailable: true };
      error: LlmError;
    };

export interface EmbeddingAdapter {
  readonly id: string;
  /** 任何失败返回 ok:false，不抛异常（与 ProviderAdapter.call 同约定）。 */
  embed(request: EmbedRequest): Promise<EmbedResponse>;
  /** 一次请求最多塞几条文本；超过由调用方分批。 */
  batchLimit(): number;
}

/** 构造成功响应。`dims` 由第一条向量派生，调用方不必手写。 */
export function embedOk(args: {
  provider: string;
  model: string;
  vectors: number[][];
  usage?: Partial<EmbedUsage>;
}): EmbedResponse {
  return {
    ok: true,
    provider: args.provider,
    model: args.model,
    vectors: args.vectors,
    dims: args.vectors[0]?.length ?? 0,
    usage: {
      tokens: args.usage?.tokens ?? 0,
      costUsd: args.usage?.costUsd ?? null,
      usageUnavailable: args.usage?.usageUnavailable ?? true,
    },
  };
}

/** 构造失败响应的唯一入口 —— 保证 AD-13 的不变式不被某个 adapter 忘记。 */
export function embedFailure(args: {
  provider: string;
  model: string;
  kind: LlmErrorKind;
  message: string;
  retryable?: boolean;
}): EmbedResponse {
  return {
    ok: false,
    provider: args.provider,
    model: args.model,
    vectors: null,
    dims: null,
    usage: { tokens: 0, costUsd: null, usageUnavailable: true },
    error: {
      kind: args.kind,
      message: redactSecrets(args.message),
      retryable: args.retryable ?? false,
    },
  };
}

export type { LlmError };

/**
 * 余弦相似度。纯函数，数值由单测钉死。
 *
 * 两条刻意的决定：
 *   ① **维度不一致抛异常**。两个不同模型（或同模型不同版本）的向量混在一起算出来的数
 *      没有任何意义，静默返回一个数会让它一路流进阈值判定。这是编程错误，要当场炸。
 *   ② **零向量返回 0，不返回 1、也不返回 NaN**。零向量的方向未定义；把「方向未定义」
 *      解释成「完全相似」是最危险的一种沉默失败（provider 出故障吐全零 → 全判成相似
 *      → 所有 claim 都被判 existing）。返回 0 = 不相似，会让标定测试的正样本断言当场红，
 *      故障因此可见。（阴性对照 ②）
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: 向量维度不一致（${a.length} vs ${b.length}）——不同模型的向量不能混算`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
