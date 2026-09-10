// bioRxiv / medRxiv 预印本（Cold Spring Harbor 公共 API）。免 key。官方文档未给出
// 具体限速数字（「没写来源的数字不许进表」——不设 HOST_RATE_POLICIES 条目）。
//
// 拉动来源（§1.4.2 checklist □0）：F-1 缺口——v0.5 connector 扩展调研点名的「生物预印本」
// 空白，literature 域此前没有覆盖 bioRxiv/medRxiv。
//
// **这个 API 没有全文检索端点**，只有两种原语：
//   1. `/details/{server}/{count}` —— 某服务器最近 N 篇
//   2. `/details/{server}/{doi}` —— 按 DOI 精确查（含所有历史版本）
// 下面暴露 4 个工具：`getRecent` / `getByDoi` 是对上面两个端点的直接映射（原样透传
// 原始 JSON，不做任何处理）；`search` / `getPaper` 是**在这两个原语之上、connector 层
// 内部组合出来的复合工具**，为的是让 bioRxiv 能用与其余 6 个 literature connector
// 一致的 "search"/"getPaper" 接口名接入统一检索（`literature/search.ts` 对所有源走同一套
// `registry.call(source, "search"/"getPaper", ...)` 调度，不为单个源特判）。
//
// **`search` 的真实行为，务必知道**：它不是关键词全文检索，而是「拉最近 N 篇
// （默认 200，见 DEFAULT_SEARCH_WINDOW）+ 客户端 token 重叠打分过滤」——受 API 本身
// 结构性限制（没有真正的检索端点），这是能做到的最好近似。**查不到 ≠ 该预印本不存在**，
// 可能只是发表时间超出了最近 N 篇的窗口。需要覆盖更早 bioRxiv 内容时，改用
// europepmc/openalex（它们索引 bioRxiv 全部历史内容）。`getPaper` 只认 DOI 形态的 id
// （内部转发到 `getByDoi`）——`literature/search.ts` 的 `fetchOne()` 对非 DOI id
// 会直接标 skipped，不会打一次注定失败的请求（与 crossref/openalex 同一处理）。
import { HttpConnector, type ConnectorOptions, type HttpConnectorConfig } from "./base";

const SERVERS = ["biorxiv", "medrxiv"] as const;
type Server = (typeof SERVERS)[number];

function assertServer(value: unknown, toolName: string): void {
  if (value !== undefined && !SERVERS.includes(value as Server)) {
    throw new Error(`Connector "biorxiv" tool "${toolName}" 参数 server 只能是 "biorxiv" 或 "medrxiv"`);
  }
}

// 「最近 N 篇」窗口大小：越大越可能命中，但请求也越慢（上游一次性返回整批 JSON，
// 没有分页游标以外的筛选手段）。200 是与上游 openscience 调研笔记一致的取值。
export const DEFAULT_SEARCH_WINDOW = 200;

export const biorxivConfig: HttpConnectorConfig = {
  baseUrl: "https://api.biorxiv.org/details",
  description: "bioRxiv / medRxiv 生物与健康科学预印本（Cold Spring Harbor 公共 API，免 key）",
  tools: [
    {
      name: "getRecent",
      description: "获取某服务器最近 N 篇预印本（无全文检索，只有『最近 N 篇』）。参数：{ server?, count? }",
      endpoint: "/{server}/{count}",
    },
    { name: "getByDoi", description: "按 DOI 精确获取记录（含所有历史版本）。参数：{ server?, doi }", endpoint: "/{server}/{doi}" },
    {
      name: "search",
      description:
        "复合工具（非官方端点）：在最近 N 篇窗口内（默认 200）按关键词重叠打分过滤，模拟检索。" +
        "参数：{ query, limit?, server?, windowSize? }。查不到 ≠ 不存在，可能只是超出窗口。",
      endpoint: "/{server}/{count}",
    },
    {
      name: "getPaper",
      description: "复合工具：按 DOI 获取单篇（转发到 getByDoi）。参数：{ id（须为 DOI）, server? }",
      endpoint: "/{server}/{doi}",
    },
  ],
  metadata: {
    domain: "api.biorxiv.org",
    apiKeyRequired: false,
    status: "available",
    caveat:
      "该 API 没有全文检索端点：search 是 connector 层用『最近 N 篇（默认 200）+ 客户端关键词打分』模拟出来的" +
      "复合工具，不是真正的检索，查不到 ≠ 不存在（可能只是超出窗口）——需要覆盖更早预印本时改用 europepmc/openalex。" +
      "getPaper 只支持 DOI 形态的 id。",
  },
};

interface RecentPayload {
  collection?: unknown[];
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

function haystackOf(item: unknown): string {
  if (typeof item !== "object" || item === null) return "";
  const obj = item as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title : "";
  const abstract = typeof obj.abstract === "string" ? obj.abstract : "";
  return `${title} ${abstract}`.toLowerCase();
}

// 简单 token 重叠计数打分——不是 tf-idf/BM25，够用来把「一个词都不沾边」的条目
// 排除掉、把「沾边词更多」的条目排前面，不追求学术级相关性排序。
function scoreMatch(item: unknown, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack = haystackOf(item);
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score++;
  return score;
}

// **实测发现的真坑**（2026-09-10，真实打 api.biorxiv.org 录制 fixture 时撞上）：
// bioRxiv 的 doi 本身含 "/"（如 "10.1101/2021.01.01.20248001"），而
// `HttpConnector.requestRaw()` 的 `{param}` 路径替换统一走 `encodeURIComponent`——
// 会把 doi 内部的 "/" 转义成 "%2F"；这个 API 服务器对 "%2F" 形态的路径原样返回
// 404（curl 实测复现），doi 里的 "/" 必须原样出现在路径分段里，不能被转义。
// `requestRaw()` 的转义策略是所有 connector 共用的通用行为（`connectors/base.ts`，
// 不在本 lane 文件所有权范围内，不改动它），所以 `getByDoi` 不走 `requestRaw()`，
// 自己按 "/" 分段各自 encodeURIComponent 后拼 URL——既保留作分隔符的字面 "/"，
// 又转义每段内部真正需要转义的字符。staged 阶段的单测断言过 "%2F" 是"正确拼接"，
// 那是从未跑过真实网络时的想当然；本文件对应测试已改成断言真实能用的形态
// （见 tests/unit/connector_biorxiv.test.ts）。
function encodeDoiSegments(doi: string): string {
  return doi
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export class BioRxivConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("biorxiv", biorxivConfig, options);
    this.handle("getRecent", (p) => this.getRecent(p));
    this.handle("getByDoi", (p) => this.getByDoi(p));
    this.handle("search", (p) => this.search(p));
    this.handle("getPaper", (p) => this.getPaper(p));
  }

  async getRecent(params: { server?: Server; count?: number } & Record<string, unknown>): Promise<RecentPayload> {
    const mapped: Record<string, unknown> = { ...params };
    assertServer(mapped.server, "getRecent");
    mapped.server ??= "biorxiv";
    mapped.count ??= params.count ?? 100;
    return this.requestRaw("getRecent", mapped) as Promise<RecentPayload>;
  }

  async getByDoi(params: { server?: Server; doi?: string } & Record<string, unknown>): Promise<unknown> {
    const doi = params.doi;
    if (!doi) throw new Error('Connector "biorxiv" tool "getByDoi" 需要参数 doi');
    assertServer(params.server, "getByDoi");
    const server: Server = params.server ?? "biorxiv";
    // 不走 requestRaw()——见上方 encodeDoiSegments 的坑记录：doi 内部的 "/" 必须原样
    // 保留在路径里，requestRaw() 的通用 {param} 替换会把它转义成 "%2F" 导致 404。
    // （工具名合法性已由 call() → assertKnownTool() 在分发进 handler 之前查过一遍；
    // 直接方法调用如 getPaper() → getByDoi() 不经过那道检查，属预期，与其余
    // connector 里"复合方法直接调子方法"的写法一致。）
    const url = `${this.config.baseUrl}/${encodeURIComponent(server)}/${encodeDoiSegments(doi)}`;
    const response = await this.http.request(url, {
      method: "GET",
      headers: { Accept: "application/json", ...this.headersFor("getByDoi") },
    });
    if (!response.ok) {
      // 与 requestRaw() 同一错误消息形状，只带状态码，不回显响应体/请求头。
      throw new Error(`Connector "biorxiv" tool "getByDoi" failed: HTTP ${response.status}`);
    }
    return response.json();
  }

  // 复合工具：不直接调 requestRaw("search", ...)——"search" 在 config.tools 里只是为了
  // 让 assertKnownTool()/listTools() 认得这个名字，真正的 HTTP 请求都走 getRecent()。
  async search(
    params: { query?: string; limit?: number; server?: Server; windowSize?: number } & Record<string, unknown>,
  ): Promise<RecentPayload> {
    const query = typeof params.query === "string" ? params.query : "";
    if (!query) throw new Error('Connector "biorxiv" tool "search" 需要参数 query');
    const limit = params.limit ?? 10;
    const windowSize = params.windowSize ?? DEFAULT_SEARCH_WINDOW;
    const recent = await this.getRecent({ server: params.server, count: windowSize });
    const pool = Array.isArray(recent.collection) ? recent.collection : [];
    const tokens = tokenize(query);
    const scored = pool
      .map((item) => ({ item, score: scoreMatch(item, tokens) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.item);
    return { collection: scored };
  }

  async getPaper(params: { id?: string; server?: Server } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "biorxiv" tool "getPaper" 需要参数 id（DOI）');
    return this.getByDoi({ server: params.server, doi: id });
  }
}
