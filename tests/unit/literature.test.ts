import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AMinerConnector,
  AMINER_CONNECTOR_ID,
  AMINER_CREDENTIAL_KEY,
  credentialMissingResult,
  isCredentialMissing,
} from "../../backend/src/connectors/aminer";
import {
  CrossRefConnector,
  EuropePMCConnector,
  OpenAlexConnector,
  S2_CONNECTOR_ID,
  S2_CREDENTIAL_KEY,
  SemanticScholarConnector,
  europePmcIdQuery,
  openAlexEntityId,
  semanticScholarPaperId,
} from "../../backend/src/connectors/literature";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import {
  PLACEHOLDER_CONTACT_EMAIL,
  contactEmail,
  isContactEmailConfigured,
  userAgent,
} from "../../backend/src/connectors/politeness";
import { BufferedResponse, StubHttp } from "../../backend/src/http/client";
import { FixtureHttp, FixtureMissError, canonicalUrl, fixtureKey } from "../../backend/src/http/fixture";
import { canMerge, dedupePapers, mergePapers } from "../../backend/src/literature/dedupe";
import {
  assignBibtexKeys,
  bibtexBaseKey,
  escapeBibTeX,
  toBibTeX,
  toCSLJSON,
  toCSLName,
  titleFirstWord,
} from "../../backend/src/literature/export";
import { LibraryStore, paperFrom, toPaper } from "../../backend/src/literature/library";
import { normalizeDoi, titleKey, titleSimilarity, type Paper } from "../../backend/src/literature/models";
import { retractOrphanRecords } from "../../backend/src/literature/reading";
import {
  fromCrossRef,
  fromEuropePMC,
  fromOpenAlex,
  fromSemanticScholar,
  normalizeResponse,
  reconstructInvertedAbstract,
} from "../../backend/src/literature/normalize";
import { PdfDownloader, pdfCandidates, pdfFilename } from "../../backend/src/literature/pdf";
import { LiteratureSearcher } from "../../backend/src/literature/search";
import { ProjectManager } from "../../backend/src/project/manager";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-lit-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function paper(overrides: Partial<Paper> & { title: string }): Paper {
  return paperFrom(overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("归一化 · 字段映射", () => {
  test("OpenAlex：倒排索引摘要还原 + 作者/venue/OA 直链", () => {
    const work = {
      id: "https://openalex.org/W2741809807",
      display_name: "Highly accurate protein structure prediction",
      publication_year: 2021,
      doi: "https://doi.org/10.1038/S41586-021-03819-2",
      cited_by_count: 12345,
      abstract_inverted_index: { Protein: [0], structure: [1], prediction: [2], works: [3] },
      authorships: [
        { author: { display_name: "John Jumper" }, institutions: [{ display_name: "DeepMind" }] },
        { author: { display_name: "Richard Evans" }, institutions: [] },
      ],
      primary_location: { source: { display_name: "Nature" }, landing_page_url: "https://nature.com/x" },
      open_access: { is_oa: true },
      best_oa_location: { pdf_url: "https://example.org/a.pdf" },
      ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/34265844", pmcid: "https://www.ncbi.nlm.nih.gov/pmc/PMC8371605" },
      referenced_works: ["https://openalex.org/W111", "https://openalex.org/W222"],
    };
    const p = fromOpenAlex(work)!;
    expect(p.title).toBe("Highly accurate protein structure prediction");
    expect(p.abstract).toBe("Protein structure prediction works");
    expect(p.doi).toBe("10.1038/s41586-021-03819-2");
    expect(p.year).toBe(2021);
    expect(p.venue).toBe("Nature");
    expect(p.authors.map((a) => a.name)).toEqual(["John Jumper", "Richard Evans"]);
    expect(p.authors[0]!.affiliation).toBe("DeepMind");
    expect(p.ids.openalex).toBe("W2741809807");
    expect(p.ids.pmid).toBe("34265844");
    expect(p.ids.pmcid).toBe("PMC8371605");
    expect(p.isOpenAccess).toBe(true);
    expect(p.pdfUrl).toBe("https://example.org/a.pdf");
    expect(p.references).toEqual(["W111", "W222"]);
    expect(p.sources).toEqual(["openalex"]);
  });

  test("CrossRef：title 数组、date-parts 年份、HTML 摘要清洗", () => {
    const p = fromCrossRef({
      title: ["A Study of Things"],
      author: [{ given: "Ada", family: "Lovelace" }],
      issued: { "date-parts": [[1843, 7]] },
      "container-title": ["Journal of Notes"],
      DOI: "10.1000/XYZ.123",
      "is-referenced-by-count": 7,
      abstract: "<jats:p>Some abstract</jats:p>",
      URL: "https://doi.org/10.1000/xyz.123",
      link: [{ "content-type": "application/pdf", URL: "https://pub.example/a.pdf" }],
    })!;
    expect(p.title).toBe("A Study of Things");
    expect(p.year).toBe(1843);
    expect(p.venue).toBe("Journal of Notes");
    expect(p.doi).toBe("10.1000/xyz.123");
    expect(p.authors[0]!.name).toBe("Ada Lovelace");
    expect(p.abstract).toBe("Some abstract");
    expect(p.citedByCount).toBe(7);
    expect(p.pdfUrl).toBe("https://pub.example/a.pdf");
  });

  test("Europe PMC：authorList / OA 标志 / PDF 直链", () => {
    const p = fromEuropePMC({
      id: "34265844",
      pmid: "34265844",
      pmcid: "PMC8371605",
      title: "Highly accurate protein structure prediction with AlphaFold.",
      authorList: { author: [{ fullName: "Jumper J" }, { fullName: "Evans R" }] },
      pubYear: "2021",
      journalTitle: "Nature",
      doi: "10.1038/s41586-021-03819-2",
      abstractText: "Proteins are essential.",
      isOpenAccess: "Y",
      citedByCount: 100,
      fullTextUrlList: {
        fullTextUrl: [
          { documentStyle: "html", url: "https://europepmc.org/article/MED/34265844" },
          { documentStyle: "pdf", url: "https://europepmc.org/pdf/PMC8371605" },
        ],
      },
    })!;
    expect(p.title).toBe("Highly accurate protein structure prediction with AlphaFold");
    expect(p.authors.map((a) => a.name)).toEqual(["Jumper J", "Evans R"]);
    expect(p.isOpenAccess).toBe(true);
    expect(p.pdfUrl).toBe("https://europepmc.org/pdf/PMC8371605");
    expect(p.ids.pmcid).toBe("PMC8371605");
    expect(p.year).toBe(2021);
  });

  test("Semantic Scholar：externalIds 拆解 + openAccessPdf", () => {
    const p = fromSemanticScholar({
      paperId: "abc123",
      title: "Attention Is All You Need",
      year: 2017,
      venue: "NeurIPS",
      authors: [{ name: "Ashish Vaswani" }],
      externalIds: { DOI: "10.5555/3295222.3295349", ArXiv: "1706.03762", PubMed: "999" },
      openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762" },
      citationCount: 50000,
      isOpenAccess: true,
    })!;
    expect(p.ids.arxiv).toBe("1706.03762");
    expect(p.ids.semanticscholar).toBe("abc123");
    expect(p.ids.pmid).toBe("999");
    expect(p.doi).toBe("10.5555/3295222.3295349");
    expect(p.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
  });

  test("字段缺失/类型异常不抛错，落 null", () => {
    expect(fromOpenAlex(null)).toBeNull();
    expect(fromCrossRef({ author: "not-an-array" })).toBeNull();
    const p = fromSemanticScholar({ title: "Bare", authors: "oops", year: "nonsense" })!;
    expect(p.year).toBeNull();
    expect(p.authors).toEqual([]);
    expect(p.doi).toBeNull();
  });

  test("normalizeResponse 按源提取列表包装层", () => {
    expect(normalizeResponse("openalex", { results: [{ display_name: "A" }] }).length).toBe(1);
    expect(normalizeResponse("crossref", { message: { items: [{ title: ["B"] }] } }).length).toBe(1);
    expect(normalizeResponse("europepmc", { resultList: { result: [{ title: "C" }] } }).length).toBe(1);
    expect(normalizeResponse("semanticscholar", { data: [{ title: "D" }] }).length).toBe(1);
    expect(normalizeResponse("aminer", { data: { hitList: [{ title: "E" }] } }).length).toBe(1);
    expect(normalizeResponse("openalex", { results: [] })).toEqual([]);
  });

  test("倒排摘要为空/异常时返回 null", () => {
    expect(reconstructInvertedAbstract(null)).toBeNull();
    expect(reconstructInvertedAbstract({})).toBeNull();
    expect(reconstructInvertedAbstract({ a: [2], b: [0], c: [1] })).toBe("b c a");
  });

  test("DOI 与标题归一化", () => {
    expect(normalizeDoi("https://doi.org/10.1038/ABC")).toBe("10.1038/abc");
    expect(normalizeDoi("doi:10.1038/abc")).toBe("10.1038/abc");
    expect(normalizeDoi("not-a-doi")).toBeNull();
    expect(normalizeDoi(42)).toBeNull();
    expect(titleKey("  Deep Learning: A Review!  ")).toBe("deep learning a review");
    expect(titleKey("Café Résumé")).toBe("cafe resume");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("去重", () => {
  test("DOI 相同 → 合并成一条，来源合并", () => {
    const a = paper({ title: "Alpha Fold", doi: "10.1/x", sources: ["openalex"], citedByCount: 10 });
    const b = paper({ title: "AlphaFold", doi: "10.1/x", sources: ["crossref"], venue: "Nature" });
    const { papers, mergedCount } = dedupePapers([a, b]);
    expect(papers.length).toBe(1);
    expect(mergedCount).toBe(1);
    expect(papers[0]!.sources).toEqual(["crossref", "openalex"]);
    expect(papers[0]!.venue).toBe("Nature");
    expect(papers[0]!.citedByCount).toBe(10);
  });

  test("DOI 不同 → 即使标题一模一样也不合并", () => {
    const a = paper({ title: "Same Title", doi: "10.1/a", sources: ["openalex"] });
    const b = paper({ title: "Same Title", doi: "10.1/b", sources: ["crossref"] });
    expect(canMerge(a, b)).toBe(false);
    expect(dedupePapers([a, b]).papers.length).toBe(2);
  });

  test("无 DOI + 标题仅大小写/标点/空白差异 → 合并", () => {
    const a = paper({ title: "Deep  Learning: A Review", sources: ["europepmc"] });
    const b = paper({ title: "deep learning — a review!", sources: ["semanticscholar"] });
    expect(canMerge(a, b)).toBe(true);
    expect(dedupePapers([a, b]).papers.length).toBe(1);
  });

  test("无 DOI + 标题高度相似且年份作者不冲突 → 合并", () => {
    const a = paper({
      title: "Neural machine translation by jointly learning to align and translate",
      year: 2015,
      authors: [{ name: "Dzmitry Bahdanau" }],
      sources: ["openalex"],
    });
    const b = paper({
      title: "Neural machine translation by jointly learning to align and to translate",
      year: 2015,
      authors: [{ name: "D. Bahdanau" }],
      sources: ["crossref"],
    });
    expect(titleSimilarity(a.title, b.title)).toBeGreaterThan(0.9);
    expect(canMerge(a, b)).toBe(true);
  });

  test("标题相似但第一作者不同 → 不合并", () => {
    const a = paper({ title: "A study of protein folding", year: 2020, authors: [{ name: "Alice Smith" }] });
    const b = paper({ title: "A study of protein folding", year: 2020, authors: [{ name: "Bob Jones" }] });
    // 标题完全相同时以标题为准（同题同年不同一作是极少数情况，合并优于漏合）
    expect(canMerge(a, b)).toBe(true);
    const c = paper({ title: "A study on protein folding kinetics", year: 2020, authors: [{ name: "Bob Jones" }] });
    expect(canMerge(a, c)).toBe(false);
  });

  test("完全不同的论文不误合", () => {
    const list = [
      paper({ title: "Attention is all you need", year: 2017, sources: ["openalex"] }),
      paper({ title: "Deep residual learning for image recognition", year: 2016, sources: ["openalex"] }),
      paper({ title: "Highly accurate protein structure prediction", year: 2021, sources: ["crossref"] }),
    ];
    const { papers, mergedCount } = dedupePapers(list);
    expect(papers.length).toBe(3);
    expect(mergedCount).toBe(0);
  });

  test("Part I / Part II 这类同系列论文不误合", () => {
    const a = paper({ title: "Theory of superconductivity part I", year: 1957 });
    const b = paper({ title: "Theory of superconductivity part II", year: 1958 });
    expect(canMerge(a, b)).toBe(false);
  });

  test("合并取更长摘要、更完整作者列表、任一 OA 直链", () => {
    const a = paper({
      title: "X",
      doi: "10.1/x",
      abstract: "short",
      authors: [{ name: "A One" }],
      sources: ["semanticscholar"],
    });
    const b = paper({
      title: "X",
      doi: "10.1/x",
      abstract: "a much longer abstract text",
      authors: [{ name: "A One" }, { name: "B Two" }],
      pdfUrl: "https://x/a.pdf",
      sources: ["crossref"],
    });
    const merged = mergePapers(a, b);
    expect(merged.abstract).toBe("a much longer abstract text");
    expect(merged.authors.length).toBe(2);
    expect(merged.pdfUrl).toBe("https://x/a.pdf");
  });

  test("排序确定性：多源命中优先，其次被引、年份", () => {
    const list = [
      paper({ title: "Single source old", year: 2000, citedByCount: 5, sources: ["openalex"] }),
      paper({ title: "Multi source", doi: "10.1/m", citedByCount: 1, sources: ["openalex"] }),
      paper({ title: "Multi source", doi: "10.1/m", citedByCount: 1, sources: ["crossref"] }),
      paper({ title: "Single source new", year: 2024, citedByCount: 5, sources: ["openalex"] }),
    ];
    const first = dedupePapers(list).papers;
    const second = dedupePapers([...list].reverse()).papers;
    expect(first[0]!.sources.length).toBe(2);
    expect(first.map((p) => p.title)).toEqual(second.map((p) => p.title));
    expect(first[1]!.title).toBe("Single source new");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("BibTeX / CSL-JSON 导出", () => {
  const jumper = paper({
    title: "Highly accurate protein structure prediction with AlphaFold",
    authors: [{ name: "John Jumper" }, { name: "Richard Evans" }],
    year: 2021,
    venue: "Nature",
    doi: "10.1038/s41586-021-03819-2",
    url: "https://doi.org/10.1038/s41586-021-03819-2",
    sources: ["openalex"],
  });

  test("key 规则：第一作者姓 + 年份 + 标题首词", () => {
    expect(bibtexBaseKey(jumper)).toBe("jumper2021highly");
    expect(bibtexBaseKey(paper({ title: "The Origin of Species", authors: [{ name: "Charles Darwin" }], year: 1859 })))
      .toBe("darwin1859origin");
    // 无作者 / 无年份的兜底
    expect(bibtexBaseKey(paper({ title: "Anonymous Work" }))).toBe("anonndanonymous");
  });

  test("标题首词跳过冠词介词与纯数字", () => {
    expect(titleFirstWord("A Review of Things")).toBe("review");
    expect(titleFirstWord("On the Origin")).toBe("origin");
    expect(titleFirstWord("2021 Annual Report")).toBe("annual");
  });

  test("key 冲突加后缀 a/b/c，第一条无后缀", () => {
    const same = [jumper, { ...jumper, doi: "10.1/b" }, { ...jumper, doi: "10.1/c" }];
    expect(assignBibtexKeys(same)).toEqual(["jumper2021highly", "jumper2021highlya", "jumper2021highlyb"]);
  });

  test("BibTeX 输出格式与转义", () => {
    const bib = toBibTeX([jumper]);
    expect(bib).toContain("@article{jumper2021highly,");
    expect(bib).toContain("  title = {Highly accurate protein structure prediction with AlphaFold}");
    expect(bib).toContain("  author = {John Jumper and Richard Evans}");
    expect(bib).toContain("  year = {2021}");
    expect(bib).toContain("  journal = {Nature}");
    expect(bib).toContain("  doi = {10.1038/s41586-021-03819-2}");
    expect(bib.trimEnd().endsWith("}")).toBe(true);
    expect(escapeBibTeX("Cost & Benefit 100% #1")).toBe("Cost \\& Benefit 100\\% \\#1");
  });

  test("无 venue 无 DOI 的预印本用 @misc", () => {
    const pre = paper({ title: "A Preprint", authors: [{ name: "X Y" }], year: 2024, ids: { arxiv: "2401.00001" } });
    expect(toBibTeX([pre])).toContain("@misc{");
    expect(toBibTeX([pre])).toContain("eprint = {2401.00001}");
  });

  test("CSL-JSON：姓名拆分、date-parts、container-title", () => {
    const [item] = toCSLJSON([jumper]);
    expect(item!.id).toBe("jumper2021highly");
    expect(item!.type).toBe("article-journal");
    expect(item!.author).toEqual([
      { family: "Jumper", given: "John" },
      { family: "Evans", given: "Richard" },
    ]);
    expect(item!.issued).toEqual({ "date-parts": [[2021]] });
    expect(item!["container-title"]).toBe("Nature");
    expect(item!.DOI).toBe("10.1038/s41586-021-03819-2");
    expect(JSON.parse(JSON.stringify(toCSLJSON([jumper])))).toBeArray();
  });

  test("CSL 姓名解析：逗号形式与单名", () => {
    expect(toCSLName("Lovelace, Ada")).toEqual({ family: "Lovelace", given: "Ada" });
    expect(toCSLName("Plato")).toEqual({ literal: "Plato" });
    expect(toCSLName("Jan van der Berg")).toEqual({ family: "Berg", given: "Jan van der" });
  });

  test("空库导出不报错", () => {
    expect(toBibTeX([])).toBe("");
    expect(toCSLJSON([])).toEqual([]);
  });

  // E-5：CJK 元数据——bibtex key 保留 Unicode（\p{Script=Han}）。
  // 旧实现 `.replace(/[^a-z0-9]/g, "")` 把汉字整个砍掉：中文作者/标题的 key
  // 全部退化成 "anon" + "untitled"，AMiner 收录的中文文献 key 与论文彻底脱钩。
  describe("CJK bibtex key（E-5）", () => {
    test("中文作者姓名 + 中文标题 → key 保留汉字，不再退化成 anon/untitled", () => {
      const zh = paper({
        title: "深度学习蛋白质结构预测综述",
        authors: [{ name: "张伟" }],
        year: 2022,
      });
      const key = bibtexBaseKey(zh);
      expect(key).not.toContain("anon");
      expect(key).not.toContain("untitled");
      expect(key).toBe("张伟2022深度学习蛋白质结构预测综述");
    });

    test("中文标题首词提取整句（无空格分词），保留完整汉字序列", () => {
      expect(titleFirstWord("深度学习蛋白质结构预测综述")).toBe("深度学习蛋白质结构预测综述");
    });

    test("中英混合作者名：ASCII 与汉字都保留，其余符号仍被砍掉", () => {
      // authorSurname 取姓名最后一个空格分隔段作为「姓」（既有行为，不是本次修的范围）：
      // "Wei 张#Zhang!" → 姓段 "张#Zhang!" → 归一化后 "张 zhang" → 本次修的 keepAsciiAndHan
      // 再把符号与空格都砍掉，汉字与 ASCII 字母都保留。
      const mixed = paper({ title: "Mixed Title", authors: [{ name: "Wei 张#Zhang!" }], year: 2020 });
      expect(bibtexBaseKey(mixed)).toBe("张zhang2020mixed");
    });

    test("assignBibtexKeys 对中文文献同样能生成确定性、无冲突的 key 序列", () => {
      const a = paper({ title: "深度学习综述", authors: [{ name: "张伟" }], year: 2021 });
      const b = paper({ title: "深度学习综述", authors: [{ name: "张伟" }], year: 2021, doi: "10.1/b" });
      const keys = assignBibtexKeys([a, b]);
      expect(keys[0]).toBe("张伟2021深度学习综述");
      expect(keys[1]).toBe("张伟2021深度学习综述a");
    });

    test("toBibTeX 对中文文献输出合法 BibTeX（key 与字段都保留汉字）", () => {
      const zh = paper({
        title: "深度学习蛋白质结构预测综述",
        authors: [{ name: "张伟" }, { name: "李明" }],
        year: 2022,
        venue: "计算机学报",
      });
      const bib = toBibTeX([zh]);
      expect(bib).toContain("@article{张伟2022深度学习蛋白质结构预测综述,");
      expect(bib).toContain("author = {张伟 and 李明}");
      expect(bib).toContain("journal = {计算机学报}");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Project Library", () => {
  function makeLibrary(withRecords = true) {
    const manager = new ProjectManager(tmp);
    const project = manager.create("lib-test", { name: "库测试" });
    const library = new LibraryStore(project.paths.libraryDb, {
      records: withRecords ? project.records() : undefined,
    });
    return { manager, project, library };
  }

  test("入库 → 查询 → 更新 → 删除", () => {
    const { library, project } = makeLibrary();
    const { paper: added, merged } = library.add(
      paper({ title: "Test Paper", doi: "10.1/t", year: 2020, sources: ["openalex"] }),
      { tags: ["methods"] },
    );
    expect(merged).toBe(false);
    expect(library.count()).toBe(1);
    expect(library.getByDoi("10.1/T")).not.toBeNull();
    expect(added.tags).toEqual(["methods"]);
    expect(added.readingStatus).toBe("unread");
    expect(added.pdfStatus).toBe("absent");

    const updated = library.update(added.id, { readingStatus: "read", notes: "很关键" });
    expect(updated.readingStatus).toBe("read");
    expect(updated.notes).toBe("很关键");
    expect(library.list({ readingStatus: "read" }).length).toBe(1);
    expect(library.list({ tag: "methods" }).length).toBe(1);
    expect(library.list({ tag: "nope" }).length).toBe(0);
    expect(library.list({ q: "test" }).length).toBe(1);

    expect(library.remove(added.id)).toBe(true);
    expect(library.remove(added.id)).toBe(false);
    expect(library.count()).toBe(0);
    library.close();
    project.close();
  });

  test("入库自动创建 record（type: paper）并互链", () => {
    const { library, project } = makeLibrary();
    const { paper: added } = library.add(
      paper({ title: "Linked Paper", doi: "10.1/l", sources: ["crossref"], abstract: "abs" }),
      { sessionId: "s1" },
    );
    expect(added.recordId).not.toBeNull();
    const records = project.records();
    const record = records.get(added.recordId!)!;
    expect(record.type).toBe("paper");
    expect(record.evidence).toBe("sourced");
    expect(record.origin.kind).toBe("connector");
    expect(record.origin.connector).toBe("crossref");
    expect(record.origin.sessionId).toBe("s1");
    expect(record.metadata.libraryPaperId).toBe(added.id);
    expect(records.list({ type: "paper" }).length).toBe(1);
    library.close();
    project.close();
  });

  test("重复入库同一 DOI → 合并不新增行，且不产生第二个 record", () => {
    const { library, project } = makeLibrary();
    library.add(paper({ title: "Dup", doi: "10.1/d", sources: ["openalex"] }));
    const second = library.add(paper({ title: "Dup", doi: "10.1/d", venue: "Nature", sources: ["crossref"] }));
    expect(second.merged).toBe(true);
    expect(library.count()).toBe(1);
    expect(second.paper.venue).toBe("Nature");
    expect(second.paper.sources).toEqual(["crossref", "openalex"]);
    expect(project.records().list({ type: "paper" }).length).toBe(1);
    library.close();
    project.close();
  });

  test("DOI 不同的两篇分别入库，不因标题相同而合并", () => {
    const { library, project } = makeLibrary();
    library.add(paper({ title: "Same", doi: "10.1/a", sources: ["openalex"] }));
    library.add(paper({ title: "Same", doi: "10.1/b", sources: ["openalex"] }));
    expect(library.count()).toBe(2);
    library.close();
    project.close();
  });

  test("空标题拒绝入库", () => {
    const { library, project } = makeLibrary();
    expect(() => library.add(paper({ title: "   " }))).toThrow(/标题不能为空/);
    library.close();
    project.close();
  });

  test("引文边：显式 link + 证据图同步 cites 边", () => {
    const { library, project } = makeLibrary();
    const a = library.add(paper({ title: "Citing", doi: "10.1/c1", sources: ["openalex"] })).paper;
    const b = library.add(paper({ title: "Cited", doi: "10.1/c2", sources: ["openalex"] })).paper;
    library.link(a.id, b.id);
    expect(library.citations().length).toBe(1);
    expect(library.citationsOf(a.id).cites.length).toBe(1);
    expect(library.citationsOf(b.id).citedBy.length).toBe(1);
    // 幂等
    library.link(a.id, b.id);
    expect(library.citations().length).toBe(1);
    const graphEdges = project.records().listEdges("cites");
    expect(graphEdges.length).toBe(1);
    expect(graphEdges[0]!.sourceId).toBe(a.recordId!);
    expect(graphEdges[0]!.targetId).toBe(b.recordId!);

    expect(() => library.link(a.id, a.id)).toThrow(/不能引用自己/);
    expect(() => library.link(a.id, "missing")).toThrow(/不在库中/);
    library.close();
    project.close();
  });

  test("rebuildCitations 由 OpenAlex referenced_works 生成库内互引边", () => {
    const { library, project } = makeLibrary();
    library.add(
      paper({
        title: "Citing Work",
        doi: "10.1/r1",
        ids: { openalex: "W100" },
        references: ["W200", "W999"],
        sources: ["openalex"],
      }),
    );
    // 只有 W200 在库内，W999 不在 → 只应该建 1 条边
    expect(library.rebuildCitations()).toBe(0);
    library.add(paper({ title: "Cited Work", doi: "10.1/r2", ids: { openalex: "W200" }, sources: ["openalex"] }));
    expect(library.rebuildCitations()).toBe(1);
    expect(library.citations().length).toBe(1);
    // 再跑一次不重复建边
    expect(library.rebuildCitations()).toBe(0);
    expect(library.citations().length).toBe(1);
    library.close();
    project.close();
  });

  test("非法阅读/PDF 状态被拒绝", () => {
    const { library, project } = makeLibrary();
    const p = library.add(paper({ title: "S", doi: "10.1/s", sources: ["openalex"] })).paper;
    expect(() => library.update(p.id, { readingStatus: "bogus" as never })).toThrow(/未知阅读状态/);
    expect(() => library.update(p.id, { pdfStatus: "bogus" as never })).toThrow(/未知 PDF 状态/);
    expect(() => library.update("missing", { notes: "x" })).toThrow(/不在库中/);
    library.close();
    project.close();
  });

  test("持久化往返：关闭重开后数据与引文边完整", () => {
    const manager = new ProjectManager(tmp);
    const project = manager.create("persist", {});
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const a = library.add(paper({ title: "P1", doi: "10.1/p1", sources: ["openalex"] })).paper;
    const b = library.add(paper({ title: "P2", doi: "10.1/p2", sources: ["openalex"] })).paper;
    library.link(a.id, b.id);
    library.close();
    project.close();

    const reopened = new ProjectManager(tmp).open("persist");
    const lib2 = new LibraryStore(reopened.paths.libraryDb, { records: reopened.records() });
    expect(lib2.count()).toBe(2);
    expect(lib2.citations().length).toBe(1);
    expect(lib2.get(a.id)!.recordId).toBe(a.recordId);
    expect(reopened.records().list({ type: "paper" }).length).toBe(2);
    lib2.close();
    reopened.close();
  });

  test("toPaper 剥离库字段后可直接进导出与去重", () => {
    const { library, project } = makeLibrary();
    const entry = library.add(
      paper({ title: "Export Me", doi: "10.1/e", year: 2022, authors: [{ name: "Zed Ann" }], sources: ["crossref"] }),
      { tags: ["t"] },
    ).paper;
    const plain = toPaper(entry);
    expect(Object.keys(plain)).not.toContain("tags");
    expect(toBibTeX([plain])).toContain("@article{ann2022export,");
    library.close();
    project.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E-6：删除论文留孤儿 record（证据图不撒谎）。
//
// `library.remove()`（library.ts）只删 papers 表那一行，records.db 里同一篇论文的
// `type:"paper"` record（入库时创建）会变成孤儿——仍然出现在 `records.list()` /
// `records.graph()` 里，但指向的库内论文已经不存在。`retractOrphanRecords()`
// （reading.ts）是一次可重复调用的对账扫描：把这类孤儿标 `metadata.retracted`。
describe("证据图孤儿 record 回收（E-6）", () => {
  function makeLibrary() {
    const manager = new ProjectManager(tmp);
    const project = manager.create("orphan-test", { name: "孤儿回收测试" });
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    return { manager, project, library };
  }

  test("删除论文后，paper record 仍在库里且未被标记——复现 bug 本身", () => {
    const { library, project } = makeLibrary();
    const added = library.add(paper({ title: "Will Be Deleted", doi: "10.1/del", sources: ["openalex"] })).paper;
    const recordId = added.recordId!;
    const records = project.records();

    expect(library.remove(added.id)).toBe(true);
    // bug 复现：record 原样还在，且没有任何「已失效」的标记——这就是「证据图撒了谎」。
    const orphan = records.get(recordId)!;
    expect(orphan).not.toBeNull();
    expect((orphan.metadata as Record<string, unknown>).retracted).toBeUndefined();

    library.close();
    project.close();
  });

  test("retractOrphanRecords 把孤儿 paper record 标 retracted，健康 record 不受影响", () => {
    const { library, project } = makeLibrary();
    const alive = library.add(paper({ title: "Still Here", doi: "10.1/alive", sources: ["openalex"] })).paper;
    const gone = library.add(paper({ title: "Will Be Deleted", doi: "10.1/del", sources: ["openalex"] })).paper;
    const records = project.records();

    library.remove(gone.id);
    const summary = retractOrphanRecords(records, library);

    expect(summary.retracted).toEqual([gone.recordId!]);
    expect(summary.alreadyRetracted).toBe(0);
    expect(summary.scanned).toBe(2); // alive + gone 两条 paper record 都被扫过

    const goneRecord = records.get(gone.recordId!)!;
    expect((goneRecord.metadata as Record<string, unknown>).retracted).toBe(true);
    expect(typeof (goneRecord.metadata as Record<string, unknown>).retractedAt).toBe("string");

    const aliveRecord = records.get(alive.recordId!)!;
    expect((aliveRecord.metadata as Record<string, unknown>).retracted).toBeUndefined();
    // 健康 record 的原有字段（libraryPaperId 等）没有被这次浅合并冲掉。
    expect(aliveRecord.metadata.libraryPaperId).toBe(alive.id);

    library.close();
    project.close();
  });

  test("幂等：重复调用不会重复标记，也不会报错", () => {
    const { library, project } = makeLibrary();
    const gone = library.add(paper({ title: "X", doi: "10.1/x", sources: ["openalex"] })).paper;
    const records = project.records();
    library.remove(gone.id);

    const first = retractOrphanRecords(records, library);
    expect(first.retracted).toEqual([gone.recordId!]);

    const second = retractOrphanRecords(records, library);
    expect(second.retracted).toEqual([]);
    expect(second.alreadyRetracted).toBe(1);

    library.close();
    project.close();
  });

  test("同时回收精读卡 record：删除的论文，其精读卡也被标 retracted", () => {
    const { library, project } = makeLibrary();
    const added = library.add(paper({ title: "Has A Card", doi: "10.1/card", sources: ["openalex"] })).paper;
    const records = project.records();
    const cardRecord = records.create({
      type: "reading",
      title: "精读卡：Has A Card",
      content: "内容",
      evidence: "sourced",
      metadata: { kind: "reading_card", libraryPaperId: added.id, bibtexKey: "x2020hasacard" },
    });

    library.remove(added.id);
    const summary = retractOrphanRecords(records, library);

    expect(summary.retracted.sort()).toEqual([added.recordId!, cardRecord.id].sort());
    expect((records.get(cardRecord.id)!.metadata as Record<string, unknown>).retracted).toBe(true);

    library.close();
    project.close();
  });

  test("与库无关的 record（不声明 libraryPaperId）不受影响", () => {
    const { library, project } = makeLibrary();
    const records = project.records();
    const unrelated = records.create({ type: "idea", title: "无关的 idea", content: "x", evidence: "inferred" });

    const summary = retractOrphanRecords(records, library);
    expect(summary.scanned).toBe(0);
    expect(summary.retracted).toEqual([]);
    expect((records.get(unrelated.id)!.metadata as Record<string, unknown>).retracted).toBeUndefined();

    library.close();
    project.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("PDF 下载管线", () => {
  function makeLibrary() {
    const manager = new ProjectManager(tmp);
    const project = manager.create("pdf-test", {});
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    return { project, library };
  }

  const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n fake pdf body");

  test("候选直链推导顺序：arXiv → EuropePMC → 归一化直链", () => {
    const candidates = pdfCandidates(
      paper({
        title: "X",
        ids: { arxiv: "1706.03762", pmcid: "PMC123" },
        isOpenAccess: true,
        pdfUrl: "https://other/a.pdf",
      }),
    );
    expect(candidates.map((c) => c.origin)).toEqual(["arxiv", "europepmc", "openalex_best_oa"]);
    expect(candidates[0]!.url).toBe("https://arxiv.org/pdf/1706.03762");
    expect(candidates[1]!.url).toBe("https://europepmc.org/articles/PMC123?pdf=render");
    // 无任何线索时候选为空
    expect(pdfCandidates(paper({ title: "no links" }))).toEqual([]);
  });

  test("成功下载：落盘 + checksum + 库内状态回写", async () => {
    const { project, library } = makeLibrary();
    const entry = library.add(
      paper({ title: "Attention Is All You Need", authors: [{ name: "A Vaswani" }], year: 2017, ids: { arxiv: "1706.03762" } }),
    ).paper;
    const http = new StubHttp(
      () => new BufferedResponse({ status: 200, headers: { "content-type": "application/pdf" }, body: PDF_BYTES }),
    );
    const result = await new PdfDownloader({ http, papersDir: project.paths.papersDir, library }).download(entry.id);
    expect(result.ok).toBe(true);
    expect(result.origin).toBe("arxiv");
    expect(result.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readFileSync(result.path!).length).toBe(PDF_BYTES.length);
    const stored = library.get(entry.id)!;
    expect(stored.pdfStatus).toBe("downloaded");
    expect(stored.pdfPath).toBe(result.path!);
    expect(stored.checksum).toBe(result.checksum!);
    expect(stored.pdfReason).toBeNull();
    library.close();
    project.close();
  });

  test("403 不重试，如实标注原因并写回库", async () => {
    const { project, library } = makeLibrary();
    const entry = library.add(paper({ title: "Paywalled", ids: { arxiv: "1234.5678" } })).paper;
    const http = new StubHttp(() => new BufferedResponse({ status: 403, headers: {}, body: new Uint8Array() }));
    const result = await new PdfDownloader({ http, papersDir: project.paths.papersDir, library }).download(entry.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http_403");
    // 只有一个候选 → 只请求一次，不重试
    expect(http.calls.length).toBe(1);
    expect(result.attempts.length).toBe(1);
    expect(library.get(entry.id)!.pdfStatus).toBe("unavailable");
    expect(library.get(entry.id)!.pdfReason).toContain("http_403");
    library.close();
    project.close();
  });

  test("第一个候选 404 时回落到下一个候选", async () => {
    const { project, library } = makeLibrary();
    const entry = library.add(
      paper({ title: "Fallback", ids: { arxiv: "9999.9999", pmcid: "PMC42" }, isOpenAccess: true }),
    ).paper;
    const http = new StubHttp((url) =>
      url.includes("arxiv")
        ? new BufferedResponse({ status: 404, headers: {}, body: new Uint8Array() })
        : new BufferedResponse({ status: 200, headers: { "content-type": "application/pdf" }, body: PDF_BYTES }),
    );
    const result = await new PdfDownloader({ http, papersDir: project.paths.papersDir, library }).download(entry.id);
    expect(result.ok).toBe(true);
    expect(result.origin).toBe("europepmc");
    expect(result.attempts.map((a) => a.outcome)).toEqual(["http_404", "ok"]);
    library.close();
    project.close();
  });

  test("返回 HTML 落地页 → not_a_pdf", async () => {
    const { project, library } = makeLibrary();
    const entry = library.add(paper({ title: "Landing", ids: { arxiv: "1111.1111" } })).paper;
    const http = new StubHttp(
      () =>
        new BufferedResponse({
          status: 200,
          headers: { "content-type": "text/html" },
          body: new TextEncoder().encode("<html>login</html>"),
        }),
    );
    const result = await new PdfDownloader({ http, papersDir: project.paths.papersDir, library }).download(entry.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_a_pdf");
    library.close();
    project.close();
  });

  test("无 OA 直链 → no_oa_link，不发任何请求", async () => {
    const { project, library } = makeLibrary();
    const entry = library.add(paper({ title: "No links at all" })).paper;
    const http = new StubHttp(() => new BufferedResponse({ status: 200, headers: {}, body: PDF_BYTES }));
    const result = await new PdfDownloader({ http, papersDir: project.paths.papersDir, library }).download(entry.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_oa_link");
    expect(http.calls.length).toBe(0);
    library.close();
    project.close();
  });

  test("文件名可读且带 id 后缀防撞名", () => {
    const entry = {
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      title: "Highly Accurate Protein Structure Prediction",
      authors: [{ name: "John Jumper" }],
      year: 2021,
    } as never;
    expect(pdfFilename(entry)).toBe("jumper2021-highly-abcdef12.pdf");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("AMiner connector · 凭据降级", () => {
  const fakeStore = (values: Record<string, string> | null) => ({
    has: () => values !== null,
    get: () => values,
  });

  test("无凭据提供方 → search 返回结构化降级结果，不抛异常", async () => {
    const connector = new AMinerConnector();
    const result = await connector.search({ query: "蛋白质结构预测" });
    expect(isCredentialMissing(result)).toBe(true);
    const missing = result as ReturnType<typeof credentialMissingResult>;
    expect(missing.ok).toBe(false);
    expect(missing.configured).toBe(false);
    expect(missing.connector).toBe("aminer");
    expect(missing.requiredKeys).toEqual(["api_key"]);
    expect(missing.results).toEqual([]);
    expect(missing.howToConfigure.length).toBeGreaterThan(0);
    expect(connector.isConfigured()).toBe(false);
  });

  test("凭据存在但字段为空串 → 同样降级", async () => {
    const connector = new AMinerConnector({ credentials: fakeStore({ api_key: "   " }) });
    expect(connector.isConfigured()).toBe(false);
    expect(isCredentialMissing(await connector.getPaper({ id: "x" }))).toBe(true);
  });

  test("凭据读取抛错时按未配置处理，不外泄底层错误", async () => {
    const connector = new AMinerConnector({
      credentials: {
        has: () => true,
        get: () => {
          throw new Error("凭据文件解析失败（/home/u/.spark-research/credentials.json）");
        },
      },
    });
    const result = await connector.search({ query: "x" });
    expect(isCredentialMissing(result)).toBe(true);
    // 降级体里出现 credentials.json 是「配置指引」，但底层错误细节不得外泄
    expect(JSON.stringify(result)).not.toContain("解析失败");
    expect(JSON.stringify(result)).not.toContain("/home/u/");
  });

  test("降级结果与错误消息中不含任何凭据值片段", async () => {
    const secret = "sk-super-secret-token-value-1234567890";
    const connector = new AMinerConnector({ credentials: fakeStore({ api_key: secret }) });
    const http = new StubHttp(() => new BufferedResponse({ status: 401, headers: {}, body: new Uint8Array() }));
    const withHttp = new AMinerConnector({ credentials: fakeStore({ api_key: secret }), http });
    expect(connector.isConfigured()).toBe(true);
    let message = "";
    try {
      await withHttp.search({ query: "x" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HTTP 401");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(secret.slice(0, 10));
  });

  test("有凭据时按官方口径构造请求：GET /paper/search + Authorization header", async () => {
    const secret = "fake-aminer-token";
    const http = new StubHttp(() =>
      new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ code: 200, data: { hitList: [{ title: "T", year: 2020 }] } })),
      }),
    );
    const connector = new AMinerConnector({ credentials: fakeStore({ api_key: secret }), http });
    await connector.search({ query: "AlphaFold", size: 5 });
    const call = http.calls[0]!;
    expect(call.url).toContain("datacenter.aminer.cn/gateway/open_platform/api/paper/search");
    expect(call.url).toContain("title=AlphaFold");
    expect(call.url).toContain("size=5");
    expect(call.url).toContain("page=1");
    expect(call.init.headers!.Authorization).toBe(secret);
    expect(call.init.method ?? "GET").toBe("GET");
  });

  test("paper-detail 走 POST /paper/info，body 为 ids 数组", async () => {
    const http = new StubHttp(() =>
      new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ code: 200, data: [{ title: "T" }] })),
      }),
    );
    const connector = new AMinerConnector({ credentials: fakeStore({ api_key: "fake-aminer-token" }), http });
    await connector.getPaper({ ids: ["53e9ab9eb7602d970354a97e"] });
    const call = http.calls[0]!;
    expect(call.url).toContain("/paper/info");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(call.init.body!)).toEqual({ ids: ["53e9ab9eb7602d970354a97e"] });
  });

  test("凭据 id / 字段名与 CredentialStore 契约一致", () => {
    expect(AMINER_CONNECTOR_ID).toBe("aminer");
    expect(AMINER_CREDENTIAL_KEY).toBe("api_key");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("连接器请求构造", () => {
  function capture() {
    const http = new StubHttp(
      () =>
        new BufferedResponse({
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode("{}"),
        }),
    );
    return http;
  }

  test("OpenAlex：search 映射到 ?search= 与 per-page，带 mailto 与 UA", async () => {
    const http = capture();
    await new OpenAlexConnector({ http }).search({ query: "AlphaFold", limit: 5 });
    const call = http.calls[0]!;
    expect(call.url).toContain("api.openalex.org/works");
    expect(call.url).toContain("search=AlphaFold");
    expect(call.url).toContain("per-page=5");
    expect(call.url).toContain("mailto=");
    expect(call.init.headers!["User-Agent"]).toContain("spark-research/");
  });

  test("OpenAlex：id 归一化（W.../DOI/URL）", async () => {
    const http = capture();
    const connector = new OpenAlexConnector({ http });
    await connector.getPaper({ id: "10.1038/abc" });
    expect(http.calls[0]!.url).toContain("/works/doi%3A10.1038%2Fabc");
    expect(openAlexEntityId("https://openalex.org/W1")).toBe("W1");
    expect(openAlexEntityId("w123")).toBe("W123");
    expect(openAlexEntityId("https://doi.org/10.1/x")).toBe("doi:10.1/x");
  });

  test("CrossRef：rows 参数 + DOI 路径去前缀", async () => {
    const http = capture();
    const connector = new CrossRefConnector({ http });
    await connector.search({ query: "protein", limit: 3 });
    expect(http.calls[0]!.url).toContain("rows=3");
    expect(http.calls[0]!.url).toContain("query=protein");
    await connector.getPaper({ id: "https://doi.org/10.1/x" });
    expect(http.calls[1]!.url).toContain("/works/10.1%2Fx");
  });

  test("Europe PMC：resultType=core + 按 id 形态构造检索式", async () => {
    const http = capture();
    await new EuropePMCConnector({ http }).search({ query: "alphafold", limit: 4 });
    expect(http.calls[0]!.url).toContain("resultType=core");
    expect(http.calls[0]!.url).toContain("pageSize=4");
    expect(europePmcIdQuery("PMC8371605")).toBe("PMCID:PMC8371605");
    expect(europePmcIdQuery("34265844")).toBe("EXT_ID:34265844 AND SRC:MED");
    expect(europePmcIdQuery("https://doi.org/10.1/x")).toBe('DOI:"10.1/x"');
  });

  test("Semantic Scholar：fields 与 limit，id 带前缀（有凭据时）", async () => {
    const http = capture();
    const connector = new SemanticScholarConnector({
      http,
      credentials: { has: () => true, get: () => ({ api_key: "fake-s2-key" }) },
    });
    await connector.search({ query: "attention", limit: 2 });
    expect(http.calls[0]!.url).toContain("/paper/search");
    expect(http.calls[0]!.url).toContain("limit=2");
    expect(http.calls[0]!.url).toContain("fields=");
    expect(http.calls[0]!.init.headers!["x-api-key"]).toBe("fake-s2-key");
    expect(semanticScholarPaperId("10.1038/x")).toBe("DOI:10.1038/x");
    expect(semanticScholarPaperId("1706.03762")).toBe("arXiv:1706.03762");
    expect(semanticScholarPaperId("abc123")).toBe("abc123");
  });

  describe("Semantic Scholar connector · 凭据降级（E-4）", () => {
    test("无凭据提供方 → search/getPaper 返回结构化降级结果，不发请求", async () => {
      const http = capture();
      const connector = new SemanticScholarConnector({ http });
      expect(connector.isConfigured()).toBe(false);

      const searchResult = await connector.search({ query: "attention" });
      expect(isCredentialMissing(searchResult)).toBe(true);
      const missing = searchResult as ReturnType<typeof credentialMissingResult>;
      expect(missing.connector).toBe("semanticscholar");
      expect(missing.requiredKeys).toEqual(["api_key"]);
      expect(missing.results).toEqual([]);

      expect(isCredentialMissing(await connector.getPaper({ id: "10.1/x" }))).toBe(true);
      // 无 key 就不该白撞一遍 429：压根不发请求。
      expect(http.calls.length).toBe(0);
    });

    test("凭据字段为空串 → 同样按未配置处理", async () => {
      const connector = new SemanticScholarConnector({
        http: capture(),
        credentials: { has: () => true, get: () => ({ api_key: "   " }) },
      });
      expect(connector.isConfigured()).toBe(false);
      expect(isCredentialMissing(await connector.search({ query: "x" }))).toBe(true);
    });

    test("凭据读取抛错时按未配置处理，不外泄底层错误", async () => {
      const connector = new SemanticScholarConnector({
        http: capture(),
        credentials: {
          has: () => true,
          get: () => {
            throw new Error("凭据文件解析失败（/home/u/.spark-research/credentials.json）");
          },
        },
      });
      const result = await connector.search({ query: "x" });
      expect(isCredentialMissing(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("解析失败");
      expect(JSON.stringify(result)).not.toContain("/home/u/");
    });

    test("有凭据时按官方口径带 x-api-key 头，无凭据时不带该头", async () => {
      const withKey = capture();
      await new SemanticScholarConnector({
        http: withKey,
        credentials: { has: () => true, get: () => ({ api_key: "s2-secret" }) },
      }).getPaper({ id: "10.1038/x" });
      expect(withKey.calls[0]!.init.headers!["x-api-key"]).toBe("s2-secret");

      // 无凭据时 getPaper 直接降级，不发请求——headersFor 根本没被调用到网络层。
      const withoutKey = capture();
      await new SemanticScholarConnector({ http: withoutKey }).getPaper({ id: "10.1038/x" });
      expect(withoutKey.calls.length).toBe(0);
    });

    test("凭据 id / 字段名固定，供 CredentialStore 契约对齐", () => {
      expect(S2_CONNECTOR_ID).toBe("semanticscholar");
      expect(S2_CREDENTIAL_KEY).toBe("api_key");
    });
  });

  test("礼貌头默认是占位符，不含任何个人信息", () => {
    expect(contactEmail({})).toBe(PLACEHOLDER_CONTACT_EMAIL);
    expect(isContactEmailConfigured({})).toBe(false);
    expect(userAgent({})).toContain("example.invalid");
    expect(isContactEmailConfigured({ SPARK_RESEARCH_CONTACT_EMAIL: "me@lab.edu" })).toBe(true);
    expect(userAgent({ SPARK_RESEARCH_CONTACT_EMAIL: "me@lab.edu" })).toContain("mailto:me@lab.edu");
  });

  test("registry 注册了 P2 新增的文献源，且能按域列出", () => {
    const registry = new ConnectorRegistry().registerBuiltins();
    const names = registry.listAll().map((c) => c.name);
    for (const name of ["openalex", "crossref", "europepmc", "semanticscholar", "aminer"]) {
      expect(names).toContain(name);
    }
    expect(registry.listDomain("literature").map((c) => c.name)).toContain("openalex");
    // aminer 与 semanticscholar 标注需要 key（E-4：S2 匿名请求持续 429，凭据路径已补上）
    const needKey = registry
      .listAll()
      .filter((c) => c.domain === "literature" && c.metadata?.apiKeyRequired && c.metadata.status === "available");
    expect(needKey.map((c) => c.name).sort()).toEqual(["aminer", "semanticscholar"]);
    for (const name of ["openalex", "crossref", "europepmc", "semanticscholar", "aminer"]) {
      const tools = registry.listTools(name).map((t) => t.name);
      expect(tools).toContain("search");
      expect(tools).toContain("getPaper");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("跨源检索编排", () => {
  // 默认给 S2 配一把假凭据：这个 describe 块测的是跨源编排/去重/失败传播，
  // 不是 E-4 的凭据降级本身（那部分见上面「Semantic Scholar connector · 凭据降级」
  // 与下面单独的「S2 无 key → skipped」用例）——不配的话 S2 会在这些用例里
  // 提前被降级成 skipped，掩盖掉本来要测的「四源都真的打了请求」这件事。
  function registryWith(handler: (url: string) => BufferedResponse): ConnectorRegistry {
    return new ConnectorRegistry({
      http: new StubHttp((url) => handler(url)),
      credentials: { has: (id) => id === S2_CONNECTOR_ID, get: (id) => (id === S2_CONNECTOR_ID ? { api_key: "test-s2-key" } : null) },
    }).registerBuiltins();
  }

  const json = (payload: unknown, status = 200) =>
    new BufferedResponse({
      status,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });

  test("并发查询四源 → 归一化 → 去重合并", async () => {
    const registry = registryWith((url) => {
      if (url.includes("openalex")) {
        return json({ results: [{ display_name: "Shared Paper", doi: "10.1/s", publication_year: 2021 }] });
      }
      if (url.includes("crossref")) {
        return json({ message: { items: [{ title: ["Shared Paper"], DOI: "10.1/s", "container-title": ["Nature"] }] } });
      }
      if (url.includes("europepmc")) {
        return json({ resultList: { result: [{ title: "Unique EuropePMC Paper", pubYear: "2019" }] } });
      }
      return json({ data: [{ paperId: "s2", title: "Unique S2 Paper", year: 2020 }] });
    });
    const result = await new LiteratureSearcher(registry).search("test");
    expect(result.totalBeforeDedupe).toBe(4);
    expect(result.papers.length).toBe(3);
    expect(result.mergedCount).toBe(1);
    expect(result.sources.every((s) => s.outcome === "ok")).toBe(true);
    // 双源命中的排最前
    expect(result.papers[0]!.sources).toEqual(["crossref", "openalex"]);
    expect(result.papers[0]!.venue).toBe("Nature");
  });

  test("单源失败不拖垮整次检索，failed 如实标注", async () => {
    const registry = registryWith((url) =>
      url.includes("semanticscholar")
        ? json({ error: "rate limited" }, 429)
        : json({ results: [{ display_name: "OK Paper", doi: "10.1/ok" }] }),
    );
    const result = await new LiteratureSearcher(registry).search("test");
    const failed = result.sources.find((s) => s.source === "semanticscholar")!;
    expect(failed.outcome).toBe("failed");
    expect(failed.error).toContain("HTTP 429");
    expect(result.papers.length).toBeGreaterThan(0);
    expect(result.sources.filter((s) => s.outcome === "ok").length).toBe(3);
  });

  test("AMiner 无 key → skipped 而非 failed，其余源照常返回", async () => {
    const registry = registryWith(() => json({ results: [{ display_name: "P", doi: "10.1/p" }] }));
    const result = await new LiteratureSearcher(registry).search("x", {
      sources: ["openalex", "aminer"],
    });
    const aminer = result.sources.find((s) => s.source === "aminer")!;
    expect(aminer.outcome).toBe("skipped");
    expect(aminer.note).toContain("未配置凭据");
    expect(result.papers.length).toBe(1);
  });

  test("S2 无 key → skipped 而非 failed，不再每次白撞 429（E-4）", async () => {
    // 这里不用 registryWith（它默认给 S2 塞了假 key）：单独造一个没有任何凭据的 registry。
    const registry = new ConnectorRegistry({
      http: new StubHttp(() => json({ results: [{ display_name: "P", doi: "10.1/p" }] })),
    }).registerBuiltins();
    const result = await new LiteratureSearcher(registry).search("x", {
      sources: ["openalex", "semanticscholar"],
    });
    const s2 = result.sources.find((s) => s.source === "semanticscholar")!;
    expect(s2.outcome).toBe("skipped");
    expect(s2.note).toContain("未配置凭据");
    expect(result.papers.length).toBe(1);
  });

  test("fetchById：非 DOI 标识符对 crossref/openalex 标 skipped 而不是打 404", async () => {
    const registry = registryWith(() => json({ data: [{ paperId: "s2", title: "By Id", year: 2020 }] }));
    const result = await new LiteratureSearcher(registry).fetchById("1706.03762");
    const crossref = result.sources.find((s) => s.source === "crossref")!;
    expect(crossref.outcome).toBe("skipped");
    expect(crossref.note).toContain("不是该源可解析的标识符");
    expect(result.papers.length).toBeGreaterThan(0);
  });

  test("limit 截断在去重之后生效", async () => {
    const registry = registryWith(() =>
      json({
        results: [
          { display_name: "A", doi: "10.1/a" },
          { display_name: "B", doi: "10.1/b" },
          { display_name: "C", doi: "10.1/c" },
        ],
      }),
    );
    const result = await new LiteratureSearcher(registry).search("x", { sources: ["openalex"], limit: 2 });
    expect(result.totalBeforeDedupe).toBe(3);
    expect(result.papers.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("FixtureHttp 回放机制", () => {
  test("record 模式落盘、replay 模式命中同一 key", async () => {
    const upstream = new StubHttp(
      () =>
        new BufferedResponse({
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode('{"hello":"world"}'),
        }),
    );
    const recorder = new FixtureHttp({ dir: tmp, cassette: "demo", mode: "record", upstream });
    await recorder.request("https://api.example/works?search=x&mailto=a@b.c");
    expect(recorder.size).toBe(1);

    const replayer = new FixtureHttp({ dir: tmp, cassette: "demo", mode: "replay" });
    // mailto 不参与 key → 换个邮箱也能命中
    const response = await replayer.request("https://api.example/works?search=x&mailto=other@d.e");
    expect(await response.json()).toEqual({ hello: "world" });
    expect(response.status).toBe(200);
  });

  test("replay 未命中给出可操作的报错", async () => {
    const replayer = new FixtureHttp({ dir: tmp, cassette: "missing", mode: "replay" });
    expect(replayer.request("https://api.example/nope")).rejects.toThrow(FixtureMissError);
    await replayer.request("https://api.example/nope").catch((e: Error) => {
      expect(e.message).toContain("FIXTURE_MODE=record");
    });
  });

  test("canonicalUrl 剔除凭据类参数并排序", () => {
    expect(canonicalUrl("https://a.b/c?z=1&a=2&api_key=SECRET&token=T")).toBe("https://a.b/c?a=2&z=1");
    expect(fixtureKey("GET", "https://a.b/c?api_key=X")).toBe(fixtureKey("get", "https://a.b/c?api_key=Y"));
    expect(fixtureKey("GET", "https://a.b/c")).not.toBe(fixtureKey("POST", "https://a.b/c"));
    expect(fixtureKey("POST", "https://a.b/c", "{}")).not.toBe(fixtureKey("POST", "https://a.b/c", '{"a":1}'));
  });

  test("请求头（含 Authorization）永远不落盘", async () => {
    const upstream = new StubHttp(
      () => new BufferedResponse({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode("{}") }),
    );
    const recorder = new FixtureHttp({ dir: tmp, cassette: "secret", mode: "record", upstream });
    await recorder.request("https://api.example/x", { headers: { Authorization: "super-secret-token-abc" } });
    const raw = readFileSync(join(tmp, "secret.json"), "utf8");
    expect(raw).not.toContain("super-secret-token-abc");
    expect(raw).not.toContain("Authorization");
    expect(raw).not.toContain("headers\":{\"Authorization");
  });

  test("POST body 只存哈希不存原文", async () => {
    const upstream = new StubHttp(
      () => new BufferedResponse({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode("{}") }),
    );
    const recorder = new FixtureHttp({ dir: tmp, cassette: "post", mode: "record", upstream });
    await recorder.request("https://api.example/x", { method: "POST", body: '{"secret_field":"value-xyz"}' });
    const raw = readFileSync(join(tmp, "post.json"), "utf8");
    expect(raw).not.toContain("secret_field");
    expect(raw).not.toContain("value-xyz");
    expect(raw).toContain("bodyHash");
  });

  test("二进制响应只留截断样本 + 长度 + sha256", async () => {
    const big = new Uint8Array(10000);
    big.set(new TextEncoder().encode("%PDF-1.7"));
    const upstream = new StubHttp(
      () => new BufferedResponse({ status: 200, headers: { "content-type": "application/pdf" }, body: big }),
    );
    const recorder = new FixtureHttp({ dir: tmp, cassette: "pdf", mode: "record", upstream, maxBinaryBytes: 512 });
    await recorder.request("https://a.b/x.pdf");
    const file = JSON.parse(readFileSync(join(tmp, "pdf.json"), "utf8"));
    const entry = file.entries[0];
    expect(entry.response.bodyLength).toBe(10000);
    expect(entry.response.truncated).toBe(true);
    expect(entry.response.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(entry.response.bodyBase64, "base64").length).toBe(512);
    expect(entry.response.body).toBeUndefined();
  });

  test("损坏的 cassette 文件抛错而不是静默返回空", () => {
    writeFileSync(join(tmp, "broken.json"), "{ not json");
    expect(() => new FixtureHttp({ dir: tmp, cassette: "broken", mode: "replay" })).toThrow();
  });
});
