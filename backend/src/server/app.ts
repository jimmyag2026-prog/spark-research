import { Hono } from "hono";
import { file } from "bun";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { buildCapabilities } from "../capabilities";
import { ProtocolCompiler, validateProtocol } from "../lab/protocol";
import type { Protocol } from "../lab/protocol";
import { LabSafetyGate } from "../lab/orchestrator";
import { HttpError, ServerContext, type ServerDeps } from "./context";
import { resolveSetting } from "../config";
import { experimentRoutes } from "./routes/experiments";
import { ideationRoutes } from "./routes/ideation";
import { labRoutes } from "./routes/lab";
import { literatureRoutes } from "./routes/literature";
import { artifactRoutes, recordRoutes } from "./routes/records";
import { conclusionRoutes, reportRoutes } from "./routes/report";
import { sessionRoutes, taskRoutes } from "./routes/session";
import { projectRoutes } from "./routes/projects";
import { proteinRoutes } from "./routes/proteins";
import { chemRoutes } from "./routes/chem";
import type { ArtifactListResponse, ChatRequest, ChatResponse, LineageResponse } from "./types";
import { PACKAGE_VERSION } from "../version";

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

// ── D-7：写请求的 Origin/Host 校验 + Content-Type 强制 ─────────────────────
//
// 外部评审给出的攻击链：用户浏览器开一个恶意网页 → 该网页对本机 API 发一个
// `Content-Type: text/plain` 的跨站 POST（这种「简单请求」不会触发 CORS 预检，
// 浏览器照样把它发出去）→ 冒充用户调用写端点（比如 lab 的 approve）。
// 现在后端是模拟器，后果有限；接了真实 Opentrons 设备之后这条直接是 P0。
//
// 两道闸：
//   1) 写请求（POST/PUT/PATCH/DELETE）必须显式声明 `Content-Type: application/json`——
//      堵住「用非 JSON Content-Type 绕开预检」这条路。跨站攻击者可以伪造这个头，
//      但伪造了它就正好落进闸 2）。
//   2) 若请求带 Origin header，必须在白名单内（本地默认 localhost/127.0.0.1，
//      任意端口；可用 config 的 originAllowlist 扩展）。
//
// **关键判定，务必先想清楚再动**：缺 Origin header 的请求一律放行，不做任何拦截。
// 这不是漏洞，是刻意口径——理由：
//   - 现代浏览器对「非同源」的 fetch/XHR 写请求（含 text/plain 绕预检那种）与
//     跨站 `<form>` POST 导航，都会强制带上 Origin，拿不掉、改不了。真实的
//     跨站攻击者发不出「没有 Origin」的浏览器请求。
//   - 没有 Origin 的写请求只可能来自非浏览器调用方：本机 CLI（`spark-research`
//     直接调用 daemon，不经过这层 HTTP）、MCP server 的进程内 `app.fetch()`
//     （backend/src/mcp/server.ts 用 `new Request()` 构造，从不带 Origin）、
//     curl / 这个仓库里几十个直接打 HTTP 的既有测试。这些等价于「本机 shell
//     里跑的东西」，挡住它们只会把没坏的路径打红，换不来任何真实的安全收益。
//   - 换句话说：Origin 校验防的是「浏览器代替用户身份去打本机 API」，
//     对没有浏览器参与的调用方无意义，也无法收窄。

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// 本地回环地址恒信任，端口不限——开发/生产两种模式下前端与 API 经常不同端口
// （dev server 代理、或生产构建产物由同一个 Hono 实例直出但端口仍可能变化）。
function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function parseAllowlist(raw: string | number | null | undefined): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin: string, allowlist: string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // 解析不了的 Origin（畸形/伪造）一律当作不可信，绝不当成「缺 Origin」放行。
    return false;
  }
  return isLocalHostname(hostname) || allowlist.includes(hostname) || allowlist.includes(origin);
}

function isJsonContentType(contentType: string): boolean {
  // 只看 `;` 前的 media type，忽略 charset 等参数；大小写不敏感。
  return contentType.split(";")[0]!.trim().toLowerCase() === "application/json";
}

// deps.root 已经是 ServerDeps 的既有字段（供各域测试注入 mkdtemp 工作区），
// 这里复用它去解析 originAllowlist，不需要改 ServerDeps/ServerContext 的形状。
function loadOriginAllowlist(deps: ServerDeps): string[] {
  return parseAllowlist(resolveSetting("originAllowlist", { root: deps.root }).value);
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

  // D-7：写请求安全闸，见上面大段注释。挂在所有路由之前，对 /api/* 与静态/SPA
  // 路径统一生效（后者没有写方法，这道闸对它们等价于 no-op）。
  const originAllowlist = loadOriginAllowlist(deps);
  app.use("*", async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (!WRITE_METHODS.has(method)) return next();

    const contentType = c.req.header("content-type") ?? "";
    if (!isJsonContentType(contentType)) {
      return c.json(
        { error: `写请求必须使用 Content-Type: application/json（收到 '${contentType || "(missing)"}'）` },
        415,
      );
    }

    const origin = c.req.header("origin");
    // 缺 Origin = 同源/进程内调用（CLI、MCP 的 app.fetch()、curl 等）——恒放行，
    // 理由见本文件顶部「关键判定」那段注释，不要在这里加「没有就当作可疑」的逻辑。
    if (origin !== undefined && !isAllowedOrigin(origin, originAllowlist)) {
      return c.json({ error: `拒绝跨站请求：Origin '${origin}' 不在白名单内` }, 403);
    }

    return next();
  });

  // ── v0.1 既有端点（保持不变） ───────────────────────────────────────────────

  // 版本号单一真源是 package.json。此前这里硬编码 "0.2.0"，而 package.json 还写着 0.1.0——
  // 两处不一致时没有任何东西会报警，只会让「你跑的是哪个版本」这个问题变得不可回答。
  app.get("/api/health", (c) => c.json({ status: "ok", service: "spark-research", version: PACKAGE_VERSION }));

  app.get("/api/connectors", (c) => c.json({ connectors: ctx.connectors.listAll() }));

  // 能力自描述（P9）。UI、CLI、MCP 三个消费者共用同一份生成结果——
  // `?probe=1` 才会真去 spawn 子进程探测本地仿真平台/湿实验后端的安装情况。
  app.get("/api/capabilities", async (c) => {
    const probe = c.req.query("probe") === "1" || c.req.query("probe") === "true";
    return c.json(
      await buildCapabilities({
        probe,
        root: deps.root,
        connectors: ctx.connectors,
        credentials: ctx.credentials(),
      }),
    );
  });

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
  // R-d-2（v0.4 P11 lane R-d）：protein-analysis 技能补的 HTTP 入口。这两行是本 lane
  // 唯一越过文件所有权表的改动——server/app.ts 不在 R-d 的持有清单里，但 MCP 工具的
  // 调用口径（backend/src/mcp/server.ts）硬编码「工具 = 对 Hono app 的一次 fetch()」，
  // 没有这两行 protein_analyze 就是个挂了名字却打不通的假入口，等于重犯 AD-12。
  // app.ts 未被任何并行 P11 lane 认领，改动是纯新增两行、不改既有路由——详见
  // docs/devlog/P11-d.md 的「文件边界」一节。
  app.route("/api/proteins", proteinRoutes(ctx));
  app.route("/api/chem", chemRoutes(ctx));
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
