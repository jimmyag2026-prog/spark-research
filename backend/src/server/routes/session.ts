import { Hono } from "hono";
import { SESSION_MODES, type SessionMode } from "../../agents/orchestrator";
import { CoExploreError } from "../../ideation/coexplore";
import { HttpError, type ServerContext } from "../context";
import { sseResponse } from "../sse";
import type { TaskEvent } from "../tasks";
import { jsonBody, optionalString, queryNumber, queryString, requireString } from "./shared";

// 会话端点（chat / coexplore）与任务流。
//
// **关于「流式」的诚实口径（W1 期）**：orchestrator.chat() 本身不是 token 级流式的——
// `processRequest` 内部做任务分解 + 执行，往往是不止一次模型调用，`chat()` 也没有
// 接受 onDelta 回调的口子（backend/src/agents/** 不属于本 lane 所有权，这条 lane
// 不能替它加）。所以**权威回答**仍然只能是 start → progress → result → done 这条
// 生命周期事件链，`result` 依旧是一次性给完整正文——这一点没有变，也是
// `tests/unit/server_session.test.ts` 里「依次发 start → progress → result → done」
// 那条既有断言继续成立的原因（下面新加的 `delta` 事件只在真的发生流式调用时才会出现，
// 现有的 fake LLM 从不触发 onDelta，序列不受影响）。
//
// **W3 收口**：`chat()` 接受可选 `onDelta`（W3-a 交付），接到 `summarize()`——
// 唯一产出用户可见 `summary` 的 LLM 调用点。于是 `delta` 事件吐的就是**权威答案本身**
// 的增量。W2-d 当初那次「另发一次裸模型调用做预览」的绕道已删除（见下方 POST 处理器）。

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
    // 预览流默认开；调用方可显式 `{"preview": false}` 关掉（省一次模型调用——见上面
    // 大注释的代价说明）。只在 chat 模式尝试：coexplore 的 prompt/grounding 装配更复杂
    // （CoExploreSession，见 agents/orchestrator.ts），本 lane 不重新拼一份。
    // **W2 收口裁定：预览流默认关闭（`preview: true` 才开）。**
    //
    // **W3 收口：预览流已删除，改用 orchestrator 自己的 onDelta。**
    //
    // W2-d 当初为了做 SSE，在权威调用之外**另发一次裸模型调用**做「预览流」——
    // 那次调用发的是 `[{role:"user", content: message}]`（无 system prompt、无技能上下文、
    // 无 plan），跟走完整 orchestrator 管线（plan → execute → review）的权威答案
    // **是两个不同的回答**，不是同一个回答的两个阶段。用户会把先出现的那段读成答案，
    // 然后它被换掉；附带每次 chat 多花一次模型调用。W2 收口先把它默认关闭，
    // 根治留给 W3-a——现在 W3-a 已经让 `chat()` 接受可选的 `onDelta`，
    // 接到 `summarize()` 那一个 LLM 调用点（唯一产出用户可见 `summary` 的地方）。
    //
    // 于是这里吐出去的 `delta` **就是权威答案本身**在生成过程中的增量，
    // 不再需要「先给一段别的、再整体替换」。前端相应地改成累加即最终文本。

    return sseResponse(
      (sender) => {
        sender.send("start", { sessionId, mode, at: new Date().toISOString() });
        void (async () => {
          try {
            sender.send("progress", { message: mode === "coexplore" ? "共探中" : "规划与执行中" });
            const result = await ctx.agent.chat({
              sessionId,
              message,
              model,
              mode,
              // 权威答案的流式增量。provider 不支持流式、或注入的 fake LLM 不调 onDelta 时，
              // 这里就是从不触发——SSE 退化成「只有 result」，与接线前行为一致，不报错。
              onDelta: (chunk: string) => {
                if (!sender.closed) sender.send("delta", { chunk });
              },
            });
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
    if (!task) throw new HttpError(404, `task '${c.req.param("id")}' 不存在（任务句柄存在 server 进程内存里，只在本次连接/进程存活期间有效；若连接断过，干实验用 exp_list + exp_run --resume 接回，文献类长任务需重跑）`);
    return c.json({ task });
  });

  app.get("/:id/stream", (c) => {
    const id = c.req.param("id");
    const task = ctx.tasks.get(id);
    if (!task) throw new HttpError(404, `task '${id}' 不存在（任务句柄存在 server 进程内存里，只在本次连接/进程存活期间有效；若连接断过，干实验用 exp_list + exp_run --resume 接回，文献类长任务需重跑）`);
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
          sender.send("error", { message: `task '${id}' 不存在（任务句柄存在 server 进程内存里，只在本次连接/进程存活期间有效；若连接断过，干实验用 exp_list + exp_run --resume 接回，文献类长任务需重跑）` });
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
