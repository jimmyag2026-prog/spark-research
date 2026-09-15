// 本地使用窗口第三批门禁：U54（结论先行）· U55/S4（每源 deadline + 429 冷却）· U56（PDF 直开 + 列表列）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { LiteratureSearcher, clearSourceCooldowns, DEFAULT_SOURCE_TIMEOUT_MS } from "../../backend/src/literature/search";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { LibraryStore } from "../../backend/src/literature/library";
import { makeServer, type ServerFixture } from "../helpers/server_scenario";
import { FakeLlm } from "../helpers/review_scenario";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

class RecordingLlm {
  readonly prompts: string[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async call(messages: ChatMessage[]): Promise<LlmResponse> {
    this.prompts.push(messages.map((m) => `[${m.role}]${m.content}`).join("\n"));
    const content = this.replies[Math.min(this.i++, this.replies.length - 1)] ?? "";
    return { ok: true, content, provider: "kimi", model: "t", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as LlmResponse;
  }
  listModels() { return {}; }
}

describe("U54 · 回复结构：结论 → 附件 → 过程校对", () => {
  test("summarize 的 system 提示词按此顺序约束，且写明「never put process before conclusion」", async () => {
    const llm = new RecordingLlm([JSON.stringify([{ id: "t1", kind: "analysis", description: "x" }]), "## 结论\n答。"]);
    const orch = new OrchestratorAgent(new SparkResearchDaemon(), { llm: llm as never });
    await orch.processRequest("q", "s-u54");
    const sys = llm.prompts[llm.prompts.length - 1]!;
    const a = sys.indexOf("## 结论"), b = sys.indexOf("## 附件"), c = sys.indexOf("## 过程校对");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(sys).toContain("Never put process before conclusion");
  });
});

describe("U55 / S4 · 每源独立 deadline；被 429 的源进入冷却", () => {
  beforeEach(() => clearSourceCooldowns());
  afterEach(() => clearSourceCooldowns());

  const registryWith = (impl: (source: string) => Promise<unknown>) =>
    ({ call: (source: string) => impl(source) }) as unknown as ConnectorRegistry;

  test("一个源 30s 不回，其它源照常返回；整条查询不再等最慢的", async () => {
    const reg = registryWith((source) =>
      source === "arxiv"
        ? new Promise(() => {}) // 永不返回
        : Promise.resolve({ results: [{ display_name: `P-${source}`, doi: `10.1/${source}` }] }),
    );
    const searcher = new LiteratureSearcher(Object.assign(Object.create(ConnectorRegistry.prototype), reg) as ConnectorRegistry, { sourceTimeoutMs: 300 });
    const t0 = Date.now();
    const r = await searcher.search("x", { sources: ["openalex", "arxiv"] });
    expect(Date.now() - t0).toBeLessThan(3000);
    const arxiv = r.sources.find((s) => s.source === "arxiv")!;
    expect(arxiv.outcome).toBe("failed");
    expect(arxiv.error).toContain("timeout");
    expect(r.sources.find((s) => s.source === "openalex")!.outcome).toBe("ok");
    expect(r.papers.length).toBe(1);
  });

  test("上游 429 → 该源冷却，下一条查询直接 skipped 并说明剩余秒数，不再发请求", async () => {
    let arxivCalls = 0;
    const reg = registryWith((source) => {
      if (source === "arxiv") { arxivCalls++; return Promise.reject(new Error('Connector "arxiv" tool "search" failed: HTTP 429')); }
      return Promise.resolve({ results: [{ display_name: "P", doi: "10.1/p" }] });
    });
    const searcher = new LiteratureSearcher(Object.assign(Object.create(ConnectorRegistry.prototype), reg) as ConnectorRegistry, { sourceTimeoutMs: 1000, cooldownOn429: true });
    const r1 = await searcher.search("q1", { sources: ["openalex", "arxiv"] });
    expect(r1.sources.find((s) => s.source === "arxiv")!.outcome).toBe("failed");
    const r2 = await searcher.search("q2", { sources: ["openalex", "arxiv"] });
    const ax = r2.sources.find((s) => s.source === "arxiv")!;
    expect(ax.outcome).toBe("skipped");
    expect(ax.note).toContain("冷却");
    expect(arxivCalls).toBe(1);
  });

  test("默认 deadline 是 8s（六个正常源 1–3s 就回）", () => {
    expect(DEFAULT_SOURCE_TIMEOUT_MS).toBe(8000);
  });
});

describe("U56 · 下载好的 PDF 在浏览器里直接打开", () => {
  let fx: ServerFixture | undefined;
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "u56-")); });
  afterEach(async () => { await fx?.stop(); fx = undefined; rmSync(tmp, { recursive: true, force: true }); });

  test("GET /api/lit/papers/:id/pdf/file → application/pdf；未下载 → 404 带下一步", async () => {
    fx = makeServer({ slug: "u56", llm: new FakeLlm([]) });
    const pdf = join(tmp, "a.pdf"); writeFileSync(pdf, "%PDF-1.4\n%%EOF\n");
    // 直接往夹具项目的文献库写两篇：一篇标了 pdfPath，一篇没有。
    const project = fx.manager.open("u56");
    const lib = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const base = { authors: [{ name: "A" }], year: 2024, venue: "V", ids: {}, abstract: "", url: null, pdfUrl: null, citedByCount: 0, isOpenAccess: true, sources: ["openalex"], references: [] };
    const withPdf = lib.add({ ...base, title: "With PDF", doi: "10.1/with" } as never).paper.id;
    const noPdf = lib.add({ ...base, title: "No PDF", doi: "10.1/none" } as never).paper.id;
    lib.update(withPdf, { pdfPath: pdf, pdfStatus: "downloaded", checksum: "sha256:x" });
    lib.close(); project.close();

    const ok = await fetch(`${fx.base}/api/lit/papers/${withPdf}/pdf/file?project=u56`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/pdf");
    expect((await ok.text()).startsWith("%PDF")).toBe(true);

    const missing = await fx.get<{ error: string }>(`/api/lit/papers/${noPdf}/pdf/file?project=u56`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("尚未下载");
  });
});
