// v0.9.1 本地使用窗口门禁（USAGE_LOG U38 U39 U40）。
// 现场：2026-09-15 网页端 chat「帮我下载 mRNA × AI 的综述」——三次连接器失败被记成 ok，
// 子代理类型写成 "Review" 崩 TypeError，Europe PMC 空壳当成功。见 docs/UX_TEST_v0.9.0.md。
import { describe, expect, test } from "bun:test";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import {
  OrchestratorAgent,
  connectorFailureOf,
  normalizeSubAgentType,
} from "../../backend/src/agents/orchestrator";
import { buildSubAgentSpec, SUB_AGENT_TYPES } from "../../backend/src/agents/sub_agent";
import { searchPayloadProblem } from "../../backend/src/connectors/base";
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
