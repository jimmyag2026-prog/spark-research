// R7 修复窗口门禁（v0.10.0-alpha.2）：U66 U67 U59 U69 U64 U62。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { LLMRouter, type CallOptions, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { isReasoningModel, resetLearnedReasoningModels } from "../../backend/src/llm/providers/registry";
import { PdfDownloader } from "../../backend/src/literature/pdf";
import { LibraryStore } from "../../backend/src/literature/library";
import { runLitCommand } from "../../backend/src/literature/cli";

class ScriptLlm {
  readonly options: CallOptions[] = [];
  readonly prompts: string[] = [];
  private i = 0;
  constructor(private readonly replies: Array<string | { content: string; outputTokens: number }>) {}
  async call(messages: ChatMessage[], o?: string | CallOptions): Promise<LlmResponse> {
    this.options.push(typeof o === "string" ? { model: o } : (o ?? {}));
    this.prompts.push(messages.map((m) => m.content).join("\n"));
    const r = this.replies[Math.min(this.i++, this.replies.length - 1)]!;
    const content = typeof r === "string" ? r : r.content;
    const outputTokens = typeof r === "string" ? 5 : r.outputTokens;
    return { ok: true, content, provider: "kimi", model: "test", usage: { inputTokens: 1, outputTokens } } as unknown as LlmResponse;
  }
  listModels() { return {}; }
}

let root: string; let pm: ProjectManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "r7win-")); pm = new ProjectManager(root); resetLearnedReasoningModels(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); resetLearnedReasoningModels(); });

function orchWith(llm: ScriptLlm, slug: string, sessionId: string) {
  pm.create(slug, { name: "x" }); pm.bindSession(sessionId, slug);
  return new OrchestratorAgent(new SparkResearchDaemon({ projects: pm }), { llm: llm as never, projects: pm, workspaceRoot: join(root, "ws") });
}

const openaiFetch = (bodies: Array<Record<string, unknown>>, replies: Array<{ content: string; completion_tokens: number }>) => {
  let i = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { content: r.content } }], usage: { prompt_tokens: 10, completion_tokens: r.completion_tokens } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
};

describe("U66/U67 · router：带上限拿到空正文 / 顶满上限 → 学为思考型并不带上限重试一次", () => {
  test("空正文：第二次请求体没有 max_tokens，返回的是第二次的正文；该模型此后一律不带上限", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const router = new LLMRouter({ KIMI_API_KEY: "k" }, { fetchImpl: openaiFetch(bodies, [{ content: "", completion_tokens: 600 }, { content: "real answer", completion_tokens: 40 }]) });
    const res = await router.call([{ role: "user", content: "hi" }], { model: "kimi-k2", maxTokens: 600 });
    expect(res.ok && res.content).toBe("real answer");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.max_tokens).toBe(600);
    expect(bodies[1]!.max_tokens).toBeUndefined();
    expect(isReasoningModel("kimi-k2")).toBe(true);
    await router.call([{ role: "user", content: "again" }], { model: "kimi-k2", maxTokens: 600 });
    expect(bodies[2]!.max_tokens).toBeUndefined();
  });

  test("顶满上限但有正文（截断 JSON）：同样重试一次；未顶满的正常返回只打一次", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const router = new LLMRouter({ KIMI_API_KEY: "k" }, { fetchImpl: openaiFetch(bodies, [{ content: '[{"id":"t1","kind":"sk', completion_tokens: 600 }, { content: "[]", completion_tokens: 3 }]) });
    await router.call([{ role: "user", content: "plan" }], { model: "kimi-k2", maxTokens: 600 });
    expect(bodies).toHaveLength(2);
    const bodies2: Array<Record<string, unknown>> = [];
    const router2 = new LLMRouter({ KIMI_API_KEY: "k" }, { fetchImpl: openaiFetch(bodies2, [{ content: "short", completion_tokens: 3 }]) });
    resetLearnedReasoningModels();
    await router2.call([{ role: "user", content: "x" }], { model: "kimi-k2", maxTokens: 600 });
    expect(bodies2).toHaveLength(1);
  });

  test("名单：glm-5.3-flash 与 deepseek-v4-flash 现在是思考型（R7 现场）", () => {
    expect(isReasoningModel("z-ai/glm-5.3-flash")).toBe(true);
    expect(isReasoningModel("deepseek-v4-flash")).toBe(true);
  });
});

describe("U66 · plan 解析失败重试一次（不带上限）再退默认计划", () => {
  test("第一次截断 JSON → 第二次合法 → 用第二次的计划；执行日志留痕", async () => {
    const llm = new ScriptLlm(['[{"id":"t1","kind":"analysis","descr', '[{"id":"t9","kind":"analysis","description":"ok"}]', "分析", "汇总"]);
    const orch = orchWith(llm, "lp-retry", "s-retry");
    const r = await orch.processRequest("RSI", "s-retry");
    expect(r.plan.map((t) => t.id)).toEqual(["t9"]);
    expect(llm.options[1]!.maxTokens).toBeUndefined();
    expect(llm.prompts[1]).toContain("not a valid JSON array");
  });
});

describe("U67 · summarize 空正文不当结论", () => {
  test("ok:true + 空 content → summary 是结构化失败说明，failure.kind=llm，review 不 approved", async () => {
    const llm = new ScriptLlm(['[{"id":"t1","kind":"analysis","description":"x"}]', "分析", { content: "", outputTokens: 1200 }]);
    const orch = orchWith(llm, "lp-empty", "s-empty");
    const r = await orch.processRequest("RSI", "s-empty");
    expect(r.summary).toContain("空正文");
    expect(r.failure?.kind).toBe("llm");
    expect(r.review.approved).toBe(false);
  });
});

describe("U59 · S1 直答路径", () => {
  test('规划器回 {"direct": …} → 只有 1 次模型调用，response 就是答案，onDelta 收到它', async () => {
    const llm = new ScriptLlm([JSON.stringify({ direct: "你好！我是 Spark Research。" })]);
    const orch = orchWith(llm, "lp-direct", "s-direct");
    const chunks: string[] = [];
    const r = await orch.chat({ sessionId: "s-direct", message: "你好", onDelta: (c) => chunks.push(c) });
    expect(llm.options).toHaveLength(1);
    expect(r.response).toContain("你好！我是 Spark Research。");
    expect(chunks.join("")).toBe("你好！我是 Spark Research。");
    expect(llm.prompts[0]).toContain('{"direct"');
  });
  test("任务数组照旧走三段（直答不误伤）", async () => {
    const llm = new ScriptLlm(['[{"id":"t1","kind":"analysis","description":"x"}]', "分析", "汇总"]);
    const orch = orchWith(llm, "lp-tasks", "s-tasks");
    await orch.chat({ sessionId: "s-tasks", message: "分析一下" });
    expect(llm.options).toHaveLength(3);
  });
});

describe("U64 · Unpaywall 给的直链与已失败候选相同 → 不再敲第二次", () => {
  test("同一 URL 只请求一次，attempts 里留 skipped 痕迹", async () => {
    const hits: string[] = [];
    const http = {
      async request(url: string) {
        hits.push(url);
        const mk = (status: number, body: string, ct: string) => {
          const bytes = new TextEncoder().encode(body);
          return { status, ok: status >= 200 && status < 300, url, headers: { "content-type": ct }, text: async () => body, bytes: async () => bytes, json: async () => JSON.parse(body) };
        };
        if (url.includes("api.unpaywall.org")) return mk(200, JSON.stringify({ best_oa_location: { url_for_pdf: "https://pub.example/x.pdf" } }), "application/json");
        return mk(403, "forbidden", "text/html");
      },
    };
    const project = pm.create("u64", { name: "x" });
    const lib = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const id = lib.add({
      title: "Same link paper", authors: [{ name: "A" }], year: 2024, venue: "J", doi: "10.1/x", ids: { doi: "10.1/x" },
      abstract: "a", url: null, pdfUrl: "https://pub.example/x.pdf", citedByCount: 1, isOpenAccess: true, sources: ["openalex"], references: [],
    } as never, { tags: ["t"] }).paper.id;
    const dl = new PdfDownloader({ http: http as never, papersDir: join(root, "papers"), library: lib, contactEmail: "real@example.org" });
    const r = await dl.download(id);
    expect(r.ok).toBe(false);
    expect(hits.filter((u) => u === "https://pub.example/x.pdf")).toHaveLength(1);
    expect(r.attempts.some((a) => a.outcome.startsWith("skipped: unpaywall"))).toBe(true);
  });
});

describe("U69 · lit search 的英译调用过台账", () => {
  test("中文检索式 → 项目 usage.jsonl 多一行 command=lit-search", async () => {
    const manager = new ProjectManager(root);
    manager.create("zh", { name: "zh" });
    const llm = new ScriptLlm(["repetitive strain injury prevention"]);
    const searcher = { async search(q: string) { return { query: q, sources: [], papers: [] }; } };
    // 注入 searcher 时 makeSearcher 直接返回它——英译只在真 LiteratureSearcher 路径触发，
    // 所以这里不注入 searcher，而注入一个不发网络请求的 http。
    const http = { async request() { return { ok: true, status: 200, headers: {}, bytes: async () => new TextEncoder().encode("{}") }; } };
    void searcher;
    const code = await runLitCommand(["search", "重复性劳损 预防", "--project", "zh", "--sources", "openalex", "--limit", "1"], { manager, root, llm: llm as never, http: http as never, out: () => {}, err: () => {} });
    expect(code).toBeGreaterThanOrEqual(0);
    const ledger = join(root, "projects", "zh", "usage.jsonl");
    const p = existsSync(ledger) ? ledger : join(manager.open("zh").paths.root, "usage.jsonl");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toContain('"lit-search"');
  });
});
