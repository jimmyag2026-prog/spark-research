import { Hono } from "hono";
import { SESSION_MODES, type SessionMode } from "../../agents/orchestrator";
import { CoExploreError } from "../../ideation/coexplore";
import type { CallOptions } from "../../llm/types";
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
// **W2-d（P14）新增的是一层「预览流」**：`mode === "chat"` 且请求没有显式关掉
// （`preview !== false`）时，在权威调用之前，先用同一个 router 依赖发**一次独立的、
// 真正流式的**模型调用（P11 的 `CallOptions.onDelta`，backend/src/llm/providers/*
// 已经实现），逐块把 `delta` 事件吐给前端做「实时预览」——不是把权威结果切成假
// token 回放（上面吐槽过这是自欺），是一次真实的、被前端明确标成"预览"的模型输出，
// 权威 `result` 到达后前端会用它覆盖预览文本。
//
// 代价要如实说：这意味着 `mode === "chat"` 的一次 `/stream` 请求在配置了真实 provider
// 时会发生**两次**模型调用（一次流式预览 + 一次权威 orchestrator 调用，后者内部可能
// 还不止一次）。真正的根治是让 `processRequest` 自己支持 `onDelta` 并把预览与权威
// 合而为一——那需要改 agents/orchestrator.ts，不在本 lane 所有权内，已经写进
// docs/devlog/W2-d.md 交给主会话或 agents/** 的 owner。预览调用失败（没配 provider /
// 网络问题 / 用于测试的 fake LLM 根本不支持 onDelta）一律安静地不发 delta，不影响
// 权威流程——预览是锦上添花，不是必需品。

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
    // W2-d 把它做成默认开，理由是「一次真实的模型输出，比把权威结果切成假 token 回放诚实」
    // ——前半句对，后半句的对比选错了参照物。真正的问题是**预览的内容和权威答案无关**：
    // 预览发的是 `[{role:"user", content: message}]`（裸消息，无 system prompt、无技能上下文、
    // 无 plan），而权威答案走完整 orchestrator 管线（plan → execute → review）。
    // 两者是**两个不同的回答**，不是同一个回答的两个阶段。
    //
    // 用户不会把先出现的那段文字读成「占位」，会读成「答案」——然后它被换掉。
    // 展示一段与最终产出无关、却读起来像答案的文字，比不做流式更糟。
    // 附带代价：每次 chat 多一次模型调用。
    //
    // 根治是让 orchestrator 支持 `onDelta`，把预览与权威合而为一——那是 W3-a 的活
    // （它本来就要重构 orchestrator 做 replan 循环）。在那之前保留能力、默认关闭。
    const wantsPreview = body["preview"] === true && mode === "chat";

    return sseResponse(
      (sender) => {
        sender.send("start", { sessionId, mode, at: new Date().toISOString() });
        void (async () => {
          try {
            if (wantsPreview) {
              try {
                await ctx.llm().call([{ role: "user", content: message }], {
                  model,
                  onDelta: (chunk) => {
                    if (!sender.closed) sender.send("delta", { chunk });
                  },
                } satisfies CallOptions);
              } catch {
                // 预览失败不影响权威流程：没配 provider / 网络问题 / 注入的测试用
                // fake LLM 根本不支持 onDelta（那种情况下 onDelta 从不会被调用，
                // 这里的 catch 只兜真正抛出的异常，例如适配器内部错误）。
              }
            }
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
