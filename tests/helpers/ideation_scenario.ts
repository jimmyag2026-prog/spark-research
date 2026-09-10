import { join } from "node:path";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { FixtureHttp, type FixtureMode } from "../../backend/src/http/fixture";
import type { LiteratureSource } from "../../backend/src/literature/models";
import { LiteratureSearcher } from "../../backend/src/literature/search";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { llmExtras } from "../../backend/src/llm/types";

// P4 双向对照 e2e 的单一真源。
//
// 录制（tests/integration/novelty_record.test.ts）与回放（tests/unit/novelty_e2e.test.ts）
// **必须**共用这里的检索式与检索参数，否则 fixture key 对不上，回放会 miss。
// 换句话说：下面任何一个常量改了，就必须重新录制 fixture。

export const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "literature");
export const NOVELTY_CASSETTE = "novelty-check";

// 每源取几条、合并后留几条。比 P2 的 10 小：novelty 要的是精确的最近邻，不是召回率，
// 而且 4 源 × 2 检索式 × 2 claim 的响应体如果按 10 条录，cassette 会膨胀到几 MB。
export const NOVELTY_PER_SOURCE = 5;
export const NOVELTY_LIMIT = 8;
export const NOVELTY_SOURCES: LiteratureSource[] = ["openalex", "crossref", "europepmc", "semanticscholar"];

// ── 对照 (a)：已发表工作的核心 idea ──────────────────────────────────────────
// 「用 Transformer 自注意力替代循环结构做序列转导」= Attention Is All You Need 的核心主张。
// 期望：评 existing，并且最近邻命中原文。
export const PUBLISHED_CLAIM = {
  statement: "用 Transformer 的自注意力机制完全替代循环结构来做序列转导建模，并在机器翻译上取得更好效果",
  queries: [
    "transformer architecture dispensing with recurrence for sequence transduction",
    "self-attention replaces recurrent networks for sequence transduction",
  ],
  // 报告必须命中的原文标题（大小写不敏感的子串匹配）。
  expectTitle: "attention is all you need",
};

// ── 对照 (b)：刻意杜撰的组合 idea ────────────────────────────────────────────
// 三个互不相干的东西硬拼在一起，检索不到直接匹配。
// 期望：评 novel/incremental，但**必须**给出最近邻，不许空手评 novel。
export const FABRICATED_CLAIM = {
  statement:
    "用超导量子退火器采样得到的构象系综来预训练蛋白质语言模型，从而预测嗜盐菌蛋白的液液相分离温度",
  queries: [
    "quantum annealing sampled conformational ensembles for protein language model pretraining",
    "superconducting annealer conformer sampling to predict halophilic protein phase separation temperature",
  ],
};

export function fixtureHttp(cassette: string, mode: FixtureMode): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette, mode });
}

export function noveltySearcher(mode: FixtureMode): LiteratureSearcher {
  return new LiteratureSearcher(
    new ConnectorRegistry({ http: fixtureHttp(NOVELTY_CASSETTE, mode) }).registerBuiltins(),
  );
}

// ── fake LLM ────────────────────────────────────────────────────────────────
//
// 纪律（同 P3）：**所有** LLM 调用都走 fake，单测与 e2e 都不打真实模型 API。
// 这个 fake 按 prompt 内容分派，并且**从 prompt 里读取**候选 key/白名单——
// 也就是说它只能引用管线真的检索到的东西。想让它引用一篇没检索到的论文，它做不到；
// 反过来，评级是否成立由 constrainRating 这层确定性代码说了算，不是 fake 说了算。

export type Dispatch = (userPrompt: string) => string | null;

export class ScriptedLlm {
  readonly prompts: string[] = [];
  constructor(private handlers: Dispatch[]) {}

  call = async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
    // 用全部 user 消息拼接分派：重试时最后一条是纠正指令，只看最后一条会错判。
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    this.prompts.push(user);
    for (const handler of this.handlers) {
      const answer = handler(user);
      if (answer !== null) return { ok: true, provider: "kimi", model, content: answer, ...llmExtras() };
    }
    return { ok: true, provider: "kimi", model, content: "{}", ...llmExtras() };
  };

  listModels = () => ({ kimi: [], openai: [], anthropic: [], deepseek: [], qwen: [], openrouter: [] });
}

// prompt 里 `- [@key] 标题…` 或 `### [@key]` 形态的候选清单解析。
export function keysInPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/\[@([A-Za-z0-9][A-Za-z0-9_\-:]*)\]/g)].map((m) => m[1]!);
}

// 从对比 prompt 里按 claim 段落切出各自的候选行（key + 标题）。
export function candidatesByClaim(prompt: string): Map<string, Array<{ key: string; title: string }>> {
  const out = new Map<string, Array<{ key: string; title: string }>>();
  let current: string | null = null;
  for (const line of prompt.split("\n")) {
    const header = line.match(/^### (c\d+):/);
    if (header) {
      current = header[1]!;
      out.set(current, []);
      continue;
    }
    const entry = line.match(/^- \[@([A-Za-z0-9][A-Za-z0-9_\-:]*)\] (.+?) \(/);
    if (entry && current) out.get(current)!.push({ key: entry[1]!, title: entry[2]! });
  }
  return out;
}
