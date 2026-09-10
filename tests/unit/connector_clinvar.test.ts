// ClinVar connector（W5-2 γ · V26 附带的 C2 第一批）。
//
// 两组用例：
//   1. 结构测试（StubHttp echo）：验证参数映射，不碰网络。
//   2. 真实响应回放（FixtureHttp mode="replay"）：tests/fixtures/genomics/clinvar.json
//      是 2026-09-10 用本 connector 本身（FIXTURE_MODE=record）真实打
//      eutils.ncbi.nlm.nih.gov/entrez/eutils（db=clinvar）录制的，不是手写样例——
//      常规回放用例，不 skip（方案 §6.1「0 skip」）。
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";
import { FixtureHttp } from "../../backend/src/http/fixture";
import { ClinVarConnector } from "../../backend/src/connectors/clinvar";

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

describe("ClinVarConnector（结构测试，无真实网络）", () => {
  test("工具清单含 search / getSummary", () => {
    const connector = new ClinVarConnector({ http: echoHttp() });
    const names = connector.listTools().map((t) => t.name);
    expect(names).toEqual(["search", "getSummary"]);
  });

  test("search：query 映射成 term，db 固定 clinvar，retmax 默认 10", async () => {
    const connector = new ClinVarConnector({ http: echoHttp() });
    const raw = await connector.call("search", { query: "BRCA1" });
    const echo = raw as { url: string };
    expect(echo.url).toContain("eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
    expect(echo.url).toContain("term=BRCA1");
    expect(echo.url).toContain("db=clinvar");
    expect(echo.url).toContain("retmax=10");
    expect(echo.url).not.toContain("query=");
  });

  test("search：缺 query 抛错", async () => {
    const connector = new ClinVarConnector({ http: echoHttp() });
    await expect(connector.call("search", {})).rejects.toThrow(/需要参数 query/);
  });

  test("getSummary：id 数组自动 join 逗号", async () => {
    const connector = new ClinVarConnector({ http: echoHttp() });
    const raw = await connector.call("getSummary", { id: ["12345", "67890"] });
    const echo = raw as { url: string };
    expect(echo.url).toContain("esummary.fcgi");
    expect(echo.url).toContain("id=12345%2C67890");
    expect(echo.url).toContain("db=clinvar");
  });

  test("getSummary：缺 id 抛错", async () => {
    const connector = new ClinVarConnector({ http: echoHttp() });
    await expect(connector.call("getSummary", {})).rejects.toThrow(/需要参数 id/);
  });

  test("调用未知工具报错", async () => {
    const connector = new ClinVarConnector({ http: echoHttp() });
    await expect(connector.call("notATool")).rejects.toThrow(/Unknown tool/);
  });

  // 阴性对照③（V26 checklist）：本仓库口径「没查到 ≠ 查了没有」——上游失败必须报成
  // failed，不能被静默吞成一个看起来正常的空结果。HttpConnector.requestRaw() 已经
  // 对 !response.ok 无条件抛错（base.ts:164-169），这里钉住这个不变式，防止将来有人
  // 在 clinvar.ts 里加一层 try/catch 把失败悄悄降级成 {}/[]。
  test("阴性对照③：上游 500 时 call() 必须 reject，不吞成空结果", async () => {
    const http500 = new StubHttp(
      () => new BufferedResponse({ status: 500, headers: {}, body: new TextEncoder().encode("upstream error") }),
    );
    const connector = new ClinVarConnector({ http: http500 });
    await expect(connector.call("search", { query: "BRCA1" })).rejects.toThrow(/HTTP 500/);
  });
});

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "genomics");

function replayHttp(): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette: "clinvar", mode: "replay" });
}

describe("真实响应回放 · ClinVar", () => {
  test("search()：真实 esearch 命中 BRCA1，拿到 UID 列表", async () => {
    const connector = new ClinVarConnector({ http: replayHttp() });
    const result = (await connector.call("search", { query: "BRCA1", retmax: 3 })) as {
      esearchresult?: { idlist?: string[]; count?: string };
    };
    expect(result.esearchresult?.idlist?.length).toBe(3);
    expect(Number(result.esearchresult?.count)).toBeGreaterThan(0);
  });

  test("getSummary()：真实 esummary 按 UID 批量取详情，每条都有 title", async () => {
    const connector = new ClinVarConnector({ http: replayHttp() });
    const result = (await connector.call("getSummary", {
      id: ["4887763", "4887537", "4887439"],
    })) as { result?: { uids?: string[] } & Record<string, { title?: string } | string[] | undefined> };
    const uids = result.result?.uids ?? [];
    expect(uids.length).toBe(3);
    for (const uid of uids) {
      const rec = result.result?.[uid] as { title?: string } | undefined;
      expect(rec?.title).toBeTruthy();
    }
  });
});
