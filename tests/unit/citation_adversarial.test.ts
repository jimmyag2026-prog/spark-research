import { afterAll, describe, expect, test } from "bun:test";
import {
  CITATION_RULE,
  citationIntegrity,
  type CitationBaseline,
  type Finding,
} from "../../backend/src/reviewer/rules";
import { FakeJudge } from "../helpers/review_scenario";

// ── P3 对抗测试（DEVELOPMENT_PLAN P3 退出标准）────────────────────────────────
//
// 三种伪造引用模式 × 每种 ≥3 个变体，检出率必须 100%；外加阴性对照防误杀。
//
//   模式 A  编造的 bibtex key（凭空捏造，库里没有、世上也没有）        → 期望 hard
//   模式 B  真 key 假内容（引用库内真论文，但陈述与精读卡冲突）        → 期望 soft（soft 也算检出）
//   模式 C  库外真文献（真实存在、key 形态完全合理，但不在项目库里）   → 期望 hard
//
// 关于 A 与 C：对检查器而言两者是同一件事——「这个 key 不在项目文献库里」。
// 这是**有意**的口径：读者能不能核对一条引用，取决于它在不在库内，
// 而不取决于这篇文献在世界上是否存在。因此 C 不需要联网核实「是否真实存在」，
// 也就不会因为外部 API 不可用而失去检出能力。两类分开列，是为了证明
// 「真实存在」这个属性不会让检查器放松（模式 C 的三个变体都是货真价实的论文）。

// 库内三篇论文（bibtex key 与精读卡对照基准）
const LIBRARY_KEYS = ["jumper2021highly", "baek2021accurate", "lin2023evolutionary"];

const BASELINES = new Map<string, CitationBaseline>([
  [
    "jumper2021highly",
    {
      key: "jumper2021highly",
      title: "Highly accurate protein structure prediction with AlphaFold",
      summary:
        "研究问题: 能否用深度学习达到实验级单链结构预测精度\n" +
        "方法: 端到端 Evoformer + 结构模块，输入 MSA 与模板\n" +
        "核心结论: 在 CASP14 上单链预测达到原子级精度\n" +
        "局限: 对蛋白复合物与无序区效果较弱；不预测构象变化",
    },
  ],
  [
    "baek2021accurate",
    {
      key: "baek2021accurate",
      title: "Accurate prediction of protein structures and interactions using a three-track network",
      summary:
        "研究问题: 三轨网络能否同时建模序列/距离/坐标\n" +
        "方法: 三轨神经网络 RoseTTAFold\n" +
        "核心结论: 精度接近 AlphaFold2 且计算开销更低\n" +
        "局限: 在最难目标上仍落后于 AlphaFold2",
    },
  ],
  [
    "lin2023evolutionary",
    {
      key: "lin2023evolutionary",
      title: "Evolutionary-scale prediction of atomic-level protein structure with a language model",
      summary:
        "研究问题: 不用 MSA 能否做结构预测\n" +
        "方法: 蛋白语言模型 ESMFold，单序列输入\n" +
        "核心结论: 推理速度比基于 MSA 的方法快一个数量级，精度略低\n" +
        "局限: 对低深度进化信息的序列精度下降",
    },
  ],
]);

// 冲突判定用的 fake judge：句子里出现这些「假内容」标记即判 conflict。
// 用确定性关键词而不是真实 LLM，保证对抗测试可重复、不打网络。
const CONFLICT_MARKERS = [
  "在蛋白复合物预测上同样达到原子级精度",
  "计算开销高于 AlphaFold2",
  "精度全面超过基于 MSA 的方法",
];

interface AdversarialCase {
  pattern: "A" | "B" | "C";
  variant: string;
  draft: string;
  expect: "hard" | "soft";
}

const CASES: AdversarialCase[] = [
  // ── 模式 A：编造的 key ────────────────────────────────────────────────────
  {
    pattern: "A",
    variant: "A1 凭空捏造的作者+年份+词",
    draft: "早期工作已经解决了折叠问题[@zhang2019foldsolver]。",
    expect: "hard",
  },
  {
    pattern: "A",
    variant: "A2 库内真 key 的形近错拼",
    draft: "结构预测在 CASP14 上取得突破[@jumper2021highy]。",
    expect: "hard",
  },
  {
    pattern: "A",
    variant: "A3 编造的 key 混在真引用之间",
    draft:
      "三轨网络给出另一条路线[@baek2021accurate]，而后续工作把精度又推高了一截[@wang2022superfold]，" +
      "语言模型路线则更快[@lin2023evolutionary]。",
    expect: "hard",
  },
  // ── 模式 B：真 key 假内容 ─────────────────────────────────────────────────
  {
    pattern: "B",
    variant: "B1 把卡片里的局限说成成果",
    draft: "该工作在蛋白复合物预测上同样达到原子级精度[@jumper2021highly]。",
    expect: "soft",
  },
  {
    pattern: "B",
    variant: "B2 把结论方向说反",
    draft: "RoseTTAFold 的计算开销高于 AlphaFold2[@baek2021accurate]。",
    expect: "soft",
  },
  {
    pattern: "B",
    variant: "B3 张冠李戴地拔高结论",
    draft: "ESMFold 的精度全面超过基于 MSA 的方法[@lin2023evolutionary]。",
    expect: "soft",
  },
  // ── 模式 C：库外真文献（这三篇论文真实存在，只是不在本项目文献库里）────────
  {
    pattern: "C",
    variant: "C1 Attention Is All You Need（真实论文，库外）",
    draft: "Transformer 架构是这些模型的基础[@vaswani2017attention]。",
    expect: "hard",
  },
  {
    pattern: "C",
    variant: "C2 AlphaFold-Multimer（真实论文，库外）",
    draft: "复合物预测由后续工作专门处理[@evans2021protein]。",
    expect: "hard",
  },
  {
    pattern: "C",
    variant: "C3 ImageNet/ResNet（真实论文，库外，跨领域）",
    draft: "残差网络的思想被广泛借用[@he2016deep]。",
    expect: "hard",
  },
];

// 阴性对照：全部真实引用且陈述与卡片一致，必须 0 hard finding。
const NEGATIVE_CONTROLS: Array<{ name: string; draft: string; expectFindings: number }> = [
  {
    name: "N1 三条真引用、陈述与精读卡一致",
    draft:
      "AlphaFold2 在 CASP14 上达到原子级精度[@jumper2021highly]。" +
      "三轨网络以更低开销接近同等精度[@baek2021accurate]。" +
      "语言模型路线免去 MSA、推理更快[@lin2023evolutionary]。",
    expectFindings: 0,
  },
  {
    name: "N2 并列引用形式 [@a; @b]",
    draft: "两条路线各有取舍[@jumper2021highly; @baek2021accurate]。",
    expectFindings: 0,
  },
  {
    name: "N3 强断言但带了引用",
    draft: "该工作首次在 CASP14 上达到原子级精度[@jumper2021highly]。",
    expectFindings: 0,
  },
  {
    name: "N4 代码块里写着示例 key，不应误判",
    draft:
      "引用写法示例：\n```\n[@yourkey2020example]\n```\n实际引用见此[@jumper2021highly]。",
    expectFindings: 0,
  },
];

interface MatrixRow {
  pattern: string;
  variant: string;
  expected: string;
  detected: boolean;
  severity: string;
  key: string;
}

const matrix: MatrixRow[] = [];

async function run(draft: string): Promise<{ findings: Finding[]; hard: Finding[]; soft: Finding[] }> {
  const result = await citationIntegrity({
    draft,
    knownKeys: LIBRARY_KEYS,
    baselines: BASELINES,
    judge: new FakeJudge(CONFLICT_MARKERS),
    location: "text/markdown",
  });
  return {
    findings: result.findings,
    hard: result.findings.filter((f) => f.severity === "hard"),
    soft: result.findings.filter((f) => f.severity === "soft"),
  };
}

describe("对抗测试 · 三种伪造引用模式（退出标准：检出率 100%）", () => {
  for (const testCase of CASES) {
    test(`${testCase.variant} → ${testCase.expect} finding`, async () => {
      const { findings, hard, soft } = await run(testCase.draft);
      const bucket = testCase.expect === "hard" ? hard : soft;

      expect(bucket.length).toBeGreaterThan(0);
      expect(bucket.every((f) => f.rule === CITATION_RULE)).toBe(true);

      if (testCase.expect === "hard") {
        // 伪造/库外引用必须能被 veto（hard）
        expect(hard.some((f) => f.message.includes("unknown_citation"))).toBe(true);
      } else {
        // 真 key 假内容是 soft：提示但不否决
        expect(hard).toHaveLength(0);
        expect(soft.some((f) => f.message.includes("citation_conflict"))).toBe(true);
        expect(soft.some((f) => f.message.includes("inferred"))).toBe(true);
      }

      matrix.push({
        pattern: testCase.pattern,
        variant: testCase.variant,
        expected: testCase.expect,
        detected: bucket.length > 0,
        severity: bucket[0]!.severity,
        key: String((bucket[0]!.detail as { key?: string }).key ?? "-"),
      });
      expect(findings.length).toBeGreaterThan(0);
    });
  }

  test("模式 A/C 的伪造 key 全部落在 unknownKeys 里（无一漏网）", async () => {
    const drafts = CASES.filter((c) => c.pattern !== "B").map((c) => c.draft).join("\n");
    const result = await citationIntegrity({ draft: drafts, knownKeys: LIBRARY_KEYS });
    expect(result.unknownKeys.sort()).toEqual(
      [
        "evans2021protein",
        "he2016deep",
        "jumper2021highy",
        "vaswani2017attention",
        "wang2022superfold",
        "zhang2019foldsolver",
      ].sort(),
    );
    // 同一段里的真引用不受牵连
    expect(result.unknownKeys).not.toContain("jumper2021highly");
  });

  test("模式 B 的三条冲突陈述全部被判定为 conflict", async () => {
    const draft = CASES.filter((c) => c.pattern === "B").map((c) => c.draft).join("");
    const result = await citationIntegrity({
      draft,
      knownKeys: LIBRARY_KEYS,
      baselines: BASELINES,
      judge: new FakeJudge(CONFLICT_MARKERS),
    });
    expect(result.conflictKeys.sort()).toEqual([...LIBRARY_KEYS].sort());
    expect(result.findings.filter((f) => f.severity === "hard")).toHaveLength(0);
  });

  test("模式 B 没有 judge 时如实降级：不报冲突，但也不假装检查过", async () => {
    const draft = CASES.find((c) => c.variant.startsWith("B1"))!.draft;
    const result = await citationIntegrity({ draft, knownKeys: LIBRARY_KEYS, baselines: BASELINES });
    expect(result.judgedCount).toBe(0);
    expect(result.conflictKeys).toHaveLength(0);
    // 没有 judge 就不会产生 conflict finding —— 调用方必须自己知道这一层没跑
    expect(result.findings.filter((f) => f.message.includes("citation_conflict"))).toHaveLength(0);
  });
});

describe("阴性对照 · 真实引用的草稿必须通过（防误杀）", () => {
  for (const control of NEGATIVE_CONTROLS) {
    test(`${control.name} → 0 hard finding`, async () => {
      const { findings, hard } = await run(control.draft);
      expect(hard).toHaveLength(0);
      expect(findings).toHaveLength(control.expectFindings);
      matrix.push({
        pattern: "阴性",
        variant: control.name,
        expected: "0 hard",
        detected: hard.length === 0,
        severity: "-",
        key: "-",
      });
    });
  }

  test("一整篇混合真引用的长草稿：0 hard，soft 仅来自无引用的强断言", async () => {
    const draft = [
      "## 研究现状",
      "深度学习方法把单链结构预测推到了原子级精度[@jumper2021highly]。",
      "三轨网络以更低的计算开销接近同等精度[@baek2021accurate]。",
      "语言模型路线免去 MSA 依赖，推理速度快一个数量级[@lin2023evolutionary]。",
      "",
      "## 开放问题",
      "复合物与无序区仍是公认的难点[@jumper2021highly]。",
      "这一路线显著优于所有传统物理方法。", // 故意留一句无引用强断言
    ].join("\n");
    const { hard, soft } = await run(draft);
    expect(hard).toHaveLength(0);
    expect(soft).toHaveLength(1);
    expect(soft[0]!.message).toContain("unsupported_claim");
  });
});

// 结果矩阵打印出来，直接进 devlog（数字不是我手写的，是跑出来的）。
afterAll(() => {
  const attack = matrix.filter((r) => r.pattern !== "阴性");
  const detected = attack.filter((r) => r.detected).length;
  console.log("\n对抗测试结果矩阵（模式 × 变体）");
  console.log("| 模式 | 变体 | 期望 | 检出 | 实际严重度 | 命中 key |");
  console.log("|------|------|------|------|-----------|---------|");
  for (const row of matrix) {
    console.log(
      `| ${row.pattern} | ${row.variant} | ${row.expected} | ${row.detected ? "✅" : "❌"} | ${row.severity} | ${row.key} |`,
    );
  }
  console.log(`\n伪造引用检出率: ${detected}/${attack.length} = ${((detected / attack.length) * 100).toFixed(0)}%`);
});
