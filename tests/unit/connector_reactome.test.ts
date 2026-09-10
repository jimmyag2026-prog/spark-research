// Reactome connector（W5-2 γ · V26 附带的 C2 第一批，新域 pathways）。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";
import { FixtureHttp } from "../../backend/src/http/fixture";
import { ReactomeConnector } from "../../backend/src/connectors/reactome";

function echoHttp(): StubHttp {
  return new StubHttp((url, init) => {
    return new BufferedResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(
        JSON.stringify({ url, method: init.method ?? "GET", headers: init.headers ?? {} }),
      ),
    });
  });
}

describe("ReactomeConnector（结构测试，无真实网络）", () => {
  test("工具清单含 search / getEntry", () => {
    const connector = new ReactomeConnector({ http: echoHttp() });
    const names = connector.listTools().map((t) => t.name);
    expect(names).toEqual(["search", "getEntry"]);
  });

  test("search：query 进 querystring，cluster 默认 true", async () => {
    const connector = new ReactomeConnector({ http: echoHttp() });
    const raw = await connector.call("search", { query: "apoptosis" });
    const echo = raw as { url: string };
    expect(echo.url).toContain("reactome.org/ContentService/search/query");
    expect(echo.url).toContain("query=apoptosis");
    expect(echo.url).toContain("cluster=true");
  });

  test("search：species 透传，limit 被丢弃（上游无此参数）", async () => {
    const connector = new ReactomeConnector({ http: echoHttp() });
    const raw = await connector.call("search", { query: "apoptosis", species: "Homo sapiens", limit: 999 });
    const echo = raw as { url: string };
    expect(new URL(echo.url).searchParams.get("species")).toBe("Homo sapiens");
    expect(echo.url).not.toContain("limit=");
  });

  test("search：缺 query 抛错", async () => {
    const connector = new ReactomeConnector({ http: echoHttp() });
    await expect(connector.call("search", {})).rejects.toThrow(/需要参数 query/);
  });

  test("getEntry：id 替换路径参数，不进查询串", async () => {
    const connector = new ReactomeConnector({ http: echoHttp() });
    const raw = await connector.call("getEntry", { id: "R-HSA-109581" });
    const echo = raw as { url: string };
    expect(echo.url).toBe("https://reactome.org/ContentService/data/query/R-HSA-109581");
  });

  test("调用未知工具报错", async () => {
    const connector = new ReactomeConnector({ http: echoHttp() });
    await expect(connector.call("notATool")).rejects.toThrow(/Unknown tool/);
  });

  // 阴性对照③（V26 checklist）：上游失败必须报成 failed，不许被吞成空结果。
  test("阴性对照③：上游 500 时 call() 必须 reject，不吞成空结果", async () => {
    const http500 = new StubHttp(
      () => new BufferedResponse({ status: 500, headers: {}, body: new TextEncoder().encode("upstream error") }),
    );
    const connector = new ReactomeConnector({ http: http500 });
    await expect(connector.call("search", { query: "apoptosis" })).rejects.toThrow(/HTTP 500/);
  });
});

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "pathways");

function replayHttp(cassette: string): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette, mode: "replay" });
}

describe("真实响应回放 · Reactome", () => {
  test("search()：真实检索 apoptosis，results 是按类型分组的数组（未扁平化）", async () => {
    const connector = new ReactomeConnector({ http: replayHttp("reactome-search") });
    const result = (await connector.call("search", { query: "apoptosis" })) as {
      results?: Array<{ typeName?: string; entries?: unknown[] }>;
    };
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results!.length).toBeGreaterThan(0);
    const pathwayGroup = result.results!.find((g) => Array.isArray(g.entries) && g.entries.length > 0);
    expect(pathwayGroup).toBeDefined();
  });

  test("getEntry()：真实取回 R-HSA-109581（Apoptosis pathway）详情", async () => {
    const connector = new ReactomeConnector({ http: replayHttp("reactome-getentry") });
    const entry = (await connector.call("getEntry", { id: "R-HSA-109581" })) as {
      stId?: string;
      displayName?: string;
    };
    expect(entry.stId).toBe("R-HSA-109581");
    expect(entry.displayName?.toLowerCase()).toContain("apoptosis");
  });
});
