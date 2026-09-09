#!/usr/bin/env bun
// G5：「真 key 假内容」（citation-integrity 模式 B）在**真实模型**下的判准率测量。
//
// 背景（P3 devlog 验收批注）：P3 的对抗矩阵用确定性的 `FakeJudge` 验的是**管线**
//（判定器被调用、conflict 被汇总成 soft finding、故障时降级可见），验不了
// 「真实模型到底判不判得准」。这个脚本补的就是后者。
//
// 口径：
//  - 正类 = 该句对文献的陈述**与精读卡冲突**（说反 / 篡改数值 / 悄悄外推），期望 verdict=conflict
//  - 负类 = 忠实陈述（包括更概括、换词、加限定的合法表述），期望 verdict≠conflict
//  - `unclear` 落在负类一侧：「拿不准就 unclear」是 prompt 里写明的纪律。
//    所以正类判成 unclear 记作**漏报**（FN），负类判成 unclear 记作**正确**（TN）。
//  - precision = TP/(TP+FP)（报出来的冲突里有多少是真的）
//    recall    = TP/(TP+FN)（真的冲突里抓到了多少）
//
// **三档分别报告**，不给单一总分：一个 48/48 的满分只说明测试集没有区分度，
// 说明不了检查器好不好用。三档的设计意图各不相同：
//   easy   结论方向被说反 / 卡片写明的局限被说成成果 —— 人一眼能看出来的
//   medium 数值与条件口径被篡改（样本量、数据集、层数、指标），方向不变 ——
//          考的是「模型有没有真的去对照卡片里的数字」，而不是凭语感
//   hard   语义细微偏移（条件结论→普适、并列→因果、子集→全体、加归因）——
//          真实综述里最常见的失真形态，也是最难抓的
// 每档都配等量的**难阴性**（合法的概括/换词/加限定）来测误报：误报噪音比漏报更致命，
// 它会训练用户忽略这类告警。
//
// **不进 CI 默认路径**：它要打真实模型 API。CI 跑的是 tests/unit 里的 FakeJudge 版本
//（`tests/unit/citation_adversarial.test.ts`）。
//
// 用法：OPENROUTER_API_KEY=… bun scripts/measure-citation-judge.ts [--model <id>] [--json]
// 没有可用 key 时**如实报「未能测量」并以退出码 2 结束**，不产出任何数字。

import { LLMRouter } from "../backend/src/llm/router";
import { LlmCitationJudge } from "../backend/src/reviewer/citation_judge";
import type { CitationBaseline, CitationJudgement } from "../backend/src/reviewer/rules";

export const TIERS = ["easy", "medium", "hard"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_DESCRIPTION: Record<Tier, string> = {
  easy: "陈述与精读卡明显矛盾（结论说反 / 卡片写明的局限被说成成果）",
  medium: "数值与条件口径被篡改（样本量、数据集、层数、指标），结论方向不变",
  hard: "语义细微偏移（条件结论→普适、并列→因果、子集→全体、凭空归因）",
};

interface Case {
  id: string;
  tier: Tier;
  baseline: CitationBaseline;
  statement: string;
  // true = 这句话与卡片冲突（正类）
  conflicting: boolean;
  // 这条用例想测什么（写进结果表，便于看模型在哪一类上失手）
  pattern: string;
}

interface PaperSpec {
  key: string;
  title: string;
  // 精读卡摘要是**唯一权威基准**（prompt 里写死了这条）。刻意在几处让卡片与
  // 「大众印象中的这篇论文」略有出入，用来测模型会不会拿自己的记忆覆盖卡片。
  summary: string;
  tiers: Record<Tier, { faithful: string; faithfulPattern: string; conflicting: string; conflictingPattern: string }>;
}

const PAPERS: PaperSpec[] = [
  {
    key: "jumper2021highly",
    title: "Highly accurate protein structure prediction with AlphaFold",
    summary:
      "研究问题: 能否用端到端神经网络从序列直接预测蛋白三维结构\n" +
      "方法: Evoformer + 结构模块，端到端训练，输入 MSA 与模板；在 CASP14 的 87 个目标上评估\n" +
      "核心结论: 中位 GDT_TS 达到 92.4；多数单体目标达到原子级精度\n" +
      "局限: 对蛋白复合物界面与无序区预测较弱；依赖较深的 MSA（有效序列数 <30 时明显退化）",
    tiers: {
      easy: {
        faithful: "端到端网络已能在多数单体目标上达到原子级精度 [@jumper2021highly]。",
        faithfulPattern: "忠实复述核心结论",
        conflicting: "该方法在蛋白复合物界面的预测精度同样达到原子级 [@jumper2021highly]。",
        conflictingPattern: "把卡片写明的局限说成成果",
      },
      medium: {
        faithful: "在 CASP14 的 87 个目标上，其中位 GDT_TS 为 92.4 [@jumper2021highly]。",
        faithfulPattern: "数值与卡片一致",
        conflicting: "在 CASP14 的 87 个目标上，其中位 GDT_TS 为 78.1 [@jumper2021highly]。",
        conflictingPattern: "改指标数值（92.4 → 78.1），方向不变",
      },
      hard: {
        faithful: "深度学习方法已经把结构预测的精度推到了实用水平 [@jumper2021highly]。",
        faithfulPattern: "合法的更宽泛概括",
        conflicting: "该方法的精度提升主要来自 MSA 深度而非网络结构本身 [@jumper2021highly]。",
        conflictingPattern: "凭空给出卡片里没有的归因",
      },
    },
  },
  {
    key: "baek2021accurate",
    title: "Accurate prediction of protein structures and interactions using a three-track network",
    summary:
      "研究问题: 三轨网络能否同时建模序列、距离与坐标信息\n" +
      "方法: 序列/距离/坐标三条信息轨并行互传；单张 RTX2080 上约 10 分钟完成一个目标\n" +
      "核心结论: 精度接近但**未超过**同期的端到端方法；推理速度快约 5 倍\n" +
      "局限: 在浅 MSA 目标上退化明显",
    tiers: {
      easy: {
        faithful: "三轨网络以更快的推理速度取得了接近同期方法的精度 [@baek2021accurate]。",
        faithfulPattern: "忠实复述核心结论",
        conflicting: "三轨网络在精度上全面超过了同期的端到端方法 [@baek2021accurate]。",
        conflictingPattern: "把结论方向说反（接近 → 超过）",
      },
      medium: {
        faithful: "该方法在单张消费级 GPU 上约 10 分钟即可完成一个目标 [@baek2021accurate]。",
        faithfulPattern: "数值与卡片一致",
        conflicting: "该方法在单张消费级 GPU 上约 10 秒即可完成一个目标 [@baek2021accurate]。",
        conflictingPattern: "改时间量级（10 分钟 → 10 秒）",
      },
      hard: {
        faithful: "三轨设计是当时在精度与算力开销之间取折中的代表性尝试 [@baek2021accurate]。",
        faithfulPattern: "把单篇工作放进领域叙述，未声称卡片外结论",
        conflicting: "三轨网络的提速来自它更高的建模精度 [@baek2021accurate]。",
        conflictingPattern: "把并列事实编成因果",
      },
    },
  },
  {
    key: "lin2023evolutionary",
    title: "Evolutionary-scale prediction of atomic-level protein structure with a language model",
    summary:
      "研究问题: 不用 MSA、只靠蛋白语言模型能否预测结构\n" +
      "方法: 150 亿参数的蛋白语言模型 + 结构头，单序列输入\n" +
      "核心结论: 单序列输入即可预测，速度快约 60 倍；平均精度略低于依赖 MSA 的方法\n" +
      "局限: 对低同源家族（有效序列数少）精度下降明显",
    tiers: {
      easy: {
        faithful: "语言模型路线以单序列输入换来了数量级的速度提升 [@lin2023evolutionary]。",
        faithfulPattern: "忠实复述核心结论",
        conflicting: "语言模型路线在平均精度上也优于依赖 MSA 的方法 [@lin2023evolutionary]。",
        conflictingPattern: "把「略低」拔高成「优于」",
      },
      medium: {
        faithful: "该工作用的是 150 亿参数规模的蛋白语言模型 [@lin2023evolutionary]。",
        faithfulPattern: "数值与卡片一致",
        conflicting: "该工作用的是 6.5 亿参数规模的蛋白语言模型 [@lin2023evolutionary]。",
        conflictingPattern: "改模型规模（150 亿 → 6.5 亿）",
      },
      hard: {
        faithful: "去掉 MSA 依赖之后，推理成本大幅下降 [@lin2023evolutionary]。",
        faithfulPattern: "换词表述，语义等价",
        conflicting: "语言模型路线在低同源家族上同样保持了精度 [@lin2023evolutionary]。",
        conflictingPattern: "把卡片写明的失效条件反过来说",
      },
    },
  },
  {
    key: "vaswani2017attention",
    title: "Attention Is All You Need",
    summary:
      "研究问题: 能否完全去掉循环与卷积做序列转导\n" +
      "方法: 纯自注意力的编码器-解码器，6 层编码器 + 6 层解码器，8 个注意力头\n" +
      "核心结论: WMT14 英德 BLEU 28.4，英法 41.8，均为当时最好；训练时间显著更短\n" +
      "局限: 论文只在机器翻译与一个成分句法分析任务上验证",
    tiers: {
      easy: {
        faithful: "纯注意力结构在机器翻译上取得了当时最好的结果，且训练更快 [@vaswani2017attention]。",
        faithfulPattern: "忠实复述核心结论",
        conflicting: "该工作在语言建模与图像分类上也系统验证了这一结构 [@vaswani2017attention]。",
        conflictingPattern: "声称卡片里明确没有的验证范围",
      },
      medium: {
        faithful: "该模型在 WMT14 英德上取得 28.4 BLEU [@vaswani2017attention]。",
        faithfulPattern: "数值与卡片一致",
        conflicting: "该模型在 WMT14 英德上取得 41.8 BLEU [@vaswani2017attention]。",
        conflictingPattern: "把英法的分数安到英德上（张冠李戴的数值）",
      },
      hard: {
        faithful: "去掉循环结构之后，训练可以更好地并行 [@vaswani2017attention]。",
        faithfulPattern: "卡片没明写但属于方法的直接推论",
        conflicting: "该结构此后被证明是所有序列任务的最优选择 [@vaswani2017attention]。",
        conflictingPattern: "把两个任务上的结果升级成普遍论断",
      },
    },
  },
  {
    key: "devlin2019bert",
    title: "BERT: Pre-training of Deep Bidirectional Transformers",
    summary:
      "研究问题: 双向预训练能否提升下游理解任务\n" +
      "方法: 掩码语言模型 + 下一句预测，先预训练后微调；BERT-large 为 24 层、3.4 亿参数\n" +
      "核心结论: 在 11 个 NLU 任务上刷新最好结果；GLUE 得分 80.5\n" +
      "局限: 预训练与微调之间存在 [MASK] 标记的分布不一致",
    tiers: {
      easy: {
        faithful: "先预训练后微调的范式在多个理解任务上大幅刷新了当时的最好结果 [@devlin2019bert]。",
        faithfulPattern: "忠实复述核心结论",
        conflicting: "该方法通过去掉 [MASK] 标记消除了预训练与微调之间的分布不一致 [@devlin2019bert]。",
        conflictingPattern: "把局限说成已解决",
      },
      medium: {
        faithful: "该方法在 11 个自然语言理解任务上刷新了最好结果 [@devlin2019bert]。",
        faithfulPattern: "数值与卡片一致",
        conflicting: "该方法在 27 个自然语言理解任务上刷新了最好结果 [@devlin2019bert]。",
        conflictingPattern: "改任务数量（11 → 27）",
      },
      hard: {
        faithful: "掩码式预训练让模型能同时利用左右两侧的上下文 [@devlin2019bert]。",
        faithfulPattern: "换词表述，语义等价",
        conflicting: "双向预训练在全部自然语言任务上都优于单向模型 [@devlin2019bert]。",
        conflictingPattern: "11 个理解任务 → 「全部任务」",
      },
    },
  },
  {
    key: "shalek2013single",
    title: "Single-cell transcriptomics reveals bimodality in expression",
    summary:
      "研究问题: 同一细胞类型内部表达是否均一\n" +
      "方法: 单细胞 RNA-seq，18 个骨髓来源树突状细胞，单批次\n" +
      "核心结论: 观察到大量基因呈双峰表达；作者将结论定位为探索性\n" +
      "局限: n=18，未做多批次重复，未做蛋白层面验证",
    tiers: {
      easy: {
        faithful: "在少量细胞上观察到基因表达的双峰现象，作者将其定位为探索性结果 [@shalek2013single]。",
        faithfulPattern: "忠实复述核心结论",
        conflicting: "该研究在多批次重复中确证了双峰表达并做了蛋白层面验证 [@shalek2013single]。",
        conflictingPattern: "把卡片写明的局限说成已完成的验证",
      },
      medium: {
        faithful: "该研究测了 18 个细胞 [@shalek2013single]。",
        faithfulPattern: "数值与卡片一致",
        conflicting: "该研究测了 1800 个细胞 [@shalek2013single]。",
        conflictingPattern: "改样本量（18 → 1800）",
      },
      hard: {
        faithful: "单细胞层面的表达异质性在早期工作里就已被观察到 [@shalek2013single]。",
        faithfulPattern: "加了限定词的弱化表述",
        conflicting: "该研究表明表达异质性是所有细胞类型的普遍属性 [@shalek2013single]。",
        conflictingPattern: "一种细胞的探索性观察 → 全体的普遍属性",
      },
    },
  },
  {
    key: "jinek2012programmable",
    title: "A programmable dual-RNA-guided DNA endonuclease",
    summary:
      "研究问题: Cas9 的切割能否被 RNA 编程\n" +
      "方法: 体外重构 crRNA/tracrRNA 与 Cas9 的切割体系；测试了 3 个靶位点\n" +
      "核心结论: 双 RNA 可编程地引导 Cas9 在特定位点切割双链 DNA\n" +
      "局限: 全部为体外实验，未做真核细胞内验证；未评估脱靶",
    tiers: {
      easy: {
        faithful: "双 RNA 可以编程地引导核酸酶在指定位点切割 DNA [@jinek2012programmable]。",
        faithfulPattern: "忠实复述核心结论",
        conflicting: "该工作在人源细胞中验证了可编程切割的有效性 [@jinek2012programmable]。",
        conflictingPattern: "把体外结果说成细胞内验证",
      },
      medium: {
        faithful: "该工作在体外测试了 3 个靶位点 [@jinek2012programmable]。",
        faithfulPattern: "数值与卡片一致",
        conflicting: "该工作在体外测试了 30 个靶位点并评估了脱靶 [@jinek2012programmable]。",
        conflictingPattern: "改位点数并添加卡片明确排除的评估项",
      },
      hard: {
        faithful: "该工作确立了 RNA 引导切割这一机制的可编程性 [@jinek2012programmable]。",
        faithfulPattern: "合法的机制层面概括",
        conflicting: "该工作确立了 CRISPR 作为基因治疗工具的有效性 [@jinek2012programmable]。",
        conflictingPattern: "体外机制 → 治疗有效性（跨了两级）",
      },
    },
  },
  {
    key: "chen2020simple",
    title: "A simple framework for contrastive learning of visual representations",
    summary:
      "研究问题: 简单的对比学习框架能否学到好的视觉表征\n" +
      "方法: 强数据增广 + 投影头 + 对比损失；batch size 最大用到 8192，训练 1000 epoch\n" +
      "核心结论: ImageNet 线性评估 top-1 达到 76.5%，接近有监督基线\n" +
      "局限: 对算力要求高；batch size 降到 256 时精度明显下降",
    tiers: {
      easy: {
        faithful: "在强增广与大 batch 下，对比学习的线性评估精度接近有监督基线 [@chen2020simple]。",
        faithfulPattern: "忠实复述核心结论",
        conflicting: "该框架在小 batch 设定下同样能达到接近有监督的精度 [@chen2020simple]。",
        conflictingPattern: "无视卡片里写明的失效条件",
      },
      medium: {
        faithful: "其 ImageNet 线性评估 top-1 为 76.5% [@chen2020simple]。",
        faithfulPattern: "数值与卡片一致",
        conflicting: "其 ImageNet 线性评估 top-1 为 85.6% [@chen2020simple]。",
        conflictingPattern: "改精度数值（76.5% → 85.6%）",
      },
      hard: {
        faithful: "对比学习的效果对训练规模比较敏感 [@chen2020simple]。",
        faithfulPattern: "把「大 batch 是关键 / 小 batch 下降」换成中性表述",
        conflicting: "该框架说明无监督表征学习已经不再需要标注数据 [@chen2020simple]。",
        conflictingPattern: "线性评估结果 → 「不再需要标注」的立场性论断",
      },
    },
  },
];

export function buildCases(tiers: readonly Tier[] = TIERS): Case[] {
  const cases: Case[] = [];
  for (const paper of PAPERS) {
    const baseline: CitationBaseline = { key: paper.key, title: paper.title, summary: paper.summary };
    for (const tier of tiers) {
      const spec = paper.tiers[tier];
      cases.push({
        id: `${paper.key}:${tier}:faithful`,
        tier,
        baseline,
        statement: spec.faithful,
        conflicting: false,
        pattern: spec.faithfulPattern,
      });
      cases.push({
        id: `${paper.key}:${tier}:conflict`,
        tier,
        baseline,
        statement: spec.conflicting,
        conflicting: true,
        pattern: spec.conflictingPattern,
      });
    }
  }
  return cases;
}

export interface JudgeOutcome {
  id: string;
  tier: Tier;
  pattern: string;
  expected: "conflict" | "not-conflict";
  verdict: CitationJudgement["verdict"] | "error";
  reason: string;
  correct: boolean;
}

export interface TierScore {
  tier: Tier | "overall";
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

export interface Measurement {
  model: string;
  temperature: string;
  total: number;
  errors: number;
  overall: TierScore;
  byTier: TierScore[];
  outcomes: JudgeOutcome[];
}

function score(tier: Tier | "overall", subset: JudgeOutcome[]): TierScore {
  const tp = subset.filter((o) => o.expected === "conflict" && o.verdict === "conflict").length;
  const fn = subset.filter((o) => o.expected === "conflict" && o.verdict !== "conflict").length;
  const fp = subset.filter((o) => o.expected === "not-conflict" && o.verdict === "conflict").length;
  const tn = subset.filter((o) => o.expected === "not-conflict" && o.verdict !== "conflict").length;
  return {
    tier,
    n: subset.length,
    tp,
    fp,
    tn,
    fn,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
  };
}

export async function measure(
  judge: {
    judge: (input: { key: string; statement: string; baseline: CitationBaseline }) => Promise<CitationJudgement>;
  },
  model: string,
  options: { cases?: Case[]; temperature?: string } = {},
): Promise<Measurement> {
  const cases = options.cases ?? buildCases();
  const outcomes: JudgeOutcome[] = [];
  for (const item of cases) {
    let verdict: JudgeOutcome["verdict"] = "error";
    let reason = "";
    try {
      const judgement = await judge.judge({
        key: item.baseline.key,
        statement: item.statement,
        baseline: item.baseline,
      });
      verdict = judgement.verdict;
      reason = judgement.reason;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    outcomes.push({
      id: item.id,
      tier: item.tier,
      pattern: item.pattern,
      expected: item.conflicting ? "conflict" : "not-conflict",
      verdict,
      reason,
      // 调用出错的用例不算对，也不进混淆矩阵（单独计 errors）——
      // 「没测成」与「判错了」必须分开，否则会把接口故障读成模型能力问题。
      correct: verdict !== "error" && (verdict === "conflict") === item.conflicting,
    });
  }

  const scored = outcomes.filter((o) => o.verdict !== "error");
  return {
    model,
    // LLMRouter 不传 temperature，用的是各 provider 的默认值。如实记录这一点，
    // 而不是写一个我们并没有设置的数字。
    temperature: options.temperature ?? "provider default（LLMRouter 未显式设置）",
    total: outcomes.length,
    errors: outcomes.length - scored.length,
    overall: score("overall", scored),
    byTier: TIERS.map((tier) => score(tier, scored.filter((o) => o.tier === tier))),
    outcomes,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const modelIndex = args.indexOf("--model");
  const model = modelIndex >= 0 ? args[modelIndex + 1]! : LLMRouter.DEFAULT_MODEL;
  const asJson = args.includes("--json");

  const router = new LLMRouter();
  // 探一次可用性：没有 key 时 LLMRouter 返回 ok:false 的错误信封而不是抛错，
  // 直接跑会得到一片 error —— 那不是「模型判不准」，是「没测成」，必须分清楚。
  const probe = await router.call([{ role: "user", content: "ping" }], model);
  if (!probe.ok) {
    console.error("❌ 未能测量：没有可用的 LLM 凭据。");
    console.error(`   模型 ${model} 的调用返回：${probe.content}`);
    console.error("   需要 OPENROUTER_API_KEY 或 KIMI_API_KEY（AMiner 是文献源，不是 LLM）。");
    process.exit(2);
  }

  const result = await measure(new LlmCitationJudge(router, model), model);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
    console.log(`模型：${result.model} · temperature：${result.temperature}`);
    console.log(
      `用例：${result.total} 条 = ${PAPERS.length} 篇文献 × 3 档 ×（1 真 + 1 假）· ` +
        `调用失败 ${result.errors} 条\n`,
    );
    console.log("| 用例 | 档 | 期望 | 判定 | 对 | 模式 |");
    console.log("|------|-----|------|------|-----|------|");
    for (const o of result.outcomes) {
      console.log(`| ${o.id} | ${o.tier} | ${o.expected} | ${o.verdict} | ${o.correct ? "✅" : "❌"} | ${o.pattern} |`);
    }
    console.log("");
    console.log("| 档 | 样本 | TP | FP | TN | FN | precision | recall |");
    console.log("|----|------|----|----|----|----|-----------|--------|");
    for (const tier of [...result.byTier, result.overall]) {
      console.log(
        `| ${tier.tier} | ${tier.n} | ${tier.tp} | ${tier.fp} | ${tier.tn} | ${tier.fn} | ` +
          `${pct(tier.precision)} | ${pct(tier.recall)} |`,
      );
    }
    const wrong = result.outcomes.filter((x) => !x.correct);
    console.log("");
    if (wrong.length === 0) {
      console.log("误判明细：无");
    } else {
      console.log("误判明细：");
      for (const o of wrong) {
        console.log(`  - ${o.id}（${o.pattern}）→ ${o.verdict}：${o.reason}`);
      }
    }
  }
}
