import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import { runReportCommand } from "../../backend/src/report/cli";

// S11（第二次零上下文外部验收里最要紧的一条）：验收者想回答「它到底进没进证据图」，
// 试了 `report stats`（不含 artifact）、`report export`（附录空表，见 S10）、
// 猜了 records/record/graph 三个命令名都不是——最后只能自己开 sqlite 查 records.db。
// 这里验证补上的 `report records` / `report show` 真的能回答这个问题，不用开 sqlite。

const roots: string[] = [];
const projects: Project[] = [];

function newWorkspace(slug = "report-records") {
  const root = mkdtempSync(join(tmpdir(), "report-records-test-"));
  roots.push(root);
  const manager = new ProjectManager(root);
  const project = manager.create(slug, { description: "S11 证据图可见性" });
  projects.push(project);
  return { root, manager, project };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

afterAll(() => {
  for (const project of projects) {
    try {
      project.close();
    } catch {
      /* 已关 */
    }
  }
});

describe("report records", () => {
  test("列出全部 record，含 artifact 类型——这是 S11 的核心", async () => {
    const { root, manager } = newWorkspace("cli-records-artifact");
    const project = manager.defaultProject();
    const records = project.records();
    records.create({ type: "idea", title: "思路 A", content: "# 思路", evidence: "inferred" });
    const artifact = records.create({
      type: "artifact",
      title: "harvest/output.csv",
      content: "artifact output.csv",
      evidence: "computed",
      artifactId: "art-fixture-1",
    });
    project.close();

    const cap = capture();
    const code = await runReportCommand(["records"], { root, ...cap.deps });
    expect(code).toBe(0);
    const text = cap.out.join("\n");
    expect(text).toContain("思路 A");
    expect(text).toContain("artifact"); // 类型列
    expect(text).toContain(artifact.id.slice(0, 8));
    expect(text).toContain(`artifact ${artifact.artifactId!.slice(0, 8)}`);
  });

  test("--type artifact 只过滤出 artifact record", async () => {
    const { root, manager } = newWorkspace("cli-records-type-filter");
    const project = manager.defaultProject();
    const records = project.records();
    records.create({ type: "idea", title: "思路 B", content: "# 思路", evidence: "inferred" });
    records.create({
      type: "artifact",
      title: "harvest/result.json",
      content: "artifact result.json",
      evidence: "computed",
      artifactId: "art-fixture-2",
    });
    project.close();

    const cap = capture();
    expect(await runReportCommand(["records", "--type", "artifact"], { root, ...cap.deps })).toBe(0);
    const text = cap.out.join("\n");
    expect(text).toContain("result.json");
    expect(text).not.toContain("思路 B");
  });

  test("--json 给出机器可读形状，total 与 shown 分开", async () => {
    const { root, manager } = newWorkspace("cli-records-json");
    const project = manager.defaultProject();
    project.records().create({ type: "idea", title: "思路 C", content: "# 思路", evidence: "inferred" });
    project.close();

    const cap = capture();
    expect(await runReportCommand(["records", "--json"], { root, ...cap.deps })).toBe(0);
    const parsed = JSON.parse(cap.out.join("\n")) as { total: number; shown: number; records: unknown[] };
    expect(parsed.total).toBe(1);
    expect(parsed.shown).toBe(1);
    expect(parsed.records.length).toBe(1);
  });

  test("--limit 截断并在人类输出里提示还有更多", async () => {
    const { root, manager } = newWorkspace("cli-records-limit");
    const project = manager.defaultProject();
    const records = project.records();
    for (let i = 0; i < 5; i++) {
      records.create({ type: "idea", title: `思路 ${i}`, content: "# 思路", evidence: "inferred" });
    }
    project.close();

    const cap = capture();
    expect(await runReportCommand(["records", "--limit", "2"], { root, ...cap.deps })).toBe(0);
    const text = cap.out.join("\n");
    expect(text).toContain("共 5 条");
    expect(text).toContain("显示前 2 条");
  });

  test("未知 --type 给出可见错误与可选值，不静默返回空列表", async () => {
    const { root } = newWorkspace("cli-records-bad-type");
    const cap = capture();
    const code = await runReportCommand(["records", "--type", "not-a-type"], { root, ...cap.deps });
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("未知的 record 类型");
  });

  test("空项目给出「没有任何 record」而不是空白输出", async () => {
    const { root } = newWorkspace("cli-records-empty");
    const cap = capture();
    expect(await runReportCommand(["records"], { root, ...cap.deps })).toBe(0);
    expect(cap.out.join("\n")).toContain("还没有任何 record");
  });
});

describe("report show", () => {
  test("单条详情带类型/证据/来源/metadata，以及入边出边", async () => {
    const { root, manager } = newWorkspace("cli-show-basic");
    const project = manager.defaultProject();
    const records = project.records();
    const paper = records.create({ type: "paper", title: "AlphaFold", content: "abs", evidence: "sourced" });
    const idea = records.create({
      type: "idea",
      title: "思路：结构预测",
      content: "# 思路正文",
      evidence: "inferred",
      metadata: { hypothesis: "h1" },
    });
    records.link(paper.id, idea.id, "supports");
    project.close();

    const cap = capture();
    expect(await runReportCommand(["show", idea.id], { root, ...cap.deps })).toBe(0);
    const text = cap.out.join("\n");
    expect(text).toContain(idea.id);
    expect(text).toContain("思路：结构预测");
    expect(text).toContain("思路正文");
    expect(text).toContain("hypothesis");
    expect(text).toContain("入边（1）");
    expect(text).toContain(paper.id);
    expect(text).toContain("supports");
  });

  test("--json 返回 record + edges", async () => {
    const { root, manager } = newWorkspace("cli-show-json");
    const project = manager.defaultProject();
    const records = project.records();
    const rec = records.create({ type: "idea", title: "思路 D", content: "# 思路", evidence: "inferred" });
    project.close();

    const cap = capture();
    expect(await runReportCommand(["show", rec.id, "--json"], { root, ...cap.deps })).toBe(0);
    const parsed = JSON.parse(cap.out.join("\n")) as { record: { id: string }; edges: { outgoing: unknown[]; incoming: unknown[] } };
    expect(parsed.record.id).toBe(rec.id);
    expect(parsed.edges.outgoing).toEqual([]);
    expect(parsed.edges.incoming).toEqual([]);
  });

  test("不存在的 id → 可见失败 + 下一步指引，不返回空壳装作成功", async () => {
    const { root } = newWorkspace("cli-show-missing");
    const cap = capture();
    const code = await runReportCommand(["show", "does-not-exist"], { root, ...cap.deps });
    expect(code).toBe(1);
    const errText = cap.err.join("\n");
    expect(errText).toContain("不存在");
    expect(errText).toContain("report records");
    // 绝不能悄悄打印一个「看起来成功」的空结构到 stdout。
    expect(cap.out.join("\n")).toBe("");
  });

  test("不给 id → 用法提示，退非零", async () => {
    const { root } = newWorkspace("cli-show-no-arg");
    const cap = capture();
    const code = await runReportCommand(["show"], { root, ...cap.deps });
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("用法");
  });
});
