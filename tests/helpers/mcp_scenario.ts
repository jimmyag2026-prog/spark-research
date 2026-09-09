import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { ProjectManager, type Project } from "../../backend/src/project/manager";
import { createApp } from "../../backend/src/server/app";
import type { ServerDeps } from "../../backend/src/server/context";
import { McpToolRunner, createMcpServer } from "../../backend/src/mcp/server";

// MCP 层测试脚手架（P9）。
//
// 与 P7 的 server_scenario 同一套纪律：工作区 mkdtemp、模型与网络全注入 fake、
// 湿实验后端注入 mock。差别是这里**不起网络监听**——MCP 走进程内 Hono fetch，
// 真实客户端走 InMemoryTransport，链路仍然是真的 JSON-RPC。

export interface McpFixture {
  runner: McpToolRunner;
  root: string;
  manager: ProjectManager;
  project: Project;
  slug: string;
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<{ ok: boolean; payload: T }>;
  dispose(): void;
}

export interface McpFixtureOptions extends Omit<ServerDeps, "root" | "projects"> {
  slug?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export function makeMcp(options: McpFixtureOptions = {}): McpFixture {
  const { slug = "p9", timeoutMs, pollIntervalMs, ...deps } = options;
  const root = mkdtempSync(join(tmpdir(), "spark-p9-mcp-"));
  const manager = new ProjectManager(root);
  const created = manager.create(slug, { name: "P9 MCP 测试项目", description: "" });
  const actualSlug = created.slug;
  created.close();

  const app = createApp({
    root,
    projects: manager,
    wetBackend: deps.wetBackend ?? new MockDeviceBackend(),
    sseHeartbeatMs: 0,
    ...deps,
  });
  const runner = new McpToolRunner({
    app,
    timeoutMs: timeoutMs ?? 30_000,
    pollIntervalMs: pollIntervalMs ?? 20,
  });

  return {
    runner,
    root,
    manager,
    project: manager.open(actualSlug),
    slug: actualSlug,
    call: async (name, args = {}) => {
      const outcome = await runner.call(name, args);
      return { ok: outcome.ok, payload: outcome.payload as never };
    },
    dispose: () => {},
  };
}

// 真实 MCP 客户端 ↔ 真实 MCP server，跑在内存传输上。
export async function connectClient(options: McpFixtureOptions = {}): Promise<{
  client: Client;
  fixture: McpFixture;
  close(): Promise<void>;
}> {
  const { slug = "p9", timeoutMs, pollIntervalMs, ...deps } = options;
  const root = mkdtempSync(join(tmpdir(), "spark-p9-mcp-"));
  const manager = new ProjectManager(root);
  const created = manager.create(slug, { name: "P9 MCP 测试项目", description: "" });
  const actualSlug = created.slug;
  created.close();

  const app = createApp({
    root,
    projects: manager,
    wetBackend: deps.wetBackend ?? new MockDeviceBackend(),
    sseHeartbeatMs: 0,
    ...deps,
  });
  const { server, runner } = createMcpServer({
    app,
    timeoutMs: timeoutMs ?? 30_000,
    pollIntervalMs: pollIntervalMs ?? 20,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "spark-research-test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const fixture: McpFixture = {
    runner,
    root,
    manager,
    project: manager.open(actualSlug),
    slug: actualSlug,
    call: async (name, args = {}) => {
      const outcome = await runner.call(name, args);
      return { ok: outcome.ok, payload: outcome.payload as never };
    },
    dispose: () => {},
  };

  return {
    client,
    fixture,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// 客户端侧调用并把 text content 解析回 JSON（工具返回体一律是 JSON 文本）。
export async function callTool<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; payload: T }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.map((c) => c.text ?? "").join("");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { isError: Boolean(result.isError), payload: payload as T };
}
