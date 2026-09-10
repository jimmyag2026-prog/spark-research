import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FindingsStore,
  FindingsStoreError,
  type FindingTarget,
} from "../../backend/src/reviewer/findings_store";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import { runReviewCommand } from "../../backend/src/reviewer/cli";

// v0.4 P13 lane W1-b：findings 状态机单测。
//
// 覆盖 DEVELOPMENT_PLAN_v0.4.md §4.3 / v0.3 §4.3.4 的三条硬约束：
//   1. 按 (checker, target, fingerprint) upsert 去重——同一个问题反复报不应变成 N 条
//   2. 复核闭环：下一轮仍命中 → reflagged + reflagCount++；不再命中 → resolved
//   3. mark-addressed 只能从 open/reflagged 转过去，且是状态机的守卫点
//
// 阴性对照见文末两个 test.skip 之外的专门用例（真正验证「去掉这段逻辑测试会红」在
// docs/devlog/W1-b.md 里记录的是手工临时改代码后重跑的终端输出；这里保留的是正面用例，
// 负面用例的断言本身已经隐含了「没有去重/没有 reflag 就会失败」的判据）。

const stores: FindingsStore[] = [];
const roots: string[] = [];
const projects: Project[] = [];

function newStore(): FindingsStore {
  const root = mkdtempSync(join(tmpdir(), "findings-store-"));
  roots.push(root);
  const store = new FindingsStore(join(root, "findings.db"));
  stores.push(store);
  return store;
}

function newWorkspace(slug = "w1b"): { manager: ProjectManager; project: Project } {
  const root = mkdtempSync(join(tmpdir(), "findings-cli-"));
  roots.push(root);
  const manager = new ProjectManager(root);
  const project = manager.create(slug);
  projects.push(project);
  return { manager, project };
}

afterAll(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* 已关 */
    }
  }
  for (const project of projects) {
    try {
      project.close();
    } catch {
      /* 已关 */
    }
  }
});

const TARGET: FindingTarget = { kind: "artifact", id: "artifact-1" };

describe("FindingsStore · 去重 upsert", () => {
  test("同一个 (checker, target, fingerprint) 报两次不会变成两条", () => {
    const store = newStore();
    store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "citation-integrity",
      hits: [{ severity: "hard", fingerprint: "fp-1", evidence: "第一次" }],
    });
    store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "citation-integrity",
      hits: [{ severity: "hard", fingerprint: "fp-1", evidence: "第二次证据" }],
    });

    const all = store.list({ project: "p1" });
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe("open");
    expect(all[0]!.evidence).toBe("第二次证据"); // 证据被刷新，不是堆叠
    expect(all[0]!.reflagCount).toBe(0); // 续命中不算 reflag
  });

  test("不同 fingerprint 是不同的 finding", () => {
    const store = newStore();
    store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "lineage",
      hits: [
        { severity: "soft", fingerprint: "fp-a" },
        { severity: "soft", fingerprint: "fp-b" },
      ],
    });
    expect(store.list({ project: "p1" })).toHaveLength(2);
  });

  test("不同 checker 对同一个 target/fingerprint 各算各的", () => {
    const store = newStore();
    store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "shared-fp" }],
    });
    store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-b",
      hits: [{ severity: "soft", fingerprint: "shared-fp" }],
    });
    expect(store.list({ project: "p1" })).toHaveLength(2);
  });
});

describe("FindingsStore · 复核闭环", () => {
  test("下一轮不再命中 → resolved", () => {
    const store = newStore();
    store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "hard", fingerprint: "fp-1" }],
    });
    const result = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [], // 这一轮什么都没查到
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.state).toBe("resolved");
    expect(store.get(result.resolved[0]!.id)!.state).toBe("resolved");
  });

  test("mark-addressed 之后仍命中 → reflagged 且 reflagCount 递增", () => {
    const store = newStore();
    const first = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "hard", fingerprint: "fp-1" }],
    });
    const id = first.findings[0]!.id;

    const addressed = store.markAddressed(id, { note: "已修复", actor: "jimmy" });
    expect(addressed.state).toBe("addressed");

    const second = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "hard", fingerprint: "fp-1" }], // 同样的问题又出现了
    });
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]!.state).toBe("reflagged");
    expect(second.findings[0]!.reflagCount).toBe(1);

    // 再命中一次，reflagCount 不会重复递增（已经是 reflagged，不是「重新从 addressed 转」）。
    const third = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "hard", fingerprint: "fp-1" }],
    });
    expect(third.findings[0]!.state).toBe("reflagged");
    expect(third.findings[0]!.reflagCount).toBe(1);
  });

  test("mark-addressed 之后不再命中 → resolved（复核确认修复有效）", () => {
    const store = newStore();
    const first = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "hard", fingerprint: "fp-1" }],
    });
    const id = first.findings[0]!.id;
    store.markAddressed(id, { actor: "jimmy" });

    const second = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [],
    });
    expect(second.resolved).toHaveLength(1);
    expect(store.get(id)!.state).toBe("resolved");
  });

  test("resolved 之后又命中 → 也会 reflag（不是只有 addressed 才会复发）", () => {
    const store = newStore();
    store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "fp-1" }],
    });
    store.reviewTarget({ project: "p1", target: TARGET, checker: "checker-a", hits: [] }); // → resolved
    const again = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "fp-1" }],
    });
    expect(again.findings[0]!.state).toBe("reflagged");
    expect(again.findings[0]!.reflagCount).toBe(1);
  });
});

describe("FindingsStore · mark-addressed 守卫", () => {
  test("不存在的 id 抛错", () => {
    const store = newStore();
    expect(() => store.markAddressed("nope")).toThrow(FindingsStoreError);
  });

  test("已经 resolved 的 finding 不能再 mark-addressed", () => {
    const store = newStore();
    const first = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "fp-1" }],
    });
    const id = first.findings[0]!.id;
    store.reviewTarget({ project: "p1", target: TARGET, checker: "checker-a", hits: [] }); // → resolved
    expect(store.get(id)!.state).toBe("resolved");
    expect(() => store.markAddressed(id)).toThrow(FindingsStoreError);
  });

  test("已经 addressed 的 finding 不能重复 mark-addressed", () => {
    const store = newStore();
    const first = store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "fp-1" }],
    });
    const id = first.findings[0]!.id;
    store.markAddressed(id, { actor: "a" });
    expect(() => store.markAddressed(id, { actor: "b" })).toThrow(FindingsStoreError);
  });
});

describe("FindingsStore · list 过滤", () => {
  test("--open 口径只包含 open / reflagged", () => {
    const store = newStore();
    // open
    store.reviewTarget({
      project: "p1",
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "fp-open" }],
    });
    // 会变成 resolved
    const willResolve = store.reviewTarget({
      project: "p1",
      target: { kind: "artifact", id: "artifact-2" },
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "fp-resolve" }],
    });
    store.reviewTarget({
      project: "p1",
      target: { kind: "artifact", id: "artifact-2" },
      checker: "checker-a",
      hits: [],
    });
    // 会变成 reflagged
    const willReflag = store.reviewTarget({
      project: "p1",
      target: { kind: "artifact", id: "artifact-3" },
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "fp-reflag" }],
    });
    store.markAddressed(willReflag.findings[0]!.id, { actor: "a" });
    store.reviewTarget({
      project: "p1",
      target: { kind: "artifact", id: "artifact-3" },
      checker: "checker-a",
      hits: [{ severity: "soft", fingerprint: "fp-reflag" }],
    });

    expect(willResolve.findings).toHaveLength(1);

    const open = store.list({ project: "p1", open: true });
    const states = open.map((f) => f.state).sort();
    expect(states).toEqual(["open", "reflagged"]);

    const all = store.list({ project: "p1" });
    expect(all).toHaveLength(3);
  });
});

describe("review CLI", () => {
  test("findings --open 在没有任何 finding 时给出空态提示", async () => {
    const { manager } = newWorkspace("cli-empty");
    const lines: string[] = [];
    const code = await runReviewCommand(["findings", "--open"], {
      manager,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR: ${l}`),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("没有仍需要关注的 finding");
  });

  test("mark-addressed 走 CLI 到 store 的完整路径，并驱动一次复核闭环", async () => {
    // 每次 runReviewCommand 都会像真实 CLI 进程那样 open→用→close 自己的 FindingsStore
    // （makeStore 在没有注入 deps.store 时如此）——所以这里种子数据、以及事后校验都各开
    // 一个**新的** FindingsStore 指向同一个 db 文件，而不是复用一个跨 close() 的实例
    // （bun:sqlite 的 Database 一旦 close() 就不能再用，复用会直接抛错）。
    // 这与 Project.records() 的惰性重开模式（close 后再调用会重新 new 一个 RecordStore）
    // 是同一套纪律。
    const { manager, project } = newWorkspace("cli-full");
    const dbPath = join(project.paths.root, "findings.db");
    const seed = new FindingsStore(dbPath);
    const created = seed.reviewTarget({
      project: project.slug,
      target: TARGET,
      checker: "checker-a",
      hits: [{ severity: "hard", fingerprint: "fp-cli" }],
    });
    const id = created.findings[0]!.id;
    seed.close();

    const lines: string[] = [];
    const code = await runReviewCommand(["mark-addressed", id, "--note", "修好了", "--actor", "jimmy"], {
      manager,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR: ${l}`),
    });
    expect(code).toBe(0);

    const verify = new FindingsStore(dbPath);
    stores.push(verify);
    expect(verify.get(id)!.state).toBe("addressed");
    expect(verify.get(id)!.note).toBe("修好了");
    expect(verify.get(id)!.resolvedBy).toBe("jimmy");

    // 未知 id 应该走错误路径、退出码 1。
    const badLines: string[] = [];
    const badCode = await runReviewCommand(["mark-addressed", "does-not-exist"], {
      manager,
      out: (l) => badLines.push(l),
      err: (l) => badLines.push(`ERR: ${l}`),
    });
    expect(badCode).toBe(1);
    expect(badLines.join("\n")).toContain("不存在");
  });

  test("未知子命令返回退出码 1", async () => {
    const { manager } = newWorkspace("cli-unknown");
    const code = await runReviewCommand(["bogus"], { manager, out: () => {}, err: () => {} });
    expect(code).toBe(1);
  });
});
