import { describe, expect, test } from "bun:test";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import {
  OrchestratorAgent,
  type OrchestratorDeps,
  type ReviewerAdapter,
} from "../../backend/src/agents/orchestrator";
import { SubAgentFactory, type SubAgentType } from "../../backend/src/agents/sub_agent";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";

const mockLlm = {
  call: async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return { ok: true, provider: "kimi", model, content: `[test:${model}] ${lastUser.slice(0, 120)}`, mock: false };
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
      expect(res.content).toContain("No API key configured");
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
