import { Hono } from "hono";
import type { ServerContext } from "../../context";
import { BAD_BODY, fail, panel, settingsBody, written, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta } from "./types";

// scientific-tools 面板：`capabilities --json` 的 connector / platform / wetBackend / rule 四段，
// `?probe=1` 走真探（spawn 子进程问本地仿真平台/湿实验后端装没装）。
//
// 写的那一半是 `PUT /api/settings/sources`：勾选默认检索源 → 写 `searchSources` 配置键。
// 勾掉一个源之后，不带 `--sources` 的检索真的不再查它（U6 · v0.9 DONE 第 7 条）。

const META: SettingsMeta = {
  level: "full",
  summary: "文献源、仿真平台、湿实验后端、评审规则：各自可用不可用，为什么",
  notes: [
    "?probe=1 才会 spawn 子进程真探本地平台；不带它是零 I/O 的静态清单",
    "需要 key 的源显示 `spark-research auth --connector <id>`，也可以在「凭据」面板直填",
  ],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "searchSources",
    label: "默认检索源",
    kind: "enum",
    value: "openalex,crossref",
    source: "default",
    configured: false,
    allowed: ["openalex", "crossref", "arxiv", "pubmed"],
    editable: true,
    summary: "`lit search` 不给 --sources 时查哪些源",
    nextStep: null,
    extra: { selected: ["openalex", "crossref"] },
  },
];

export function scientificToolsRoutes(_ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/scientific-tools", (c) => panel(c, "scientific-tools", FIXTURE, META));

  app.put("/sources", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "scientific-tools", FIXTURE[0]!, META);
  });

  return app;
}
