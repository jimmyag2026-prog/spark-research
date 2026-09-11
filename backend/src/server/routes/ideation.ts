import { Hono } from "hono";
import { CoExploreSession } from "../../ideation/coexplore";
import type { NoveltyStatus } from "../../ideation/models";
import { NoveltyChecker } from "../../ideation/novelty";
import { IdeaStore } from "../../ideation/store";
import { DEFAULT_SEARCH_SOURCES, LITERATURE_SOURCES, type LiteratureSource } from "../../literature/models";
import { HttpError, type ServerContext } from "../context";
import {
  jsonBody,
  optionalNumber,
  optionalString,
  optionalStringList,
  projectSlug,
  queryString,
  requireString,
  taskResponse,
} from "./shared";

// 思路库端点（P4 的 `spark-research idea` 的 HTTP 投影）。
// co-explore 与 novelty check 都要打模型/网络，一律走任务句柄。

function parseSources(raw: string[] | undefined): LiteratureSource[] {
  if (!raw || raw.length === 0) return DEFAULT_SEARCH_SOURCES;
  const invalid = raw.filter((n) => !LITERATURE_SOURCES.includes(n as LiteratureSource));
  if (invalid.length > 0) throw new HttpError(400, `未知文献源: ${invalid.join(", ")}`);
  return raw as LiteratureSource[];
}

export function ideationRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const store = new IdeaStore(scope.project.records(), scope.library());
      const status = queryString(c, "status") as NoveltyStatus | undefined;
      return c.json({ project: scope.project.slug, ideas: store.list({ status }) });
    });
  });

  // Co-explore：一轮批判性共探 → Idea 卡。`persist: false` 只讨论不落库（多轮中间轮）。
  app.post("/", async (c) => {
    const body = await jsonBody(c);
    const message = requireString(body, "message");
    const sessionId = optionalString(body, "sessionId") ?? `web_${Date.now()}`;
    const persist = body.persist !== false;
    const slug = projectSlug(c) ?? null;

    return taskResponse(c, ctx, body, {
      kind: "idea.coexplore",
      project: slug,
      run: async (task) => {
        const scope = ctx.openProject(slug);
        try {
          const library = scope.library();
          const emptyLibrary = library.count() === 0;
          task.progress(0, 1, emptyLibrary ? "文献库为空：本轮观点只能是推断" : "共探中");
          const session = new CoExploreSession({
            llm: ctx.llmFor(scope.project, "idea-new"),
            library,
            records: scope.project.records(),
            model: ctx.model(),
            projectContext: scope.project.meta.description || undefined,
          });
          const turn = await session.turn(message, { sessionId });
          const stored = persist ? session.save(turn.card, { sessionId, model: turn.model }) : null;
          task.progress(1, 1, stored ? `Idea 卡 ${stored.recordId.slice(0, 8)}` : "候选卡（未落库）");
          return {
            project: scope.project.slug,
            sessionId,
            critique: turn.card.critique,
            card: turn.card,
            stored,
            // 顶层别名（v0.2.1）：下游 idea_novelty_check 要的参数就叫 ideaId，
            // 外部验收发现得往下挖到 stored.recordId 才找得到，两个工具间命名不一致。
            // 保留 stored.recordId 不动（向后兼容），这里只是把它抬到顺手的位置。
            ideaId: stored?.recordId ?? null,
            grounding: turn.grounding,
            // 「库为空」不是错误但必须让用户看见：没有文献支撑的共探只是推断。
            emptyLibrary,
          };
        } finally {
          scope.dispose();
        }
      },
    });
  });

  app.get("/:id", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const records = scope.project.records();
      const store = new IdeaStore(records, scope.library());
      const idea = store.get(c.req.param("id"));
      if (!idea) throw new HttpError(404, `思路库里没有 record '${c.req.param("id")}'`);
      const { outgoing, incoming } = records.edgesOf(idea.recordId);
      return c.json({ project: scope.project.slug, idea, edges: { outgoing, incoming } });
    });
  });

  app.post("/:id/check", async (c) => {
    const body = await jsonBody(c);
    const ref = c.req.param("id");
    const sources = parseSources(optionalStringList(body, "sources"));
    const perSource = optionalNumber(body, "perSource") ?? 5;
    const sessionId = optionalString(body, "sessionId") ?? null;
    const slug = projectSlug(c) ?? null;

    return taskResponse(c, ctx, body, {
      kind: "idea.novelty",
      project: slug,
      run: async (task) => {
        const scope = ctx.openProject(slug);
        try {
          const library = scope.library();
          const records = scope.project.records();
          const store = new IdeaStore(records, library);
          const idea = store.get(ref);
          if (!idea) throw new Error(`思路库里没有 record '${ref}'`);
          task.progress(0, 3, "claim 提取");
          const checker = new NoveltyChecker({
            llm: ctx.llmFor(scope.project, "novelty-check"),
            searcher: ctx.searcher(),
            library,
            records,
            artifacts: scope.project.artifacts(),
            model: ctx.model(),
            workDir: scope.project.paths.artifactsDir,
            sources,
            perSource,
            judge: ctx.deps.judge,
          });
          const result = await checker.check(idea, { sessionId });
          task.progress(3, 3, `评级 ${result.aggregate.status}`);
          const hard = result.citation.findings.filter((f) => f.severity === "hard");
          return {
            project: scope.project.slug,
            ideaId: idea.recordId,
            status: result.aggregate,
            claims: result.claims,
            assessments: result.assessments,
            markdown: result.markdown,
            path: result.path,
            artifactId: result.artifactId,
            recordId: result.recordId,
            citation: result.citation,
            // 「查过但没查出结论」与「没查过」必须分得开（P4 落地口径）。
            conclusive: result.aggregate.conclusive,
            vetoed: hard.length > 0,
          };
        } finally {
          scope.dispose();
        }
      },
    });
  });

  return app;
}
