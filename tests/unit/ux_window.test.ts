// v0.9.1 本地使用窗口门禁（USAGE_LOG U38 U39 U40）。
// 现场：2026-09-15 网页端 chat「帮我下载 mRNA × AI 的综述」——三次连接器失败被记成 ok，
// 子代理类型写成 "Review" 崩 TypeError，Europe PMC 空壳当成功。见 docs/UX_TEST_v0.9.0.md。
import { describe, expect, test } from "bun:test";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import {
  OrchestratorAgent,
  connectorFailureOf,
  connectorSearchDigest,
  normalizeSubAgentType,
} from "../../backend/src/agents/orchestrator";
import {
  buildSubAgentSpec,
  SUB_AGENT_TYPES,
  toolResultContent as toolResultContentForTest,
  TOOL_RESULT_MAX_CHARS as TOOL_RESULT_MAX_CHARS_FOR_TEST,
} from "../../backend/src/agents/sub_agent";
import { searchPayloadProblem } from "../../backend/src/connectors/base";
import { PubMedConnector } from "../../backend/src/connectors/literature";
import {
  ConnectorRegistry,
  connectorPlanningInventory,
  renderConnectorInventory,
} from "../../backend/src/connectors/registry";
import { StubHttp, BufferedResponse } from "../../backend/src/http/client";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

/** 只按顺序吐预设内容、并把收到的 prompt 存下来的假 LLM。 */
class RecordingLlm {
  readonly prompts: string[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async call(messages: ChatMessage[]): Promise<LlmResponse> {
    this.prompts.push(messages.map((m) => m.content).join("\n"));
    const content = this.replies[Math.min(this.i++, this.replies.length - 1)] ?? "";
    return { ok: true, content, provider: "kimi", model: "test", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as LlmResponse;
  }
  listModels() {
    return {};
  }
}

/** 跑一轮 chat，返回 summarize 那一次收到的 prompt（执行摘要就在里面）。 */
async function runWithConnector(
  sessionId: string,
  envelope: unknown,
  params: Record<string, unknown> = { server: "pubmed", tool: "search", args: { query: "x" } },
) {
  const daemon = new SparkResearchDaemon();
  (daemon as unknown as { dispatch: (t: string, p: unknown) => Promise<unknown> }).dispatch = async () => envelope;
  const llm = new RecordingLlm([
    JSON.stringify([{ id: "t1", kind: "connector", description: "查文献", params }]),
    "汇总",
  ]);
  const orch = new OrchestratorAgent(daemon, { llm: llm as never });
  const result = await orch.processRequest("查文献", sessionId);
  return { result, prompts: llm.prompts };
}

describe("U38 · 连接器失败不得记成成功的任务", () => {
  test("mcp_call 回 ok:false 信封 → 这一步 failed，且上游 error 原文进执行摘要", async () => {
    const { result, prompts } = await runWithConnector("s-u38", {
      ok: false,
      server: "pubmed",
      tool: "search",
      error: "HTTP request timed out after 30000ms",
    });
    const outcome = result.execution.find((e) => e.taskId === "t1");
    expect(outcome?.ok).toBe(false);
    expect(prompts.join("\n")).toContain("[connector] t1: failed");
    expect(prompts.join("\n")).toContain("timed out");
  });

  test("连接器成功仍是 ok（回归防护）", async () => {
    const { result, prompts } = await runWithConnector("s-u38b", { ok: true, server: "pubmed", tool: "search", result: { hitCount: 3 } });
    expect(result.execution.find((e) => e.taskId === "t1")?.ok).toBe(true);
    expect(prompts.join("\n")).toContain("[connector] t1: ok");
  });

  test("判据只看 ok===false，不去猜「结果是不是空的」", () => {
    expect(connectorFailureOf({ ok: false, error: "boom" })).toBe("boom");
    expect(connectorFailureOf({ ok: false })).toContain("连接器调用失败");
    expect(connectorFailureOf({ ok: true, result: {} })).toBeNull();
    expect(connectorFailureOf({ result: [] })).toBeNull();
    expect(connectorFailureOf("plain string")).toBeNull();
  });
});

describe("U39 · 子代理类型是不可信输入", () => {
  test("模型写 'Review'（大写）→ 归一成 review；认不出返回 null", () => {
    expect(normalizeSubAgentType("Review")).toBe("review");
    expect(normalizeSubAgentType("  EXECUTE ")).toBe("execute");
    expect(normalizeSubAgentType(undefined)).toBe("execute");
    expect(normalizeSubAgentType("Reviewer")).toBeNull();
  });

  test("未知类型的 subagent 任务 → ok:false 且消息列出可用类型，不是 TypeError", async () => {
    const daemon = new SparkResearchDaemon();
    const llm = new RecordingLlm([
      JSON.stringify([{ id: "t1", kind: "subagent", description: "复核", params: { subagent: "Reviewer" } }]),
      "汇总",
    ]);
    const orch = new OrchestratorAgent(daemon, { llm: llm as never });
    const result = await orch.processRequest("复核一下", "s-u39");
    const outcome = result.execution.find((e) => e.taskId === "t1");
    expect(outcome?.ok).toBe(false);
    expect(outcome?.output).toContain("未知子代理类型");
    expect(outcome?.output).toContain("explore");
    expect(outcome?.output).not.toContain("undefined is not an object");
  });

  test("buildSubAgentSpec 收到未知类型 → 带下一步的错误", () => {
    expect(SUB_AGENT_TYPES).toContain("review");
    expect(() => buildSubAgentSpec("Reviewer" as never)).toThrow(/未知子代理类型/);
    expect(() => buildSubAgentSpec("Reviewer" as never)).toThrow(/下一步/);
  });

  test("SUB_AGENT_TYPES 只有一份（orchestrator 不再自带副本）", async () => {
    const src = await Bun.file(new URL("../../backend/src/agents/orchestrator.ts", import.meta.url)).text();
    expect(src).not.toMatch(/^const SUB_AGENT_TYPES/m);
  });
});

describe("U40 · search 的响应里至少要有计数或结果容器", () => {
  test("只有 version 的空壳 → 点名「空壳」与下一步", () => {
    const msg = searchPayloadProblem("europepmc", { version: "6.9" });
    expect(msg).toContain("空壳");
    expect(msg).toContain("下一步");
  });
  test("有计数或结果容器就放行；0 条也放行（0 条是合法结果，语法错不是）", () => {
    expect(searchPayloadProblem("europepmc", { version: "6.9", hitCount: 0, resultList: { result: [] } })).toBeNull();
    expect(searchPayloadProblem("pubmed", { esearchresult: { idlist: [] } })).toBeNull();
    expect(searchPayloadProblem("crossref", { message: { items: [] } })).toBeNull();
    expect(searchPayloadProblem("openalex", { results: [] })).toBeNull();
  });
  test("非对象响应也拒", () => {
    expect(searchPayloadProblem("arxiv", "<xml/>")).toContain("非对象");
  });

  test("编排层：search 拿到空壳 → 任务 failed；getPaper 拿到同样的壳 → 不拦（单条取回不适用）", async () => {
    const shell = { ok: true, server: "europepmc", tool: "search", result: { version: "6.9" } };
    const searched = await runWithConnector("s-u40", shell, { server: "europepmc", tool: "search", args: { query: "x" } });
    expect(searched.result.execution.find((e) => e.taskId === "t1")?.ok).toBe(false);
    expect(searched.prompts.join("\n")).toContain("[connector] t1: failed");

    const fetched = await runWithConnector("s-u40b", { ...shell, tool: "getPaper" }, { server: "europepmc", tool: "getPaper", args: { id: "PMC1" } });
    expect(fetched.result.execution.find((e) => e.taskId === "t1")?.ok).toBe(true);
  });
});

describe("U45 · PubMed 认 NCBI 原名 term，空检索词不发给上游", () => {
  function capture() {
    const calls: string[] = [];
    const http = new StubHttp((url: string) => {
      calls.push(url);
      return new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ esearchresult: { idlist: [] } })),
      });
    });
    return { http, calls };
  }

  test("只传 term（NCBI 原名）→ 真的带进 esearch，不被空串覆盖", async () => {
    const { http, calls } = capture();
    await new PubMedConnector({ http }).search({ term: "repetitive strain injury AND China[Affiliation]" });
    expect(calls[0]).toContain("term=repetitive");
    expect(calls[0]).not.toContain("term=&");
  });

  test("query 与 term 同时给 → query 赢（平台统一名优先）", async () => {
    const { http, calls } = capture();
    await new PubMedConnector({ http }).search({ query: "alpha", term: "beta" });
    expect(calls[0]).toContain("term=alpha");
    expect(calls[0]).not.toContain("beta");
  });

  test("两个都不给 / 都是空 → 当场失败，不向上游发空检索词", async () => {
    const { http, calls } = capture();
    const c = new PubMedConnector({ http });
    await expect(c.search({})).rejects.toThrow(/缺少检索词/);
    await expect(c.search({ term: "   " })).rejects.toThrow(/缺少检索词/);
    expect(calls).toHaveLength(0);
  });

  test("上游 200 + 业务错误（NCBI ERROR / REST errCode）→ 判为失败，不当成合法空结果", () => {
    const ncbi = searchPayloadProblem("pubmed", { esearchresult: { ERROR: "Empty term and query_key - nothing todo" } });
    expect(ncbi).toContain("被上游拒绝");
    expect(ncbi).toContain("Empty term");
    expect(searchPayloadProblem("europepmc", { errCode: 404, errMsg: "No search criteria provided" })).toContain("被上游拒绝");
    // 正常空结果仍然放行：0 条是合法结果
    expect(searchPayloadProblem("pubmed", { esearchresult: { idlist: [] } })).toBeNull();
  });
});

describe("U46 · placeholder 连接器早失败，不发网络请求", () => {
  test("cnki / wanfang 调用 → 抛「占位实现」+ 下一步，且一次 HTTP 都没发", async () => {
    const calls: string[] = [];
    const http = new StubHttp((url: string) => {
      calls.push(url);
      return new BufferedResponse({ status: 200, headers: {}, body: new TextEncoder().encode("{}") });
    });
    const reg = new ConnectorRegistry({ http }).registerBuiltins();
    for (const id of ["cnki", "wanfang"]) {
      await expect(reg.call(id, "search", { query: "重复性劳损" })).rejects.toThrow(/占位实现/);
      await expect(reg.call(id, "search", { query: "重复性劳损" })).rejects.toThrow(/下一步/);
    }
    expect(calls).toHaveLength(0);
  });

  test("非 placeholder 的源不受影响（回归防护）", async () => {
    const http = new StubHttp(
      () =>
        new BufferedResponse({
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify({ esearchresult: { idlist: [] } })),
        }),
    );
    const reg = new ConnectorRegistry({ http }).registerBuiltins();
    await expect(reg.call("pubmed", "search", { query: "x" })).resolves.toBeDefined();
  });
});

describe("U44 · 工具返回进对话历史前先瘦身", () => {
  const bigPaper = (i: number) => ({
    title: `Paper ${i}`,
    authors: Array.from({ length: 30 }, (_, k) => ({ name: `Author ${k}` })),
    year: 2024,
    venue: "Nature",
    doi: `10.1/${i}`,
    ids: { pmid: String(i), pmcid: `PMC${i}` },
    abstract: "A".repeat(3000),
    url: "https://example.com/x",
    pdfUrl: "https://example.com/x.pdf",
    citedByCount: i,
    isOpenAccess: true,
    sources: ["openalex"],
    references: Array.from({ length: 80 }, (_, k) => `10.9/${k}`),
  });

  test("检索结果被瘦身：保留每源 outcome/count 与前 10 篇要素，砍掉 references/authors，注明砍了什么", () => {
    const outcome = {
      ok: true,
      payload: {
        query: "rsi",
        sources: [{ source: "openalex", outcome: "ok", count: 30 }],
        papers: Array.from({ length: 20 }, (_, i) => bigPaper(i)),
        totalBeforeDedupe: 60,
        afterDedupe: 20,
      },
    };
    const raw = JSON.stringify(outcome);
    const out = toolResultContentForTest(outcome);
    expect(raw.length).toBeGreaterThan(50_000); // 原始返回是六位数量级；瘦身后必须落到四位
    expect(out.length).toBeLessThan(TOOL_RESULT_MAX_CHARS_FOR_TEST);
    const parsed = JSON.parse(out) as { payload: { sources: unknown[]; papers: unknown[]; _compacted: { papersShown: number; papersTotal: number; note: string; droppedFields: string[] } } };
    expect(parsed.payload.sources).toHaveLength(1); // 每源的 outcome/count 一条不少
    expect(parsed.payload.papers).toHaveLength(10);
    expect(parsed.payload._compacted.papersTotal).toBe(20);
    expect(parsed.payload._compacted.note).toContain("10/20");
    // 「references」这个词只该出现在 droppedFields / note 里，不该再有真数据
    expect(out).not.toContain('"references":[');
    expect(out).not.toContain("Author 29");
    expect(out).not.toContain("10.9/"); // 参考文献 DOI 一条都不该留
    expect(parsed.payload._compacted.droppedFields).toContain("references");
  });

  test("认不出形状的大返回 → 截断且**明说**被截断（静默截断比截断更危险）", () => {
    const outcome = { ok: true, payload: { blob: "Z".repeat(50_000) } };
    const parsed = JSON.parse(toolResultContentForTest(outcome)) as { _truncated?: boolean; _note?: string; _originalChars?: number };
    expect(parsed._truncated).toBe(true);
    expect(parsed._originalChars).toBeGreaterThan(50_000);
    expect(parsed._note).toContain("不是完整结果");
  });

  test("小返回原样透传（不给正常路径加噪声）", () => {
    const outcome = { ok: true, payload: { project: "p", papers: [], sources: [] } };
    const parsed = JSON.parse(toolResultContentForTest(outcome)) as { _truncated?: boolean };
    expect(parsed._truncated).toBeUndefined();
  });
});

describe("U47 · 规划器拿到真实连接器清单，不再猜工具名 / 不再排死源", () => {
  test("清单里的工具名与 registry 实际暴露的逐字一致（猜出来的 esearch 不在其中）", () => {
    const reg = new ConnectorRegistry().registerBuiltins();
    for (const entry of connectorPlanningInventory()) {
      if (!entry.usable) continue;
      const real = reg.listTools(entry.name).map((t) => t.name);
      expect(entry.tools).toEqual(real);
    }
    const pubmed = connectorPlanningInventory().find((e) => e.name === "pubmed")!;
    expect(pubmed.tools).toEqual(["search", "getPaper", "getAbstract"]);
    expect(pubmed.tools).not.toContain("esearch"); // 三次真实会话里模型猜的那个名字
  });

  test("placeholder 源被标不可用并进黑名单；渲染文本点名 cnki / wanfang", () => {
    const inv = connectorPlanningInventory();
    for (const id of ["cnki", "wanfang"]) {
      const e = inv.find((x) => x.name === id)!;
      expect(e.usable).toBe(false);
      expect(e.note).toContain("不要排进计划");
    }
    const text = renderConnectorInventory();
    expect(text).toContain("Do NOT plan connector tasks for these");
    expect(text).toContain("cnki");
    expect(text).toContain("wanfang");
    expect(text).toContain("pubmed: search, getPaper, getAbstract");
  });

  test("渲染出的清单足够小（plan 的 prompt 不能被它顶大——U44 的教训）", () => {
    expect(renderConnectorInventory().length).toBeLessThan(2000);
  });

  test("清单真的进了 plan 的提示词——不只是「存在一个函数」（AD-17：声明即须有读者）", async () => {
    // 阴性对照第一版只钉了清单内容，把 renderConnectorInventory() 从 prompt 里整段删掉仍然全绿。
    // 判据必须落在「规划器真的看见了它」上。
    const daemon = new SparkResearchDaemon();
    const llm = new RecordingLlm([JSON.stringify([{ id: "t1", kind: "analysis", description: "x" }]), "汇总"]);
    const orch = new OrchestratorAgent(daemon, { llm: llm as never });
    await orch.processRequest("查点文献", "s-u47");
    const planPrompt = llm.prompts[0]!;
    expect(planPrompt).toContain("pubmed: search, getPaper, getAbstract");
    expect(planPrompt).toContain("Do NOT plan connector tasks for these");
    expect(planPrompt).toContain("cnki");
  });

  test("需凭据的源仍列出来但标注会被跳过（不是黑名单）", () => {
    const s2 = connectorPlanningInventory().find((e) => e.name === "semanticscholar")!;
    expect(s2.usable).toBe(true);
    expect(s2.note).toContain("需凭据");
    expect(renderConnectorInventory()).toContain("semanticscholar:");
  });
});

describe("V171 / U48 · 连接器产出落盘 + 规划器知道路径 + summarize 看摘要而非前 200 字符", () => {
  const openalexShaped = {
    ok: true, server: "openalex", tool: "search",
    result: { meta: { count: 56768, page: 1, per_page: 25 }, results: [
      { display_name: "Recursive Self-Improvement in AI", publication_year: 2024 },
      { display_name: "Superintelligence Governance", publication_year: 2023 },
      { display_name: "Third Paper", publication_year: 2022 },
    ] },
  };
  test("summarize 收到的是「条数 + 标题 + 落盘路径」，不是被 200 字符截断的 meta", async () => {
    const { result, prompts } = await runWithConnector("s-v171", openalexShaped, { server: "openalex", tool: "search", args: { query: "x" } });
    expect(result.execution.find((e) => e.taskId === "t1")?.ok).toBe(true);
    const summ = prompts[prompts.length - 1]!;
    expect(summ).toContain("Recursive Self-Improvement in AI");
    expect(summ).toContain('"count":56768');
    expect(summ).toMatch(/full result: .*s-v171\/t1\.json/);
  });
  test("结果真的落盘到 <workspace>/<sessionId>/<taskId>.json，内容是完整信封", async () => {
    const { result } = await runWithConnector("s-v171b", openalexShaped, { server: "openalex", tool: "search", args: { query: "x" } });
    void result;
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { dataDir } = await import("../../backend/src/config");
    const p = join(dataDir(), "workspaces", "s-v171b", "t1.json");
    expect(existsSync(p)).toBe(true);
    const saved = JSON.parse(readFileSync(p, "utf8")) as typeof openalexShaped;
    expect(saved.result.results).toHaveLength(3);
  });
  test("规划器的提示词写明了绝对路径约定（AD-17：约定必须真的被读到）", async () => {
    const { prompts } = await runWithConnector("s-v171c", openalexShaped, { server: "openalex", tool: "search", args: { query: "x" } });
    expect(prompts[0]).toMatch(/saved to .*s-v171c\/<taskId>\.json/);
    expect(prompts[0]).toContain("must not be globbed");
  });
  test("digest 认得 openalex / crossref / europepmc / pubmed 四种形状，认不出返回 null", () => {
    expect(connectorSearchDigest(JSON.stringify(openalexShaped))).toContain("Recursive Self-Improvement");
    expect(connectorSearchDigest(JSON.stringify({ ok: true, server: "crossref", result: { message: { "total-results": 7, items: [{ title: ["Cross Title"] }] } } }))).toContain("Cross Title");
    expect(connectorSearchDigest(JSON.stringify({ ok: true, server: "europepmc", result: { hitCount: 12, resultList: { result: [{ title: "EPMC Title" }] } } }))).toContain('"count":12');
    expect(connectorSearchDigest(JSON.stringify({ ok: true, server: "pubmed", result: { result: { uids: ["1"], "1": { uid: "1", title: "PubMed Title" } } } }))).toContain("PubMed Title");
    expect(connectorSearchDigest(JSON.stringify({ ok: true, server: "x", result: { version: "6.9" } }))).toBeNull();
    expect(connectorSearchDigest("not json")).toBeNull();
  });
});
