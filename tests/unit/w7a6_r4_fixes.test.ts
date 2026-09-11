import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { JsonlRawSink } from "../../backend/src/raw";
import { exportProject } from "../../backend/src/data/export";
import { importExport } from "../../backend/src/data/import";
import { runLitCommand } from "../../backend/src/literature/cli";
import { StubHttp } from "../../backend/src/http/client";
import { LiteratureSearcher } from "../../backend/src/literature/search";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import type { Paper } from "../../backend/src/literature/models";
import { emptyPaper } from "../../backend/src/literature/models";

// v0.7 alpha.6 · R4 修复窗口的门禁：
//   P0-1 for-sharing 的 raw/llm prompt 只存 hash（上游摘要不出门）
//   P0-2 CLI 的 connector raw 落项目目录，不落全局
//   P0-3 stub 保留书目指针（title/DOI）
//   P1-4 lit search --json 真的是 JSON
//   P1-6 AMiner 拆词合并要求 ≥2 词同时命中

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "spark-a6-"));
  dirs.push(d);
  return d;
}

describe("P0-1/P0-3 · --for-sharing", () => {
  test("raw/llm 的 messages 只剩 hashOnly，产物 grep 不到 prompt 里的上游摘要；stub 带 title 与 DOI；导入后链可核", () => {
    const root = tmp();
    const manager = new ProjectManager(root);
    const project = manager.create("fs");
    const records = project.records();
    records.create({ type: "paper", title: "Upstream Title X", content: "UPSTREAM-ABSTRACT-ZZZ", provenanceClass: "upstream", origin: { kind: "connector", connector: "openalex", ref: "10.1/xyz" } });
    const sink = project.raw() as JsonlRawSink;
    sink.append({ kind: "llm", provenanceClass: "model_generated", license: "LicenseRef-spark-user-owned", payload: { provider: "p", model: "m", ok: true, failureKind: null, messages: sink.body(JSON.stringify([{ role: "user", content: "摘要: UPSTREAM-ABSTRACT-ZZZ 请精读" }])), response: sink.body("模型输出"), usage: { inputTokens: 1, outputTokens: 1, costUsd: null, usageUnavailable: false }, options: {} } });
    const result = exportProject(project, { forSharing: true, now: () => "2026-09-11T12:00:00.000Z" });
    expect(result.manifest.excluded.llmPromptsHashed).toBe(1);
    let all = "";
    for (const f of result.manifest.files) all += readFileSync(join(result.dir, f.path), "utf8");
    expect(all.includes("UPSTREAM-ABSTRACT-ZZZ")).toBe(false);
    expect(all.includes("模型输出")).toBe(true); // response 是模型产出，照常带
    expect(all.includes("Upstream Title X")).toBe(true); // stub 的书目指针
    expect(all.includes("10.1/xyz")).toBe(true);
    const imported = importExport(manager, result.dir, "fs-dst");
    expect(imported.verified).toBe(true);
    const stub = imported.project.records().list({ type: "paper" })[0]!;
    expect(stub.title).toBe("Upstream Title X");
    expect(stub.content).toBe("");
    expect((imported.project.raw() as JsonlRawSink).verify("llm").ok).toBe(true);
    imported.project.close();
    project.close();
  });
});

describe("P0-2 · CLI connector raw 落项目目录", () => {
  test("lit search（不注入 searcher）→ 项目 raw/connector 有行，全局兜底目录没有", async () => {
    const root = tmp();
    const dataDir = join(root, "data");
    const prev = process.env.SPARK_RESEARCH_DATA_DIR;
    process.env.SPARK_RESEARCH_DATA_DIR = dataDir;
    try {
      const manager = new ProjectManager(join(dataDir));
      const project = manager.create("cli-raw");
      project.close();
      const out: string[] = [];
      const code = await runLitCommand(["search", "alpha fold", "--project", "cli-raw", "--sources", "openalex", "--json"], {
        manager,
        http: StubHttp.json({ results: [] }),
        out: (l) => out.push(l),
        err: () => {},
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join("\n")) as { query: string; papers: unknown[]; sources: Array<{ source: string }> };
      expect(parsed.query).toBe("alpha fold");
      expect(Array.isArray(parsed.papers)).toBe(true);
      const projectRows = [...new JsonlRawSink(join(dataDir, "projects", "cli-raw", "raw")).iterate({ kind: "connector" })];
      expect(projectRows.length).toBeGreaterThanOrEqual(1);
      expect(projectRows[0]!.project).toBe("cli-raw");
      expect(projectRows[0]!.command).toBe("lit-search");
      expect(existsSync(join(dataDir, "raw", "connector"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SPARK_RESEARCH_DATA_DIR;
      else process.env.SPARK_RESEARCH_DATA_DIR = prev;
    }
  });
});

describe("P1-6 · AMiner 拆词合并查准", () => {
  const paper = (id: string, title: string): Paper => ({ ...emptyPaper(), title, ids: { aminer: id }, sources: ["aminer"] });
  class ScriptedRegistry extends ConnectorRegistry {
    constructor(private script: (q: string) => Paper[]) {
      super();
    }
    override get() {
      return { name: "aminer" } as never;
    }
    override async call(_c: string, _t: string, params: Record<string, unknown> = {}) {
      return { data: this.script(String(params.query)) };
    }
  }
  test("两词查询：同时命中的排前且单词命中被排除；全无双命中时退回并在 note 说明", async () => {
    const both = paper("b1", "脑机接口信号解码综述");
    const onlyA = paper("a1", "脑机接口伦理");
    const onlyB = paper("s1", "卫星信号解码算法");
    const searcher = new LiteratureSearcher(new ScriptedRegistry((q) => (q === "脑机接口 信号解码" ? [] : q === "脑机接口" ? [both, onlyA] : q === "信号解码" ? [both, onlyB] : [])), { segmenter: async () => ({ terms: null }) });
    const r = await searcher.search("脑机接口 信号解码", { sources: ["aminer"], perSource: 10 });
    expect(r.papers.map((p) => p.title)).toEqual(["脑机接口信号解码综述"]);
    expect(r.sources[0]!.note).toContain("≥2 词同时命中");
    const r2 = await new LiteratureSearcher(new ScriptedRegistry((q) => (q === "脑机接口" ? [onlyA] : q === "信号解码" ? [onlyB] : [])), { segmenter: async () => ({ terms: null }) }).search("脑机接口 信号解码", { sources: ["aminer"], perSource: 10 });
    expect(r2.papers.length).toBe(2);
    expect(r2.sources[0]!.note).toContain("退回单词命中");
  });
});

describe("V91（A6）· raw 导入按源文件顺序回放，不按 ts 重排", () => {
  test("同一 connector 文件里两行 ts 相同（并发 append）→ 导出/导入后链仍完整；import 结果逐链报告", () => {
    const root = tmp();
    const manager = new ProjectManager(root);
    const project = manager.create("order");
    const sink = project.raw() as JsonlRawSink;
    const ts = "2026-09-11T10:00:00.000Z";
    const mk = (i: number, connector: string) =>
      sink.append({ kind: "connector", provenanceClass: "upstream", license: "CC0-1.0", ts, payload: { connector, tool: "search", host: "h", method: "GET", params: { i }, status: 200, latencyMs: 1, contentType: null, response: sink.body(String(i)) } });
    // 故意让「后 append 的行」内容排序上靠前（params.i 递减），ts 完全相同——任何按 ts/内容重排都会断链。
    mk(3, "arxiv"); mk(2, "arxiv"); mk(1, "arxiv"); mk(9, "crossref"); mk(8, "crossref");
    expect(sink.verify("connector").ok).toBe(true);
    const result = exportProject(project, { now: () => "2026-09-11T11:00:00.000Z" });
    const imported = importExport(manager, result.dir, "order-dst");
    expect(imported.verification.raw.connector).toEqual({ ok: true, lines: 5 });
    expect(imported.verification.journal.ok).toBe(true);
    expect(imported.verified).toBe(true);
    const dst = imported.project.raw() as JsonlRawSink;
    expect([...dst.iterate({ kind: "connector" })].map((e) => (e.payload as unknown as { params: { i: number } }).params.i)).toEqual([3, 2, 1, 9, 8]);
    imported.project.close();
    project.close();
  });
});
