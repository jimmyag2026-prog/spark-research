import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { runProjectCommand } from "../../backend/src/project/cli";
import { globToRegExp, slugMatchesGlob } from "../../backend/src/project/slug";

// δ-1（V157）门禁。
//
// 钉的是「接线」不只是「内容」：批量归档与指针跳转都经 `runProjectCommand`（真正的 CLI
// 入口）走一遍，而不是只测 manager 的方法——U40/U47 的教训是判据写了但没人读它。

function freshManager(): ProjectManager {
  return new ProjectManager(mkdtempSync(join(tmpdir(), "w10-delta-proj-")));
}

function touch(manager: ProjectManager, slug: string, at: Date): void {
  utimesSync(manager.pathsFor(slug).recordsDb, at, at);
}

describe("δ-1 glob", () => {
  test("整串匹配，只认 * 与 ?；其余字符按字面量", () => {
    expect(slugMatchesGlob("t1-protein-r1", "t*-r*")).toBe(true);
    expect(slugMatchesGlob("r6-probe", "r6-*")).toBe(true);
    // 刻意不做前缀匹配：'r6' 匹不上 'r6-probe'，要匹前缀得显式写 'r6-*'。
    expect(slugMatchesGlob("r6-probe", "r6")).toBe(false);
    // '.' 是字面量，不是正则的任意字符。
    expect(slugMatchesGlob("axb", "a.b")).toBe(false);
    expect(slugMatchesGlob("a.b", "a.b")).toBe(true);
    expect(slugMatchesGlob("speed-probe", "speed-probe")).toBe(true);
    expect(globToRegExp("a*b").source).toBe("^a.*b$");
  });
});

describe("δ-1 archive --pattern", () => {
  test("CLI 批量归档命中的项目，未命中的不动", () => {
    const manager = freshManager();
    for (const slug of ["t1-protein-r1", "t2-sc-r6", "speed-probe", "real-work"]) manager.create(slug);
    const lines: string[] = [];
    const code = runProjectCommand(["archive", "--pattern", "t*-r*"], { manager, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const active = manager.list().map((m) => m.slug).sort();
    expect(active).toEqual(["real-work", "speed-probe"]);
    expect(lines.join("\n")).toContain("已归档 2 个项目");
  });

  test("--dry-run 只列不改", () => {
    const manager = freshManager();
    for (const slug of ["r6-a", "r6-b", "keep"]) manager.create(slug);
    const lines: string[] = [];
    const code = runProjectCommand(["archive", "--pattern", "r6-*", "--dry-run"], { manager, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("--dry-run");
    expect(manager.list().map((m) => m.slug).sort()).toEqual(["keep", "r6-a", "r6-b"]);
  });

  test("--pattern 与 <slug> 同时给 → 拒绝", () => {
    const manager = freshManager();
    manager.create("keep");
    const errs: string[] = [];
    const code = runProjectCommand(["archive", "keep", "--pattern", "k*"], { manager, err: (l) => errs.push(l), out: () => {} });
    expect(code).toBe(1);
    expect(manager.list().map((m) => m.slug)).toEqual(["keep"]);
  });

  test("再跑一遍是幂等的：已归档的不重复计入", () => {
    const manager = freshManager();
    manager.create("r6-a");
    runProjectCommand(["archive", "--pattern", "r6-*"], { manager, out: () => {} });
    const lines: string[] = [];
    runProjectCommand(["archive", "--pattern", "r6-*"], { manager, out: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("没有未归档的项目匹配");
  });
});

describe("δ-1 指针跳转", () => {
  test("归档当前项目 → 指针跳到最近活动的未归档项目，而不是置 null", () => {
    const manager = freshManager();
    for (const slug of ["speed-probe", "old-work", "recent-work"]) manager.create(slug);
    touch(manager, "old-work", new Date("2026-01-01T00:00:00Z"));
    touch(manager, "recent-work", new Date("2026-09-01T00:00:00Z"));
    manager.setCurrent("speed-probe");

    const lines: string[] = [];
    runProjectCommand(["archive", "--pattern", "speed-*"], { manager, out: (l) => lines.push(l) });

    // 接线断言：CLI 说出来的那句话与 state.json 里真正的指针必须一致。
    expect(manager.currentSlug()).toBe("recent-work");
    expect(lines.join("\n")).toContain("已自动切到最近活动的未归档项目 'recent-work'");
  });

  test("单个 slug 的 archive 走同一条跳转路径", () => {
    const manager = freshManager();
    manager.create("probe");
    manager.create("work");
    touch(manager, "work", new Date("2026-09-01T00:00:00Z"));
    manager.setCurrent("probe");
    const lines: string[] = [];
    runProjectCommand(["archive", "probe"], { manager, out: (l) => lines.push(l) });
    expect(manager.currentSlug()).toBe("work");
    expect(lines.join("\n")).toContain("'work'");
  });

  test("一个未归档项目都不剩 → 指针落回 null，并如实提示会新建 default", () => {
    const manager = freshManager();
    manager.create("only-one");
    manager.setCurrent("only-one");
    const lines: string[] = [];
    runProjectCommand(["archive", "--pattern", "only-*"], { manager, out: (l) => lines.push(l) });
    expect(manager.currentSlug()).toBe(null);
    expect(lines.join("\n")).toContain("default");
  });
});
