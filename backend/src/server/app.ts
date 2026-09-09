import { Hono } from "hono";
import { file } from "bun";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { ProtocolCompiler, validateProtocol } from "../lab/protocol";
import type { Protocol } from "../lab/protocol";
import { LabSafetyGate } from "../lab/orchestrator";
import { HttpError, ServerContext, type ServerDeps } from "./context";
import { experimentRoutes } from "./routes/experiments";
import { ideationRoutes } from "./routes/ideation";
import { labRoutes } from "./routes/lab";
import { literatureRoutes } from "./routes/literature";
import { artifactRoutes, recordRoutes } from "./routes/records";
import { conclusionRoutes, reportRoutes } from "./routes/report";
import { sessionRoutes, taskRoutes } from "./routes/session";
import { projectRoutes } from "./routes/projects";
import type { ArtifactListResponse, ChatRequest, ChatResponse, LineageResponse } from "./types";

export type { ServerDeps } from "./context";

// SolidJS 工作台的构建产物目录。构建产物不入 git（纪律），所以运行时可能不存在——
// 那种情况下 API 照常工作，UI 路径返回一页带构建指引的 503，而不是一个空白 200。
export const DEFAULT_FRONTEND_DIR = join(import.meta.dir, "../../../frontend/workspace/dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const NOT_BUILT_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>Spark Research · 工作台未构建</title>
<style>body{font:15px/1.7 ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1.5rem;color:#1c1c1f}
code{background:#f2f2f4;padding:.15em .4em;border-radius:.3em}
@media(prefers-color-scheme:dark){body{background:#111113;color:#e8e8ea}code{background:#232326}}</style>
</head><body>
<h1>工作台前端还没有构建</h1>
<p>API 已经在跑（试试 <code>/api/health</code>）。前端构建产物不入 git，需要本地构建一次：</p>
<pre><code>bun install
bun run build:web</code></pre>
<p>构建完刷新本页即可。</p>
</body></html>`;

function safeResolve(base: string, rel: string): string | null {
  // 逐段过滤掉 `.` 与 `..`：不给任何拼出上级目录的机会。
  const clean = rel.split("/").filter((p) => p && p !== "." && p !== "..").join("/");
  if (!clean) return null;
  const resolved = join(base, clean);
  return resolved.startsWith(base) ? resolved : null;
}

function serveFile(dir: string, relative: string): Response | null {
  const path = safeResolve(dir, relative);
  if (!path || !existsSync(path)) return null;
  const mime = MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  return new Response(file(path), { headers: { "Content-Type": mime } });
}

export function createApp(deps: ServerDeps = {}): Hono {
  const app = new Hono();
  const ctx = new ServerContext(deps);
  const frontendDir = deps.frontendDir ?? DEFAULT_FRONTEND_DIR;
  const compiler = new ProtocolCompiler();
  const safetyGate = new LabSafetyGate();

  // 统一错误出口：HttpError 带自己的状态码，其余一律 500 且不外泄堆栈。
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message, detail: error.detail ?? undefined }, error.status as 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, 500);
  });

  // ── v0.1 既有端点（保持不变） ───────────────────────────────────────────────

  app.get("/api/health", (c) => c.json({ status: "ok", service: "spark-research", version: "0.2.0" }));

  app.get("/api/connectors", (c) => c.json({ connectors: ctx.connectors.listAll() }));

  app.post("/api/chat", async (c) => {
    const req = await c.req.json<ChatRequest>();
    const result = await ctx.agent.chat(req);
    return c.json(result satisfies ChatResponse);
  });

  app.get("/api/lab/devices", (c) => c.json({ devices: ctx.lab.listDevices() }));

  // 协议编译预览：不建 record、不落库，纯粹给 UI 「先看看会编译成什么」。
  app.post("/api/lab/protocol", async (c) => {
    const body = await c.req.json<{ name?: string; text?: string }>();
    const text = body?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return c.json({ error: "missing required field: text" }, 400);
    }
    const protocol = compiler.compile(text, { name: body.name });
    const validation = validateProtocol(protocol);
    const safety = safetyGate.checkProtocol(protocol);
    const compiled: Protocol = { ...protocol, safetyChecks: safety.checks };
    return c.json({ protocol: compiled, valid: validation.valid && safety.passed, validation, safety });
  });

  // ── P7 域端点 ──────────────────────────────────────────────────────────────

  app.route("/api/projects", projectRoutes(ctx));
  app.route("/api/lit", literatureRoutes(ctx));
  app.route("/api/ideas", ideationRoutes(ctx));
  app.route("/api/experiments", experimentRoutes(ctx));
  app.route("/api/lab", labRoutes(ctx));
  app.route("/api/records", recordRoutes(ctx));
  app.route("/api/conclusions", conclusionRoutes(ctx));
  app.route("/api/report", reportRoutes(ctx));
  app.route("/api/session", sessionRoutes(ctx));
  app.route("/api/tasks", taskRoutes(ctx));

  // v0.1 遗留：按 session 取 artifact / 取 lineage。新代码用 /api/artifacts?session=。
  app.get("/api/artifacts/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    // `version` 是新端点的前缀段，交给 artifactRoutes 处理。
    if (sessionId === "version") return c.notFound();
    const explicit = deps.store;
    if (explicit) {
      return c.json({ artifacts: explicit.listBySession(sessionId) } satisfies ArtifactListResponse);
    }
    const slug = ctx.projects.sessionProjectSlug(sessionId);
    return ctx.withProject(slug ?? undefined, (scope) =>
      c.json({ artifacts: scope.project.artifacts().listBySession(sessionId) } satisfies ArtifactListResponse),
    );
  });

  app.route("/api/artifacts", artifactRoutes(ctx));

  app.get("/api/lineage/:versionId", async (c) => {
    const versionId = c.req.param("versionId");
    const explicit = deps.store;
    if (explicit) {
      return c.json({ graph: explicit.getLineageGraph(versionId) } satisfies LineageResponse);
    }
    return ctx.withProject(undefined, (scope) =>
      c.json({ graph: scope.project.artifacts().getLineageGraph(versionId) } satisfies LineageResponse),
    );
  });

  // 未命中的 /api/* 一律 404 JSON（不能掉进 SPA 兜底，否则前端会把 HTML 当 JSON 解析）。
  app.all("/api/*", (c) => c.json({ error: `未知端点 ${c.req.path}` }, 404));

  // ── 静态资源与 SPA 兜底 ────────────────────────────────────────────────────

  app.get("*", (c) => {
    const path = c.req.path;
    const asset = path === "/" ? null : serveFile(frontendDir, path.slice(1));
    if (asset) return asset;
    // 带扩展名却没找到 = 资源缺失，报 404；不带扩展名 = 前端路由，回 index.html。
    if (path !== "/" && extname(path) !== "") return c.notFound();
    const index = serveFile(frontendDir, "index.html");
    if (index) return index;
    return new Response(NOT_BUILT_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  return app;
}
