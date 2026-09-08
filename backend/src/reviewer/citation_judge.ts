import type { LLMRouter } from "../llm/router";
import type { CitationJudge, CitationJudgeInput, CitationJudgement, CitationVerdict } from "./rules";

// citation-integrity 的第二类检查（真 key 假内容）需要语义判定，规则层做不到。
// 这里把 LLM 判定隔离在单独文件里：rules.ts 保持纯函数、零 IO，单测不需要 LLM。
//
// 判定失败一律**抛异常**，由 citationIntegrity 汇总成一条可见的 soft finding。
// 绝不把「判不出来」悄悄当成「一致」——那会让核验形同虚设。

export const CITATION_JUDGE_SYSTEM_PROMPT = `你是学术引用核验员。给定：
(A) 一篇论文的精读卡摘要（这是唯一权威对照基准）
(B) 一份综述草稿里引用了这篇论文的句子

判断 (B) 对这篇论文的陈述是否与 (A) 冲突。

只输出一个 JSON 对象：{"verdict": "consistent" | "conflict" | "unclear", "reason": "一句话理由"}

判定标准：
- conflict：草稿把该文献的结论/方法/数据说反了、张冠李戴、或声称了卡片里明确没有的结果
- consistent：草稿的陈述能被卡片内容支持，或只是更概括的表述
- unclear：卡片信息不足以判断（例如草稿讲的是卡片没覆盖的细节）

纪律：
- 只依据卡片内容判断，不要用你自己对这篇论文的记忆
- 「表述更宽泛」不等于冲突；「说了卡片里没有的具体结论」才是冲突
- 拿不准就给 unclear，不要为了显得严格而误报`;

function parseJudgement(raw: string): CitationJudgement {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], raw].filter((c): c is string => typeof c === "string");
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      const verdict = parsed.verdict;
      if (verdict === "consistent" || verdict === "conflict" || verdict === "unclear") {
        return {
          verdict: verdict as CitationVerdict,
          reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "（模型未给出理由）",
        };
      }
    } catch {
      continue;
    }
  }
  throw new Error(`引用一致性判定输出无法解析: ${raw.slice(0, 160)}`);
}

export class LlmCitationJudge implements CitationJudge {
  constructor(
    private llm: Pick<LLMRouter, "call">,
    private model?: string,
  ) {}

  async judge(input: CitationJudgeInput): Promise<CitationJudgement> {
    const messages = [
      { role: "system" as const, content: CITATION_JUDGE_SYSTEM_PROMPT },
      {
        role: "user" as const,
        content:
          `(A) 精读卡摘要 —— 文献 [@${input.baseline.key}]《${input.baseline.title}》：\n${input.baseline.summary}\n\n` +
          `(B) 综述草稿里的句子：\n${input.statement}`,
      },
    ];
    const response = this.model ? await this.llm.call(messages, this.model) : await this.llm.call(messages);
    if (!response.ok) throw new Error(`引用一致性判定调用失败: ${response.content}`);
    return parseJudgement(response.content);
  }
}
