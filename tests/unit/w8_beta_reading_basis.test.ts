// v0.8 W8-1 β · V98：`cardFromRecord()` 此前从没把 `persist()` 早就写进 metadata 的
// `basis`/`basisReason` 读回来——`listReadingCards()` 拿到的卡片永远 basis===undefined，
// `cardBaselineText()`（唯一读到卡片文本的 judge 入口，review.ts 的
// `summary: cardBaselineText(card)`）也就永远不带「全文/仅摘要」标注。
//
// 覆盖两件事：
//   1. 端到端：record 带 basis（全文成功 / 降级回摘要两种）→ listReadingCards() 读回的
//      卡片 basis/basisReason 都在。
//   2. cardBaselineText() 的输出文本按 basis 标注，且老卡片（无 basis 字段）不受影响。
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ReadingCardGenerator, cardBaselineText, listReadingCards } from "../../backend/src/literature/reading";
import { FakeLlm, cardJson, makeProjectWithPapers, type Fixture } from "../helpers/review_scenario";

let fx: Fixture | null = null;
function fixture(n = 2): Fixture {
  fx = makeProjectWithPapers(n);
  return fx;
}
afterEach(() => {
  if (fx) {
    fx.library.close();
    fx.project.close();
    rmSync(fx.root, { recursive: true, force: true });
    fx = null;
  }
});

describe("V98 · basis 端到端回读（generate → persist → listReadingCards → cardFromRecord）", () => {
  test("全文抽取成功：卡片 basis='fulltext'，无 basisReason", async () => {
    const { project, library, paperIds } = fixture(1);
    const records = project.records();
    const generator = new ReadingCardGenerator({
      llm: new FakeLlm([cardJson()]),
      library,
      records,
      fullTextFor: async () => ({ ok: true, text: "这是抽取到的全文正文。" }),
    });
    await generator.generate(paperIds[0]!);

    const cards = listReadingCards(records, library);
    expect(cards.length).toBe(1);
    expect(cards[0]!.basis).toBe("fulltext");
    expect(cards[0]!.basisReason).toBeUndefined();
  });

  test("全文抽取失败降级：卡片 basis='abstract'，basisReason 带着降级原因", async () => {
    const { project, library, paperIds } = fixture(1);
    const records = project.records();
    const generator = new ReadingCardGenerator({
      llm: new FakeLlm([cardJson()]),
      library,
      records,
      fullTextFor: async () => ({ ok: false, reason: "PDF 抽取失败：加密文档" }),
    });
    await generator.generate(paperIds[0]!);

    const cards = listReadingCards(records, library);
    expect(cards.length).toBe(1);
    expect(cards[0]!.basis).toBe("abstract");
    expect(cards[0]!.basisReason).toBe("PDF 抽取失败：加密文档");
  });

  test("不注入 fullTextFor（老行为）：basis='abstract'，basisReason 缺省", async () => {
    const { project, library, paperIds } = fixture(1);
    const records = project.records();
    const generator = new ReadingCardGenerator({ llm: new FakeLlm([cardJson()]), library, records });
    await generator.generate(paperIds[0]!);

    const cards = listReadingCards(records, library);
    expect(cards[0]!.basis).toBe("abstract");
    expect(cards[0]!.basisReason).toBeUndefined();
  });
});

describe("V98 · cardBaselineText() 按 basis 标注，供 judge 使用", () => {
  const base = {
    paperId: "p",
    bibtexKey: "jumper2021paper",
    title: "T",
    researchQuestion: "Q",
    methods: "M",
    keyFindings: ["F1"],
    limitations: [] as string[],
    relationToProject: "推断，不应出现在 baseline 里",
  };

  test("basis='fulltext'：文本以「依据: 全文」开头", () => {
    const text = cardBaselineText({ ...base, basis: "fulltext" });
    expect(text.split("\n")[0]).toBe("依据: 全文");
    expect(text).toContain("F1");
    expect(text).not.toContain("推断，不应出现在 baseline 里");
  });

  test("basis='abstract' 带 basisReason：标注里带上降级原因", () => {
    const text = cardBaselineText({ ...base, basis: "abstract", basisReason: "PDF 抽取失败：加密文档" });
    expect(text.split("\n")[0]).toBe("依据: 仅摘要（PDF 抽取失败：加密文档）");
  });

  test("basis='abstract' 不带 basisReason：标注不带括号原因", () => {
    const text = cardBaselineText({ ...base, basis: "abstract" });
    expect(text.split("\n")[0]).toBe("依据: 仅摘要");
  });

  test("老卡片（没有 basis 字段，纯 ReadingCard）：不加标注行，逐字节兼容既有行为", () => {
    const text = cardBaselineText(base);
    expect(text.split("\n")[0]).toBe("研究问题: Q");
    expect(text).not.toContain("依据:");
  });
});
