import { afterEach, describe, expect, test } from "bun:test";
import { makeServer, type ServerFixture } from "../helpers/server_scenario";

// V122（R5 P0-2）：写路由的项目归属此前只看 query，body 里的 `project` 被静默忽略——
// 请求落进全局 current-project 指针指向的项目，响应还回报了错误的 project 名。
// SDK 生成的就是 body 风格，等于「显式指定项目仍然写错地方」（R5 实测把 3 篇论文写进了无关项目）。
// 阴性对照（已验红）：projectSlug 改回只读 query → 第一条红（记录落在当前项目）。

let fx: ServerFixture | null = null;
afterEach(async () => {
  await fx?.stop();
  fx = null;
});

describe("V122 · body.project 被尊重", () => {
  test("current 指针指向 alpha，POST body.project=beta → 落 beta，响应回报 beta", async () => {
    fx = makeServer({ slug: "alpha" });
    fx.manager.create("beta", { name: "beta" });
    fx.manager.setCurrent("alpha");

    const res = await fx.post<{ project: string }>("/api/chem/depict", {
      project: "beta",
      smiles: "CCO",
      name: "ethanol",
    });
    expect(res.status).toBe(200);
    expect(res.body.project).toBe("beta");

    const beta = await fx.get<{ total: number }>("/api/records?project=beta");
    const alpha = await fx.get<{ total: number }>("/api/records?project=alpha");
    expect(beta.body.total).toBe(1);
    expect(alpha.body.total).toBe(0);
  });

  test("query 与 body 同时给 → query 赢（URL 最显式）", async () => {
    fx = makeServer({ slug: "alpha" });
    fx.manager.create("beta", { name: "beta" });
    fx.manager.setCurrent("alpha");

    const res = await fx.post<{ project: string }>("/api/chem/depict?project=alpha", {
      project: "beta",
      smiles: "CCO",
    });
    expect(res.body.project).toBe("alpha");
    expect((await fx.get<{ total: number }>("/api/records?project=alpha")).body.total).toBe(1);
    expect((await fx.get<{ total: number }>("/api/records?project=beta")).body.total).toBe(0);
  });

  test("两者都不给 → 仍落当前项目指针（旧行为不变）", async () => {
    fx = makeServer({ slug: "alpha" });
    fx.manager.create("beta", { name: "beta" });
    fx.manager.setCurrent("beta");
    const res = await fx.post<{ project: string }>("/api/chem/depict", { smiles: "CCO" });
    expect(res.body.project).toBe("beta");
  });
});
