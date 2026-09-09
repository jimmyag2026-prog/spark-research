import { Hono } from "hono";
import { SESSION_MODES, type SessionMode } from "../../agents/orchestrator";
import { CoExploreError } from "../../ideation/coexplore";
import { HttpError, type ServerContext } from "../context";
import { sseResponse } from "../sse";
import type { TaskEvent } from "../tasks";
import { jsonBody, optionalString, queryNumber, queryString, requireString } from "./shared";

// 会话端点（chat / coexplore）与任务流。
//
// **关于「流式」的诚实口径**：orchestrator 目前不是 token 级流式的（模型调用一次性返回）。
// 所以 SSE 上跑的是**生命周期事件**：start → progress（阶段）→ result（完整正文）→ done。
// 传输层已经就位，将来 agent 支持增量输出时直接往 `delta` 事件里塞即可，
// 不会因此改变前端的连接方式。把已完成的正文切成假 token 往外吐是自欺，不做。

function parseMode(raw: string | undefined): SessionMode | undefined {
  if (raw === undefined) return undefined;
  if (!(SESSION_MODES as readonly string[]).includes(raw)) {
    throw new HttpError(400, `未知会话模式 '${raw}'（可用: ${SESSION_MODES.join(", ")}）`);
  }
  return raw as SessionMode;
}

export function sessionRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/modes", (c) => c.json({ modes: SESSION_MODES, default: "chat" }));

  app.post("/chat", async (c) => {
    const body = await jsonBody(c);
    const sessionId = requireString(body, "sessionId");
    const message = requireString(body, "message");
    const mode = parseMode(optionalString(body, "mode"));
    let result: Awaited<ReturnType<typeof ctx.agent.chat>>;
    try {
      result = await ctx.agent.chat({
        sessionId,
        message,
        model: optionalString(body, "model"),
        mode,
      });
    } catch (error) {
      // 模型两次都产不出合契约的 Idea 卡：服务端没坏，是这次生成不可用 → 422 而不是 500。
      if (error instanceof CoExploreError) throw new HttpError(422, error.message);
      throw error;
    }
    return c.json({
      sessionId,
      mode: mode ?? "chat",
      projectSlug: ctx.agent.projectForSession(sessionId)?.slug ?? null,
      ...result,
    });
  });

  app.post("/stream", async (c) => {
    const body = await jsonBody(c);
    const sessionId = requireString(body, "sessionId");
    const message = requireString(body, "message");
    const mode = parseMode(optionalString(body, "mode")) ?? "chat";
    const model = optionalString(body, "model");

    return sseResponse(
      (sender) => {
        sender.send("start", { sessionId, mode, at: new Date().toISOString() });
        void (async () => {
          try {
            sender.send("progress", { message: mode === "coexplore" ? "共探中" : "规划与执行中" });
            const result = await ctx.agent.chat({ sessionId, message, model, mode });
            sender.send("result", {
              sessionId,
              mode,
              projectSlug: ctx.agent.projectForSession(sessionId)?.slug ?? null,
              ...result,
            });
          } catch (error) {
            sender.send("error", { message: error instanceof Error ? error.message : String(error) });
          } finally {
            sender.send("done", { sessionId });
            sender.close();
          }
        })();
      },
      { heartbeatMs: ctx.sseHeartbeatMs, signal: c.req.raw.signal },
    );
  });

  app.get("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const slug = ctx.projects.sessionProjectSlug(sessionId);
    if (!slug) return c.json({ sessionId, projectSlug: null, records: [], artifacts: [] });
    return ctx.withProject(slug, (scope) => {
      return c.json({
        sessionId,
        projectSlug: scope.project.slug,
        records: scope.project.records().list({ sessionId }),
        artifacts: scope.project.artifacts().listBySession(sessionId),
      });
    });
  });

  return app;
}

export function taskRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const limit = queryNumber(c, "limit") ?? 50;
    return c.json({
      tasks: ctx.tasks.list({ project: queryString(c, "project"), limit }),
    });
  });

  app.get("/:id", (c) => {
    const task = ctx.tasks.get(c.req.param("id"));
    if (!task) throw new HttpError(404, `task '${c.req.param("id")}' 不存在`);
    return c.json({ task });
  });

  app.get("/:id/stream", (c) => {
    const id = c.req.param("id");
    const task = ctx.tasks.get(id);
    if (!task) throw new HttpError(404, `task '${id}' 不存在`);
    return sseResponse(
      (sender) => {
        const forward = (event: TaskEvent) => {
          sender.send(event.type, event);
          if (event.type === "state" && (event.data as { state?: string })?.state !== "running") {
            sender.send("done", { id, state: (event.data as { state?: string }).state });
            sender.close();
          }
        };
        const subscription = ctx.tasks.subscribe(id, forward);
        if (!subscription) {
          sender.send("error", { message: `task '${id}' 不存在` });
          sender.close();
          return;
        }
        // 补历史：晚订阅的客户端也拿得到开头的事件（任务可能已经跑完了）。
        for (const event of subscription.history) sender.send(event.type, event);
        const current = ctx.tasks.get(id);
        if (current && current.state !== "running" && current.state !== "pending") {
          sender.send("done", { id, state: current.state });
          sender.close();
        }
        return subscription.cancel;
      },
      { heartbeatMs: ctx.sseHeartbeatMs, signal: c.req.raw.signal },
    );
  });

  return app;
}
