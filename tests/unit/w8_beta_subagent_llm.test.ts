// v0.8 W8-1 β · V78 残余：子代理 tool loop（`subAgentLlm()`）此前裸调 `llm.call`——
// 不进 usage.jsonl 也不进 raw/llm/，与 `llmFor()`（chat 主循环，command="chat"）同一处
// 漏记的另一半。修复后：会话绑定了项目时，子代理的每次真实 LLM 调用都经
// `usageTrackingLlm`（command="chat:subagent"），落 usage.jsonl 一行、raw/llm 一行。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import type { McpToolRunner } from "../../backend/src/mcp/server";
import { ProjectManager } from "../../backend/src/project/manager";
import { LLMRouter, type CallOptions, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { llmExtras } from "../../backend/src/llm/types";
import { JsonlRawSink } from "../../backend/src/raw";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "w8-beta-subagent-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function planResponse(): LlmResponse {
  return {
    ok: true,
    provider: "fake",
    model: "fake-model",
    content: JSON.stringify([{ id: "t1", kind: "subagent", description: "去检索一下", params: { subagent: "explore" } }]),
    ...llmExtras(),
  };
}

function subAgentDoneResponse(model: string): LlmResponse {
  // toolCalls 为空 → sub_agent.ts 的 runSubAgent() 立即以 stopReason:"done" 结束循环
  // （不需要真的驱动一轮工具调用，本文件只关心「这次调用有没有被计费/落账」）。
  return { ok: true, provider: "fake", model, content: "子代理检索完了", ...llmExtras() };
}

describe("V78 · subAgentLlm() 经 usageTrackingLlm 入账", () => {
  test("会话绑定了项目：子代理的一次真实调用 → usage.jsonl 一行 command=chat:subagent、raw/llm 一行", async () => {
    const workspaceRoot = tmpRoot();
    const manager = new ProjectManager(workspaceRoot);
    const toolRunner = { call: async () => ({ ok: true, payload: {} }) } as unknown as McpToolRunner;

    const llm = {
      call: async (_messages: ChatMessage[], modelOrOptions: string | CallOptions = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
        const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
        if (options.tools) return subAgentDoneResponse(options.model ?? "fake-model");
        return planResponse(); // plan() 调用：不带 tools
      },
      listModels: () => ({ kimi: [], openai: [], anthropic: [], deepseek: [], qwen: [], openrouter: [] }),
      capabilitiesFor: () => ({ toolCalling: true, jsonMode: true, streaming: true, usageReported: true }),
    };

    const daemon = new SparkResearchDaemon();
    const orch = new OrchestratorAgent(daemon, { llm, projects: manager, toolRunner });
    const sessionId = "sess_v78_subagent";
    const result = await orch.processRequest("帮我研究一下", sessionId);

    const outcome = result.execution.find((e) => e.kind === "subagent");
    expect(outcome).toBeDefined();
    expect(outcome?.ok).toBe(true);

    // 会话归属的项目——processRequest 内部会绑定到默认项目（AD-1）。
    const project = manager.projectForSession(sessionId);
    const usagePath = join(project.paths.root, "usage.jsonl");
    expect(existsSync(usagePath)).toBe(true);
    const usageLines = readFileSync(usagePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const subagentEntries = usageLines.filter((e) => e.command === "chat:subagent");
    expect(subagentEntries.length).toBeGreaterThan(0);
    expect(subagentEntries[0]!.ok).toBe(true);

    // raw/llm 同步落账，sessionId/project 都透传对了。
    const rawSink = project.raw() as JsonlRawSink;
    const rawLlmEntries = [...rawSink.iterate({ kind: "llm" })].filter((e) => e.command === "chat:subagent");
    expect(rawLlmEntries.length).toBeGreaterThan(0);
    expect(rawLlmEntries[0]!.sessionId).toBe(sessionId);
    expect(rawLlmEntries[0]!.project).toBe(project.slug);
  });

  test("没有 projects 注入（会话绑不到项目）：子代理调用退回裸 llm，不落任何 usage/raw（不假装记了）", async () => {
    const toolRunner = { call: async () => ({ ok: true, payload: {} }) } as unknown as McpToolRunner;
    const llm = {
      call: async (_messages: ChatMessage[], modelOrOptions: string | CallOptions = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
        const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
        if (options.tools) return subAgentDoneResponse(options.model ?? "fake-model");
        return planResponse();
      },
      listModels: () => ({ kimi: [], openai: [], anthropic: [], deepseek: [], qwen: [], openrouter: [] }),
      capabilitiesFor: () => ({ toolCalling: true, jsonMode: true, streaming: true, usageReported: true }),
    };
    const daemon = new SparkResearchDaemon();
    // 刻意不传 projects——subAgentLlm() 应该退回裸 llm.call，不抛错、不假装记账。
    const orch = new OrchestratorAgent(daemon, { llm, toolRunner });
    const result = await orch.processRequest("帮我研究一下", "sess_v78_no_project");
    const outcome = result.execution.find((e) => e.kind === "subagent");
    expect(outcome?.ok).toBe(true);
    expect(outcome?.output).toContain("子代理检索完了");
  });
});
