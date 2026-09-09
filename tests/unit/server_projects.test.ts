import { describe, expect, test } from "bun:test";
import { makeServer } from "../helpers/server_scenario";

// P7 · 项目端点。CLI `spark-research project` 的能力必须在 HTTP 上一一对得上。

describe("HTTP · projects", () => {
  test("GET /api/projects 列出项目并标出当前项目", async () => {
    const fx = makeServer({ slug: "alpha" });
    try {
      const { status, body } = await fx.get<{ projects: Array<{ slug: string }>; current: string | null }>(
        "/api/projects",
      );
      expect(status).toBe(200);
      expect(body.projects.map((p) => p.slug)).toContain("alpha");
      expect(body.current).toBe("alpha");
    } finally {
      await fx.stop();
    }
  });

  test("POST /api/projects 建项目并切为当前", async () => {
    const fx = makeServer({ slug: "alpha" });
    try {
      const { status, body } = await fx.post<{ project: { slug: string; current: boolean; name: string } }>(
        "/api/projects",
        { slug: "beta", name: "第二个项目", description: "描述" },
      );
      expect(status).toBe(201);
      expect(body.project.slug).toBe("beta");
      expect(body.project.name).toBe("第二个项目");
      expect(body.project.current).toBe(true);
      expect(fx.manager.currentSlug()).toBe("beta");
    } finally {
      await fx.stop();
    }
  });

  test("POST /api/projects 缺 slug → 400；重复 slug → 400", async () => {
    const fx = makeServer({ slug: "alpha" });
    try {
      expect((await fx.post("/api/projects", {})).status).toBe(400);
      expect((await fx.post("/api/projects", { slug: "alpha" })).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/projects/current 带 record/文献/实验计数", async () => {
    const fx = makeServer({ slug: "alpha" });
    try {
      const { status, body } = await fx.get<{
        project: { slug: string; counts: Record<string, number>; paths: Record<string, string> };
      }>("/api/projects/current");
      expect(status).toBe(200);
      expect(body.project.slug).toBe("alpha");
      expect(body.project.counts).toMatchObject({
        records: 0,
        papers: 0,
        ideas: 0,
        dryExperiments: 0,
        wetExperiments: 0,
      });
      expect(body.project.paths.root).toContain("alpha");
    } finally {
      await fx.stop();
    }
  });

  test("POST /api/projects/current 切换项目；不存在 → 404", async () => {
    const fx = makeServer({ slug: "alpha" });
    try {
      await fx.post("/api/projects", { slug: "beta" });
      const switched = await fx.post<{ project: { slug: string } }>("/api/projects/current", { slug: "alpha" });
      expect(switched.status).toBe(200);
      expect(switched.body.project.slug).toBe("alpha");
      expect(fx.manager.currentSlug()).toBe("alpha");
      expect((await fx.post("/api/projects/current", { slug: "nope" })).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/projects/:slug 不存在 → 404", async () => {
    const fx = makeServer({ slug: "alpha" });
    try {
      expect((await fx.get("/api/projects/alpha")).status).toBe(200);
      expect((await fx.get("/api/projects/nope")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });

  test("POST /api/projects/:slug/archive 归档后默认列表里看不到，--all 能看到", async () => {
    const fx = makeServer({ slug: "alpha" });
    try {
      await fx.post("/api/projects", { slug: "beta" });
      expect((await fx.post("/api/projects/beta/archive")).status).toBe(200);
      const plain = await fx.get<{ projects: Array<{ slug: string }> }>("/api/projects");
      expect(plain.body.projects.map((p) => p.slug)).not.toContain("beta");
      const all = await fx.get<{ projects: Array<{ slug: string }> }>("/api/projects?all=1");
      expect(all.body.projects.map((p) => p.slug)).toContain("beta");
    } finally {
      await fx.stop();
    }
  });

  test("?project=<slug> 覆盖当前项目作用域", async () => {
    const fx = makeServer({ slug: "alpha" });
    try {
      await fx.post("/api/projects", { slug: "beta" });
      // 当前项目现在是 beta；显式指定 alpha 时端点必须作用在 alpha 上。
      const records = await fx.get<{ project: string }>("/api/records?project=alpha");
      expect(records.body.project).toBe("alpha");
      const beta = await fx.get<{ project: string }>("/api/records");
      expect(beta.body.project).toBe("beta");
      expect((await fx.get("/api/records?project=nope")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });
});
