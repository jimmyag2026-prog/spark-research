// 统一 Paper 模型（DESIGN 域 A1）：跨源检索的归一化目标。
// 各源的原始 JSON 由 normalize.ts 映射到这里，之后的去重、入库、导出只认这个模型。

export const LITERATURE_SOURCES = [
  "openalex",
  "crossref",
  "europepmc",
  "semanticscholar",
  "aminer",
  "arxiv",
  "pubmed",
  "biorxiv",
] as const;
export type LiteratureSource = (typeof LITERATURE_SOURCES)[number];

// 默认检索源。
//
// V34（v0.5 闸门 F 的零上下文外部验收发现）：这张表在 W3-d 把 arxiv / pubmed 真正接通
// 之后**没有跟着改**，仍是 P2 时代的四个源。后果不是「少查两个源」这么轻——
// `lit add <arxiv-id>` 不带 --sources 时走的就是这张表，于是
// `lit search --sources arxiv` 能用、`capabilities --json` 也报 arxiv 可用，
// 唯独 `lit add 1706.03762` 报「未找到」。**能力做好了、默认值没跟着改。**
//
// 结构性教训写在 `DEFAULT_SOURCE_EXCLUSIONS` 上：光改这一行还会复发，
// 因为 AD-12 门禁核的是「源在不在注册表」，核不了「默认值有没有包含它」。
// W5-2 γ（V26 附带的 C2 第一批）：biorxiv 判断——进默认集，不进排除表。
//
// bioRxiv 免 key、`status: "available"`，按 V34 门禁的判据，这类源**没有**合法的
// 排除理由（只认 apiKeyRequired 或 status:"placeholder"，二者都不成立）。唯一能让它
// "合法"缺席默认集的办法是把 status 谎报成 placeholder——那是为了让门禁变绿而
// 放宽门禁本身，本轮明确不许。
//
// bioRxiv 官方 API 没有全文检索端点（只有"最近 N 篇"和"按 DOI 精确查"两个原语），
// 所以 connector 层（backend/src/connectors/biorxiv.ts）在此之上组合出了一个
// "search"/"getPaper" 复合工具：search 拉最近 200 篇窗口 + 客户端关键词打分过滤，
// getPaper 只认 DOI。这不是伪造出来的假通过——是一个真实、诚实（caveat 里写清楚了
// 窗口限制）的能力，能让 bioRxiv 加入统一检索、覆盖它独有的预印本（尤其是刚挂出、
// 还没被 europepmc/openalex 二次索引的最新内容）。所以判断是：让它进默认集。
export const DEFAULT_SEARCH_SOURCES: LiteratureSource[] = [
  "openalex",
  "crossref",
  "europepmc",
  "semanticscholar",
  "arxiv",
  "pubmed",
  "biorxiv",
];

// V34 的门禁面：**已实装的文献源要么在 `DEFAULT_SEARCH_SOURCES` 里，要么在这张表里带理由。**
//
// 断言本身在 `tests/unit/literature_source_parity.test.ts`，它以 ConnectorRegistry 的
// literature 域清单为真源（不是这里的 `LITERATURE_SOURCES` 常量——那本身也是一份手写副本，
// 拿它当真源就等于自证自明，抓不到「注册表里加了源、这两张表都没跟上」这一类）。
//
// 排除**不是**随手写个理由就行：门禁只承认两类合法排除——
//   1. `apiKeyRequired: true`（默认集里放一个必然 skipped 的源，只会让每次检索多一行噪音）；
//   2. `status: "placeholder"`（占位实现，调用必然失败）。
// 换句话说，一个免 key、状态 available 的源**没有**合法的排除理由，只能进默认集。
// arxiv / pubmed 正是这一类，所以上面那张表必须包含它们。
export interface DefaultSourceExclusion {
  // 连接器注册表里的源名。类型故意是 string 而不是 LiteratureSource：
  // cnki / wanfang 是占位实现，本来就不该能被 `--sources` 选中（所以不在那个联合类型里），
  // 但它们**确实在注册表里**，门禁要求它们在这张表里给出理由。
  source: string;
  reason: string;
}

export const DEFAULT_SOURCE_EXCLUSIONS: readonly DefaultSourceExclusion[] = [
  {
    source: "aminer",
    reason: "apiKeyRequired：AMiner 要自备 key，未配置时整源 skipped；需要中文文献时显式 --sources aminer",
  },
  {
    source: "cnki",
    reason: "placeholder：知网无公开 API 渠道（官方开放平台需申请），调用必然失败；中文文献主路径是 aminer",
  },
  {
    source: "wanfang",
    reason: "placeholder：万方官方 Web API 需企业授权，调用必然失败；中文文献主路径是 aminer",
  },
];

export interface PaperAuthor {
  name: string;
  affiliation?: string | null;
}

// 各源的原生 id：openalex=W..., crossref=DOI, europepmc=PMID/PMCID,
// semanticscholar=paperId, aminer=paper id, arxiv=2101.00001, pubmed=PMID。
export type PaperSourceIds = Partial<Record<LiteratureSource | "pmid" | "pmcid", string>>;

export interface Paper {
  title: string;
  authors: PaperAuthor[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  ids: PaperSourceIds;
  abstract: string | null;
  url: string | null;
  pdfUrl: string | null;
  citedByCount: number | null;
  isOpenAccess: boolean | null;
  // 该条记录来自哪些源（合并后可能多个）。
  sources: LiteratureSource[];
  // OpenAlex referenced_works：库内互引边的数据来源（DESIGN 域 A2）。
  references: string[];
}

export function emptyPaper(): Paper {
  return {
    title: "",
    authors: [],
    year: null,
    venue: null,
    doi: null,
    ids: {},
    abstract: null,
    url: null,
    pdfUrl: null,
    citedByCount: null,
    isOpenAccess: null,
    sources: [],
    references: [],
  };
}

// DOI 归一化：去掉 URL 前缀与大小写差异，作为跨源去重的强 key。
export function normalizeDoi(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^doi:\s*/i, "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  if (!/^10\.\d{4,9}\/\S+$/.test(trimmed)) return null;
  return trimmed.toLowerCase().replace(/[.,;]+$/, "");
}

// 标题归一化：大小写 / 标点 / 空白折叠，供无 DOI 时的模糊匹配使用。
export function titleKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function titleTokens(raw: unknown): string[] {
  const key = titleKey(raw);
  return key ? key.split(" ") : [];
}

// 标题相似度：token 集合的 Jaccard 系数（0~1）。
// 选它而不是编辑距离，是因为跨源标题差异主要来自副标题/连接词的增删，而不是拼写。
export function titleSimilarity(a: unknown, b: unknown): number {
  const setA = new Set(titleTokens(a));
  const setB = new Set(titleTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / (setA.size + setB.size - shared);
}

// V38：「Last F」形态的作者名。
//
// Europe PMC / PubMed 归一化出来的作者名是 `"Jumper J"` / `"Varadi MG"` 这种
// **姓在前、名缩写在后**的形态（OpenAlex / CrossRef 给的是 `"John Jumper"`，姓在后）。
// 旧实现无条件取最后一段当姓，于是 `"Jumper J"` 的姓被解析成 `"j"`：
//   - BibTeX key 变成 `j2021highly` 而不是 `jumper2021highly`（外部验收发现的那一条）；
//   - 跨源去重的姓氏比对也跟着错位（同一篇论文，openalex 侧姓 "jumper"、europepmc 侧姓 "j"）。
//
// 判据：最后一段**只由 1~3 个大写字母（可带点）组成**就判为名缩写，姓取它前面的部分。
// 只认大写是关键——`"Jan van der Berg"` 的 "Berg"、`"Xu Li"` 的 "Li" 都含小写字母，
// 不会被误判；而真正的缩写（"J" / "JA" / "J.A." / "MG"）一定是全大写。
const INITIALS = /^(?:[A-Z]\.?){1,3}$/;

export function authorSurname(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.includes(",")) return titleKey(cleaned.split(",")[0]);
  const parts = cleaned.split(" ");
  if (parts.length > 1 && INITIALS.test(parts[parts.length - 1]!)) {
    return titleKey(parts.slice(0, -1).join(" "));
  }
  return titleKey(parts[parts.length - 1] ?? "");
}

// 「最后一段是名缩写吗」——export.ts 的 CSL 姓名解析要用同一条判据，
// 两处各写一份正则就是 V34 那类问题的翻版（同一判据两份手写副本，改一处漏一处）。
export function isInitialsToken(token: string): boolean {
  return INITIALS.test(token);
}

export function firstAuthorSurname(paper: Paper): string {
  const first = paper.authors[0]?.name;
  return first ? authorSurname(first) : "";
}
