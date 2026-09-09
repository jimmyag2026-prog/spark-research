import { llmFailure } from "../types";
import type { CallOptions, ChatMessage, LlmErrorKind, LlmResponse, ProviderCapabilities } from "../types";

// provider 适配层的契约（P11 接口先行）。
//
// 为什么要这一层：v0.3.1 的实测是「`SUPPORTED_PROVIDERS` 声明 6 个，`call()` 里只有
// kimi / openrouter 两个实现，其余静默落到 OpenRouter 或失败」——而「模型中立」
// 恰恰是 OpenScience 最被引用的卖点。把 provider 做成显式适配器，
// 「声明了几个」与「实现了几个」就不可能再分家（narrative_parity 门禁也能核它）。
//
// 分工（v0.4 方案 §5.1）：
//   - openai_compat.ts —— 一套代码覆盖 openai / deepseek / qwen / kimi / openrouter /
//     ollama / vLLM / 任意自建 baseUrl。**「模型中立」的真正落点在这里**。
//   - anthropic.ts —— 原生 messages API：tool_use / tool_result 的形状与 OpenAI 不同，
//     硬套 openai_compat 只会把两边都写脏，所以独立一份。

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  options: CallOptions;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export interface ProviderAdapter {
  readonly id: string;
  /** 随 capabilities 透出；调用方据此决定能不能跑 tool loop。 */
  capabilities(model: string): ProviderCapabilities;
  /**
   * 发起一次调用。**约定：任何失败都返回 `ok:false` 的 LlmResponse，不抛异常**——
   * 抛异常会让调用方回到「try/catch 里拿不到 provider/model/usage」的老路。
   * 实现必须保证 `ok:false ⇒ content === ""`（AD-13），错误只放 `error`。
   */
  call(request: ProviderRequest): Promise<LlmResponse>;
}

/** 构造失败响应的唯一入口——保证 AD-13 的不变式不被某个 provider 忘记。 */
export function failure(
  provider: string,
  model: string,
  error: { kind: LlmErrorKind; message: string; retryable: boolean },
): LlmResponse {
  return llmFailure({ provider, model, ...error });
}
