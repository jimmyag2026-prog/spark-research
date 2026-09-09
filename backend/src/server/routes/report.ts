import { Hono } from "hono";
import { CONCLUSION_REVIEW_STATES, type ConclusionCard, type ConclusionReviewState } from "../../conclusion/models";
import { ConclusionReviewer, ConclusionReviewError } from "../../conclusion/reviewer";
import { buildReport } from "../../report/export";
import { HttpError, type ServerContext } from "../context";
import { jsonBody, optionalString, projectSlug, queryBool, queryString } from "./shared";

// 结论卡与研究报告端点（P8-gate G1/G7 的 HTTP 投影）。
//
// 与 CLI 同一套业务实现（ConclusionReviewer / buildReport），HTTP 层只做解析与序列化。
// **actor 在 HTTP 层没有 env 兜底**（AD-6 的 P7 补充）：服务进程的 OS 用户与点「评审」
// 的人无关，缺 actor 直接 400，actorSource 记 `http:explicit` 以便审计分辨来源。

function cardJson(card: ConclusionCard): Record<string, unknown> {
  const { record: _record, ...rest } = card;
  return rest;
}

export function conclusionRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/meta", (c) => c.json({ states: CONCLUSION_REVIEW_STATES }));

  app.get("/", async (c) => {
    const review = queryString(c, "review");
    if (review && !(CONCLUSION_REVIEW_STATES as readonly string[]).includes(review)) {
      throw new HttpError(400, `未知 review 状态 '${review}'（可用: ${CONCLUSION_REVIEW_STATES.join(", ")}）`);
    }
    return ctx.withProject(projectSlug(c), (scope) => {
      const reviewer = new ConclusionReviewer(scope.project.records());
      const cards = reviewer.store.list({ review: review as ConclusionReviewState | undefined });
      return c.json({ project: scope.project.slug, conclusions: cards.map(cardJson), total: cards.length });
    });
  });

  app.get("/:id", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const reviewer = new ConclusionReviewer(scope.project.records());
      const card = reviewer.store.get(c.req.param("id"));
      if (!card) throw new HttpError(404, `结论卡 '${c.req.param("id")}' 不存在`);
      // 预览：跑检查器但不落库（与 CLI `conclusion show` 同口径）。
      const assessment = reviewer.assess(card);
      return c.json({
        project: scope.project.slug,
        conclusion: cardJson(card),
        assessment: {
          hardCount: assessment.hardCount,
          softCount: assessment.softCount,
          wouldApprove: assessment.wouldApprove,
          reconciliation: assessment.reconciliation,
          findings: assessment.findings,
          evidence: assessment.resolved.map((r) => ({
            id: r.id,
            ok: r.ok,
            simulated: r.simulated,
            deterministic: r.deterministic,
            linked: r.linked,
          })),
        },
      });
    });
  });

  app.post("/:id/review", async (c) => {
    const body = await jsonBody(c);
    const actor = optionalString(body, "actor");
    if (!actor) {
      throw new HttpError(
        400,
        "缺少 actor：HTTP 层不接受环境变量兜底——服务进程的 OS 用户不是评审人（AD-6 / BACKLOG V10）",
      );
    }
    const veto = optionalString(body, "veto");
    return ctx.withProject(projectSlug(c), (scope) => {
      const reviewer = new ConclusionReviewer(scope.project.records());
      const card = reviewer.store.get(c.req.param("id"));
      if (!card) throw new HttpError(404, `结论卡 '${c.req.param("id")}' 不存在`);
      try {
        const result = reviewer.review(card, { actor, actorSource: "http:explicit", veto: veto ?? null });
        return c.json({
          project: scope.project.slug,
          conclusion: cardJson(result.card),
          approved: result.approved,
          decisionRecordId: result.decisionRecordId,
          reconciliation: result.reconciliation,
          findings: result.findings,
        });
      } catch (error) {
        if (error instanceof ConclusionReviewError) throw new HttpError(400, error.message);
        throw error;
      }
    });
  });

  return app;
}

export function reportRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  // `?format=markdown` 返回 text/markdown（浏览器可直接另存），默认返回 JSON 信封。
  app.get("/", async (c) => {
    const format = queryString(c, "format") ?? "json";
    if (format !== "json" && format !== "markdown") {
      throw new HttpError(400, `未知 format '${format}'（可用: json, markdown）`);
    }
    const verbose = queryBool(c, "verbose");
    return ctx.withProject(projectSlug(c), (scope) => {
      const report = buildReport({
        meta: scope.project.meta,
        records: scope.project.records(),
        papers: scope.library().list(),
        verbose,
      });
      if (format === "markdown") {
        return new Response(report.markdown, {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            // 前端的「导出」按钮靠这个头拿到文件名。
            "Content-Disposition": `attachment; filename="${report.project}-report.md"`,
          },
        });
      }
      return c.json({
        project: report.project,
        title: report.title,
        generatedAt: report.generatedAt,
        counts: report.counts,
        recordIds: report.recordIds,
        markdown: report.markdown,
      });
    });
  });

  return app;
}
