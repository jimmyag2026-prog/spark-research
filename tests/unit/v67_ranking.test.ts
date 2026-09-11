import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupePapers } from "../../backend/src/literature/dedupe";
import { RANK_MODES, emptyPaper, type Paper, type RankMode } from "../../backend/src/literature/models";
import { applyRank, rankBlended, type LiteratureSearchResult } from "../../backend/src/literature/search";
import { runLitCommand } from "../../backend/src/literature/cli";

// V67（BACKLOG）：跨源合并后的排序问题，不是覆盖问题。R1/R2 实测：任务书检索式下
// 里程碑论文（高被引但只命中 1 个源）沉在结果尾部——T1 召回 2/8、T4 英文 1/5@10
// （limit 提到 150 仍 2/5），而缺席的论文 DOI 直加秒中。旧默认排序（dedupe.ts 的
// compareMergedPapers）只看「命中源数 → 首见顺序」，完全不看被引/年份。
//
// 本文件用固定的假检索结果集断言 §交付4 的四点：
//   ① 高被引里程碑在 blended 下进前 10、在 hits 下沉底（复现 T1 形状）
//   ② 缺被引数的源退化正确（不当 0 处理，不会被死死压到底）
//   ③ --rank 四档各自可解释
//   ④ note 含排序依据（AD-12：结果怎么来的要可见）
// 以及 --rank hits 与 v0.6 原始行为逐字节一致的回归钉子。
//
// 阴性对照（真跑，记录见 docs/devlog/W7-B1.md）：
//   · 被引权重（search.ts BLENDED_CITATION_WEIGHT）改成 0 → ① 的「进前 10」断言必须红。
//   · 删掉 fallbackCitationFactor 的退化分支（换成 citedByCount ?? 0）→ ② 断言必须红。

function paper(overrides: Partial<Paper> & { title: string }): Paper {
  return { ...emptyPaper(), ...overrides };
}

function withHits(hits: 1 | 2 | 3, overrides: Partial<Paper> & { title: string }): Paper {
  const sources = (["openalex", "crossref", "arxiv"] as const).slice(0, hits);
  return paper({ ...overrides, sources: [...sources] });
}

// ─────────────────────────────────────────────────────────────────────────────
describe("① 高被引里程碑：blended 进前 10、hits 沉底（复现 T1 形状）", () => {
  // 里程碑：只被 1 个源收录（真实检索里常见——不是每个源都索引同一篇论文），
  // 但被引 5485（ESMFold 数量级，见 docs/taskbooks/v0.6/T1_protein_structure.md #2）。
  const milestone = withHits(1, {
    title: "Evolutionary-scale prediction of atomic-level protein structure with a language model",
    year: 2023,
    citedByCount: 5485,
  });
  // 12 篇「噪音」：命中 2 个源（比里程碑多），但被引数很低（3~14，远低于里程碑），
  // 年份更新（2024）。真实检索式命中一堆相关但非里程碑的论文正是这个形状。
  const noise = Array.from({ length: 12 }, (_, i) =>
    withHits(2, {
      title: `Noise paper ${i} on protein folding pipelines and benchmarks`,
      year: 2024,
      citedByCount: 3 + i,
    }),
  );
  const all = [milestone, ...noise];

  test("hits 排序（v0.6 原始行为）：里程碑沉到第 10 名之后", () => {
    // dedupePapers 内部固定用 compareMergedPapers 排序——这就是 v0.6 默认行为本身，
    // 不经过本 lane 新加的任何排序层。
    const hitsSorted = dedupePapers(all).papers;
    const pos = hitsSorted.findIndex((p) => p.title === milestone.title);
    expect(pos).toBeGreaterThanOrEqual(10);
  });

  test("blended 排序：里程碑进前 10（实际上排第 1——被引优势远盖过命中源数劣势）", () => {
    const blended = applyRank(all, "blended").papers;
    const pos = blended.findIndex((p) => p.title === milestone.title);
    expect(pos).toBeLessThan(10);
    expect(pos).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 四篇「已知被引数」的论文（100/75/50/0）+ 一篇「缺被引数」——特意用 4 个已知值
// （偶数个）让中位数是两个不同值的平均，不撞到任何一篇论文自己的分数上，
// 避免测试意外依赖 compareMergedPapers 的 tie-break 才能过（那样断言的就不是
// 「中位数代理」本身，而是退化到了另一条不相关的规则）。
const known100 = withHits(2, { title: "Known citation A (100)", year: 2023, citedByCount: 100 });
const known75 = withHits(2, { title: "Known citation B (75)", year: 2023, citedByCount: 75 });
const known50 = withHits(2, { title: "Known citation C (50)", year: 2023, citedByCount: 50 });
const knownZero = withHits(2, { title: "Known zero citation D", year: 2023, citedByCount: 0 });
const missing = withHits(2, { title: "Missing citation data E", year: 2023, citedByCount: null });

describe("② 缺被引数的源退化正确（不当 0 处理）", () => {
  const set = [known100, known75, known50, knownZero, missing];

  test("blended：缺被引数据的论文取本次结果集已知被引的中位数代理——排在『已证实 0 被引』之上，落在中段", () => {
    // 中位数 = mean(citationFactor(50), citationFactor(75))，严格大于
    // citationFactor(0)==1（中性基线）、严格小于 citationFactor(75)，不撞到任何单篇
    // 已知论文自己的分数——完整验证这是一个真正的「中位数代理」，不是巧合的 tie-break。
    const ranked = rankBlended(set);
    const titles = ranked.map((p) => p.title);
    expect(titles).toEqual([known100.title, known75.title, missing.title, known50.title, knownZero.title]);
  });

  test("阴性对照的可观测靶子：若把 missing 当 0 处理，它会跌到 knownZero 那一档（与①的正确全序不同）", () => {
    // 这条不是「拆掉再跑」的阴性对照本身（阴性对照要求真的编辑源码重跑，记录见
    // docs/devlog/W7-B1.md），而是把「当 0 处理」的效果显式算出来，钉住这条判断
    // 确实可证伪——不是随便断言一个总为真的东西。
    const buggyAsZero = rankBlended(set.map((p) => (p.title === missing.title ? { ...p, citedByCount: 0 } : p)));
    const titles = buggyAsZero.map((p) => p.title);
    // 被当 0 处理后 missing 与 knownZero 同分（citationFactor 都是 1，hits/year 也相同），
    // 一起跌到 known50 之后——不再落在 known75/known50 之间。
    expect(titles.slice(0, 3)).toEqual([known100.title, known75.title, known50.title]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("③ --rank 四档各自可解释", () => {
  const citationSet = [known100, known75, known50, knownZero, missing];

  test("citations 档：纯按被引数降序；无被引数据的论文整体退化到 hits 排序，排在已知被引论文之后", () => {
    const ranked = applyRank(citationSet, "citations").papers;
    // 四篇已知被引数据的严格按数值降序；唯一缺数据的那篇排在它们之后。
    expect(ranked.map((p) => p.title)).toEqual([
      known100.title,
      known75.title,
      known50.title,
      knownZero.title,
      missing.title,
    ]);
  });

  const y2020 = withHits(1, { title: "Old paper A", year: 2020 });
  const y2024 = withHits(1, { title: "New paper B", year: 2024 });
  // 命中更多源，但没有年份数据——不该被当成「最老」压到底之外，也不该靠命中源数
  // 把它排到已知年份的论文之前（recent 档的字面意思就是按年份，不是按命中数）。
  const yUnknown = withHits(2, { title: "No year data C", year: null });

  test("recent 档：纯按年份降序；缺年份的论文整体退化到 hits 排序，排在已知年份论文之后", () => {
    const ranked = applyRank([y2020, y2024, yUnknown], "recent").papers;
    expect(ranked.map((p) => p.title)).toEqual([y2024.title, y2020.title, yUnknown.title]);
  });

  test("hits 档：与 --rank blended 在同一输入上给出不同顺序（可解释＝档位真的各干各的事），citations 档与 hits 档在本例中重合但推理路径不同", () => {
    const hitsOrder = dedupePapers(citationSet).papers.map((p) => p.title);
    const citationsOrder = applyRank(citationSet, "citations").papers.map((p) => p.title);
    const blendedOrder = applyRank(citationSet, "blended").papers.map((p) => p.title);
    // hits 档：五篇命中源数相同（都是 2），tie-break 落到 citedByCount（null 当 -1）→
    // 100 > 75 > 50 > 0 > missing——数值上与 citations 档巧合一致（因为 hits 全平），
    // 但 blended 档因为退化用中位数代理，missing 会插到 known75/known50 之间：
    // 三档里 blended 是唯一一个给出不同顺序的，证明排序依据真的各不相同。
    expect(hitsOrder).toEqual([known100.title, known75.title, known50.title, knownZero.title, missing.title]);
    expect(citationsOrder).toEqual(hitsOrder);
    expect(blendedOrder).not.toEqual(hitsOrder);
    expect(blendedOrder[2]).toBe(missing.title);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("④ note 含排序依据（AD-12：结果怎么来的要可见）", () => {
  const sample = [withHits(1, { title: "Sample", year: 2023, citedByCount: 5 })];

  for (const mode of RANK_MODES) {
    test(`--rank ${mode} 的 note 非空且能认出是这一档`, () => {
      const { note } = applyRank(sample, mode);
      expect(note.length).toBeGreaterThan(0);
      expect(note).toContain(mode);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe("--rank hits 与 v0.6 原始行为逐字节一致（回归钉子）", () => {
  test("applyRank(..., \"hits\") 原样返回 dedupePapers 的输出，不重新排序", () => {
    const milestone = withHits(1, { title: "Milestone", year: 2023, citedByCount: 5485 });
    const noise = Array.from({ length: 5 }, (_, i) =>
      withHits(2, { title: `Noise ${i}`, year: 2024, citedByCount: 3 + i }),
    );
    const viaDedupe = dedupePapers([milestone, ...noise]).papers;
    const { papers: viaHitsRank } = applyRank(viaDedupe, "hits");
    // 同一个数组引用——不是「排出来结果一样」，是压根没有重新 sort 过。
    expect(viaHitsRank).toBe(viaDedupe);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("CLI：--rank 解析、透传给 searcher、note 打印到输出", () => {
  function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), "v67-ranking-cli-"));
  }

  function fakeResult(overrides: Partial<LiteratureSearchResult> = {}): LiteratureSearchResult {
    return {
      query: "q",
      papers: [],
      sources: [],
      totalBeforeDedupe: 0,
      mergedCount: 0,
      rank: "citations",
      rankNote: "排序依据: citations（测试桩）",
      ...overrides,
    };
  }

  test("--rank citations 透传进 LiteratureSearchOptions，且结果头打印 rankNote", async () => {
    let capturedRank: RankMode | undefined;
    const searcher = {
      search: async (_query: string, options: { rank?: RankMode }) => {
        capturedRank = options.rank;
        return fakeResult();
      },
      fetchById: async () => fakeResult(),
    } as never;
    const out: string[] = [];
    const code = await runLitCommand(["search", "quantum", "computing", "--rank", "citations"], {
      root: tmpRoot(),
      searcher,
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(capturedRank).toBe("citations");
    expect(out.join("\n")).toContain("排序依据: citations（测试桩）");
  });

  test("不给 --rank 时默认透传 blended", async () => {
    let capturedRank: RankMode | undefined;
    const searcher = {
      search: async (_query: string, options: { rank?: RankMode }) => {
        capturedRank = options.rank;
        return fakeResult({ rank: "blended", rankNote: "排序依据: blended（测试桩）" });
      },
      fetchById: async () => fakeResult(),
    } as never;
    const code = await runLitCommand(["search", "quantum"], {
      root: tmpRoot(),
      searcher,
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(0);
    expect(capturedRank).toBe("blended");
  });

  test("未知 --rank 档位：拒绝并列出可选项，不发起检索", async () => {
    let searchCalled = false;
    const searcher = {
      search: async () => {
        searchCalled = true;
        return fakeResult();
      },
      fetchById: async () => fakeResult(),
    } as never;
    const err: string[] = [];
    const code = await runLitCommand(["search", "quantum", "--rank", "popularity"], {
      root: tmpRoot(),
      searcher,
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(searchCalled).toBe(false);
    const text = err.join("\n");
    expect(text).toContain("未知排序档位");
    for (const mode of RANK_MODES) expect(text).toContain(mode);
  });
});
