import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIdeaCommand } from "../../backend/src/ideation/cli";
import { classifyIdentifier, runLitCommand } from "../../backend/src/literature/cli";
import { LibraryStore } from "../../backend/src/literature/library";
import { runReportCommand } from "../../backend/src/report/cli";
import { ProjectManager } from "../../backend/src/project/manager";
import type { LiteratureSearcher } from "../../backend/src/literature/search";

// R1-P0（B2 第 1 轮头两号发现的回归）：
//
// 1. `lit add` 对「没有任何源能按 id 取数」的标识符必须**前置拒绝、零查询**。
//    R1-T3 实测：AMiner 内部 id（24 位十六进制）被当 unknown 整体绕过 S1 的形状门禁、
//    透传给各源撞库，静默匹配到无关论文并报 ✅——「查到了不对的东西比没查到更糟」。
// 2. lit/idea/report 的 `--project` 显式覆盖。state.json 的 currentProject 是全局
//    无锁指针，两个并发会话互相改写对方的落库目标（R1 双向污染实锤）。

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-r1p0-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 任何 fetch 都不该发生——被调用即测试失败。
function explodingSearcher(): { searcher: LiteratureSearcher; calls: () => number } {
  let n = 0;
  const searcher = {
    fetchById: async () => {
      n += 1;
      throw new Error("不该走到这里：前置拒绝必须发生在任何检索之前");
    },
    search: async () => {
      n += 1;
      throw new Error("不该走到这里");
    },
  } as unknown as LiteratureSearcher;
  return { searcher, calls: () => n };
}

describe("R1-P0 · lit add 的标识符前置拒绝", () => {
  test("AMiner 内部 id 被识别成独立形态", () => {
    expect(classifyIdentifier("619bae731c45e57ce9ef7218")).toBe("aminer");
    // 全数字 24 位也归 aminer（hex 超集），绝不能落进 pmid（≤8 位）或 unknown 透传
    expect(classifyIdentifier("123456789012345678901234")).toBe("aminer");
  });

  test("lit add <aminer-id> → 拒绝 + 零查询 + 给 lit search 绕行指引", async () => {
    const manager = new ProjectManager(tmp);
    manager.create("p0", { name: "p0" });
    const { searcher, calls } = explodingSearcher();
    const errs: string[] = [];
    const code = await runLitCommand(["add", "619bae731c45e57ce9ef7218"], {
      manager,
      root: tmp,
      searcher,
      out: () => {},
      err: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(calls()).toBe(0);
    const text = errs.join("\n");
    expect(text).toContain("AMiner 内部 id");
    expect(text).toContain("lit search");
  });

  test("lit add <乱码> → 拒绝 + 零查询（unknown 不再整体绕过形状门禁）", async () => {
    const manager = new ProjectManager(tmp);
    manager.create("p0", { name: "p0" });
    const { searcher, calls } = explodingSearcher();
    const errs: string[] = [];
    const code = await runLitCommand(["add", "!!!not-an-identifier!!!"], {
      manager,
      root: tmp,
      searcher,
      out: () => {},
      err: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(calls()).toBe(0);
    expect(errs.join("\n")).toContain("lit search");
  });
});

describe("R1-P0 · --project 显式覆盖（并发污染的最小防线）", () => {
  function seedTwoProjects() {
    const manager = new ProjectManager(tmp);
    const b = manager.create("proj-b", { name: "B" });
    const library = new LibraryStore(b.paths.libraryDb, { records: b.records() });
    library.add(
      {
        title: "Only in project B",
        authors: [],
        year: 2024,
        venue: null,
        doi: null,
        ids: { openalex: "W900000001" },
        abstract: null,
        url: null,
        pdfUrl: null,
        citedByCount: null,
        isOpenAccess: null,
        sources: ["openalex"],
        references: [],
      },
      { tags: [] },
    );
    library.close();
    b.close();
    // A 建在后面 → 全局 currentProject 指向 A（模拟「另一个会话刚把指针切走」）
    manager.create("proj-a", { name: "A" }).close();
    return manager;
  }

  test("lit list --project 各看各的库，不受全局指针影响", async () => {
    const manager = seedTwoProjects();
    // 不断言全局指针指向谁——那正是不可靠的东西；断言显式 --project 的确定性。
    const aOut: string[] = [];
    expect(
      await runLitCommand(["list", "--project", "proj-a"], { manager, root: tmp, out: (l) => aOut.push(l), err: () => {} }),
    ).toBe(0);
    expect(aOut.join("\n")).not.toContain("Only in project B");

    const bOut: string[] = [];
    expect(
      await runLitCommand(["list", "--project", "proj-b"], { manager, root: tmp, out: (l) => bOut.push(l), err: () => {} }),
    ).toBe(0);
    expect(bOut.join("\n")).toContain("Only in project B");
  });

  test("idea list 与 report stats 接受 --project 并作用于指定项目", async () => {
    const manager = seedTwoProjects();
    const ideaOut: string[] = [];
    expect(
      await runIdeaCommand(["list", "--project", "proj-b"], { manager, root: tmp, out: (l) => ideaOut.push(l), err: () => {} }),
    ).toBe(0);

    const repOut: string[] = [];
    expect(
      await runReportCommand(["stats", "--project", "proj-b", "--json"], {
        manager,
        root: tmp,
        out: (l) => repOut.push(l),
        err: () => {},
      }),
    ).toBe(0);
    // B 库里有 1 篇——stats 的 JSON 必须反映指定项目而不是全局指针指向的 A
    const stats = JSON.parse(repOut.join("\n"));
    expect(JSON.stringify(stats)).toContain("1");
  });
});
