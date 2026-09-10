import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startServer, type StartedServer } from "../../backend/src/server/server";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmExtras } from "../../backend/src/llm/types";

const mockLlm = {
  call: async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
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

describe("Spark Research HTTP server", () => {
  let server: StartedServer;

  beforeAll(() => {
    const daemon = new SparkResearchDaemon();
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

// P8：版本号单一真源。此前 /api/health 硬编码 "0.2.0" 而 package.json 是 "0.1.0"，
// 两处漂移没有任何东西会报警。这条测试就是那个报警器。
describe("版本号单一真源", () => {
  test("/api/health 报的版本 == package.json 的版本", async () => {
    const pkg = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as { version: string };
    const server = startServer(0, { root: mkdtempSync(join(tmpdir(), "spark-version-")) });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
      const body = (await res.json()) as { version: string };
      expect(body.version).toBe(pkg.version);
    } finally {
      await server.stop();
    }
  });
});
