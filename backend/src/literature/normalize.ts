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
  // OpenAlex 的 pmcid 是完整 URL（.../pmc/PMC8371605），取末段。
  if (pmcid) paper.ids.pmcid = pmcid.split("/").filter(Boolean).pop() ?? pmcid;

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
    // 与 pdf.ts 的候选推导保持同一形式（实测可用；REST fullTextPdf 端点返回 404）。
    return `https://europepmc.org/articles/${pmcid}?pdf=render`;
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

// AMiner /paper/search 的实测响应（2026-09 录制验证）：
//   { code, success, msg, total, log_id,
//     data: [{ doi, first_author, id, n_citation_bucket, title, venue_name, year }] }
// /paper/info 的 data 层级与字段更丰富，公开文档未固定，故字段名走别名表做防御式映射。
export function fromAMiner(raw: unknown): Paper | null {
  const item = asObject(raw);
  if (!item) return null;
  const title = asString(item.title) ?? asString(item.title_zh) ?? asString(item.name);
  if (!title) return null;
  const paper = emptyPaper();
  paper.title = title;
  paper.sources = ["aminer"];
  const authorList = asArray(item.authors);
  // search 接口只给 first_author 字符串，没有完整作者数组。
  paper.authors =
    authorList.length > 0
      ? authorsOf(authorList)
      : authorsOf([asString(item.first_author)].filter((n): n is string => n !== null));
  paper.year = yearOf(item.year) ?? yearOf(item.pub_year);
  paper.venue =
    asString(asObject(asObject(item.venue)?.info)?.name) ??
    asString(asObject(item.venue)?.raw) ??
    asString(item.venue) ??
    asString(item.venue_name);
  paper.doi = normalizeDoi(item.doi);
  paper.abstract = asString(item.abstract) ?? asString(item.abstract_zh);
  // 注意：search 接口只给 n_citation_bucket（"5000+" 这种区间字符串）。
  // 区间不是数字，硬转会凭空造出精度，故此时留 null。
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


// ── arXiv / PubMed（v0.4 W3 收口接线）─────────────────────────────────────────
//
// 这两个源的 connector 在 W3-d 落地（XML 解析走 TS 扩展——manifest 的 normalize DSL
// 假定响应已是解析好的 JSON 对象树，喂原始 XML 会**每个字段静默为 undefined**，
// 详见 docs/devlog/W3-d.md）。但 connector 做好之后归一化表还桩着空数组，
// 于是统一检索仍然看不到它们——这是本版第六个「建好但没人喂」，收口一并接上。

export function extractArxivList(payload: unknown): unknown[] {
  // ArxivFeed { entries: ArxivEntry[] }（W3-d 的 parseArxivFeed 产出）。
  return asArray(asObject(payload)?.entries);
}

export function fromArxiv(raw: unknown): Paper | null {
  const entry = asObject(raw);
  if (!entry) return null;
  const title = asString(entry.title);
  if (!title) return null;
  const paper = emptyPaper();
  // arXiv 的 title/summary 里带换行与多空格（XML 排版），压平再用。
  paper.title = title.replace(/\s+/g, " ").trim();
  paper.sources = ["arxiv"];
  paper.authors = authorsOf(
    asArray(entry.authors)
      .map((a) => asString(asObject(a)?.name) ?? "")
      .filter(Boolean),
  );
  paper.year = yearOf(entry.published) ?? yearOf(entry.updated);
  paper.venue = asString(entry.journalRef);
  paper.doi = normalizeDoi(entry.doi);
  const summary = asString(entry.summary);
  paper.abstract = summary ? summary.replace(/\s+/g, " ").trim() : null;
  const shortId = asString(entry.shortId);
  if (shortId) paper.ids.arxiv = shortId;
  paper.url = asString(entry.id);
  // pdf 直链在 links[] 里：rel=related & title=pdf（arXiv 的 Atom 约定）。
  for (const link of asArray(entry.links)) {
    const l = asObject(link);
    if (!l) continue;
    if (asString(l.title) === "pdf" || asString(l.type) === "application/pdf") {
      paper.pdfUrl = asString(l.href);
      break;
    }
  }
  return paper;
}

export function extractPubMedList(payload: unknown): unknown[] {
  // NCBI esummary：{ result: { uids: ["1","2"], "1": {...}, "2": {...} } }。
  // 空结果时 W3-d 的 search() 原样返回 esearch 响应（没有 result 段）——这里自然得到 []。
  const result = asObject(asObject(payload)?.result);
  if (!result) return [];
  const uids = asArray(result.uids)
    .map((u) => asString(u))
    .filter((u): u is string => Boolean(u));
  return uids.map((uid) => result[uid]).filter((v) => v !== undefined);
}

export function fromPubMed(raw: unknown): Paper | null {
  const doc = asObject(raw);
  if (!doc) return null;
  const title = asString(doc.title);
  if (!title) return null;
  const paper = emptyPaper();
  paper.title = title.replace(/\.$/, "");
  paper.sources = ["pubmed"];
  paper.authors = authorsOf(
    asArray(doc.authors)
      .map((a) => asString(asObject(a)?.name) ?? "")
      .filter(Boolean),
  );
  paper.year = yearOf(doc.pubdate) ?? yearOf(doc.epubdate) ?? yearOf(doc.sortpubdate);
  paper.venue = asString(doc.fulljournalname) ?? asString(doc.source);
  // esummary 的 DOI 藏在 articleids[] 里（idtype === "doi"）。
  for (const item of asArray(doc.articleids)) {
    const a = asObject(item);
    if (!a) continue;
    const kind = asString(a.idtype);
    const value = asString(a.value);
    if (!value) continue;
    if (kind === "doi") paper.doi = normalizeDoi(value);
    if (kind === "pubmed") paper.ids.pmid = value;
    if (kind === "pmc") paper.ids.pmcid = value;
  }
  const pmid = paper.ids.pmid ?? asString(doc.uid);
  if (pmid) {
    paper.ids.pubmed = pmid;
    paper.ids.pmid = pmid;
    paper.url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  }
  // esummary 不含摘要（那要 efetch）——如实留 null，不编造。
  return paper;
}

const NORMALIZERS: Record<LiteratureSource, { extract: (p: unknown) => unknown[]; map: (r: unknown) => Paper | null }> = {
  openalex: { extract: extractOpenAlexList, map: fromOpenAlex },
  crossref: { extract: extractCrossRefList, map: fromCrossRef },
  europepmc: { extract: extractEuropePMCList, map: fromEuropePMC },
  semanticscholar: { extract: extractSemanticScholarList, map: fromSemanticScholar },
  aminer: { extract: extractAMinerList, map: fromAMiner },
  // v0.4 W3 收口：W3-d 的 connector 落地后接上（此前是 P2 留的空占位）。
  arxiv: { extract: extractArxivList, map: fromArxiv },
  pubmed: { extract: extractPubMedList, map: fromPubMed },
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
