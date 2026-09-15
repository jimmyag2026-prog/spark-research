import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { dataDir, resolveSetting } from "../../../config";
import { exportProject } from "../../../data/export";
import { ProjectError } from "../../../project/manager";
import type { ServerContext } from "../../context";
import { configOptions, handleSettingWrite, toItem } from "./general";
import { BAD_BODY, fail, panel, settingsBody, type SettingsRouteOptions } from "./shared";
import type { SettingsItem, SettingsMeta, SettingsTaskResponse } from "./types";

// storage 面板：工作区在哪、占了多少盘、原始层留不留、导出一份走人。
//
// **不做目录迁移**（上游有，我们本版不做，§九 明确不做）——`dataDir` 只读。
// 假装能在网页端换工作区，然后让用户发现旧项目没跟过去，比不提供这个按钮糟得多。

export const STORAGE_SWITCH_KEYS = ["rawLlm", "rawUpstreamInline"] as const;

const META: SettingsMeta = {
  level: "reduced",
  summary: "工作区在哪、占了多少盘、原始层留不留、导出一份走人",
  notes: [
    "不做目录迁移：dataDir 只读，换工作区请设 SPARK_RESEARCH_DATA_DIR 后重启",
    "关掉 rawLlm 之后 LLM 原文不再落盘，归一化逻辑一改旧结果就无法重算——除非磁盘受限否则别关",
  ],
};

/**
 * 目录体积。递归 `statSync`，**失败一律当 0 并继续**——体积是给人看的参考值，
 * 不值得为了一个权限不足的子目录让整个面板 500。
 */
function dirBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(path, name);
    try {
      const st = statSync(full);
      total += st.isDirectory() ? dirBytes(full) : st.size;
    } catch {
      // 读不到就算了，别把一个面板拖垮。
    }
  }
  return total;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function buildItems(ctx: ServerContext): SettingsItem[] {
  const opts = configOptions(ctx);
  const root = ctx.deps.root ?? dataDir();
  const active = ctx.projects.list();
  const all = ctx.projects.list({ includeArchived: true });

  const projects = all.map((meta) => {
    const paths = ctx.projects.pathsFor(meta.slug);
    const raw = dirBytes(paths.rawDir);
    const records = fileBytes(paths.recordsDb) + fileBytes(paths.libraryDb) + fileBytes(paths.artifactsDb);
    return {
      slug: meta.slug,
      status: meta.status,
      rawBytes: raw,
      recordBytes: records,
      totalBytes: raw + records,
    };
  });

  const items: SettingsItem[] = [
    {
      key: "dataDir",
      label: "工作区目录",
      kind: "info",
      value: root,
      source: resolveSetting("dataDir", opts).source,
      configured: resolveSetting("dataDir", opts).configured,
      editable: false,
      summary: "一切持久化的根：projects/、credentials.json、config.json 全在它下面",
      nextStep: "换工作区请设环境变量 SPARK_RESEARCH_DATA_DIR 后重启 server——本版不做目录迁移",
      extra: {
        projects,
        totalBytes: projects.reduce((sum, p) => sum + p.totalBytes, 0),
        projectCount: all.length,
        archivedCount: all.length - active.length,
      },
    },
  ];
  for (const key of STORAGE_SWITCH_KEYS) {
    items.push(toItem(resolveSetting(key, opts)));
  }
  return items;
}

export function storageRoutes(ctx: ServerContext, _options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get("/storage", (c) => panel(c, "storage", buildItems(ctx), META));

  app.put("/storage/:key", (c) =>
    handleSettingWrite(c, ctx, "storage", c.req.param("key"), META, STORAGE_SWITCH_KEYS),
  );

  // 导出走长任务句柄（与其余长任务同一个出口），不在请求里同步跑完——
  // 一个上千条 record 的项目导出要几秒到几十秒，同步返回只会把浏览器挂住。
  app.post("/storage/export", async (c) => {
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    const slug = typeof body.project === "string" && body.project.trim() !== "" ? body.project.trim() : null;
    const forSharing = body.forSharing === true;
    try {
      // 先确认项目存在：不存在要当场 404，而不是发一个注定失败的任务句柄回去。
      const probe = slug ? ctx.projects.open(slug) : ctx.projects.defaultProject();
      const resolvedSlug = probe.slug;
      probe.close();
      const snapshot = ctx.tasks.start({
        kind: "data-export",
        project: resolvedSlug,
        run: async () => {
          const project = ctx.projects.open(resolvedSlug);
          try {
            return exportProject(project, { forSharing });
          } finally {
            project.close();
          }
        },
      });
      return c.json(
        {
          panel: "storage",
          task: { id: snapshot.id, kind: snapshot.kind, state: snapshot.state, project: snapshot.project },
        } satisfies SettingsTaskResponse,
        202,
      );
    } catch (error) {
      if (error instanceof ProjectError) {
        return fail(c, 404, error.message, "用 GET /api/projects 看有哪些项目");
      }
      throw error;
    }
  });

  return app;
}
