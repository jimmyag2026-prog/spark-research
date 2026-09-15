// v0.10 收口门禁：枢纽文件（orchestrator / router / session.ts / context.ts）上的接线。
// 各 lane 的门禁钉的是各自模块；这里钉的是「lane 交来的收口 diff 真的接上了」。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { LLMRouter, type CallOptions, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { isReasoningModel } from "../../backend/src/llm/providers/registry";
import { STAGE_MAX_TOKENS } from "../../backend/src/literature/limits";
import type { LiteratureSearchResult } from "../../backend/src/literature/search";
import type { PartialEvent } from "../../backend/src/agents/progress";
import { makeServer } from "../helpers/server_scenario";

const paper = (i: number) => ({
  title: `Paper ${i} on repetitive strain injury`,
  authors: [{ name: `Author ${i}` }],
  year: 2020 + i,
  venue: "J Occup Health",
  doi: `10.1000/rsi.${i}`,
  ids: { doi: `10.1000/rsi.${i}` },
  abstract: `Abstract ${i}: prevalence and prevention of RSI among office workers.`,
  url: null, pdfUrl: null, citedByCount: 10 * i, isOpenAccess: false, sources: ["openalex"], references: [],
});
const fakeSearcher = (n = 2) => ({
  async search(query: string): Promise<LiteratureSearchResult> {
    return {
      query,
      sources: [{ source: "openalex", outcome: "ok", count: n, elapsedMs: 5 }],
      papers: Array.from({ length: n }, (_, i) => paper(i)),
    } as unknown as LiteratureSearchResult;
  },
});

class ScriptLlm {
  readonly options: CallOptions[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async call(messages: ChatMessage[], o?: string | CallOptions): Promise<LlmResponse> {
    this.options.push(typeof o === "string" ? { model: o } : (o ?? {}));
    const content = this.replies[Math.min(this.i++, this.replies.length - 1)]!;
    return { ok: true, content, provider: "kimi", model: "test", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as LlmResponse;
  }
  listModels() { return {}; }
}
const PLAN_LIT = JSON.stringify([{ id: "t1", kind: "skill", description: "查文献", params: { skill: "literature-search", queries: ["rsi china"] } }]);
const PLAN_ANALYSIS = JSON.stringify([{ id: "t1", kind: "analysis", description: "分析一下" }]);

let root: string; let pm: ProjectManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "w10-closeout-")); pm = new ProjectManager(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function orchWith(llm: ScriptLlm, slug: string, sessionId: string) {
  pm.create(slug, { name: "x" });
  pm.bindSession(sessionId, slug);
  return new OrchestratorAgent(new SparkResearchDaemon({ projects: pm }), {
    llm: llm as never, projects: pm, workspaceRoot: join(root, "ws"), literatureSearcher: fakeSearcher(2),
  });
}

describe("收口 · α-3 推理模型不发 max_tokens（router 层根治）", () => {
  test("名单：kimi-k2.6（含 provider 前缀）与 deepseek-reasoner 是思考型；glm-5.3-flash 不是", () => {
    expect(isReasoningModel("moonshotai/kimi-k2.6")).toBe(true);
    expect(isReasoningModel("kimi-k2.6")).toBe(true);
    expect(isReasoningModel("deepseek-reasoner")).toBe(true);
    expect(isReasoningModel("z-ai/glm-5.3-flash")).toBe(false);
  });

  test("接线：同一个 router，思考型模型的请求体没有 max_tokens，非思考型带上", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const router = new LLMRouter({ OPENROUTER_API_KEY: "test-key" }, { fetchImpl });
    await router.call([{ role: "user", content: "hi" }], { model: "moonshotai/kimi-k2.6", maxTokens: 300 });
    await router.call([{ role: "user", content: "hi" }], { model: "z-ai/glm-5.3-flash", maxTokens: 300 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.max_tokens).toBeUndefined();
    expect(bodies[1]!.max_tokens).toBe(300);
  });
});

describe("收口 · α-3 plan / summarize 的 maxTokens 接线", () => {
  test("一次 chat：plan 那次调用 maxTokens = STAGE_MAX_TOKENS.plan，summarize 那次 = .summarize", async () => {
    const llm = new ScriptLlm([PLAN_ANALYSIS, "分析结果", "汇总"]);
    const orch = orchWith(llm, "lp-mt", "s-mt");
    await orch.chat({ sessionId: "s-mt", message: "RSI" });
    expect(llm.options.length).toBeGreaterThanOrEqual(3);
    expect(llm.options[0]!.maxTokens).toBe(STAGE_MAX_TOKENS.plan);
    expect(llm.options[llm.options.length - 1]!.maxTokens).toBe(STAGE_MAX_TOKENS.summarize);
  });
});

describe("收口 · β 流式钩子与取消透到 chat()", () => {
  test("β-2：chat(onPartial) 在文献技能执行时收到 papers 与 search_source（候选清单先于汇总）", async () => {
    const llm = new ScriptLlm([PLAN_LIT, "汇总"]);
    const orch = orchWith(llm, "lp-partial", "s-partial");
    const events: PartialEvent[] = [];
    await orch.chat({ sessionId: "s-partial", message: "RSI", onPartial: (e) => events.push(e) });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("papers");
    expect(kinds).toContain("search_source");
    expect(events.every((e) => e.taskId === "t1")).toBe(true);
  });

  test("β-4：chat(signal) 透到每次模型调用的 options.signal（同一个对象），chat 结束后不粘连", async () => {
    const llm = new ScriptLlm([PLAN_ANALYSIS, "分析结果", "汇总"]);
    const orch = orchWith(llm, "lp-sig", "s-sig");
    const controller = new AbortController();
    await orch.chat({ sessionId: "s-sig", message: "RSI", signal: controller.signal });
    expect(llm.options.length).toBeGreaterThanOrEqual(3);
    expect(llm.options.every((o) => o.signal === controller.signal)).toBe(true);
    const llm2 = new ScriptLlm([PLAN_ANALYSIS, "分析结果", "汇总"]);
    const orch2 = orchWith(llm2, "lp-sig2", "s-sig2");
    await orch2.chat({ sessionId: "s-sig2", message: "RSI" });
    expect(llm2.options.every((o) => o.signal === undefined)).toBe(true);
  });
});

describe("收口 · γ-4 runSkill 接进 orchestrator 的 case \"skill\"", () => {
  test("注册表里的技能（paper-download）真执行：输出是执行摘要而不是说明书；表外技能仍只加载上下文", async () => {
    const plan = JSON.stringify([
      { id: "t1", kind: "skill", description: "下载", params: { skill: "paper-download" } },
      { id: "t2", kind: "skill", description: "别的", params: { skill: "protein-analysis" } },
    ]);
    const llm = new ScriptLlm([plan, "汇总"]);
    const orch = orchWith(llm, "lp-skill", "s-skill");
    const result = await orch.processRequest("下载文献", "s-skill");
    const t1 = result.execution.find((e) => e.taskId === "t1")!;
    expect(t1.output).toMatch(/paper-download/);
    expect(t1.output).not.toMatch(/^#\s/m);
    const t2 = result.execution.find((e) => e.taskId === "t2")!;
    expect(t2.ok).toBe(true);
    expect(t2.output).not.toMatch(/paper-download/);
  });
});

describe("收口 · session.ts SSE 出口转发 partial", () => {
  test("POST /api/session/stream：文献技能执行时流里有 partial 事件；仍以 start 开头、done 结尾", async () => {
    const llm = new ScriptLlm([PLAN_LIT, "汇总"]);
    const fx = makeServer({ llm: llm as never, searcher: fakeSearcher(2) as never });
    try {
      const res = await fetch(`${fx.base}/api/session/stream`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s-sse-partial", message: "RSI", project: fx.project.slug }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const kinds = text.split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
      expect(kinds[0]).toBe("start");
      expect(kinds[kinds.length - 1]).toBe("done");
      expect(kinds).toContain("partial");
    } finally {
      await fx.stop();
    }
  });
});

describe("收口 · δ-2 /api/health 带 frontendBuilt（app.ts 接线）", () => {
  test("GET /api/health 的载荷来自 server/health.ts：有 frontendBuilt 字段，status/version 仍在", async () => {
    const fx = makeServer({});
    try {
      const { status, body } = await fx.get<{ status: string; version: string; frontendBuilt?: boolean | null }>("/api/health");
      expect(status).toBe(200);
      expect(body.status).toBe("ok");
      expect(typeof body.version).toBe("string");
      expect("frontendBuilt" in body).toBe(true);
    } finally {
      await fx.stop();
    }
  });
});
