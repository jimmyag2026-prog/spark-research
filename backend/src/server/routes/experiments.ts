import { Hono } from "hono";
import {
  EXPERIMENT_STATES,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  isExperimentState,
  type ExperimentState,
  type ExperimentView,
} from "../../experiment/models";
import { ExperimentNotFoundError } from "../../experiment/loop";
import { DEFAULT_SIMULATION_PLATFORM, SIMULATION_PLATFORM_IDS } from "../../simulation/registry";
import { HttpError, type ServerContext } from "../context";
import {
  jsonBody,
  optionalNumber,
  optionalString,
  projectSlug,
  queryString,
  requireString,
  taskResponse,
} from "./shared";

// 干实验端点（P5 的 `spark-research exp` 的 HTTP 投影）。
//
// `record` 字段在响应里剥掉（与 CLI 的 `--json` 同口径）：它是整条 record 的副本，
// 时间线端点已经提供，重复一份只会让前端两处状态打架。

function viewJson(view: ExperimentView): Record<string, unknown> {
  const { record: _record, ...rest } = view;
  return rest;
}

export function experimentRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  // 状态机视图：UI 的干实验面板照这张表画，不在前端另抄一份。
  app.get("/machine", (c) =>
    c.json({
      mode: "dry",
      states: EXPERIMENT_STATES,
      transitions: LEGAL_TRANSITIONS,
      terminal: TERMINAL_STATES,
      // 干实验没有停留态；等待发生在 dry_run 内部（任务在别的进程里跑）。
      awaiting: null,
    }),
  );

  app.get("/platforms", async (c) => {
    return ctx.withProject(projectSlug(c), async (scope) => {
      const registry = ctx.simulationRegistry(scope.project);
      return c.json({
        platforms: await registry.availability(),
        default: DEFAULT_SIMULATION_PLATFORM,
        ids: SIMULATION_PLATFORM_IDS,
      });
    });
  });

  app.get("/", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const state = queryString(c, "state");
      if (state && !isExperimentState(state)) {
        throw new HttpError(400, `未知状态 '${state}'（可用：${EXPERIMENT_STATES.join(", ")}）`);
      }
      const views = scope.dryLoop().list({
        state: state as ExperimentState | undefined,
        platform: queryString(c, "platform"),
      });
      return c.json({ project: scope.project.slug, experiments: views.map(viewJson) });
    });
  });

  app.post("/", async (c) => {
    const body = await jsonBody(c);
    const title = requireString(body, "title");
    const platform = optionalString(body, "platform") ?? DEFAULT_SIMULATION_PLATFORM;
    const params = (body.params ?? {}) as Record<string, unknown>;
    if (typeof params !== "object" || Array.isArray(params)) throw new HttpError(400, "params 必须是对象");
    const hypothesis = optionalString(body, "hypothesis");

    return ctx.withProject(projectSlug(c), async (scope) => {
      const loop = scope.dryLoop();
      const registry = ctx.simulationRegistry(scope.project);
      try {
        let kind = optionalString(body, "kind");
        if (!kind) {
          const kinds = (registry.get(platform) as { kinds?: readonly string[] }).kinds ?? [];
          if (kinds.length === 0) throw new Error(`平台 '${platform}' 没有可用的任务种类`);
          kind = kinds[0]!;
        }
        const view = await loop.design({ title, platform, kind, params, hypothesis });
        return c.json({ project: scope.project.slug, experiment: viewJson(view) }, 201);
      } catch (error) {
        // 参数写错/平台未知在 design 阶段就该被挡住（P5 纪律），并且是 400 不是 500。
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
    });
  });

  app.get("/:id", async (c) => {
    return ctx.withProject(projectSlug(c), async (scope) => {
      const loop = scope.dryLoop();
      try {
        const view = loop.get(c.req.param("id"));
        const runStatus = view.runId ? await loop.poll(view.id).catch(() => null) : null;
        return c.json({ project: scope.project.slug, experiment: viewJson(view), runStatus });
      } catch (error) {
        if (error instanceof ExperimentNotFoundError) throw new HttpError(404, error.message);
        throw error;
      }
    });
  });

  app.post("/:id/run", async (c) => {
    const body = await jsonBody(c);
    const ref = c.req.param("id");
    const resume = body.resume === true;
    const timeoutMs = optionalNumber(body, "timeoutMs");
    const pollIntervalMs = optionalNumber(body, "pollIntervalMs");
    const note = optionalString(body, "note");
    const claim = optionalString(body, "conclude");
    const slug = projectSlug(c) ?? null;

    return taskResponse(c, ctx, body, {
      kind: "exp.run",
      project: slug,
      run: async (task) => {
        const scope = ctx.openProject(slug);
        try {
          const loop = scope.dryLoop();
          let view = loop.get(ref);
          if (resume) {
            const resumed = await loop.resume(view.id);
            view = resumed.view;
            task.note(`恢复：${resumed.action}`, { action: resumed.action });
            if (resumed.action === "marked_failed") {
              throw new Error(view.lastError ?? "仿真已丢失或失败，已标记为 failed（可重试）");
            }
          }
          view = await loop.run(view.id, {
            timeoutMs,
            pollIntervalMs,
            analysisNote: note,
            onPoll: (status) => {
              task.progress(0, null, `run ${status.runId} ${status.state}`);
            },
          });
          if (claim) view = loop.conclude(view.id, { claim });
          task.progress(1, 1, `状态 ${view.state}`);
          return { project: scope.project.slug, experiment: viewJson(view) };
        } finally {
          scope.dispose();
        }
      },
    });
  });

  app.post("/:id/conclude", async (c) => {
    const body = await jsonBody(c);
    const claim = requireString(body, "claim");
    return ctx.withProject(projectSlug(c), (scope) => {
      try {
        const view = scope.dryLoop().conclude(c.req.param("id"), {
          claim,
          limitations: optionalString(body, "limitations"),
          confidence: optionalString(body, "confidence"),
        });
        return c.json({ project: scope.project.slug, experiment: viewJson(view) });
      } catch (error) {
        if (error instanceof ExperimentNotFoundError) throw new HttpError(404, error.message);
        throw new HttpError(409, error instanceof Error ? error.message : String(error));
      }
    });
  });

  return app;
}
