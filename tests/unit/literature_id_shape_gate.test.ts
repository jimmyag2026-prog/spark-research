import { describe, expect, test } from "bun:test";
import { SHAPE_SOURCES, classifyIdentifier } from "../../backend/src/literature/cli";
import { DEFAULT_SEARCH_SOURCES, type LiteratureSource } from "../../backend/src/literature/models";

// S1（v0.5 W5-2 末的零上下文外部验收，主会话已实机复现）：
//
//   $ lit add 9999.99999          ← 一个不存在的 arXiv id
//   ✅ 已入库  [c0093cc5] Intravenous nitroglycerin   ← 1978 年，与用户要的毫无关系
//   EXIT=0
//
// 真因：`fetchOne()` 里是一张**写死的三源白名单**（crossref/openalex/biorxiv），
// 其余源一律把原始 id 透传给连接器；pubmed 的 eutils 把 `9999.99999` 宽容解析成
// PMID 9999，于是取回一篇毫不相干的论文并报成功。
//
// 这比「静默返回空」更糟一档：不是「没查到」被报成「查了没有」，
// 而是**「没查到」被报成「查到了，给你另一篇」**——垃圾论文以 paper record 落进证据图、
// 被 `lit read` 花真钱生成精读卡、并列进 `report export` 的参考文献，
// 而 `citation-integrity`（引用必须在库内）会**全部放行**，因为它们确实在库内。
//
// 这份测试盯住两件事：判定必须来自 SHAPE_SOURCES 单一真源；以及那几个具体的现场不许复发。

describe("S1 · 标识符形态门（不许把一种 id 降级成另一种去撞库）", () => {
  test("形态判定与能力表是同一份真源（search.ts 不许再写第二份白名单）", () => {
    // 只要 SHAPE_SOURCES 是被 search.ts import 的那一份，这条就成立；
    // 这里额外钉住表本身的正确性——pubmed 不许出现在 doi / arxiv 形态里。
    expect(SHAPE_SOURCES.arxiv).not.toContain("pubmed");
    expect(SHAPE_SOURCES.doi).not.toContain("pubmed");
    expect(SHAPE_SOURCES.pmid).toContain("pubmed");
  });

  test("外部验收抓到的三个现场，形态判定必须正确", () => {
    // `9999.99999` 是合法的 arXiv id 形态（只是这篇不存在），**不是** PMID。
    expect(classifyIdentifier("9999.99999")).toBe("arxiv");
    expect(classifyIdentifier("10.1234/this-doi-does-not-exist-xyz")).toBe("doi");
    // 纯数字确实是 PMID——`lit add 99999` 取回 PMID 99999 是**正确**行为，
    // 原来的 bug 是 `9999.99999` 也走到了那条路上。
    expect(classifyIdentifier("99999")).toBe("pmid");
  });

  test("能解析 arxiv 形态的源里不含任何会「宽容解析」数字的源", () => {
    // 反向断言：默认集里每一个不在 SHAPE_SOURCES.arxiv 里的源，
    // 都必须在 arxiv 形态下被跳过——这正是 S1 的修法。
    const shape = classifyIdentifier("9999.99999");
    const capable = SHAPE_SOURCES[shape];
    const skipped = DEFAULT_SEARCH_SOURCES.filter((s) => !capable.includes(s));
    expect(skipped).toContain("pubmed");
    expect(skipped).toContain("europepmc");
    expect(skipped.length).toBeGreaterThan(0);
  });

  test("形态未知时不拦：可能仍被某个源认得（如 semanticscholar 的 CorpusId）", () => {
    expect(classifyIdentifier("totally-not-an-id")).toBe("unknown");
    expect(SHAPE_SOURCES.unknown).toEqual([]);
    // 未知形态走「全查一遍再如实分类失败原因」那条路（验收报告称其为全场最佳消息），
    // 而不是在这里被静默拦掉——拦掉会把一条能用的路堵死。
  });
});
