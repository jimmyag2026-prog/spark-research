import { Hono } from "hono";
import { resolveSetting } from "../../../config";
import type { ServerContext } from "../../context";
import { configOptions, handleSettingWrite, toItem } from "./general";
import { panel, queryFlag, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// local-models 面板：本地 / 自建 OpenAI 兼容端点（ollama / vLLM / 任意自建服务）。
//
// `?probe=1` 会真去 `GET <baseUrl>/v1/models`（3s 超时）——「配了地址」与「那台机器
// 真的在跑」是两件事，只显示前者就是在替用户猜。key 走凭据面板，不在这里写。
//
// **不做模型拉取**（Ollama pull，§九 明确不做）。

const PROBE_TIMEOUT_MS = 3_000;

const META: SettingsMeta = {
  level: "reduced",
  summary: "本地 / 自建 LLM 端点的 baseUrl 与连通性",
  notes: [
    "不做模型拉取（Ollama pull）——v0.9 明确不做",
    "端点的 API key 在「凭据」面板写，这里只显示配没配",
    "本地端点是显式 opt-in：模型名要写成 local/<真实模型名>，不会有任何隐式回退",
  ],
};

export interface LocalProbeResult {
  ok: boolean;
  /** 探到的模型名；失败时为空数组。 */
  models: string[];
  /** 失败原因摘要——只有状态码/错误类型，不含响应体，更不含凭据。 */
  error: string | null;
  elapsedMs: number;
}

/** 真探一次本地端点。任何失败都归一成一句话，**不把上游响应体透出来**。 */
export async function probeLocalEndpoint(baseUrl: string): Promise<LocalProbeResult> {
  const started = Date.now();
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) {
      return { ok: false, models: [], error: `HTTP ${response.status}`, elapsedMs: Date.now() - started };
    }
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(body.data)
      ? body.data.map((m) => String(m?.id ?? "")).filter(Boolean).sort()
      : [];
    return { ok: true, models, error: null, elapsedMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.name : "未知错误";
    return {
      ok: false,
      models: [],
      error: message === "TimeoutError" ? `超过 ${PROBE_TIMEOUT_MS}ms 未返回` : `连不上（${message}）`,
      elapsedMs: Date.now() - started,
    };
  }
}

async function buildItems(ctx: ServerContext, probe: boolean): Promise<SettingsItem[]> {
  const opts = configOptions(ctx);
  const baseUrlSetting = resolveSetting("SPARK_LOCAL_LLM_BASE_URL", opts);
  const keySetting = resolveSetting("SPARK_LOCAL_LLM_API_KEY", opts);
  const baseUrl = typeof baseUrlSetting.value === "string" ? baseUrlSetting.value : null;

  const probeResult = probe && baseUrl ? await probeLocalEndpoint(baseUrl) : null;

  const base = toItem(baseUrlSetting);
  return [
    {
      ...base,
      label: "本地端点 baseUrl",
      nextStep: baseUrl
        ? base.nextStep
        : "填入形如 http://127.0.0.1:11434/v1 的地址后，模型名用 `local/<真实模型名>` 调用",
      extra: { ...base.extra, probe: probeResult },
    },
    {
      ...toItem(keySetting),
      label: "本地端点 API key",
      editable: false,
      nextStep: keySetting.configured
        ? null
        : "很多本地服务不校验凭据，可以不填；真要填请走「凭据」面板",
    },
  ];
}

export function localRoutes(ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/local", async (c) => panel(c, "local", await buildItems(ctx, queryFlag(c, "probe")), META));

  app.put("/local", (c) =>
    handleSettingWrite(c, ctx, "local", "SPARK_LOCAL_LLM_BASE_URL", META, undefined, ["baseUrl"]),
  );

  return app;
}
