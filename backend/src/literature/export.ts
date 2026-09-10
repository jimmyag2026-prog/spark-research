import { authorSurname, titleKey, type Paper, type PaperAuthor } from "./models";
import type { LibraryPaper } from "./library";

// 导出（DESIGN 域 A2）：BibTeX + CSL-JSON。
// BibTeX key 规则：第一作者姓 + 年份 + 标题首词；冲突加后缀 a/b/c…

const BIBTEX_ESCAPES: Array<[RegExp, string]> = [
  [/\\/g, "\\textbackslash{}"],
  [/([&%$#_{}])/g, "\\$1"],
  [/~/g, "\\textasciitilde{}"],
  [/\^/g, "\\textasciicircum{}"],
];

export function escapeBibTeX(value: string): string {
  let out = value;
  for (const [pattern, replacement] of BIBTEX_ESCAPES) out = out.replace(pattern, replacement);
  return out;
}

// 标题首词：跳过纯数字与英文冠词，取第一个实词。
export function titleFirstWord(title: string): string {
  const stop = new Set(["a", "an", "the", "on", "of", "in", "for", "and"]);
  for (const token of titleKey(title).split(" ")) {
    if (!token || stop.has(token) || /^\d+$/.test(token)) continue;
    return token;
  }
  return titleKey(title).split(" ")[0] || "untitled";
}

// E-5：bibtex key 保留 Unicode（中文等 CJK 字符）。
//
// 旧实现用 `[^a-z0-9]` 砍掉一切非 ASCII 字符——对中文作者/标题，`titleKey()`
// 归一化后本来是保留汉字的（models.ts 的 `\p{L}\p{N}` 本身就含 `\p{Script=Han}`），
// 结果到这一步被整个砍空，author 变成 "anon"、word 变成 "untitled"：AMiner 收录的
// 中文文献入库后 key 全部退化成 `anon2021untitled`、`anon2021untiteda`……冲突后缀
// 疯狂递增，key 与论文彻底脱钩。改成保留 `\p{Script=Han}`（连同其余 ASCII 字母数字）
// ——英文标题的行为完全不变，中文标题/作者姓名第一次能生成有辨识度的 key。
function keepAsciiAndHan(raw: string): string {
  return raw.replace(/[^a-z0-9\p{Script=Han}]/gu, "");
}

// 单篇的 base key（未处理冲突）。
export function bibtexBaseKey(paper: Paper): string {
  const surname = paper.authors[0] ? authorSurname(paper.authors[0].name) : "";
  const author = keepAsciiAndHan(surname) || "anon";
  const year = paper.year !== null ? String(paper.year) : "nd";
  const word = keepAsciiAndHan(titleFirstWord(paper.title)) || "untitled";
  return `${author}${year}${word}`;
}

// 冲突后缀：第 2 个同 key 变 xxxa，第 3 个 xxxb…（第 1 个保持无后缀）。
export function suffixForIndex(index: number): string {
  if (index === 0) return "";
  let n = index - 1;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return suffix;
}

export function assignBibtexKeys(papers: Paper[]): string[] {
  const counts = new Map<string, number>();
  return papers.map((paper) => {
    const base = bibtexBaseKey(paper);
    const index = counts.get(base) ?? 0;
    counts.set(base, index + 1);
    return `${base}${suffixForIndex(index)}`;
  });
}

// 库内论文 ↔ bibtex key 的双向索引（P3：综述引用只认库内 key）。
// key 由 assignBibtexKeys 在**同一份有序列表**上计算，所以调用方必须传 `library.list()`
// 的完整输出（按 created_at,id 排序，确定性）；只传子集会让冲突后缀 a/b/c 错位。
export interface BibtexKeyIndex {
  // 论文 id → key
  byId: Map<string, string>;
  // key → 论文
  byKey: Map<string, LibraryPaper>;
  keys: string[];
}

export function libraryKeyIndex(papers: LibraryPaper[]): BibtexKeyIndex {
  const keys = assignBibtexKeys(papers);
  const byId = new Map<string, string>();
  const byKey = new Map<string, LibraryPaper>();
  papers.forEach((paper, i) => {
    const key = keys[i]!;
    byId.set(paper.id, key);
    byKey.set(key, paper);
  });
  return { byId, byKey, keys };
}

function bibtexAuthors(authors: PaperAuthor[]): string {
  return authors.map((a) => a.name.trim()).filter(Boolean).join(" and ");
}

// entry type：有 venue 且像期刊 → article；arXiv 预印本 → misc；其余 → article（保守）。
function entryTypeOf(paper: Paper): string {
  if (!paper.venue && paper.ids.arxiv) return "misc";
  if (!paper.venue && !paper.doi) return "misc";
  return "article";
}

export function toBibTeXEntry(paper: Paper, key: string): string {
  const fields: Array<[string, string]> = [];
  const push = (name: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    fields.push([name, escapeBibTeX(String(value))]);
  };

  push("title", paper.title);
  push("author", bibtexAuthors(paper.authors));
  push("year", paper.year !== null ? String(paper.year) : null);
  push("journal", paper.venue);
  push("doi", paper.doi);
  push("url", paper.url);
  if (paper.ids.arxiv) push("eprint", paper.ids.arxiv);
  if (paper.ids.pmid) push("pmid", paper.ids.pmid);
  push("abstract", paper.abstract);

  const body = fields.map(([name, value]) => `  ${name} = {${value}}`).join(",\n");
  return `@${entryTypeOf(paper)}{${key},\n${body}\n}`;
}

export function toBibTeX(papers: Paper[]): string {
  const keys = assignBibtexKeys(papers);
  return papers.map((paper, i) => toBibTeXEntry(paper, keys[i]!)).join("\n\n") + (papers.length > 0 ? "\n" : "");
}

// ── CSL-JSON ────────────────────────────────────────────────────────────────

export interface CSLName {
  family?: string;
  given?: string;
  literal?: string;
}

export interface CSLItem {
  id: string;
  type: string;
  title: string;
  author?: CSLName[];
  issued?: { "date-parts": number[][] };
  "container-title"?: string;
  DOI?: string;
  URL?: string;
  abstract?: string;
  PMID?: string;
  number?: string;
  source?: string;
}

export function toCSLName(name: string): CSLName {
  const cleaned = name.trim().replace(/\s+/g, " ");
  if (!cleaned) return { literal: name };
  if (cleaned.includes(",")) {
    const [family, given] = cleaned.split(",", 2);
    return { family: family!.trim(), given: (given ?? "").trim() || undefined };
  }
  const parts = cleaned.split(" ");
  if (parts.length === 1) return { literal: cleaned };
  return { family: parts[parts.length - 1]!, given: parts.slice(0, -1).join(" ") };
}

export function toCSLItem(paper: Paper, id: string): CSLItem {
  const item: CSLItem = {
    id,
    type: entryTypeOf(paper) === "misc" ? "manuscript" : "article-journal",
    title: paper.title,
  };
  if (paper.authors.length > 0) item.author = paper.authors.map((a) => toCSLName(a.name));
  if (paper.year !== null) item.issued = { "date-parts": [[paper.year]] };
  if (paper.venue) item["container-title"] = paper.venue;
  if (paper.doi) item.DOI = paper.doi;
  if (paper.url) item.URL = paper.url;
  if (paper.abstract) item.abstract = paper.abstract;
  if (paper.ids.pmid) item.PMID = paper.ids.pmid;
  if (paper.sources.length > 0) item.source = paper.sources.join(",");
  return item;
}

export function toCSLJSON(papers: Paper[]): CSLItem[] {
  const keys = assignBibtexKeys(papers);
  return papers.map((paper, i) => toCSLItem(paper, keys[i]!));
}

export type ExportFormat = "bibtex" | "csl";

export function exportLibrary(papers: Array<Paper | LibraryPaper>, format: ExportFormat): string {
  if (format === "bibtex") return toBibTeX(papers);
  return JSON.stringify(toCSLJSON(papers), null, 2) + "\n";
}
