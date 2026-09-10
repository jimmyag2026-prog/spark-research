// tests/fixtures/mcp · W4-d 测试纪律："不连真实的外部 MCP server"——这是那个假的。
// 独立进程，用真实的 @modelcontextprotocol/sdk（server 侧）说真实的 stdio MCP 协议，
// 供 tests/unit/mcp_client.test.ts 用 command=process.execPath 现场 spawn。
//
// 三个工具：
//   echo    —— 回显参数，最基本的往返验证。
//   whoami  —— 回显子进程实际看到的几个环境变量：测试"凭据不泄漏"/"env 白名单"
//               的关键探针（父进程测不到子进程 env，只能让子进程自己说）。
//   slow    —— 按 args.delayMs 睡眠后再返回：制造调用超时（区别于启动超时）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "spark-fixture-good-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "回显参数", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    {
      name: "whoami",
      description: "回显子进程能看到的几个环境变量（测试用探针）",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "slow",
      description: "延迟 args.delayMs 毫秒后返回（用于测试调用超时）",
      inputSchema: { type: "object", properties: { delayMs: { type: "number" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params as { name: string; arguments?: Record<string, unknown> };
  const args = rawArgs ?? {};

  if (name === "echo") {
    return { content: [{ type: "text" as const, text: JSON.stringify({ echoed: args }) }] };
  }

  if (name === "whoami") {
    const probeKeys = ["UPSTREAM_KEY", "SAFE_VAR", "PATH"];
    const snapshot: Record<string, string | null> = {};
    for (const key of probeKeys) snapshot[key] = process.env[key] ?? null;
    return { content: [{ type: "text" as const, text: JSON.stringify({ env: snapshot }) }] };
  }

  if (name === "slow") {
    const delayMs = typeof args.delayMs === "number" ? args.delayMs : 5000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { content: [{ type: "text" as const, text: JSON.stringify({ waited: delayMs }) }] };
  }

  return { content: [{ type: "text" as const, text: JSON.stringify({ error: `未知工具 "${name}"` }) }], isError: true };
});

await server.connect(new StdioServerTransport());
