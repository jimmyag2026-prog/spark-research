import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConclusionReviewer } from "../../backend/src/conclusion/reviewer";
import { ConclusionStore } from "../../backend/src/conclusion/store";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import type { RecordStore } from "../../backend/src/project/records";
import { runReportCommand } from "../../backend/src/report/cli";
import { buildReport } from "../../backend/src/report/export";

// P8-gate G7：证据图 → Markdown 报告。
//
// 报告最重要的性质是**可核对**：每条结论下面的每条证据都带 record id，
// 拿 id 回到 records.db 能找到同一条记录。这里逐条断言这件事。

const roots: string[] = [];
const projects: Project[] = [];

function newWorkspace(slug = "report") {
  const root = mkdtempSync(join(tmpdir(), "report-test-"));
  roots.push(root);
  const manager = new ProjectManager(root);
  const project = manager.create(slug, { description: "验证阻尼系数对能量衰减的影响" });
  projects.push(project);
  return { root, manager, project };
}

function observation(records: RecordStore, extra: Record<string, unknown> = {}): string {
  return records.create({
    type: "observation",
    title: "观察 · 能量衰减",
    content: "# 观察\n\n在 n=30 的样本上测得衰减时间常数缩短 3.1 倍（p=0.002）。",
    evidence: "computed",
    metadata: { kind: "simulation_summary", runId: "run-1", experimentId: "exp-1", deterministic: true, ...extra },
  }).id;
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

describe("buildReport", () => {
  test("空项目也能出报告，各区给出「暂无」而不是崩", () => {
    const { project } = newWorkspace("empty");
    const report = buildReport({ meta: project.meta, records: project.records(), generatedAt: "2026-09-09T00:00:00Z" });
    expect(report.markdown).toContain("## 一、问题");
    expect(report.markdown).toContain("## 二、思路");
    expect(report.markdown).toContain("## 三、实验");
    expect(report.markdown).toContain("## 四、结论");
    expect(report.markdown).toContain("## 五、待验证");
    expect(report.markdown).toContain("（暂无 idea 卡）");
    expect(report.markdown).toContain("（暂无通过评审的结论）");
    expect(report.counts.approvedConclusions).toBe(0);
  });

  test("approved 进结论区，pending 与 vetoed 进待验证区", () => {
    const { project } = newWorkspace("gate");
    const records = project.records();
    const store = new ConclusionStore(records);
    const reviewer = new ConclusionReviewer(records, { store });

    const passed = store.create({ claim: "阻尼系数升高使衰减更快", evidenceIds: [observation(records)] });
    reviewer.review(passed, { actor: "张三", actorSource: "explicit" });

    const pending = store.create({ claim: "还没评审的结论", evidenceIds: [observation(records)] });
    const vetoed = store.create({ claim: "证据是编的", evidenceIds: ["ghost-record"] });
    reviewer.review(vetoed, { actor: "张三" });

    const report = buildReport({ meta: project.meta, records, generatedAt: "2026-09-09T00:00:00Z" });
    const conclusionSection = report.markdown.split("## 四、结论")[1]!.split("## 五、待验证")[0]!;
    const pendingSection = report.markdown.split("## 五、待验证")[1]!.split("## 附录 A")[0]!;

    expect(conclusionSection).toContain(passed.claim);
    expect(conclusionSection).not.toContain(pending.claim);
    expect(conclusionSection).not.toContain(vetoed.claim);
    expect(pendingSection).toContain(pending.claim);
    expect(pendingSection).toContain(vetoed.claim);
    expect(pendingSection).toContain("dangling_evidence");
    expect(report.counts.approvedConclusions).toBe(1);
    expect(report.counts.unverifiedConclusions).toBe(2);
  });

  test("门槛看已落的状态，不看「现在跑一遍会通过」", () => {
    const { project } = newWorkspace("not-self-approving");
    const records = project.records();
    const store = new ConclusionStore(records);
    // 这张卡跑检查器会全过，但没人评审过它。
    const card = store.create({ claim: "干净但没评审的结论", evidenceIds: [observation(records)] });
    expect(new ConclusionReviewer(records, { store }).assess(card).wouldApprove).toBe(true);

    const report = buildReport({ meta: project.meta, records });
    expect(report.counts.approvedConclusions).toBe(0);
    expect(report.markdown.split("## 五、待验证")[1]).toContain("pending（尚未评审）");
    // 并且要告诉读者怎么把它推进结论区。
    expect(report.markdown).toContain("conclusion review");
  });

  test("每条证据都能拿 record id 回到 records.db", () => {
    const { project } = newWorkspace("traceable");
    const records = project.records();
    const store = new ConclusionStore(records);
    const obsId = observation(records);
    const card = store.create({ claim: "结论", evidenceIds: [obsId] });
    new ConclusionReviewer(records, { store }).review(card, { actor: "张三" });

    const report = buildReport({ meta: project.meta, records });
    expect(report.markdown).toContain(obsId);
    expect(report.markdown).toContain(card.recordId);
    // 附录索引里出现的每个 id 都必须是真的。
    expect(report.recordIds.length).toBeGreaterThan(0);
    for (const id of report.recordIds) expect(records.get(id)).not.toBeNull();
  });

  test("G4：非确定性平台的证据 → 区间/趋势对账措辞，不声称逐位可复现", () => {
    const { project } = newWorkspace("nondet");
    const records = project.records();
    const store = new ConclusionStore(records);
    const card = store.create({
      claim: "在该温度下体系保持稳定",
      evidenceIds: [observation(records, { deterministic: false })],
    });
    new ConclusionReviewer(records, { store }).review(card, { actor: "张三" });

    const report = buildReport({ meta: project.meta, records });
    expect(report.markdown).toContain("区间/趋势对账");
    expect(report.markdown).toContain("非确定性平台");
    expect(report.markdown).not.toContain("逐位重算对账");
  });

  test("G4：模拟读数在报告里带 [模拟数据] 标记与免责句", () => {
    const { project } = newWorkspace("sim");
    const records = project.records();
    const store = new ConclusionStore(records);
    const card = store.create({
      claim: "协议在协议引擎里可执行",
      limitations: "读数来自 Opentrons 模拟器，不是真实实验数据",
      evidenceIds: [observation(records, { kind: "wet_run_observation", simulated: true })],
      mode: "wet",
    });
    const result = new ConclusionReviewer(records, { store }).review(card, { actor: "张三" });
    expect(result.approved).toBe(true);

    const report = buildReport({ meta: project.meta, records });
    expect(report.markdown).toContain("[模拟数据]");
    expect(report.markdown).toContain("模拟器验证的是协议在协议引擎里是否合法，不验证生物学");
  });

  test("实验区把干湿实验、状态与审批人写进去", () => {
    const { project } = newWorkspace("experiments");
    const records = project.records();
    records.create({
      type: "experiment",
      title: "阻尼振子",
      content: "# 实验",
      metadata: { kind: "experiment", mode: "dry", state: "concluded", platform: "pyref", simKind: "damped-oscillator", runId: "r1" },
    });
    records.create({
      type: "experiment",
      title: "OD600 测定",
      content: "# 实验",
      metadata: {
        kind: "experiment",
        mode: "wet",
        state: "concluded",
        backend: "opentrons_simulate",
        approval: { actor: "李四", at: "2026-09-09T01:00:00Z", protocolHash: "abc123" },
      },
    });
    const report = buildReport({ meta: project.meta, records });
    expect(report.counts.dryExperiments).toBe(1);
    expect(report.counts.wetExperiments).toBe(1);
    expect(report.markdown).toContain("pyref / damped-oscillator");
    expect(report.markdown).toContain("人工批准：李四");
    expect(report.markdown).toContain("（模拟）");
  });

  test("S10：正文没有点名引用任何 record 时，附录 A 说明而不是留空表装没事", () => {
    const { project } = newWorkspace("no-citations");
    const records = project.records();
    // 只有论文与精读卡，没有 idea/实验/结论去引用它们——正文不会 track 到任何 record id，
    // 但 stats 仍会显示「论文 N」。这正是验收者被误导的场景（S10）。
    records.create({ type: "paper", title: "从不被引用的论文", content: "abs", evidence: "sourced" });
    records.create({ type: "reading", title: "精读卡", content: "# 精读", evidence: "sourced" });

    const report = buildReport({ meta: project.meta, records, generatedAt: "2026-09-10T00:00:00Z" });
    expect(report.recordIds.length).toBe(0);
    expect(report.markdown).toContain("## 附录 A · 证据索引");
    // 必须显式说明「不代表证据图是空的」，且指去能看全量 record 的命令——不能是裸空表。
    expect(report.markdown).toContain("不代表证据图是空的");
    expect(report.markdown).toContain("spark-research report records");
    expect(report.markdown).toContain("spark-research report show");
  });

  test("思路区带 novelty 状态与支持/反对文献边", () => {
    const { project } = newWorkspace("ideas");
    const records = project.records();
    const paper = records.create({ type: "paper", title: "AlphaFold", content: "abs", evidence: "sourced" });
    const idea = records.create({
      type: "idea",
      title: "思路：用扩散模型做侧链打包",
      content: "# 思路",
      metadata: {
        kind: "idea_card",
        hypothesis: "扩散模型可以改进侧链打包",
        noveltyStatus: "checked-incremental",
        openQuestions: ["能否泛化到膜蛋白？"],
      },
    });
    records.link(paper.id, idea.id, "supports");

    const report = buildReport({ meta: project.meta, records });
    expect(report.markdown).toContain("checked-incremental");
    expect(report.markdown).toContain("能否泛化到膜蛋白？");
    expect(report.markdown).toContain("AlphaFold");
    expect(report.counts.ideas).toBe(1);
  });
});

describe("report CLI", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  }

  test("export --out 写文件并汇报统计", async () => {
    const { root, manager } = newWorkspace("cli-export");
    const project = manager.defaultProject();
    const records = project.records();
    const store = new ConclusionStore(records);
    const card = store.create({ claim: "结论 A", evidenceIds: [observation(records)] });
    new ConclusionReviewer(records, { store }).review(card, { actor: "张三" });
    project.close();

    const target = join(root, "report.md");
    const cap = capture();
    const code = await runReportCommand(["export", "--out", target], { root, ...cap.deps });
    expect(code).toBe(0);
    expect(existsSync(target)).toBe(true);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("# 研究报告");
    expect(text).toContain("结论 A");
    expect(cap.out.join("\n")).toContain("报告已写入");
  });

  test("结论区为空但有待验证结论时给出警告", async () => {
    const { root, manager } = newWorkspace("cli-warn");
    const project = manager.defaultProject();
    const records = project.records();
    new ConclusionStore(records).create({ claim: "没评审的结论", evidenceIds: [observation(records)] });
    project.close();

    const target = join(root, "r.md");
    const cap = capture();
    expect(await runReportCommand(["export", "--out", target], { root, ...cap.deps })).toBe(0);
    expect(cap.err.join("\n")).toContain("结论区是空的");
  });

  test("export --json / stats --json", async () => {
    const { root } = newWorkspace("cli-json");
    const cap = capture();
    expect(await runReportCommand(["export", "--json"], { root, ...cap.deps })).toBe(0);
    const parsed = JSON.parse(cap.out.join("\n")) as { markdown: string; counts: Record<string, number> };
    expect(parsed.markdown).toContain("# 研究报告");
    expect(parsed.counts.approvedConclusions).toBe(0);

    const stats = capture();
    expect(await runReportCommand(["stats", "--json"], { root, ...stats.deps })).toBe(0);
    expect(JSON.parse(stats.out.join("\n")).counts).toBeDefined();
  });

  test("未知子命令给帮助并退非零", async () => {
    const { root } = newWorkspace("cli-bad");
    const cap = capture();
    expect(await runReportCommand(["frobnicate"], { root, ...cap.deps })).toBe(1);
    expect(cap.err.join("\n")).toContain("未知的 report 子命令");
    const none = capture();
    expect(await runReportCommand([], { root, ...none.deps })).toBe(1);
  });
});
