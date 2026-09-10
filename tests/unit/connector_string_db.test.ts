// STRING connector（W5-2 γ · V26 附带的 C2 第一批，新域 pathways）。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";
import { FixtureHttp } from "../../backend/src/http/fixture";
import { StringDBConnector } from "../../backend/src/connectors/string-db";

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

describe("StringDBConnector（结构测试，无真实网络）", () => {
  test("工具清单含 search / getPartners", () => {
    const connector = new StringDBConnector({ http: echoHttp() });
    const names = connector.listTools().map((t) => t.name);
    expect(names).toEqual(["search", "getPartners"]);
  });

  test("search：query 映射成 identifiers，species 默认 9606", async () => {
    const connector = new StringDBConnector({ http: echoHttp() });
    const raw = await connector.call("search", { query: "TP53" });
    const echo = raw as { url: string };
    expect(echo.url).toContain("string-db.org/api/json/get_string_ids");
    expect(echo.url).toContain("identifiers=TP53");
    expect(echo.url).toContain("species=9606");
    expect(echo.url).not.toContain("?query=");
    expect(echo.url).not.toContain("&query=");
  });

  test("search：非默认物种可覆盖", async () => {
    const connector = new StringDBConnector({ http: echoHttp() });
    const raw = await connector.call("search", { query: "Trp53", species: 10090 });
    const echo = raw as { url: string };
    expect(echo.url).toContain("species=10090");
  });

  test("search：缺 query/identifiers 抛错", async () => {
    const connector = new StringDBConnector({ http: echoHttp() });
    await expect(connector.call("search", {})).rejects.toThrow(/需要参数 query 或 identifiers/);
  });

  test("getPartners：id 映射成 identifiers，limit 默认 25", async () => {
    const connector = new StringDBConnector({ http: echoHttp() });
    const raw = await connector.call("getPartners", { id: "9606.ENSP00000269305" });
    const echo = raw as { url: string };
    expect(echo.url).toContain("string-db.org/api/json/interaction_partners");
    expect(echo.url).toContain("identifiers=9606.ENSP00000269305");
    expect(echo.url).toContain("limit=25");
    expect(echo.url).not.toContain("id=");
  });

  test("调用未知工具报错", async () => {
    const connector = new StringDBConnector({ http: echoHttp() });
    await expect(connector.call("notATool")).rejects.toThrow(/Unknown tool/);
  });

  // 阴性对照③（V26 checklist）：上游失败必须报成 failed，不许被吞成空结果。
  test("阴性对照③：上游 500 时 call() 必须 reject，不吞成空结果", async () => {
    const http500 = new StubHttp(
      () => new BufferedResponse({ status: 500, headers: {}, body: new TextEncoder().encode("upstream error") }),
    );
    const connector = new StringDBConnector({ http: http500 });
    await expect(connector.call("search", { query: "TP53" })).rejects.toThrow(/HTTP 500/);
  });
});

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "pathways");

function replayHttp(cassette: string): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette, mode: "replay" });
}

describe("真实响应回放 · STRING", () => {
  test("search()：真实解析 TP53（人类），拿到 STRING ID", async () => {
    const connector = new StringDBConnector({ http: replayHttp("string-db-search") });
    const result = (await connector.call("search", { query: "TP53" })) as Array<{
      stringId?: string;
      preferredName?: string;
      ncbiTaxonId?: number;
    }>;
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.stringId).toBe("9606.ENSP00000269305");
    expect(result[0]!.preferredName).toBe("TP53");
    expect(result[0]!.ncbiTaxonId).toBe(9606);
  });

  test("getPartners()：真实取回 TP53 的互作伙伴，每条都带置信度分数", async () => {
    const connector = new StringDBConnector({ http: replayHttp("string-db-partners") });
    const result = (await connector.call("getPartners", {
      id: "9606.ENSP00000269305",
      limit: 5,
    })) as Array<{ preferredName_A?: string; preferredName_B?: string; score?: number }>;
    expect(result.length).toBeGreaterThan(0);
    for (const partner of result) {
      expect(partner.preferredName_A).toBe("TP53");
      expect(typeof partner.score).toBe("number");
      expect(partner.score!).toBeGreaterThan(0);
    }
  });
});
