import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  CoExploreSession,
  buildCoExplorePrompt,
  groundingCheck,
  isMarkedInferred,
  loadCoExplorePrompt,
} from "../../backend/src/ideation/coexplore";
import {
  renderIdeaCard,
  statusFromRatings,
  validateEvidenceList,
  validateIdeaCardPayload,
} from "../../backend/src/ideation/models";
import { IdeaStore } from "../../backend/src/ideation/store";
import { FakeLlm, makeProjectWithPapers } from "../helpers/review_scenario";

// P4 · Co-explore 与思路库单测。所有 LLM 调用注入 fake，零网络。

const roots: string[] = [];

function fixture(slug: string) {
  const f = makeProjectWithPapers(3, slug);
  roots.push(f.root);
  return f;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function cardJson(keys: string[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    critique: `你的假设默认了折叠精度可以外推到复合物[@${keys[0]}]，但这一步没有证据支撑（inferred）。`,
    hypothesis: "端到端结构预测模型可以在无模板情况下达到实验级精度",
    supporting: [{ key: keys[0], note: "该工作在单链上达到可用精度" }],
    contradicting: [{ key: keys[1], note: "该工作指出跨物种数据上未验证" }],
    openQuestions: ["复合物界面上的精度是否同样成立"],
    ...overrides,
  });
}

describe("idea 卡 schema 校验", () => {
  const known = new Set(["a2020x", "b2021y"]);

  test("合法 payload 通过并归一化字段", () => {
    const result = validateIdeaCardPayload(JSON.parse(cardJson(["a2020x", "b2021y"])), { knownKeys: known });
    expect(result.ok).toBe(true);
    expect(result.fields!.supporting[0]!.key).toBe("a2020x");
    expect(result.fields!.contradicting[0]!.inferred).toBe(false);
    expect(result.fields!.openQuestions).toHaveLength(1);
  });

  test("缺 contradicting 直接不合格——共探不许只顺着说", () => {
    const result = validateIdeaCardPayload(
      JSON.parse(cardJson(["a2020x", "b2021y"], { contradicting: [] })),
      { knownKeys: known },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("至少要有 1 条反对");
  });

  test("库外 key 被当成伪造引用挡下（不是悄悄丢掉）", () => {
    const result = validateIdeaCardPayload(
      JSON.parse(cardJson(["a2020x", "b2021y"], { supporting: [{ key: "vaswani2017attention", note: "x" }] })),
      { knownKeys: known },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("vaswani2017attention");
  });

  test("没有 key 又没标 inferred 的证据不合格", () => {
    const result = validateEvidenceList([{ note: "凭印象觉得如此" }], "supporting", known);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("inferred");
  });

  test("显式标 inferred 的证据合法且 key 为 null", () => {
    const result = validateEvidenceList([{ note: "机制上讲不通", inferred: true }], "contradicting", known);
    expect(result.ok).toBe(true);
    expect(result.items[0]).toEqual({ key: null, note: "机制上讲不通", inferred: true });
  });

  test("整张卡全是 inferred（库非空时）不合格", () => {
    const result = validateIdeaCardPayload(
      JSON.parse(
        cardJson(["a2020x", "b2021y"], {
          supporting: [{ note: "直觉", inferred: true }],
          contradicting: [{ note: "另一个直觉", inferred: true }],
        }),
      ),
      { knownKeys: known },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("没有任何库内文献支撑");
  });

  test("库为空时允许全 inferred（但仍要有反对证据）", () => {
    const empty = validateIdeaCardPayload(
      JSON.parse(
        cardJson([], {
          supporting: [],
          contradicting: [{ note: "机制上讲不通", inferred: true }],
          critique: "库里没有文献，以下全部是推断（inferred）。",
        }),
      ),
      { knownKeys: [] },
    );
    expect(empty.ok).toBe(true);
  });

  test("openQuestions 为空不合格", () => {
    const result = validateIdeaCardPayload(
      JSON.parse(cardJson(["a2020x", "b2021y"], { openQuestions: [] })),
      { knownKeys: known },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("openQuestions");
  });

  test("非对象输入直接失败", () => {
    expect(validateIdeaCardPayload("不是对象", { knownKeys: known }).ok).toBe(false);
    expect(validateIdeaCardPayload(["数组"], { knownKeys: known }).ok).toBe(false);
  });
});

describe("grounding 检查", () => {
  test("识别库外引用", () => {
    const report = groundingCheck("这一点已有工作证实[@real2020a]，另一处引了[@fake2019b]。", ["real2020a"]);
    expect(report.unknownKeys).toEqual(["fake2019b"]);
  });

  test("强断言无引用也无 inferred 标记 → 记一条未落地断言", () => {
    const report = groundingCheck("该方法显著优于所有基线。", ["real2020a"]);
    expect(report.ungroundedClaims).toHaveLength(1);
  });

  test("强断言显式标了 inferred 就不算未落地", () => {
    const report = groundingCheck("该方法显著优于所有基线（inferred）。", ["real2020a"]);
    expect(report.ungroundedClaims).toHaveLength(0);
    expect(isMarkedInferred("这是推断（推断）")).toBe(true);
  });

  test("带引用的强断言不算未落地", () => {
    const report = groundingCheck("该方法显著优于所有基线[@real2020a]。", ["real2020a"]);
    expect(report.ungroundedClaims).toHaveLength(0);
  });
});

describe("Co-explore 会话", () => {
  test("prompt 带上库内 key 白名单与项目背景", () => {
    const f = fixture("coexplore-prompt");
    const prompt = buildCoExplorePrompt("我想做端到端结构预测", f.library.list(), f.keyOf, "蛋白结构预测");
    for (const key of f.keys) expect(prompt).toContain(`[@${key}]`);
    expect(prompt).toContain("蛋白结构预测");
    expect(prompt).toContain("白名单之外一律不许引");
  });

  test("库为空时 prompt 明说没有证据基础", () => {
    const prompt = buildCoExplorePrompt("随便聊聊", [], () => "", undefined);
    expect(prompt).toContain("项目文献库为空");
  });

  test("workflow prompt 文件真的被加载（不是占位符）", () => {
    const prompt = loadCoExplorePrompt();
    expect(prompt).toContain("Criticism is mandatory");
    expect(prompt).toContain("(inferred)");
  });

  test("一轮共探产出卡片并落 record + supports/contradicts 边", async () => {
    const f = fixture("coexplore-save");
    const records = f.project.records();
    const llm = new FakeLlm([cardJson(f.keys)]);
    const session = new CoExploreSession({ llm, library: f.library, records });
    const result = await session.explore("端到端结构预测能到实验级精度吗", { sessionId: "s1" });

    expect(result.attempts).toBe(1);
    expect(result.stored.noveltyStatus).toBe("unchecked");
    expect(records.list({ type: "idea" })).toHaveLength(1);

    const paper0 = f.library.list()[0]!;
    const paper1 = f.library.list()[1]!;
    const incoming = records.edgesOf(result.stored.recordId).incoming;
    // 边的方向按语义：论文 --supports--> 思路
    expect(incoming.find((e) => e.type === "supports")!.sourceId).toBe(paper0.recordId!);
    expect(incoming.find((e) => e.type === "contradicts")!.sourceId).toBe(paper1.recordId!);
    f.library.close();
    f.project.close();
  });

  test("非法输出重试一次后成功，只落一条 record", async () => {
    const f = fixture("coexplore-retry");
    const records = f.project.records();
    const llm = new FakeLlm([JSON.stringify({ hypothesis: "只有假设" }), cardJson(f.keys)]);
    const session = new CoExploreSession({ llm, library: f.library, records });
    const result = await session.explore("试试", { sessionId: "s1" });

    expect(result.attempts).toBe(2);
    expect(records.list({ type: "idea" })).toHaveLength(1);
    // 第二次调用带上了校验失败原因
    expect(llm.calls[1]!.messages.at(-1)!.content).toContain("校验失败原因");
    f.library.close();
    f.project.close();
  });

  test("两次都不合格 → 抛错且不落半成品 record", async () => {
    const f = fixture("coexplore-fail");
    const records = f.project.records();
    const llm = new FakeLlm([JSON.stringify({ hypothesis: "x" })]);
    const session = new CoExploreSession({ llm, library: f.library, records });
    await expect(session.explore("试试")).rejects.toThrow(/CoExplore/);
    expect(records.list({ type: "idea" })).toHaveLength(0);
    f.library.close();
    f.project.close();
  });

  test("讨论正文引用库外 key → 重试后仍越界则拒绝", async () => {
    const f = fixture("coexplore-badkey");
    const records = f.project.records();
    const llm = new FakeLlm([cardJson(f.keys, { critique: "早有定论[@vaswani2017attention]。" })]);
    const session = new CoExploreSession({ llm, library: f.library, records });
    await expect(session.explore("试试")).rejects.toThrow(/vaswani2017attention/);
    expect(records.list({ type: "idea" })).toHaveLength(0);
    f.library.close();
    f.project.close();
  });

  test("模型调用失败与 schema 不合的报错文案可区分", async () => {
    const f = fixture("coexplore-callfail");
    const llm = new FakeLlm([{ ok: false, content: "[error] no key" }]);
    const session = new CoExploreSession({ llm, library: f.library, records: f.project.records() });
    await expect(session.explore("试试")).rejects.toThrow(/模型两次都没能返回内容/);
    f.library.close();
    f.project.close();
  });

  test("空消息直接拒绝", async () => {
    const f = fixture("coexplore-empty");
    const session = new CoExploreSession({
      llm: new FakeLlm(["{}"]),
      library: f.library,
      records: f.project.records(),
    });
    await expect(session.explore("   ")).rejects.toThrow(/用户消息为空/);
    f.library.close();
    f.project.close();
  });

  test("多轮共探：第二轮带上历史，/card 前不落库", async () => {
    const f = fixture("coexplore-multi");
    const records = f.project.records();
    const llm = new FakeLlm([cardJson(f.keys), cardJson(f.keys, { hypothesis: "收敛后的假设" })]);
    const session = new CoExploreSession({ llm, library: f.library, records });

    const first = await session.turn("初步想法");
    expect(records.list({ type: "idea" })).toHaveLength(0);
    const second = await session.turn("再想想", { history: first.history });
    expect(second.card.hypothesis).toBe("收敛后的假设");
    expect(llm.calls[1]!.messages.some((m) => m.role === "assistant")).toBe(true);

    const stored = session.save(second.card, { sessionId: "s2" });
    expect(records.list({ type: "idea" })).toHaveLength(1);
    expect(stored.hypothesis).toBe("收敛后的假设");
    f.library.close();
    f.project.close();
  });

  test("没有 RecordStore 时 save 明确报错而不是静默丢弃", async () => {
    const f = fixture("coexplore-norecords");
    const session = new CoExploreSession({ llm: new FakeLlm([cardJson(f.keys)]), library: f.library });
    const turn = await session.turn("想法");
    expect(() => session.save(turn.card)).toThrow(/无处落库/);
    f.library.close();
    f.project.close();
  });
});

describe("IdeaStore", () => {
  test("按 id 前缀取卡；前缀歧义时报错", async () => {
    const f = fixture("ideastore-prefix");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const session = new CoExploreSession({ llm: new FakeLlm([cardJson(f.keys)]), library: f.library, records });
    const card = (await session.explore("想法")).stored;

    expect(store.get(card.recordId.slice(0, 8))!.recordId).toBe(card.recordId);
    expect(store.get("完全不存在的前缀")).toBeNull();
    expect(store.get("  ")).toBeNull();

    // 前缀歧义必须报错而不是随便挑一条。uuid 首字符只有 16 种，
    // 建到第 17 条时鸽巢原理保证一定出现同首字符（不依赖运气）。
    let collided = "";
    for (let i = 0; i < 17 && !collided; i++) {
      const next = (await session.explore(`想法 ${i}`)).stored;
      const heads = store.list().map((c) => c.recordId[0]!);
      const dup = heads.find((h, idx) => heads.indexOf(h) !== idx);
      if (dup) collided = dup;
    }
    expect(collided).not.toBe("");
    expect(() => store.get(collided)).toThrow(/匹配到/);
    f.library.close();
    f.project.close();
  });

  test("setNovelty 回写状态并重渲染卡片正文", async () => {
    const f = fixture("ideastore-status");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const session = new CoExploreSession({ llm: new FakeLlm([cardJson(f.keys)]), library: f.library, records });
    const card = (await session.explore("想法")).stored;

    const updated = store.setNovelty(card.recordId, "checked-overlap", { reportRecordId: "r1" });
    expect(updated.noveltyStatus).toBe("checked-overlap");
    expect(updated.noveltyReportRecordId).toBe("r1");
    expect(updated.checkedAt).toBeTruthy();
    // 正文与 metadata 不能各说各话
    expect(records.get(card.recordId)!.content).toContain("checked-overlap");
    // type/evidence/createdAt 不可变
    expect(records.get(card.recordId)!.evidence).toBe("inferred");
    expect(records.get(card.recordId)!.createdAt).toBe(card.createdAt);
    f.library.close();
    f.project.close();
  });

  test("未知状态被拒绝", async () => {
    const f = fixture("ideastore-badstatus");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const session = new CoExploreSession({ llm: new FakeLlm([cardJson(f.keys)]), library: f.library, records });
    const card = (await session.explore("想法")).stored;
    expect(() => store.setNovelty(card.recordId, "checked" as never)).toThrow(/未知 novelty 状态/);
    f.library.close();
    f.project.close();
  });

  test("论文被移出文献库后，对应证据条目不再算数", async () => {
    const f = fixture("ideastore-drift");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const session = new CoExploreSession({ llm: new FakeLlm([cardJson(f.keys)]), library: f.library, records });
    const card = (await session.explore("想法")).stored;
    expect(store.get(card.recordId)!.supporting).toHaveLength(1);

    // 删掉被支持引用的那篇 → key 不再存在于库中
    f.library.remove(f.library.list()[0]!.id);
    expect(store.get(card.recordId)!.supporting).toHaveLength(0);
    f.library.close();
    f.project.close();
  });

  test("list 按状态过滤", async () => {
    const f = fixture("ideastore-list");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const llm = new FakeLlm([cardJson(f.keys), cardJson(f.keys, { hypothesis: "第二条思路" })]);
    const session = new CoExploreSession({ llm, library: f.library, records });
    const a = (await session.explore("想法一")).stored;
    await session.explore("想法二");
    store.setNovelty(a.recordId, "checked-novel");

    expect(store.list()).toHaveLength(2);
    expect(store.list({ status: "checked-novel" })).toHaveLength(1);
    expect(store.list({ status: "unchecked" })).toHaveLength(1);
    f.library.close();
    f.project.close();
  });
});

describe("状态聚合与渲染", () => {
  test("statusFromRatings 取最保守的一条", () => {
    expect(statusFromRatings([])).toBe("unchecked");
    expect(statusFromRatings(["novel", "novel"])).toBe("checked-novel");
    expect(statusFromRatings(["novel", "incremental"])).toBe("checked-incremental");
    expect(statusFromRatings(["novel", "incremental", "existing"])).toBe("checked-overlap");
  });

  test("renderIdeaCard 五段齐全且标出 inferred 条目", () => {
    const md = renderIdeaCard(
      {
        hypothesis: "假设",
        critique: "讨论",
        supporting: [{ key: "a2020x", note: "支持理由", inferred: false }],
        contradicting: [{ key: null, note: "推断出的反例", inferred: true }],
        openQuestions: ["待验证点"],
      },
      "checked-incremental",
    );
    expect(md).toContain("## 假设陈述");
    expect(md).toContain("[@a2020x]");
    expect(md).toContain("（inferred）推断出的反例");
    expect(md).toContain("checked-incremental");
  });
});
