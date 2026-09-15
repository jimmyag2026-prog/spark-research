import { describe, expect, test } from "bun:test";
import { arxivErrorOf, searchPayloadProblem, upstreamErrorOf } from "../../backend/src/connectors/base";

// v0.10 lane γ-3（V175）门禁：逐源核「HTTP 200 带业务错误」的形状。
//
// U45 的残余：`upstreamErrorOf` 只认 NCBI 加通用三键（errCode/errMsg/error），
// 其余源一条都没盘过。下面每个源一条门禁，**夹具是 2026-09-16 实探的真实响应片段**
// （命令与原文见 docs/devlog/W10-gamma.md §γ-3），不是手编的形状。
//
// 每条都配一条「合法的空结果不能被误判成错误」的反向断言——V175 要防的不只是漏判，
// 还有为了堵漏判把 0 条结果打成错误（0 条是合法结果，语法错不是，这是 U40 定的界）。

// ── 真实响应片段（原样粘贴，不转述）──────────────────────────────────────
const REAL = {
  // curl 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term=' → HTTP 200
  pubmed: { header: { type: "esearch", version: "0.3" }, esearchresult: { ERROR: "Empty term and query_key - nothing todo" } },
  // curl 'https://api.openalex.org/works?filter=nonsense_field:zz' → HTTP 400（体形状同 200-带错）
  openalex: { error: "Invalid query parameters error.", message: "nonsense_field is not a valid field. Valid fields are underscore or hyphenated versions of: abstract.search, ..." },
  // curl 'https://api.crossref.org/works?query=cancer&rows=notanumber'
  crossref: {
    status: "failed",
    "message-type": "validation-failure",
    message: [{ type: "integer-not-valid", value: "notanumber", message: "Integer specified as notanumber but must be a positive integer less than or equal to 1000. " }],
  },
  // curl 'https://api.semanticscholar.org/graph/v1/paper/search?query=&fields=title'
  semanticscholar: { message: "Too Many Requests. Please wait and try again or apply for a key for higher rate limits. https://www.semanticscholar.org/product/api#api-key-form", code: "429" },
  // curl 'https://datacenter.aminer.cn/gateway/open_platform/api/paper/search?query=test'（不带凭据）
  aminer: { code: 40308, success: false, msg: "Get Authorization Error", data: null, log_id: "3JNHNRFf2tzPL59i0e3dMEzoFkg" },
  // U40 现场：Europe PMC 用 200 回了一个没有 hitCount / resultList 的空壳
  europepmc: { version: "6.9" },
};

describe("γ-3 逐源：200-带错必须被认出来", () => {
  test("pubmed · esearchresult.ERROR（U45 现场原文）", () => {
    expect(upstreamErrorOf("pubmed", REAL.pubmed)).toBe("Empty term and query_key - nothing todo");
    expect(searchPayloadProblem("pubmed", REAL.pubmed)).toContain("被上游拒绝");
    expect(searchPayloadProblem("pubmed", { esearchresult: { idlist: [] } })).toBeNull();
  });

  test("openalex · error + message（message 里才是「哪个字段不对」）", () => {
    const hit = upstreamErrorOf("openalex", REAL.openalex);
    expect(hit).toContain("Invalid query parameters error.");
    expect(hit).toContain("nonsense_field is not a valid field");
    expect(searchPayloadProblem("openalex", { results: [], meta: { count: 0 } })).toBeNull();
  });

  test("crossref · status=failed（错误体里也有 message，而 message 在 SEARCH_RESULT_KEYS 里）", () => {
    // 修前：三个通用键一个都不在 → null → `message` 这个键让它当成合法空结果放行。
    // 与 U45 里 esearchresult 被放行是**同一个形状**，只是换了个源。
    const hit = upstreamErrorOf("crossref", REAL.crossref);
    expect(hit).toContain("status=failed");
    expect(hit).toContain("must be a positive integer");
    expect(searchPayloadProblem("crossref", REAL.crossref)).toContain("被上游拒绝");
    // 反向：成功响应的 status=ok、message 是对象 → 不许误判
    expect(searchPayloadProblem("crossref", { status: "ok", message: { items: [] } })).toBeNull();
  });

  test("semanticscholar · message 字符串 + code（同上，message 键让它蒙混过关）", () => {
    const hit = upstreamErrorOf("semanticscholar", REAL.semanticscholar);
    expect(hit).toContain("429");
    expect(hit).toContain("Too Many Requests");
    expect(searchPayloadProblem("semanticscholar", REAL.semanticscholar)).toContain("被上游拒绝");
    // 反向：S2 的合法空结果是 { total: 0, data: [] }，没有顶层 message
    expect(searchPayloadProblem("semanticscholar", { total: 0, data: [] })).toBeNull();
  });

  test("aminer · code/success/msg（与通用三键一个都不重合；这是我们唯一持凭据的源）", () => {
    const hit = upstreamErrorOf("aminer", REAL.aminer);
    expect(hit).toContain("code=40308");
    expect(hit).toContain("Get Authorization Error");
    // 错误摘要里不许出现凭据（AD-2）：整条摘要只由 code 与 msg 拼成。
    expect(hit).not.toContain("api_key");
    expect(searchPayloadProblem("aminer", { code: 0, success: true, data: { items: [] } })).toBeNull();
  });

  test("europepmc · 空壳（U40）：归「没有结果容器」那条，不是带错键", () => {
    expect(upstreamErrorOf("europepmc", REAL.europepmc)).toBeNull();
    expect(searchPayloadProblem("europepmc", REAL.europepmc)).toContain("既没有结果也没有计数字段");
    expect(searchPayloadProblem("europepmc", { version: "6.9", hitCount: 0, resultList: { result: [] } })).toBeNull();
  });

  test("arxiv · Atom 错误信封（字符串载荷，走单独一条；本次 IP 被封未实探，按 API 手册写）", () => {
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_9999.99999</id>
    <title>Error</title>
    <summary>incorrect id format for 9999.99999</summary>
  </entry>
</feed>`;
    expect(arxivErrorOf(feed)).toBe("incorrect id format for 9999.99999");
    expect(searchPayloadProblem("arxiv", feed)).toContain("被上游拒绝");
    // 既有判据逐字未改：认不出错误信封的字符串照旧落「非对象响应」（ux_window 那条钉子）
    expect(searchPayloadProblem("arxiv", "<xml/>")).toContain("非对象");
  });

  test("表里没有的源退回通用三键（不给没实探过的源凭空加判据）", () => {
    expect(upstreamErrorOf("cnki", { errCode: "E1", errMsg: "x" })).toBe("E1");
    expect(upstreamErrorOf("cnki", { code: 40308, success: false, msg: "x" })).toBeNull();
  });
});
