import { describe, expect, test } from "bun:test";
import { canMerge, dedupePapers, effectiveTitleSimilarity, mergeAuthors, mergePapers } from "../../backend/src/literature/dedupe";
import { emptyPaper, type Paper } from "../../backend/src/literature/models";

// dedupe.ts 专项单测（W4-b lane）：
//   E-3 —— mergeAuthors 按下标配对 affiliation 的张冠李戴 bug（已复现的 P1）
//   E-5 —— 中文标题的模糊去重（bigram 相似度）

function paper(overrides: Partial<Paper> & { title: string }): Paper {
  return { ...emptyPaper(), ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("E-3：mergeAuthors 按归一化姓名配对（不再按下标）", () => {
  test("评审实测场景复现并验证已修复：跨源作者顺序不同不再张冠李戴", () => {
    // 旧 bug：longer.map((author, i) => shorter[i]?.affiliation) 纯按下标对齐。
    // base（无 affiliation，顺序 [Bob, Alice]） vs collision（有 affiliation，顺序 [Alice(MIT), Bob(Tsinghua)]）
    // 按下标配对会把 base[0]=Bob 配到 collision[0]=Alice(MIT)，base[1]=Alice 配到 collision[1]=Bob(Tsinghua)——
    // 也就是评审报的 Alice/Bob 互换。
    const base = [{ name: "Bob Li" }, { name: "Alice Zhang" }];
    const withAffiliations = [
      { name: "Alice Zhang", affiliation: "MIT" },
      { name: "Bob Li", affiliation: "Tsinghua" },
    ];
    const merged = mergeAuthors(base, withAffiliations);
    expect(merged.find((a) => a.name === "Alice Zhang")?.affiliation).toBe("MIT");
    expect(merged.find((a) => a.name === "Bob Li")?.affiliation).toBe("Tsinghua");
  });

  test("mergePapers 端到端：同一篇论文跨源作者顺序不同，affiliation 仍配对正确", () => {
    const a = paper({
      title: "Deep Learning for Protein Structure",
      doi: "10.1/x",
      year: 2021,
      authors: [{ name: "Bob Li" }, { name: "Alice Zhang" }],
      sources: ["semanticscholar"],
    });
    const b = paper({
      title: "Deep Learning for Protein Structure",
      doi: "10.1/x",
      year: 2021,
      authors: [
        { name: "Alice Zhang", affiliation: "MIT" },
        { name: "Bob Li", affiliation: "Tsinghua" },
      ],
      sources: ["crossref"],
    });
    const merged = mergePapers(a, b);
    expect(merged.authors.find((x) => x.name === "Alice Zhang")?.affiliation).toBe("MIT");
    expect(merged.authors.find((x) => x.name === "Bob Li")?.affiliation).toBe("Tsinghua");

    const viaDedupe = dedupePapers([a, b]).papers[0]!;
    expect(viaDedupe.authors.find((x) => x.name === "Alice Zhang")?.affiliation).toBe("MIT");
    expect(viaDedupe.authors.find((x) => x.name === "Bob Li")?.affiliation).toBe("Tsinghua");
  });

  test("只有唯一同名候选时正常补齐 affiliation", () => {
    const merged = mergeAuthors([{ name: "Carol Lee" }], [{ name: "Carol Lee", affiliation: "NYU" }]);
    expect(merged[0]!.affiliation).toBe("NYU");
  });

  test("另一方压根没有同名作者时不误补（保持空，不瞎猜）", () => {
    const merged = mergeAuthors([{ name: "Solo Author" }], [{ name: "Someone Else", affiliation: "Z" }]);
    expect(merged[0]!.affiliation).toBeNull();
  });

  test("自己已有 affiliation 时不被对方覆盖", () => {
    const merged = mergeAuthors(
      [{ name: "Carol Lee", affiliation: "Own Lab" }],
      [{ name: "Carol Lee", affiliation: "Other Lab" }],
    );
    expect(merged[0]!.affiliation).toBe("Own Lab");
  });

  test("完全同名撞出多个候选时不瞎猜：年份闸——年份不确定就留空，年份对得上才取候选", () => {
    const base = [{ name: "Wei Zhang" }, { name: "Carol Lee" }];
    const collision = [
      { name: "Wei Zhang", affiliation: "A Lab" },
      { name: "Wei Zhang", affiliation: "B Lab" },
    ];
    expect(mergeAuthors(base, collision, 2020, null).find((a) => a.name === "Wei Zhang")?.affiliation).toBeNull();
    expect(mergeAuthors(base, collision, 2020, 2021).find((a) => a.name === "Wei Zhang")?.affiliation).toBeNull();
    expect(mergeAuthors(base, collision, 2020, 2020).find((a) => a.name === "Wei Zhang")?.affiliation).toBe("A Lab");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("E-5：中文标题模糊去重（字符 bigram）", () => {
  // 基准标题足够长（20 字），后面各用例只加/减极少字符，方便手算 Jaccard 校验预期。
  const BASE_TITLE = "基于深度学习的蛋白质三维结构预测方法研究"; // 20 个汉字，19 个 bigram

  test("轻微措辞差异应判高相似（旧的词级 Jaccard 因中文无空格分词会判 0）", () => {
    const a = BASE_TITLE;
    const b = `${BASE_TITLE}综述`; // 追加 2 字：新标题 22 字/21 bigram，19 个与 a 共享
    // 旧实现：titleKey 后整句是一个 token，a≠b → Jaccard=0。
    // 新实现：字符 bigram，shared=19, |A|=19, |B|=21 → 19/(19+21-19)=19/21≈0.905。
    expect(effectiveTitleSimilarity(a, b)).toBeGreaterThan(0.85);
  });

  test("完全不同的中文标题不应被判高相似", () => {
    const a = BASE_TITLE;
    const b = "量子计算在密码学中的前沿进展与挑战";
    expect(effectiveTitleSimilarity(a, b)).toBeLessThan(0.3);
  });

  test("英文标题相似度行为不受影响（回归：不含汉字走原有词级 Jaccard）", () => {
    expect(effectiveTitleSimilarity("Deep Learning Review", "deep learning review!")).toBe(1);
    expect(effectiveTitleSimilarity("Attention is all you need", "Completely different title")).toBeLessThan(0.3);
  });

  test("canMerge：中文标题只差 1 个字 + 年份/作者不冲突 → 合并", () => {
    // 只加 1 个字：shared=19, |A|=19, |B|=20 → 19/20 = 0.95，稳过默认阈值 0.9。
    const a = paper({ title: BASE_TITLE, year: 2021, authors: [{ name: "张伟" }] });
    const b = paper({ title: `${BASE_TITLE}稿`, year: 2021, authors: [{ name: "张伟" }] });
    expect(canMerge(a, b)).toBe(true);
  });

  test("canMerge：中文标题差异过大不合并（即使年份相同）", () => {
    const a = paper({ title: BASE_TITLE, year: 2021 });
    const b = paper({ title: "量子计算在密码学中的前沿进展与挑战", year: 2021 });
    expect(canMerge(a, b)).toBe(false);
  });

  test("dedupePapers：AMiner 中文文献与其他源的结果按 bigram 正确合并", () => {
    const a = paper({
      title: `${BASE_TITLE}稿`,
      year: 2021,
      authors: [{ name: "张伟" }],
      sources: ["aminer"],
    });
    const b = paper({
      title: BASE_TITLE,
      year: 2021,
      authors: [{ name: "张伟" }],
      doi: "10.1/cjk",
      sources: ["crossref"],
    });
    const { papers, mergedCount } = dedupePapers([a, b]);
    expect(mergedCount).toBe(1);
    expect(papers.length).toBe(1);
    expect(papers[0]!.sources).toEqual(["aminer", "crossref"]);
  });
});
