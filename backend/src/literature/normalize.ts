import {
  emptyPaper,
  normalizeDoi,
  type LiteratureSource,
  type Paper,
  type PaperAuthor,
} from "./models";

// 各源原始响应 → 统一 Paper 模型。
// 原则：所有取值都走防御式读取（源 API 字段随时可能缺失或改型），
// 缺字段一律落 null 而不是抛错——一个源的字段异常不该让整次跨源检索失败。

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function yearOf(value: unknown): number | null {
  const num = asNumber(value);
  if (num !== null && num > 1400 && num < 2200) return Math.trunc(num);
  const text = asString(value);
  const match = text?.match(/(1[4-9]\d{2}|2[01]\d{2})/);
  return match ? Number(match[1]) : null;
}

function authorsOf(names: unknown[]): PaperAuthor[] {
  return names
    .map((entry) => {
      if (typeof entry === "string") return { name: entry.trim() };
      const obj = asObject(entry);
      if (!obj) return null;
      const name =
        asString(obj.name) ??
        asString(asObject(obj.author)?.display_name) ??
        asString(obj.display_name) ??
        [asString(obj.given), asString(obj.family)].filter(Boolean).join(" ").trim() ??
        null;
      if (!name) return null;
      const affiliation =
        asString(obj.org) ??
        asString(obj.affiliation) ??
        asString(asArray(obj.institutions)[0] && asObject(asArray(obj.institutions)[0])?.display_name) ??
        null;
      return { name, affiliation };
    })
    .filter((a): a is PaperAuthor => a !== null && a.name.length > 0);
}

// OpenAlex 的摘要是倒排索引（abstract_inverted_index），要还原成文本。
export function reconstructInvertedAbstract(value: unknown): string | null {
  const index = asObject(value);
  if (!index) return null;
  const slots: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of asArray(positions)) {
      const p = asNumber(pos);
      if (p !== null) slots.push([p, word]);
    }
  }
  if (slots.length === 0) return null;
  slots.sort((a, b) => a[0] - b[0]);
  return slots.map(([, word]) => word).join(" ");
}

function stripOpenAlexId(raw: unknown): string | null {
  const id = asString(raw);
  return id ? id.replace(/^https?:\/\/openalex\.org\//i, "") : null;
}

export function fromOpenAlex(raw: unknown): Paper | null {
  const work = asObject(raw);
  if (!work) return null;
  const title = asString(work.display_name) ?? asString(work.title);
  if (!title) return null;
  const paper = emptyPaper();
  paper.title = title;
  paper.sources = ["openalex"];
  paper.authors = authorsOf(asArray(work.authorships));
  paper.year = yearOf(work.publication_year) ?? yearOf(work.publication_date);
  const location = asObject(work.primary_location);
  paper.venue =
    asString(asObject(location?.source)?.display_name) ??
    asString(asObject(work.host_venue)?.display_name);
  paper.doi = normalizeDoi(work.doi);
  paper.citedByCount = asNumber(work.cited_by_count);
  paper.abstract = reconstructInvertedAbstract(work.abstract_inverted_index) ?? asString(work.abstract);

  const openalexId = stripOpenAlexId(work.id);
  if (openalexId) paper.ids.openalex = openalexId;
  const external = asObject(work.ids);
  const pmid = asString(external?.pmid)?.replace(/^https?:\/\/\S*?\/(\d+)$/, "$1");
  if (pmid) paper.ids.pmid = pmid.replace(/\D/g, "") || pmid;
  const pmcid = asString(external?.pmcid);
  if (pmcid) paper.ids.pmcid = pmcid.replace(/^https?:\/\/\S*?\//, "");

  const oa = asObject(work.open_access) ?? asObject(work.best_oa_location);
  paper.isOpenAccess = typeof oa?.is_oa === "boolean" ? (oa.is_oa as boolean) : null;
  const bestOa = asObject(work.best_oa_location);
  paper.pdfUrl = asString(bestOa?.pdf_url) ?? asString(asObject(work.open_access)?.oa_url);
  paper.url =
    asString(asObject(work.primary_location)?.landing_page_url) ??
    (paper.doi ? `https://doi.org/${paper.doi}` : null) ??
    (openalexId ? `https://openalex.org/${openalexId}` : null);

  paper.references = asArray(work.referenced_works)
    .map((r) => stripOpenAlexId(r))
    .filter((r): r is string => r !== null);
  return paper;
}

export function fromCrossRef(raw: unknown): Paper | null {
  const item = asObject(raw);
  if (!item) return null;
  const title = asString(asArray(item.title)[0]) ?? asString(item.title);
  if (!title) return null;
  const paper = emptyPaper();
  paper.title = title;
  paper.sources = ["crossref"];
  paper.authors = authorsOf(asArray(item.author));
  const issuedParts = asArray(asArray(asObject(item.issued)?.["date-parts"])[0]);
  paper.year = yearOf(issuedParts[0]) ?? yearOf(asObject(item.issued)?.["date-time"]);
  paper.venue = asString(asArray(item["container-title"])[0]) ?? asString(item["container-title"]);
  paper.doi = normalizeDoi(item.DOI);
  if (paper.doi) paper.ids.crossref = paper.doi;
  paper.citedByCount = asNumber(item["is-referenced-by-count"]);
  paper.abstract = asString(item.abstract)?.replace(/<[^>]+>/g, "").trim() ?? null;
  paper.url = asString(item.URL) ?? (paper.doi ? `https://doi.org/${paper.doi}` : null);
  // CrossRef 的 link 里偶尔带 application/pdf 的全文链接（多数需要机构订阅）。
  const pdfLink = asArray(item.link)
    .map(asObject)
    .find((l) => l && asString(l["content-type"]) === "application/pdf");
  paper.pdfUrl = pdfLink ? asString(pdfLink.URL) : null;
  return paper;
}

// Europe PMC 的 fullTextUrlList 是 OA PDF 直链的主要来源之一。
export function europePmcPdfUrl(raw: unknown): string | null {
  const result = asObject(raw);
  const urls = asArray(asObject(result?.fullTextUrlList)?.fullTextUrl).map(asObject);
  const pdf = urls.find((u) => u && asString(u.documentStyle)?.toLowerCase() === "pdf");
  if (pdf) return asString(pdf.url);
  const pmcid = asString(result?.pmcid);
  if (pmcid && asString(result?.isOpenAccess)?.toUpperCase() === "Y") {
    return `https://europepmc.org/api/fulltextRepo?pprId=${pmcid}&type=FILE&fileName=EMS.pdf`;
  }
  return null;
}

export function fromEuropePMC(raw: unknown): Paper | null {
  const result = asObject(raw);
  if (!result) return null;
  const title = asString(result.title);
  if (!title) return null;
  const paper = emptyPaper();
  paper.title = title.replace(/\.$/, "");
  paper.sources = ["europepmc"];
  const authorList = asArray(asObject(result.authorList)?.author);
  paper.authors =
    authorList.length > 0
      ? authorsOf(authorList.map((a) => ({ name: asString(asObject(a)?.fullName) ?? "" })))
      : authorsOf(
          (asString(result.authorString) ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
  paper.year = yearOf(result.pubYear) ?? yearOf(result.firstPublicationDate);
  paper.venue = asString(result.journalTitle) ?? asString(asObject(asObject(result.journalInfo)?.journal)?.title);
  paper.doi = normalizeDoi(result.doi);
  paper.abstract = asString(result.abstractText);
  paper.citedByCount = asNumber(result.citedByCount);
  const pmid = asString(result.pmid);
  if (pmid) paper.ids.pmid = pmid;
  const pmcid = asString(result.pmcid);
  if (pmcid) paper.ids.pmcid = pmcid;
  const extId = asString(result.id);
  if (extId) paper.ids.europepmc = extId;
  paper.isOpenAccess = asString(result.isOpenAccess)?.toUpperCase() === "Y";
  paper.pdfUrl = europePmcPdfUrl(result);
  paper.url = pmid
    ? `https://europepmc.org/article/MED/${pmid}`
    : paper.doi
      ? `https://doi.org/${paper.doi}`
      : null;
  return paper;
}

export function fromSemanticScholar(raw: unknown): Paper | null {
  const item = asObject(raw);
  if (!item) return null;
  const title = asString(item.title);
  if (!title) return null;
  const paper = emptyPaper();
  paper.title = title;
  paper.sources = ["semanticscholar"];
  paper.authors = authorsOf(asArray(item.authors));
  paper.year = yearOf(item.year);
  paper.venue = asString(item.venue) ?? asString(asObject(item.publicationVenue)?.name);
  const external = asObject(item.externalIds);
  paper.doi = normalizeDoi(external?.DOI);
  paper.abstract = asString(item.abstract);
  paper.citedByCount = asNumber(item.citationCount);
  const s2id = asString(item.paperId);
  if (s2id) paper.ids.semanticscholar = s2id;
  const pmid = asString(external?.PubMed);
  if (pmid) paper.ids.pmid = pmid;
  const pmcid = asString(external?.PubMedCentral);
  if (pmcid) paper.ids.pmcid = pmcid.startsWith("PMC") ? pmcid : `PMC${pmcid}`;
  const arxivId = asString(external?.ArXiv);
  if (arxivId) paper.ids.arxiv = arxivId;
  paper.isOpenAccess = typeof item.isOpenAccess === "boolean" ? (item.isOpenAccess as boolean) : null;
  paper.pdfUrl = asString(asObject(item.openAccessPdf)?.url);
  paper.url = asString(item.url) ?? (paper.doi ? `https://doi.org/${paper.doi}` : null);
  return paper;
}

// AMiner 的响应体结构未在公开文档中固定（不同接口 data 层级不一），
// 这里做防御式映射，字段名走别名表；实测口径变化时只需要改这一处。
export function fromAMiner(raw: unknown): Paper | null {
  const item = asObject(raw);
  if (!item) return null;
  const title = asString(item.title) ?? asString(item.title_zh) ?? asString(item.name);
  if (!title) return null;
  const paper = emptyPaper();
  paper.title = title;
  paper.sources = ["aminer"];
  paper.authors = authorsOf(asArray(item.authors));
  paper.year = yearOf(item.year) ?? yearOf(item.pub_year);
  paper.venue =
    asString(asObject(asObject(item.venue)?.info)?.name) ??
    asString(asObject(item.venue)?.raw) ??
    asString(item.venue) ??
    asString(item.venue_name);
  paper.doi = normalizeDoi(item.doi);
  paper.abstract = asString(item.abstract) ?? asString(item.abstract_zh);
  paper.citedByCount = asNumber(item.num_citation) ?? asNumber(item.n_citation) ?? asNumber(item.citation);
  const id = asString(item.id) ?? asString(item._id) ?? asString(item.paper_id);
  if (id) paper.ids.aminer = id;
  const pmid = asString(item.pmid);
  if (pmid) paper.ids.pmid = pmid;
  paper.pdfUrl = asString(item.pdf) ?? null;
  paper.url =
    asString(asArray(item.urls)[0]) ??
    (paper.doi ? `https://doi.org/${paper.doi}` : null) ??
    (id ? `https://www.aminer.cn/pub/${id}` : null);
  return paper;
}

// 各源「检索响应」→ 论文数组的提取器（每家的包装层都不一样）。
export function extractOpenAlexList(payload: unknown): unknown[] {
  const obj = asObject(payload);
  if (!obj) return [];
  if (Array.isArray(obj.results)) return obj.results;
  // getPaper 返回单个 work 对象。
  return obj.id || obj.display_name ? [obj] : [];
}

export function extractCrossRefList(payload: unknown): unknown[] {
  const message = asObject(asObject(payload)?.message);
  if (!message) return [];
  if (Array.isArray(message.items)) return message.items;
  return message.DOI ? [message] : [];
}

export function extractEuropePMCList(payload: unknown): unknown[] {
  const obj = asObject(payload);
  const results = asObject(obj?.resultList)?.result;
  return Array.isArray(results) ? results : [];
}

export function extractSemanticScholarList(payload: unknown): unknown[] {
  const obj = asObject(payload);
  if (!obj) return [];
  if (Array.isArray(obj.data)) return obj.data;
  return obj.paperId ? [obj] : [];
}

export function extractAMinerList(payload: unknown): unknown[] {
  const obj = asObject(payload);
  if (!obj) return [];
  if (Array.isArray(obj.data)) return obj.data;
  const data = asObject(obj.data);
  for (const key of ["hitList", "data", "items", "list", "papers"]) {
    const candidate = data?.[key];
    if (Array.isArray(candidate)) return candidate;
  }
  if (Array.isArray(obj.result)) return obj.result;
  return [];
}

const NORMALIZERS: Record<LiteratureSource, { extract: (p: unknown) => unknown[]; map: (r: unknown) => Paper | null }> = {
  openalex: { extract: extractOpenAlexList, map: fromOpenAlex },
  crossref: { extract: extractCrossRefList, map: fromCrossRef },
  europepmc: { extract: extractEuropePMCList, map: fromEuropePMC },
  semanticscholar: { extract: extractSemanticScholarList, map: fromSemanticScholar },
  aminer: { extract: extractAMinerList, map: fromAMiner },
  // arxiv / pubmed 是 XML 响应，P2 不进统一检索的默认源，留占位保持类型完备。
  arxiv: { extract: () => [], map: () => null },
  pubmed: { extract: () => [], map: () => null },
};

// 统一入口：给定源与原始响应，吐出归一化后的 Paper 列表。
export function normalizeResponse(source: LiteratureSource, payload: unknown): Paper[] {
  const spec = NORMALIZERS[source];
  if (!spec) return [];
  return spec
    .extract(payload)
    .map((raw) => spec.map(raw))
    .filter((p): p is Paper => p !== null);
}
