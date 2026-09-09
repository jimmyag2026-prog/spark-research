import { describe, expect, test } from "bun:test";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import {
  OrchestratorAgent,
  type OrchestratorDeps,
  type ReviewerAdapter,
} from "../../backend/src/agents/orchestrator";
import { SubAgentFactory, type SubAgentType } from "../../backend/src/agents/sub_agent";
import { LLMRouter, type CallOptions, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
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
