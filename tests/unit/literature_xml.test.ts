// W3-d · arXiv / PubMed 的 XML 解析 + TS 扩展装载强度单测。
//
// 覆盖：
//   1) `parseXml` 本身的语法覆盖（元素/属性/文本/CDATA/注释/自闭合/命名空间前缀）
//   2) arXiv connector：请求构造（query→search_query=all:{value} 前缀映射、
//      limit→max_results、getPaper 用 id_list） + Atom feed → 结构化 ArxivEntry
//      + arXiv"HTTP 200 但其实是错误"响应体分支的显式识别
//   3) PubMed connector：请求构造 + esearch→esummary 两跳串行链路 + efetch 的
//      结构化摘要解析（含带 Label 的分段摘要）
//   4) 阴性对照①（强制）：给两个源各喂一个畸形/截断的响应 → 显式抛错，不是静默空结果
//   5) 阴性对照②（强制）：arXiv/PubMed 的 handler 走 `connector.call()` 时，
//      同 tests/concurrency/connector_race.test.ts 同款并发不变式（N=140 混合工具
//      调用，并发结果与串行逐位一致）——这里额外覆盖 PubMed search() 内部两跳链路
//      本身引入的耦合风险（第二跳的 id 是否会在并发下串味）。

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BufferedResponse, StubHttp, type HttpRequestInit } from "../../backend/src/http/client";
import { FixtureHttp } from "../../backend/src/http/fixture";
import {
  XmlParseError,
  arxivShortId,
  localName,
  parsePubmedAbstractXml,
  parseXml,
  xmlChild,
  xmlChildren,
  xmlElementText,
} from "../../backend/src/connectors/literature";
import { arXivConnector, PubMedConnector } from "../../backend/src/connectors/literature";

// ─────────────────────────────────────────────────────────────────────────────
// 1) parseXml 语法覆盖
// ─────────────────────────────────────────────────────────────────────────────

describe("parseXml · 最小 XML 解析器", () => {
  test("嵌套元素 + 属性 + 文本", () => {
    const root = parseXml('<a x="1"><b y="2">hello</b><b>world</b></a>');
    expect(root.tag).toBe("a");
    expect(root.attrs.x).toBe("1");
    const bs = xmlChildren(root, "b");
    expect(bs.length).toBe(2);
    expect(bs[0]!.attrs.y).toBe("2");
    expect(xmlElementText(bs[0])).toBe("hello");
    expect(xmlElementText(bs[1])).toBe("world");
  });

  test("自闭合标签", () => {
    const root = parseXml('<link href="http://x" rel="alternate"/>');
    expect(root.tag).toBe("link");
    expect(root.children).toEqual([]);
    expect(root.attrs.href).toBe("http://x");
  });

  test("CDATA 段原样进文本", () => {
    const root = parseXml("<a><![CDATA[1 < 2 && 3 > 2]]></a>");
    expect(xmlElementText(root)).toBe("1 < 2 && 3 > 2");
  });

  test("实体解码：命名实体 + 数字实体（十进制/十六进制）", () => {
    const root = parseXml("<a>Q&amp;A &lt;tag&gt; &#65; &#x42;</a>");
    expect(xmlElementText(root)).toBe("Q&A <tag> A B");
  });

  test("注释与处理指令被跳过，不进树", () => {
    const root = parseXml('<?xml version="1.0"?><!-- top comment --><a><!-- inner -->x</a>');
    expect(root.tag).toBe("a");
    expect(xmlElementText(root)).toBe("x");
  });

  test("命名空间前缀按本名匹配（localName）", () => {
    const root = parseXml(
      '<feed xmlns:opensearch="urn:x"><opensearch:totalResults>3</opensearch:totalResults></feed>',
    );
    expect(localName(root.tag)).toBe("feed");
    const el = xmlChild(root, "totalResults");
    expect(xmlElementText(el)).toBe("3");
  });

  test("阴性对照①证据 a：未闭合标签 → 显式抛 XmlParseError，不是返回半截结果", () => {
    expect(() => parseXml("<a><b>hello</a>")).toThrow(XmlParseError);
    expect(() => parseXml("<a><b>hello</b>")).toThrow(XmlParseError); // 缺 </a>，提前到达文档末尾
  });

  test("阴性对照①证据 b：闭标签名不匹配 → 显式抛错", () => {
    expect(() => parseXml("<a><b>x</c></a>")).toThrow(/不匹配/);
  });

  test("阴性对照①证据 c：空文档 → 显式抛错", () => {
    expect(() => parseXml("   ")).toThrow(XmlParseError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) arXiv connector
// ─────────────────────────────────────────────────────────────────────────────

const ATOM_NS = 'xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"';

function atomFeed(entriesXml: string, totals = { total: 1, start: 0, perPage: 10 }): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed ${ATOM_NS}>` +
    `<opensearch:totalResults>${totals.total}</opensearch:totalResults>` +
    `<opensearch:startIndex>${totals.start}</opensearch:startIndex>` +
    `<opensearch:itemsPerPage>${totals.perPage}</opensearch:itemsPerPage>` +
    entriesXml +
    `</feed>`
  );
}

const SAMPLE_ENTRY = atomFeed(
  `<entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>  Attention Is
      All You Need  </title>
    <summary>  The dominant sequence transduction models...  </summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:comment>15 pages, 5 figures</arxiv:comment>
    <arxiv:doi>10.48550/arXiv.1706.03762</arxiv:doi>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`,
);

const ARXIV_ERROR_FEED = atomFeed(
  `<entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_ver1706.03762</id>
    <title>Error</title>
    <summary>incorrect id format for ver1706.03762</summary>
  </entry>`,
  { total: 0, start: 0, perPage: 0 },
);

function stubReturning(body: string, contentType = "application/atom+xml"): StubHttp {
  return new StubHttp(async () => new BufferedResponse({ status: 200, headers: { "content-type": contentType }, body: new TextEncoder().encode(body) }));
}

describe("arXivConnector", () => {
  test("search()：query→search_query=all:{value} 前缀映射 + limit→max_results", async () => {
    const http = new StubHttp(async (url) => {
      expect(url).toContain("search_query=all%3AAlphaFold");
      expect(url).toContain("max_results=3");
      expect(url).not.toContain("&query="); // 裸 query 参数没有被发出（只有 search_query）
      expect(url).not.toContain("limit=");
      return new BufferedResponse({ status: 200, headers: { "content-type": "application/atom+xml" }, body: new TextEncoder().encode(SAMPLE_ENTRY) });
    });
    const connector = new arXivConnector({ http });
    const feed = await connector.search({ query: "AlphaFold", limit: 3 });
    expect(feed.entries.length).toBe(1);
  });

  test("search() 不传 limit 时默认 max_results=10", async () => {
    const http = new StubHttp(async (url) => {
      expect(url).toContain("max_results=10");
      return new BufferedResponse({ status: 200, headers: { "content-type": "application/atom+xml" }, body: new TextEncoder().encode(atomFeed("")) });
    });
    const connector = new arXivConnector({ http });
    await connector.search({ query: "x" });
  });

  test("getPaper()：id 拼成 id_list，不是裸 id 参数", async () => {
    const http = new StubHttp(async (url) => {
      expect(url).toContain("id_list=1706.03762");
      expect(url).not.toContain("&id=1706.03762");
      return new BufferedResponse({ status: 200, headers: { "content-type": "application/atom+xml" }, body: new TextEncoder().encode(SAMPLE_ENTRY) });
    });
    const connector = new arXivConnector({ http });
    const feed = await connector.getPaper({ id: "1706.03762" });
    expect(feed.entries[0]!.shortId).toBe("1706.03762v7");
  });

  test("Atom entry → ArxivEntry：标题/摘要折叠空白，作者/链接/分类/主分类/评论/DOI 都取到", async () => {
    const connector = new arXivConnector({ http: stubReturning(SAMPLE_ENTRY) });
    const feed = await connector.search({ query: "attention" });
    expect(feed.totalResults).toBe(1);
    const e = feed.entries[0]!;
    expect(e.title).toBe("Attention Is All You Need");
    expect(e.summary).toBe("The dominant sequence transduction models...");
    expect(e.authors).toEqual([{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }]);
    expect(e.links).toHaveLength(2);
    expect(e.links[1]).toEqual({ href: "http://arxiv.org/pdf/1706.03762v7", rel: "related", type: "application/pdf", title: "pdf" });
    expect(e.categories).toEqual(["cs.CL", "cs.LG"]);
    expect(e.primaryCategory).toBe("cs.CL");
    expect(e.comment).toBe("15 pages, 5 figures");
    expect(e.doi).toBe("10.48550/arXiv.1706.03762");
    expect(e.shortId).toBe("1706.03762v7");
  });

  test("响应体分支：arXiv 对非法查询仍是 HTTP 200，但 entry 是错误占位 → 显式抛错而不是返回『0 篇论文』", async () => {
    const connector = new arXivConnector({ http: stubReturning(ARXIV_ERROR_FEED) });
    await expect(connector.search({ query: "ver1706.03762" })).rejects.toThrow(/arXiv API 返回了一个错误响应/);
  });

  test("阴性对照①：截断的 XML 响应 → search() 显式 reject，不是静默 0 条", async () => {
    const truncated = SAMPLE_ENTRY.slice(0, Math.floor(SAMPLE_ENTRY.length / 2)); // 砍掉后半段，标签必然不闭合
    const connector = new arXivConnector({ http: stubReturning(truncated) });
    await expect(connector.search({ query: "x" })).rejects.toThrow(XmlParseError);
  });

  test("阴性对照①：根元素不是 feed → 显式抛错", async () => {
    const connector = new arXivConnector({ http: stubReturning("<not-a-feed></not-a-feed>") });
    await expect(connector.search({ query: "x" })).rejects.toThrow(/不是预期的 Atom feed/);
  });

  test("arxivShortId：从完整 URL 里取末段 id（含版本号）", () => {
    expect(arxivShortId("http://arxiv.org/abs/1706.03762v7")).toBe("1706.03762v7");
    expect(arxivShortId("1706.03762")).toBe("1706.03762");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) PubMed connector
// ─────────────────────────────────────────────────────────────────────────────

function esearchJson(idlist: string[]): string {
  return JSON.stringify({ header: { type: "esearch", version: "0.3" }, esearchresult: { count: String(idlist.length), retmax: "10", retstart: "0", idlist } });
}

function esummaryJson(ids: string[]): string {
  const result: Record<string, unknown> = { uids: ids };
  for (const id of ids) result[id] = { uid: id, title: `Title for ${id}`, pubdate: "2021 Aug" };
  return JSON.stringify({ header: { type: "esummary", version: "0.3" }, result });
}

const PUBMED_ABSTRACT_XML = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">34265844</PMID><Article><ArticleTitle>Highly accurate protein structure prediction with AlphaFold.</ArticleTitle><Abstract><AbstractText Label="BACKGROUND" NlmCategory="BACKGROUND">Proteins are essential to life.</AbstractText><AbstractText Label="METHODS" NlmCategory="METHODS">We use a neural network.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;

describe("PubMedConnector", () => {
  test("search()：esearch(term=query) → esummary(id=逗号拼接)，两跳串行，最终返回 esummary 的形状", async () => {
    const calls: string[] = [];
    const http = new StubHttp(async (url) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("/esearch.fcgi")) {
        expect(u.searchParams.get("term")).toBe("alphafold");
        expect(u.searchParams.get("retmax")).toBe("5");
        return new BufferedResponse({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(esearchJson(["111", "222"])) });
      }
      if (u.pathname.endsWith("/esummary.fcgi")) {
        expect(u.searchParams.get("id")).toBe("111,222");
        return new BufferedResponse({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(esummaryJson(["111", "222"])) });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const connector = new PubMedConnector({ http });
    const result = (await connector.search({ query: "alphafold", limit: 5 })) as { result: { uids: string[] } };
    expect(calls.length).toBe(2); // 两跳都真的发出去了
    expect(result.result.uids).toEqual(["111", "222"]);
  });

  test("search()：esearch 空结果 → 不发第二跳请求", async () => {
    const calls: string[] = [];
    const http = new StubHttp(async (url) => {
      calls.push(url);
      return new BufferedResponse({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(esearchJson([])) });
    });
    const connector = new PubMedConnector({ http });
    await connector.search({ query: "zzz_no_such_thing_zzz" });
    expect(calls.length).toBe(1);
  });

  test("getPaper()：单 id 走 esummary，db/retmode 有默认值", async () => {
    const http = new StubHttp(async (url) => {
      const u = new URL(url);
      expect(u.pathname).toContain("esummary.fcgi");
      expect(u.searchParams.get("id")).toBe("34265844");
      expect(u.searchParams.get("db")).toBe("pubmed");
      expect(u.searchParams.get("retmode")).toBe("json");
      return new BufferedResponse({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(esummaryJson(["34265844"])) });
    });
    const connector = new PubMedConnector({ http });
    const result = (await connector.getPaper({ id: "34265844" })) as { result: { uids: string[] } };
    expect(result.result.uids).toEqual(["34265844"]);
  });

  test("getAbstract()：efetch XML → 结构化分段摘要（带 Label 拼接）", async () => {
    const http = new StubHttp(async (url) => {
      const u = new URL(url);
      expect(u.pathname).toContain("efetch.fcgi");
      expect(u.searchParams.get("rettype")).toBe("abstract");
      expect(u.searchParams.get("retmode")).toBe("xml");
      return new BufferedResponse({ status: 200, headers: { "content-type": "application/xml" }, body: new TextEncoder().encode(PUBMED_ABSTRACT_XML) });
    });
    const connector = new PubMedConnector({ http });
    const result = await connector.getAbstract({ id: "34265844" });
    expect(result.pmid).toBe("34265844");
    expect(result.title).toBe("Highly accurate protein structure prediction with AlphaFold.");
    expect(result.sections).toEqual([
      { label: "BACKGROUND", text: "Proteins are essential to life." },
      { label: "METHODS", text: "We use a neural network." },
    ]);
    expect(result.abstract).toBe("BACKGROUND: Proteins are essential to life.\n\nMETHODS: We use a neural network.");
  });

  test("阴性对照①：efetch 返回截断/畸形 XML → getAbstract() 显式 reject，不是返回 abstract:null 假装『没有摘要』", async () => {
    const broken = PUBMED_ABSTRACT_XML.slice(0, 120); // 砍在标签中间
    const http = new StubHttp(async () => new BufferedResponse({ status: 200, headers: { "content-type": "application/xml" }, body: new TextEncoder().encode(broken) }));
    const connector = new PubMedConnector({ http });
    await expect(connector.getAbstract({ id: "34265844" })).rejects.toThrow(XmlParseError);
  });

  test("阴性对照①：efetch 根元素不对 → 显式抛错", async () => {
    const http = new StubHttp(async () => new BufferedResponse({ status: 200, headers: { "content-type": "application/xml" }, body: new TextEncoder().encode("<Wrong></Wrong>") }));
    const connector = new PubMedConnector({ http });
    await expect(connector.getAbstract({ id: "34265844" })).rejects.toThrow(/不是预期的 PubmedArticleSet/);
  });

  test("parsePubmedAbstractXml 可独立调用（非 connector 路径也能复用）", () => {
    const parsed = parsePubmedAbstractXml(PUBMED_ABSTRACT_XML, "34265844");
    expect(parsed.pmid).toBe("34265844");
    expect(parsed.sections.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) 阴性对照②（强制）：并发不变式，同 tests/concurrency/connector_race.test.ts
//    的断言写法——通过 `connector.call()` 分发（与 daemon/swarm 的实际调用路径
//    一致），单实例高并发混合工具调用，结果与串行逐个调用逐位一致。
//
//    这里特别针对 PubMedConnector.search() 新引入的"内部两跳串行请求"设计：
//    第二跳（esummary）用的 id 完全来自第一跳响应 + 局部变量（`idlist`），
//    不经过任何跨调用共享的实例字段——这组并发测试就是用来验证这一点的。
// ─────────────────────────────────────────────────────────────────────────────

interface Echo {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

// 确定性 stub：esearch 把 term 编码进合成 id（`syn-<term>`），esummary/efetch
// 按请求里的 id 回显——如果并发下出现跨调用的状态污染（比如误用了共享字段而不是
// 局部变量传递两跳之间的 id），job i 的最终结果就会混入 job j 的 id/term，
// 与串行版本比对时会在 toEqual 上炸。
function pubmedRaceHttp(): StubHttp {
  return new StubHttp(async (url) => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
    const u = new URL(url);
    if (u.pathname.endsWith("/esearch.fcgi")) {
      const term = u.searchParams.get("term") ?? "";
      const id = `syn-${term}`;
      return new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(esearchJson([id])),
      });
    }
    if (u.pathname.endsWith("/esummary.fcgi")) {
      const id = u.searchParams.get("id") ?? "";
      return new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(esummaryJson([id])),
      });
    }
    if (u.pathname.endsWith("/efetch.fcgi")) {
      const id = u.searchParams.get("id") ?? "";
      const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><ArticleTitle>Title ${id}</ArticleTitle><Abstract><AbstractText>Abstract for ${id}.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
      return new BufferedResponse({ status: 200, headers: { "content-type": "application/xml" }, body: new TextEncoder().encode(xml) });
    }
    throw new Error(`pubmed race stub: unexpected url ${url}`);
  });
}

function arxivRaceHttp(): StubHttp {
  return new StubHttp(async (url) => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 8)));
    const u = new URL(url);
    const key = u.searchParams.get("id_list") || u.searchParams.get("search_query") || "";
    const xml = atomFeed(
      `<entry><id>http://arxiv.org/abs/${encodeURIComponent(key)}</id><title>Title ${key}</title><summary>Summary ${key}</summary><author><name>Author ${key}</name></author></entry>`,
    );
    return new BufferedResponse({ status: 200, headers: { "content-type": "application/atom+xml" }, body: new TextEncoder().encode(xml) });
  });
}

interface RaceBag {
  pubmed: PubMedConnector;
  arxiv: arXivConnector;
}

interface Job {
  label: string;
  exec: (bag: RaceBag) => Promise<unknown>;
}

function buildRaceJobs(n: number): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 5;
    switch (kind) {
      case 0:
        jobs.push({ label: `pubmed.search#${i}`, exec: (b) => b.pubmed.call("search", { query: `term-${i}`, limit: (i % 4) + 1 }) });
        break;
      case 1:
        jobs.push({ label: `pubmed.getPaper#${i}`, exec: (b) => b.pubmed.call("getPaper", { id: `id-${i}` }) });
        break;
      case 2:
        jobs.push({ label: `pubmed.getAbstract#${i}`, exec: (b) => b.pubmed.call("getAbstract", { id: `pmid-${i}` }) });
        break;
      case 3:
        jobs.push({ label: `arxiv.search#${i}`, exec: (b) => b.arxiv.call("search", { query: `q-${i}`, limit: (i % 5) + 1 }) });
        break;
      default:
        jobs.push({ label: `arxiv.getPaper#${i}`, exec: (b) => b.arxiv.call("getPaper", { id: `arxiv-id-${i}` }) });
    }
  }
  return jobs;
}

async function runRaceJobs(order: "serial" | "parallel", jobs: Job[]): Promise<unknown[]> {
  const bag: RaceBag = {
    pubmed: new PubMedConnector({ http: pubmedRaceHttp() }),
    arxiv: new arXivConnector({ http: arxivRaceHttp() }),
  };
  if (order === "serial") {
    const out: unknown[] = [];
    for (const job of jobs) out.push(await job.exec(bag));
    return out;
  }
  return Promise.all(jobs.map((job) => job.exec(bag)));
}

const RACE_N = 140;

describe("W3-d 阴性对照② · arXiv/PubMed 并发不变式（同 connector_race.test.ts 断言写法）", () => {
  test(`单实例各 ${RACE_N} 并发混合工具调用，结果与串行逐个调用逐位一致`, async () => {
    const jobs = buildRaceJobs(RACE_N);
    const serial = await runRaceJobs("serial", jobs);
    const parallel = await runRaceJobs("parallel", jobs);
    expect(serial.length).toBe(jobs.length);
    expect(parallel.length).toBe(jobs.length);
    for (let i = 0; i < jobs.length; i++) {
      expect(parallel[i]).toEqual(serial[i]);
    }
  });

  test("并发下 pubmed.search 的两跳链路没有串味：每个 job 的最终 uid 都对应自己的 term", async () => {
    const jobs = buildRaceJobs(RACE_N);
    const parallel = await runRaceJobs("parallel", jobs);
    const searchJobs = jobs
      .map((job, idx) => ({ job, out: parallel[idx] as { result?: { uids?: string[] } } }))
      .filter(({ job }) => job.label.startsWith("pubmed.search#"));
    expect(searchJobs.length).toBe(28); // 140/5
    for (const { job, out } of searchJobs) {
      const i = Number(job.label.split("#")[1]);
      expect(out.result?.uids).toEqual([`syn-term-${i}`]);
    }
  });

  test("并发下 arxiv.getPaper 的 id_list 没有串味", async () => {
    const jobs = buildRaceJobs(RACE_N);
    const parallel = await runRaceJobs("parallel", jobs);
    const getPaperJobs = jobs
      .map((job, idx) => ({ job, out: parallel[idx] as { entries: Array<{ shortId: string | null }> } }))
      .filter(({ job }) => job.label.startsWith("arxiv.getPaper#"));
    expect(getPaperJobs.length).toBe(28);
    for (const { job, out } of getPaperJobs) {
      const i = Number(job.label.split("#")[1]);
      expect(out.entries[0]!.shortId).toBe(`arxiv-id-${i}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) 真实网络录制回放（无网络，CI 常驻）
//
// 下面五个 cassette 是 2026-09-10 用这两个 connector 本身（走 FixtureHttp
// mode=record）真实打 export.arxiv.org / eutils.ncbi.nlm.nih.gov 录制的——不是
// 手写的样例数据，命中了真实响应里的一些噪音（PubMed 的 DOCTYPE 声明、摘要里
// 混着 `<sup>` 引用角标的行内标记、esearch 的 translationset 等字段）。
// 这组测试既验证解析器在真实响应上不崩，也是"两个源接入统一检索需要的原始数据
// 形状"的活文档——见 docs/devlog/W3-d.md 给 normalize.ts 的交接说明。
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "literature");

function replayHttp(cassette: string): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette, mode: "replay" });
}

describe("真实响应回放 · arXiv", () => {
  test("search()：真实 Atom feed 解析出 3 条结构完整的论文", async () => {
    const connector = new arXivConnector({ http: replayHttp("arxiv-search") });
    const feed = await connector.search({ query: "AlphaFold protein structure prediction", limit: 3 });
    expect(feed.entries.length).toBe(3);
    for (const e of feed.entries) {
      expect(e.title).toBeTruthy();
      expect(e.shortId).toBeTruthy();
      expect(e.authors.length).toBeGreaterThan(0);
      expect(e.links.some((l) => l.type === "application/pdf")).toBe(true);
    }
  });

  test("getPaper()：真实响应里拿到《Attention Is All You Need》", async () => {
    const connector = new arXivConnector({ http: replayHttp("arxiv-getpaper") });
    const feed = await connector.getPaper({ id: "1706.03762" });
    expect(feed.entries[0]!.title).toBe("Attention Is All You Need");
    expect(feed.entries[0]!.shortId).toContain("1706.03762");
    expect(feed.entries[0]!.categories.length).toBeGreaterThan(0);
  });
});

describe("真实响应回放 · PubMed", () => {
  test("search()：真实 esearch→esummary 两跳链路，5 篇都带 title", async () => {
    const connector = new PubMedConnector({ http: replayHttp("pubmed-search") });
    const result = (await connector.search({ query: "AlphaFold protein structure prediction", limit: 5 })) as {
      result: { uids: string[] } & Record<string, { title?: string } | string[] | undefined>;
    };
    expect(result.result.uids.length).toBe(5);
    for (const uid of result.result.uids) {
      const rec = result.result[uid] as { title?: string };
      expect(rec.title).toBeTruthy();
    }
  });

  test("getPaper()：真实响应命中 AlphaFold 的 Nature 论文", async () => {
    const connector = new PubMedConnector({ http: replayHttp("pubmed-getpaper") });
    const result = (await connector.getPaper({ id: "34265844" })) as { result: Record<string, { title?: string; source?: string }> };
    expect(result.result["34265844"]!.title).toContain("AlphaFold");
    expect(result.result["34265844"]!.source).toBe("Nature");
  });

  test("getAbstract()：真实 efetch XML（带 DOCTYPE + 摘要里混着 <sup> 引用角标）解析不崩，拿到干净摘要正文", async () => {
    const connector = new PubMedConnector({ http: replayHttp("pubmed-getabstract") });
    const result = await connector.getAbstract({ id: "34265844" });
    expect(result.pmid).toBe("34265844");
    expect(result.title).toBe("Highly accurate protein structure prediction with AlphaFold.");
    expect(result.abstract).toContain("Proteins are essential to life");
    // 已知取舍：<sup>1-4</sup> 这类行内引用角标的文本内容会丢失（见 xmlElementText
    // 的文档注释），但周围的正文没有被打乱或截断。
    expect(result.abstract).toContain("the structures of around 100,000 unique proteins have been determined");
    expect(result.sections.length).toBe(1); // 这篇摘要没有 BACKGROUND/METHODS 这类 Label 分段
  });
});
