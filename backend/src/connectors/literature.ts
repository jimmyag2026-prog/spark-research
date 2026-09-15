import { credentialMissingResult } from "./aminer";
import { HttpConnector, type ConnectorOptions, type HttpConnectorConfig } from "./base";
import { politeHeaders } from "./politeness";

// ─────────────────────────────────────────────────────────────────────────────
// W3-d · 最小 XML 解析器（arXiv 的 Atom feed + PubMed efetch 的 PubmedArticleSet）
//
// **不是**一个通用 XML/DOM 库——刻意收窄到这两个源实际用到的语法子集：
// 元素 / 属性 / 文本 / CDATA / 注释 / 处理指令 / DOCTYPE，**不**处理 XML
// 命名空间语义（标签按去掉 `prefix:` 前缀后的本名匹配，见 `localName`）、
// 不处理外部实体、不做 DTD 校验。这与本文件里 `manifest.ts` 的"受限路径 DSL"
// 同一种克制哲学：只做两个具体来源真实需要的那部分，不做"以防万一"的通用能力。
//
// **格式错误必须显式抛错，不能吞掉退化成"看起来正常的空结果"**——这是
// W3-d 阴性对照①的直接落地：`parseXml` 对未闭合标签 / 标签不匹配 / 提前
// 到达文档末尾等情况一律 throw，调用方（`search()` / `getAbstract()`）不做
// try/catch 吞掉，让错误原样冒泡给 `run()`（search.ts）按 outcome:"failed"
// 如实标注，而不是静默产出 0 篇论文伪装成"这个源刚好没有结果"。
// ─────────────────────────────────────────────────────────────────────────────

export interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

const XML_ENTITY_MAP: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const isHex = ent[1] === "x" || ent[1] === "X";
      const code = Number.parseInt(ent.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITY_MAP[ent] ?? whole;
  });
}

// 去掉标签的命名空间前缀（`opensearch:totalResults` → `totalResults`）。
// 本解析器不做真正的命名空间 URI 解析——两个来源的标签名在各自文档里从不冲突，
// 按本名做子元素查找足够用，也避免了在 manifest 那种受限 DSL 之外再造一套
// 命名空间解析规则。
export function localName(tag: string): string {
  const idx = tag.indexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

export function parseXml(input: string): XmlElement {
  let i = 0;
  const n = input.length;

  function fail(msg: string): never {
    throw new XmlParseError(`XML 解析失败（字符位置 ${i}/${n}）：${msg}`);
  }

  function isWs(ch: string | undefined): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  function skipWs(): void {
    while (i < n && isWs(input[i])) i++;
  }

  function startsWith(s: string): boolean {
    return input.startsWith(s, i);
  }

  function skipMisc(): void {
    for (;;) {
      skipWs();
      if (startsWith("<?")) {
        const end = input.indexOf("?>", i);
        if (end < 0) fail("未闭合的处理指令（<?...?>）");
        i = end + 2;
        continue;
      }
      if (startsWith("<!--")) {
        const end = input.indexOf("-->", i);
        if (end < 0) fail("未闭合的注释（<!--...-->）");
        i = end + 3;
        continue;
      }
      if (startsWith("<!DOCTYPE")) {
        const end = input.indexOf(">", i);
        if (end < 0) fail("未闭合的 DOCTYPE 声明");
        i = end + 1;
        continue;
      }
      break;
    }
  }

  const NAME_RE = /^[A-Za-z_:][\w:.\-]*/;

  function parseName(kind: string): string {
    const m = NAME_RE.exec(input.slice(i));
    if (!m) fail(`期望一个${kind}名`);
    i += m![0].length;
    return m![0];
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWs();
      if (startsWith("/>") || startsWith(">") || i >= n) return attrs;
      const name = parseName("属性");
      skipWs();
      if (input[i] !== "=") fail(`属性 "${name}" 缺少 "="`);
      i++;
      skipWs();
      const quote = input[i];
      if (quote !== '"' && quote !== "'") fail(`属性 "${name}" 的值必须用引号包裹`);
      i++;
      const end = input.indexOf(quote, i);
      if (end < 0) fail(`属性 "${name}" 的值未闭合`);
      attrs[name] = decodeXmlEntities(input.slice(i, end));
      i = end + 1;
    }
  }

  function parseElement(): XmlElement {
    if (input[i] !== "<") fail('期望 "<" 开始一个元素');
    i++;
    const tag = parseName("标签");
    skipWs();
    const attrs = parseAttrs();
    skipWs();
    if (startsWith("/>")) {
      i += 2;
      return { tag, attrs, children: [], text: "" };
    }
    if (input[i] !== ">") fail(`标签 "${tag}" 的开标签未正确闭合`);
    i++;
    const children: XmlElement[] = [];
    let text = "";
    for (;;) {
      if (i >= n) fail(`标签 "${tag}" 未闭合就到达了文档末尾`);
      if (startsWith("<![CDATA[")) {
        const end = input.indexOf("]]>", i + 9);
        if (end < 0) fail("未闭合的 CDATA 段");
        text += input.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      if (startsWith("<!--")) {
        const end = input.indexOf("-->", i);
        if (end < 0) fail("未闭合的注释（<!--...-->）");
        i = end + 3;
        continue;
      }
      if (startsWith("</")) {
        const closeStart = i + 2;
        const m = NAME_RE.exec(input.slice(closeStart));
        if (!m) fail("闭标签缺少标签名");
        const name = m[0];
        let j = closeStart + name.length;
        while (j < n && isWs(input[j])) j++;
        if (input[j] !== ">") fail(`闭标签 "</${name}>" 未正确闭合`);
        if (name !== tag) fail(`闭标签 "</${name}>" 与开标签 "<${tag}>" 不匹配`);
        i = j + 1;
        return { tag, attrs, children, text: decodeXmlEntities(text) };
      }
      if (input[i] === "<") {
        children.push(parseElement());
        continue;
      }
      const next = input.indexOf("<", i);
      if (next < 0) fail(`标签 "${tag}" 未闭合就到达了文档末尾`);
      text += input.slice(i, next);
      i = next;
    }
  }

  skipMisc();
  skipWs();
  if (i >= n) fail("空文档（没有根元素）");
  const root = parseElement();
  return root;
}

export function xmlChildren(el: XmlElement, tag: string): XmlElement[] {
  const want = localName(tag);
  return el.children.filter((c) => localName(c.tag) === want);
}

export function xmlChild(el: XmlElement, tag: string): XmlElement | undefined {
  return xmlChildren(el, tag)[0];
}

// **已知取舍（如实记录，不是 bug）**：只取直接文本子节点，嵌在行内标记
// （PubMed 摘要里常见的 `<sup>1-4</sup>` 引用角标、`<i>species name</i>` 斜体）
// 里的文本会丢失——本解析器的 AST 把"文本"和"子元素"分开存放，不记录二者在
// 原文里的交错顺序，所以没有廉价的方式按文档序拼出完整 `textContent`。对"清洁
// 摘要正文"这个用途，丢掉引用角标数字是可接受的取舍（真实录制的 fixture
// tests/fixtures/literature/pubmed-getabstract.json 里能看到这个效果）；如果
// 未来有场景需要逐字还原，需要先把 AST 换成保序的 text/element 混合节点列表，
// 目前没有这个需求，不做超前设计。
export function xmlElementText(el: XmlElement | undefined): string {
  return el ? el.text.trim() : "";
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// PubMed（NCBI E-utilities）
// ─────────────────────────────────────────────────────────────────────────────
//
// **W1-c 交接说的"query → term 纯改名，mapTo 直接够用"只覆盖了 esearch 一个端点的
// 请求构造**；真正让 `search` 工具能喂出可用于统一检索的论文（有 title/authors，
// 不只是一串 PMID）需要 esearch → esummary **两次串行请求**（先拿 id 列表，
// 再按 id 批量拿摘要式详情），第二次请求依赖第一次的响应内容（id 列表）——
// 这是"一个 tool = 一次 HTTP 请求"的 manifest 模型结构性表达不了的形态，
// 比 W1-c 标出的字符串前缀缺口更根本。详见 docs/devlog/W3-d.md。
//
// esearch / esummary 都天然是 JSON（retmode=json），**不需要 XML 解析**；
// 真正需要下面 XML 解析器的只有 `getAbstract`（efetch 的 abstract 只有 XML/纯文本
// 两种 retmode，JSON 不可选）。

export const pubmedConfig: HttpConnectorConfig = {
  baseUrl: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
  description: "PubMed 生物医学文献数据库（NCBI E-utilities）",
  tools: [
    { name: "search", description: "检索 PubMed 文献（esearch 取 id 列表 → esummary 取详情，两次请求合并成一次工具调用）", endpoint: "/esearch.fcgi" },
    { name: "getPaper", description: "按 PMID（或逗号分隔的多个 PMID）获取摘要式详情（esummary）", endpoint: "/esummary.fcgi" },
    { name: "getAbstract", description: "按 PMID 获取结构化摘要正文（efetch XML 解析）", endpoint: "/efetch.fcgi", responseType: "text" },
  ],
  metadata: {
    domain: "ncbi.nlm.nih.gov",
    apiKeyRequired: false,
    status: "available",
    caveat:
      "search 每次调用对 eutils 发两次请求（esearch + esummary），与 getPaper/getAbstract 共享同一 NCBI 主机预算——" +
      "限速器（BACKLOG V26）将来必须按 host 键控合池，不能按 connector 各自为政",
  },
};

interface PubmedEsearchResult {
  esearchresult?: { idlist?: unknown };
}

function idlistOf(payload: unknown): string[] {
  const list = (payload as PubmedEsearchResult | undefined)?.esearchresult?.idlist;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

interface PubmedAbstractSection {
  label: string | null;
  text: string;
}

export interface PubmedAbstractResult {
  pmid: string;
  title: string | null;
  abstract: string | null;
  sections: PubmedAbstractSection[];
}

// efetch（rettype=abstract&retmode=xml）的响应形状：
//   PubmedArticleSet > PubmedArticle > MedlineCitation > { PMID, Article: { ArticleTitle, Abstract: { AbstractText[] } } }
// 结构化摘要（BACKGROUND/METHODS/...）体现为多个带 Label 属性的 AbstractText。
export function parsePubmedAbstractXml(xmlText: string, requestedId: string): PubmedAbstractResult {
  const root = parseXml(xmlText); // 格式错误在这里 throw（阴性对照①）
  if (localName(root.tag) !== "PubmedArticleSet") {
    throw new Error(`PubMed efetch 响应不是预期的 PubmedArticleSet（根元素是 "${root.tag}"）`);
  }
  const article = xmlChild(root, "PubmedArticle");
  if (!article) {
    throw new Error(`PubMed efetch 响应里没有 PubmedArticle（PMID "${requestedId}" 可能不存在或已被撤回）`);
  }
  const medline = xmlChild(article, "MedlineCitation");
  const pmidEl = medline && xmlChild(medline, "PMID");
  const articleEl = medline && xmlChild(medline, "Article");
  const title = articleEl ? xmlElementText(xmlChild(articleEl, "ArticleTitle")) : "";
  const abstractEl = articleEl && xmlChild(articleEl, "Abstract");
  const sections: PubmedAbstractSection[] = abstractEl
    ? xmlChildren(abstractEl, "AbstractText").map((el) => ({
        label: el.attrs.Label ?? el.attrs.NlmCategory ?? null,
        text: xmlElementText(el),
      }))
    : [];
  const abstract =
    sections.length > 0 ? sections.map((s) => (s.label ? `${s.label}: ${s.text}` : s.text)).join("\n\n") : null;
  return {
    pmid: pmidEl ? xmlElementText(pmidEl) : requestedId,
    title: title || null,
    abstract,
    sections,
  };
}

export class PubMedConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("pubmed", pubmedConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getPaper", (p) => this.getPaper(p));
    this.handle("getAbstract", (p) => this.getAbstract(p));
  }

  // NCBI 建议所有 eutils 调用带 tool + email 参数（比 User-Agent 更明确地进入
  // NCBI 自己的"礼貌调用"识别路径），照抄 OpenAlex/CrossRef 已有的 mailto 惯例。
  protected override queryFor(): Record<string, string> {
    return { tool: "spark-research", email: this.options.contactEmail ?? politeHeaders().From };
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  // 统一检索调用方传 { query, limit }（见 search.ts `searchOne`），与其余五个 JSON
  // 源同一约定——旧实现只认 `retmax`，caller 传的 `limit` 会被当成一个上游不认识
  // 的裸查询参数发出去，等于**从未真正生效过**。这里补上 limit→retmax 的对齐。
  async search(params: { query?: string; limit?: number; retmax?: number } & Record<string, unknown>): Promise<unknown> {
    const term = typeof params.query === "string" ? params.query : "";
    const retmax = params.retmax ?? params.limit ?? 10;
    const rest = { ...params };
    delete rest.query;
    delete rest.limit;
    delete rest.retmax;

    const idResp = await this.requestRaw("search", { ...rest, term, db: "pubmed", retmode: "json", retmax });
    const idlist = idlistOf(idResp);
    if (idlist.length === 0) {
      // 空结果是正常结果，不是错误——原样返回 esearch 响应即可，第二跳没有意义发。
      return idResp;
    }
    return this.requestRaw("getPaper", { id: idlist.join(","), db: "pubmed", retmode: "json" });
  }

  async getPaper(params: { id?: string | number } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "pubmed" tool "getPaper" 需要参数 id（PMID，可逗号分隔多个）');
    const rest = { ...params };
    delete rest.id;
    return this.requestRaw("getPaper", { ...rest, id, db: rest.db ?? "pubmed", retmode: "json" });
  }

  async getAbstract(params: { id?: string | number; rettype?: string } & Record<string, unknown>): Promise<PubmedAbstractResult> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "pubmed" tool "getAbstract" 需要参数 id（PMID）');
    const rest = { ...params };
    delete rest.id;
    delete rest.rettype;
    const xmlText = (await this.requestRaw("getAbstract", {
      ...rest,
      id,
      db: rest.db ?? "pubmed",
      rettype: "abstract",
      retmode: "xml",
    })) as string;
    return parsePubmedAbstractXml(xmlText, id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// arXiv
// ─────────────────────────────────────────────────────────────────────────────
//
// 单一端点 `/query`，`search_query` 与 `id_list` 二选一驱动同一个 Atom feed 响应。
// **两个独立的表达力缺口同时压在这一个源上**（W1-c 只标出了第一个）：
//   ① `query` → `search_query=all:{value}` 是"改名 + 拼前缀"，manifest 当前的
//     `mapTo` 只能纯改名，表达不了。
//   ② 响应是 Atom XML，manifest 的 `normalize` 受限路径 DSL 只会在**已解析的 JSON
//     对象树**上做 `.field` / `[N]` 取值——喂给它一个字符串（`responseType: "text"`
//     的原样文本）时，`objGet` 对非 object 的 `cur` 直接返回 `undefined`，每一条
//     normalize 路径都会静默取到 `undefined`。这不是"缺一个模板语法"能补的，
///    是"DSL 里根本没有 XML→对象树这一步"——见 docs/devlog/W3-d.md 的实测记录
//     （tests/unit/connector_manifest.test.ts 里有一条可运行的复现）。
// arXiv 对非法查询仍返回 HTTP 200 + 一条 id 形如
// `http://arxiv.org/api/errors#...` 的"错误 entry"（管这类响应体分支叫"该走 TS
// 而不是 manifest"的活例子——与 bioRxiv/BindingDB 那条已经写进 manifest.ts 头部
// 注释的约束②是同一件事：manifest 的 normalize 没有"按字段值切换处理路径"的能力）。

export const arxivConfig: HttpConnectorConfig = {
  baseUrl: "https://export.arxiv.org/api",
  description: "arXiv 预印本数据库（Atom XML）",
  tools: [
    { name: "search", description: "检索 arXiv 论文", endpoint: "/query", responseType: "text" },
    { name: "getPaper", description: "按 arXiv id 获取单篇论文", endpoint: "/query", responseType: "text" },
  ],
  metadata: { domain: "arxiv.org", apiKeyRequired: false, status: "available" },
};

export interface ArxivLink {
  href: string | null;
  rel: string | null;
  type: string | null;
  title: string | null;
}

export interface ArxivEntry {
  id: string | null;
  shortId: string | null;
  title: string | null;
  summary: string | null;
  published: string | null;
  updated: string | null;
  authors: Array<{ name: string | null }>;
  links: ArxivLink[];
  categories: string[];
  primaryCategory: string | null;
  comment: string | null;
  doi: string | null;
  journalRef: string | null;
}

export interface ArxivFeed {
  totalResults: number | null;
  startIndex: number | null;
  itemsPerPage: number | null;
  entries: ArxivEntry[];
}

// `http://arxiv.org/abs/1706.03762v7` → `1706.03762v7`。
export function arxivShortId(rawId: string): string {
  const trimmed = rawId.trim();
  const m = /\/abs\/([^/]+)$/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

function arxivEntryToRaw(entry: XmlElement): ArxivEntry {
  const idText = xmlElementText(xmlChild(entry, "id")) || null;
  const primaryCategory = xmlChild(entry, "primary_category");
  const commentEl = xmlChild(entry, "comment");
  const doiEl = xmlChild(entry, "doi");
  const journalRefEl = xmlChild(entry, "journal_ref");
  return {
    id: idText,
    shortId: idText ? arxivShortId(idText) : null,
    title: collapseWhitespace(xmlElementText(xmlChild(entry, "title"))) || null,
    summary: collapseWhitespace(xmlElementText(xmlChild(entry, "summary"))) || null,
    published: xmlElementText(xmlChild(entry, "published")) || null,
    updated: xmlElementText(xmlChild(entry, "updated")) || null,
    authors: xmlChildren(entry, "author").map((a) => ({ name: xmlElementText(xmlChild(a, "name")) || null })),
    links: xmlChildren(entry, "link").map((l) => ({
      href: l.attrs.href ?? null,
      rel: l.attrs.rel ?? null,
      type: l.attrs.type ?? null,
      title: l.attrs.title ?? null,
    })),
    categories: xmlChildren(entry, "category")
      .map((c) => c.attrs.term)
      .filter((t): t is string => Boolean(t)),
    primaryCategory: primaryCategory?.attrs.term ?? null,
    comment: commentEl ? xmlElementText(commentEl) : null,
    doi: doiEl ? xmlElementText(doiEl) : null,
    journalRef: journalRefEl ? xmlElementText(journalRefEl) : null,
  };
}

function numFrom(text: string): number | null {
  const n = Number(text);
  return Number.isFinite(n) && text !== "" ? n : null;
}

// 供 search() / getPaper() 共用：把 Atom XML 解析成结构化 feed，并把
// "HTTP 200 但其实是错误响应"的分支显式识别出来抛错（见上方文件头注释）。
function parseArxivFeed(xmlText: string): ArxivFeed {
  const root = parseXml(xmlText); // 格式错误在这里 throw（阴性对照①）
  if (localName(root.tag) !== "feed") {
    throw new Error(`arXiv 响应不是预期的 Atom feed（根元素是 "${root.tag}"）`);
  }
  const entries = xmlChildren(root, "entry").map(arxivEntryToRaw);
  if (entries.length === 1 && (entries[0]!.id ?? "").startsWith("http://arxiv.org/api/errors")) {
    throw new Error(`arXiv API 返回了一个错误响应：${entries[0]!.summary ?? entries[0]!.title ?? "（无详情）"}`);
  }
  return {
    totalResults: numFrom(xmlElementText(xmlChild(root, "totalResults"))),
    startIndex: numFrom(xmlElementText(xmlChild(root, "startIndex"))),
    itemsPerPage: numFrom(xmlElementText(xmlChild(root, "itemsPerPage"))),
    entries,
  };
}

export class arXivConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("arxiv", arxivConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getPaper", (p) => this.getPaper(p));
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  // 与其余源同一约定：调用方传 { query, limit }（旧实现只认 max_results，统一检索
  // 传来的 limit 会被当裸查询参数发出、从未真正生效——顺带修掉）。
  async search(params: { query?: string; limit?: number; max_results?: number } & Record<string, unknown>): Promise<ArxivFeed> {
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string" && !("search_query" in params)) {
      mapped.search_query = `all:${params.query}`;
      delete mapped.query;
    }
    if (params.limit !== undefined) {
      mapped.max_results = params.limit;
      delete mapped.limit;
    }
    mapped.max_results ??= 10;
    const xmlText = (await this.requestRaw("search", mapped)) as string;
    return parseArxivFeed(xmlText);
  }

  async getPaper(params: { id?: string } & Record<string, unknown>): Promise<ArxivFeed> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "arxiv" tool "getPaper" 需要参数 id');
    const rest = { ...params };
    delete rest.id;
    const xmlText = (await this.requestRaw("getPaper", { ...rest, id_list: id })) as string;
    return parseArxivFeed(xmlText);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P2 新增：四个免 key 文献源。每个至少 search + getPaper（fetch-by-id）两个工具。
// 归一化到统一 Paper 模型的逻辑不在这里，而在 backend/src/literature/normalize.ts，
// connector 只负责「按各家 API 的口径把请求发对、把原始 JSON 拿回来」。
// ─────────────────────────────────────────────────────────────────────────────

// OpenAlex 的 id 可以是 W2741809807、doi:10.x/y 或完整 https://doi.org/... URL。
export function openAlexEntityId(raw: string): string {
  const id = raw.trim();
  if (/^https?:\/\/openalex\.org\//i.test(id)) return id.split("/").pop()!;
  if (/^W\d+$/i.test(id)) return id.toUpperCase();
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(id)) return `doi:${id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
  if (/^10\.\d{4,9}\//.test(id)) return `doi:${id}`;
  if (/^(pmid|pmcid|doi|mag):/i.test(id)) return id;
  return id;
}

// OpenAlex 的 work 对象默认极其臃肿（单条可达 30 KB，大半是我们不用的 concepts/counts_by_year）。
// 用 select 只取归一化需要的字段：响应体缩小一个数量级，对 API 也更礼貌。
export const OPENALEX_SELECT = [
  "id",
  "doi",
  "display_name",
  "publication_year",
  "publication_date",
  "cited_by_count",
  "authorships",
  "primary_location",
  "open_access",
  "best_oa_location",
  "ids",
  "abstract_inverted_index",
  "referenced_works",
].join(",");

export const openalexConfig: HttpConnectorConfig = {
  baseUrl: "https://api.openalex.org",
  description: "OpenAlex 开放学术图谱（作品/作者/机构，免 key，支持 polite pool）",
  tools: [
    { name: "search", description: "全文检索作品（works）", endpoint: "/works" },
    { name: "getPaper", description: "按 OpenAlex ID / DOI 获取单篇作品", endpoint: "/works/{id}" },
    { name: "getReferences", description: "获取某作品的参考文献（referenced_works）", endpoint: "/works/{id}" },
  ],
  metadata: { domain: "api.openalex.org", apiKeyRequired: false, status: "available" },
};

export class OpenAlexConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("openalex", openalexConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getPaper", (p) => this.getPaper(p));
    this.handle("getReferences", (p) => this.getReferences(p));
  }

  // OpenAlex 用 mailto 查询参数而不是 header 进 polite pool。
  protected override queryFor(): Record<string, string> {
    return { mailto: this.options.contactEmail ?? politeHeaders().From };
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  async search(params: { query?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (typeof params.query === "string") {
      mapped.search = params.query;
      delete mapped.query;
    }
    if (params.limit !== undefined) {
      mapped["per-page"] = Math.min(Number(params.limit) || 10, 200);
      delete mapped.limit;
    }
    mapped["per-page"] ??= 10;
    mapped.select ??= OPENALEX_SELECT;
    return this.requestRaw("search", mapped);
  }

  async getPaper(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "openalex" tool "getPaper" 需要参数 id');
    return this.requestRaw("getPaper", { ...params, id: openAlexEntityId(id), select: params.select ?? OPENALEX_SELECT });
  }

  async getReferences(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "openalex" tool "getReferences" 需要参数 id');
    return this.requestRaw("getReferences", { ...params, id: openAlexEntityId(id), select: "id,referenced_works" });
  }
}

export const crossrefConfig: HttpConnectorConfig = {
  baseUrl: "https://api.crossref.org",
  description: "CrossRef DOI 注册元数据（免 key，mailto 进 polite pool）",
  tools: [
    { name: "search", description: "检索 CrossRef 作品", endpoint: "/works" },
    { name: "getPaper", description: "按 DOI 获取单篇元数据", endpoint: "/works/{id}" },
  ],
  metadata: { domain: "api.crossref.org", apiKeyRequired: false, status: "available" },
};

export class CrossRefConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("crossref", crossrefConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getPaper", (p) => this.getPaper(p));
  }

  protected override queryFor(): Record<string, string> {
    return { mailto: this.options.contactEmail ?? politeHeaders().From };
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  async search(params: { query?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (params.limit !== undefined) {
      mapped.rows = Math.min(Number(params.limit) || 10, 100);
      delete mapped.limit;
    }
    mapped.rows ??= 10;
    return this.requestRaw("search", mapped);
  }

  async getPaper(params: { id?: string; doi?: string } & Record<string, unknown>): Promise<unknown> {
    const raw = String(params.id ?? params.doi ?? "");
    if (!raw) throw new Error('Connector "crossref" tool "getPaper" 需要参数 id（DOI）');
    const doi = raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    const rest = { ...params };
    delete rest.doi;
    return this.requestRaw("getPaper", { ...rest, id: doi });
  }
}

export const europepmcConfig: HttpConnectorConfig = {
  baseUrl: "https://www.ebi.ac.uk/europepmc/webservices/rest",
  description: "Europe PMC 生命科学文献（免 key，含 OA 全文链接）",
  tools: [
    { name: "search", description: "检索 Europe PMC", endpoint: "/search" },
    { name: "getPaper", description: "按 DOI / PMID / PMCID 获取单篇", endpoint: "/search" },
  ],
  metadata: { domain: "ebi.ac.uk", apiKeyRequired: false, status: "available" },
};

// Europe PMC 没有独立的 by-id 端点，统一走 search + 字段限定查询。
export function europePmcIdQuery(raw: string): string {
  const id = raw.trim();
  if (/^PMC\d+$/i.test(id)) return `PMCID:${id.toUpperCase()}`;
  if (/^\d{4,9}$/.test(id)) return `EXT_ID:${id} AND SRC:MED`;
  const doi = id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return `DOI:"${doi}"`;
}

export class EuropePMCConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("europepmc", europepmcConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getPaper", (p) => this.getPaper(p));
  }

  protected override headersFor(): Record<string, string> {
    return { "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]! };
  }

  async search(params: { query?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    const mapped: Record<string, unknown> = { ...params };
    if (params.limit !== undefined) {
      mapped.pageSize = Math.min(Number(params.limit) || 10, 100);
      delete mapped.limit;
    }
    mapped.pageSize ??= 10;
    mapped.format ??= "json";
    // core 结果集才带 abstract 与 fullTextUrlList（PDF 下载管线依赖它）。
    mapped.resultType ??= "core";
    return this.requestRaw("search", mapped);
  }

  async getPaper(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "europepmc" tool "getPaper" 需要参数 id');
    const rest = { ...params };
    delete rest.id;
    return this.requestRaw("getPaper", {
      ...rest,
      query: europePmcIdQuery(id),
      format: "json",
      resultType: "core",
      pageSize: 1,
    });
  }
}

export const S2_FIELDS =
  "paperId,externalIds,title,abstract,year,venue,publicationVenue,authors,openAccessPdf,citationCount,referenceCount,url,isOpenAccess";

// E-4：S2「无 key 自动降级」承诺未实现（BACKLOG D2 / DEVELOPMENT_PLAN_v0.3 E-4）。
//
// 旧状态：`apiKeyRequired: false` 但从没实现凭据路径——`headersFor()` 只发 User-Agent，
// 即使 `~/.spark-research/credentials.json` 里配了 S2 key 也用不上；于是每次检索都
// 匿名打一遍，P2 实测「7 次尝试全 429」，统一检索把它计成 `outcome:"failed"`，
// 而失败与「压根没配置、跳过更诚实」是两件事——把它们混在一起，用户看不出该不该
// 去申请 key。
//
// 现在补上与 AMiner 同款的 CredentialProvider 通路（connector id `semanticscholar`，
// 字段 `api_key`，走官方 `x-api-key` 头），并把 `apiKeyRequired` 改成真值：没配置
// 时 `search`/`getPaper` 不再发出注定 429 的请求，直接返回与 AMiner 一致的
// `credentialMissingResult()`——统一检索（search.ts 的 `isCredentialMissing`
// 判断是通用的，不认连接器 id）会把它识别成 `outcome:"skipped"` 而不是 `"failed"`。
export const S2_CONNECTOR_ID = "semanticscholar";
export const S2_CREDENTIAL_KEY = "api_key";

export const semanticscholarConfig: HttpConnectorConfig = {
  baseUrl: "https://api.semanticscholar.org/graph/v1",
  description: "Semantic Scholar 学术图谱（需 API Key；凭据只在 daemon 内取用）",
  tools: [
    { name: "search", description: "检索论文", endpoint: "/paper/search" },
    { name: "getPaper", description: "按 S2 ID / DOI / arXiv ID 获取单篇", endpoint: "/paper/{id}" },
  ],
  metadata: {
    domain: "api.semanticscholar.org",
    apiKeyRequired: true,
    status: "available",
    // P2 实测：匿名请求持续 429（7 次尝试全挂）。接口是通的，配额不是。
    caveat:
      "匿名调用持续 429，实测已非「免 key」；需配置凭据（`spark-research lit sources` 看是否已配，" +
      "connector id `semanticscholar`，字段 `api_key`）——未配置时统一检索把它标为 skipped，不再每次白撞 429",
  },
};

// Semantic Scholar 支持带前缀的外部 id：DOI:10.x/y、arXiv:2101.00001、PMID:12345。
export function semanticScholarPaperId(raw: string): string {
  const id = raw.trim();
  if (/^(DOI|ARXIV|PMID|PMCID|MAG|ACL|CorpusId):/i.test(id)) return id;
  if (/^https?:\/\/(dx\.)?doi\.org\//i.test(id)) return `DOI:${id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}`;
  if (/^10\.\d{4,9}\//.test(id)) return `DOI:${id}`;
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) return `arXiv:${id}`;
  return id;
}

export class SemanticScholarConnector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("semanticscholar", semanticscholarConfig, options);
    this.handle("search", (p) => this.search(p));
    this.handle("getPaper", (p) => this.getPaper(p));
  }

  // 是否已配置凭据。只看「有没有」，不把值带出这个方法之外（与 AMinerConnector 同款）。
  isConfigured(): boolean {
    return this.apiKey() !== null;
  }

  private apiKey(): string | null {
    const provider = this.options.credentials;
    if (!provider) return null;
    try {
      const values = provider.get(S2_CONNECTOR_ID);
      const key = values?.[S2_CREDENTIAL_KEY];
      return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
    } catch {
      // 凭据文件损坏等情况按「未配置」处理，绝不把底层错误消息（可能含路径/内容）外抛。
      return null;
    }
  }

  protected override headersFor(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": politeHeaders({ userAgent: this.options.userAgent })["User-Agent"]!,
    };
    const key = this.apiKey();
    // 官方鉴权头是 `x-api-key`（与 Anthropic 同名但语义各自独立，两处实现互不引用）。
    if (key) headers["x-api-key"] = key;
    return headers;
  }

  async search(params: { query?: string; limit?: number } & Record<string, unknown>): Promise<unknown> {
    if (!this.isConfigured()) return credentialMissingResult(S2_CONNECTOR_ID, [S2_CREDENTIAL_KEY]);
    const mapped: Record<string, unknown> = { ...params };
    mapped.limit = Math.min(Number(params.limit ?? 10) || 10, 100);
    mapped.fields ??= S2_FIELDS;
    return this.requestRaw("search", mapped);
  }

  async getPaper(params: { id?: string } & Record<string, unknown>): Promise<unknown> {
    if (!this.isConfigured()) return credentialMissingResult(S2_CONNECTOR_ID, [S2_CREDENTIAL_KEY]);
    const id = String(params.id ?? "");
    if (!id) throw new Error('Connector "semanticscholar" tool "getPaper" 需要参数 id');
    return this.requestRaw("getPaper", { ...params, id: semanticScholarPaperId(id), fields: params.fields ?? S2_FIELDS });
  }
}

