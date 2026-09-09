import { Hono } from "hono";
import { LlmCitationJudge } from "../../reviewer/citation_judge";
import { citationIntegrity } from "../../reviewer/rules";
import { exportLibrary, libraryKeyIndex, type ExportFormat } from "../../literature/export";
import type { LibraryPaper } from "../../literature/library";
import { DEFAULT_SEARCH_SOURCES, LITERATURE_SOURCES, type LiteratureSource } from "../../literature/models";
import { PdfDownloader } from "../../literature/pdf";
import { ReadingCardGenerator, listReadingCards } from "../../literature/reading";
import { ReviewDraftGenerator, baselinesFrom } from "../../literature/review";
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

// 文献域端点（P2/P3 的 `spark-research lit` 的 HTTP 投影）。
//
// 长任务（检索 / 入库 / PDF / 精读卡 / 综述）一律走任务句柄：它们要打网络或模型，
// 秒级到分钟级不等，挂在请求上等于让浏览器替我们承担超时。

function parseSources(raw: string[] | undefined): LiteratureSource[] {
  if (!raw || raw.length === 0) return DEFAULT_SEARCH_SOURCES;
  const invalid = raw.filter((n) => !LITERATURE_SOURCES.includes(n as LiteratureSource));
  if (invalid.length > 0) {
    throw new HttpError(400, `未知文献源: ${invalid.join(", ")}（可用: ${LITERATURE_SOURCES.join(", ")}）`);
  }
  return raw as LiteratureSource[];
}

// 支持传 id 前缀（UI 列表里显示的是前 8 位，与 CLI 同一约定）。
function resolvePaper(list: LibraryPaper[], ref: string): LibraryPaper {
  const exact = list.find((p) => p.id === ref);
  if (exact) return exact;
  const matches = list.filter((p) => p.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new HttpError(400, `论文 id 前缀 '${ref}' 命中 ${matches.length} 条，请给完整 id`);
  throw new HttpError(404, `论文 '${ref}' 不在库中`);
}

function counts(result: { totalBeforeDedupe: number; mergedCount: number }) {
  return {
    totalBeforeDedupe: result.totalBeforeDedupe,
    mergedCount: result.mergedCount,
    afterDedupe: result.totalBeforeDedupe - result.mergedCount,
  };
}

export function literatureRoutes(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/sources", (c) => {
    const credentials = ctx.credentials();
    const entries = ctx.connectors
      .listAll()
      .filter((entry) => entry.domain === "literature")
      .map((entry) => {
        const apiKeyRequired = Boolean(entry.metadata?.apiKeyRequired);
        return {
          name: entry.name,
          description: entry.description,
          apiKeyRequired,
          // AD-2：只回「是否已配置」，凭据值本体永远不出 daemon。
          credentialConfigured: apiKeyRequired ? credentials.has(entry.name) : null,
          tools: entry.tools.map((t) => t.name),
        };
      });
    return c.json({ sources: entries, defaults: DEFAULT_SEARCH_SOURCES });
  });

  app.post("/search", async (c) => {
    const body = await jsonBody(c);
    const query = requireString(body, "query");
    const sources = parseSources(optionalStringList(body, "sources"));
    const limit = optionalNumber(body, "limit") ?? 10;
    const add = body.add === true;
    const tags = optionalStringList(body, "tags") ?? [];
    const slug = projectSlug(c) ?? null;

    return taskResponse(c, ctx, body, {
      kind: "lit.search",
      project: slug,
      run: async (task) => {
        task.progress(0, 1, `检索「${query}」`);
        const result = await ctx.searcher().search(query, { sources, perSource: limit, limit });
        task.progress(1, add ? 2 : 1, `${result.papers.length} 篇候选`);
        if (!add) {
          return { query, sources: result.sources, papers: result.papers, added: null, ...counts(result) };
        }
        const scope = ctx.openProject(slug);
        try {
          const library = scope.library();
          let added = 0;
          let merged = 0;
          for (const paper of result.papers) {
            library.add(paper, { tags }).merged ? merged++ : added++;
          }
          library.rebuildCitations();
          task.progress(2, 2, `入库 ${added} 新增 / ${merged} 合并`);
          return {
            query,
            sources: result.sources,
            papers: result.papers,
            added: { project: scope.project.slug, added, merged, tags },
            ...counts(result),
          };
        } finally {
          scope.dispose();
        }
      },
    });
  });

  // 按标识符入库（DOI / arXiv id / PMID）。
  app.post("/papers", async (c) => {
    const body = await jsonBody(c);
    const identifier = requireString(body, "identifier");
    const sources = parseSources(optionalStringList(body, "sources"));
    const tags = optionalStringList(body, "tags") ?? [];
    const slug = projectSlug(c) ?? null;

    return taskResponse(c, ctx, body, {
      kind: "lit.add",
      project: slug,
      run: async (task) => {
        task.progress(0, 1, `解析 ${identifier}`);
        const result = await ctx.searcher().fetchById(identifier, { sources });
        if (result.papers.length === 0) {
          throw new Error(`未能在 ${sources.join("/")} 中找到标识符 '${identifier}' 对应的论文`);
        }
        const scope = ctx.openProject(slug);
        try {
          const library = scope.library();
          const added = library.add(result.papers[0]!, { tags });
          library.rebuildCitations();
          task.progress(1, 1, added.merged ? "合并进已有条目" : "已入库");
          return { project: scope.project.slug, merged: added.merged, paper: added.paper };
        } finally {
          scope.dispose();
        }
      },
    });
  });

  app.get("/papers", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const library = scope.library();
      const papers = library.list({
        tag: queryString(c, "tag"),
        readingStatus: queryString(c, "status") as LibraryPaper["readingStatus"] | undefined,
        q: queryString(c, "q"),
      });
      const index = libraryKeyIndex(papers);
      return c.json({
        project: scope.project.slug,
        papers: papers.map((paper, i) => ({ ...paper, bibtexKey: index.keys[i] ?? null })),
        citations: library.citations().length,
      });
    });
  });

  app.get("/papers/:id", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const library = scope.library();
      const all = library.list();
      const paper = resolvePaper(all, c.req.param("id"));
      const index = libraryKeyIndex(all);
      const cards = listReadingCards(scope.project.records(), library).filter((card) => card.paperId === paper.id);
      return c.json({
        project: scope.project.slug,
        paper: { ...paper, bibtexKey: index.byId.get(paper.id) ?? null },
        citations: library.citationsOf(paper.id),
        readingCards: cards,
      });
    });
  });

  app.patch("/papers/:id", async (c) => {
    const body = await jsonBody(c);
    return ctx.withProject(projectSlug(c), (scope) => {
      const library = scope.library();
      const paper = resolvePaper(library.list(), c.req.param("id"));
      const updated = library.update(paper.id, {
        readingStatus: optionalString(body, "readingStatus") as LibraryPaper["readingStatus"] | undefined,
        tags: optionalStringList(body, "tags"),
        notes: optionalString(body, "notes"),
      });
      return c.json({ project: scope.project.slug, paper: updated });
    });
  });

  app.post("/papers/:id/pdf", async (c) => {
    const body = await jsonBody(c);
    const ref = c.req.param("id");
    const slug = projectSlug(c) ?? null;
    return taskResponse(c, ctx, body, {
      kind: "lit.pdf",
      project: slug,
      run: async (task) => {
        const scope = ctx.openProject(slug);
        try {
          const library = scope.library();
          const paper = resolvePaper(library.list(), ref);
          task.progress(0, 1, `下载 ${paper.title.slice(0, 40)}`);
          const downloader = new PdfDownloader({
            http: ctx.deps.http,
            papersDir: scope.project.paths.papersDir,
            library,
          });
          const result = await downloader.download(paper.id);
          task.progress(1, 1, result.ok ? "已下载" : `不可得（${result.reason}）`);
          // 「不可得」是已知结果不是异常：库里记了 pdf_reason，UI 要照实显示而不是弹错误。
          return { project: scope.project.slug, paperId: paper.id, result };
        } finally {
          scope.dispose();
        }
      },
    });
  });

  app.get("/export", async (c) => {
    const format = (queryString(c, "format") ?? "bibtex") as ExportFormat;
    if (format !== "bibtex" && format !== "csl") {
      throw new HttpError(400, `未知导出格式 '${format}'（可用: bibtex, csl）`);
    }
    return ctx.withProject(projectSlug(c), (scope) => {
      const papers = scope.library().list({ tag: queryString(c, "tag") });
      const content = exportLibrary(papers, format);
      return new Response(content, {
        headers: {
          "Content-Type": format === "bibtex" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
        },
      });
    });
  });

  app.get("/cards", async (c) => {
    return ctx.withProject(projectSlug(c), (scope) => {
      const cards = listReadingCards(scope.project.records(), scope.library());
      return c.json({ project: scope.project.slug, cards });
    });
  });

  // 精读卡生成（P3）。单篇或 `all: true` 批量。
  app.post("/read", async (c) => {
    const body = await jsonBody(c);
    const all = body.all === true;
    const paperRef = optionalString(body, "paperId");
    if (!all && !paperRef) throw new HttpError(400, "需要 paperId，或 all: true 批量精读");
    const tag = optionalString(body, "tag");
    const slug = projectSlug(c) ?? null;

    return taskResponse(c, ctx, body, {
      kind: "lit.read",
      project: slug,
      run: async (task) => {
        const scope = ctx.openProject(slug);
        try {
          const library = scope.library();
          const targets = all ? library.list({ tag }) : [resolvePaper(library.list(), paperRef!)];
          if (targets.length === 0) throw new Error("没有可精读的论文（库为空或标签无匹配）");
          const generator = new ReadingCardGenerator({
            llm: ctx.llm(),
            library,
            records: scope.project.records(),
            model: ctx.deps.model,
            projectContext: scope.project.meta.description || undefined,
          });
          task.progress(0, targets.length, `精读 ${targets.length} 篇`);
          const { cards, failures } = await generator.generateMany(targets.map((p) => p.id));
          task.progress(targets.length, targets.length, `成功 ${cards.length} / 失败 ${failures.length}`);
          // 全失败要以任务失败呈现——「成功 0 张」不该是绿色的。
          if (cards.length === 0 && failures.length > 0) {
            throw new Error(`${failures.length} 篇精读卡全部生成失败：${failures[0]?.error ?? ""}`);
          }
          return { project: scope.project.slug, cards, failures };
        } finally {
          scope.dispose();
        }
      },
    });
  });

  // 综述草稿（P3）：生成 + citation-integrity 核验一次做完。
  app.post("/review", async (c) => {
    const body = await jsonBody(c);
    const topic = optionalString(body, "topic");
    const sessionId = optionalString(body, "sessionId") ?? null;
    const useJudge = body.judge !== false;
    const slug = projectSlug(c) ?? null;

    return taskResponse(c, ctx, body, {
      kind: "lit.review",
      project: slug,
      run: async (task) => {
        const scope = ctx.openProject(slug);
        try {
          const library = scope.library();
          const records = scope.project.records();
          const cards = listReadingCards(records, library);
          if (cards.length === 0) {
            throw new Error("项目里还没有精读卡。先跑 lit read（或 POST /api/lit/read）");
          }
          task.progress(0, 2, `基于 ${cards.length} 张精读卡生成综述`);
          const llm = ctx.llm();
          const generator = new ReviewDraftGenerator({
            llm,
            library,
            records,
            artifacts: scope.project.artifacts(),
            model: ctx.deps.model,
            workDir: scope.project.paths.artifactsDir,
          });
          const draft = await generator.generate(cards, { topic, sessionId });
          task.progress(1, 2, "引用核验中");
          const check = await citationIntegrity({
            draft: draft.markdown,
            knownKeys: libraryKeyIndex(library.list()).keys,
            baselines: baselinesFrom(cards),
            judge: useJudge ? (ctx.deps.judge ?? new LlmCitationJudge(llm, ctx.deps.model)) : undefined,
            artifactId: draft.artifactId ?? "",
            location: "text/markdown",
          });
          const hard = check.findings.filter((f) => f.severity === "hard");
          task.progress(2, 2, hard.length > 0 ? `${hard.length} 条 hard finding` : "引用核验通过");
          return {
            project: scope.project.slug,
            draft: {
              markdown: draft.markdown,
              path: draft.path,
              artifactId: draft.artifactId,
              recordId: draft.recordId,
              citedKeys: draft.citedKeys,
            },
            cardCount: cards.length,
            citation: check,
            // veto 是结果不是异常：草稿要能被读到（否则用户没法修），但必须带着否决结论。
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
