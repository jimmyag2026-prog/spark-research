import { Hono } from "hono";
import { LibraryStore } from "../../literature/library";
import { ProjectError, type Project } from "../../project/manager";
import { HttpError, type ServerContext } from "../context";
import type { ProjectListResponse, ProjectSummary } from "../types";
import { jsonBody, optionalString, queryBool, requireString } from "./shared";

// 项目端点（P1 的 `spark-research project` 的 HTTP 投影）。
// 能力一一对应：list / new / open（= 设为当前）/ archive / current。

function summarize(ctx: ServerContext, project: Project): ProjectSummary {
  const records = project.records();
  const library = new LibraryStore(project.paths.libraryDb, { records });
  try {
    const papers = library.count();
    const ideas = records.count({ type: "idea" });
    const experiments = records.list({ type: "experiment" });
    const wet = experiments.filter((r) => (r.metadata as { mode?: string }).mode === "wet").length;
    return {
      ...project.meta,
      current: ctx.projects.currentSlug() === project.slug,
      counts: {
        records: records.count(),
        papers,
        ideas,
        dryExperiments: experiments.length - wet,
        wetExperiments: wet,
      },
      paths: {
        root: project.paths.root,
        papersDir: project.paths.papersDir,
        artifactsDir: project.paths.artifactsDir,
        experimentsDir: project.paths.experimentsDir,
      },
    };
  } finally {
    library.close();
  }
}

export function projectRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const projects = ctx.projects.list({ includeArchived: queryBool(c, "all") });
    return c.json({ projects, current: ctx.projects.currentSlug() } satisfies ProjectListResponse);
  });

  app.post("/", async (c) => {
    const body = await jsonBody(c);
    const slug = requireString(body, "slug");
    let project: Project;
    try {
      project = ctx.projects.create(slug, {
        name: optionalString(body, "name"),
        description: optionalString(body, "description"),
      });
    } catch (error) {
      if (error instanceof ProjectError) throw new HttpError(400, error.message);
      throw error;
    }
    try {
      // 与 CLI `project new` 一致：第一个项目自动成为当前项目；显式 setCurrent 让
      // 「新建后 UI 就切过去」不依赖那条隐式规则。
      if (body.setCurrent !== false) ctx.projects.setCurrent(project.slug);
      return c.json({ project: summarize(ctx, project) }, 201);
    } finally {
      project.close();
    }
  });

  // current 必须先于 /:slug 注册，否则会被当成 slug='current'。
  app.get("/current", (c) => {
    const slug = ctx.projects.currentSlug();
    if (!slug) {
      // 没有当前项目时按 CLI 的 defaultProject 语义兜底建默认项目，
      // 让 UI 首次打开就有一个可用的工作区，而不是一个死掉的空态。
      const fallback = ctx.projects.defaultProject();
      try {
        return c.json({ project: summarize(ctx, fallback) });
      } finally {
        fallback.close();
      }
    }
    const project = ctx.projects.open(slug);
    try {
      return c.json({ project: summarize(ctx, project) });
    } finally {
      project.close();
    }
  });

  app.post("/current", async (c) => {
    const body = await jsonBody(c);
    const slug = requireString(body, "slug");
    try {
      ctx.projects.setCurrent(slug);
    } catch (error) {
      if (error instanceof ProjectError) throw new HttpError(404, error.message);
      throw error;
    }
    const project = ctx.projects.open(slug);
    try {
      return c.json({ project: summarize(ctx, project) });
    } finally {
      project.close();
    }
  });

  app.get("/:slug", (c) => {
    const slug = c.req.param("slug");
    let project: Project;
    try {
      project = ctx.projects.open(slug);
    } catch (error) {
      if (error instanceof ProjectError) throw new HttpError(404, error.message);
      throw error;
    }
    try {
      return c.json({ project: summarize(ctx, project) });
    } finally {
      project.close();
    }
  });

  app.post("/:slug/archive", (c) => {
    const slug = c.req.param("slug");
    try {
      const meta = ctx.projects.archive(slug);
      return c.json({ project: meta });
    } catch (error) {
      if (error instanceof ProjectError) throw new HttpError(404, error.message);
      throw error;
    }
  });

  return app;
}
