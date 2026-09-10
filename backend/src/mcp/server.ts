import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Hono } from "hono";
import { createApp, type ServerDeps } from "../server/app";
import { configuredMcpTimeoutMs } from "../config";
import { PACKAGE_VERSION } from "../version";
import { MCP_TOOLS, MCP_WITHHELD, toolByName, type McpToolDef } from "./tools";

// MCP server 模式（P9 交付物 5）：`spark-research mcp`。
//
// 实现口径：**每个工具都只是对 P7 HTTP 端点的一次进程内调用**。
// 用同一个 Hono app 的 `fetch()`，不起网络监听、不重实现业务逻辑。
// 这条纪律的价值在于口径一致：CLI / HTTP / UI / MCP 四个入口共享同一套
// service 层，任何一处修了业务规则，四个入口同时生效。
//
// 用低阶 `Server` 而不是 `McpServer`：后者的 inputSchema 只吃 zod schema，
// 而我们的工具 schema 要与 `capabilities` 输出同源（手写 JSON Schema），
// 再引一层 zod 只会多一份可能漂移的定义。

export interface McpServerOptions extends ServerDeps {
  // 长任务同步等待上限；超时后返回任务句柄 + 提示改用 task_status。
  timeoutMs?: number;
  pollIntervalMs?: number;
  // 注入现成的 app（测试用），否则按 deps 建一个。
  app?: Hono;
}

const BASE_URL = "http://spark-research.mcp";

export interface ToolOutcome {
  ok: boolean;
  payload: unknown;
}

interface TaskEnvelope {
  task?: {
    id: string;
    state: "pending" | "running" | "succeeded" | "failed";
    result?: unknown;
    error?: { message: string } | null;
    progress?: { done: number; total: number | null; message: string | null } | null;
    kind?: string;
  };
}

// V17：长任务的中途进度回传。
//
// 之前：`runLongTask()` 提交任务拿句柄之后，只是干等——每 `pollIntervalMs` 轮一次
// `GET /api/tasks/:id`，中间的 `progress`（P7 的 `handle.progress()`，各路由早就在报，
// 比如 `lit_read` 每精读完一篇就 `task.progress(i, total, ...)`）**读到了但没往外传**，
// 外部 agent 只在任务落定（或超时）那一刻才第一次看到任何反馈。
//
// MCP 协议本身有 progress notification 这条通道（`notifications/progress`，客户端在
// 请求的 `_meta.progressToken` 里主动要）——接上它之后，外部 agent 能在等待期间持续看到
// 「精读第 7/20 篇」这类中间态，而不是发出请求后陷入沉默直到结果或超时。
//
// 接口设计成回调（`onProgress`）而不是直接依赖 MCP SDK 的类型：`McpToolRunner` 本身
// 不知道、也不该知道自己是不是被真实的 MCP `Server` 调用（`McpFixture.call()` 这条
// 测试路径完全不经过协议层，见 tests/helpers/mcp_scenario.ts）——由 `createMcpServer()`
// 在有 `progressToken` 时才构造这个回调、桥接到 `extra.sendNotification()`，
// `McpToolRunner` 自己完全不 import `@modelcontextprotocol/sdk` 的通知类型。
export interface TaskProgressPayload {
  done: number;
  total: number | null;
  message: string | null;
}
export type TaskProgressCallback = (progress: TaskProgressPayload) => void;

export class McpToolRunner {
  private readonly app: Hono;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: McpServerOptions = {}) {
    this.app = options.app ?? createApp(options);
    this.timeoutMs = options.timeoutMs ?? configuredMcpTimeoutMs(300_000);
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
  }

  private async fetchJson(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; payload: unknown }> {
    const init: RequestInit = { method };
    if (body !== undefined && method !== "GET") {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await this.app.fetch(new Request(BASE_URL + path, init));
    const text = await response.text();
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("json")) {
      // BibTeX / Markdown 这类端点直接回文本，原样带回去（不硬塞进 JSON 壳）。
      return { status: response.status, payload: { contentType, content: text } };
    }
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { status: response.status, payload };
  }

  // 长任务：提交拿句柄 → 自己轮询到落定。判断三——不把 202 的复杂度甩给外部 agent。
  //
  // V17：`onProgress` 是可选的——只有真实 MCP 客户端在请求里带了 `progressToken`
  // （见 `createMcpServer()` 的 CallTool handler）才会有值；`McpFixture.call()` 这条
  // 测试路径（不经协议层）不传，行为与 V17 之前完全一致。
  private async runLongTask(
    tool: McpToolDef,
    args: Record<string, unknown>,
    onProgress?: TaskProgressCallback,
  ): Promise<ToolOutcome> {
    const req = tool.request(args);
    // 显式 await:false：拿到句柄才能做超时控制。用 await:true 会让 HTTP 层无限等，
    // 超时就只能靠掐连接——那样任务状态在 MCP 侧就丢了。
    const submitted = await this.fetchJson(req.method, req.path, { ...(req.body ?? {}), await: false });
    if (submitted.status !== 202) {
      // 不是任务句柄（参数错误 / 404 等）→ 按普通结果处理。
      return { ok: submitted.status < 400, payload: submitted.payload };
    }
    const taskId = (submitted.payload as TaskEnvelope).task?.id;
    if (!taskId) return { ok: false, payload: submitted.payload };

    // 去重：同一个 progress（done/total/message 全等）不重复通知——轮询间隔比任务实际
    // 进展快很多时（`pollIntervalMs` 默认 400ms，多数子步骤耗时以秒计），大多数轮询
    // tick 上 progress 根本没变，原样转发只会刷屏，掩盖真正有信息量的那几条。
    let lastProgressKey: string | null = null;
    const reportProgress = (progress: TaskProgressPayload | null | undefined) => {
      if (!onProgress || !progress) return;
      const key = JSON.stringify(progress);
      if (key === lastProgressKey) return;
      lastProgressKey = key;
      onProgress(progress);
    };

    const deadline = Date.now() + this.timeoutMs;
    let last: TaskEnvelope["task"] | undefined;
    while (Date.now() < deadline) {
      const polled = await this.fetchJson("GET", `/api/tasks/${encodeURIComponent(taskId)}`);
      last = (polled.payload as TaskEnvelope).task;
      if (!last) return { ok: false, payload: polled.payload };
      reportProgress(last.progress ?? null);
      if (last.state === "succeeded") {
        return { ok: true, payload: tool.present ? tool.present(last.result, args) : last.result };
      }
      if (last.state === "failed") {
        return {
          ok: false,
          payload: { error: last.error?.message ?? "任务失败", taskId, kind: last.kind },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    // 超时不等于取消：任务还在后台跑，把句柄交出去。
    return {
      ok: true,
      payload: {
        timedOut: true,
        taskId,
        state: last?.state ?? "running",
        progress: last?.progress ?? null,
        note: `等待超过 ${this.timeoutMs}ms。**任务仍在后台运行**，用 task_status 查 taskId=${taskId} 取最终结果；调大等待上限见 \`spark-research config set mcpTimeoutMs <毫秒>\`。`,
      },
    };
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
    hooks: { onProgress?: TaskProgressCallback } = {},
  ): Promise<ToolOutcome> {
    const withheld = MCP_WITHHELD.find((w) => w.name === name);
    if (withheld) {
      // 对抗面：即便调用方猜到了名字，这里也只回「为什么不给 + 人该怎么做」。
      return {
        ok: false,
        payload: {
          error: `工具 '${name}' 刻意不通过 MCP 暴露`,
          reason: withheld.reason,
          humanAction: withheld.humanAction,
        },
      };
    }
    const tool = toolByName(name);
    if (!tool) {
      return {
        ok: false,
        payload: { error: `未知工具 '${name}'`, available: MCP_TOOLS.map((t) => t.name) },
      };
    }
    if (tool.longRunning) return this.runLongTask(tool, args, hooks.onProgress);

    const req = tool.request(args);
    const { status, payload } = await this.fetchJson(req.method, req.path, req.body);
    if (status >= 400) return { ok: false, payload };
    return { ok: true, payload: tool.present ? tool.present(payload, args) : payload };
  }
}

export const MCP_INSTRUCTIONS = `Spark Research —— 面向科研人员的本地科研工作台（文献 → 思路 → 创新性核验 → 实验 → 记录 → 结论 → 报告）。

先调 research_capabilities 摸清这台机器上有什么可用（文献源、仿真平台、技能、当前配置）。
所有工具默认作用在**当前项目**上；跨项目时给 project 参数。

刻意不提供的工具（不是缺失，是设计）：
${MCP_WITHHELD.map((w) => `  - ${w.name}：${w.reason}\n    人来做：${w.humanAction}`).join("\n")}

遇到需要这些动作时，把「该谁做、怎么做」原样转达给用户，不要试图绕路。`;

export function createMcpServer(options: McpServerOptions = {}): {
  server: Server;
  runner: McpToolRunner;
} {
  const runner = new McpToolRunner(options);
  const server = new Server(
    { name: "spark-research", version: PACKAGE_VERSION },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    // V17：客户端只有在这次请求的 `_meta.progressToken` 里主动要进度通知时才接线——
    // 协议本身把这标成 opt-in（"The receiver is not obligated to provide these
    // notifications"），没要的客户端不该无谓地收到通知。
    const progressToken = request.params._meta?.progressToken;
    const onProgress: TaskProgressCallback | undefined =
      progressToken === undefined
        ? undefined
        : (progress) => {
            // sendNotification 失败（客户端已断开之类）不该拖垮整个工具调用——
            // 进度通知本来就是尽力而为、非阻塞的旁路，不是结果的一部分。
            void extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: progress.done,
                ...(progress.total !== null ? { total: progress.total } : {}),
                ...(progress.message !== null ? { message: progress.message } : {}),
              },
            }).catch(() => {});
          };
    const outcome = await runner.call(name, (args ?? {}) as Record<string, unknown>, { onProgress });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(outcome.payload, null, 2) }],
      isError: !outcome.ok,
    };
  });

  return { server, runner };
}

export async function runMcpStdio(options: McpServerOptions = {}): Promise<void> {
  const { server } = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
