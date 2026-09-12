import { redactSecrets } from "./types";
import { EmbeddingRouter, parseEmbeddingModelId, type EmbeddingRouterOptions } from "./embeddings/router";
import type { EmbedResponse } from "./embeddings/types";
import { embeddingPriceFor } from "./providers/registry";
import { USER_OWNED_LICENSE } from "../provenance/policy";
import type { RawSink } from "../raw";
import type { UsageStore } from "../usage/ledger";

// W8-1 ζ · V2 embedding 语义化——**成本入账层**（BACKLOG V2，docs/devlog/W8-zeta.md 有完整交代）。
//
// **这不是重新实现一遍 embedding 的 HTTP 适配。** `llm/embeddings/router.ts`
// （v0.5 W5-1 · C4 lane 交付，已被 `ideation/novelty.ts` 的 `applySemanticAffinity()` 在生产
// 路径上使用）已经是一套跑过真实 Ollama 端点、带批处理/维度校验/AD-13 失败契约的实现，
// `EmbedResponse.usage.tokens` 也已经在拿。再写一份平行的裸 fetch 客户端只会制造两套
// 语义早晚分叉的 embedding 实现——这正是 P11（provider 抽象）当初要避免的形状。
//
// 现状里**确实缺的那一半**：`EmbedUsage.costUsd` 恒为 `null`（`openai_compat.ts` 的注释原话
// 是「单价表由后续 lane 接入」——那个后续 lane 就是这里），从来没有一行落进 `usage.jsonl`，
// 也从来没有一条 raw 记录——一次 embedding 调用可能真的打了网络、真的花了钱，却在整套
// 台账系统里完全隐身。本文件补的就是这半截：**同一个 EmbeddingRouter 之上包一层**
// registry 单价查表 + `UsageStore.append` + raw `kind:"llm"`（`payload.options.endpoint`
// 标 `"embeddings"`，见下方 `recordAccounting` 的注释——`LlmPayload` 类型本身没有
// `endpoint` 字段，`raw/models.ts` 不在本 lane 的允许文件列表里，不新开字段）。
//
// **生产调用方**：`ideation/novelty.ts` 的 `NoveltyChecker.applySemanticAffinity()`——
// 默认构造语义 embedder 的那一行，从裸 `new EmbeddingRouter()` 换成本文件的
// `createTrackedEmbedder()`。返回给 novelty.ts 的仍是原样的 `Embedder`
// （`{ embed(texts): Promise<EmbedResponse>; modelId(): string | null }`）契约，
// `applySemanticAffinity()` 其余逻辑（降级判断、`EmbeddingState` 组装、报告渲染）
// 零改动——「无 key / 调用失败 → 走词面法且行为与 v0.7 逐字节一致」因此天然成立：
// 既有 novelty 单测全部显式注入 `embedder`（`null` 或 stub），从不落到这条默认分支，
// 一条不改就绿。

/** `embed()` 的成本入账目的地。不给 = 不记账（v0.7 行为，纯查询用途）。 */
export interface EmbedAccounting {
  store: UsageStore;
  /** 基础命令名；实际落 usage.jsonl 的 `command` 是 `${command}:embedding`（任务书原文）。 */
  command: string;
  rawSink?: RawSink;
  project?: string | null;
  sessionId?: string | null;
}

export interface EmbedTextsOptions {
  /** 测试注入位：满足 `EmbeddingRouter` 的 `embed`/`modelId` 子集即可，不必是真实 HTTP 客户端。 */
  router?: Pick<EmbeddingRouter, "embed" | "modelId">;
  /** 不传 router 时用它构造一个真实 `EmbeddingRouter`（转发 fixture http / 覆盖 modelId 等）。 */
  routerOptions?: EmbeddingRouterOptions;
  accounting?: EmbedAccounting;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EmbedUsageResult {
  /** 上游报的 token 数；usage 不可用时为 0（不是免费，是不知道，见 unpriced/costUsd）。 */
  tokens: number;
  /** 已知成本；null = usage 不可用，或 registry 查不到这个 provider/model 的单价。 */
  costUsd: number | null;
  /** true = registry 里没有这个 provider/model 的单价条目（`costUsd` 为 null 的原因之一）。 */
  unpriced: boolean;
}

/** 任务书原文的返回形状：成功一档 / `{ unavailable: reason }` 一档，reason 是人可读的失败原因。 */
export type EmbedTextsResult =
  | { vectors: number[][]; usage: EmbedUsageResult; provider: string; model: string }
  | { unavailable: string };

function isEmbedTextsFailure(result: EmbedTextsResult): result is { unavailable: string } {
  return "unavailable" in result;
}

/** 是否真的打了一次网络请求（用来决定要不要落账——见 recordAccounting 的注释）。 */
function attemptedNetwork(response: EmbedResponse): boolean {
  if (response.ok) return true;
  // "unsupported"（未配置 / provider 无 embedding 端点 / modelId 格式不对）与 "auth"
  // （缺 API key）两类在 EmbeddingRouter.embed() 里**发请求之前**就短路返回——
  // 这是绝大多数用户（没配 embeddingModel）的默认路径，每次 novelty check 都会打一遍，
  // 若也落一行 usage.jsonl，会把台账刷满「从未真正调用过」的幽灵行。只在真的碰了网络
  // （timeout/upstream/parse/rate_limit，或成功）时才入账。
  return response.error.kind !== "unsupported" && response.error.kind !== "auth";
}

/**
 * 一次调用的入账副作用：查单价、算成本、落 `UsageStore.append` 一行、
 * 有 `rawSink` 时再落 raw `kind:"llm"` 一行。**不抛异常**——入账失败不该打断真正的调用结果，
 * 但会把原因写进 console.warn（同仓库 `feedback_silent_fallback_logging` 纪律：降级要出声）。
 */
function recordAccounting(
  response: EmbedResponse,
  texts: string[],
  accounting: EmbedAccounting | undefined,
): EmbedUsageResult {
  if (!response.ok) {
    if (accounting && attemptedNetwork(response)) {
      try {
        appendUsage(accounting, response.provider, response.model, { inputTokens: 0, outputTokens: 0, costUsd: null, unpriced: false }, false);
        appendRaw(accounting, response, texts, null);
      } catch (error) {
        console.warn(`llm/embeddings.ts：入账失败被吞（调用结果不受影响）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { tokens: 0, costUsd: null, unpriced: false };
  }

  const parsed = parseEmbeddingModelId(response.model);
  const price = parsed ? embeddingPriceFor(parsed.provider, parsed.wireModel) : null;
  const unpriced = price === null;
  const costUsd =
    price !== null && !response.usage.usageUnavailable
      ? Math.round((response.usage.tokens / 1_000_000) * price.perMillionUsd * 1e8) / 1e8
      : null;
  const usage: EmbedUsageResult = { tokens: response.usage.tokens, costUsd, unpriced };

  if (accounting) {
    try {
      appendUsage(
        accounting,
        response.provider,
        response.model,
        { inputTokens: usage.tokens, outputTokens: 0, costUsd: usage.costUsd, unpriced: usage.unpriced },
        true,
      );
      appendRaw(accounting, response, texts, usage);
    } catch (error) {
      console.warn(`llm/embeddings.ts：入账失败被吞（调用结果不受影响）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return usage;
}

function appendUsage(
  accounting: EmbedAccounting,
  provider: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null; unpriced: boolean },
  ok: boolean,
): void {
  // embedding 只有一个 token 计数（没有「输出」）——按仓库既有 Usage 惯例，全部记进
  // `inputTokens`（调用方消耗的是输入侧 token），`outputTokens` 恒 0，在这一处如实注释，
  // 免得下游看 usage.jsonl 时误以为 embedding 也有「生成」token。
  accounting.store.append({
    ts: new Date().toISOString(),
    command: `${accounting.command}:embedding`,
    provider,
    model,
    ok,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    ...(usage.unpriced ? { unpriced: true } : {}),
  });
}

function appendRaw(
  accounting: EmbedAccounting,
  response: EmbedResponse,
  texts: string[],
  usage: EmbedUsageResult | null,
): void {
  if (!accounting.rawSink) return;
  accounting.rawSink.append({
    kind: "llm",
    project: accounting.project ?? undefined,
    sessionId: accounting.sessionId ?? null,
    command: `${accounting.command}:embedding`,
    provenanceClass: "model_generated",
    license: USER_OWNED_LICENSE,
    payload: {
      provider: response.provider,
      model: response.model,
      ok: response.ok,
      failureKind: response.ok ? null : response.error.kind,
      // `LlmPayload.messages` 是给 chat 消息设计的字段，这里没有更贴切的位置放「本次
      // embed 的输入文本」——复用它，内容是 texts 数组本身（脱敏一遍：embedding 输入
      // 理论上不该含凭据，但与 chat 路径同一条纪律，不假设）。
      messages: accounting.rawSink.body(redactSecrets(JSON.stringify(texts))),
      // 向量本身不落盘（体积大且对「过程留痕」没有增量价值）：只留条数/维度摘要。
      response: response.ok
        ? accounting.rawSink.body(JSON.stringify({ vectorCount: response.vectors.length, dims: response.dims }))
        : null,
      usage: {
        inputTokens: usage?.tokens ?? 0,
        outputTokens: 0,
        costUsd: usage?.costUsd ?? null,
        usageUnavailable: usage === null || (response.ok && response.usage.usageUnavailable === true),
      },
      // `LlmPayload.options` 是自由字段（`Record<string, unknown>`）——任务书要求的
      // `payload 标 endpoint:"embeddings"` 落在这里，而不是顶层新开字段（`raw/models.ts`
      // 的 `LlmPayload` 不在本 lane 允许改动的文件列表里）。
      options: { endpoint: "embeddings", textCount: texts.length },
    },
  });
}

/**
 * 任务书原文签名：`embed(texts): Promise<{vectors, usage, provider, model} | {unavailable: reason}>`。
 * 内部转发给 `EmbeddingRouter`（或注入的 `options.router`），成功/失败都会触发一次入账副作用
 * （`options.accounting` 给了才真的落盘）。
 */
export async function embedTexts(texts: string[], options: EmbedTextsOptions = {}): Promise<EmbedTextsResult> {
  const router = options.router ?? new EmbeddingRouter(options.routerOptions);
  const response = await router.embed(texts, { timeoutMs: options.timeoutMs, signal: options.signal });
  const usage = recordAccounting(response, texts, options.accounting);
  if (!response.ok) {
    return { unavailable: `${response.error.kind}: ${response.error.message}` };
  }
  return { vectors: response.vectors, usage, provider: response.provider, model: response.model };
}

/** `Embedder` 的字面契约（`ideation/novelty.ts` 定义为 `Pick<EmbeddingRouter, "embed" | "modelId">`，
 *  这里不 import 它——novelty.ts 不在本 lane 允许改动之外的引用会制造不必要的耦合方向，
 *  结构性相同即满足 TypeScript 的鸭子类型。 */
export interface TrackedEmbedder {
  embed(texts: string[]): Promise<EmbedResponse>;
  modelId(): string | null;
}

/**
 * `ideation/novelty.ts` 的 `applySemanticAffinity()` 默认构造语义 embedder 时改调用这个
 * （替换裸 `new EmbeddingRouter()`），返回值满足它现有的 `Embedder` 契约不变——
 * `.embed()` 仍然原样转发 `EmbedResponse`（`ok:false` 时的 `error.kind`/`retryable` 等
 * 结构化信息不丢，novelty.ts 的降级判断逻辑因此零改动），只是每次调用会顺带触发
 * `recordAccounting()`（`accounting` 未给时该函数是纯粹的直通，无副作用、无额外开销）。
 */
export function createTrackedEmbedder(
  options: { router?: Pick<EmbeddingRouter, "embed" | "modelId">; routerOptions?: EmbeddingRouterOptions; accounting?: EmbedAccounting } = {},
): TrackedEmbedder {
  const router = options.router ?? new EmbeddingRouter(options.routerOptions);
  return {
    modelId: () => router.modelId(),
    async embed(texts: string[]): Promise<EmbedResponse> {
      const response = await router.embed(texts);
      recordAccounting(response, texts, options.accounting);
      return response;
    },
  };
}
