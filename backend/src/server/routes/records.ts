import { Hono } from "hono";
import { RECORD_TYPES, EVIDENCE_LABELS, type EvidenceLabel, type RecordType } from "../../project/models";
import { RecordValidationError } from "../../project/records";
import { HttpError, type ServerContext } from "../context";
import type { RecordDetailResponse, RecordGraphResponse, RecordTimelinePage } from "../types";
import { projectSlug, queryList, queryNumber, queryString } from "./shared";

// Research Record 时间线与证据子图（DESIGN 域 C2 · P7）。
//
// 分页放在 SQL 里（`RecordStore.list` 的 since/until/offset）：`total` 与「这一页」
// 必须用同一套谓词，否则翻页时的总数会自相矛盾。

const MAX_LIMIT = 500;

function parseTypes(raw: string[] | undefined): RecordType[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const invalid = raw.filter((t) => !(RECORD_TYPES as readonly string[]).includes(t));
  if (invalid.length > 0) {
    throw new HttpError(400, `未知 record 类型: ${invalid.join(", ")}（可用: ${RECORD_TYPES.join(", ")}）`);
  }
  return raw as RecordType[];
}

export function recordRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  // 过滤器的可选值：UI 的类型/证据筛选面板照这里渲染，不在前端硬编码。
  app.get("/meta", (c) => c.json({ types: RECORD_TYPES, evidence: EVIDENCE_LABELS }));

  app.get("/", async (c) => {
    const types = parseTypes(queryList(c, "type"));
    const evidence = queryString(c, "evidence");
    if (evidence && !(EVIDENCE_LABELS as readonly string[]).includes(evidence)) {
      throw new HttpError(400, `未知证据类型 '${evidence}'（可用: ${EVIDENCE_LABELS.join(", ")}）`);
    }
    const limit = Math.min(queryNumber(c, "limit") ?? 50, MAX_LIMIT);
    const offset = queryNumber(c, "offset") ?? 0;
    if (limit < 1) throw new HttpError(400, "limit 必须 ≥ 1");
    if (offset < 0) throw new HttpError(400, "offset 必须 ≥ 0");

    return ctx.withProject(projectSlug(c), (scope) => {
      const records = scope.project.records();
      const filter = {
        type: types,
        evidence: evidence as EvidenceLabel | undefined,
        sessionId: queryString(c, "session"),
        since: queryString(c, "since"),
        until: queryString(c, "until"),
      };
      const page = records.list({ ...filter, limit, offset });
      const total = records.count(filter);
      const body: RecordTimelinePage = {
        project: scope.project.slug,
        records: page,
        total,
        offset,
        limit,
        types: [...new Set(page.map((r) => r.type))],
      };
      return c.json(body);
    });
  });

  app.get("/:id", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const records = scope.project.records();
      const record = records.get(c.req.param("id"));
      if (!record) throw new HttpError(404, `record '${c.req.param("id")}' 不存在`);
      const { outgoing, incoming } = records.edgesOf(record.id);
      // artifact 类型的 record 带上产物内容：AD-3 的 id 互链在 API 层要能一次取到。
      const artifact = record.artifactId ? (scope.project.artifacts().get(record.artifactId) ?? null) : null;
      const body: RecordDetailResponse = {
        project: scope.project.slug,
        record,
        outgoing,
        incoming,
        artifact,
      };
      return c.json(body);
    });
  });

  app.get("/:id/graph", async (c) => {
    const depth = queryNumber(c, "depth") ?? 2;
    if (depth < 1 || depth > 5) throw new HttpError(400, "depth 取值范围 1-5");
    return ctx.withProject(projectSlug(c), (scope) => {
      try {
        const graph = scope.project.records().graph(c.req.param("id"), depth);
        const body: RecordGraphResponse = {
          project: scope.project.slug,
          rootId: graph.rootId,
          depth,
          nodes: graph.nodes,
          edges: graph.edges,
        };
        return c.json(body);
      } catch (error) {
        if (error instanceof RecordValidationError) throw new HttpError(404, error.message);
        throw error;
      }
    });
  });

  return app;
}

export function artifactRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  // 注意注册顺序：`version/:id` 必须在 v0.1 遗留的 `/:sessionId` 之前匹配。
  app.get("/version/:versionId", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const artifact = scope.project.artifacts().get(c.req.param("versionId"));
      if (!artifact) throw new HttpError(404, `artifact '${c.req.param("versionId")}' 不存在`);
      return c.json({ project: scope.project.slug, artifact });
    });
  });

  app.get("/version/:versionId/lineage", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const graph = scope.project.artifacts().getLineageGraph(c.req.param("versionId"));
      return c.json({ project: scope.project.slug, graph });
    });
  });

  app.get("/", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const session = queryString(c, "session");
      const store = scope.project.artifacts();
      const artifacts = session ? store.listBySession(session) : store.listByProjectSlug(scope.project.slug);
      return c.json({ project: scope.project.slug, artifacts });
    });
  });

  return app;
}
