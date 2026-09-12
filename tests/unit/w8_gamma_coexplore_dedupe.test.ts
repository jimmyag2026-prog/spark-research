import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { CoExploreSession, normalizeHypothesis } from "../../backend/src/ideation/coexplore";
import { IdeaStore } from "../../backend/src/ideation/store";
import { FakeLlm, makeProjectWithPapers } from "../helpers/review_scenario";

// V89（review A6 Low，BACKLOG 行 191/204）：co-explore 单次消息偶尔存出两张几乎一样的
// Idea 卡。读 coexplore.ts 判定：当前代码没有任何「一次生成故意产两张卡（主/备假设）」
// 的机制——`turn()` 每次调用只产一张卡，`save()` 每次请求也只落一次库。所以这是**重复
// 记录**，不是设计意图；对策是去重（按 sessionId 域内的 hypothesis 归一化匹配），不是
// 给 IdeaCard 加一个 `role: primary|alternate` 的新语义（models.ts/store.ts 不在本 lane
// 足迹内，也没有证据支持这个语义真的存在——见 docs/devlog/W8-gamma.md 的判断记录）。

const roots: string[] = [];

function fixture(slug: string) {
  const f = makeProjectWithPapers(3, slug);
  roots.push(f.root);
  return f;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function cardJson(keys: string[], hypothesis: string): string {
  return JSON.stringify({
    critique: `讨论正文（可能因为重试而略有出入）[@${keys[0]}]（inferred）。`,
    hypothesis,
    supporting: [{ key: keys[0], note: "支持证据" }],
    contradicting: [{ key: keys[1], note: "反对证据" }],
    openQuestions: ["待验证点"],
  });
}

describe("V89 · co-explore save() 同会话内去重", () => {
  test("同一 sessionId、相同 hypothesis 重复提交（模拟重试/双击）→ 只落一条 record", async () => {
    const f = fixture("v89-dup-same-session");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const HYP = "端到端结构预测模型可以在无模板情况下达到实验级精度";
    const llm = new FakeLlm([cardJson(f.keys, HYP), cardJson(f.keys, HYP)]);
    const session = new CoExploreSession({ llm, library: f.library, records });

    const first = await session.explore("我们讨论一下这个假设", { sessionId: "dup-session-1" });
    const second = await session.explore("我们讨论一下这个假设", { sessionId: "dup-session-1" });

    expect(second.stored.recordId).toBe(first.stored.recordId);
    expect(store.list()).toHaveLength(1);

    f.library.close();
    f.project.close();
  });

  test("阴性范围①：不同 sessionId、相同 hypothesis → 视为两次真实发生的交互，各留一条", async () => {
    const f = fixture("v89-dup-diff-session");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const HYP = "端到端结构预测模型可以在无模板情况下达到实验级精度";
    const llm = new FakeLlm([cardJson(f.keys, HYP), cardJson(f.keys, HYP)]);
    const session = new CoExploreSession({ llm, library: f.library, records });

    const first = await session.explore("我们讨论一下这个假设", { sessionId: "session-a" });
    const second = await session.explore("我们讨论一下这个假设", { sessionId: "session-b" });

    expect(second.stored.recordId).not.toBe(first.stored.recordId);
    expect(store.list()).toHaveLength(2);

    f.library.close();
    f.project.close();
  });

  test("阴性范围②：同一 sessionId 但 hypothesis 不同 → 不误伤，各留一条", async () => {
    const f = fixture("v89-dup-diff-hyp");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const llm = new FakeLlm([
      cardJson(f.keys, "假设一：注意力机制可以替代循环结构"),
      cardJson(f.keys, "假设二：扩散模型可以直接生成蛋白结构"),
    ]);
    const session = new CoExploreSession({ llm, library: f.library, records });

    const first = await session.explore("第一个想法", { sessionId: "session-c" });
    const second = await session.explore("第二个想法", { sessionId: "session-c" });

    expect(second.stored.recordId).not.toBe(first.stored.recordId);
    expect(store.list()).toHaveLength(2);

    f.library.close();
    f.project.close();
  });

  test("阴性范围③：不给 sessionId（CLI 非交互单次调用/既有单测的默认形态）→ 完全不去重，维持老行为", async () => {
    const f = fixture("v89-dup-no-session");
    const records = f.project.records();
    const store = new IdeaStore(records, f.library);
    const HYP = "端到端结构预测模型可以在无模板情况下达到实验级精度";
    const llm = new FakeLlm([cardJson(f.keys, HYP), cardJson(f.keys, HYP)]);
    const session = new CoExploreSession({ llm, library: f.library, records });

    const first = await session.explore("想法");
    const second = await session.explore("想法");

    expect(second.stored.recordId).not.toBe(first.stored.recordId);
    expect(store.list()).toHaveLength(2);

    f.library.close();
    f.project.close();
  });

  test("归一化：大小写/全半角空白/中英文标点差异不影响判重", () => {
    const a = "用 Transformer 的自注意力，完全替代循环结构！";
    const b = "用transformer的自注意力 完全替代循环结构";
    expect(normalizeHypothesis(a)).toBe(normalizeHypothesis(b));
  });
});
