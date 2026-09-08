import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { LibraryStore, paperFrom } from "../../backend/src/literature/library";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import type { CitationJudge, CitationJudgeInput, CitationJudgement } from "../../backend/src/reviewer/rules";

// P3 测试共用脚手架。
// 纪律：**所有** LLM 调用都走这里的 fake，单测与 e2e 都不打真实模型 API。

export interface FakeLlmCall {
  messages: ChatMessage[];
  model: string;
}

// 按调用顺序吐出预置回答的 fake LLM；回答用完后重复最后一条。
export class FakeLlm {
  readonly calls: FakeLlmCall[] = [];
  private queue: Array<string | { ok: false; content: string }>;

  constructor(responses: Array<string | { ok: false; content: string }>) {
    this.queue = [...responses];
  }

  call = async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
    this.calls.push({ messages, model });
    const next = this.queue.length > 1 ? this.queue.shift()! : (this.queue[0] ?? "");
    if (typeof next !== "string") {
      return { ok: false, provider: "kimi", model, content: next.content, mock: false };
    }
    return { ok: true, provider: "kimi", model, content: next, mock: false };
  };

  listModels = () => ({
    kimi: [LLMRouter.DEFAULT_MODEL],
    openai: [],
    anthropic: [],
    deepseek: [],
    qwen: [],
    openrouter: [],
  });

  get lastUserPrompt(): string {
    const last = this.calls[this.calls.length - 1];
    return [...(last?.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
  }
}

// 关键词驱动的 fake 判定器：句子里出现 conflictMarkers 之一即判 conflict。
// 用关键词而不是随机/顺序，是为了让对抗测试的期望完全确定。
export class FakeJudge implements CitationJudge {
  readonly seen: CitationJudgeInput[] = [];
  constructor(
    private conflictMarkers: string[] = [],
    private failOn: string[] = [],
  ) {}

  async judge(input: CitationJudgeInput): Promise<CitationJudgement> {
    this.seen.push(input);
    if (this.failOn.some((m) => input.statement.includes(m))) {
      throw new Error("fake judge 故障");
    }
    const hit = this.conflictMarkers.find((m) => input.statement.includes(m));
    return hit
      ? { verdict: "conflict", reason: `草稿声称「${hit}」，精读卡里没有这个结论` }
      : { verdict: "consistent", reason: "与精读卡一致" };
  }
}

export interface CardPayload {
  researchQuestion?: string;
  methods?: string;
  keyFindings?: string[];
  limitations?: string[];
  relationToProject?: string;
}

// 合法精读卡 JSON（可覆写任意字段以构造非法输出）。
export function cardJson(overrides: CardPayload & Record<string, unknown> = {}): string {
  return JSON.stringify({
    researchQuestion: "该论文要回答的问题",
    methods: "深度学习模型 + 公开数据集",
    keyFindings: ["方法在基准上取得可用精度"],
    limitations: ["未在跨物种数据上验证"],
    relationToProject: "可作为方法基线",
    ...overrides,
  });
}

export interface Fixture {
  root: string;
  manager: ProjectManager;
  project: Project;
  library: LibraryStore;
  paperIds: string[];
  // keys[i] 对应 paperIds[i]（依赖 library.list() 的确定性插入序）
  keys: string[];
  keyOf: (paperId: string) => string;
}

// n 篇确定性论文的项目（标题/作者/年份固定 → bibtex key 固定）。
export function makeProjectWithPapers(n = 3, slug = "p3"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "spark-p3-"));
  const manager = new ProjectManager(root);
  const project = manager.create(slug, { name: "P3 测试项目", description: "蛋白结构预测方法综述" });
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  const surnames = ["Jumper", "Baek", "Lin", "Vaswani", "Senior", "Wu", "Chen", "Zhang", "Li", "Wang"];
  const paperIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const surname = surnames[i % surnames.length]!;
    const added = library.add(
      paperFrom({
        title: `Paper ${i + 1} on protein structure prediction`,
        // 姓在最后（authorSurname 取最后一个词），保证 key 形如 jumper2020paper
        authors: [{ name: `Alice ${surname}` }],
        year: 2020 + (i % 5),
        venue: "Nature",
        doi: `10.1000/p3.${i + 1}`,
        abstract: `Abstract of paper ${i + 1}: a method for protein structure prediction.`,
        sources: ["openalex"],
      }),
    );
    paperIds.push(added.paper.id);
  }
  const index = libraryKeyIndex(library.list());
  return {
    root,
    manager,
    project,
    library,
    paperIds,
    keys: index.keys,
    keyOf: (paperId: string) => libraryKeyIndex(library.list()).byId.get(paperId)!,
  };
}
