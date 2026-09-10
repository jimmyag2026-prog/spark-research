import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CITATION_INTEGRITY_REVIEW_KIND,
  RecordStoreEvidenceQuery,
  createLiteratureReviewContract,
  type CitationIntegrityReviewMetadata,
} from "../../backend/src/agents/contract";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { llmExtras } from "../../backend/src/llm/types";
import { runLitCommand } from "../../backend/src/literature/cli";
import { LibraryStore } from "../../backend/src/literature/library";
import { ReadingCardGenerator } from "../../backend/src/literature/reading";
import { ProjectManager } from "../../backend/src/project/manager";
import { CASSETTES, PER_SOURCE, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";

// v0.4 W3-c：`lit review` → citation-integrity observation record。
//
// W2-b 交付的 literature-review 契约（backend/src/agents/contract.ts，本 lane 只读）把
// citations_verified stage 的判据钉死成「存在 metadata.kind === CITATION_INTEGRITY_REVIEW_KIND
// 的 observation record，且最近一次 hardFindingCount === 0」，但当时明确留了一个「已知缺口：
// 目前没有生产者」——`lit review` 命令跑了核验，只把结果打印到 stdout，不落证据图（见
// docs/devlog/W2-b.md「citations_verified 的已知缺口」一节）。这个测试文件验证的正是这条缺口
// 已经补上：真的跑一遍 `lit review` CLI 命令，然后从**同一个真实证据图**里读回这条 record，
// 并让契约的 citations_verified stage 亲自判一遍——不是在测试里手工塞一条模拟 record
// （tests/unit/contract.test.ts 的 addCitationReview() 那套只验证判据本身对不对，不验证
// 生产者是否存在；这个文件反过来，只验证生产者是否真的把 record 落对了地方）。

const PAPER_COUNT = 2;

// 与 tests/unit/review_e2e.test.ts 的 ScriptedLlm 同一套写法：按 prompt 内容分派，
// 看到综述 prompt 就写引用背景陈述的草稿，否则写精读卡 JSON。
class ScriptedLlm {
  readonly cardPrompts: string[] = [];
  readonly reviewPrompts: string[] = [];
  constructor(private draftFor: (keys: string[]) => string) {}

  call = async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
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
  tmp = mkdtempSync(join(tmpdir(), "spark-lit-review-record-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function seed(slug: string) {
  const manager = new ProjectManager(tmp);
  const project = manager.create(slug, { name: "lit review record test" });
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  const searched = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, {
    sources: SEARCH_SOURCES,
    perSource: PER_SOURCE,
  });
  for (const paper of searched.papers.slice(0, PAPER_COUNT)) library.add(paper, { tags: ["background"] });
  return { manager, project, library };
}

describe("`lit review` → citation-integrity observation record（W3-c）", () => {
  test("命令跑完之后证据图里有一条 metadata.kind=CITATION_INTEGRITY_REVIEW_KIND 的 record，citations_verified stage 能读到它", async () => {
    const { manager, project, library } = await seed("lit-review-record");
    const records = project.records();

    const llm = new ScriptedLlm((keys) => keys.map((k) => `这是背景陈述[@${k}]。`).join("\n"));
    const cardGen = new ReadingCardGenerator({ llm, library, records });
    const { cards, failures } = await cardGen.generateMany(library.list().map((p) => p.id), { sessionId: "s1" });
    expect(failures).toHaveLength(0);
    expect(cards).toHaveLength(PAPER_COUNT);

    // 补线之前的状态：还没有任何 citation-integrity 的 review 记录，stage 必须是未完成——
    // 这正是 docs/devlog/W2-b.md 记录的已知缺口本身（不是本测试臆造的前提）。
    const q = new RecordStoreEvidenceQuery(records);
    const before = createLiteratureReviewContract(q).evaluate(q).stages.find((s) => s.id === "citations_verified")!;
    expect(before.done).toBe(false);
    expect(before.reason).toContain("还没有 citation-integrity 的 review 记录");

    const out: string[] = [];
    const err: string[] = [];
    const code = await runLitCommand(["review", "--session", "s1", "--no-judge"], {
      manager,
      llm,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });

    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.some((line) => line.includes("citation-integrity record:"))).toBe(true);

    // ① record 真的落库了，形状与 W2-b 约定的一致。
    const observations = records
      .list({ type: "observation" })
      .filter((r) => (r.metadata as Partial<CitationIntegrityReviewMetadata>).kind === CITATION_INTEGRITY_REVIEW_KIND);
    expect(observations).toHaveLength(1);
    const meta = observations[0]!.metadata as unknown as CitationIntegrityReviewMetadata;
    expect(meta.checker).toBe("citation-integrity");
    expect(meta.hardFindingCount).toBe(0);
    expect(typeof meta.targetRecordId).toBe("string");
    expect(meta.targetRecordId.length).toBeGreaterThan(0);

    // ② 契约的 citations_verified stage 现在真的能过——此前的已知缺口是「没有生产者，
    // 这个 stage 在生产里永远过不了」，这条断言就是验证缺口已经补上。
    const contract = createLiteratureReviewContract(q);
    const report = contract.evaluate(q);
    const stage = report.stages.find((s) => s.id === "citations_verified")!;
    expect(stage.done, stage.reason).toBe(true);
    expect(stage.evidence).toEqual([observations[0]!.id]);

    library.close();
    project.close();
  });

  // 第二次运行必须落第二条 record，而不是复用/更新第一条——citations_verified 的判据
  // 显式取「最近一次」（按 createdAt 排序取最后一条），append-only 是这条判据成立的前提。
  test("同一个项目跑两次 `lit review` → 两条独立的 observation record，契约取最近一次", async () => {
    const { manager, project, library } = await seed("lit-review-record-twice");
    const records = project.records();
    const llm = new ScriptedLlm((keys) => keys.map((k) => `这是背景陈述[@${k}]。`).join("\n"));
    const cardGen = new ReadingCardGenerator({ llm, library, records });
    await cardGen.generateMany(library.list().map((p) => p.id), { sessionId: "s1" });

    const run = (session: string) =>
      runLitCommand(["review", "--session", session, "--no-judge"], { manager, llm, out: () => {}, err: () => {} });

    expect(await run("round-1")).toBe(0);
    expect(await run("round-2")).toBe(0);

    const observations = records
      .list({ type: "observation" })
      .filter((r) => (r.metadata as Partial<CitationIntegrityReviewMetadata>).kind === CITATION_INTEGRITY_REVIEW_KIND);
    expect(observations).toHaveLength(2);

    const q = new RecordStoreEvidenceQuery(records);
    const stage = createLiteratureReviewContract(q).evaluate(q).stages.find((s) => s.id === "citations_verified")!;
    expect(stage.done).toBe(true);
    expect(stage.evidence).toEqual([observations[1]!.id]);

    library.close();
    project.close();
  });
});
