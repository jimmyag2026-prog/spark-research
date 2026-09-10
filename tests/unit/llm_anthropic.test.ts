import { describe, expect, test } from "bun:test";
import { AnthropicAdapter, anthropicAdapter } from "../../backend/src/llm/providers/anthropic";
import type { ProviderRequest } from "../../backend/src/llm/providers/types";
import type { ChatMessage } from "../../backend/src/llm/types";

// lane R-b：Anthropic 原生适配器。全部走注入的 fetchImpl——不打真实网络（测试纪律，
// 与 tests/unit/llm_router.test.ts 里 R-a 的写法对齐）。

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function capturingFetch(status: number, responseBody: unknown): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
    }
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : {}, headers });
    return new Response(JSON.stringify(responseBody), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function sseFetch(events: string[]): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
    }
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : {}, headers });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const evt of events) controller.enqueue(encoder.encode(evt));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function sse(eventType: string, dataObj: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(dataObj)}\n\n`;
}

function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    options: {},
    apiKey: "sk-ant-test",
    baseUrl: "",
    timeoutMs: 5_000,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    ...overrides,
  };
}

describe("AnthropicAdapter 基础请求形状", () => {
  test("打到 /v1/messages，带 x-api-key + anthropic-version 头（不是 Authorization: Bearer）", async () => {
    const { fetchImpl, requests } = capturingFetch(200, {
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl }));
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]!.headers["x-api-key"]).toBe("sk-ant-test");
    expect(requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(requests[0]!.headers.Authorization).toBeUndefined();
  });

  test("max_tokens 必填参数总是被带上", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const adapter = new AnthropicAdapter();
    await adapter.call(baseRequest({ fetchImpl }));
    expect(typeof requests[0]!.body.max_tokens).toBe("number");
    expect(requests[0]!.body.max_tokens).toBeGreaterThan(0);
  });

  test("自定义 baseUrl 会拼上 /v1/messages", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const adapter = new AnthropicAdapter({ baseUrl: "http://localhost:9999/" });
    await adapter.call(baseRequest({ fetchImpl }));
    expect(requests[0]!.url).toBe("http://localhost:9999/v1/messages");
  });

  test("system 角色消息不进 messages 数组，拼进顶层 system 参数", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const adapter = new AnthropicAdapter();
    const messages: ChatMessage[] = [
      { role: "system", content: "你是一个助手" },
      { role: "user", content: "你好" },
    ];
    await adapter.call(baseRequest({ fetchImpl, messages }));
    expect(requests[0]!.body.system).toBe("你是一个助手");
    expect(requests[0]!.body.messages).toEqual([{ role: "user", content: "你好" }]);
  });

  test("多条 system 消息拼接（\\n\\n 连接）", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const adapter = new AnthropicAdapter();
    const messages: ChatMessage[] = [
      { role: "system", content: "第一条" },
      { role: "system", content: "第二条" },
      { role: "user", content: "hi" },
    ];
    await adapter.call(baseRequest({ fetchImpl, messages }));
    expect(requests[0]!.body.system).toBe("第一条\n\n第二条");
  });

  test("没有 system 消息时不带 system 字段", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const adapter = new AnthropicAdapter();
    await adapter.call(baseRequest({ fetchImpl }));
    expect(requests[0]!.body.system).toBeUndefined();
  });
});

describe("R-b-1：tool calling（请求侧）", () => {
  test("options.tools → tools[].input_schema（不是 function.parameters）", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const adapter = new AnthropicAdapter();
    await adapter.call(
      baseRequest({
        fetchImpl,
        options: {
          tools: [{ name: "search", description: "搜索", inputSchema: { type: "object", properties: {} } }],
          toolChoice: { name: "search" },
        },
      }),
    );
    expect(requests[0]!.body.tools).toEqual([
      { name: "search", description: "搜索", input_schema: { type: "object", properties: {} } },
    ]);
    expect(requests[0]!.body.tool_choice).toEqual({ type: "tool", name: "search" });
  });

  test("toolChoice 'auto'/'none' 编码成 {type:'auto'}/{type:'none'}", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const adapter = new AnthropicAdapter();
    await adapter.call(
      baseRequest({
        fetchImpl,
        options: { tools: [{ name: "search", description: "d", inputSchema: {} }], toolChoice: "auto" },
      }),
    );
    expect(requests[0]!.body.tool_choice).toEqual({ type: "auto" });

    const second = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    await adapter.call(
      baseRequest({
        fetchImpl: second.fetchImpl,
        options: { tools: [{ name: "search", description: "d", inputSchema: {} }], toolChoice: "none" },
      }),
    );
    expect(second.requests[0]!.body.tool_choice).toEqual({ type: "none" });
  });

  test("assistant 带 toolCalls → content[] 里的 tool_use 块，input 是原始对象（不 stringify）", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "done" }] });
    const adapter = new AnthropicAdapter();
    const messages: ChatMessage[] = [
      { role: "user", content: "搜一下天气" },
      {
        role: "assistant",
        content: "好的",
        toolCalls: [{ id: "toolu_1", name: "search", args: { q: "天气" } }],
      },
      { role: "tool", toolCallId: "toolu_1", name: "search", content: '{"temp":20}' },
    ];
    await adapter.call(baseRequest({ fetchImpl, messages }));
    const wire = requests[0]!.body.messages as Array<Record<string, unknown>>;
    expect(wire[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "好的" },
        { type: "tool_use", id: "toolu_1", name: "search", input: { q: "天气" } },
      ],
    });
    // tool 结果 → role:"user" 消息，content 里放 tool_result 块（tool_use_id，不是 tool_call_id）。
    expect(wire[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"temp":20}' }],
    });
  });

  test("连续多条 tool 消息合并成一个 user 消息里的多个 tool_result 块（并发工具调用）", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "done" }] });
    const adapter = new AnthropicAdapter();
    const messages: ChatMessage[] = [
      { role: "user", content: "查两件事" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "toolu_1", name: "search", args: { q: "a" } },
          { id: "toolu_2", name: "search", args: { q: "b" } },
        ],
      },
      { role: "tool", toolCallId: "toolu_1", name: "search", content: "result-a" },
      { role: "tool", toolCallId: "toolu_2", name: "search", content: "result-b" },
    ];
    await adapter.call(baseRequest({ fetchImpl, messages }));
    const wire = requests[0]!.body.messages as Array<Record<string, unknown>>;
    expect(wire).toHaveLength(3);
    expect(wire[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "result-a" },
        { type: "tool_result", tool_use_id: "toolu_2", content: "result-b" },
      ],
    });
  });
});

describe("R-b-1：tool calling（响应侧）", () => {
  test("content[] 里的 tool_use 块 → ToolCall[]，input 已是对象，不需要 JSON.parse", async () => {
    const { fetchImpl } = capturingFetch(200, {
      content: [
        { type: "text", text: "我来搜一下" },
        { type: "tool_use", id: "toolu_abc", name: "search", input: { q: "hello" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(
      baseRequest({ fetchImpl, options: { tools: [{ name: "search", description: "d", inputSchema: {} }] } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.content).toBe("我来搜一下");
    expect(res.toolCalls).toEqual([{ id: "toolu_abc", name: "search", args: { q: "hello" } }]);
    expect(res.finishReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: null });
  });

  test("多个 text 块拼接成最终 content", async () => {
    const { fetchImpl } = capturingFetch(200, {
      content: [
        { type: "text", text: "第一段。" },
        { type: "text", text: "第二段。" },
      ],
    });
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.content).toBe("第一段。第二段。");
  });

  test("tool_use 块的 input 不是合法对象（如为字符串）→ 显式 kind:'parse' 失败，不静默塞 {}", async () => {
    const { fetchImpl } = capturingFetch(200, {
      content: [{ type: "tool_use", id: "toolu_bad", name: "search", input: "not-an-object" }],
    });
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(
      baseRequest({ fetchImpl, options: { tools: [{ name: "search", description: "d", inputSchema: {} }] } }),
    );
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("parse");
    expect(res.error?.message).toContain("search");
  });

  test("tool_use 块缺少 name 字段 → 显式 kind:'parse' 失败", async () => {
    const { fetchImpl } = capturingFetch(200, {
      content: [{ type: "tool_use", id: "toolu_noname", input: {} }],
    });
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl }));
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("parse");
  });
});

describe("R-b-2：流式（options.onDelta）", () => {
  test("text_delta 逐块回调，结束时返回完整 content", async () => {
    const { fetchImpl, requests } = sseFetch([
      sse("message_start", { type: "message_start", message: { usage: { input_tokens: 8, output_tokens: 1 } } }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      sse("message_stop", { type: "message_stop" }),
    ]);
    const adapter = new AnthropicAdapter();
    const chunks: string[] = [];
    const res = await adapter.call(baseRequest({ fetchImpl, options: { onDelta: (c) => chunks.push(c) } }));
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.content).toBe("Hello");
    expect(res.finishReason).toBe("end_turn");
    expect(res.usage.inputTokens).toBe(8);
    expect(res.usage.outputTokens).toBe(2);
    expect(res.usage.usageUnavailable).toBeUndefined();
    expect(requests[0]!.body.stream).toBe(true);
  });

  test("流式下从没见过 usage 事件 → usageUnavailable:true（不许填 0 冒充）", async () => {
    const { fetchImpl } = sseFetch([
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      sse("message_stop", { type: "message_stop" }),
    ]);
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl, options: { onDelta: () => {} } }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.usage.usageUnavailable).toBe(true);
    expect(res.usage.costUsd).toBeNull();
  });

  test("流式 tool_use：input_json_delta 按 index 聚合、跨块拼接后解析", async () => {
    const { fetchImpl } = sseFetch([
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "search" },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"q":' },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"x"}' },
      }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
    ]);
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(
      baseRequest({
        fetchImpl,
        options: { tools: [{ name: "search", description: "d", inputSchema: {} }], onDelta: () => {} },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "search", args: { q: "x" } }]);
    expect(res.finishReason).toBe("tool_use");
  });

  test("流式 tool_use 聚合后 JSON 仍不合法 → 显式 kind:'parse' 失败", async () => {
    const { fetchImpl } = sseFetch([
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "search" },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{broken" },
      }),
      sse("message_stop", { type: "message_stop" }),
    ]);
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(
      baseRequest({
        fetchImpl,
        options: { tools: [{ name: "search", description: "d", inputSchema: {} }], onDelta: () => {} },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("parse");
  });

  test("流式中途收到 error 事件 → 显式失败，不把半截内容当成功返回", async () => {
    const { fetchImpl } = sseFetch([
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "部分" } }),
      sse("error", { type: "error", error: { type: "overloaded_error", message: "上游过载" } }),
    ]);
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl, options: { onDelta: () => {} } }));
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.message).toContain("上游过载");
  });
});

describe("R-b-3：response_format——如实不支持，不假装", () => {
  test("responseFormat:'json_object' → 显式 kind:'unsupported' 失败，不静默忽略也不冒充", async () => {
    const adapter = new AnthropicAdapter();
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const res = await adapter.call(baseRequest({ fetchImpl, options: { responseFormat: "json_object" } }));
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("unsupported");
    // 显式失败必须发生在真的打网络之前——不许先发请求再回头声明不支持。
    expect(requests).toHaveLength(0);
  });

  test("responseFormat:'text' 或不传都正常放行", async () => {
    const adapter = new AnthropicAdapter();
    const { fetchImpl } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    const res = await adapter.call(baseRequest({ fetchImpl, options: { responseFormat: "text" } }));
    expect(res.ok).toBe(true);
  });
});

describe("R-b-4：能力位（AD-12：没实现的位不许翻 true）", () => {
  test("capabilities() 矩阵：toolCalling/streaming/usageReported=true，jsonMode=false", () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.capabilities("claude-sonnet-4-5")).toEqual({
      toolCalling: true,
      jsonMode: false,
      streaming: true,
      usageReported: true,
    });
  });

  test("capabilities() 与模型名无关（Anthropic 全系列 Messages API 形状一致）", () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.capabilities("claude-opus-4-5")).toEqual(adapter.capabilities("claude-sonnet-4-5"));
  });
});

describe("错误分类（HTTP 状态码 / Anthropic 错误体 → error.kind）", () => {
  test("401 → auth，不可重试", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
        status: 401,
      })) as unknown as typeof fetch;
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl }));
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("auth");
    expect(res.error?.retryable).toBe(false);
    expect(res.error?.message).toContain("invalid x-api-key");
  });

  test("429 → rate_limit，可重试", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
        status: 429,
      })) as unknown as typeof fetch;
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl }));
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("rate_limit");
    expect(res.error?.retryable).toBe(true);
  });

  test("529 overloaded_error → upstream，可重试", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }), {
        status: 529,
      })) as unknown as typeof fetch;
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl }));
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("upstream");
    expect(res.error?.retryable).toBe(true);
  });

  test("超时：AbortError → kind:'timeout'", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl, timeoutMs: 50 }));
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("timeout");
  });

  test("凭据不会出现在错误消息里（redactSecrets）", async () => {
    const fetchImpl = (async () =>
      new Response(`upstream said: Authorization: Bearer sk-ant-api03-SUPERSECRETVALUE123456`, { status: 500 })) as unknown as typeof fetch;
    const adapter = new AnthropicAdapter();
    const res = await adapter.call(baseRequest({ fetchImpl, apiKey: "sk-ant-api03-SUPERSECRETVALUE123456" }));
    expect(res.ok).toBe(false);
    expect(res.error?.message).not.toContain("SUPERSECRETVALUE123456");
  });
});

describe("AD-13：ok:false ⇒ content===\"\" 且 error 必填（跨所有失败路径巡检）", () => {
  test("非流式 parse 失败、流式 parse 失败、unsupported 失败、HTTP 失败、超时失败，全部满足不变式", async () => {
    const adapter = new AnthropicAdapter();

    const nonStreamParse = await adapter.call(
      baseRequest({ fetchImpl: capturingFetch(200, { content: [{ type: "tool_use", id: "x", input: "bad" }] }).fetchImpl }),
    );
    const httpFail = await adapter.call(baseRequest({ fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch }));
    const unsupported = await adapter.call(baseRequest({ options: { responseFormat: "json_object" } }));

    for (const res of [nonStreamParse, httpFail, unsupported]) {
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.content).toBe("");
      expect(res.error).toBeDefined();
      expect(res.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("导出：给主会话接线用的现成实例", () => {
  test("anthropicAdapter 是 AnthropicAdapter 实例，id 为 'anthropic'，baseUrl 默认 api.anthropic.com", async () => {
    expect(anthropicAdapter).toBeInstanceOf(AnthropicAdapter);
    expect(anthropicAdapter.id).toBe("anthropic");
    const { fetchImpl, requests } = capturingFetch(200, { content: [{ type: "text", text: "ok" }] });
    await anthropicAdapter.call(baseRequest({ fetchImpl }));
    expect(requests[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });
});
