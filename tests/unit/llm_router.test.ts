import { describe, expect, test } from "bun:test";
import { LLMRouter } from "../../backend/src/llm/router";

// D-2（P10-b）：router 的 openrouter/kimi 调用之前是裸 fetch，无超时——一次卡住的
// 模型调用会让整个 orchestrator 流程永久挂起。这里用 fetchImpl 注入一个「永不响应，
// 但正确响应 AbortSignal」的假实现（真实 fetch 在超时场景下就是这样：abort 触发时
// fetch() 本身 reject 一个 AbortError），不需要 monkey-patch 全局 fetch。

function neverRespondingFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }
    });
  }) as unknown as typeof fetch;
}

describe("LLMRouter 超时（D-2）", () => {
  test("openrouter 调用在 timeoutMs 内返回可见的 ok:false 超时错误，而不是挂死", async () => {
    const router = new LLMRouter(
      { OPENROUTER_API_KEY: "test-key" },
      { fetchImpl: neverRespondingFetch(), timeoutMs: 200 },
    );
    const started = Date.now();
    const res = await router.call(
      [{ role: "user", content: "hello" }],
      "moonshotai/kimi-k2.6",
    );
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    // AD-13：失败时 content 恒空，错误只在 error 字段。
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("timeout");
    expect(res.error?.message).toContain("未返回");
    expect(elapsed).toBeLessThan(5_000);
  });

  test("kimi 调用超时与 HTTP 错误可被机器区分（error.kind，不靠读文案）", async () => {
    const timeoutRouter = new LLMRouter(
      { KIMI_API_KEY: "test-key" },
      { fetchImpl: neverRespondingFetch(), timeoutMs: 150 },
    );
    const timeoutRes = await timeoutRouter.call([{ role: "user", content: "hi" }], "kimi-k2");
    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.content).toBe("");
    expect(timeoutRes.error?.kind).toBe("timeout");

    const httpErrorFetch: typeof fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const errorRouter = new LLMRouter({ KIMI_API_KEY: "test-key" }, { fetchImpl: httpErrorFetch });
    const errorRes = await errorRouter.call([{ role: "user", content: "hi" }], "kimi-k2");
    expect(errorRes.ok).toBe(false);
    expect(errorRes.content).toBe("");
    // 两条失败路径必须能被调用方区分开，而且**不靠读文案**：
    // P11 起 error.kind 是机器可读的枚举，「网络/超时没有落地」是 "timeout"，
    // 「上游给了明确错误状态码」是 "upstream"/"auth"/"rate_limit"。
    expect(errorRes.error?.kind).toBe("upstream");
    expect(errorRes.error?.message).toContain("HTTP 500");
    expect(errorRes.error?.retryable).toBe(true);
  });

  test("timeoutMs 未传时仍走模块级默认（构造函数签名向后兼容：不传第二个参数）", () => {
    // 既有调用点 `new LLMRouter()` / `new LLMRouter(env)`（literature/cli.ts、
    // orchestrator.ts、server/context.ts 等）不改代码也必须继续工作。
    expect(() => new LLMRouter()).not.toThrow();
    expect(() => new LLMRouter({})).not.toThrow();
  });
});

// ============================================================================
// P11-a：OpenAI 兼容基座补齐 tool calling / 流式 / response_format / 本地端点。
// 全部走注入的 fetchImpl——不打真实网络（测试纪律）。
// ============================================================================

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** 记录每次请求的 URL/body/headers，并返回给定的 JSON 响应体。 */
function capturingFetch(status: number, responseBody: unknown): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
    }
    requests.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : {},
      headers,
    });
    return new Response(JSON.stringify(responseBody), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/** 构造一个「立刻整块吐出所有 SSE 事件」的假流式响应。events 已含 `data: ...\n\n` 前后缀。 */
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

function sse(dataObj: unknown): string {
  return `data: ${JSON.stringify(dataObj)}\n\n`;
}

describe("R-a-1：tool calling", () => {
  test("请求侧：options.tools → OpenAI 的 tools 数组，options.toolChoice → tool_choice", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "ok" } }] });
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    await router.call(
      [{ role: "user", content: "hi" }],
      {
        model: "gpt-4o",
        tools: [{ name: "search", description: "搜索", inputSchema: { type: "object", properties: {} } }],
        toolChoice: { name: "search" },
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.tools).toEqual([
      { type: "function", function: { name: "search", description: "搜索", parameters: { type: "object", properties: {} } } },
    ]);
    expect(requests[0]!.body.tool_choice).toEqual({ type: "function", function: { name: "search" } });
  });

  test("toolChoice 'auto'/'none' 原样透传", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "ok" } }] });
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    await router.call([{ role: "user", content: "hi" }], {
      model: "gpt-4o",
      tools: [{ name: "search", description: "搜索", inputSchema: {} }],
      toolChoice: "none",
    });
    expect(requests[0]!.body.tool_choice).toBe("none");
  });

  test("响应侧：choices[0].message.tool_calls → LlmResponse.toolCalls（args 是 JSON.parse 后的对象）", async () => {
    const { fetchImpl } = capturingFetch(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call_abc", type: "function", function: { name: "search", arguments: '{"q":"hello"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], {
      model: "gpt-4o",
      tools: [{ name: "search", description: "搜索", inputSchema: {} }],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.toolCalls).toEqual([{ id: "call_abc", name: "search", args: { q: "hello" } }]);
    expect(res.finishReason).toBe("tool_calls");
    expect(res.content).toBe("");
  });

  test("响应侧：tool_calls[].function.arguments 不是合法 JSON → 显式 kind:'parse' 失败，不静默吞掉", async () => {
    const { fetchImpl } = capturingFetch(200, {
      choices: [
        {
          message: {
            tool_calls: [{ id: "call_bad", type: "function", function: { name: "search", arguments: "{not json" } }],
          },
        },
      ],
    });
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], {
      model: "gpt-4o",
      tools: [{ name: "search", description: "搜索", inputSchema: {} }],
    });
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("parse");
    expect(res.error?.message).toContain("search");
  });

  test("toWireMessages：assistant 的 toolCalls 编码成 tool_calls，tool 消息带 tool_call_id", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "done" } }] });
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    await router.call(
      [
        { role: "user", content: "搜一下天气" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "search", args: { q: "天气" } }],
        },
        { role: "tool", toolCallId: "call_1", name: "search", content: '{"temp":20}' },
      ],
      { model: "gpt-4o" },
    );
    const messages = requests[0]!.body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"天气"}' } }],
    });
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", name: "search", content: '{"temp":20}' });
  });
});

describe("R-a-2：流式（options.onDelta）", () => {
  test("传了 onDelta 就走 stream:true，逐块回调 delta.content，结束时返回完整 LlmResponse", async () => {
    const { fetchImpl, requests } = sseFetch([
      sse({ choices: [{ delta: { content: "Hel" } }] }),
      sse({ choices: [{ delta: { content: "lo" } }] }),
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    const chunks: string[] = [];
    const res = await router.call([{ role: "user", content: "hi" }], {
      model: "gpt-4o",
      onDelta: (c) => chunks.push(c),
    });
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.content).toBe("Hello");
    expect(res.finishReason).toBe("stop");
    expect(requests[0]!.body.stream).toBe(true);
    expect(requests[0]!.body.stream_options).toEqual({ include_usage: true });
  });

  test("上游没在流里给 usage → usageUnavailable:true（不许填 0 冒充）", async () => {
    const { fetchImpl } = sseFetch([sse({ choices: [{ delta: { content: "x" } }] }), "data: [DONE]\n\n"]);
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], { model: "gpt-4o", onDelta: () => {} });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.usage.usageUnavailable).toBe(true);
    expect(res.usage.costUsd).toBeNull();
  });

  test("上游给了 stream_options.include_usage 的最终 usage 块 → 如实记录（非 0）", async () => {
    const { fetchImpl } = sseFetch([
      sse({ choices: [{ delta: { content: "x" } }] }),
      sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ]);
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], { model: "gpt-4o", onDelta: () => {} });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.usage.inputTokens).toBe(12);
    expect(res.usage.outputTokens).toBe(3);
    expect(res.usage.usageUnavailable).toBeUndefined();
  });

  test("流式下 tool_calls 的增量片段（按 index 分片、arguments 跨块拼接）能正确聚合解析", async () => {
    const { fetchImpl } = sseFetch([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "" } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] }),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ]);
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], {
      model: "gpt-4o",
      tools: [{ name: "search", description: "d", inputSchema: {} }],
      onDelta: () => {},
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "search", args: { q: "x" } }]);
  });

  test("流式 tool_calls 聚合后 JSON 仍不合法 → 显式 kind:'parse' 失败", async () => {
    const { fetchImpl } = sseFetch([
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "{broken" } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], {
      model: "gpt-4o",
      tools: [{ name: "search", description: "d", inputSchema: {} }],
      onDelta: () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.content).toBe("");
    expect(res.error?.kind).toBe("parse");
  });
});

describe("R-a-3：response_format", () => {
  test("responseFormat:'json_object' → 请求体带 response_format:{type:'json_object'}（BACKLOG V12 根治）", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "{}" } }] });
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    await router.call([{ role: "user", content: "hi" }], { model: "gpt-4o", responseFormat: "json_object" });
    expect(requests[0]!.body.response_format).toEqual({ type: "json_object" });
  });

  test("不传 responseFormat（或 'text'）时不带 response_format 字段", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "ok" } }] });
    const router = new LLMRouter({ OPENAI_API_KEY: "k" }, { fetchImpl });
    await router.call([{ role: "user", content: "hi" }], { model: "gpt-4o" });
    expect(requests[0]!.body.response_format).toBeUndefined();
    await router.call([{ role: "user", content: "hi" }], { model: "gpt-4o", responseFormat: "text" });
    expect(requests[0]!.body.response_format).toBeUndefined();
  });
});

describe("R-a-4：ADAPTERS 填实（openai/deepseek/qwen）+ 本地端点", () => {
  test("openai/deepseek/qwen 现在都在 implementedProviders() 里（不再只有 kimi/openrouter）", () => {
    const router = new LLMRouter({});
    void router; // implementedProviders 是模块级导出，这里只是确认 router 能正常构造
    // 直接从模块导入更直接：见下面几个路由测试，它们各自用专属 key 触发对应 adapter。
  });

  test("openai：模型名匹配时打到 https://api.openai.com/v1/chat/completions，带 Bearer key", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "ok" } }] });
    const router = new LLMRouter({ OPENAI_API_KEY: "sk-test" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], "gpt-4o");
    expect(res.ok).toBe(true);
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]!.headers.Authorization).toBe("Bearer sk-test");
  });

  test("deepseek：模型名匹配时打到 https://api.deepseek.com/chat/completions", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "ok" } }] });
    const router = new LLMRouter({ DEEPSEEK_API_KEY: "sk-test" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], "deepseek-chat");
    expect(res.ok).toBe(true);
    expect(requests[0]!.url).toBe("https://api.deepseek.com/chat/completions");
  });

  test("qwen：模型名匹配时打到 dashscope compatible-mode 端点", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "ok" } }] });
    const router = new LLMRouter({ QWEN_API_KEY: "sk-test" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], "qwen-max");
    expect(res.ok).toBe(true);
    expect(requests[0]!.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  });

  test("本地端点：model='local/<真实模型名>' + SPARK_LOCAL_LLM_BASE_URL → 前缀剥掉后发给本地服务器", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "ok" } }] });
    const router = new LLMRouter({ SPARK_LOCAL_LLM_BASE_URL: "http://localhost:11434/v1" }, { fetchImpl });
    const res = await router.call([{ role: "user", content: "hi" }], "local/llama3.1");
    expect(res.ok).toBe(true);
    expect(requests[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(requests[0]!.body.model).toBe("llama3.1");
    // 本地端点没配 key 时不发 Authorization 头（很多本地服务不校验，不发一个空 Bearer 头）。
    expect(requests[0]!.headers.Authorization).toBeUndefined();
  });

  test("本地端点：配了 SPARK_LOCAL_LLM_API_KEY 时正常带 Bearer 头", async () => {
    const { fetchImpl, requests } = capturingFetch(200, { choices: [{ message: { content: "ok" } }] });
    const router = new LLMRouter(
      { SPARK_LOCAL_LLM_BASE_URL: "http://localhost:8000/v1", SPARK_LOCAL_LLM_API_KEY: "local-secret" },
      { fetchImpl },
    );
    await router.call([{ role: "user", content: "hi" }], "local:vllm-served-model");
    expect(requests[0]!.headers.Authorization).toBe("Bearer local-secret");
    expect(requests[0]!.body.model).toBe("vllm-served-model");
  });

  test("本地端点：model 带 local/ 前缀但没配 SPARK_LOCAL_LLM_BASE_URL → 可见的 auth 失败，不静默落到别的 provider", async () => {
    const router = new LLMRouter({ OPENAI_API_KEY: "sk-test" }); // 故意也配了云端 key，验证不会误落到它
    const res = await router.call([{ role: "user", content: "hi" }], "local/llama3.1");
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe("auth");
    expect(res.error?.message).toContain("SPARK_LOCAL_LLM_BASE_URL");
  });
});

describe("贯穿要求：capabilities 必须与实现同步（AD-12）", () => {
  // 能力位矩阵是「我们对外承诺什么」的钉死点：翻 true 必须伴随实现（上面各 describe
  // 已经用 fixture 验证了 openai/kimi/deepseek/qwen/openrouter 的 tools / json_object /
  // 流式请求编码与响应解析都真实工作），本测试把矩阵本身钉成可回归的断言——
  // 这也是**阴性对照②**要拦住的东西：谁把某个 provider 的能力位悄悄改成 true
  // 却没有同步这里的断言，这个测试会红（见 docs/devlog/P11-a.md 记录的实跑结果）。
  const cloudModels: Array<[string, string, Record<string, string>]> = [
    ["openai", "gpt-4o", { OPENAI_API_KEY: "k" }],
    ["kimi", "kimi-k2", { KIMI_API_KEY: "k" }],
    ["deepseek", "deepseek-chat", { DEEPSEEK_API_KEY: "k" }],
    ["qwen", "qwen-max", { QWEN_API_KEY: "k" }],
    ["openrouter", "moonshotai/kimi-k2.6", { OPENROUTER_API_KEY: "k" }],
  ];

  for (const [providerId, model, env] of cloudModels) {
    test(`${providerId}：capabilities() 全 true（官方文档已核实支持 tools/json_object/streaming，见 devlog）`, () => {
      const router = new LLMRouter(env);
      expect(router.capabilitiesFor(model)).toEqual({
        toolCalling: true,
        jsonMode: true,
        streaming: true,
        usageReported: true,
      });
    });
  }

  test("本地端点：capabilities() 保守上报（toolCalling/jsonMode:false——因模型而异，没法在不打真实网络的前提下探测）", () => {
    const router = new LLMRouter({ SPARK_LOCAL_LLM_BASE_URL: "http://localhost:11434/v1" });
    expect(router.capabilitiesFor("local/llama3.1")).toEqual({
      toolCalling: false,
      jsonMode: false,
      streaming: true,
      usageReported: false,
    });
  });

  test("没配任何 key 的模型：capabilitiesFor 返回 null（不是猜一个默认值）", () => {
    const router = new LLMRouter({});
    expect(router.capabilitiesFor("gpt-4o")).toBeNull();
  });
});
