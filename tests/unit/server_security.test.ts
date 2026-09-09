import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../backend/src/server/server";
import { saveConfig } from "../../backend/src/config";
import { makeServer } from "../helpers/server_scenario";
import { makeMcp } from "../helpers/mcp_scenario";

// D-7（外部评审）：HTTP server 原本没有任何 Origin/Host 防护，且解析请求体时不查
// Content-Type。攻击链：用户浏览器打开恶意网页 → 该网页用 `Content-Type: text/plain`
// 发起跨站 POST（不触发 CORS 预检）→ 冒充用户调写端点。这里的对抗测试覆盖三种
// 跨站写请求形态，并确认正常的同源 / CLI / MCP 调用路径没有被误伤。
//
// 用 POST /api/projects 当靶子：它是最简单的真实写端点，201/403/415 的语义都很干净。

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-sec-"));
}

describe("D-7 · Content-Type 强制", () => {
  test("完全缺 Content-Type 的写请求 → 415", async () => {
    const fx = makeServer();
    try {
      // fetch 对 string body 会自动补 text/plain；用不带类型的字节体才是真的「没有 Content-Type」。
      const res = await fetch(`${fx.base}/api/projects`, {
        method: "POST",
        body: new TextEncoder().encode(JSON.stringify({ slug: "missing-content-type" })),
      });
      expect(res.status).toBe(415);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Content-Type");
    } finally {
      await fx.stop();
    }
  });

  test("Content-Type: text/plain 的写请求 → 415（这正是跨站攻击绕过预检用的那个头）", async () => {
    const fx = makeServer();
    try {
      const res = await fetch(`${fx.base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ slug: "text-plain-attack" }),
      });
      expect(res.status).toBe(415);
    } finally {
      await fx.stop();
    }
  });

  test("application/json; charset=utf-8 之类带参数的 Content-Type 仍放行", async () => {
    const fx = makeServer();
    try {
      const res = await fetch(`${fx.base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ slug: "charset-ok" }),
      });
      expect(res.status).toBe(201);
    } finally {
      await fx.stop();
    }
  });

  test("GET 请求不受这道闸限制", async () => {
    const fx = makeServer();
    try {
      const res = await fetch(`${fx.base}/api/projects`);
      expect(res.status).toBe(200);
    } finally {
      await fx.stop();
    }
  });
});

describe("D-7 · Origin 白名单", () => {
  test("伪造外站 Origin → 403（哪怕 Content-Type 正确）", async () => {
    const fx = makeServer();
    try {
      const res = await fetch(`${fx.base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ slug: "should-not-be-created" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("evil.example");
      // 真的没有创建成功——不是只报错但底下还是执行了。
      const list = await fx.get<{ projects: Array<{ slug: string }> }>("/api/projects");
      expect(list.body.projects.map((p) => p.slug)).not.toContain("should-not-be-created");
    } finally {
      await fx.stop();
    }
  });

  test("Origin: http://localhost:<任意端口> 放行（端口与服务器不同也放行）", async () => {
    const fx = makeServer();
    try {
      const res = await fetch(`${fx.base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:9999" },
        body: JSON.stringify({ slug: "local-origin-ok" }),
      });
      expect(res.status).toBe(201);
    } finally {
      await fx.stop();
    }
  });

  test("Origin: http://127.0.0.1:<server 实际端口> 放行", async () => {
    const fx = makeServer();
    try {
      const res = await fetch(`${fx.base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: fx.base },
        body: JSON.stringify({ slug: "loopback-origin-ok" }),
      });
      expect(res.status).toBe(201);
    } finally {
      await fx.stop();
    }
  });

  test("config 的 originAllowlist 可以扩展白名单，不在名单里的仍被拒", async () => {
    const root = tmpRoot();
    saveConfig({ originAllowlist: "trusted.example" }, { root });
    const server = startServer(0, { root });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const allowed = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://trusted.example" },
        body: JSON.stringify({ slug: "allowlisted" }),
      });
      expect(allowed.status).toBe(201);

      const rejected = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
        body: JSON.stringify({ slug: "not-allowlisted" }),
      });
      expect(rejected.status).toBe(403);
    } finally {
      await server.stop();
    }
  });
});

describe("D-7 · 缺 Origin 的同源 / CLI / 进程内调用必须照常放行", () => {
  test("缺 Origin 的写请求（server_scenario 里几十个既有用例的调用形态）正常成功", async () => {
    const fx = makeServer();
    try {
      const res = await fx.post<{ project: { slug: string } }>("/api/projects", { slug: "no-origin-ok" });
      expect(res.status).toBe(201);
      expect(res.body.project.slug).toBe("no-origin-ok");
    } finally {
      await fx.stop();
    }
  });

  test("MCP ToolRunner 的进程内 app.fetch() 不带 Origin，写工具照常成功", async () => {
    // backend/src/mcp/server.ts 用 `new Request()` 直接喂给同一个 Hono app 的 fetch()，
    // 从不带 Origin/Host——这条路径正是 D-7 要求「必须照常放行」的那类调用方。
    const fx = makeMcp();
    try {
      const res = await fx.call<{ project: { slug: string } }>("project_create", {
        slug: "mcp-write-ok",
        name: "MCP 写路径",
        description: "验证 D-7 不误伤进程内调用",
        setCurrent: false,
      });
      expect(res.ok).toBe(true);
      expect(res.payload.project.slug).toBe("mcp-write-ok");
    } finally {
      fx.dispose();
    }
  });
});
