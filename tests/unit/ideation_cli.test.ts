import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIdeaCommand, IDEA_HELP } from "../../backend/src/ideation/cli";
import { IdeaStore } from "../../backend/src/ideation/store";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import { LibraryStore, paperFrom } from "../../backend/src/literature/library";
import type { LiteratureSearchResult, LiteratureSearcher } from "../../backend/src/literature/search";
import { emptyPaper, type Paper } from "../../backend/src/literature/models";
import { ProjectManager } from "../../backend/src/project/manager";
import { FakeLlm } from "../helpers/review_scenario";
import { llmExtras } from "../../backend/src/llm/types";
import type { ChatMessage } from "../../backend/src/llm/router";

// `spark-research idea ...` 的 CLI 单测：输出/退出码走注入，不打网络也不调真实模型。

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(slug = "cli") {
  const root = mkdtempSync(join(tmpdir(), "spark-p4-cli-"));
  roots.push(root);
  const manager = new ProjectManager(root);
  const project = manager.create(slug, { name: "P4 CLI", description: "序列建模" });
  manager.setCurrent(slug);
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  for (let i = 0; i < 2; i++) {
    library.add(
      paperFrom({
        title: `Paper ${i + 1} on sequence modeling`,
        authors: [{ name: `Alice Smith${i}` }],
        year: 2020 + i,
        venue: "Nature",
        doi: `10.1000/cli.${i + 1}`,
        abstract: `Abstract ${i + 1} about sequence modeling with attention.`,
        sources: ["openalex"],
      }),
    );
  }
  const keys = libraryKeyIndex(library.list()).keys;
  library.close();
  project.close();
  return { root, manager, keys };
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

function cardJson(keys: string[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    critique: `你的假设默认了 A 能外推到 B[@${keys[0]}]（inferred）。`,
    hypothesis: "自注意力可以替代循环结构",
    supporting: [{ key: keys[0], note: "支持" }],
    contradicting: [{ key: keys[1], note: "反对" }],
    openQuestions: ["长序列上是否成立"],
    ...overrides,
  });
}

class StubSearcher {
  constructor(private papers: Paper[]) {}
  search = async (query: string): Promise<LiteratureSearchResult> => ({
    query,
    papers: this.papers,
    sources: [{ source: "openalex", outcome: "ok", count: this.papers.length, elapsedMs: 1 }],
    totalBeforeDedupe: this.papers.length,
    mergedCount: 0,
  });
}

describe("idea CLI", () => {
  test("无子命令返回帮助与退出码 1", async () => {
    const s = sink();
    expect(await runIdeaCommand([], { ...s.deps, root: mkdtempSync(join(tmpdir(), "spark-p4-help-")) })).toBe(1);
    expect(s.out.join()).toContain("spark-research idea new");
    expect(IDEA_HELP).toContain("idea check");
  });

  test("未知子命令返回 1", async () => {
    const s = sink();
    const root = mkdtempSync(join(tmpdir(), "spark-p4-unknown-"));
    roots.push(root);
    expect(await runIdeaCommand(["bogus"], { ...s.deps, root })).toBe(1);
    expect(s.err.join()).toContain("未知的 idea 子命令");
  });

  test("idea new -m 产出卡片并落库", async () => {
    const w = workspace("cli-new");
    const s = sink();
    const code = await runIdeaCommand(["new", "-m", "自注意力能替代循环吗"], {
      ...s.deps,
      root: w.root,
      llm: new FakeLlm([cardJson(w.keys)]),
    });
    expect(code).toBe(0);
    expect(s.out.join("\n")).toContain("Idea 卡已入思路库");
    expect(s.out.join("\n")).toContain("## 待验证点");

    const project = w.manager.open("cli-new");
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    expect(new IdeaStore(project.records(), library).list()).toHaveLength(1);
    library.close();
    project.close();
  });

  test("--json 输出结构化卡片与 grounding", async () => {
    const w = workspace("cli-json");
    const s = sink();
    await runIdeaCommand(["new", "-m", "想法", "--json"], {
      ...s.deps,
      root: w.root,
      llm: new FakeLlm([cardJson(w.keys)]),
    });
    const parsed = JSON.parse(s.out.join("\n"));
    expect(parsed.card.noveltyStatus).toBe("unchecked");
    expect(parsed.grounding.unknownKeys).toEqual([]);
  });

  test("库为空时明确警告没有文献基础", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-p4-emptylib-"));
    roots.push(root);
    const manager = new ProjectManager(root);
    manager.create("empty", {});
    manager.setCurrent("empty");
    const s = sink();
    await runIdeaCommand(["new", "-m", "想法"], {
      ...s.deps,
      root,
      llm: new FakeLlm([
        JSON.stringify({
          critique: "库里没有文献，以下全是推断（inferred）。",
          hypothesis: "假设",
          supporting: [],
          contradicting: [{ note: "推断的反例", inferred: true }],
          openQuestions: ["先把文献入库"],
        }),
      ]),
    });
    expect(s.err.join("\n")).toContain("项目文献库为空");
  });

  test("生成失败时返回 1 并如实报错", async () => {
    const w = workspace("cli-fail");
    const s = sink();
    const code = await runIdeaCommand(["new", "-m", "想法"], {
      ...s.deps,
      root: w.root,
      llm: new FakeLlm(["不是 JSON"]),
    });
    expect(code).toBe(1);
    expect(s.err.join("\n")).toContain("CoExplore");
  });

  test("交互式：/card 之前不落库，/card 之后入库", async () => {
    const w = workspace("cli-interactive");
    const s = sink();
    const script = ["初步想法", "/card"];
    const code = await runIdeaCommand(["new"], {
      ...s.deps,
      root: w.root,
      llm: new FakeLlm([cardJson(w.keys)]),
      ask: async () => script.shift() ?? null,
    });
    expect(code).toBe(0);
    expect(s.out.join("\n")).toContain("候选假设");
    expect(s.out.join("\n")).toContain("已入思路库");

    const project = w.manager.open("cli-interactive");
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    expect(new IdeaStore(project.records(), library).list()).toHaveLength(1);
    library.close();
    project.close();
  });

  test("交互式：直接 exit 不落库", async () => {
    const w = workspace("cli-exit");
    const s = sink();
    const script = ["exit"];
    await runIdeaCommand(["new"], {
      ...s.deps,
      root: w.root,
      llm: new FakeLlm([cardJson(w.keys)]),
      ask: async () => script.shift() ?? null,
    });
    const project = w.manager.open("cli-exit");
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    expect(new IdeaStore(project.records(), library).list()).toHaveLength(0);
    library.close();
    project.close();
  });

  test("idea list 空库与有内容两种输出 + 状态过滤", async () => {
    const w = workspace("cli-list");
    const empty = sink();
    await runIdeaCommand(["list"], { ...empty.deps, root: w.root });
    expect(empty.out.join()).toContain("思路库为空");

    await runIdeaCommand(["new", "-m", "想法"], { ...sink().deps, root: w.root, llm: new FakeLlm([cardJson(w.keys)]) });
    const listed = sink();
    await runIdeaCommand(["list"], { ...listed.deps, root: w.root });
    expect(listed.out.join("\n")).toContain("思路库：1 条");
    expect(listed.out.join("\n")).toContain("novelty unchecked");

    const filtered = sink();
    await runIdeaCommand(["list", "--status", "checked-novel"], { ...filtered.deps, root: w.root });
    expect(filtered.out.join()).toContain("思路库为空");
  });

  test("idea check：跑完管线、写报告文件、回写状态", async () => {
    const w = workspace("cli-check");
    await runIdeaCommand(["new", "-m", "想法"], { ...sink().deps, root: w.root, llm: new FakeLlm([cardJson(w.keys)]) });

    const project = w.manager.open("cli-check");
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const idea = new IdeaStore(project.records(), library).list()[0]!;
    library.close();
    project.close();

    const hit: Paper = {
      ...emptyPaper(),
      title: "Attention Is All You Need",
      abstract: "A transformer based solely on self attention, replacing recurrence for sequence transduction.",
      doi: "10.1/attn",
      year: 2017,
    };
    const llm = {
      call: async (messages: ChatMessage[], model?: string) => {
        const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        if (user.includes("候选工作")) {
          const key = user.match(/- \[@([^\]]+)\]/)![1]!;
          return {
            ok: true as const,
            ...llmExtras(),
            provider: "kimi" as const,
            model: model ?? "m",
            content: JSON.stringify({
              claims: [
                {
                  claimId: "c1",
                  rating: "existing",
                  nearestWorks: [{ key, sameness: "同一件事", difference: "无实质差异" }],
                  verdict: "已被做过",
                },
              ],
            }),
          };
        }
        return {
          ok: true as const,
          ...llmExtras(),
          provider: "kimi" as const,
          model: model ?? "m",
          content: JSON.stringify({
            claims: [
              {
                statement: "self attention replaces recurrence for sequence transduction",
                queries: ["self attention transduction", "transformer recurrence"],
              },
            ],
          }),
        };
      },
    };

    const s = sink();
    const outFile = join(w.root, "report.md");
    const code = await runIdeaCommand(["check", idea.recordId.slice(0, 8), "--out", outFile], {
      ...s.deps,
      root: w.root,
      llm,
      searcher: new StubSearcher([hit]) as unknown as LiteratureSearcher,
    });

    expect(code).toBe(0);
    expect(s.out.join("\n")).toContain("c1 existing");
    expect(s.out.join("\n")).toContain("0 条 hard finding");
    expect(s.out.join("\n")).toContain("思路库状态 → checked-overlap");
    expect(readFileSync(outFile, "utf8")).toContain("Novelty check 报告");

    const reopened = w.manager.open("cli-check");
    const lib2 = new LibraryStore(reopened.paths.libraryDb, { records: reopened.records() });
    expect(new IdeaStore(reopened.records(), lib2).get(idea.recordId)!.noveltyStatus).toBe("checked-overlap");
    lib2.close();
    reopened.close();
  });

  test("idea check：结论不可用时退出码 1 并说明状态未推进", async () => {
    const w = workspace("cli-check-fail");
    await runIdeaCommand(["new", "-m", "想法"], { ...sink().deps, root: w.root, llm: new FakeLlm([cardJson(w.keys)]) });
    const project = w.manager.open("cli-check-fail");
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const idea = new IdeaStore(project.records(), library).list()[0]!;
    library.close();
    project.close();

    const llm = {
      call: async (messages: ChatMessage[], model?: string) => {
        const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        const content = user.includes("候选工作")
          ? JSON.stringify({ claims: [{ claimId: "c1", rating: "novel", nearestWorks: [], verdict: "查不到" }] })
          : JSON.stringify({ claims: [{ statement: "杜撰的组合", queries: ["q1", "q2"] }] });
        return { ok: true as const, provider: "kimi" as const, model: model ?? "m", ...llmExtras(), content };
      },
    };
    const s = sink();
    const code = await runIdeaCommand(["check", idea.recordId], {
      ...s.deps,
      root: w.root,
      llm,
      searcher: new StubSearcher([]) as unknown as LiteratureSearcher,
    });
    expect(code).toBe(1);
    expect(s.err.join("\n")).toContain("维持 unchecked");
  });

  test("idea check：找不到 record 返回 1", async () => {
    const w = workspace("cli-check-missing");
    const s = sink();
    expect(await runIdeaCommand(["check", "不存在"], { ...s.deps, root: w.root })).toBe(1);
    expect(s.err.join()).toContain("思路库里没有 record");
  });

  test("idea check：缺参数返回 1；未知文献源被拒", async () => {
    const w = workspace("cli-check-args");
    const s = sink();
    expect(await runIdeaCommand(["check"], { ...s.deps, root: w.root })).toBe(1);

    await runIdeaCommand(["new", "-m", "想法"], { ...sink().deps, root: w.root, llm: new FakeLlm([cardJson(w.keys)]) });
    const project = w.manager.open("cli-check-args");
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const idea = new IdeaStore(project.records(), library).list()[0]!;
    library.close();
    project.close();

    const s2 = sink();
    expect(
      await runIdeaCommand(["check", idea.recordId, "--sources", "不存在的源"], { ...s2.deps, root: w.root }),
    ).toBe(1);
    expect(s2.err.join()).toContain("未知文献源");
  });
});
