// γ-2（V161 + U58）：中文查询处理层。
//
// U58 现场：`lit search "重复性劳损 预防 办公人群" --sources aminer,openalex,europepmc --limit 6`
// 拿回 75 条原始结果，前 6 条是丙肝防治指南 / IMF 中国国别报告 / ChiMed-GPT /
// 白塞病中西医综述 / 新质生产力与体育科技 —— **0/6 相关**。
//
// 机制（三条，各自独立）：
//   ① AMiner 的 title 检索是词序列匹配，中文整串扑空 → 退回单词命中（自报「查准率低」）；
//   ② OpenAlex / Europe PMC 对中文 token 做松散匹配，"预防" 这种通用词会把任何中文
//      医学文献捞上来；
//   ③ 三个源里真正索引中文期刊的只有 OpenAlex，**但没有相关性保障**。
//
// 这一层做的事**只有一件**：把中文查询变成「主题词 + 英译」，让上面三个源拿到它们
// 真正擅长的输入。它不做排序、不做过滤、不判断相关性——那些各有归属
// （排序 V67、预筛 α-1、语言过滤见 search.ts 的 searchLanguage）。
//
// 刻意的边界：
//   · 纯英文查询**一个字节都不碰**（`via: "passthrough"`，`queries` 就是原查询本身）；
//   · 英译失败**不吞掉**——退回词典兜底，词典也没覆盖就如实返回 `via: "failed"` 并在
//     `note` 里写清楚，调用方照旧只查原查询。不许把「翻译没成功」伪装成「不需要翻译」。
//   · 原查询**永远留在 queries[0]**。中英双查，不是英译替换——中文期刊的检索仍要靠中文串。

/** 一次 LLM 调用的上限：任务书口径 ≤200 token。 */
export const PREPARE_QUERY_MAX_TOKENS = 200;

export type PrepareQueryVia = "passthrough" | "llm" | "dictionary" | "failed";

export interface PreparedQuery {
  /** 用户原样输入的查询。 */
  original: string;
  /** 原查询里有没有 CJK 字符。false 时这一层整体不介入。 */
  hasCJK: boolean;
  /** 实际要发给各源的查询串，去重。**`queries[0]` 恒为原查询。** */
  queries: string[];
  /** 抽出的英文主题词串；没做或做失败时 null。 */
  english: string | null;
  via: PrepareQueryVia;
  /** 人类可读的依据说明（AD-12：结果怎么来的要可见）。passthrough 时为 null。 */
  note: string | null;
}

/** 把一条中文查询翻成英文主题词串；拿不到时返回 null（不许抛）。 */
export type QueryTranslator = (query: string) => Promise<string | null>;

export interface PrepareQueryOptions {
  translate?: QueryTranslator;
}

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;

export function containsCJK(text: string): boolean {
  return CJK.test(text);
}

/**
 * 词典兜底。
 *
 * **它不是「中英词典」**，覆盖不了任意查询——它是「LLM 不可用时至少别一个词都译不出来」
 * 的最后一道。收录口径：本项目真实用过的研究主题词（U58 现场、T3 课题、四份验收任务书）。
 * 覆盖不到的词原样留在中文串里，`via` 标 `dictionary`、`note` 里点名哪些词没译出来——
 * **不许静默半译**（半译比不译更糟：英文源会拿半个中文串去做松散匹配）。
 */
export const QUERY_TERM_DICTIONARY: Record<string, string> = {
  // U58 现场
  重复性劳损: "repetitive strain injury",
  劳损: "strain injury",
  预防: "prevention",
  办公人群: "office workers",
  办公室: "office",
  久坐: "sedentary",
  肌肉骨骼: "musculoskeletal",
  腕管综合征: "carpal tunnel syndrome",
  人机工程学: "ergonomics",
  工效学: "ergonomics",
  // 四份验收任务书的主题
  蛋白质结构预测: "protein structure prediction",
  蛋白结构: "protein structure",
  单细胞: "single cell",
  聚类: "clustering",
  脑机接口: "brain computer interface",
  神经解码: "neural decoding",
  运动意图解码: "motor intention decoding",
  钙钛矿: "perovskite",
  稳定性: "stability",
  // 高频通用研究词
  综述: "review",
  进展: "progress",
  机制: "mechanism",
  治疗: "treatment",
  诊断: "diagnosis",
  干预: "intervention",
  流行病学: "epidemiology",
  随机对照试验: "randomized controlled trial",
  荟萃分析: "meta-analysis",
  队列研究: "cohort study",
  深度学习: "deep learning",
  机器学习: "machine learning",
  大语言模型: "large language model",
  强化学习: "reinforcement learning",
};

/** 词典兜底：按词条长度从长到短贪心替换，返回译文与未覆盖的中文片段。 */
export function dictionaryTranslate(query: string): { english: string | null; untranslated: string[] } {
  const entries = Object.entries(QUERY_TERM_DICTIONARY).sort((a, b) => b[0].length - a[0].length);
  const pieces: string[] = [];
  const untranslated: string[] = [];
  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (!containsCJK(token)) {
      pieces.push(token);
      continue;
    }
    let rest = token;
    const hits: string[] = [];
    for (const [zh, en] of entries) {
      if (rest.includes(zh)) {
        hits.push(en);
        rest = rest.split(zh).join("");
      }
    }
    if (hits.length === 0) {
      untranslated.push(token);
      continue;
    }
    pieces.push(...hits);
    // 词条命中之后剩下的中文残渣**不带进英文串**——半个中文词只会污染英文检索。
    if (containsCJK(rest)) untranslated.push(rest);
  }
  const english = pieces.join(" ").trim();
  return { english: english === "" ? null : english, untranslated };
}

const TRANSLATE_SYSTEM =
  "You turn a research query into English search keywords. " +
  "Reply with ONLY the keywords, space separated, no punctuation, no explanation, at most 8 words. " +
  "Keep domain terms precise (use the standard English term of art, not a literal gloss).";

/** 用一次 ≤200 token 的 LLM 调用做主题词抽取 + 英译。失败一律返回 null，不抛。 */
export function llmQueryTranslator(
  llm: { call: (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, options?: { model?: string; maxTokens?: number }) => Promise<{ ok: boolean; content: string }> },
  model?: string,
): QueryTranslator {
  return async (query: string) => {
    try {
      const res = await llm.call(
        [
          { role: "system", content: TRANSLATE_SYSTEM },
          { role: "user", content: query },
        ],
        { ...(model ? { model } : {}), maxTokens: PREPARE_QUERY_MAX_TOKENS },
      );
      if (!res.ok) return null;
      return sanitizeEnglish(res.content);
    } catch {
      return null;
    }
  };
}

/**
 * 模型的回答可能带引号、换行、编号、甚至一句「Here are the keywords:」。
 * 这里只保留 ASCII 词；**残留 CJK 的一律判失败**（返回 null）——一个没译干净的串
 * 送去英文源，就是 U58 的病灶本身。
 */
export function sanitizeEnglish(raw: string): string | null {
  const firstLine = raw.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => !/[:：]\s*$/.test(l));
  if (!firstLine) return null;
  const cleaned = firstLine
    .replace(/^["'`\s\-*\d.)]+/, "")
    .replace(/["'`.,;]+$/, "")
    .replace(/[,;、]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || containsCJK(cleaned)) return null;
  const words = cleaned.split(" ").filter(Boolean).slice(0, 8);
  return words.length > 0 ? words.join(" ") : null;
}

export async function prepareQuery(
  query: string,
  options: PrepareQueryOptions = {},
): Promise<PreparedQuery> {
  const original = query.trim();
  if (!containsCJK(original)) {
    return { original, hasCJK: false, queries: [original], english: null, via: "passthrough", note: null };
  }

  if (options.translate) {
    const english = await options.translate(original);
    if (english !== null && english !== "") {
      return {
        original,
        hasCJK: true,
        queries: dedupe([original, english]),
        english,
        via: "llm",
        note: `中文查询：已抽取主题词并英译为「${english}」，中英双查后合并`,
      };
    }
  }

  const { english, untranslated } = dictionaryTranslate(original);
  if (english !== null) {
    const missed = untranslated.length > 0 ? `；词典未覆盖：${untranslated.join(" ")}（仍按中文查）` : "";
    return {
      original,
      hasCJK: true,
      queries: dedupe([original, english]),
      english,
      via: "dictionary",
      note: `中文查询：英译走词典兜底（LLM 不可用或译文无效）→「${english}」${missed}`,
    };
  }

  return {
    original,
    hasCJK: true,
    queries: [original],
    english: null,
    via: "failed",
    note:
      "中文查询：英译未成功（LLM 不可用，词典也没覆盖这些词），本次只按中文原串检索——" +
      "英文源对中文 token 做的是松散匹配，查准率会很低（U58）",
  };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}
