// W2-d（B-b `init` 向导）：provider 探测。
//
// P11 之后 provider 已经不是「装了 key 就等于能跑」这么简单——6 个云端 provider +
// 本地端点各自的能力位（tool calling / json 模式 / 流式 / usage 上报）不一样，
// `LLMRouter.capabilitiesFor(model)` 是运行时唯一真源（见 backend/src/llm/router.ts，
// 本 lane 只读不改）。向导的任务是**如实**转述这份信息，不是自己编一份。
//
// 关键陷阱（写在这里免得下一个人重踩）：`LLMRouter.resolve()` 在「优先 provider 没配 key」
// 时会**隐式回退**到任一已配置的 provider（避免调用方每次都要自己试全部 provider）。
// 如果不管三七二十一就拿 `capabilitiesFor(anyModel)` 去问某个未配置的 provider，
// 回退机制会让它看起来「有能力」——实际上问的是别的 provider。这里的做法是：
// 只有确认这个 provider 自己的环境变量已设置，才去查它的 capabilities（此时
// `resolve()` 走的是「优先命中」分支，不会绕道）；没配置就诚实报 `capabilities: null`，
// 不给「未配置」的 provider 编造一份能力清单。这正是阴性对照②要卡住的坑。
import { PROVIDER_API_KEY_ENV } from "../llm/providers/registry";
import { LLMRouter, PROVIDER_MODELS, SUPPORTED_PROVIDERS, type Provider } from "../llm/router";
import type { ProviderCapabilities } from "../llm/types";

export interface ProviderStatus {
  id: Provider;
  envVar: string;
  configured: boolean;
  /** 只有 `configured` 为 true 时才非 null——未配置的 provider 不编造能力位。 */
  capabilities: ProviderCapabilities | null;
}

export function detectProviders(env: Record<string, string | undefined> = process.env): ProviderStatus[] {
  const router = new LLMRouter(env);
  return SUPPORTED_PROVIDERS.map((id) => {
    const envVar = PROVIDER_API_KEY_ENV[id] ?? "(未知环境变量)";
    const configured = Boolean(env[envVar]);
    const model = PROVIDER_MODELS[id][0];
    return {
      id,
      envVar,
      configured,
      capabilities: configured && model ? router.capabilitiesFor(model) : null,
    };
  });
}

export interface LocalProbeResult {
  baseUrl: string;
  /** `SPARK_LOCAL_LLM_BASE_URL` 是否已经显式设置（区别于"用默认地址猜到的"）。 */
  configuredExplicitly: boolean;
  reachable: boolean;
  models: string[] | null;
  note: string;
}

// Ollama 的默认监听地址；`SPARK_LOCAL_LLM_BASE_URL` 未设时拿它来猜一下——
// 猜中了也只是「探测到能不能连上」，不代表 router 已经会把请求路由过去
// （路由仍然需要模型名带 `local/` 前缀 + 这个环境变量，见 router.ts 的 LOCAL_MODEL_PREFIX）。
const LOCAL_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const LOCAL_PROBE_TIMEOUT_MS = 800;

/**
 * 探测本地 Ollama（或任意实现了 `/api/tags` 的兼容服务）是否在跑。
 * 纯本地环回请求（不打公网），失败/超时都收敛成 `reachable: false`，绝不抛出。
 */
export async function detectLocalOllama(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalProbeResult> {
  const configuredBase = env.SPARK_LOCAL_LLM_BASE_URL;
  const baseUrl = (configuredBase ?? LOCAL_DEFAULT_BASE_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      return {
        baseUrl,
        configuredExplicitly: Boolean(configuredBase),
        reachable: false,
        models: null,
        note: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    return {
      baseUrl,
      configuredExplicitly: Boolean(configuredBase),
      reachable: true,
      models,
      note: configuredBase
        ? ""
        : `探测到本地服务在 ${baseUrl} 响应，但 SPARK_LOCAL_LLM_BASE_URL 未设置——` +
          `设置它之后可以用 local/<模型名> 调用（能力位保守上报：不支持工具调用/JSON 模式）`,
    };
  } catch (err) {
    return {
      baseUrl,
      configuredExplicitly: Boolean(configuredBase),
      reachable: false,
      models: null,
      note: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
