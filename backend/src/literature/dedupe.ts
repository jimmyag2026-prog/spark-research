import {
  firstAuthorSurname,
  titleKey,
  titleSimilarity,
  type LiteratureSource,
  type Paper,
  type PaperAuthor,
} from "./models";

// ── CJK 标题相似度（E-5）──────────────────────────────────────────────────────
//
// `titleSimilarity`（models.ts）按空白切分 token 算 Jaccard：中文标题本来就没有
// 空格分词，`titleKey()` 折叠标点后整句变成一个大 token，两篇标题只要有一字之差
// 就会被判 0 相似——中文标题的模糊匹配等于形同虚设。这里不改 models.ts（跨 lane
// 共享文件），只在本文件内为「标题含汉字」的情况换一条相似度算法：按归一化后的
// **字符 bigram** 算 Jaccard，对中文这种无空格语言是标准做法，且对英文标题的行为
// 不变（含汉字才会走这条分支）。

const HAN_PATTERN = /\p{Script=Han}/u;

function hasHan(text: string): boolean {
  return HAN_PATTERN.test(text);
}

function charBigrams(raw: string): Set<string> {
  const chars = [...titleKey(raw)].filter((c) => c !== " ");
  if (chars.length === 0) return new Set();
  if (chars.length === 1) return new Set([chars[0]!]);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

function bigramSimilarity(a: string, b: string): number {
  const setA = charBigrams(a);
  const setB = charBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared++;
  return shared / (setA.size + setB.size - shared);
}

// canMerge 用的相似度：标题含汉字（任一方）就走字符 bigram，否则沿用原有的
// 词级 Jaccard（titleSimilarity）——两条路径共用同一个阈值。
export function effectiveTitleSimilarity(a: string, b: string): number {
  if (hasHan(a) || hasHan(b)) return bigramSimilarity(a, b);
  return titleSimilarity(a, b);
}

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

  if (effectiveTitleSimilarity(a.title, b.title) < threshold) return false;
  // 标题只是「很像」时，年份与第一作者必须不冲突才敢合并。
  if (a.year !== null && b.year !== null && Math.abs(a.year - b.year) > 1) return false;
  const surnameA = firstAuthorSurname(a);
  const surnameB = firstAuthorSurname(b);
  if (surnameA && surnameB && surnameA !== surnameB) return false;
  return true;
}

// 归一化姓名：跨源大小写/空白差异折叠，供作者配对用（不是去重意义上的强 key，
// 只用于「这是不是同一个人」的字符串比较）。
function normalizeAuthorName(name: string): string {
  return titleKey(name);
}

// E-3（已复现的 P1 bug）：旧实现按下标配对 affiliation——`longer.map((author, i) =>
// ... shorter[i]?.affiliation)`。两源作者顺序一旦不同（很常见：一个源按贡献排序，
// 另一个按姓氏字母序），第 i 位就对不上同一个人，导致张冠李戴（评审实测：
// Alice→MIT 的 affiliation 被错配给了顺序里排在同一位的 Bob）。
//
// 改成按**归一化姓名**在两个列表间配对：只有名字匹配的那一位才继承对方的
// affiliation。完全同名撞出多个候选时（同一作者列表里两个人恰好同名，理论上
// 罕见但不可排除），姓名本身已经无法区分身份——不瞎猜，除非两篇论文的年份都
// 已知且相同，否则宁可把 affiliation 留空也不猜（`年份闸`：同一次合并事件里
// a/b 通常已经是同一篇论文，年份摆在这里是给「同名撞车」的场景一个明确、
// 可解释的兜底判据，而不是悄悄按位置猜）。
export function mergeAuthors(
  a: PaperAuthor[],
  b: PaperAuthor[],
  aYear: number | null = null,
  bYear: number | null = null,
): PaperAuthor[] {
  // 作者列表取更完整的一方；缺失的 affiliation 从另一方按姓名找回来。
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  const yearsCompatible = aYear !== null && bYear !== null && aYear === bYear;

  const byName = new Map<string, PaperAuthor[]>();
  for (const author of shorter) {
    const key = normalizeAuthorName(author.name);
    if (!key) continue;
    const bucket = byName.get(key) ?? [];
    bucket.push(author);
    byName.set(key, bucket);
  }

  return longer.map((author) => {
    if (author.affiliation) return { name: author.name, affiliation: author.affiliation };
    const key = normalizeAuthorName(author.name);
    const candidates = key ? (byName.get(key) ?? []) : [];
    if (candidates.length === 1) {
      return { name: author.name, affiliation: candidates[0]!.affiliation ?? null };
    }
    if (candidates.length > 1 && yearsCompatible) {
      // 同名撞车但年份对得上：取第一个候选，好过完全不补。
      return { name: author.name, affiliation: candidates[0]!.affiliation ?? null };
    }
    // 没有唯一匹配（含「压根没这个名字」与「同名撞车且年份对不上/未知」两种）→ 不猜。
    return { name: author.name, affiliation: null };
  });
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
    authors: mergeAuthors(a.authors, b.authors, a.year, b.year),
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
