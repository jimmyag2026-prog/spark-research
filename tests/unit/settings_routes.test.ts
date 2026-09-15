import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ServerContext } from "../../backend/src/server/context";
import { settingsRoutes } from "../../backend/src/server/routes/settings";

// 设置面（U6）的契约门禁 —— lane γ 对 lane ε 的承诺就钉在这里。
//
// 这个文件只管**形状**：路径、方法、响应 JSON 的键。值对不对是各面板自己的测试的事。
// 骨架 commit 之后契约**只增字段不改名**：谁改了下面任何一个路径或键名，这里会立刻红，
// 而 ε 的面板正是照着这些名字写的。

function makeApp(): Hono {
  const root = mkdtempSync(join(tmpdir(), "spark-settings-"));
  const ctx = new ServerContext({ root });
  const app = new Hono();
  app.route("/api/settings", settingsRoutes(ctx));
  return app;
}

async function get(app: Hono, path: string): Promise<{ status: number; body: any }> {
  const res = await app.fetch(new Request(`http://127.0.0.1${path}`));
  return { status: res.status, body: await res.json() };
}

// 十个面板 → 十条 GET。ε 的面板注册表与这张表一一对应。
const PANELS = [
  "general",
  "models",
  "local",
  "scientific-tools",
  "credentials",
  "extensions",
  "compute",
  "network",
  "storage",
  "permissions",
] as const;

describe("设置面 · 统一形状", () => {
  test("十个面板各有一条 GET，返回 { panel, items[], meta }", async () => {
    const app = makeApp();
    for (const id of PANELS) {
      const { status, body } = await get(app, `/api/settings/${id}`);
      expect(status).toBe(200);
      expect(body.panel).toBe(id);
      expect(Array.isArray(body.items)).toBe(true);
      // meta 三个必备键：能力分级、一句话说明、注意事项（减配在这里如实写明）。
      expect(["full", "reduced", "readonly"]).toContain(body.meta.level);
      expect(typeof body.meta.summary).toBe("string");
      expect(Array.isArray(body.meta.notes)).toBe(true);
    }
  });

  test("每个 item 都有 key / label / kind / value / editable / summary", async () => {
    const app = makeApp();
    for (const id of PANELS) {
      const { body } = await get(app, `/api/settings/${id}`);
      for (const item of body.items) {
        expect(typeof item.key).toBe("string");
        expect(typeof item.label).toBe("string");
        expect(["string", "number", "enum", "bool", "secret", "info", "action"]).toContain(item.kind);
        expect(item).toHaveProperty("value");
        expect(typeof item.editable).toBe("boolean");
        expect(typeof item.summary).toBe("string");
      }
    }
  });

  test("secret 类条目的 value 恒为 null（AD-18 ① 的形状面）", async () => {
    const app = makeApp();
    for (const id of PANELS) {
      const { body } = await get(app, `/api/settings/${id}`);
      for (const item of body.items) {
        if (item.kind === "secret") expect(item.value).toBeNull();
      }
    }
  });

  test("错误体一律 { error, nextStep } 且 nextStep 非空", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://127.0.0.1/api/settings/general/defaultModel", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; nextStep: string };
    expect(typeof body.error).toBe("string");
    expect(body.nextStep.length).toBeGreaterThan(0);
  });
});

describe("设置面 · 路由表", () => {
  // 契约冻结点：这 25 条路径是 ε 的面板直接调的地址。**只增不改名**。
  test("挂载后的路由表与承诺给 ε 的清单逐条相等", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-settings-"));
    const app = new Hono();
    app.route("/api/settings", settingsRoutes(new ServerContext({ root })));
    const actual = new Set(
      app.routes
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method} ${r.path}`),
    );
    const expected = [
      "GET /api/settings/general",
      "PUT /api/settings/general/:key",
      "DELETE /api/settings/general/:key",
      "GET /api/settings/models",
      "PUT /api/settings/models/default",
      "PUT /api/settings/models/subagent/:kind",
      "GET /api/settings/local",
      "PUT /api/settings/local",
      "GET /api/settings/scientific-tools",
      "PUT /api/settings/sources",
      "GET /api/settings/credentials",
      "PUT /api/settings/credentials/:id",
      "DELETE /api/settings/credentials/:id",
      "GET /api/settings/extensions",
      "POST /api/settings/extensions/mcp",
      "POST /api/settings/extensions/:name/verify",
      "DELETE /api/settings/extensions/:name",
      "GET /api/settings/compute",
      "PUT /api/settings/compute/target",
      "GET /api/settings/network",
      "PUT /api/settings/network/:key",
      "GET /api/settings/storage",
      "PUT /api/settings/storage/:key",
      "POST /api/settings/storage/export",
      "GET /api/settings/permissions",
    ];
    for (const route of expected) expect(actual).toContain(route);
    expect(expected.length).toBe(25);
  });
});
