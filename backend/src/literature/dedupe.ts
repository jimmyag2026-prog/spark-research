import {
  firstAuthorSurname,
  titleKey,
  titleSimilarity,
  type LiteratureSource,
  type Paper,
  type PaperAuthor,
} from "./models";

// 跨源去重（DESIGN 域 A1「DOI/标题模糊匹配」）。
//
// 判定顺序：
//   1. DOI 相同（归一化后精确匹配）→ 一定是同一篇，直接合并。
//   2. 无 DOI 时看归一化标题：完全相同，或 Jaccard 相似度 ≥ 阈值。
//      相似但不完全相同的，还要过「年份不冲突 + 第一作者姓不冲突」两道闸，
//      避免把同一系列的不同论文（如 Part I / Part II）误合。
//   3. 两篇都有 DOI 且 DOI 不同 → 无论标题多像都不合并（DOI 是权威判据）。

export const DEFAULT_TITLE_SIMILARITY_THRESHOLD = 0.9;

export interface DedupeOptions {
  titleSimilarityThreshold?: number;
}

// 源可信度：字段冲突时谁说了算（CrossRef 是 DOI 注册方，元数据最规范）。
const SOURCE_PRIORITY: Record<LiteratureSource, number> = {
  crossref: 5,
  openalex: 4,
  europepmc: 3,
  semanticscholar: 2,
  aminer: 1,
  pubmed: 1,
  arxiv: 1,
};

function priorityOf(paper: Paper): number {
  return Math.max(0, ...paper.sources.map((s) => SOURCE_PRIORITY[s] ?? 0));
}

export function canMerge(a: Paper, b: Paper, options: DedupeOptions = {}): boolean {
  const threshold = options.titleSimilarityThreshold ?? DEFAULT_TITLE_SIMILARITY_THRESHOLD;
  if (a.doi && b.doi) return a.doi === b.doi;

  const keyA = titleKey(a.title);
  const keyB = titleKey(b.title);
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;

  if (titleSimilarity(a.title, b.title) < threshold) return false;
  // 标题只是「很像」时，年份与第一作者必须不冲突才敢合并。
  if (a.year !== null && b.year !== null && Math.abs(a.year - b.year) > 1) return false;
  const surnameA = firstAuthorSurname(a);
  const surnameB = firstAuthorSurname(b);
  if (surnameA && surnameB && surnameA !== surnameB) return false;
  return true;
}

function mergeAuthors(a: PaperAuthor[], b: PaperAuthor[]): PaperAuthor[] {
  // 作者列表取更完整的一方；等长时补齐缺失的 affiliation。
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  return longer.map((author, i) => ({
    name: author.name,
    affiliation: author.affiliation ?? shorter[i]?.affiliation ?? null,
  }));
}

function preferString(a: string | null, b: string | null, aWins: boolean): string | null {
  if (a && b) return aWins ? a : b;
  return a ?? b;
}

export function mergePapers(a: Paper, b: Paper): Paper {
  const aWins = priorityOf(a) >= priorityOf(b);
  const [hi, lo] = aWins ? [a, b] : [b, a];
  return {
    title: preferString(hi.title, lo.title, true) ?? "",
    authors: mergeAuthors(a.authors, b.authors),
    year: hi.year ?? lo.year,
    venue: preferString(hi.venue, lo.venue, true),
    doi: hi.doi ?? lo.doi,
    ids: { ...lo.ids, ...hi.ids },
    // 摘要取更长的：跨源常见一方只有截断摘要。
    abstract:
      (a.abstract?.length ?? 0) >= (b.abstract?.length ?? 0) ? (a.abstract ?? b.abstract) : (b.abstract ?? a.abstract),
    url: preferString(hi.url, lo.url, true),
    // PDF 直链谁有算谁的，OA 链接稀缺，不按源优先级挑。
    pdfUrl: a.pdfUrl ?? b.pdfUrl,
    citedByCount: Math.max(a.citedByCount ?? -1, b.citedByCount ?? -1) >= 0
      ? Math.max(a.citedByCount ?? -1, b.citedByCount ?? -1)
      : null,
    isOpenAccess: a.isOpenAccess === true || b.isOpenAccess === true ? true : (hi.isOpenAccess ?? lo.isOpenAccess),
    sources: [...new Set([...a.sources, ...b.sources])].sort(),
    references: [...new Set([...a.references, ...b.references])],
  };
}

// 排序：命中源越多越靠前（跨源交叉验证过的更可信），再按被引、年份、标题兜底。
// 全程确定性，保证同一输入在 CI 与本地得到同一顺序。
export function compareMergedPapers(a: Paper, b: Paper): number {
  if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length;
  const citedA = a.citedByCount ?? -1;
  const citedB = b.citedByCount ?? -1;
  if (citedA !== citedB) return citedB - citedA;
  const yearA = a.year ?? -1;
  const yearB = b.year ?? -1;
  if (yearA !== yearB) return yearB - yearA;
  return titleKey(a.title).localeCompare(titleKey(b.title));
}

export interface DedupeResult {
  papers: Paper[];
  // 合并了多少次（输入条数 - 输出条数），供 CLI 展示与测试断言。
  mergedCount: number;
}

export function dedupePapers(input: Paper[], options: DedupeOptions = {}): DedupeResult {
  const merged: Paper[] = [];
  // DOI → merged 下标，O(1) 命中最常见的强匹配路径。
  const byDoi = new Map<string, number>();
  // 归一化标题 → merged 下标集合，缩小模糊匹配的比较范围。
  const byTitle = new Map<string, number[]>();

  for (const paper of input) {
    let targetIndex = -1;

    if (paper.doi) {
      const hit = byDoi.get(paper.doi);
      if (hit !== undefined) targetIndex = hit;
    }

    if (targetIndex === -1) {
      const key = titleKey(paper.title);
      const candidates = new Set(byTitle.get(key) ?? []);
      if (candidates.size === 0) {
        // 标题不完全相同的走全量模糊比对（结果集通常在百量级，可接受）。
        for (let i = 0; i < merged.length; i++) candidates.add(i);
      }
      for (const index of candidates) {
        if (canMerge(paper, merged[index]!, options)) {
          targetIndex = index;
          break;
        }
      }
    }

    if (targetIndex === -1) {
      merged.push({ ...paper, sources: [...paper.sources] });
      targetIndex = merged.length - 1;
    } else {
      merged[targetIndex] = mergePapers(merged[targetIndex]!, paper);
    }

    const target = merged[targetIndex]!;
    if (target.doi) byDoi.set(target.doi, targetIndex);
    const key = titleKey(target.title);
    const bucket = byTitle.get(key) ?? [];
    if (!bucket.includes(targetIndex)) bucket.push(targetIndex);
    byTitle.set(key, bucket);
  }

  merged.sort(compareMergedPapers);
  return { papers: merged, mergedCount: input.length - merged.length };
}
