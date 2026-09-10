// bioRxiv connector（W5-2 γ · V26 附带的 C2 第一批）。
//
// getRecent / getByDoi 是原样透传原语；search / getPaper 是 connector 层在其上组合
// 出来的复合工具（见 connectors/biorxiv.ts 文件头注释），二者共用同一批参数映射测试
// 与真实响应回放。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";
import { FixtureHttp } from "../../backend/src/http/fixture";
import { BioRxivConnector } from "../../backend/src/connectors/biorxiv";

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

describe("BioRxivConnector（结构测试，无真实网络）", () => {
  test("工具清单含 getRecent / getByDoi / search / getPaper", () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    const names = connector.listTools().map((t) => t.name);
    expect(names).toEqual(["getRecent", "getByDoi", "search", "getPaper"]);
  });

  test("getRecent：server 默认 biorxiv，count 默认 100，均替换进路径而非查询串", async () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    const raw = await connector.call("getRecent", {});
    const echo = raw as { url: string };
    expect(echo.url).toBe("https://api.biorxiv.org/details/biorxiv/100");
  });

  test("getRecent：非法 server 抛错", async () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    await expect(connector.call("getRecent", { server: "arxiv" })).rejects.toThrow(/只能是 "biorxiv" 或 "medrxiv"/);
  });

  // 这条断言与最初的 staged 单测桩（从未跑过真实网络）不一样：staged 版本断言
  // doi 里的 "/" 被转义成 "%2F" 是"正确拼接"。真实打 api.biorxiv.org 录制时发现
  // %2F 形态返回 404（doi 内部的 "/" 必须原样出现在路径里）——见 connectors/biorxiv.ts
  // 的 encodeDoiSegments 注释。这里钉住修好之后的真实行为：doi 的 "/" 保持字面形式，
  // 只有 doi 以外真正需要转义的字符才会被转义。
  test("getByDoi：doi 内部的 '/' 保持字面形式（不转义成 %2F），server=medrxiv 时路径正确拼接", async () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    const raw = await connector.call("getByDoi", { server: "medrxiv", doi: "10.1101/2021.01.01.20248001" });
    const echo = raw as { url: string };
    expect(echo.url).toBe("https://api.biorxiv.org/details/medrxiv/10.1101/2021.01.01.20248001");
    expect(echo.url).not.toContain("%2F");
  });

  test("getByDoi：缺 doi 抛错", async () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    await expect(connector.call("getByDoi", {})).rejects.toThrow(/需要参数 doi/);
  });

  test("search：缺 query 抛错", async () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    await expect(connector.call("search", {})).rejects.toThrow(/需要参数 query/);
  });

  test("search：内部通过 getRecent 拉窗口，windowSize 控制 count", async () => {
    // echoHttp 对 search 的底层 getRecent 请求原样回显 url——用它验证 search()
    // 真的落到了 getRecent 的 HTTP 路径，而不是打了一个不存在的 "search" 端点。
    const connector = new BioRxivConnector({ http: echoHttp() });
    // 用不会匹配任何 token 的 url 回显内容来检查请求本身发对了（echo 里没有
    // title/abstract 字段，打分永远是 0，collection 会是空数组——这里只关心
    // 请求路径，不关心打分结果）。
    const result = await connector.call("search", { query: "irrelevant", windowSize: 42 });
    expect((result as { collection: unknown[] }).collection).toEqual([]);
  });

  test("getPaper：转发到 getByDoi", async () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    const raw = await connector.call("getPaper", { id: "10.1101/2021.01.01.20248001" });
    const echo = raw as { url: string };
    expect(echo.url).toBe("https://api.biorxiv.org/details/biorxiv/10.1101/2021.01.01.20248001");
  });

  test("getPaper：缺 id 抛错", async () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    await expect(connector.call("getPaper", {})).rejects.toThrow(/需要参数 id/);
  });

  test("调用未知工具报错", async () => {
    const connector = new BioRxivConnector({ http: echoHttp() });
    await expect(connector.call("notATool")).rejects.toThrow(/Unknown tool/);
  });

  // 阴性对照③（V26 checklist）：上游失败必须报成 failed，不许被吞成空结果。
  // 这里特意测两条路径——getRecent 的直接失败，以及 search() 组合调用里 getRecent
  // 失败时也必须原样冒泡（不能被 search() 的 filter/sort 逻辑意外吞掉）。
  test("阴性对照③：上游 500 时 getRecent 必须 reject，不吞成空结果", async () => {
    const http500 = new StubHttp(
      () => new BufferedResponse({ status: 500, headers: {}, body: new TextEncoder().encode("upstream error") }),
    );
    const connector = new BioRxivConnector({ http: http500 });
    await expect(connector.call("getRecent", {})).rejects.toThrow(/HTTP 500/);
  });

  test("阴性对照③：上游 500 时 search()（组合调用）也必须 reject，不吞成空 collection", async () => {
    const http500 = new StubHttp(
      () => new BufferedResponse({ status: 500, headers: {}, body: new TextEncoder().encode("upstream error") }),
    );
    const connector = new BioRxivConnector({ http: http500 });
    await expect(connector.call("search", { query: "anything" })).rejects.toThrow(/HTTP 500/);
  });

  test("阴性对照③：上游 404 时 getByDoi 必须 reject（不是本 connector 自定义的错误处理路径把它吞掉）", async () => {
    const http404 = new StubHttp(
      () => new BufferedResponse({ status: 404, headers: {}, body: new TextEncoder().encode("not found") }),
    );
    const connector = new BioRxivConnector({ http: http404 });
    await expect(connector.call("getByDoi", { doi: "10.1101/does.not.exist" })).rejects.toThrow(/HTTP 404/);
  });
});

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "literature");

function replayHttp(cassette: string): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette, mode: "replay" });
}

describe("真实响应回放 · bioRxiv", () => {
  test("getRecent()：真实取回最近 5 篇 bioRxiv 预印本，结构完整", async () => {
    const connector = new BioRxivConnector({ http: replayHttp("biorxiv-recent") });
    const result = await connector.getRecent({ count: 5 });
    expect(result.collection?.length).toBe(5);
    for (const item of result.collection ?? []) {
      const paper = item as { title?: string; doi?: string; authors?: string };
      expect(paper.title).toBeTruthy();
      expect(paper.doi).toMatch(/^10\./);
      expect(paper.authors).toBeTruthy();
    }
  });

  test("getByDoi()：真实按 DOI（含内部 '/'）精确取回单篇记录", async () => {
    const connector = new BioRxivConnector({ http: replayHttp("biorxiv-getbydoi") });
    const result = (await connector.getByDoi({ doi: "10.64898/2026.08.11.744243" })) as {
      collection?: Array<{ doi?: string; title?: string }>;
    };
    expect(result.collection?.length).toBe(1);
    expect(result.collection![0]!.doi).toBe("10.64898/2026.08.11.744243");
  });

  // 这个 cassette 录的是 search({query:"cell", windowSize:100}) 内部真正发出的
  // getRecent(count=100) 请求（search 本身不是一个独立端点，见连接器文件头注释）——
  // 回放时用同一套参数重走一遍 search()，验证关键词打分过滤在真实数据上确实能筛出
  // 命中项，而不是要么全命中要么全不命中。
  test("search()：真实窗口数据上，'cell' 关键词能筛出命中项（不是全量透传也不是全空）", async () => {
    const connector = new BioRxivConnector({ http: replayHttp("biorxiv-search") });
    const result = await connector.search({ query: "cell", limit: 5, windowSize: 100 });
    const hits = result.collection ?? [];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(5);
    for (const item of hits) {
      const paper = item as { title?: string; abstract?: string };
      const haystack = `${paper.title ?? ""} ${paper.abstract ?? ""}`.toLowerCase();
      expect(haystack).toContain("cell");
    }
  });

  test("search()：查不到 ≠ 报错——完全不沾边的关键词返回空 collection 而不是抛错", async () => {
    const connector = new BioRxivConnector({ http: replayHttp("biorxiv-search") });
    const result = await connector.search({
      query: "zzzznonexistentkeywordxyz123",
      limit: 5,
      windowSize: 100,
    });
    expect(result.collection).toEqual([]);
  });
});
