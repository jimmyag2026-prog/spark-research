import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, type StartedServer } from "../../backend/src/server/server";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { KimiScienceDaemon } from "../../backend/src/daemon/daemon";
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

describe("Kimi Science HTTP server", () => {
  let server: StartedServer;

  beforeAll(() => {
    const daemon = new KimiScienceDaemon();
    const agent = new OrchestratorAgent(daemon, { llm: mockLlm });
    server = startServer(0, { agent });
  });

  afterAll(async () => {
    await server.stop();
  });

  const base = () => `http://127.0.0.1:${server.port}`;

  test("GET /api/health returns 200", async () => {
    const res = await fetch(`${base()}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("GET /api/connectors returns connector list", async () => {
    const res = await fetch(`${base()}/api/connectors`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connectors: Array<{ name: string }> };
    expect(Array.isArray(body.connectors)).toBe(true);
    expect(body.connectors.length).toBeGreaterThan(0);
    expect(body.connectors[0]).toHaveProperty("name");
  });

  test("POST /api/chat returns a response", async () => {
    const res = await fetch(`${base()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "test-session", message: "你好" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { response: string };
    expect(typeof body.response).toBe("string");
    expect(body.response).toContain("test-session");
  });

  test("GET /api/lab/devices returns device list", async () => {
    const res = await fetch(`${base()}/api/lab/devices`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: Array<{ id: string }> };
    expect(Array.isArray(body.devices)).toBe(true);
    expect(body.devices.length).toBeGreaterThan(0);
    expect(body.devices[0]).toHaveProperty("id");
  });

  test("unknown route returns 404", async () => {
    const res = await fetch(`${base()}/api/nonexistent`);
    expect(res.status).toBe(404);
  });
});
