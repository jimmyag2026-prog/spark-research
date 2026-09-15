import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { configuredModel } from "../../backend/src/config";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { LLMRouter, type CallOptions, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";

// 闸门 · 「声明了要能生效」（USAGE_LOG U10） —— lane β-1。
//
// **这条门禁抓的是整类问题，不是一个字段**：一个参数被类型声明、被调用方老实传进来、
// 函数体却从没让它影响任何一次真实调用。形状来源是 U10：
//   `OrchestratorAgent.chat(req)` 声明 `model?: string`，HTTP `/chat` 与 `/stream`
//   两条路由都传了，函数体主路径从头到尾没读过它——传什么模型都用配置默认值，
//   不报错、不告警。决定性实验：指定 `qwen-max`（`QWEN_API_KEY` 未配置）照常回答。
//
// 与闸门 I（tests/unit/gate_i_param_readers.test.ts）的分工：
//   - 闸门 I 是**静态**的，抓「有没有读」：AST 里找不到 `req.model` 的读点就红。
//   - 本门禁是**运行期**的，抓「读了有没有用」：真的起 router、真的发（假）请求，
//     看出站请求里带的是不是覆盖的那个模型名。静态那条抓不到「读了、存了、但调用时
//     又被调用点的默认值盖掉」这种形状，而那恰好是最容易写出来的假修复。
//
// ── 与收口的关系（必读）────────────────────────────────────────────────────────
// β-1 的修复落在 `backend/src/agents/orchestrator.ts`，那是本 lane 的**禁止文件**
// （枢纽文件归收口）。所以本文件里的 `applyBeta1Collar()` 把收口 diff 的语义
// **逐行等价地**在实例上打了一遍补丁：一个 `sessionModel` Map、`chat()` 开头存/删、
// `llmFor()` 返回的 `call` 用它覆盖调用点传来的默认模型。报告「收口 diff」段贴的
// 就是与它一一对应的 orchestrator.ts 改动。
// **收口应用 diff 之后**：删掉 `applyBeta1Collar` 与它的调用（stock `orch` 直接用），
// 并删掉 `GATE_I_ALLOWLIST` 里 `agents/orchestrator.ts::OrchestratorAgent.chat::req.model`
// 那一条（届时 `req.model` 有了真实读者，留着会被闸门 I 的陈旧检查判红）。
//
// 阴性对照：`applyBeta1Collar(orch, { readSessionModel: false })`——只把「llmFor 读
// sessionModel」这一步拆掉，其余不变，下面两条断言必须红（红/绿输出见 docs/devlog/W9-beta.md）。

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "gate-model-override-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Outbound {
  url: string;
  model: string;
}

/**
 * 一个「假 daemon」：真的 `LLMRouter`（provider 选择、baseUrl、鉴权判断全是真逻辑），
 * 只把最外层的 `fetch` 换成记录器。env 默认只有 `OPENROUTER_API_KEY`——这正是 U10
 * 现场的配置形状（`QWEN_API_KEY` 未配置）。
 */
function fixture(env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "placeholder-test-value" }) {
  const outbound: Outbound[] = [];
  const responses: LlmResponse[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    outbound.push({ url: String(input), model: String(body.model) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const router = new LLMRouter(env, { fetchImpl });
  const llm = {
    call: async (messages: ChatMessage[], modelOrOptions: string | CallOptions = {}): Promise<LlmResponse> => {
      const res = await router.call(messages, modelOrOptions);
      responses.push(res);
      return res;
    },
    listModels: () => router.listModels(),
    capabilitiesFor: (model?: string) => router.capabilitiesFor(model),
  };
  const daemon = new SparkResearchDaemon();
  const orch = new OrchestratorAgent(daemon, { llm, workspaceRoot: tmpRoot() });
  return { orch, outbound, responses, daemon };
}

type ChatReq = Parameters<OrchestratorAgent["chat"]>[0];
type LlmLike = Pick<LLMRouter, "call">;

/** 收口 diff（orchestrator.ts）的逐行等价补丁——见文件头注释。 */
function applyBeta1Collar(orch: OrchestratorAgent, opts: { readSessionModel?: boolean } = {}): void {
  const read = opts.readSessionModel !== false;
  const sessionModel = new Map<string, string>();
  const inner = orch as unknown as {
    chat: (req: ChatReq) => Promise<unknown>;
    llmFor: (sessionId: string | null) => LlmLike;
  };
  const origChat = inner.chat.bind(orch);
  const origLlmFor = inner.llmFor.bind(orch);

  // diff ①：chat() 开头——传了就记住，没传就忘掉（与紧邻的 sessionBudget 同一个套路）。
  inner.chat = (req: ChatReq) => {
    if (req.model) sessionModel.set(req.sessionId, req.model);
    else sessionModel.delete(req.sessionId);
    return origChat(req);
  };

  // diff ②：llmFor() 返回的 call 用会话模型覆盖调用点传来的默认模型。
  // 改这一处就覆盖 plan / execute / summarize / review 全部调用点（它们都经 llmFor）。
  inner.llmFor = (sessionId: string | null): LlmLike => {
    const base = origLlmFor(sessionId);
    const model = read && sessionId ? sessionModel.get(sessionId) : undefined;
    return {
      call: (messages: ChatMessage[], modelOrOptions: string | CallOptions = {}) => {
        const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
        return base.call(messages, model ? { ...options, model } : options);
      },
    };
  };
}

describe("闸门 · chat(req.model) 必须真的改变发出去的那次调用（U10）", () => {
  test("覆盖生效：chat({ model: 'qwen-max' }) → 每一次出站请求带的都是 qwen-max，不是配置默认模型", async () => {
    const { orch, outbound, daemon } = fixture();
    applyBeta1Collar(orch);
    try {
      await orch.chat({ sessionId: "probe-qwen", message: "跑一个最小请求" });
      const defaultModel = configuredModel(LLMRouter.DEFAULT_MODEL);
      expect(outbound.length).toBeGreaterThan(0);
      expect(new Set(outbound.map((o) => o.model))).toEqual(new Set([defaultModel]));

      outbound.length = 0;
      await orch.chat({ sessionId: "probe-qwen-2", message: "跑一个最小请求", model: "qwen-max" });
      expect(outbound.length).toBeGreaterThan(0);
      // U10 的核心断言：**一次都不许**再用默认模型发请求。
      expect(new Set(outbound.map((o) => o.model))).toEqual(new Set(["qwen-max"]));
    } finally {
      daemon.kernelManager.dispose();
    }
  });

  test("覆盖生效的硬判据：指定一个拿不到 key 的模型 → 调用必须失败（kind=auth），不许静默照常回答", async () => {
    const { orch, responses, daemon } = fixture();
    applyBeta1Collar(orch);
    try {
      // 同一套配置下不带覆盖：照常成功（这是对照基线，证明失败不是因为环境坏了）。
      await orch.chat({ sessionId: "probe-baseline", message: "跑一个最小请求" });
      expect(responses.length).toBeGreaterThan(0);
      expect(responses.every((r) => r.ok)).toBe(true);

      // 带覆盖：`local/` 前缀显式路由到本地端点，而 SPARK_LOCAL_LLM_BASE_URL 没设
      // → router 在发请求前就判失败。**只有覆盖真正生效才会失败；静默忽略必然被抓。**
      responses.length = 0;
      await orch.chat({ sessionId: "probe-local", message: "跑一个最小请求", model: "local/llama3.1" });
      expect(responses.length).toBeGreaterThan(0);
      expect(responses.every((r) => !r.ok)).toBe(true);
      const first = responses[0]!;
      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect(first.error.kind).toBe("auth");
        expect(first.error.message).toContain("SPARK_LOCAL_LLM_BASE_URL");
      }
    } finally {
      daemon.kernelManager.dispose();
    }
  });

  test("不粘连：同一会话第二次 chat() 不传 model → 回到默认模型", async () => {
    const { orch, outbound, daemon } = fixture();
    applyBeta1Collar(orch);
    try {
      await orch.chat({ sessionId: "sticky", message: "第一次", model: "qwen-max" });
      expect(new Set(outbound.map((o) => o.model))).toEqual(new Set(["qwen-max"]));

      outbound.length = 0;
      await orch.chat({ sessionId: "sticky", message: "第二次" });
      expect(new Set(outbound.map((o) => o.model))).toEqual(new Set([configuredModel(LLMRouter.DEFAULT_MODEL)]));
    } finally {
      daemon.kernelManager.dispose();
    }
  });

  // ── U10 现场的另一半：为什么「无 key 的 qwen-max 照常回答」不能只怪 chat() ──
  // `LLMRouter.resolve()` 在模型所属 provider 没配 key 时会**隐式回退**到任何一个已配置的
  // provider（capabilities/index.ts 的注释已经点名这个行为）。所以即使模型覆盖完全生效，
  // `qwen-max` 在只有 OPENROUTER_API_KEY 的环境里也不会因为缺 key 而失败——它会带着
  // "qwen-max" 这个模型名被发给 OpenRouter。这不是本 lane 的足迹（router.ts 归收口），
  // 但它是「无 key 照常回答」的第二个成因，本用例把它钉成**当前行为的快照**：
  // 谁改了回退策略，这条会红，届时按新行为更新并在 CHANGELOG 记一笔。
  test("已知残余：模型所属 provider 没 key 时 router 会隐式回退到已配置的 provider（记录当前行为）", async () => {
    const { orch, outbound, responses, daemon } = fixture();
    applyBeta1Collar(orch);
    try {
      await orch.chat({ sessionId: "fallback", message: "跑一个最小请求", model: "qwen-max" });
      expect(outbound.every((o) => o.model === "qwen-max")).toBe(true);
      expect(outbound.every((o) => o.url.includes("openrouter.ai"))).toBe(true);
      expect(responses.every((r) => r.ok)).toBe(true);
    } finally {
      daemon.kernelManager.dispose();
    }
  });
});
