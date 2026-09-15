import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// storage 面板：`dataDir` · 各项目 raw/ 与 records 体积 · `rawLlm` / `rawUpstreamInline` 两个开关
// · 已归档项目数 · 导出（= `data export`，返回任务句柄）。
//
// **不做目录迁移**（上游有，我们本版不做）——`dataDir` 只读，改它要重开 server。

export const STORAGE_SWITCH_KEYS = ["rawLlm", "rawUpstreamInline"] as const;

const META: SettingsMeta = {
  level: "reduced",
  summary: "工作区占了多少盘、原始层留不留、导出一份走人",
  notes: [
    "不做目录迁移：dataDir 只读，换工作区请设 SPARK_RESEARCH_DATA_DIR 后重启",
    "关掉 rawLlm 之后 LLM 原文不再落盘，旧结果无法重算——除非磁盘受限否则别关",
  ],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "rawLlm",
    label: "保留 LLM 原文",
    kind: "enum",
    value: "on",
    source: "default",
    configured: false,
    allowed: ["on", "off"],
    editable: true,
    summary: "是否把每次 LLM 调用的 prompt 与响应原文落进项目 raw/llm/",
    nextStep: null,
  },
];

export function storageRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/storage", (c) => panel(c, "storage", FIXTURE, META));

  app.put("/storage/:key", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "storage", FIXTURE[0]!, META);
  });

  app.post("/storage/export", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return c.json({
      panel: "storage",
      task: { id: "fixture", kind: "data-export", state: "running", project: null },
    });
  });

  return app;
}
