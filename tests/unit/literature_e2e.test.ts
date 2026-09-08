import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportLibrary } from "../../backend/src/literature/export";
import { LibraryStore, paperFrom } from "../../backend/src/literature/library";
import { PdfDownloader } from "../../backend/src/literature/pdf";
import { runLitCommand } from "../../backend/src/literature/cli";
import { ProjectManager } from "../../backend/src/project/manager";
import {
  ADD_DOI,
  ARXIV_SAMPLE,
  CASSETTES,
  EUROPEPMC_SAMPLE,
  PER_SOURCE,
  SEARCH_QUERY,
  SEARCH_SOURCES,
  fixtureHttp,
  searcherWith,
} from "../helpers/literature_scenario";

// e2e 回放（无网络，CI 常驻）：跨源检索 → 去重合并 → 入库 → 引文边 → PDF → 导出。
// 所有响应来自 tests/fixtures/literature/*.json，由 tests/integration/literature_record.test.ts
// 在本地真实网络下录制。fixture 与本文件共用 tests/helpers/literature_scenario.ts 的参数。

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-e2e-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function newProject(slug = "e2e") {
  const manager = new ProjectManager(tmp);
  const project = manager.create(slug, { name: "e2e 项目" });
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  return { manager, project, library };
}

describe("e2e 回放 · 检索 → 去重 → 入库 → 导出", () => {
  test("跨源检索回放：三源成功、Semantic Scholar 429 被如实标注为 failed", async () => {
    const result = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, {
      sources: SEARCH_SOURCES,
      perSource: PER_SOURCE,
    });

    const byName = Object.fromEntries(result.sources.map((s) => [s.source, s]));
    expect(byName.openalex!.outcome).toBe("ok");
    expect(byName.crossref!.outcome).toBe("ok");
    expect(byName.europepmc!.outcome).toBe("ok");
    expect(byName.openalex!.count).toBe(PER_SOURCE);
    // 录制当时 Semantic Scholar 对未鉴权请求返回 429；这是真实世界状态，不是伪造。
    expect(byName.semanticscholar!.outcome).toBe("failed");
    expect(byName.semanticscholar!.error).toContain("HTTP 429");

    // 一个源失败不影响其余源的结果
    expect(result.papers.length).toBe(PER_SOURCE * 3);
    expect(result.papers.every((p) => p.title.length > 0)).toBe(true);
    // 归一化后应该大部分有 DOI
    expect(result.papers.filter((p) => p.doi !== null).length).toBeGreaterThan(20);
  });

  test("按 DOI 取单篇：三源命中同一 DOI → 去重合并成一条", async () => {
    const result = await searcherWith(CASSETTES.fetchById, "replay").fetchById(ADD_DOI, {
      sources: SEARCH_SOURCES,
    });
    expect(result.totalBeforeDedupe).toBe(3);
    expect(result.papers.length).toBe(1);
    expect(result.mergedCount).toBe(2);

    const paper = result.papers[0]!;
    expect(paper.doi).toBe(ADD_DOI);
    expect(paper.sources.sort()).toEqual(["crossref", "europepmc", "openalex"]);
    expect(paper.title.toLowerCase()).toContain("alphafold");
    expect(paper.year).toBe(2021);
    expect(paper.venue).toBe("Nature");
    expect(paper.authors.length).toBeGreaterThan(5);
    // 跨源合并把各家的独有字段补齐了
    expect(paper.ids.openalex).toBeTruthy();
    expect(paper.ids.pmid).toBeTruthy();
    expect(paper.abstract).toBeTruthy();
    expect(paper.references.length).toBeGreaterThan(0);
  });

  test("全链路：检索 → 入库 → 引文边 → 导出 BibTeX / CSL", async () => {
    const { project, library } = newProject();

    const searched = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, {
      sources: SEARCH_SOURCES,
      perSource: PER_SOURCE,
    });
    for (const paper of searched.papers) library.add(paper, { tags: ["background"] });
    expect(library.count()).toBe(searched.papers.length);

    // 再把 fetchById 的那一篇入库：它与检索结果里的同一篇应该合并而不是新增
    const fetched = await searcherWith(CASSETTES.fetchById, "replay").fetchById(ADD_DOI, {
      sources: SEARCH_SOURCES,
    });
    const before = library.count();
    const addResult = library.add(fetched.papers[0]!, { tags: ["key-paper"] });
    expect(addResult.merged).toBe(true);
    expect(library.count()).toBe(before);
    expect(addResult.paper.tags.sort()).toEqual(["background", "key-paper"]);

    // 幂等：同一批再入一次不新增
    for (const paper of searched.papers) library.add(paper);
    expect(library.count()).toBe(before);

    // 证据图联动：每篇论文一条 record
    const records = project.records();
    expect(records.list({ type: "paper" }).length).toBe(library.count());
    expect(library.list().every((p) => p.recordId !== null)).toBe(true);

    // 引文边：OpenAlex referenced_works 里落在库内的那些
    const edges = library.rebuildCitations();
    expect(edges).toBeGreaterThan(0);
    expect(library.citations().length).toBe(edges);
    // 证据图上同步出现 cites 边
    expect(records.listEdges("cites").length).toBe(edges);
    // 幂等
    expect(library.rebuildCitations()).toBe(0);

    // 导出 BibTeX
    const bib = exportLibrary(library.list(), "bibtex");
    const keys = [...bib.matchAll(/@\w+\{([^,]+),/g)].map((m) => m[1]!);
    expect(keys.length).toBe(library.count());
    expect(new Set(keys).size).toBe(keys.length); // key 唯一
    expect(bib).toContain("doi = {10.1038/s41586-021-03819-2}");

    // 导出 CSL-JSON
    const csl = JSON.parse(exportLibrary(library.list(), "csl"));
    expect(csl.length).toBe(library.count());
    expect(csl.every((item: { id: string; title: string }) => item.id && item.title)).toBe(true);
    const alphafold = csl.find((i: { DOI?: string }) => i.DOI === ADD_DOI);
    expect(alphafold.issued).toEqual({ "date-parts": [[2021]] });
    expect(alphafold["container-title"]).toBe("Nature");

    library.close();
    project.close();
  });

  test("PDF 下载回放：arXiv 与 Europe PMC 各一篇真实录制的 OA PDF", async () => {
    const { project, library } = newProject("pdf-e2e");
    const arxiv = library.add(
      paperFrom({
        title: ARXIV_SAMPLE.title,
        authors: [{ name: ARXIV_SAMPLE.author }],
        year: ARXIV_SAMPLE.year,
        ids: { arxiv: ARXIV_SAMPLE.arxivId },
      }),
    ).paper;
    const pmc = library.add(
      paperFrom({
        title: EUROPEPMC_SAMPLE.title,
        authors: [{ name: EUROPEPMC_SAMPLE.author }],
        year: EUROPEPMC_SAMPLE.year,
        ids: { pmcid: EUROPEPMC_SAMPLE.pmcid },
        isOpenAccess: true,
      }),
    ).paper;

    const results = await new PdfDownloader({
      http: fixtureHttp(CASSETTES.pdf, "replay"),
      papersDir: project.paths.papersDir,
      library,
    }).downloadMany([arxiv.id, pmc.id]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]!.origin).toBe("arxiv");
    expect(results[1]!.origin).toBe("europepmc");
    for (const result of results) {
      expect(existsSync(result.path!)).toBe(true);
      // fixture 里只保留截断样本，所以字节数是样本长度而不是原始大小；
      // 但 %PDF magic bytes 与 checksum 结构必须成立。
      expect(readFileSync(result.path!).subarray(0, 4).toString()).toBe("%PDF");
      expect(result.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      const stored = library.get(result.paperId)!;
      expect(stored.pdfStatus).toBe("downloaded");
      expect(stored.checksum).toBe(result.checksum!);
    }
    library.close();
    project.close();
  });

  test("CLI 全流程：lit search --add → lit list → lit export", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const manager = new ProjectManager(tmp);
    manager.create("cli-e2e", { name: "CLI e2e" });
    const deps = {
      manager,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      searcher: searcherWith(CASSETTES.search, "replay"),
    };

    expect(await runLitCommand(["search", SEARCH_QUERY, "--limit", String(PER_SOURCE), "--add", "--tag", "bg"], deps)).toBe(0);
    const searchOutput = out.join("\n");
    expect(searchOutput).toContain("去重合并掉");
    expect(searchOutput).toContain("--limit 截断后展示");
    expect(searchOutput).toContain("✅ openalex");
    // 失败源在 CLI 输出里必须可见，不能静默
    expect(searchOutput).toContain("❌ semanticscholar");
    expect(searchOutput).toContain("HTTP 429");
    expect(searchOutput).toContain("已入库项目 'cli-e2e'");

    out.length = 0;
    expect(await runLitCommand(["list"], deps)).toBe(0);
    expect(out.join("\n")).toContain("文献库：");
    expect(out.join("\n")).toContain("标签 bg");

    out.length = 0;
    const target = join(tmp, "refs.bib");
    expect(await runLitCommand(["export", "--format", "bibtex", "--out", target], deps)).toBe(0);
    expect(readFileSync(target, "utf8")).toContain("@");
    expect(out.join("\n")).toContain("已导出");

    out.length = 0;
    expect(await runLitCommand(["export", "--format", "nope"], deps)).toBe(1);
    expect(err.join("\n")).toContain("未知导出格式");

    out.length = 0;
    expect(await runLitCommand(["sources"], deps)).toBe(0);
    const sourcesOutput = out.join("\n");
    expect(sourcesOutput).toContain("openalex");
    // 凭据状态只显示「是否配置」，不显示值
    expect(sourcesOutput).toContain("aminer");
    expect(sourcesOutput).toMatch(/凭据(已|未)配置/);
  });

  test("CLI 错误路径：未知子命令 / 缺参数 / 帮助", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = { root: tmp, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await runLitCommand([], deps)).toBe(1);
    expect(out.join("\n")).toContain("用法:");
    expect(await runLitCommand(["help"], deps)).toBe(0);
    expect(await runLitCommand(["bogus"], deps)).toBe(1);
    expect(err.join("\n")).toContain("未知的 lit 子命令");
    expect(await runLitCommand(["search"], deps)).toBe(1);
    expect(await runLitCommand(["add"], deps)).toBe(1);
    expect(await runLitCommand(["pdf"], deps)).toBe(1);
    expect(await runLitCommand(["search", "x", "--sources", "not-a-source"], deps)).toBe(1);
    expect(err.join("\n")).toContain("未知文献源");
  });

  test("AMiner 回放：真实响应形态能被归一化（fixture 无任何凭据）", async () => {
    const raw = readFileSync(join(import.meta.dir, "..", "fixtures", "literature", "aminer-search.json"), "utf8");
    // 结构性保证：fixture 不含请求头，因此不可能含 token
    expect(raw).not.toContain("Authorization");
    expect(raw.toLowerCase()).not.toContain("bearer ");

    const { normalizeResponse } = await import("../../backend/src/literature/normalize");
    const payload = JSON.parse(JSON.parse(raw).entries[0].response.body);
    const papers = normalizeResponse("aminer", payload);
    expect(papers.length).toBe(3);
    expect(papers[0]!.doi).toBe("10.1038/s41586-021-03819-2");
    expect(papers[0]!.venue).toBe("Nature");
    expect(papers[0]!.year).toBe(2021);
    expect(papers[0]!.authors[0]!.name).toBe("John Jumper");
    expect(papers[0]!.ids.aminer).toBeTruthy();
    // n_citation_bucket 是 "5000+" 区间字符串，不硬转成数字
    expect(papers[0]!.citedByCount).toBeNull();
    expect(papers[0]!.sources).toEqual(["aminer"]);
  });
});
