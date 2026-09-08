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
] as const;
export type LiteratureSource = (typeof LITERATURE_SOURCES)[number];

// 免 key 的默认检索源；aminer 需凭据，按需显式加入。
export const DEFAULT_SEARCH_SOURCES: LiteratureSource[] = [
  "openalex",
  "crossref",
  "europepmc",
  "semanticscholar",
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

export function authorSurname(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.includes(",")) return titleKey(cleaned.split(",")[0]);
  const parts = cleaned.split(" ");
  return titleKey(parts[parts.length - 1] ?? "");
}

export function firstAuthorSurname(paper: Paper): string {
  const first = paper.authors[0]?.name;
  return first ? authorSurname(first) : "";
}
