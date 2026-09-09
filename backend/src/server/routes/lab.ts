import { Hono } from "hono";
import { LabSafetyError } from "../../lab/orchestrator";
import { DEFAULT_WET_BACKEND, WET_BACKEND_IDS, wetBackend } from "../../lab/wet_backend";
import {
  ApprovalRequiredError,
  WET_EXPERIMENT_STATES,
  WET_LEGAL_TRANSITIONS,
  WET_TERMINAL_STATES,
  WetExperimentNotFoundError,
  WetStateError,
  isWetExperimentState,
  type WetExperimentState,
  type WetExperimentView,
} from "../../lab/wet_models";
import { HttpError, type ServerContext } from "../context";
import { jsonBody, optionalString, projectSlug, queryString, requireString, taskResponse } from "./shared";

// 湿实验端点（P6 的 `spark-research lab` 的 HTTP 投影 · AD-6）。
//
// **approve gate 在 HTTP 层同样是硬门**，而且比 CLI 更严：
// CLI 的 `resolveActor` 在没给 --actor 时会落到 $USER——那是诚实的，就是这个人在这台机器上敲的命令。
// HTTP 不能这么做：服务进程的 OS 用户与点「批准」的人没有任何关系。
// 所以 HTTP 层**要求 actor 必填**，缺了就是 400，并且 actorSource 记为 `http:explicit`，
// 审计时能一眼分出「网页批的」与「命令行批的」。

function viewJson(view: WetExperimentView): Record<string, unknown> {
  const { record: _record, ...rest } = view;
  return rest;
}

// 审批人：HTTP 层不许有 env 兜底。
function requireActor(body: Record<string, unknown>): { actor: string; actorSource: string } {
  const actor = body.actor;
  if (typeof actor !== "string" || actor.trim() === "") {
    throw new HttpError(400, "approve/reject 必须记名：请求体缺少 actor（HTTP 层不从环境变量猜审批人）");
  }
  return { actor: actor.trim(), actorSource: "http:explicit" };
}

function mapLabError(error: unknown): never {
  if (error instanceof WetExperimentNotFoundError) throw new HttpError(404, error.message);
  if (error instanceof ApprovalRequiredError) throw new HttpError(403, error.message);
  if (error instanceof WetStateError) throw new HttpError(409, error.message);
  if (error instanceof LabSafetyError) throw new HttpError(422, error.message, { report: error.report });
  throw error;
}

export function labRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  // 状态机视图：UI 的底部实验面板照这张表画停留态与合法动作。
  app.get("/machine", (c) =>
    c.json({
      mode: "wet",
      states: WET_EXPERIMENT_STATES,
      transitions: WET_LEGAL_TRANSITIONS,
      terminal: WET_TERMINAL_STATES,
      // AD-6 的机器可读表达：必须停下来等人的状态，以及两道门各自唯一的入边。
      //
      // D-10 起 wet_run 拆成 approved / executing，于是门也变成两道：
      //   approvalGate  —— 人工审批：awaiting_approval → approved（唯一入边，必须记名）
      //   executionGate —— 执行权原子声明：approved → executing（唯一入边，CAS 抢占）
      // 后者是「approval 一次性消费」的机器可读形态：执行权一旦声明，approval 即被消费，
      // 重跑必须重新审批。两道门的 from/to 都从 WET_LEGAL_TRANSITIONS 推得出来，
      // 这里写成显式字段是为了让外部调用方不必自己反推。
      awaiting: "awaiting_approval",
      approvalGate: { from: "awaiting_approval", to: "approved", requires: ["actor"] },
      executionGate: { from: "approved", to: "executing", consumesApproval: true },
    }),
  );

  app.get("/backends", async (c) => {
    const entries = [];
    for (const id of WET_BACKEND_IDS) {
      const backend = ctx.deps.wetBackend?.id === id ? ctx.deps.wetBackend : wetBackend(id);
      const status = await backend.available();
      entries.push({
        id,
        description: backend.description,
        ok: status.ok,
        reason: status.reason,
        default: id === DEFAULT_WET_BACKEND,
      });
    }
    return c.json({ backends: entries, default: DEFAULT_WET_BACKEND });
  });

  app.get("/experiments", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const state = queryString(c, "state");
      if (state && !isWetExperimentState(state)) {
        throw new HttpError(400, `未知状态 '${state}'（可用：${WET_EXPERIMENT_STATES.join(", ")}）`);
      }
      const views = scope.wetLoop().list({ state: state as WetExperimentState | undefined });
      return c.json({ project: scope.project.slug, experiments: views.map(viewJson) });
    });
  });

  // 新建 + 编译 + 安全门，一步走到 awaiting_approval —— 绝不自动执行（与 CLI compile 同口径）。
  app.post("/experiments", async (c) => {
    const body = await jsonBody(c);
    const naturalLanguage = requireString(body, "naturalLanguage");
    const title = optionalString(body, "title") ?? naturalLanguage.slice(0, 32);
    const hypothesis = optionalString(body, "hypothesis");
    const fromDry = optionalString(body, "fromDry");

    return ctx.withProject(projectSlug(c), async (scope) => {
      const loop = scope.wetLoop();
      try {
        let view: WetExperimentView;
        let derived: { id: string; state: string } | null = null;
        if (fromDry) {
          const result = await loop.deriveFromDry(scope.dryLoop(), fromDry, {
            title,
            naturalLanguage,
            hypothesis,
          });
          view = result.wet;
          derived = result.dry;
        } else {
          view = loop.design({ title, naturalLanguage, hypothesis });
        }
        view = loop.compile(view.id).view;
        const checked = loop.safetyCheck(view.id);
        return c.json(
          {
            project: scope.project.slug,
            experiment: viewJson(checked.view),
            safetyReport: checked.report,
            derivedFromDry: derived,
            // 提示语在 API 层也说一遍：调用方（含 UI）不该自己发明「可以执行了」的结论。
            next: "awaiting_approval —— 安全门通过 ≠ 可以执行，需要人工 approve（AD-6）",
          },
          201,
        );
      } catch (error) {
        if (error instanceof LabSafetyError) {
          // 安全门拦截：实验已被标 failed，把报告如实回给调用方（422 而不是 500）。
          throw new HttpError(422, error.message, {
            report: error.report,
            blocked: error.report.checks.filter((check) => !check.passed),
          });
        }
        mapLabError(error);
      }
    });
  });

  app.get("/experiments/:id", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      try {
        const view = scope.wetLoop().get(c.req.param("id"));
        return c.json({ project: scope.project.slug, experiment: viewJson(view) });
      } catch (error) {
        mapLabError(error);
      }
    });
  });

  app.post("/experiments/:id/compile", async (c) => {
    const body = await jsonBody(c);
    return ctx.withProject(projectSlug(c), (scope) => {
      const loop = scope.wetLoop();
      try {
        const compiled = loop.compile(c.req.param("id"), {
          naturalLanguage: optionalString(body, "naturalLanguage"),
        });
        const checked = loop.safetyCheck(compiled.view.id);
        return c.json({
          project: scope.project.slug,
          experiment: viewJson(checked.view),
          safetyReport: checked.report,
          // 重新编译一律作废先前的 approve（AD-6 落地口径），API 明说，UI 不用猜。
          approvalCleared: true,
        });
      } catch (error) {
        if (error instanceof LabSafetyError) {
          throw new HttpError(422, error.message, { report: error.report });
        }
        mapLabError(error);
      }
    });
  });

  app.post("/experiments/:id/approve", async (c) => {
    const body = await jsonBody(c);
    const signer = requireActor(body);
    return ctx.withProject(projectSlug(c), (scope) => {
      try {
        const { view, decisionId } = scope.wetLoop().approve(c.req.param("id"), {
          actor: signer.actor,
          actorSource: signer.actorSource,
          note: optionalString(body, "note"),
        });
        return c.json({
          project: scope.project.slug,
          experiment: viewJson(view),
          decisionId,
          decision: scope.project.records().get(decisionId),
        });
      } catch (error) {
        mapLabError(error);
      }
    });
  });

  app.post("/experiments/:id/reject", async (c) => {
    const body = await jsonBody(c);
    const signer = requireActor(body);
    const reason = requireString(body, "reason");
    return ctx.withProject(projectSlug(c), (scope) => {
      try {
        const { view, decisionId } = scope.wetLoop().reject(c.req.param("id"), {
          actor: signer.actor,
          actorSource: signer.actorSource,
          reason,
        });
        return c.json({
          project: scope.project.slug,
          experiment: viewJson(view),
          decisionId,
          decision: scope.project.records().get(decisionId),
        });
      } catch (error) {
        mapLabError(error);
      }
    });
  });

  app.post("/experiments/:id/simulate", async (c) => {
    const body = await jsonBody(c);
    const ref = c.req.param("id");
    const note = optionalString(body, "note");
    const claim = optionalString(body, "conclude");
    const slug = projectSlug(c) ?? null;

    return taskResponse(c, ctx, body, {
      kind: "lab.simulate",
      project: slug,
      run: async (task) => {
        const scope = ctx.openProject(slug);
        try {
          const loop = scope.wetLoop();
          task.progress(0, 3, "执行协议");
          let view = await loop.execute(ref, { note });
          task.progress(1, 3, `回收 ${view.runLogEntryCount ?? 0} 条 run log`);
          view = loop.analyze(view.id, { note });
          task.progress(2, 3, `observation ${view.observationId?.slice(0, 8) ?? "—"}`);
          if (claim) view = loop.conclude(view.id, { claim });
          task.progress(3, 3, `状态 ${view.state}`);
          return { project: scope.project.slug, experiment: viewJson(view) };
        } finally {
          scope.dispose();
        }
      },
    });
  });

  return app;
}
