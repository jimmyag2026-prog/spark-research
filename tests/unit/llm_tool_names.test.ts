import { describe, expect, test } from "bun:test";
import { LLMRouter } from "../../backend/src/llm/router";
import { buildToolNameMap } from "../../backend/src/llm/tool_names";

// 真实现场（接入 provena）：外部 MCP 工具名 `mcp:provena:preregister` 原样发给 DeepSeek，
// HTTP 400 `tools[4].function.name ... does not match pattern '^[a-zA-Z0-9_-]+$'`，整次调用失败。

function capturingFetch(seen: unknown[], reply: unknown): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("provider 函数名约束：外部工具名线上编码、回来解码", () => {
  test("发出去的名字全部合规；模型回调用的名字解码回 mcp:<扩展>:<工具>", async () => {
    const seen: any[] = [];
    const reply = {
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "",
        tool_calls: [{ id: "c1", type: "function",
          function: { name: "mcp__provena__preregister", arguments: "{\"path\":\"plan.md\"}" } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl: capturingFetch(seen, reply) });
    const res = await router.call(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "mcp:provena:status", args: {} }] },
        { role: "tool", toolCallId: "c0", name: "mcp:provena:status", content: "{}" },
      ],
      {
        model: "gpt-4o-mini",
        maxRetries: 0,
        tools: [
          { name: "lit_search", description: "built in", inputSchema: { type: "object" } },
          { name: "mcp:provena:preregister", description: "x", inputSchema: { type: "object" } },
          { name: "mcp:provena:status", description: "y", inputSchema: { type: "object" } },
        ],
      },
    );
    const body = seen[0];
    const names = body.tools.map((t: any) => t.function.name);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(names).toContain("lit_search");                        // 合规的原样
    expect(JSON.stringify(body.messages)).not.toContain("mcp:provena");  // 历史消息也编码了
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.toolCalls[0]!.name).toBe("mcp:provena:preregister");
    expect(process.env.SPARK_RESEARCH_DATA_DIR).toBeTruthy(); // 不污染 V74 隔离
  });

  test("编码不撞名", () => {
    const m = buildToolNameMap([
      { name: "mcp__a__b", description: "", inputSchema: {} },
      { name: "mcp:a:b", description: "", inputSchema: {} },
    ]);
    expect(m.toWire.get("mcp:a:b")).not.toBe("mcp__a__b");
  });
});
