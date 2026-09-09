import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageGraph } from "../../backend/src/artifacts/lineage";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import { LibraryStore } from "../../backend/src/literature/library";
import { ReadingCardGenerator, listReadingCards } from "../../backend/src/literature/reading";
import { ReviewDraftGenerator, baselinesFrom } from "../../backend/src/literature/review";
import { ProjectManager } from "../../backend/src/project/manager";
import { ReviewerAgent } from "../../backend/src/reviewer/agent";
import { citationIntegrity } from "../../backend/src/reviewer/rules";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { CASSETTES, PER_SOURCE, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";
import { FakeJudge } from "../helpers/review_scenario";
import { llmExtras } from "../../backend/src/llm/types";

// P3 e2e（回放，无网络）：P2 的 fixture 检索 → 10 篇入库 → 10 张精读卡 → 综述草稿
// → citation-integrity 全过 → 再注入伪造引用跑对抗路径。
//
// 文献响应来自 tests/fixtures/literature/search-alphafold.json（P2 真实录制）；
// LLM 全部是注入的 fake（P3 不引入新的外部依赖，也不打模型 API）。

const PAPER_COUNT = 10;

// 按 prompt 内容分派的 fake 模型：看到综述 prompt 就写草稿，否则写精读卡。
// 比「按顺序吐答案」更接近真实调用形态，也能顺带断言 prompt 里确实带了论文/白名单。
class ScriptedLlm {
  readonly cardPrompts: string[] = [];
  readonly reviewPrompts: string[] = [];
  constructor(private draftFor: (keys: string[]) => string) {}

  call = async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
    // 用整段 user 消息拼接来分派：重试时最后一条 user 消息是纠正指令，
    // 只看最后一条会把「综述重试」误判成「精读卡请求」。
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    if (user.includes("可用引用 key 白名单")) {
      this.reviewPrompts.push(user);
      const keys = [...user.matchAll(/^- \[@([^\]]+)\]/gm)].map((m) => m[1]!);
      return { ok: true, provider: "kimi", model, content: this.draftFor(keys), ...llmExtras() };
    }
    this.cardPrompts.push(user);
    const title = user.match(/标题: (.+)/)?.[1] ?? "未知标题";
    return {
      ok: true,
      ...llmExtras(),
      provider: "kimi",
      model,
      content: JSON.stringify({
        researchQuestion: `《${title.slice(0, 60)}》试图回答的问题`,
        methods: "见摘要所述方法",
        keyFindings: [`该工作报告了与「${title.slice(0, 30)}」相关的结果`],
        limitations: ["摘要未提及完整局限"],
        relationToProject: "作为背景文献纳入综述",
      }),
    };
  };

  listModels = () => ({ kimi: [], openai: [], anthropic: [], deepseek: [], qwen: [], openrouter: [] });
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-p3-e2e-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function seedLibrary(slug = "p3-e2e") {
  const manager = new ProjectManager(tmp);
  const project = manager.create(slug, { name: "P3 e2e", description: "蛋白结构预测综述" });
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  const searched = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, {
    sources: SEARCH_SOURCES,
    perSource: PER_SOURCE,
  });
  for (const paper of searched.papers.slice(0, PAPER_COUNT)) library.add(paper, { tags: ["background"] });
  return { manager, project, library };
}

describe("P3 e2e 回放 · 10 篇文献 → 精读卡 → 综述 → 引用核验", () => {
  test("全链路：入库 → 10 张精读卡 → 综述草稿 → citation-integrity 全过", async () => {
    const { project, library } = await seedLibrary();
    const records = project.records();
    expect(library.count()).toBe(PAPER_COUNT);

    // ① 精读卡
    const llm = new ScriptedLlm((keys) =>
      [
        "## 研究现状",
        ...keys.map((k, i) => `路线 ${i + 1} 的代表工作给出了相应结果[@${k}]。`),
        "",
        "## 开放问题",
        `跨方法的公平比较仍不充分[@${keys[0]}]。`,
      ].join("\n"),
    );
    const cardGen = new ReadingCardGenerator({ llm, library, records, projectContext: "蛋白结构预测" });
    const { cards, failures } = await cardGen.generateMany(library.list().map((p) => p.id), { sessionId: "e2e" });

    expect(failures).toHaveLength(0);
    expect(cards).toHaveLength(PAPER_COUNT);
    expect(llm.cardPrompts).toHaveLength(PAPER_COUNT);
    // 每张卡片一条 observation record + 一条指向 paper record 的 cites 边
    expect(records.list({ type: "reading" })).toHaveLength(PAPER_COUNT);
    expect(records.listEdges("cites").length).toBeGreaterThanOrEqual(PAPER_COUNT);
    expect(library.list().every((p) => p.readingStatus === "read")).toBe(true);

    // 重新从证据图里读回卡片（综述用的是持久化后的卡片，不是内存里的）
    const reloaded = listReadingCards(records, library);
    expect(reloaded).toHaveLength(PAPER_COUNT);

    // ② 综述草稿
    const draftGen = new ReviewDraftGenerator({
      llm,
      library,
      records,
      artifacts: project.artifacts(),
      workDir: project.paths.artifactsDir,
    });
    const draft = await draftGen.generate(reloaded, { topic: "蛋白结构预测方法综述", sessionId: "e2e" });

    expect(draft.attempts).toBe(1);
    expect(draft.citedKeys).toHaveLength(PAPER_COUNT);
    expect(draft.unknownKeys).toHaveLength(0);
    expect(draft.artifactId).toBeTruthy();
    // 白名单里恰好是这 10 篇，没有别的
    expect(llm.reviewPrompts[0]!.match(/^- \[@/gm)).toHaveLength(PAPER_COUNT);

    // ③ 引用核验：全部真实引用 → 0 hard finding
    const check = await citationIntegrity({
      draft: draft.markdown,
      knownKeys: libraryKeyIndex(library.list()).keys,
      baselines: baselinesFrom(reloaded),
      judge: new FakeJudge(),
      artifactId: draft.artifactId!,
      location: "text/markdown",
    });
    // 正文 11 处引用 + 参考文献区 10 条条目 = 21 处；条目不做一致性判定，故只判 11 处
    expect(check.citations).toHaveLength(PAPER_COUNT * 2 + 1);
    expect(check.unknownKeys).toHaveLength(0);
    expect(check.judgedCount).toBe(PAPER_COUNT + 1);
    expect(check.findings.filter((f) => f.severity === "hard")).toHaveLength(0);

    // ④ 走完整 Reviewer：草稿 artifact 在同一 session 下必须 approved
    const reviewer = new ReviewerAgent(project.artifacts(), [], new LineageGraph(), {
      citations: {
        knownKeys: libraryKeyIndex(library.list()).keys,
        baselines: baselinesFrom(reloaded),
        judge: new FakeJudge(),
      },
    });
    const review = await reviewer.review("e2e");
    expect(review.approved).toBe(true);
    expect(review.findings).toHaveLength(0);

    // ⑤ 证据图完整性：草稿 record 连回 10 张卡片与 10 篇论文
    const draftRecord = records.get(draft.recordId!)!;
    const outgoing = records.edgesOf(draftRecord.id).outgoing;
    expect(outgoing.filter((e) => e.type === "derives_from")).toHaveLength(PAPER_COUNT);
    expect(outgoing.filter((e) => e.type === "cites")).toHaveLength(PAPER_COUNT);
    // 从草稿出发 2 跳能到达论文 record（综述 → 卡片 → 论文）
    const graph = records.graph(draftRecord.id, 2);
    expect(graph.nodes.filter((n) => n.type === "paper").length).toBe(PAPER_COUNT);

    library.close();
    project.close();
  });

  test("对抗路径：同一条链路注入伪造引用 → Reviewer 必须 veto", async () => {
    const { project, library } = await seedLibrary("p3-e2e-attack");
    const records = project.records();
    const llm = new ScriptedLlm((keys) =>
      [
        `真实引用在此[@${keys[0]}]。`,
        // 三种伪造模式各一条，混在真引用之间
        "早期工作已解决该问题[@zhang2019foldsolver]。",
        "Transformer 是基础架构[@vaswani2017attention]。",
        `该工作在复合物预测上同样达到原子级精度[@${keys[1]}]。`,
      ].join("\n"),
    );
    const cardGen = new ReadingCardGenerator({ llm, library, records });
    const { cards } = await cardGen.generateMany(library.list().map((p) => p.id), { sessionId: "attack" });

    const draftGen = new ReviewDraftGenerator({
      llm,
      library,
      records,
      artifacts: project.artifacts(),
      workDir: project.paths.artifactsDir,
    });
    // allowUnknownKeys=true 模拟「草稿来自别处（人写的/别的 agent 写的）」，
    // 生成器的白名单这道保险不生效时，检查器这道兜底必须挡住。
    const draft = await draftGen.generate(cards, { topic: "对抗", sessionId: "attack", allowUnknownKeys: true });
    expect(draft.unknownKeys.sort()).toEqual(["vaswani2017attention", "zhang2019foldsolver"]);

    const reviewer = new ReviewerAgent(project.artifacts(), [], new LineageGraph(), {
      citations: {
        knownKeys: libraryKeyIndex(library.list()).keys,
        baselines: baselinesFrom(cards),
        judge: new FakeJudge(["复合物预测上同样达到原子级精度"]),
      },
    });
    const review = await reviewer.review("attack");

    expect(review.approved).toBe(false);
    expect(review.action).toBe("inject_notice_and_veto_completion");
    const hard = review.findings.filter((f) => f.severity === "hard");
    expect(hard).toHaveLength(2);
    expect(hard.map((f) => (f.detail as { key: string }).key).sort()).toEqual([
      "vaswani2017attention",
      "zhang2019foldsolver",
    ]);
    // 真 key 假内容是 soft：提示但不参与 veto 计数
    const soft = review.findings.filter((f) => f.severity === "soft");
    expect(soft.some((f) => f.message.includes("citation_conflict"))).toBe(true);

    library.close();
    project.close();
  });

  test("生成器自身的白名单保险：默认模式下伪造引用连 artifact 都不会落地", async () => {
    const { project, library } = await seedLibrary("p3-e2e-guard");
    const records = project.records();
    const llm = new ScriptedLlm(() => "只引用库外文献[@vaswani2017attention]。");
    const { cards } = await new ReadingCardGenerator({ llm, library, records }).generateMany(
      library.list().slice(0, 3).map((p) => p.id),
    );
    const artifacts = project.artifacts();
    const before = artifacts.listBySession("guard").length;

    await expect(
      new ReviewDraftGenerator({ llm, library, records, artifacts, workDir: project.paths.artifactsDir }).generate(
        cards,
        { sessionId: "guard" },
      ),
    ).rejects.toThrow(/vaswani2017attention/);

    expect(artifacts.listBySession("guard")).toHaveLength(before);
    library.close();
    project.close();
  });
});
