import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "../../backend/src/server/server";

// P7：前端从 v0.1 的 vanilla 三栏换成 SolidJS + Vite 构建产物。
//
// 测试注入 frontendDir 而不是指向真实的 frontend/workspace/dist：
// 构建产物不入 git，真依赖它测试就会在干净检出上挂掉——那是「测试依赖构建顺序」，
// 不是我们要保的性质。这里保的是**静态托管的行为**：命中、兜底、404、路径穿越。

describe("静态托管 · 已构建", () => {
  let server: StartedServer;
  let dist: string;

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "spark-dist-"));
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), '<!doctype html><html><body><div id="root">Spark Research</div></body></html>');
    writeFileSync(join(dist, "assets", "index-abc.js"), 'export const app = "/api/session/stream";');
    writeFileSync(join(dist, "assets", "index-abc.css"), ":root{--accent:#2f6feb}");
    server = startServer(0, { frontendDir: dist, root: mkdtempSync(join(tmpdir(), "spark-fe-")) });
  });

  afterAll(async () => {
    await server.stop();
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  test("GET / 返回构建出的 index.html", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Spark Research");
  });

  test("哈希命名的 JS / CSS 资源带正确 MIME", async () => {
    const js = await fetch(`${base()}/assets/index-abc.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const css = await fetch(`${base()}/assets/index-abc.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--accent");
  });

  test("无扩展名路径回 index.html（SPA 兜底），有扩展名的缺失资源回 404", async () => {
    const route = await fetch(`${base()}/some/client/route`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("Spark Research");
    // 缺失的资源必须是 404：兜底成 HTML 会让 <script src> 静默拿到一页 HTML。
    const missing = await fetch(`${base()}/assets/nope.js`);
    expect(missing.status).toBe(404);
  });

  test("路径穿越被挡住", async () => {
    expect((await fetch(`${base()}/../package.json`)).status).toBe(404);
    expect((await fetch(`${base()}/assets/../../package.json`)).status).toBe(404);
  });

  test("API 路由与静态资源并存；未知 /api/* 回 JSON 404 而不是 HTML", async () => {
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");
    const unknown = await fetch(`${base()}/api/nonexistent`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");
  });
});

describe("静态托管 · 未构建", () => {
  let server: StartedServer;

  beforeAll(() => {
    // 指向一个空目录：模拟干净检出（dist/ 在 .gitignore 里）。
    server = startServer(0, {
      frontendDir: mkdtempSync(join(tmpdir(), "spark-nodist-")),
      root: mkdtempSync(join(tmpdir(), "spark-fe2-")),
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  test("UI 路径回 503 + 构建指引，API 照常工作", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(`${base}/`);
    // 503 而不是空白 200：服务在跑，但这一份 UI 确实还不存在。
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain("bun run build:web");
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
});
