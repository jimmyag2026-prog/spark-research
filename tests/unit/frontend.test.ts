import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, type StartedServer } from "../../backend/src/server/server";

describe("Kimi Science frontend static serving", () => {
  let server: StartedServer;

  beforeAll(() => {
    server = startServer(0);
  });

  afterAll(async () => {
    await server.stop();
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  test("GET / returns index.html", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<html");
    expect(html).toContain("Kimi Science");
  });

  test("GET /workspace/app.js returns JS content", async () => {
    const res = await fetch(`${base()}/workspace/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("initApp");
    expect(js).toContain("/api/chat");
  });

  test("GET /workspace/styles.css returns CSS content", async () => {
    const res = await fetch(`${base()}/workspace/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const css = await res.text();
    expect(css).toContain("--accent");
    expect(css).toContain("chat-messages");
  });

  test("unknown static path returns 404", async () => {
    const res = await fetch(`${base()}/workspace/nope.js`);
    expect(res.status).toBe(404);
  });

  test("path traversal is blocked", async () => {
    const res = await fetch(`${base()}/workspace/../../package.json`);
    expect(res.status).toBe(404);
  });

  test("existing API routes still work alongside static files", async () => {
    const res = await fetch(`${base()}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
