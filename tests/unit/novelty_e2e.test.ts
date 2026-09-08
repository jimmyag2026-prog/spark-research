import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoExploreSession } from "../../backend/src/ideation/coexplore";
import { HIGH_AFFINITY, NoveltyChecker } from "../../backend/src/ideation/novelty";
import { IdeaStore } from "../../backend/src/ideation/store";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import { LibraryStore } from "../../backend/src/literature/library";
import { ProjectManager } from "../../backend/src/project/manager";
import type { ChatMessage } from "../../backend/src/llm/router";
import { CASSETTES, PER_SOURCE, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";
import {
  FABRICATED_CLAIM,
  NOVELTY_LIMIT,
  NOVELTY_PER_SOURCE,
  NOVELTY_SOURCES,
  PUBLISHED_CLAIM,
  ScriptedLlm,
  candidatesByClaim,
  noveltySearcher,
} from "../helpers/ideation_scenario";

// P4 双向对照 e2e（回放，无网络）：
//   (a) 已发表工作的核心 idea  → 必须评 existing 且最近邻命中原文（Attention Is All You Need）
//   (b) 刻意杜撰的组合 idea    → 评 novel/incremental，且**必须给出最近邻**而不是空手评 novel
//
// 检索响应来自 tests/fixtures/literature/novelty-check.json（本阶段真实录制，见
// tests/integration/novelty_record.test.ts）；LLM 全部是注入的 fake。
//
// 关键设计：fake LLM 只能引用**管线真的检索到**的候选（它从 prompt 里读 key），
// 而最终评级由 constrainRating 这层确定性代码校正。所以下面的断言检验的是管线逻辑，
// 不是「fake 说了什么就是什么」——第 3、4 个用例专门把 fake 的评级判错，看代码能不能纠回来。

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-p4-e2e-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 用 P2 的 alphafold cassette 播一个真实文献库出来（co-explore 需要可引用的 key）。
async function seedProject(slug: string) {
  const manager = new ProjectManager(tmp);
  const project = manager.create(slug, { name: "P4 e2e", description: "序列建模与结构预测" });
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  const searched = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, {
    sources: SEARCH_SOURCES,
    perSource: PER_SOURCE,
  });
  for (const paper of searched.papers.slice(0, 5)) library.add(paper, { tags: ["background"] });
  return { manager, project, library, keys: libraryKeyIndex(library.list()).keys };
}

// 把「共探出卡 → 提 claim → 检索 → 评级」串起来的 fake 模型。
// 三个 handler 按 prompt 分派：co-explore / claim 提取 / 对比评级。
function scriptedFor(options: {
  libraryKeys: string[];
  hypothesis: string;
  claim: { statement: string; queries: string[] };
  // 给定候选清单，决定这次「模型」怎么评。
  rate: (candidates: Array<{ key: string; title: string }>) => {
    rating: string;
    nearestWorks: Array<{ key: string; sameness: string; difference: string }>;
  };
}): ScriptedLlm {
  return new ScriptedLlm([
    (user) =>
      user.includes("可用引用 key 白名单")
        ? JSON.stringify({
            critique:
              `这条思路的关键假设是注意力足以替代循环结构[@${options.libraryKeys[0]}]；` +
              `但同一批工作也提示评测口径本身不稳定[@${options.libraryKeys[1]}]。你打算怎么证伪它？（inferred）`,
            hypothesis: options.hypothesis,
            supporting: [{ key: options.libraryKeys[0], note: "同一范式下的代表性结果" }],
            contradicting: [{ key: options.libraryKeys[1], note: "该工作提示结论对评测口径敏感" }],
            openQuestions: ["在长序列与低资源设定下是否同样成立"],
          })
        : null,
    (user) =>
      user.includes("待验证点")
        ? JSON.stringify({ claims: [{ statement: options.claim.statement, queries: options.claim.queries }] })
        : null,
    (user) => {
      if (!user.includes("候选工作")) return null;
      const candidates = candidatesByClaim(user).get("c1") ?? [];
      const decision = options.rate(candidates);
      return JSON.stringify({
        claims: [{ claimId: "c1", ...decision, verdict: "见最近邻对比" }],
      });
    },
  ]);
}

async function runScenario(
  slug: string,
  claim: { statement: string; queries: string[] },
  hypothesis: string,
  rate: Parameters<typeof scriptedFor>[0]["rate"],
) {
  const { project, library, keys } = await seedProject(slug);
  const records = project.records();
  const llm = scriptedFor({ libraryKeys: keys, hypothesis, claim, rate });

  const idea = (await new CoExploreSession({ llm, library, records, projectContext: "序列建模" }).explore(
    hypothesis,
    { sessionId: slug },
  )).stored;

  const checker = new NoveltyChecker({
    llm,
    searcher: noveltySearcher("replay"),
    library,
    records,
    artifacts: project.artifacts(),
    workDir: project.paths.artifactsDir,
    sources: NOVELTY_SOURCES,
    perSource: NOVELTY_PER_SOURCE,
    limitPerQuery: NOVELTY_LIMIT,
  });
  const result = await checker.check(idea, { sessionId: slug });
  return { project, library, records, idea, result, keys, llm };
}

describe("P4 双向对照 e2e · (a) 已发表工作的核心 idea", () => {
  test("必须评 existing，最近邻命中 Attention Is All You Need，且证据边与引用核验都成立", async () => {
    const { project, library, records, idea, result } = await runScenario(
      "p4-published",
      PUBLISHED_CLAIM,
      "用 Transformer 的自注意力完全替代循环结构做序列转导",
      (candidates) => {
        const hit = candidates.find((c) => c.title.toLowerCase().includes(PUBLISHED_CLAIM.expectTitle))!;
        return {
          rating: "existing",
          nearestWorks: [
            { key: hit.key, sameness: "同样用自注意力替代循环结构做序列转导", difference: "本 claim 没有提出任何新机制" },
          ],
        };
      },
    );

    // ① 检索确实把原文捞回来了（这条是 fixture 里的真实网络结果）
    const candidates = result.retrievals[0]!.candidates;
    const attention = candidates.find((c) => c.paper.title.toLowerCase().includes(PUBLISHED_CLAIM.expectTitle))!;
    expect(attention).toBeDefined();
    // ② 确定性相似度把它排在第一，且达到「高相似」门槛
    expect(candidates[0]!.key).toBe(attention.key);
    expect(attention.affinity).toBeGreaterThanOrEqual(HIGH_AFFINITY);

    // ③ 评级 existing 且通过评级校验层（引用了高相似候选）
    expect(result.assessments[0]!.rating).toBe("existing");
    expect(result.assessments[0]!.violations).toHaveLength(0);
    expect(result.aggregate).toEqual({ status: "checked-overlap", conclusive: true });

    // ④ 报告里确实引到了原文
    expect(result.markdown).toContain(`[@${attention.key}]`);
    expect(result.markdown.toLowerCase()).toContain(PUBLISHED_CLAIM.expectTitle);

    // ⑤ 引用核验（P3 检查器复用）：报告里的每个 key 都能回链到库内或本次候选
    expect(result.citation.unknownKeys).toEqual([]);
    expect(result.citation.findings.filter((f) => f.severity === "hard")).toHaveLength(0);

    // ⑥ novelty 状态回写 + 证据边
    const stored = new IdeaStore(records, library).get(idea.recordId)!;
    expect(stored.noveltyStatus).toBe("checked-overlap");
    expect(stored.noveltyReportRecordId).toBe(result.recordId);
    expect(stored.checkedAt).toBeTruthy();

    const reportEdges = records.edgesOf(result.recordId!).outgoing;
    expect(reportEdges.filter((e) => e.type === "derives_from").map((e) => e.targetId)).toEqual([idea.recordId]);
    // idea 侧：supports/contradicts 边由 co-explore 建好（方向 = 论文支持/反对思路）
    const ideaEdges = records.edgesOf(idea.recordId).incoming;
    expect(ideaEdges.filter((e) => e.type === "supports")).toHaveLength(1);
    expect(ideaEdges.filter((e) => e.type === "contradicts")).toHaveLength(1);
    // 从报告出发两跳可达支撑该思路的论文 record
    const graph = records.graph(result.recordId!, 2);
    expect(graph.nodes.filter((n) => n.type === "paper").length).toBeGreaterThanOrEqual(2);

    library.close();
    project.close();
  });
});

describe("P4 双向对照 e2e · (b) 刻意杜撰的组合 idea", () => {
  test("评 novel 时必须给出最近邻；状态回写 checked-novel", async () => {
    const { project, library, records, idea, result } = await runScenario(
      "p4-fabricated",
      FABRICATED_CLAIM,
      "用量子退火采样的构象系综预训练蛋白语言模型来预测嗜盐菌蛋白相分离温度",
      (candidates) => ({
        rating: "novel",
        nearestWorks: [
          {
            key: candidates[0]!.key,
            sameness: "同样在做蛋白构象系综的生成式建模",
            difference: "没有用量子退火采样，也没有做相分离温度预测",
          },
        ],
      }),
    );

    const candidates = result.retrievals[0]!.candidates;
    // 检索**有**结果（否则「查不到 = 新颖」就成立了，那正是要防的失效模式）
    expect(candidates.length).toBeGreaterThan(0);
    // 但没有任何一条达到高相似门槛 —— 这是「杜撰组合」在数据上的样子
    expect(candidates.every((c) => c.affinity < HIGH_AFFINITY)).toBe(true);

    expect(result.assessments[0]!.rating).toBe("novel");
    expect(result.assessments[0]!.nearestWorks).toHaveLength(1);
    expect(result.assessments[0]!.violations).toHaveLength(0);
    expect(result.aggregate).toEqual({ status: "checked-novel", conclusive: true });

    // 报告必须点名最近邻（不是空手评 novel）
    const nearest = result.assessments[0]!.nearestWorks[0]!;
    expect(result.markdown).toContain(`[@${nearest.key}]`);
    expect(result.markdown).toContain("不同点：");
    expect(result.citation.findings.filter((f) => f.severity === "hard")).toHaveLength(0);

    const stored = new IdeaStore(records, library).get(idea.recordId)!;
    expect(stored.noveltyStatus).toBe("checked-novel");
    expect(records.edgesOf(result.recordId!).outgoing.some((e) => e.type === "derives_from")).toBe(true);

    library.close();
    project.close();
  });

  test("空手评 novel（不给最近邻）→ 结论不可用，状态不推进", async () => {
    const { project, library, records, idea, result } = await runScenario(
      "p4-fabricated-empty",
      FABRICATED_CLAIM,
      "用量子退火采样的构象系综预训练蛋白语言模型",
      () => ({ rating: "novel", nearestWorks: [] }),
    );

    expect(result.assessments[0]!.violations.map((v) => v.code)).toEqual(["rating_without_nearest"]);
    expect(result.aggregate.conclusive).toBe(false);
    // 「查过但没查出来」≠「新颖」：状态维持 unchecked
    expect(new IdeaStore(records, library).get(idea.recordId)!.noveltyStatus).toBe("unchecked");
    // 但报告仍然落库，能查到这次查过
    expect(result.recordId).toBeTruthy();
    expect(new IdeaStore(records, library).get(idea.recordId)!.noveltyReportRecordId).toBe(result.recordId);

    library.close();
    project.close();
  });
});

describe("P4 e2e · 评级由代码约束，不由模型说了算", () => {
  test("(a) 场景下模型硬说 novel → 校验层按检索证据升级为 existing", async () => {
    const { project, library, result } = await runScenario(
      "p4-override",
      PUBLISHED_CLAIM,
      "用 Transformer 的自注意力完全替代循环结构做序列转导",
      (candidates) => {
        // 故意挑一条相似度低的当最近邻，并宣称 novel
        const decoy = candidates[candidates.length - 1]!;
        return {
          rating: "novel",
          nearestWorks: [{ key: decoy.key, sameness: "都在做序列建模", difference: "这条 claim 是全新的" }],
        };
      },
    );

    const assessment = result.assessments[0]!;
    expect(assessment.declaredRating).toBe("novel");
    expect(assessment.rating).toBe("existing");
    expect(assessment.violations.map((v) => v.code)).toEqual(["novel_despite_high_affinity"]);
    expect(result.aggregate.status).toBe("checked-overlap");
    // 报告把「模型说的」与「校正后的」都写出来，谁改了谁看得见
    expect(result.markdown).toContain("模型原判 novel");

    library.close();
    project.close();
  });

  test("(b) 场景下模型硬说 existing → 校验层按检索证据降级为 incremental", async () => {
    const { project, library, result } = await runScenario(
      "p4-downgrade",
      FABRICATED_CLAIM,
      "用量子退火采样的构象系综预训练蛋白语言模型",
      (candidates) => ({
        rating: "existing",
        nearestWorks: [{ key: candidates[0]!.key, sameness: "都在做蛋白建模", difference: "几乎没有差别" }],
      }),
    );

    const assessment = result.assessments[0]!;
    expect(assessment.declaredRating).toBe("existing");
    expect(assessment.rating).toBe("incremental");
    expect(assessment.violations.map((v) => v.code)).toEqual(["existing_without_high_affinity"]);
    expect(result.aggregate.status).toBe("checked-incremental");

    library.close();
    project.close();
  });
});

describe("P4 e2e · fake 模型无法引用没检索到的文献", () => {
  test("引用候选清单之外的 key → 生成器重试后仍越界则整份报告拒绝落地", async () => {
    const { project, library } = await seedProject("p4-fakecite");
    const records = project.records();
    const keys = libraryKeyIndex(library.list()).keys;
    const llm = scriptedFor({
      libraryKeys: keys,
      hypothesis: "用自注意力替代循环结构",
      claim: PUBLISHED_CLAIM,
      rate: () => ({
        rating: "existing",
        nearestWorks: [{ key: "vaswani2017attention", sameness: "同", difference: "异" }],
      }),
    });
    const idea = (await new CoExploreSession({ llm, library, records }).explore("用自注意力替代循环结构")).stored;
    const before = records.count();

    const checker = new NoveltyChecker({
      llm,
      searcher: noveltySearcher("replay"),
      library,
      records,
      artifacts: project.artifacts(),
      workDir: project.paths.artifactsDir,
      sources: NOVELTY_SOURCES,
      perSource: NOVELTY_PER_SOURCE,
      limitPerQuery: NOVELTY_LIMIT,
    });
    await expect(checker.check(idea)).rejects.toThrow(/vaswani2017attention/);
    expect(records.count()).toBe(before);

    library.close();
    project.close();
  });

  test("co-explore 的 prompt 里确实带上了库内白名单（fake 只能从中挑）", async () => {
    const { project, library, keys } = await seedProject("p4-whitelist");
    const records = project.records();
    const llm = scriptedFor({
      libraryKeys: keys,
      hypothesis: "假设",
      claim: PUBLISHED_CLAIM,
      rate: (c) => ({ rating: "novel", nearestWorks: [{ key: c[0]!.key, sameness: "同", difference: "异" }] }),
    });
    await new CoExploreSession({ llm, library, records }).explore("我的思路");
    const prompt = llm.prompts[0]!;
    for (const key of keys) expect(prompt).toContain(`[@${key}]`);
    library.close();
    project.close();
  });
});

describe("P4 e2e · orchestrator co-explore 会话模式", () => {
  test("chat(mode=coexplore) 产出 idea 卡且不走 review 循环；默认 chat 行为不变", async () => {
    const { manager, project, library, keys } = await seedProject("p4-orch");
    library.close();
    project.close();

    const { SparkResearchDaemon } = await import("../../backend/src/daemon/daemon");
    const { OrchestratorAgent } = await import("../../backend/src/agents/orchestrator");
    const llm = scriptedFor({
      libraryKeys: keys,
      hypothesis: "自注意力可以替代循环结构",
      claim: PUBLISHED_CLAIM,
      rate: (c) => ({ rating: "novel", nearestWorks: [{ key: c[0]!.key, sameness: "同", difference: "异" }] }),
    });
    // 默认 chat 分支会打规划/摘要，给它一个兜底回答
    const withFallback = {
      call: async (messages: ChatMessage[], model?: string) => {
        const res = await llm.call(messages, model);
        return res;
      },
      listModels: llm.listModels,
    };
    const daemon = new SparkResearchDaemon({ projects: manager });
    const orch = new OrchestratorAgent(daemon, { llm: withFallback, projects: manager, workspaceRoot: join(tmp, "ws") });
    manager.bindSession("sess-coexplore", "p4-orch");

    const result = await orch.chat({ sessionId: "sess-coexplore", message: "自注意力能替代循环结构吗", mode: "coexplore" });
    expect(result.response).toContain("[coexplore sess-coexplore]");
    expect(result.ideaRecordId).toBeTruthy();
    // co-explore 模式不跑 reviewer 循环
    expect(result.review).toBeUndefined();

    const reopened = manager.open("p4-orch");
    const lib = new LibraryStore(reopened.paths.libraryDb, { records: reopened.records() });
    expect(new IdeaStore(reopened.records(), lib).list()).toHaveLength(1);
    lib.close();
    reopened.close();
    daemon.kernelManager.dispose();
  });
});
