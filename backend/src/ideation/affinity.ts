import { titleKey, type Paper } from "../literature/models";

// claim ↔ 候选论文的**确定性**相似度。
//
// 它存在的唯一理由：让新颖性评级不能只靠模型嘴上说。评级校验层（novelty.ts 的
// constrainRating）用它来判断「这条候选到底有多接近」，从而约束 existing / novel 两端。
// 所以这里刻意不用任何模型、不用外部服务——同样的输入永远得到同样的数。
//
// 度量选的是**覆盖率**（claim 的词有多少出现在候选里），不是 Jaccard：
// claim 陈述往往比标题长得多，Jaccard 会因为分母里的论文词把真正的命中稀释掉。

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "with", "to", "from", "by", "at", "as",
  "is", "are", "was", "were", "be", "been", "that", "this", "these", "those", "it", "its", "we",
  "our", "their", "than", "then", "but", "not", "no", "can", "could", "will", "would", "may",
  "might", "into", "over", "under", "between", "within", "without", "through", "during", "all",
  "any", "both", "each", "more", "most", "other", "such", "only", "own", "same", "so", "too",
  "very", "out", "up", "down", "about", "after", "before", "above", "below", "again", "further",
  "when", "where", "which", "who", "whom", "why", "how", "also", "via", "use", "using", "used",
  "toward", "towards", "et", "al",
]);

// 极轻量的词尾归并：只处理复数与最常见的两个动词后缀。
// 不上真正的 stemmer——两边用同一个函数，一致性比语言学正确性重要得多。
export function stem(word: string): string {
  let out = word;
  if (out.length > 4 && out.endsWith("ies")) out = `${out.slice(0, -3)}y`;
  else if (out.length > 5 && out.endsWith("ing")) out = out.slice(0, -3);
  else if (out.length > 4 && out.endsWith("ed")) out = out.slice(0, -2);
  else if (out.length > 3 && out.endsWith("s") && !out.endsWith("ss")) out = out.slice(0, -1);
  // 去掉词尾 e：否则 sample / sampled / sampling 会切成 sample / sampl / sampl 三种，
  // 同一个词在 claim 与论文里对不上——这类不一致比「归并得不够」危害大得多。
  if (out.length > 3 && out.endsWith("e")) out = out.slice(0, -1);
  return out;
}

// 每次调用新建正则：模块级 /g 正则会在 matchAll / replace 之间共享 lastIndex，
// 那是典型的「跑第二次结果就不一样」的坑。
const cjkRun = () => /[㐀-鿿぀-ヿ]+/gu;
const latinWord = () => /[a-z0-9]+/g;

// 中文没有空格，按二元组切：既不需要词典，也能让「序列转导」这类术语产生可匹配的片段。
function cjkBigrams(run: string): string[] {
  if (run.length === 1) return [run];
  const out: string[] = [];
  for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}

export function contentTokens(text: string): string[] {
  const normalized = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const tokens: string[] = [];
  for (const match of normalized.matchAll(cjkRun())) tokens.push(...cjkBigrams(match[0]));
  for (const match of normalized.replace(cjkRun(), " ").matchAll(latinWord())) {
    const word = match[0];
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    const stemmed = stem(word);
    if (STOPWORDS.has(stemmed)) continue;
    tokens.push(stemmed);
  }
  return tokens;
}

export function paperText(paper: Paper): string {
  return [paper.title, paper.abstract ?? "", paper.venue ?? ""].join(" ");
}

// 覆盖率：query 的去重内容词有多少比例出现在 target 里。0~1。
export function coverage(query: string, target: string): number {
  const queryTokens = new Set(contentTokens(query));
  if (queryTokens.size === 0) return 0;
  const targetTokens = new Set(contentTokens(target));
  let hit = 0;
  for (const token of queryTokens) if (targetTokens.has(token)) hit++;
  return hit / queryTokens.size;
}

// claim 的相似度 = 「claim 陈述 + 它的每条检索式」里覆盖率最高的一个。
// 取 max 而不是平均：中文陈述对英文论文天然覆盖率为 0，取平均会把真正命中的英文检索式抹平。
export function claimAffinity(texts: string[], paper: Paper): number {
  const target = paperText(paper);
  let best = 0;
  for (const text of texts) {
    const score = coverage(text, target);
    if (score > best) best = score;
  }
  return Math.round(best * 1000) / 1000;
}

// 候选去重用的身份：有 DOI 认 DOI，没有就认归一化标题（与 P2 dedupe 同口径）。
export function paperIdentity(paper: Paper): string {
  return paper.doi ? `doi:${paper.doi}` : `title:${titleKey(paper.title)}`;
}
