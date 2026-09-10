import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import {
  OrchestratorAgent,
  type OrchestratorDeps,
  type ReviewerAdapter,
} from "../../backend/src/agents/orchestrator";
import { SubAgentFactory, type SubAgentType } from "../../backend/src/agents/sub_agent";
import { ResearchContract, type EvidenceQuery } from "../../backend/src/agents/contract";
import type { McpToolRunner } from "../../backend/src/mcp/server";
import { ProjectManager } from "../../backend/src/project/manager";
import { LLMRouter, type CallOptions, type ChatMessage, type LlmResponse, type ToolCall } from "../../backend/src/llm/router";
import { llmExtras, llmFailure } from "../../backend/src/llm/types";

const mockLlm = {
  call: async (
        messages: ChatMessage[],
        modelOrOptions: string | CallOptions = LLMRouter.DEFAULT_MODEL,
      ): Promise<LlmResponse> => {
        // P11 起第二参可以是模型名或 CallOptions，假实现跟着归一化一次。
        const model =
          typeof modelOrOptions === "string" ? modelOrOptions : (modelOrOptions.model ?? LLMRouter.DEFAULT_MODEL);
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return { ok: true, provider: "kimi", model, content: `[test:${model}] ${lastUser.slice(0, 120)}`, ...llmExtras() };
  },
  listModels: () => ({
    kimi: [LLMRouter.DEFAULT_MODEL],
    openai: [],
    anthropic: [],
    deepseek: [],
    qwen: [],
    openrouter: [],
  }),
};

function createOrchestrator(deps: Omit<OrchestratorDeps, "store" | "executionLog" | "graph"> = {}): {
  daemon: SparkResearchDaemon;
  orch: OrchestratorAgent;
} {
  const daemon = new SparkResearchDaemon();
  const orch = new OrchestratorAgent(daemon, { llm: mockLlm, ...deps });
  return { daemon, orch };
}

describe("OrchestratorAgent.processRequest", () => {
  test("识别请求需要的技能", async () => {
    const { orch } = createOrchestrator();
    const result = await orch.processRequest(
      "搜索蛋白质结构和相关文献（UniProt/PDB/PubMed）并做计算分析",
      "sess_skills",
    );
    expect(result.skills).toContain("protein");
    expect(result.skills).toContain("literature");
    expect(result.skills).toContain("compute");
    expect(result.plan.length).toBeGreaterThan(0);
  });

  test("触发 Reviewer 检查并在 hard finding 后修正", async () => {
    let calls = 0;
    const reviewer: ReviewerAdapter = {
      review: async () => {
        calls++;
        return calls === 1
          ? {
              approved: false,
              findings: [
                { severity: "hard", artifactId: "a1", message: "unverifiable claim", location: "report" },
              ],
              action: "inject_notice_and_veto_completion",
              notice: "veto",
            }
          : { approved: true, findings: [] };
      },
    };
    const { orch } = createOrchestrator({ reviewer, maxReviewRounds: 3 });
    const result = await orch.processRequest("分析数据集", "sess_review");

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.reviewRounds).toBe(2);
    expect(result.review.approved).toBe(true);
    const fix = result.execution.find((e) => e.taskId.startsWith("fix_"));
    expect(fix).toBeDefined();
  });

  test("hard finding 持续存在时停在 maxReviewRounds 且 approved=false", async () => {
    const reviewer: ReviewerAdapter = {
      review: async () => ({
        approved: false,
        findings: [{ severity: "hard", artifactId: "a", message: "unverifiable", location: "chat" }],
      }),
    };
    const { orch } = createOrchestrator({ reviewer, maxReviewRounds: 2 });
    const result = await orch.processRequest("验证结果", "sess_veto");

    expect(result.reviewRounds).toBe(2);
    expect(result.review.approved).toBe(false);
  });
});

describe("OrchestratorAgent D-4：LLM 调用失败不再被静默当成功", () => {
  // 模拟 router 无 key / 网络挂了时的真实返回形状：ok:false，content 是路由层
  // 拼出来的错误文本（不是模型产出）。
  const failingLlm = {
    call: async (_messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => llmFailure({ provider: "kimi", model, kind: "upstream", message: "[error] simulated upstream failure — should never leak into summary" }),
    listModels: mockLlm.listModels,
  };

  test("summarize 失败时 summary 不包含错误文本，且明确标注是 LLM 调用失败", async () => {
    const { orch } = createOrchestrator({ llm: failingLlm });
    const result = await orch.processRequest("分析数据集", "sess_llm_fail_summary");

    expect(result.summary).not.toContain("simulated upstream failure");
    expect(result.summary).not.toContain("[error]");
    expect(result.summary).toContain("LLM 调用失败");
  });

  test("plan 失败时落到 defaultPlan，且执行日志里能看到 plan-llm-failed（可见，不是静默）", async () => {
    const { daemon, orch } = createOrchestrator({ llm: failingLlm });
    const result = await orch.processRequest("分析数据集", "sess_llm_fail_plan");

    // defaultPlan()：单个 analysis 任务。
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]?.kind).toBe("analysis");

    const entries = (daemon.executionLog as unknown as { entries: Array<Record<string, unknown>> }).entries;
    const planFailed = entries.find((e) => e.action === "plan-llm-failed");
    expect(planFailed).toBeDefined();
  });

  test("analysis task 的 LLM 调用失败：ExecutionOutcome.ok=false，output 明确标注非模型产出", async () => {
    const { orch } = createOrchestrator({ llm: failingLlm });
    const result = await orch.processRequest("分析数据集", "sess_llm_fail_analysis");

    const analysisOutcome = result.execution.find((e) => e.kind === "analysis");
    expect(analysisOutcome).toBeDefined();
    expect(analysisOutcome?.ok).toBe(false);
    expect(analysisOutcome?.output).toContain("llm call failed");
    expect(analysisOutcome?.output).toContain("not a model output");
  });

  test("subagent task 的 LLM 调用失败：同样 ok=false 而不是把错误文本当产出放行", async () => {
    // 用一个总是产出单个 subagent 任务的假 llm 驱动 plan()，让 subagent 分支被执行到；
    // 之后同一个 llm 对 subagent 任务本身的调用也失败，验证该调用点独立检查了 res.ok。
    let planCalls = 0;
    const subagentPlanLlm: Pick<LLMRouter, "call" | "listModels"> = {
      call: async (
        messages: ChatMessage[],
        modelOrOptions: string | CallOptions = LLMRouter.DEFAULT_MODEL,
      ): Promise<LlmResponse> => {
        // P11 起第二参可以是模型名或 CallOptions，假实现跟着归一化一次。
        const model =
          typeof modelOrOptions === "string" ? modelOrOptions : (modelOrOptions.model ?? LLMRouter.DEFAULT_MODEL);
        planCalls++;
        if (planCalls === 1) {
          // 第一次调用是 plan()：产出一个 subagent 任务。
          const plan = JSON.stringify([
            { id: "t1", kind: "subagent", description: "delegate", params: { subagent: "execute" } },
          ]);
          return { ok: true, provider: "kimi", model, content: plan, ...llmExtras() };
        }
        // 之后所有调用（subagent 任务本身、summarize）都失败。
        return llmFailure({ provider: "kimi", model, kind: "upstream", message: "[error] simulated upstream failure" });
      },
      listModels: mockLlm.listModels,
    };
    const { orch } = createOrchestrator({ llm: subagentPlanLlm });
    const result = await orch.processRequest("随便什么请求", "sess_llm_fail_subagent");

    const subagentOutcome = result.execution.find((e) => e.kind === "subagent");
    expect(subagentOutcome).toBeDefined();
    expect(subagentOutcome?.ok).toBe(false);
    expect(subagentOutcome?.output).toContain("llm call failed");
  });

  test("LLM 调用成功时行为完全不变（回归防护）", async () => {
    const { orch } = createOrchestrator();
    const result = await orch.processRequest("分析数据集", "sess_llm_ok");
    expect(result.summary).not.toContain("LLM 调用失败");
    for (const outcome of result.execution) {
      if (outcome.kind === "analysis" || outcome.kind === "subagent") {
        expect(outcome.ok).toBe(true);
      }
    }
  });
});

describe("SubAgentFactory", () => {
  test("创建各类型子代理", () => {
    const factory = new SubAgentFactory();
    const types: SubAgentType[] = ["explore", "execute", "review", "lab"];
    for (const type of types) {
      const agent = factory.create(type);
      expect(agent.type).toBe(type);
      expect(agent.name).toBe(type);
      expect(agent.model.length).toBeGreaterThan(0);
      expect(agent.prompt.length).toBeGreaterThan(0);
      expect(Array.isArray(agent.permission)).toBe(true);
    }
  });

  test("review 子代理加载 reviewer.txt 提示词", () => {
    const factory = new SubAgentFactory();
    const review = factory.create("review");
    expect(review.prompt).toContain("TRACE DON'T RECOMPUTE");
  });
});

describe("LLMRouter", () => {
  test("无 API Key 时返回错误提示", async () => {
    const original = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("should not call network without API key");
    }) as unknown as typeof fetch;
    try {
      const router = new LLMRouter({});
      const res = await router.call([
        { role: "system", content: "sys" },
        { role: "user", content: "hello world" },
      ]);
      expect(res.ok).toBe(false);
      // AD-13：失败时 content 恒空；诊断信息只在 error.message。
      expect(res.content).toBe("");
      expect(res.error?.kind).toBe("auth");
      expect(res.error?.message).toContain("没有配置任何 API key");
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("listModels 返回全部 provider 的模型列表", () => {
    const router = new LLMRouter({});
    const models = router.listModels();
    expect(Object.keys(models)).toEqual([...LLMRouter.SUPPORTED_PROVIDERS]);
    for (const list of Object.values(models)) {
      expect(list.length).toBeGreaterThan(0);
    }
  });
});

// ── W3-a：F-2 收尾——诊断信息改读 res.error.message，不再是恒为空串的 res.content ──
//
// AD-13（P11）把 LlmResponse 做成可辨识联合之后，`ok:false` 分支的 `res.content` 类型
// 是字面量 `""`——P10 的 D-4 在四处写的 `res.content.slice(0, 200)` 诊断从那时起就在
// 往执行日志里记一个永远是空串的"诊断"。这里验证这四处已经改读 `res.error.message`：
// 失败原因不再从执行日志里凭空消失。
describe("OrchestratorAgent F-2：诊断信息不再是恒为空串的 res.content", () => {
  const failingLlm = {
    call: async (_messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> =>
      llmFailure({ provider: "kimi", model, kind: "upstream", message: "[error] simulated upstream failure — should never leak into summary" }),
    listModels: mockLlm.listModels,
  };

  function entries(daemon: SparkResearchDaemon): Array<Record<string, unknown>> {
    return (daemon.executionLog as unknown as { entries: Array<Record<string, unknown>> }).entries;
  }

  test("plan-llm-failed 日志携带真实错误信息", async () => {
    const { daemon, orch } = createOrchestrator({ llm: failingLlm });
    await orch.processRequest("分析数据集", "sess_f2_plan");
    const entry = entries(daemon).find((e) => e.action === "plan-llm-failed");
    expect(entry).toBeDefined();
    expect(String(entry!.message)).toContain("simulated upstream failure");
  });

  test("explore（analysis 任务）的 llm-failed 日志携带真实错误信息", async () => {
    const { daemon, orch } = createOrchestrator({ llm: failingLlm });
    await orch.processRequest("分析数据集", "sess_f2_analysis");
    const entry = entries(daemon).find((e) => e.action === "llm-failed" && e.actor === "explore");
    expect(entry).toBeDefined();
    expect(String(entry!.message)).toContain("simulated upstream failure");
  });

  test("summarize-llm-failed 日志携带真实错误信息", async () => {
    const { daemon, orch } = createOrchestrator({ llm: failingLlm });
    await orch.processRequest("分析数据集", "sess_f2_summarize");
    const entry = entries(daemon).find((e) => e.action === "summarize-llm-failed");
    expect(entry).toBeDefined();
    expect(String(entry!.message)).toContain("simulated upstream failure");
  });
});

// ── W3-a：subagent 任务分支接上 W2-a 的真 tool loop ──────────────────────────────

function toolCallResponse(toolCalls: ToolCall[]): LlmResponse {
  return {
    ok: true,
    provider: "fake",
    model: "fake-model",
    content: "",
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, usageUnavailable: false },
    finishReason: "tool_calls",
  } as LlmResponse;
}

function toolTextResponse(content: string): LlmResponse {
  return {
    ok: true,
    provider: "fake",
    model: "fake-model",
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, usageUnavailable: false },
  } as LlmResponse;
}

describe("OrchestratorAgent · subagent 任务分支：注入 toolRunner 后走真 tool loop", () => {
  test("有 toolRunner 时不再是裸 llm.call——真的请求并执行了工具，stopReason 如实回流", async () => {
    let toolLoopRound = 0;
    const runnerCalls: { name: string; args: Record<string, unknown> }[] = [];
    const toolRunner = {
      call: async (name: string, args: Record<string, unknown> = {}) => {
        runnerCalls.push({ name, args });
        return { ok: true, payload: { name, args, hit: 1 } };
      },
    } as unknown as McpToolRunner;

    const llm: Pick<LLMRouter, "call" | "listModels" | "capabilitiesFor"> = {
      call: async (messages, modelOrOptions: string | CallOptions = LLMRouter.DEFAULT_MODEL) => {
        const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
        if (options.tools) {
          // 子代理 tool loop 的调用（真实 orchestrator plan()/summarize() 从不传 tools）。
          toolLoopRound += 1;
          if (toolLoopRound === 1) {
            return toolCallResponse([{ id: "c1", name: "lit_search", args: { query: "spark research" } }]);
          }
          return toolTextResponse("子代理真的检索完了");
        }
        // plan()：产出一个 subagent 任务。
        return toolTextResponse(
          JSON.stringify([{ id: "t1", kind: "subagent", description: "去检索一下", params: { subagent: "explore" } }]),
        );
      },
      listModels: mockLlm.listModels,
      capabilitiesFor: () => ({ toolCalling: true, jsonMode: true, streaming: true, usageReported: true }),
    };

    const { daemon, orch } = createOrchestrator({ llm, toolRunner });
    const result = await orch.processRequest("帮我研究一下", "sess_subagent_toolloop");

    // 真的请求并执行了工具——旧路径（裸 llm.call）永远不会调用 runner。
    expect(runnerCalls.length).toBe(1);
    expect(runnerCalls[0]!.name).toBe("lit_search");

    const outcome = result.execution.find((e) => e.kind === "subagent");
    expect(outcome).toBeDefined();
    expect(outcome?.ok).toBe(true);
    expect(outcome?.output).toContain("子代理真的检索完了");

    const entries = (daemon.executionLog as unknown as { entries: Array<Record<string, unknown>> }).entries;
    const runEntry = entries.find((e) => e.actor === "explore" && e.action === "run");
    expect(runEntry).toBeDefined();
    expect(String(runEntry!.message)).toContain("stopReason=done");
    expect(String(runEntry!.message)).toContain("toolCalls=1");
  });

  test("子代理没跑完（stopReason !== 'done'）时如实标注，不冒充成功产出", async () => {
    const toolRunner = {
      call: async (_name: string, _args: Record<string, unknown> = {}) => ({ ok: true, payload: {} }),
    } as unknown as McpToolRunner;

    // 每一轮都请求同一个不在 execute 默认 grants 里的工具（lit_add 是 literature 的写权限，
    // execute 没有）——连续两轮全部被拒绝，触发 sub_agent.ts 的 "denied" 停机。
    const llm: Pick<LLMRouter, "call" | "listModels" | "capabilitiesFor"> = {
      call: async (messages, modelOrOptions: string | CallOptions = LLMRouter.DEFAULT_MODEL) => {
        const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
        if (options.tools) {
          return toolCallResponse([{ id: "c1", name: "lit_add", args: { identifier: "x" } }]);
        }
        return toolTextResponse(
          JSON.stringify([{ id: "t1", kind: "subagent", description: "跑个实验", params: { subagent: "execute" } }]),
        );
      },
      listModels: mockLlm.listModels,
      capabilitiesFor: () => ({ toolCalling: true, jsonMode: true, streaming: true, usageReported: true }),
    };

    const { orch } = createOrchestrator({ llm, toolRunner });
    const result = await orch.processRequest("帮我跑个实验", "sess_subagent_denied");

    const outcome = result.execution.find((e) => e.kind === "subagent");
    expect(outcome).toBeDefined();
    expect(outcome?.ok).toBe(false); // stopReason "denied" ≠ "done"，不能冒充成功
    expect(outcome?.output).toContain("stopReason=denied");
  });
});

// ── W3-a：onDelta——权威调用（summarize）本身的流式增量出口 ───────────────────────

describe("OrchestratorAgent · onDelta 接的是 summarize() 权威调用本身", () => {
  function streamingSummarizeLlm(): Pick<LLMRouter, "call" | "listModels"> {
    return {
      call: async (messages: ChatMessage[], modelOrOptions: string | CallOptions = LLMRouter.DEFAULT_MODEL) => {
        const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("Synthesize the observable execution records") && options.onDelta) {
          options.onDelta("第一段 ");
          options.onDelta("第二段");
        }
        const model = options.model ?? LLMRouter.DEFAULT_MODEL;
        return { ok: true, provider: "kimi", model, content: "第一段 第二段", ...llmExtras() };
      },
      listModels: mockLlm.listModels,
    };
  }

  test("正例：onDelta 收到 summarize() 调用吐出的真实增量，且顺序与最终 summary 一致", async () => {
    const deltas: string[] = [];
    const { orch } = createOrchestrator({ llm: streamingSummarizeLlm() });
    const result = await orch.processRequest("分析数据集", "sess_ondelta_ok", { onDelta: (chunk) => deltas.push(chunk) });

    expect(deltas).toEqual(["第一段 ", "第二段"]);
    expect(deltas.join("")).toBe(result.summary);
  });

  test("不传 onDelta 时行为不变（回归防护）：不报错、summary 照常生成", async () => {
    const { orch } = createOrchestrator({ llm: streamingSummarizeLlm() });
    const result = await orch.processRequest("分析数据集", "sess_ondelta_absent");
    expect(result.summary).toBe("第一段 第二段");
  });
});

// ── W3-a：研究循环——contract + replan 真的接上了真子代理 ─────────────────────────

describe("OrchestratorAgent.runResearchLoop", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "spark-orch-research-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("没有绑定 project 时直接报错——不悄悄退化成问模型判完成", async () => {
    const { orch } = createOrchestrator();
    await expect(orch.runResearchLoop("sess_no_project", "写一篇综述")).rejects.toThrow(/project/);
  });

  test("端到端：planner → 真子代理（真 tool loop）→ distill → evaluateRound 全部接上，跑到 contract 完成为止", async () => {
    const manager = new ProjectManager(tmp);
    const project = manager.create("research-loop", { name: "research loop test", description: "" });
    manager.bindSession("sess_research_loop", project.slug);

    let plannerCalls = 0;
    let toolLoopStep = 0;
    const llm: Pick<LLMRouter, "call" | "listModels" | "capabilitiesFor"> = {
      call: async (messages, modelOrOptions: string | CallOptions = LLMRouter.DEFAULT_MODEL) => {
        const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
        if (options.tools) {
          toolLoopStep += 1;
          if (toolLoopStep % 2 === 1) {
            return toolCallResponse([{ id: `c${toolLoopStep}`, name: "lit_add", args: { identifier: "paper-1" } }]);
          }
          return toolTextResponse("literature 子代理：论文已入库");
        }
        plannerCalls += 1;
        return toolTextResponse(
          JSON.stringify([{ id: `s${plannerCalls}`, subagent: "literature", task: "去找一篇论文入库" }]),
        );
      },
      listModels: mockLlm.listModels,
      capabilitiesFor: () => ({ toolCalling: true, jsonMode: true, streaming: true, usageReported: true }),
    };

    const runnerCalls: string[] = [];
    const toolRunner = {
      call: async (name: string, args: Record<string, unknown> = {}) => {
        runnerCalls.push(name);
        if (name === "lit_add") {
          const rec = project.records().create({
            type: "paper",
            title: String(args.identifier ?? "paper"),
            content: "x",
            evidence: "sourced",
          });
          return { ok: true, payload: { id: rec.id } };
        }
        return { ok: true, payload: {} };
      },
    } as unknown as McpToolRunner;

    const daemon = new SparkResearchDaemon({ projects: manager });
    const orch = new OrchestratorAgent(daemon, { llm, projects: manager, toolRunner });

    // 用一个只有单个 stage 的自定义契约（而不是完整的 literature-review 三 stage），
    // 把测试焦点收在「循环机制真的接上了真子代理」上，不必为了满足 read_cards/
    // citations_verified 再去伪造精读卡与引用核验记录——那些是 contract.ts 自己的
    // 判据合同，已经在 tests/unit/contract.test.ts 里独立验证过。
    const singleStageContract = (_q: EvidenceQuery) =>
      new ResearchContract("has-paper", [
        {
          id: "has_paper",
          description: "至少一条新的 paper record",
          check(q) {
            const papers = q.listByType("paper");
            const done = papers.length >= 1;
            return { done, evidence: papers.map((p) => p.id), reason: done ? "有论文了" : "还没有论文" };
          },
        },
      ]);

    const result = await orch.runResearchLoop("sess_research_loop", "写一篇关于 X 的综述", {
      contract: singleStageContract,
      maxRounds: 5,
    });

    expect(result.stopReason).toBe("done");
    expect(result.rounds).toBe(1);
    expect(plannerCalls).toBe(1); // 一轮就满足契约，不应该再多问一次 planner
    expect(runnerCalls).toEqual(["lit_add"]);
    expect(result.observations.length).toBe(1);
    expect(result.observations[0]!.subagentType).toBe("literature");
    expect(result.observations[0]!.newRecordIds.length).toBe(1);
    expect(result.report.allDone).toBe(true);
  });
});
