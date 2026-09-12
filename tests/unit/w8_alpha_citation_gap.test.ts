import { describe, expect, test } from "bun:test";
import { explainCitationGap } from "../../backend/src/reviewer/citation_judge";
import { citationIntegrity, parseCitations, type CitationBaseline } from "../../backend/src/reviewer/rules";
import { FakeJudge } from "../helpers/review_scenario";

// W8-1 α · V87：citation-integrity「解析引用 N / 判定 M」差额分解。
//
// 背景：R4 四课题实测均有 10~15 处「解析 > 判定」的差额（T1 76/64、T2 86/73、
// T3 59/49、T4 113/98，见 docs/BACKLOG.md V87），CLI 与 observation record 都没说
// 这些差额去了哪。`explainCitationGap`（citation_judge.ts）把差额分成四桶：
// 去重 / 自引 / 解析失败·库外 / 其他，并断言四桶之和恒等于 N−M（分桶穷尽，见该
// 函数头部注释）。

const BASELINE: CitationBaseline = {
  key: "jumper2021highly",
  title: "Highly accurate protein structure prediction",
  summary: "核心结论: 在 CASP14 上达到原子级精度; 局限: 对无序区与复合物预测较弱",
};

function baselines(...keys: string[]): Map<string, CitationBaseline> {
  return new Map(keys.map((k) => [k, { ...BASELINE, key: k }]));
}

describe("explainCitationGap · 构造含重复/自引/坏 key 的草稿", () => {
  // 草稿构造：
  //  - jumper2021highly 被正文引用两次，第二次是与第一次完全相同的整句（同句重复
  //    引用同一文献）→ 应归「去重」。
  //  - jumper2021highly 又在文末以参考文献条目形式出现一次（"- [@jumper2021highly] ..."）
  //    → 应归「自引」（引用是书目条目本身，不是对内容的陈述）。
  //  - fakekey2099 是一个库外/编造的 key → 应归「解析失败/库外」。
  //  - 剩下一条正常的、库内有精读卡的引用 → 应归「判定」。
  const draft = [
    "AlphaFold3 大幅提升了配体-蛋白协同折叠的预测精度[@jumper2021highly]。",
    "AlphaFold3 大幅提升了配体-蛋白协同折叠的预测精度[@jumper2021highly]。",
    "这项完全无关的编造引用不在库内[@fakekey2099]。",
    "RFdiffusion 是扩散模型蛋白设计的标志性工作[@baek2023rfdiffusion]。",
    "",
    "参考文献：",
    "- [@jumper2021highly] Highly accurate protein structure prediction. Jumper et al. 2021. Nature.",
  ].join("\n");

  const knownKeys = ["jumper2021highly", "baek2023rfdiffusion"]; // fakekey2099 故意不在库内
  const cardBaselines = baselines("jumper2021highly", "baek2023rfdiffusion");

  test("分解数字精确：N/M/去重/自引/解析失败库外 各自对得上", () => {
    const citations = parseCitations(draft);
    const gap = explainCitationGap(citations, knownKeys, cardBaselines);

    // 解析出的引用总处数：jumper×2（正文）+ fakekey×1 + baek×1 + jumper×1（参考文献行）= 5
    expect(gap.total).toBe(5);
    // 去重：第二处 jumper2021highly 正文引用（key+句子与第一处完全相同）
    expect(gap.duplicate).toBe(1);
    // 自引：参考文献条目那一处 jumper2021highly
    expect(gap.selfReference).toBe(1);
    // 解析失败/库外：fakekey2099
    expect(gap.unresolved).toBe(1);
    // 判定：只剩第一处 jumper2021highly（正文）+ baek2023rfdiffusion
    expect(gap.judged).toBe(2);
    expect(gap.other).toBe(0);

    // 构造性恒等：四桶之和 == N − M。
    expect(gap.duplicate + gap.selfReference + gap.unresolved + gap.other).toBe(gap.total - gap.judged);
  });

  test("与 citationIntegrity 真实产出交叉核对（无重复引用场景下 judged 与 judgedCount 逐一致）", async () => {
    // 单独一条不含重复引用的草稿，验证 explainCitationGap 的 judged 与 rules.ts
    // 的 judgedCount 在「没有重复引用」这个前提下完全一致（有重复时前者更精确，
    // 见 citation_judge.ts 头部注释「如实交代」）。
    const noDupDraft = [
      "AlphaFold3 大幅提升了配体-蛋白协同折叠的预测精度[@jumper2021highly]。",
      "这项完全无关的编造引用不在库内[@fakekey2099]。",
      "RFdiffusion 是扩散模型蛋白设计的标志性工作[@baek2023rfdiffusion]。",
    ].join("\n");
    const citations = parseCitations(noDupDraft);
    const check = await citationIntegrity({
      draft: noDupDraft,
      knownKeys,
      baselines: cardBaselines,
      judge: new FakeJudge(),
      checkUnsupportedClaims: false,
    });
    const gap = explainCitationGap(citations, knownKeys, cardBaselines);
    expect(gap.total).toBe(check.citations.length);
    expect(gap.judged).toBe(check.judgedCount);
    expect(gap.duplicate).toBe(0);
    expect(gap.unresolved).toBe(1); // fakekey2099
  });

  test("全部可判定、无差额时四桶全 0", () => {
    const md = "AlphaFold3 大幅提升了配体-蛋白协同折叠的预测精度[@jumper2021highly]。";
    const citations = parseCitations(md);
    const gap = explainCitationGap(citations, ["jumper2021highly"], baselines("jumper2021highly"));
    expect(gap).toEqual({ total: 1, judged: 1, duplicate: 0, selfReference: 0, unresolved: 0, other: 0 });
  });

  test("库内 key 但没有精读卡对照基准 → 归「解析失败/库外」，不归「判定」", () => {
    const md = "该文献目前只入库还没精读[@nocardyet2024]。";
    const citations = parseCitations(md);
    // knownKeys 里有这个 key（已入库），但 baselines 里没有它（还没生成精读卡）。
    const gap = explainCitationGap(citations, ["nocardyet2024"], new Map());
    expect(gap.unresolved).toBe(1);
    expect(gap.judged).toBe(0);
  });
});
