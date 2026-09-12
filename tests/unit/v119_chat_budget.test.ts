import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";
import { makeServer, type ServerFixture } from "../helpers/server_scenario";

// V119：聊天式 chat/co-explore 的预算闸——UI 预算透传到 orchestrator.llmFor。
// 阴性对照（已验红）：routes/session.ts 去掉 budgetUsd 透传 → 第一条红（fake llm 被调用）。
class CountingLlm {
  calls = 0;
  call = async (_m: ChatMessage[], _o?: unknown): Promise<LlmResponse> => {
    this.calls += 1;
    return {
      ok: true,
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6",
      content: JSON.stringify({ summary: "ok", tasks: [] }),
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: null, usageUnavailable: false },
    };
  };
}

let fx: ServerFixture | null = null;
afterEach(async () => {
  await fx?.stop();
  fx = null;
});

describe("V119 · POST /api/session/chat 预算闸", () => {
  test("会话绑定项目 + budgetUsd 极小 → 一次模型调用都不发，回复里带预算闸消息", async () => {
    const llm = new CountingLlm();
    fx = makeServer({ slug: "v119", llm });
    await fx.post("/api/projects/current", { slug: "v119", sessionId: "s-v119" });
    const res = await fx.post<{ response: string }>("/api/session/chat", {
      sessionId: "s-v119",
      message: "帮我规划一个蛋白结构预测的文献综述",
      budgetUsd: 0.0000001,
    });
    expect(res.status).toBe(200);
    expect(llm.calls).toBe(0);
    expect(res.body.response).toContain("预算闸");
  });

  test("不带 budgetUsd → 照常调用模型（只记账不设闸）", async () => {
    const llm = new CountingLlm();
    fx = makeServer({ slug: "v119b", llm });
    await fx.post("/api/projects/current", { slug: "v119b", sessionId: "s-v119b" });
    const res = await fx.post<{ response: string }>("/api/session/chat", { sessionId: "s-v119b", message: "你好" });
    expect(res.status).toBe(200);
    expect(llm.calls).toBeGreaterThan(0);
  });
});
