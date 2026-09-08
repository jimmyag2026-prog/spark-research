import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runLitCommand } from "../../backend/src/literature/cli";
import { ReadingCardGenerator } from "../../backend/src/literature/reading";
import { ReviewDraftError, ReviewDraftGenerator, baselinesFrom, buildReviewPrompt } from "../../backend/src/literature/review";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import { FakeJudge, FakeLlm, cardJson, makeProjectWithPapers, type Fixture } from "../helpers/review_scenario";

// 综述草稿生成单测（P3 交付物 2）+ CLI（交付物 5）。LLM 全部注入 fake。

let fx: Fixture | null = null;

afterEach(() => {
  if (fx) {
    fx.library.close();
    fx.project.close();
    rmSync(fx.root, { recursive: true, force: true });
    fx = null;
  }
});

// 建库 → 为每篇生成精读卡 → 返回卡片
async function withCards(n = 3) {
  fx = makeProjectWithPapers(n);
  const records = fx.project.records();
  const generator = new ReadingCardGenerator({
    llm: new FakeLlm([cardJson()]),
    library: fx.library,
    records,
  });
  const cards = [];
  for (const id of fx.paperIds) cards.push((await generator.generate(id)).card);
  return { fx: fx!, records, cards };
}

describe("综述 prompt", () => {
  test("白名单里只有精读卡对应的 key，且卡片内容全部进 prompt", async () => {
    const { cards } = await withCards(2);
    const prompt = buildReviewPrompt(cards, "蛋白结构预测");
    expect(prompt).toContain("蛋白结构预测");
    expect(prompt).toContain("可用引用 key 白名单");
    for (const card of cards) {
      expect(prompt).toContain(`[@${card.bibtexKey}]`);
      expect(prompt).toContain(card.researchQuestion);
      expect(prompt).toContain(card.keyFindings[0]!);
    }
  });
});

describe("ReviewDraftGenerator", () => {
  test("生成草稿 → artifact + record → cites/derives_from 边入证据图", async () => {
    const { fx, records, cards } = await withCards(2);
    const draftBody = `## 研究现状\n工作一取得进展[@${cards[0]!.bibtexKey}]，工作二给出另一路线[@${cards[1]!.bibtexKey}]。`;
    const generator = new ReviewDraftGenerator({
      llm: new FakeLlm([draftBody]),
      library: fx.library,
      records,
      artifacts: fx.project.artifacts(),
      workDir: fx.project.paths.artifactsDir,
    });

    const result = await generator.generate(cards, { topic: "结构预测", sessionId: "s1" });

    expect(result.attempts).toBe(1);
    expect(result.citedKeys.sort()).toEqual([cards[0]!.bibtexKey, cards[1]!.bibtexKey].sort());
    expect(result.unknownKeys).toHaveLength(0);
    expect(existsSync(result.path!)).toBe(true);
    // 参考文献区由库内真实条目生成
    expect(result.markdown).toContain("## 参考文献");
    expect(result.markdown).toContain("doi:10.1000/p3.1");

    const record = records.get(result.recordId!)!;
    expect(record.type).toBe("artifact");
    expect(record.artifactId).toBe(result.artifactId);
    expect(record.evidence).toBe("inferred");
    expect(record.metadata.kind).toBe("review_draft");
    expect(record.metadata.citedKeys).toEqual(result.citedKeys);

    const outgoing = records.edgesOf(result.recordId!).outgoing;
    // 每张卡片一条 derives_from
    expect(outgoing.filter((e) => e.type === "derives_from")).toHaveLength(2);
    // 每个被引 key 一条 cites，指向 paper record
    const paperRecordIds = fx.paperIds.map((id) => fx.library.get(id)!.recordId);
    const cites = outgoing.filter((e) => e.type === "cites");
    expect(cites).toHaveLength(2);
    expect(cites.every((e) => paperRecordIds.includes(e.targetId))).toBe(true);
  });

  test("越界 key → 带越界清单重试一次；第二稿合规则通过", async () => {
    const { fx, records, cards } = await withCards(2);
    const llm = new FakeLlm([
      `工作一[@${cards[0]!.bibtexKey}]，另有[@ghost2019fake]。`,
      `工作一[@${cards[0]!.bibtexKey}]。`,
    ]);
    const generator = new ReviewDraftGenerator({ llm, library: fx.library, records });

    const result = await generator.generate(cards, { topic: "t" });

    expect(result.attempts).toBe(2);
    expect(result.citedKeys).toEqual([cards[0]!.bibtexKey]);
    expect(llm.lastUserPrompt).toContain("ghost2019fake");
    expect(llm.lastUserPrompt).toContain("不要换个 key 硬凑");
  });

  test("重试后仍越界 → 抛错、不落 artifact/record（不生产已知带假引用的产物）", async () => {
    const { fx, records, cards } = await withCards(2);
    const before = records.count();
    const generator = new ReviewDraftGenerator({
      llm: new FakeLlm([`引用[@ghost2019fake]。`]),
      library: fx.library,
      records,
      artifacts: fx.project.artifacts(),
    });

    let error: unknown;
    try {
      await generator.generate(cards, { topic: "t" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReviewDraftError);
    expect((error as ReviewDraftError).unknownKeys).toEqual(["ghost2019fake"]);
    expect((error as Error).message).toContain("原始输出");
    expect(records.count()).toBe(before);
  });

  test("allowUnknownKeys=true 时放行（对抗测试与「交给检查器兜底」场景）", async () => {
    const { fx, records, cards } = await withCards(2);
    const generator = new ReviewDraftGenerator({
      llm: new FakeLlm([`引用[@ghost2019fake]。`]),
      library: fx.library,
      records,
    });
    const result = await generator.generate(cards, { allowUnknownKeys: true });
    expect(result.unknownKeys).toEqual(["ghost2019fake"]);
    expect(result.attempts).toBe(1);
  });

  test("空草稿 / 无引用草稿 → 重试后报错", async () => {
    const { fx, cards } = await withCards(2);
    await expect(
      new ReviewDraftGenerator({ llm: new FakeLlm([""]), library: fx.library }).generate(cards),
    ).rejects.toThrow(/空内容|不合格/);
    await expect(
      new ReviewDraftGenerator({ llm: new FakeLlm(["一段没有任何引用的正文。"]), library: fx.library }).generate(cards),
    ).rejects.toThrow(/没有任何 \[@key\] 引用/);
  });

  test("没有精读卡 → 直接报错并给出下一步指令", async () => {
    fx = makeProjectWithPapers(1);
    await expect(
      new ReviewDraftGenerator({ llm: new FakeLlm(["x"]), library: fx.library }).generate([]),
    ).rejects.toThrow(/lit read/);
  });

  test("卡片对应的论文已被移出库 → 拒绝生成（key 会指向不存在的文献）", async () => {
    const { fx, cards } = await withCards(2);
    fx.library.remove(cards[0]!.paperId);
    await expect(
      new ReviewDraftGenerator({ llm: new FakeLlm(["x"]), library: fx.library }).generate(cards),
    ).rejects.toThrow(/已不在库内/);
  });

  test("baselinesFrom 用当前 key 建索引，摘要来自精读卡", async () => {
    const { cards } = await withCards(2);
    const baselines = baselinesFrom(cards);
    expect([...baselines.keys()].sort()).toEqual(cards.map((c) => c.bibtexKey).sort());
    expect(baselines.get(cards[0]!.bibtexKey)!.summary).toContain(cards[0]!.keyFindings[0]!);
  });
});

describe("CLI: lit read / lit review", () => {
  test("lit read <id> 生成卡片并打印 record；lit read --all 批量", async () => {
    fx = makeProjectWithPapers(3, "cli-read");
    fx.library.close();
    fx.project.close();
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      manager: fx.manager,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      llm: new FakeLlm([cardJson()]),
    };

    expect(await runLitCommand(["read", fx.paperIds[0]!.slice(0, 8)], deps)).toBe(0);
    expect(out.join("\n")).toContain("精读卡");
    expect(out.join("\n")).toContain("✅ 生成 1 张精读卡");

    out.length = 0;
    expect(await runLitCommand(["read", "--all"], deps)).toBe(0);
    expect(out.join("\n")).toContain("✅ 生成 3 张精读卡");
  });

  test("lit read 错误路径：缺参数 / 库外 id / 生成失败如实报错", async () => {
    fx = makeProjectWithPapers(1, "cli-read-err");
    fx.library.close();
    fx.project.close();
    const out: string[] = [];
    const err: string[] = [];
    const base = { manager: fx.manager, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

    expect(await runLitCommand(["read"], { ...base, llm: new FakeLlm([cardJson()]) })).toBe(1);
    expect(err.join("\n")).toContain("用法");
    expect(await runLitCommand(["read", "nope"], { ...base, llm: new FakeLlm([cardJson()]) })).toBe(1);
    expect(err.join("\n")).toContain("不在库中");

    err.length = 0;
    // 全部失败 → 退出码 1，且失败原因必须出现在 stderr（不能被「成功 0 张」盖过去）
    expect(await runLitCommand(["read", "--all"], { ...base, llm: new FakeLlm(["坏输出"]) })).toBe(1);
    expect(err.join("\n")).toContain("精读卡生成失败");
  });

  test("lit review 全流程：草稿落 artifact + 跑 citation-integrity + --out 落盘", async () => {
    const { fx: f, cards } = await withCards(2);
    const keys = libraryKeyIndex(f.library.list()).keys;
    f.library.close();
    f.project.close();

    const out: string[] = [];
    const err: string[] = [];
    const target = join(f.root, "review.md");
    const code = await runLitCommand(["review", "--topic", "结构预测", "--out", target], {
      manager: f.manager,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      llm: new FakeLlm([`## 研究现状\n工作一[@${keys[0]}]，工作二[@${keys[1]}]。`]),
      judge: new FakeJudge(),
    });

    expect(code).toBe(0);
    const output = out.join("\n");
    expect(output).toContain("综述草稿已生成");
    expect(output).toContain("citation-integrity");
    expect(output).toContain("无 hard finding");
    expect(readFileSync(target, "utf8")).toContain("## 参考文献");
    expect(cards.length).toBe(2);
  });

  test("lit review 抓到伪造引用 → 退出码 1 + veto 提示", async () => {
    const { fx: f } = await withCards(2);
    const keys = libraryKeyIndex(f.library.list()).keys;
    f.library.close();
    f.project.close();

    const out: string[] = [];
    const err: string[] = [];
    // 生成器两稿都越界 → 抛 ReviewDraftError，CLI 如实报错并返回 1
    const code = await runLitCommand(["review", "--no-judge"], {
      manager: f.manager,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      llm: new FakeLlm([`工作一[@${keys[0]}] 与 [@ghost2019fake]。`]),
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("ghost2019fake");
  });

  test("lit review 在没有精读卡时给出明确的下一步", async () => {
    fx = makeProjectWithPapers(2, "cli-review-empty");
    fx.library.close();
    fx.project.close();
    const err: string[] = [];
    const code = await runLitCommand(["review"], {
      manager: fx.manager,
      out: () => {},
      err: (l: string) => err.push(l),
      llm: new FakeLlm(["x"]),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("lit read");
  });

  test("帮助里列出 read / review", async () => {
    const out: string[] = [];
    await runLitCommand(["help"], { root: makeProjectWithPapers(0, "help-only").root, out: (l) => out.push(l) });
    expect(out.join("\n")).toContain("lit read");
    expect(out.join("\n")).toContain("lit review");
  });
});
