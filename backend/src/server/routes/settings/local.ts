import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// local-models 面板：本地 / 自建 OpenAI 兼容端点（ollama / vLLM / 任意自建服务）。
// `?probe=1` 会真去 `GET <baseUrl>/v1/models`（3s 超时），把模型列表如实带回来。
// key 走凭据面板，不在这里写。

const META: SettingsMeta = {
  level: "reduced",
  summary: "本地 / 自建 LLM 端点的 baseUrl 与连通性",
  notes: [
    "不做模型拉取（Ollama pull）——v0.9 明确不做",
    "端点的 API key 在「凭据」面板写，这里只显示配没配",
  ],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "SPARK_LOCAL_LLM_BASE_URL",
    label: "本地端点 baseUrl",
    kind: "string",
    value: null,
    source: "unset",
    configured: false,
    allowed: null,
    editable: true,
    summary: "本地/自建 OpenAI 兼容 LLM 端点的 baseUrl",
    nextStep: "填入形如 http://127.0.0.1:11434/v1 的地址后，模型名用 `local/<真实模型名>` 调用",
    extra: { probe: null },
  },
];

export function localRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/local", (c) => panel(c, "local", FIXTURE, META));

  app.put("/local", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "local", FIXTURE[0]!, META);
  });

  return app;
}
