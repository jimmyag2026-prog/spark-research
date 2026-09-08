import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  ReadingCardError,
  ReadingCardGenerator,
  cardBaselineText,
  extractJsonObject,
  listReadingCards,
  renderReadingCard,
  validateReadingCardPayload,
} from "../../backend/src/literature/reading";
import { FakeLlm, cardJson, makeProjectWithPapers, type Fixture } from "../helpers/review_scenario";

// 精读卡 pipeline 单测（P3 交付物 1）。LLM 全部注入 fake，零网络。

let fx: Fixture | null = null;

function fixture(n = 3): Fixture {
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

describe("精读卡 schema 校验", () => {
  test("合法 payload 通过并 trim 字段", () => {
    const result = validateReadingCardPayload(JSON.parse(cardJson({ researchQuestion: "  问题  " })));
    expect(result.ok).toBe(true);
    expect(result.fields!.researchQuestion).toBe("问题");
  });

  test("缺字段 / 空字段 / 类型错都被拒，并逐条给出原因", () => {
    const cases: Array<[unknown, string]> = [
      [JSON.parse(cardJson({ researchQuestion: "" })), "researchQuestion"],
      [JSON.parse(cardJson({ methods: undefined as unknown as string })), "methods"],
      [JSON.parse(cardJson({ keyFindings: [] })), "keyFindings"],
      [JSON.parse(cardJson({ keyFindings: "一条结论" as unknown as string[] })), "keyFindings"],
      [JSON.parse(cardJson({ limitations: "无" as unknown as string[] })), "limitations"],
      [JSON.parse(cardJson({ relationToProject: "   " })), "relationToProject"],
    ];
    for (const [payload, field] of cases) {
      const result = validateReadingCardPayload(payload);
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain(field);
    }
  });

  test("非对象输入直接拒", () => {
    for (const payload of [undefined, null, "文本", 42, ["a"]]) {
      expect(validateReadingCardPayload(payload).ok).toBe(false);
    }
  });

  test("limitations 可以是空数组（论文确实没写局限）", () => {
    expect(validateReadingCardPayload(JSON.parse(cardJson({ limitations: [] }))).ok).toBe(true);
  });
});

describe("extractJsonObject", () => {
  test("裸 JSON / ```json 围栏 / 前后夹带解释文字都能取出", () => {
    const raw = cardJson();
    expect(extractJsonObject(raw)).toBeDefined();
    expect(extractJsonObject("```json\n" + raw + "\n```")).toBeDefined();
    expect(extractJsonObject("好的，这是卡片：\n" + raw + "\n希望有帮助")).toBeDefined();
  });

  test("取不出 JSON 时返回 undefined 而不是抛错", () => {
    expect(extractJsonObject("完全没有 JSON")).toBeUndefined();
    expect(extractJsonObject("{ 坏掉的 json ")).toBeUndefined();
  });
});

describe("ReadingCardGenerator", () => {
  test("生成卡片 → 落 record → cites 边连到 paper record → 阅读状态推进", async () => {
    const { project, library, paperIds, keyOf } = fixture();
    const llm = new FakeLlm([cardJson()]);
    const records = project.records();
    const generator = new ReadingCardGenerator({ llm, library, records, projectContext: "蛋白结构预测" });

    const { card, attempts } = await generator.generate(paperIds[0]!, { sessionId: "s1" });

    expect(attempts).toBe(1);
    expect(card.paperId).toBe(paperIds[0]!);
    expect(card.bibtexKey).toBe(keyOf(paperIds[0]!));
    expect(card.keyFindings.length).toBeGreaterThan(0);

    const record = records.get(card.recordId)!;
    expect(record.type).toBe("observation");
    expect(record.evidence).toBe("sourced");
    expect(record.metadata.kind).toBe("reading_card");
    expect(record.metadata.libraryPaperId).toBe(paperIds[0]!);
    expect(record.metadata.inferredFields).toEqual(["relationToProject"]);
    expect(record.origin.sessionId).toBe("s1");

    // 证据图：卡片 --cites--> paper record
    const paperRecordId = library.get(paperIds[0]!)!.recordId!;
    const edges = records.edgesOf(card.recordId).outgoing;
    expect(edges.some((e) => e.targetId === paperRecordId && e.type === "cites")).toBe(true);

    expect(library.get(paperIds[0]!)!.readingStatus).toBe("read");

    // prompt 里带了论文元数据与项目背景，且要求 JSON
    const prompt = llm.lastUserPrompt;
    expect(prompt).toContain("Paper 1 on protein structure prediction");
    expect(prompt).toContain("蛋白结构预测");
  });

  test("非法输出重试一次；第二次合法则成功，并把校验失败原因回灌给模型", async () => {
    const { project, library, paperIds } = fixture();
    const llm = new FakeLlm(["这不是 JSON", cardJson()]);
    const generator = new ReadingCardGenerator({ llm, library, records: project.records() });

    const { card, attempts } = await generator.generate(paperIds[0]!);

    expect(attempts).toBe(2);
    expect(llm.calls.length).toBe(2);
    expect(llm.lastUserPrompt).toContain("校验失败原因");
    expect(card.recordId).toBeTruthy();
  });

  test("重试后仍非法 → 抛错、如实带上校验原因与原始输出片段，且不落 record", async () => {
    const { project, library, paperIds } = fixture();
    const records = project.records();
    const before = records.count();
    const llm = new FakeLlm([cardJson({ keyFindings: [] })]);
    const generator = new ReadingCardGenerator({ llm, library, records });

    let error: unknown;
    try {
      await generator.generate(paperIds[0]!);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ReadingCardError);
    const err = error as ReadingCardError;
    expect(err.attempts).toBe(2);
    expect(err.validationErrors.join(" ")).toContain("keyFindings");
    expect(err.message).toContain("原始输出");
    expect(llm.calls.length).toBe(2);
    expect(records.count()).toBe(before);
    // 失败不该把论文标成已读
    expect(library.get(paperIds[0]!)!.readingStatus).toBe("unread");
  });

  test("模型调用失败（ok=false）同样重试一次后如实报错", async () => {
    const { project, library, paperIds } = fixture();
    const llm = new FakeLlm([{ ok: false, content: "[error] No API key configured." }]);
    const generator = new ReadingCardGenerator({ llm, library, records: project.records() });

    await expect(generator.generate(paperIds[0]!)).rejects.toThrow(/No API key configured/);
    expect(llm.calls.length).toBe(2);
  });

  test("库外论文直接拒绝（卡片必须锚在库内论文上）", async () => {
    const { project, library } = fixture();
    const generator = new ReadingCardGenerator({
      llm: new FakeLlm([cardJson()]),
      library,
      records: project.records(),
    });
    await expect(generator.generate("not-in-library")).rejects.toThrow(/不在项目文献库/);
  });

  test("generateMany 逐篇独立结算：一篇失败不影响其余，失败如实返回", async () => {
    const { project, library, paperIds } = fixture(3);
    // 第 1 篇成功；第 2 篇两次都非法 → 失败；第 3 篇成功
    const llm = new FakeLlm([cardJson(), "坏输出", "还是坏输出", cardJson(), cardJson()]);
    const generator = new ReadingCardGenerator({ llm, library, records: project.records() });

    const { cards, failures } = await generator.generateMany(paperIds);

    expect(cards.length).toBe(2);
    expect(failures.length).toBe(1);
    expect(failures[0]!.paperId).toBe(paperIds[1]!);
    expect(failures[0]!.error).toContain("ReadingCard");
  });
});

describe("卡片读取与渲染", () => {
  test("listReadingCards 取回卡片、每篇只留最新一张、key 按当前库重算", async () => {
    const { project, library, paperIds, keyOf } = fixture(2);
    const records = project.records();
    const generator = new ReadingCardGenerator({
      llm: new FakeLlm([cardJson(), cardJson({ researchQuestion: "第二版问题" })]),
      library,
      records,
    });
    await generator.generate(paperIds[0]!);
    await generator.generate(paperIds[0]!); // 同一篇再生成一次

    const cards = listReadingCards(records, library);
    expect(cards.length).toBe(1);
    expect(cards[0]!.researchQuestion).toBe("第二版问题");
    expect(cards[0]!.bibtexKey).toBe(keyOf(paperIds[0]!));
  });

  test("论文被移出库后，其残留卡片不再参与综述", async () => {
    const { project, library, paperIds } = fixture(2);
    const records = project.records();
    const generator = new ReadingCardGenerator({
      llm: new FakeLlm([cardJson()]),
      library,
      records,
    });
    await generator.generate(paperIds[0]!);
    expect(listReadingCards(records, library).length).toBe(1);

    library.remove(paperIds[0]!);
    expect(listReadingCards(records, library).length).toBe(0);
  });

  test("renderReadingCard 输出五个小节；cardBaselineText 不含推断字段", () => {
    const card = {
      paperId: "p",
      bibtexKey: "jumper2021paper",
      title: "T",
      researchQuestion: "Q",
      methods: "M",
      keyFindings: ["F1", "F2"],
      limitations: [],
      relationToProject: "只对本项目的推断",
    };
    const rendered = renderReadingCard(card);
    for (const section of ["研究问题", "方法", "核心结论", "局限", "与本项目的关系"]) {
      expect(rendered).toContain(section);
    }
    expect(rendered).toContain("[@jumper2021paper]");
    expect(rendered).toContain("- （未提及）"); // 空 limitations 显式标注

    const baseline = cardBaselineText(card);
    expect(baseline).toContain("F1");
    // 对照基准不能含「与本项目关系」——那是推断，拿它判引用冲突会误判
    expect(baseline).not.toContain("只对本项目的推断");
  });
});
