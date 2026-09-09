#!/usr/bin/env bun
// G5：「真 key 假内容」（citation-integrity 模式 B）在**真实模型**下的判准率测量。
//
// 背景（P3 devlog 验收批注）：P3 的对抗矩阵用确定性的 `FakeJudge` 验的是**管线**
//（判定器被调用、conflict 被汇总成 soft finding、故障时降级可见），验不了
// 「真实模型到底判不判得准」。这个脚本补的就是后者。
//
// 口径：
//  - 正类 = 该句对文献的陈述**与精读卡冲突**（伪造/说反/张冠李戴），期望 verdict=conflict
//  - 负类 = 忠实陈述（包括更概括的表述），期望 verdict≠conflict
//  - `unclear` 落在负类一侧：拿不准就不报，是 prompt 里写明的纪律。
//    所以正类判成 unclear 记作**漏报**（FN），负类判成 unclear 记作**正确**（TN）。
//  - precision = TP/(TP+FP)（报出来的冲突里有多少是真的）
//    recall    = TP/(TP+FN)（真的冲突里抓到了多少）
//
// **不进 CI 默认路径**：它要打真实模型 API。CI 跑的是 tests/unit 里的 FakeJudge 版本。
// 用法：OPENROUTER_API_KEY=… bun scripts/measure-citation-judge.ts [--model <id>] [--json]
//
// 没有可用 key 时脚本**如实报「未能测量」并以退出码 2 结束**，不产出任何数字。

import { LLMRouter } from "../backend/src/llm/router";
import { LlmCitationJudge } from "../backend/src/reviewer/citation_judge";
import type { CitationBaseline, CitationJudgement } from "../backend/src/reviewer/rules";

interface Case {
  id: string;
  baseline: CitationBaseline;
  statement: string;
  // true = 这句话与卡片冲突（正类）
  conflicting: boolean;
  // 这条用例想测什么（写进结果表，便于看模型在哪一类上失手）
  pattern: string;
  // basic = 明显的说反/张冠李戴；hard = 边界情形
  tier: "basic" | "hard";
}

// 12 组对照，每组一真一假 = 24 条判定。
// 卡片内容是**唯一权威基准**（prompt 里写死了这条），所以刻意在几组里让卡片
// 与「大众印象中的这篇论文」略有出入——要测的是模型会不会用自己的记忆去覆盖卡片。
function buildCases(): Case[] {
  const specs: Array<{
    key: string;
    title: string;
    summary: string;
    faithful: string;
    conflicting: string;
    pattern: string;
  }> = [
    {
      key: "jumper2021highly",
      title: "Highly accurate protein structure prediction with AlphaFold",
      summary:
        "研究问题: 能否用端到端神经网络从序列直接预测蛋白三维结构\n" +
        "方法: Evoformer + 结构模块，端到端训练，输入 MSA 与模板\n" +
        "核心结论: 在 CASP14 上多数目标达到原子级精度；对单体蛋白效果最好\n" +
        "局限: 对复合物与无序区预测较弱；依赖较深的 MSA",
      faithful: "端到端网络已能在多数单体目标上达到原子级精度 [@jumper2021highly]。",
      conflicting: "该方法在蛋白复合物界面的预测精度同样达到原子级 [@jumper2021highly]。",
      pattern: "把卡片明确写为局限的项目说成成果",
    },
    {
      key: "baek2021accurate",
      title: "Accurate prediction of protein structures and interactions using a three-track network",
      summary:
        "研究问题: 三轨网络能否同时建模序列、距离与坐标信息\n" +
        "方法: 序列/距离/坐标三条信息轨并行，互相传递信息\n" +
        "核心结论: 精度接近但**未超过**同期的端到端方法；推理速度更快\n" +
        "局限: 在浅 MSA 目标上退化明显",
      faithful: "三轨网络以更快的推理速度取得了接近同期方法的精度 [@baek2021accurate]。",
      conflicting: "三轨网络在精度上全面超过了同期的端到端方法 [@baek2021accurate]。",
      pattern: "把结论方向说反（接近 → 超过）",
    },
    {
      key: "lin2023evolutionary",
      title: "Evolutionary-scale prediction of atomic-level protein structure with a language model",
      summary:
        "研究问题: 不用 MSA、只靠蛋白语言模型能否预测结构\n" +
        "方法: 大规模蛋白语言模型 + 结构头，单序列输入\n" +
        "核心结论: 单序列输入即可预测，速度快一个量级；平均精度略低于依赖 MSA 的方法\n" +
        "局限: 对低同源家族精度下降",
      faithful: "语言模型路线以单序列输入换来了数量级的速度提升 [@lin2023evolutionary]。",
      conflicting: "语言模型路线在平均精度上也优于依赖 MSA 的方法 [@lin2023evolutionary]。",
      pattern: "把「略低」拔高成「优于」",
    },
    {
      key: "vaswani2017attention",
      title: "Attention Is All You Need",
      summary:
        "研究问题: 能否完全去掉循环与卷积做序列转导\n" +
        "方法: 纯自注意力的编码器-解码器\n" +
        "核心结论: 在 WMT14 英德/英法翻译上取得当时最好结果，训练时间显著更短\n" +
        "局限: 论文只在机器翻译与一个成分句法分析任务上验证",
      faithful: "纯注意力结构在机器翻译上取得了当时最好的结果，且训练更快 [@vaswani2017attention]。",
      conflicting: "该工作在语言建模与图像分类上也系统验证了这一结构 [@vaswani2017attention]。",
      pattern: "声称卡片里明确没有的验证范围",
    },
    {
      key: "he2016deep",
      title: "Deep Residual Learning for Image Recognition",
      summary:
        "研究问题: 极深网络为何难以训练\n" +
        "方法: 残差连接（identity shortcut）\n" +
        "核心结论: 152 层网络在 ImageNet 上取得当时最好精度；退化问题被缓解\n" +
        "局限: 论文未分析残差为何有效的理论机制",
      faithful: "残差连接缓解了极深网络的退化问题 [@he2016deep]。",
      conflicting: "该论文从理论上证明了残差连接为何能缓解退化问题 [@he2016deep]。",
      pattern: "把「未分析机制」说成「理论证明」",
    },
    {
      key: "devlin2019bert",
      title: "BERT: Pre-training of Deep Bidirectional Transformers",
      summary:
        "研究问题: 双向预训练能否提升下游理解任务\n" +
        "方法: 掩码语言模型 + 下一句预测，先预训练后微调\n" +
        "核心结论: 在 11 个 NLU 任务上刷新最好结果\n" +
        "局限: 预训练与微调之间存在 [MASK] 标记的分布不一致",
      faithful: "先预训练后微调的范式在多个理解任务上大幅刷新了当时的最好结果 [@devlin2019bert]。",
      conflicting: "该方法通过去掉 [MASK] 标记消除了预训练与微调之间的分布不一致 [@devlin2019bert]。",
      pattern: "把局限说成已解决",
    },
    {
      key: "senior2020improved",
      title: "Improved protein structure prediction using potentials from deep learning",
      summary:
        "研究问题: 深度学习给出的距离分布能否指导结构搜索\n" +
        "方法: 预测残基对距离分布，转成势函数后做梯度下降折叠\n" +
        "核心结论: 在 CASP13 自由建模类别排名第一\n" +
        "局限: 仍需较长的优化时间，不是端到端",
      faithful: "把预测的距离分布转成势函数指导折叠，在 CASP13 自由建模上排名第一 [@senior2020improved]。",
      conflicting: "该方法是端到端的，直接从序列输出坐标 [@senior2020improved]。",
      pattern: "方法描述与卡片相反",
    },
    {
      key: "jinek2012programmable",
      title: "A programmable dual-RNA-guided DNA endonuclease",
      summary:
        "研究问题: Cas9 的切割能否被 RNA 编程\n" +
        "方法: 体外重构 crRNA/tracrRNA 与 Cas9 的切割体系\n" +
        "核心结论: 双 RNA 可编程地引导 Cas9 在特定位点切割双链 DNA\n" +
        "局限: 全部为体外实验，未做真核细胞内验证",
      faithful: "双 RNA 可以编程地引导核酸酶在指定位点切割 DNA [@jinek2012programmable]。",
      conflicting: "该工作在人源细胞中验证了可编程切割的有效性 [@jinek2012programmable]。",
      pattern: "把体外结果说成细胞内验证",
    },
    {
      key: "shalek2013single",
      title: "Single-cell transcriptomics reveals bimodality in expression",
      summary:
        "研究问题: 同一细胞类型内部表达是否均一\n" +
        "方法: 单细胞 RNA-seq，18 个细胞\n" +
        "核心结论: 观察到大量基因呈双峰表达；样本量小，结论为探索性\n" +
        "局限: n=18，未做多批次重复",
      faithful: "在少量细胞上观察到基因表达的双峰现象，作者将其定位为探索性结果 [@shalek2013single]。",
      conflicting: "该研究在数千个细胞的多批次重复中确证了双峰表达 [@shalek2013single]。",
      pattern: "夸大样本量与验证强度",
    },
    {
      key: "silver2017mastering",
      title: "Mastering the game of Go without human knowledge",
      summary:
        "研究问题: 不用人类棋谱能否达到顶尖棋力\n" +
        "方法: 自我对弈强化学习 + 蒙特卡洛树搜索\n" +
        "核心结论: 纯自我对弈超过了使用人类数据的前代系统\n" +
        "局限: 结论限于围棋这一完全信息博弈",
      faithful: "纯自我对弈的训练方式超过了使用人类棋谱的前代系统 [@silver2017mastering]。",
      conflicting: "该结论已在不完全信息博弈上得到同样的验证 [@silver2017mastering]。",
      pattern: "把适用范围外推",
    },
    {
      key: "wu2021protein",
      title: "Protein language models for fitness prediction",
      summary:
        "研究问题: 无监督蛋白语言模型能否预测突变体适应度\n" +
        "方法: 用似然比作为打分，在深度突变扫描数据上评估\n" +
        "核心结论: 在多数数据集上优于保守性基线，但在少数数据集上明显更差\n" +
        "局限: 打分与实验测量之间的相关性依数据集波动很大",
      faithful: "无监督似然比打分在多数深度突变扫描数据集上优于保守性基线 [@wu2021protein]。",
      conflicting: "该打分方式在全部数据集上都稳定优于保守性基线 [@wu2021protein]。",
      pattern: "把「多数」说成「全部」（抹掉反例）",
    },
    {
      key: "chen2020simple",
      title: "A simple framework for contrastive learning of visual representations",
      summary:
        "研究问题: 简单的对比学习框架能否学到好的视觉表征\n" +
        "方法: 强数据增广 + 投影头 + 大 batch 对比损失\n" +
        "核心结论: 线性评估精度接近有监督基线；大 batch 与长训练是关键\n" +
        "局限: 对算力要求高，小 batch 下效果显著下降",
      faithful: "在强增广与大 batch 下，对比学习的线性评估精度接近有监督基线 [@chen2020simple]。",
      conflicting: "该框架在小 batch 设定下同样能达到接近有监督的精度 [@chen2020simple]。",
      pattern: "无视卡片里写明的失效条件",
    },
  ];

  const cases: Case[] = [];
  for (const spec of specs) {
    const baseline: CitationBaseline = { key: spec.key, title: spec.title, summary: spec.summary };
    cases.push({
      id: `${spec.key}:faithful`,
      baseline,
      statement: spec.faithful,
      conflicting: false,
      pattern: "忠实陈述",
      tier: "basic",
    });
    cases.push({
      id: `${spec.key}:conflict`,
      baseline,
      statement: spec.conflicting,
      conflicting: true,
      pattern: spec.pattern,
      tier: "basic",
    });
  }
  return [...cases, ...buildHardCases(specs)];
}

// 难例。basic 组全对说明不了太多——那些句子把结论直接说反，人一眼也能看出来。
// 真正决定这个检查器好不好用的是两类边界：
//   hard negative：合法的**概括/换词/加限定**表述。判成 conflict 就是误报噪音，
//                  而误报噪音会训练用户忽略这类告警（比漏报更致命）
//   hard positive：**细微的口径漂移**（把条件结论说成无条件、把相关说成因果、
//                  悄悄改掉数量词），这才是真实综述里最常见的失真形态
function buildHardCases(
  specs: Array<{ key: string; title: string; summary: string }>,
): Case[] {
  const byKey = new Map(specs.map((s) => [s.key, s]));
  const make = (key: string, statement: string, conflicting: boolean, pattern: string): Case => {
    const spec = byKey.get(key)!;
    return {
      id: `${key}:hard-${conflicting ? "pos" : "neg"}`,
      baseline: { key: spec.key, title: spec.title, summary: spec.summary },
      statement,
      conflicting,
      pattern,
      tier: "hard",
    };
  };
  return [
    // ── hard negative：不该报 ──────────────────────────────────────────────
    make(
      "jumper2021highly",
      "深度学习方法已经能把结构预测的精度推到实用水平 [@jumper2021highly]。",
      false,
      "hard-neg：更宽泛的概括（prompt 明说不算冲突）",
    ),
    make(
      "vaswani2017attention",
      "去掉循环结构之后，训练可以更好地并行 [@vaswani2017attention]。",
      false,
      "hard-neg：卡片没明写但属于方法的直接推论",
    ),
    make(
      "chen2020simple",
      "对比学习的效果对训练规模比较敏感 [@chen2020simple]。",
      false,
      "hard-neg：把「大 batch 是关键 / 小 batch 下降」换成中性表述",
    ),
    make(
      "wu2021protein",
      "似然比打分与实验适应度的相关性并不稳定 [@wu2021protein]。",
      false,
      "hard-neg：引的是卡片的局限项本身",
    ),
    make(
      "shalek2013single",
      "单细胞层面的表达异质性在早期工作里就已被观察到 [@shalek2013single]。",
      false,
      "hard-neg：加了限定词的弱化表述",
    ),
    make(
      "senior2020improved",
      "把预测的残基对距离转成优化目标是当时的一条主流路线 [@senior2020improved]。",
      false,
      "hard-neg：把单篇工作放进领域叙述（未声称卡片外结论）",
    ),
    // ── hard positive：该报 ────────────────────────────────────────────────
    make(
      "lin2023evolutionary",
      "语言模型路线在低同源家族上同样保持了精度 [@lin2023evolutionary]。",
      true,
      "hard-pos：把卡片写明的失效条件反过来说",
    ),
    make(
      "baek2021accurate",
      "三轨网络的提速来自它更高的建模精度 [@baek2021accurate]。",
      true,
      "hard-pos：把并列事实编成因果",
    ),
    make(
      "devlin2019bert",
      "双向预训练在全部自然语言任务上都优于单向模型 [@devlin2019bert]。",
      true,
      "hard-pos：11 个理解任务 → 「全部任务」",
    ),
    make(
      "silver2017mastering",
      "自我对弈证明了强化学习不需要任何领域先验 [@silver2017mastering]。",
      true,
      "hard-pos：把一个博弈上的结果升级成普遍论断",
    ),
    make(
      "jinek2012programmable",
      "该工作确立了 CRISPR 作为基因治疗工具的有效性 [@jinek2012programmable]。",
      true,
      "hard-pos：体外机制 → 治疗有效性（跨了两级）",
    ),
    make(
      "he2016deep",
      "残差网络在 ImageNet 上的优势主要来自更多的参数量 [@he2016deep]。",
      true,
      "hard-pos：给出卡片里没有的归因解释",
    ),
  ];
}

export interface JudgeOutcome {
  id: string;
  tier: "basic" | "hard";
  pattern: string;
  expected: "conflict" | "not-conflict";
  verdict: CitationJudgement["verdict"] | "error";
  reason: string;
  correct: boolean;
}

export interface TierScore {
  tier: string;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

export interface Measurement {
  model: string;
  total: number;
  errors: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  byTier: TierScore[];
  outcomes: JudgeOutcome[];
}

export async function measure(
  judge: { judge: (input: { key: string; statement: string; baseline: CitationBaseline }) => Promise<CitationJudgement> },
  model: string,
  cases: Case[] = buildCases(),
): Promise<Measurement> {
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
    const reportedConflict = verdict === "conflict";
    outcomes.push({
      id: item.id,
      tier: item.tier,
      pattern: item.pattern,
      expected: item.conflicting ? "conflict" : "not-conflict",
      verdict,
      reason,
      // 判定出错的用例不算对（也不算进混淆矩阵，单独计 errors）。
      correct: verdict !== "error" && reportedConflict === item.conflicting,
    });
  }

  const scored = outcomes.filter((o) => o.verdict !== "error");
  const tp = scored.filter((o) => o.expected === "conflict" && o.verdict === "conflict").length;
  const fn = scored.filter((o) => o.expected === "conflict" && o.verdict !== "conflict").length;
  const fp = scored.filter((o) => o.expected === "not-conflict" && o.verdict === "conflict").length;
  const tn = scored.filter((o) => o.expected === "not-conflict" && o.verdict !== "conflict").length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  const tierScore = (tier: string, subset: JudgeOutcome[]): TierScore => {
    const t = subset.filter((o) => o.expected === "conflict" && o.verdict === "conflict").length;
    const missed = subset.filter((o) => o.expected === "conflict" && o.verdict !== "conflict").length;
    const wrong = subset.filter((o) => o.expected === "not-conflict" && o.verdict === "conflict").length;
    const clean = subset.filter((o) => o.expected === "not-conflict" && o.verdict !== "conflict").length;
    return {
      tier,
      tp: t,
      fp: wrong,
      tn: clean,
      fn: missed,
      precision: t + wrong > 0 ? t / (t + wrong) : null,
      recall: t + missed > 0 ? t / (t + missed) : null,
    };
  };

  return {
    model,
    total: outcomes.length,
    errors: outcomes.length - scored.length,
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    f1,
    byTier: [
      tierScore("basic", scored.filter((o) => o.tier === "basic")),
      tierScore("hard", scored.filter((o) => o.tier === "hard")),
    ],
    outcomes,
  };
}

export { buildCases };

if (import.meta.main) {
  const args = process.argv.slice(2);
  const modelIndex = args.indexOf("--model");
  const model = modelIndex >= 0 ? args[modelIndex + 1]! : LLMRouter.DEFAULT_MODEL;
  const asJson = args.includes("--json");

  const router = new LLMRouter();
  // 探一次可用性：没有 key 时 LLMRouter 会返回 ok:false 的错误信封而不是抛错，
  // 直接跑会得到 24 条 error —— 那不是「模型判不准」，是「没测成」，必须分清楚。
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
    console.log(`模型：${result.model}`);
    console.log(
      `用例：${result.total} 条 = basic 24（12 组对照，一真一假）+ hard 12（6 难阴 + 6 难阳）· ` +
        `调用失败 ${result.errors} 条\n`,
    );
    console.log("| 用例 | 层 | 期望 | 判定 | 对 | 模式 |");
    console.log("|------|-----|------|------|-----|------|");
    for (const o of result.outcomes) {
      console.log(`| ${o.id} | ${o.tier} | ${o.expected} | ${o.verdict} | ${o.correct ? "✅" : "❌"} | ${o.pattern} |`);
    }
    console.log("");
    const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
    console.log(`混淆矩阵（全部）：TP=${result.tp} FP=${result.fp} TN=${result.tn} FN=${result.fn}`);
    console.log(`precision=${pct(result.precision)} · recall=${pct(result.recall)} · F1=${pct(result.f1)}`);
    for (const tier of result.byTier) {
      console.log(
        `  ${tier.tier}: TP=${tier.tp} FP=${tier.fp} TN=${tier.tn} FN=${tier.fn} · ` +
          `precision=${pct(tier.precision)} recall=${pct(tier.recall)}`,
      );
    }
    console.log("");
    console.log("误判明细：");
    for (const o of result.outcomes.filter((x) => !x.correct)) {
      console.log(`  - ${o.id}（${o.pattern}）→ ${o.verdict}：${o.reason}`);
    }
  }
}
