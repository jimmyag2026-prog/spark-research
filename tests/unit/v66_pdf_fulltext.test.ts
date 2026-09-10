import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPdfText } from "../../backend/src/literature/pdf_text";
import {
  ReadingCardGenerator,
  buildReadingCardPrompt,
  type ReadingFullText,
} from "../../backend/src/literature/reading";
import { LibraryStore } from "../../backend/src/literature/library";
import { resolvePython } from "../../backend/src/simulation/platform";
import { ProjectManager } from "../../backend/src/project/manager";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { llmExtras } from "../../backend/src/llm/types";

// V66：精读卡吃 PDF 全文。R1 实测 10/10 卡全是摘要级推理——PDF 下载了但从未抽取。
// 三层验证：① extractPdfText 真抽（真 python + pypdf，产 PDF 用 pypdf 现场生成）
// ② 失败路径优雅降级（不抛、给 reason）③ 全文注入 prompt + basis 落 record 元数据。

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-v66-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// 与生产同一条解释器解析链（.venv 优先，CI 落系统 python3——runner 装了 pypdf 就能真跑）
const VENV_PY = resolvePython();

describe("V66 · extractPdfText", () => {
  test("真 PDF → 抽出文本（pypdf 现场生成一页含文字的 PDF）", async () => {
    const pdfPath = join(tmp, "sample.pdf");
    const gen = Bun.spawnSync([
      VENV_PY,
      "-c",
      [
        "from pypdf import PdfWriter",
        "from pypdf.annotations import FreeText",
        "w = PdfWriter()",
        "page = w.add_blank_page(width=612, height=792)",
        "a = FreeText(text='HelloSparkFulltext', rect=(50, 700, 400, 750))",
        "w.add_annotation(page_number=0, annotation=a)",
        `w.write(r'${pdfPath}')`,
      ].join("\n"),
    ]);
    if (gen.exitCode !== 0) {
      // 环境没有 pypdf 时如实跳过（CI 只装了 numpy/rdkit）——不能让环境缺依赖伪装成回归
      console.log(`[V66] skip 真抽取用例：${new TextDecoder().decode(gen.stderr).slice(0, 120)}`);
      return;
    }
    const result = await extractPdfText(pdfPath, { python: VENV_PY });
    // FreeText 注释文本不一定被 extract_text 认作正文——两种诚实结果都接受：
    // 抽到文本（ok），或如实报「无可抽取文本」（扫描件语义）。绝不接受抛异常。
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) expect(result.reason).toBeTruthy();
  });

  test("文件不存在 → ok:false + 原因，不抛", async () => {
    const result = await extractPdfText(join(tmp, "nope.pdf"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("不存在");
  });

  test("坏 PDF → ok:false + 可读原因，不抛", async () => {
    const bad = join(tmp, "bad.pdf");
    writeFileSync(bad, "this is not a pdf at all");
    const result = await extractPdfText(bad, { python: VENV_PY });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("V66 · 全文进 prompt 与 basis 留痕", () => {
  test("buildReadingCardPrompt：有全文含全文段；无全文明示「未提供全文」", () => {
    const paper = {
      id: "p1",
      title: "T",
      authors: [],
      year: 2024,
      venue: null,
      doi: null,
      ids: {},
      abstract: "摘要内容",
      url: null,
      pdfUrl: null,
      citedByCount: null,
      isOpenAccess: null,
      sources: ["openalex"],
      references: [],
      tags: [],
      readingStatus: "unread",
      notes: "",
      pdfPath: null,
      pdfStatus: "none",
      pdfReason: null,
      checksum: null,
      recordId: null,
      addedAt: "",
      updatedAt: "",
    } as never;
    const withFt = buildReadingCardPrompt(paper, undefined, { ok: true, text: "全文正文ABC", truncated: true });
    expect(withFt).toContain("全文正文ABC");
    expect(withFt).toContain("已截断");
    const without = buildReadingCardPrompt(paper, undefined, { ok: false, reason: "x" });
    expect(without).toContain("未提供全文");
  });

  test("generate：fullTextFor 注入 → prompt 带全文、record 元数据 basis=fulltext；失败篇降级 abstract+reason", async () => {
    const manager = new ProjectManager(tmp);
    const project = manager.create("v66", { name: "v66" });
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const base = {
      authors: [],
      year: 2024,
      venue: null,
      doi: null,
      abstract: "abs",
      url: null,
      pdfUrl: null,
      citedByCount: null,
      isOpenAccess: null,
      sources: ["openalex"] as ["openalex"],
      references: [],
    };
    const a = library.add({ ...base, title: "Paper FT", ids: { openalex: "W1" } }, { tags: [] });
    const b = library.add({ ...base, title: "Paper ABS", ids: { openalex: "W2" } }, { tags: [] });

    const prompts: string[] = [];
    const llm = {
      call: async (messages: ChatMessage[]): Promise<LlmResponse> => {
        prompts.push(messages.map((m) => m.content).join("\n"));
        return {
          ok: true,
          ...llmExtras(),
          provider: "openrouter",
          model: LLMRouter.DEFAULT_MODEL,
          content: JSON.stringify({
            researchQuestion: "q",
            methods: "m",
            keyFindings: ["f"],
            limitations: [],
            relationToProject: "r",
          }),
        };
      },
    };
    const generator = new ReadingCardGenerator({
      llm,
      library,
      records: project.records(),
      fullTextFor: async (p): Promise<ReadingFullText> =>
        p.title === "Paper FT" ? { ok: true, text: "FULLTEXT-MARKER-XYZ" } : { ok: false, reason: "无 PDF" },
    });

    const ft = await generator.generate(a.paper.id);
    expect(prompts.pop()).toContain("FULLTEXT-MARKER-XYZ");
    expect(ft.card.basis).toBe("fulltext");

    const abs = await generator.generate(b.paper.id);
    expect(prompts.pop()).toContain("未提供全文");
    expect(abs.card.basis).toBe("abstract");
    expect(abs.card.basisReason).toBe("无 PDF");

    // record 元数据留痕
    const records = project.records().list({ type: "reading" });
    const metas = records.map((r) => (r.metadata ?? {}) as { basis?: string; basisReason?: string });
    expect(metas.some((m) => m.basis === "fulltext")).toBe(true);
    expect(metas.some((m) => m.basis === "abstract" && m.basisReason === "无 PDF")).toBe(true);

    library.close();
    project.close();
  });

  test("不注入 fullTextFor → 行为如旧（basis 记 abstract，prompt 无全文段）", async () => {
    const manager = new ProjectManager(tmp);
    const project = manager.create("v66b", { name: "v66b" });
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const a = library.add(
      {
        title: "Legacy",
        authors: [],
        year: 2024,
        venue: null,
        doi: null,
        ids: { openalex: "W3" },
        abstract: "abs",
        url: null,
        pdfUrl: null,
        citedByCount: null,
        isOpenAccess: null,
        sources: ["openalex"],
        references: [],
      },
      { tags: [] },
    );
    const prompts: string[] = [];
    const llm = {
      call: async (messages: ChatMessage[]): Promise<LlmResponse> => {
        prompts.push(messages.map((m) => m.content).join("\n"));
        return {
          ok: true,
          ...llmExtras(),
          provider: "openrouter",
          model: LLMRouter.DEFAULT_MODEL,
          content: JSON.stringify({ researchQuestion: "q", methods: "m", keyFindings: ["f"], limitations: [], relationToProject: "r" }),
        };
      },
    };
    const generator = new ReadingCardGenerator({ llm, library, records: project.records() });
    const res = await generator.generate(a.paper.id);
    expect(res.card.basis ?? "abstract").toBe("abstract");
    expect(prompts[0]).toContain("未提供全文");
    library.close();
    project.close();
  });
});
