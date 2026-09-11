import { describe, expect, test } from "bun:test";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";
import { LiteratureSearcher } from "../../backend/src/literature/search";

// V67 深度（BACKLOG）/ 用户 2026-09-11 拍板：blended 档默认把每源抓取池从 10
// 加深到 BLENDED_DEEP_POOL(=30)。出处与机制见 search.ts 常量旁注释 +
// docs/devlog/W7-B1.md §四——浅池（perSource=10）下跨源重叠太稀薄，blended
// 排序没有材料可纠偏；这条测试钉住「谁触发深池、谁不触发」这件事本身，不重复
// 验证 blended 排序公式（那是 v67_ranking.test.ts 的范围）。
//
// 阴性对照：把 search.ts 里的 `BLENDED_DEEP_POOL` 从 30 改回 10 → 下面「① 无
// 显式 perSource」这条断言必须红（openalex 请求里的 per-page 会变回 10）。

const json = (payload: unknown) =>
  new BufferedResponse({
    status: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  });

// openalex `search()`（connectors/literature.ts）把 `limit` 映射成 URL 上的
// `per-page`——这是「registry 收到的 limit」在真实请求里唯一可外部观察到的落点，
// 比 mock 掉 ConnectorRegistry.call 更贴近生产路径（LiteratureSearcher 构造函数
// 只接受真实 ConnectorRegistry 实例，见 search.ts constructor 的 instanceof 判断）。
function perPageOf(http: StubHttp): string | null {
  const call = http.calls.find((c) => c.url.includes("openalex"));
  if (!call) return null;
  const url = new URL(call.url.startsWith("http") ? call.url : `https://x${call.url}`);
  return url.searchParams.get("per-page");
}

function threeResults() {
  return json({
    results: [
      { display_name: "Paper A", doi: "10.1/a" },
      { display_name: "Paper B", doi: "10.1/b" },
      { display_name: "Paper C", doi: "10.1/c" },
    ],
  });
}

function makeSearcher(): { searcher: LiteratureSearcher; http: StubHttp } {
  const http = new StubHttp(() => threeResults());
  const registry = new ConnectorRegistry({ http }).registerBuiltins();
  return { searcher: new LiteratureSearcher(registry), http };
}

describe("V67 深度：blended 默认深池（BLENDED_DEEP_POOL=30）", () => {
  test("① blended 且未显式给 perSource：registry 收到 limit=30（per-page=30）", async () => {
    const { searcher, http } = makeSearcher();
    await searcher.search("x", { sources: ["openalex"], rank: "blended" });
    expect(perPageOf(http)).toBe("30");
  });

  test("② 显式 perSource 优先于深池默认", async () => {
    const { searcher, http } = makeSearcher();
    await searcher.search("x", { sources: ["openalex"], rank: "blended", perSource: 7 });
    expect(perPageOf(http)).toBe("7");
  });

  test("③ --rank hits（或不传 rank，类级默认）：perSource 仍是 10，逐字节不变", async () => {
    const { searcher, http } = makeSearcher();
    await searcher.search("x", { sources: ["openalex"], rank: "hits" });
    expect(perPageOf(http)).toBe("10");

    const { searcher: searcher2, http: http2 } = makeSearcher();
    await searcher2.search("x", { sources: ["openalex"] }); // 不传 rank：类级默认 "hits"
    expect(perPageOf(http2)).toBe("10");
  });

  test("④ 深池只影响每源抓取池，合并去重排序后仍按 limit 截断返回条数", async () => {
    const { searcher } = makeSearcher();
    const result = await searcher.search("x", { sources: ["openalex"], rank: "blended", limit: 2 });
    expect(result.totalBeforeDedupe).toBe(3);
    expect(result.papers.length).toBe(2);
  });

  test("⑤ status.note 如实标注深池默认生效；显式 perSource 时不标注", async () => {
    const { searcher: a } = makeSearcher();
    const withDeepPool = await a.search("x", { sources: ["openalex"], rank: "blended" });
    const noteA = withDeepPool.sources.find((s) => s.source === "openalex")!.note;
    expect(noteA).toContain("深池 30/源");

    const { searcher: b } = makeSearcher();
    const explicitPerSource = await b.search("x", { sources: ["openalex"], rank: "blended", perSource: 30 });
    const noteB = explicitPerSource.sources.find((s) => s.source === "openalex")!.note;
    expect(noteB).toBeUndefined();

    const { searcher: c } = makeSearcher();
    const hitsMode = await c.search("x", { sources: ["openalex"], rank: "hits" });
    const noteC = hitsMode.sources.find((s) => s.source === "openalex")!.note;
    expect(noteC).toBeUndefined();
  });
});
