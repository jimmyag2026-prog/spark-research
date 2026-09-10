import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { biorxivConfig } from "../../backend/src/connectors/biorxiv";
import { runLitCommand } from "../../backend/src/literature/cli";
import { decodeCommonHtmlEntities, fromBiorxiv } from "../../backend/src/literature/normalize";
import type { LiteratureSearchResult } from "../../backend/src/literature/search";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import { buildReport } from "../../backend/src/report/export";

// W6-1 lane γ · CLI 上手性清扫（V54/V56）的输出断言。
//
// V54：bioRxiv「search 不是真检索」的 caveat 一直写在 capabilities 的 metadata.caveat
// 里，但 `lit sources` / `lit search` 两个人类入口只显示 ✅/免 key，caveat 看不见。
// 附带：bioRxiv 标题里的 HTML 实体（`&amp;` 等）未解码，会原样流进 BibTeX/报告。
//
// V56：① 未知顶层命令不回显打错的那个词；② `report export` 的湿实验条目不带
// unconsumedWarnings（README 明说 CLI 编译/审批输出必须显示它，报告是第三个面，
// 之前是缺口）；③ `report export` 把 observation 的 markdown 表格压成一行。

const roots: string[] = [];
const projects: Project[] = [];

function tmpRootDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fakeSearchResult(overrides: Partial<LiteratureSearchResult> = {}): LiteratureSearchResult {
  return {
    query: "q",
    papers: [],
    sources: [],
    totalBeforeDedupe: 0,
    mergedCount: 0,
    ...overrides,
  };
}

const BIORXIV_CAVEAT = biorxivConfig.metadata?.caveat ?? "";

describe("V54 · bioRxiv caveat 在人类入口可见", () => {
  test("capabilities 的 caveat 真源本身非空（否则下面两个断言测的是空字符串，毫无意义）", () => {
    expect(BIORXIV_CAVEAT).toBeTruthy();
    expect(BIORXIV_CAVEAT).toContain("不是");
  });

  test("lit sources：biorxiv 那一行带上 capabilities 同一份 caveat 文案", async () => {
    const root = tmpRootDir("w61-lit-sources-");
    const out: string[] = [];
    const code = await runLitCommand(["sources"], { root, out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("biorxiv");
    // 真源转发，不是手抄第二份文案：断言的是 biorxivConfig.metadata.caveat 本身的内容。
    expect(text).toContain(BIORXIV_CAVEAT);
  });

  test("lit sources：没有 caveat 的源不会被硬塞一行 ⚠️（比如 openalex）", async () => {
    const root = tmpRootDir("w61-lit-sources-noop-");
    const out: string[] = [];
    await runLitCommand(["sources"], { root, out: (l) => out.push(l), err: () => {} });
    const text = out.join("\n");
    const openalexBlock = text.split("openalex")[1]?.split(/\n\s*\S+\s+(凭据|免 key)/)[0] ?? "";
    expect(openalexBlock).not.toContain("⚠️");
  });

  test("lit search：biorxiv 命中一条结果时，caveat 跟着这个源的状态行一起打印", async () => {
    const root = tmpRootDir("w61-lit-search-");
    const out: string[] = [];
    const searcher = {
      search: async () =>
        fakeSearchResult({
          query: "long covid",
          sources: [{ source: "biorxiv", outcome: "ok", count: 1, elapsedMs: 5 }],
        }),
      fetchById: async () => fakeSearchResult(),
    } as never;
    const code = await runLitCommand(["search", "long", "covid"], {
      root,
      searcher,
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(BIORXIV_CAVEAT);
  });

  test("lit search：skipped 的源不重复刷已有的 note（caveat 只对真的查了的源生效）", async () => {
    const root = tmpRootDir("w61-lit-search-skipped-");
    const out: string[] = [];
    const searcher = {
      search: async () =>
        fakeSearchResult({
          sources: [{ source: "biorxiv", outcome: "skipped", count: 0, note: "未配置凭据", elapsedMs: 0 }],
        }),
      fetchById: async () => fakeSearchResult(),
    } as never;
    await runLitCommand(["search", "x"], { root, searcher, out: (l) => out.push(l), err: () => {} });
    const text = out.join("\n");
    expect(text).not.toContain(BIORXIV_CAVEAT);
  });
});

describe("V54 附带 · bioRxiv HTML 实体解码", () => {
  test("decodeCommonHtmlEntities：常见命名实体 + 数字实体都能还原", () => {
    expect(decodeCommonHtmlEntities("COVID-19 &amp; Long Covid")).toBe("COVID-19 & Long Covid");
    expect(decodeCommonHtmlEntities("A &lt;B&gt; C")).toBe("A <B> C");
    expect(decodeCommonHtmlEntities("caf&#233;")).toBe("café");
    expect(decodeCommonHtmlEntities("caf&#xe9;")).toBe("café");
    // 没有实体的普通文本原样通过。
    expect(decodeCommonHtmlEntities("plain title")).toBe("plain title");
  });

  test("fromBiorxiv：标题与摘要里的 &amp; 解码后再落进 Paper（不会流进 BibTeX/报告）", () => {
    const paper = fromBiorxiv({
      title: "Long-term outcomes &amp; recovery after COVID-19",
      doi: "10.1101/2024.01.01.000001",
      authors: "Doe, J.",
      date: "2024-01-01",
      abstract: "This study covers safety &amp; efficacy.",
      server: "biorxiv",
    });
    expect(paper).not.toBeNull();
    expect(paper!.title).toBe("Long-term outcomes & recovery after COVID-19");
    expect(paper!.title).not.toContain("&amp;");
    expect(paper!.abstract).toBe("This study covers safety & efficacy.");
  });
});

describe("V56① · 未知命令回显打错的那个词", () => {
  const REPO_ROOT = join(import.meta.dir, "../..");

  test("spark-research frobnicate → 提示里点名 'frobnicate'，退出码仍是 1", async () => {
    const proc = Bun.spawn(["bun", "backend/src/index.ts", "frobnicate"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(1);
    expect(stdout).toContain("frobnicate");
    expect(stdout).toContain("用法:"); // HELP 仍然打印，不是替换掉
  });

  test("零参数不受影响：不会被误判成「未知命令」（welcome 走的是另一条分支）", async () => {
    const dataDir = tmpRootDir("w61-zero-arg-");
    const proc = Bun.spawn(["bun", "backend/src/index.ts"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SPARK_RESEARCH_DATA_DIR: dataDir, KIMI_API_KEY: "", OPENROUTER_API_KEY: "" },
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).not.toContain("未知命令");
  });
});

describe("V56② · report export 携带湿实验的 unconsumedWarnings", () => {
  function workspace(slug: string) {
    const root = tmpRootDir(`w61-report-${slug}-`);
    const manager = new ProjectManager(root);
    const project = manager.create(slug, { description: "V56②" });
    projects.push(project);
    return { project, records: project.records() };
  }

  test("湿实验条目带 unconsumedWarnings 时，报告的实验区把它们列出来", () => {
    const { project, records } = workspace("wet-warn");
    records.create({
      type: "experiment",
      title: "配制次氯酸钠，浓度为10%",
      content: "# 实验",
      metadata: {
        kind: "experiment",
        mode: "wet",
        state: "compiled",
        backend: "opentrons_simulate",
        unconsumedWarnings: ["「浓度为10%」与试剂名分处不同分句，编译器不猜归属，未被 concentration_limit 消费"],
      },
    });
    const report = buildReport({ meta: project.meta, records });
    expect(report.markdown).toContain("未被安全门消费的告警");
    expect(report.markdown).toContain("未被 concentration_limit 消费");
  });

  test("没有 unconsumedWarnings（空数组/缺字段）时不显示这一段，不硬造空标题", () => {
    const { project, records } = workspace("wet-clean");
    records.create({
      type: "experiment",
      title: "干净的湿实验",
      content: "# 实验",
      metadata: {
        kind: "experiment",
        mode: "wet",
        state: "compiled",
        backend: "opentrons_simulate",
        unconsumedWarnings: [],
      },
    });
    const report = buildReport({ meta: project.meta, records });
    expect(report.markdown).not.toContain("未被安全门消费的告警");
  });

  test("干实验不受影响（该字段是湿实验专属，不会被误加到干实验条目上）", () => {
    const { project, records } = workspace("dry-untouched");
    records.create({
      type: "experiment",
      title: "干实验",
      content: "# 实验",
      metadata: { kind: "experiment", mode: "dry", state: "concluded", platform: "pyref", simKind: "x" },
    });
    const report = buildReport({ meta: project.meta, records });
    expect(report.markdown).not.toContain("未被安全门消费的告警");
  });
});

describe("V56③ · report export 不把 observation 的 markdown 表格压成一行", () => {
  function workspace(slug: string) {
    const root = tmpRootDir(`w61-report-table-${slug}-`);
    const manager = new ProjectManager(root);
    const project = manager.create(slug, { description: "V56③" });
    projects.push(project);
    return { project, records: project.records() };
  }

  test("observation 正文含表格时，报告里表格保留多行，不是一坨管道符", () => {
    const { project, records } = workspace("obs-table");
    const observation = records.create({
      type: "observation",
      title: "观察 · OD600",
      content: [
        "# 观察 · OD600 测定",
        "",
        "> 数据来源：Opentrons 官方模拟器。",
        "",
        "| 指标 | 值 |",
        "|------|-----|",
        "| od600 | 0.42 |",
      ].join("\n"),
      evidence: "observed",
      metadata: { kind: "wet_run_observation" },
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
        observationId: observation.id,
      },
    });
    const report = buildReport({ meta: project.meta, records });
    // 压成一行的旧 bug 长这样：一整行里同时出现表头分隔符与两行数据。
    expect(report.markdown).not.toContain("| 指标 | 值 | |------|-----|");
    // 修好之后，表格的每一行都应该独立成行地出现在 markdown 里。
    expect(report.markdown).toContain("| 指标 | 值 |");
    expect(report.markdown).toContain("|------|-----|");
    expect(report.markdown).toContain("| od600 | 0.42 |");
  });

  test("普通无表格的 observation 摘要仍然摊平成一行（不能把所有 observation 都改成多行）", () => {
    const { project, records } = workspace("obs-plain");
    const observation = records.create({
      type: "observation",
      title: "观察 · 能量衰减",
      content: "# 观察\n\n在 n=30 的样本上测得衰减时间常数缩短 3.1 倍（p=0.002）。",
      evidence: "computed",
      metadata: { kind: "simulation_summary" },
    });
    records.create({
      type: "experiment",
      title: "阻尼振子",
      content: "# 实验",
      metadata: {
        kind: "experiment",
        mode: "dry",
        state: "concluded",
        platform: "pyref",
        simKind: "x",
        observationId: observation.id,
      },
    });
    const report = buildReport({ meta: project.meta, records });
    expect(report.markdown).toContain("在 n=30 的样本上测得衰减时间常数缩短 3.1 倍（p=0.002）。");
  });
});

afterAll(() => {
  for (const project of projects.splice(0)) {
    try {
      project.close();
    } catch {
      /* 已关 */
    }
  }
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 已清或从未建 */
    }
  }
});
