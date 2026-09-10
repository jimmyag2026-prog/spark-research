import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMRouter, type CallOptions, type ChatMessage, type LlmResponse, type ProviderCapabilities, type ToolCall } from "../../backend/src/llm/router";
import type { McpToolRunner } from "../../backend/src/mcp/server";
import { MCP_TOOLS, MCP_WITHHELD } from "../../backend/src/mcp/tools";
import {
  buildSubAgentSpec,
  runSubAgent,
  runSubAgentOfType,
  SubAgentFactory,
  SubAgentGrantViolationError,
  SUB_AGENT_TOOL_CONCURRENCY,
  SUB_AGENT_TYPE_NAMES,
  type SubAgentDeps,
  type SubAgentSpec,
  type SubAgentType,
} from "../../backend/src/agents/sub_agent";
import { SUB_AGENT_MODEL_CONFIG_TYPES, saveConfig } from "../../backend/src/config";

// P12 · 子代理 tool loop（v0.4 方案 §4.2，波次 W2-a）。
//
// 这份文件测的是 sub_agent.ts 自己的合同：
//   ① 真 tool loop（请求 → 受限并发执行 → 结果回灌 → 再调，直到无 tool call/触预算）
//   ② stopReason 如实回流（done/budget/timeout/denied/error 各自的触发条件）
//   ③ readOnly 硬约束（review 拿不到写工具，构造期与运行期各挡一次）
//   ④ 不支持 tool calling 时的显式降级（不静默失败）
//   ⑤ legacy 兼容（orchestrator.ts 现有的 SubAgentFactory 消费方不受影响）
// 全部用注入的假 LLM / 假 runner，不打真实网络、不打真实模型（与 toolbus.test.ts /
// llm_router.test.ts 同一套纪律）。阴性对照（回退各条契约确认测试真的会红）见
// docs/devlog/W2-a.md。

// ── 测试脚手架 ──────────────────────────────────────────────────────────────

interface CapturedCall {
  messages: ChatMessage[];
  options: CallOptions;
}

/** 脚本化假 LLM：按调用顺序回放 script 里的响应函数（用尽后重放最后一个）。 */
function fakeLlm(
  script: Array<(messages: ChatMessage[], options: CallOptions) => LlmResponse>,
  caps: ProviderCapabilities = { toolCalling: true, jsonMode: true, streaming: true, usageReported: true },
): { llm: Pick<LLMRouter, "call" | "capabilitiesFor">; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  return {
    llm: {
      call: (async (messages: ChatMessage[], modelOrOptions: string | CallOptions = {}) => {
        const options: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
        calls.push({ messages: [...messages], options });
        const fn = script[Math.min(i, script.length - 1)]!;
        i += 1;
        return fn(messages, options);
      }) as Pick<LLMRouter, "call">["call"],
      capabilitiesFor: () => caps,
    },
    calls,
  };
}

function textResponse(content: string, extra: Partial<LlmResponse> = {}): LlmResponse {
  return {
    ok: true,
    provider: "fake",
    model: "fake-model",
    content,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, usageUnavailable: false },
    ...extra,
  } as LlmResponse;
}

function toolCallResponse(toolCalls: ToolCall[], extra: Partial<LlmResponse> = {}): LlmResponse {
  return {
    ok: true,
    provider: "fake",
    model: "fake-model",
    content: "",
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: null, usageUnavailable: false },
    finishReason: "tool_calls",
    ...extra,
  } as LlmResponse;
}

function failureResponse(message: string, extra: Partial<LlmResponse> = {}): LlmResponse {
  return {
    ok: false,
    provider: "fake",
    model: "fake-model",
    content: "",
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true },
    error: { kind: "upstream", message, retryable: false },
    ...extra,
  } as LlmResponse;
}

interface FakeRunnerCall {
  name: string;
  args: Record<string, unknown>;
}

function fakeRunner(
  responder: (name: string, args: Record<string, unknown>) => { ok: boolean; payload: unknown } = (name, args) => ({
    ok: true,
    payload: { echo: name, args },
  }),
): { runner: McpToolRunner; calls: FakeRunnerCall[] } {
  const calls: FakeRunnerCall[] = [];
  return {
    runner: {
      call: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        return responder(name, args);
      },
    } as unknown as McpToolRunner,
    calls,
  };
}

const ALL_TYPES: readonly SubAgentType[] = ["explore", "literature", "execute", "lab", "review"];

// ── ① 真 tool loop ──────────────────────────────────────────────────────────

describe("runSubAgent · 真 tool loop", () => {
  test("完整循环：请求工具 → 受限并发执行 → 结果回灌进下一轮 messages → 无 tool call 后 stopReason:'done'", async () => {
    const call1: ToolCall = { id: "c1", name: "record_get", args: { recordId: "r1" } };
    const { llm, calls } = fakeLlm([() => toolCallResponse([call1]), () => textResponse("最终结论")]);
    const { runner, calls: runnerCalls } = fakeRunner((name, args) => ({ ok: true, payload: { name, args, value: 42 } }));

    const spec = buildSubAgentSpec("review");
    const result = await runSubAgent(spec, "评审任务", { llm, runner });

    expect(result.stopReason).toBe("done");
    expect(result.finalText).toBe("最终结论");
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]!.tool).toBe("record_get");
    expect(result.toolCalls[0]!.ok).toBe(true);
    expect(runnerCalls.length).toBe(1);
    expect(runnerCalls[0]!.name).toBe("record_get");

    // 契约②：结果必须回灌进下一轮 prompt——第二次 llm.call 的 messages 里
    // 必须能找到第一轮那次工具调用的 role:"tool" 结果消息。
    expect(calls.length).toBe(2);
    const secondRoundMessages = calls[1]!.messages;
    const toolMsg = secondRoundMessages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    expect(toolMsg).toBeDefined();
    if (toolMsg && toolMsg.role === "tool") {
      expect(toolMsg.content).toContain('"value":42');
      expect(toolMsg.name).toBe("record_get");
    }

    // usage 跨轮聚合。
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  test("同一轮内多个 tool call：受限并发执行（真的并发，但不超过 SUB_AGENT_TOOL_CONCURRENCY）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: FakeRunnerCall[] = [];
    const runner = {
      call: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return { ok: true, payload: { name } };
      },
    } as unknown as McpToolRunner;

    const toolCalls: ToolCall[] = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: "record_get",
      args: { recordId: `r${i}` },
    }));
    const { llm } = fakeLlm([() => toolCallResponse(toolCalls), () => textResponse("done")]);

    const spec = buildSubAgentSpec("review", { budget: { maxToolCalls: 10, maxTokens: 100_000, maxWallMs: 60_000 } });
    const result = await runSubAgent(spec, "task", { llm, runner });

    expect(result.stopReason).toBe("done");
    expect(calls.length).toBe(6);
    expect(maxInFlight).toBeGreaterThan(1); // 真的并发过，不是串行
    expect(maxInFlight).toBeLessThanOrEqual(SUB_AGENT_TOOL_CONCURRENCY);
  });

  test("预算（工具调用数）耗尽 → stopReason:'budget'，不是 'done'", async () => {
    let n = 0;
    const { llm } = fakeLlm([
      () => toolCallResponse([{ id: `c${n++}`, name: "exp_list", args: {} }]),
    ]);
    const { runner } = fakeRunner();

    const spec = buildSubAgentSpec("execute", { budget: { maxToolCalls: 2, maxTokens: 1_000_000, maxWallMs: 600_000 } });
    const result = await runSubAgent(spec, "task", { llm, runner });

    expect(result.stopReason).toBe("budget");
    expect(result.stopReason).not.toBe("done");
  });

  test("墙钟（maxWallMs）耗尽 → stopReason:'timeout'，与其他预算维度的 'budget' 区分开", async () => {
    let clock = 0;
    const now = () => clock;
    const runner = {
      call: async (name: string, args: Record<string, unknown> = {}) => {
        clock += 10_000; // 模拟一次耗时的工具调用
        return { ok: true, payload: {} };
      },
    } as unknown as McpToolRunner;
    const toolCall: ToolCall = { id: "c1", name: "exp_list", args: {} };
    const { llm } = fakeLlm([() => toolCallResponse([toolCall]), () => textResponse("不该跑到这里")]);

    const spec = buildSubAgentSpec("execute", { budget: { maxToolCalls: 1000, maxTokens: 1_000_000, maxWallMs: 5_000 } });
    const result = await runSubAgent(spec, "task", { llm, runner, now });

    expect(result.stopReason).toBe("timeout");
  });

  test("llm.call 返回 ok:false → stopReason:'error'，error 字段携带原始错误信息", async () => {
    const { llm } = fakeLlm([() => failureResponse("upstream boom")]);
    const { runner } = fakeRunner();

    const spec = buildSubAgentSpec("explore");
    const result = await runSubAgent(spec, "task", { llm, runner });

    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("upstream boom");
  });

  test("连续两轮全部工具调用都被拒绝（not_granted）→ stopReason:'denied'，从未真正执行到 runner", async () => {
    // lit_add 不在 explore 的默认 grants 里（它是 literature 的写权限）。
    const badCall = (id: string): ToolCall => ({ id, name: "lit_add", args: { identifier: "x" } });
    const { llm } = fakeLlm([
      () => toolCallResponse([badCall("c1")]),
      () => toolCallResponse([badCall("c2")]),
      () => textResponse("不该跑到这里"),
    ]);
    const { runner, calls } = fakeRunner();

    const spec = buildSubAgentSpec("explore");
    const result = await runSubAgent(spec, "task", { llm, runner });

    expect(result.stopReason).toBe("denied");
    expect(calls.length).toBe(0);
  });
});

// ── ③ readOnly 硬约束 ────────────────────────────────────────────────────────

describe("buildSubAgentSpec / runSubAgent · readOnly 硬约束（review）", () => {
  test("review + grants override 混入写工具 → 构造期直接拒绝", () => {
    expect(() => buildSubAgentSpec("review", { grants: ["lit_add"] })).toThrow(SubAgentGrantViolationError);
    expect(() => buildSubAgentSpec("review", { grants: ["record_get", "exp_run"] })).toThrow(SubAgentGrantViolationError);
  });

  test("任意类型的 grants override 混入 MCP_WITHHELD 动作 → 构造期直接拒绝（AD-14 源头前移）", () => {
    expect(() => buildSubAgentSpec("lab", { grants: ["lab_compile", "lab_approve"] })).toThrow(SubAgentGrantViolationError);
    expect(() => buildSubAgentSpec("execute", { grants: ["conclusion_review"] })).toThrow(SubAgentGrantViolationError);
  });

  test("SubAgentSpecOverrides 没有 readOnly 入口——review 的 readOnly 恒为 true，不接受调用方覆盖", () => {
    const spec = buildSubAgentSpec("review");
    expect(spec.readOnly).toBe(true);
    for (const type of ALL_TYPES.filter((t) => t !== "review")) {
      expect(buildSubAgentSpec(type).readOnly).toBe(false);
    }
  });

  test("runSubAgent 对手工构造、绕过 buildSubAgentSpec 的非法 spec 同样拒绝（防御性二次校验，先于任何 llm 调用）", async () => {
    const illegalSpec: SubAgentSpec = {
      name: "review",
      type: "review",
      model: LLMRouter.DEFAULT_MODEL,
      promptFile: "reviewer.txt",
      grants: ["lit_add"], // 写工具，手工塞进去，绕过 buildSubAgentSpec 的校验
      budget: { maxToolCalls: 5, maxTokens: 10_000, maxWallMs: 60_000 },
      readOnly: true,
    };
    const { llm, calls } = fakeLlm([() => textResponse("不该跑到这里")]);
    const { runner } = fakeRunner();

    await expect(runSubAgent(illegalSpec, "task", { llm, runner })).rejects.toThrow(SubAgentGrantViolationError);
    expect(calls.length).toBe(0);
  });
});

// ── 五类子代理默认 grants（对照任务书表格）───────────────────────────────────

describe("五类子代理默认 grants", () => {
  test("与任务书推荐表格逐字段一致", () => {
    expect(buildSubAgentSpec("explore").grants).toEqual([
      "lit_search",
      "lit_list",
      "lit_read_cards",
      "records_timeline",
      "record_get",
    ]);
    expect(buildSubAgentSpec("literature").grants).toEqual([
      "lit_search",
      "lit_list",
      "lit_read_cards",
      "records_timeline",
      "record_get",
      "lit_add",
      "lit_export",
      "lit_review_draft",
    ]);
    expect(buildSubAgentSpec("execute").grants).toEqual(["exp_design", "exp_run", "exp_list", "task_status"]);
    expect(buildSubAgentSpec("lab").grants).toEqual(["lab_compile", "lab_status"]);
    expect(buildSubAgentSpec("review").grants).toEqual([
      "record_get",
      "records_timeline",
      "conclusion_list",
      "conclusion_get",
      "report_export",
    ]);
  });

  test("没有任何一类的默认 grants 出现 MCP_WITHHELD 名字", () => {
    for (const type of ALL_TYPES) {
      const spec = buildSubAgentSpec(type);
      for (const withheld of MCP_WITHHELD) {
        expect(spec.grants).not.toContain(withheld.name);
      }
    }
  });

  test("review 的默认 grants 逐个用 MCP_TOOLS 的真实 request() 核实方法都是 GET（只读判据的交叉核对）", () => {
    const spec = buildSubAgentSpec("review");
    for (const name of spec.grants) {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      expect(tool, `grants 里的 '${name}' 必须是真实存在的 MCP 工具`).toBeDefined();
      const req = tool!.request({});
      expect(req.method, `'${name}' 必须是 GET（只读）`).toBe("GET");
    }
  });

  test("几个已知的写工具（POST）确实不在 review 的默认 grants 里", () => {
    const writeTools = ["lit_add", "lab_compile", "exp_run", "project_create", "idea_coexplore"];
    for (const name of writeTools) {
      const tool = MCP_TOOLS.find((t) => t.name === name);
      expect(tool!.request({}).method).toBe("POST");
    }
    expect(buildSubAgentSpec("review").grants).not.toEqual(expect.arrayContaining(writeTools));
  });
});

// ── ④ 不支持 tool calling 时的显式降级 ────────────────────────────────────────

describe("降级路径：capabilitiesFor(model).toolCalling === false", () => {
  test("显式降级，不静默失败：finalText 含降级说明，工具全程未被调用，tools 未传给 provider", async () => {
    const { llm, calls } = fakeLlm(
      [() => textResponse("plain answer")],
      { toolCalling: false, jsonMode: false, streaming: true, usageReported: false },
    );
    const { runner, calls: runnerCalls } = fakeRunner();

    const spec = buildSubAgentSpec("explore");
    const result = await runSubAgent(spec, "task", { llm, runner });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBeTruthy();
    expect(result.finalText).toContain("降级");
    expect(result.finalText).toContain("plain answer");
    expect(result.stopReason).toBe("done");
    expect(runnerCalls.length).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.options.tools).toBeUndefined();
  });

  test("降级路径下 llm.call 仍失败 → stopReason:'error'，degraded 依旧如实标记（不因为降级就掩盖真实失败）", async () => {
    const { llm } = fakeLlm(
      [() => failureResponse("local endpoint unreachable")],
      { toolCalling: false, jsonMode: false, streaming: true, usageReported: false },
    );
    const { runner } = fakeRunner();

    const spec = buildSubAgentSpec("lab");
    const result = await runSubAgent(spec, "task", { llm, runner });

    expect(result.degraded).toBe(true);
    expect(result.stopReason).toBe("error");
    expect(result.error).toBe("local endpoint unreachable");
  });
});

// ── ⑤ legacy 兼容：orchestrator.ts 现有的 SubAgentFactory 消费方 ─────────────────

describe("legacy 兼容：SubAgentFactory", () => {
  test("permission 字段现在是 MCP 工具名，与新 API 的默认 grants 同源（不再是 v0.1 抽象能力名）", () => {
    const factory = new SubAgentFactory();
    for (const type of ALL_TYPES) {
      const agent = factory.create(type);
      expect(agent.permission).toEqual(buildSubAgentSpec(type).grants);
      expect(agent.prompt.length).toBeGreaterThan(0);
      expect(agent.model).toBe(LLMRouter.DEFAULT_MODEL);
      expect(agent.type).toBe(type);
    }
  });

  test("旧的 v0.1 抽象能力名（read_frames / python / compute_submit）不再出现在任何默认 permission 里", () => {
    const factory = new SubAgentFactory();
    const stale = ["read_frames", "read_artifacts", "read_lineage", "scoped_query", "python", "write_artifact", "compute_submit", "lab_control"];
    for (const type of ALL_TYPES) {
      const agent = factory.create(type);
      for (const name of stale) {
        expect(agent.permission).not.toContain(name);
      }
    }
  });

  test("overrides 仍然生效（向后兼容既有调用点的可选参数形状）", () => {
    const factory = new SubAgentFactory();
    const agent = factory.create("execute", { name: "custom", model: "custom-model", permission: ["exp_list"] });
    expect(agent.name).toBe("custom");
    expect(agent.model).toBe("custom-model");
    expect(agent.permission).toEqual(["exp_list"]);
  });
});

// ── 便捷入口 ─────────────────────────────────────────────────────────────────

describe("runSubAgentOfType · 便捷入口", () => {
  test("一步构造 spec 并跑，行为与手动 buildSubAgentSpec + runSubAgent 一致", async () => {
    const { llm } = fakeLlm([() => textResponse("ok")]);
    const { runner } = fakeRunner();
    const result = await runSubAgentOfType("explore", "task", { llm, runner });
    expect(result.stopReason).toBe("done");
    expect(result.finalText).toBe("ok");
  });
});

// ── V16：子代理独立模型暴露成配置项 ──────────────────────────────────────────
//
// 改前：SUB_AGENT_DEFAULTS 里每类子代理的 model 都硬编码 LLMRouter.DEFAULT_MODEL，
// 「重任务用强模型、检索摘要用快模型」这个旋钮压根不存在。这里验的是：
//   ① 两张手写清单（sub_agent.ts 的 SUB_AGENT_TYPE_NAMES / config/index.ts 的
//      SUB_AGENT_MODEL_CONFIG_TYPES）集合相等——谁漏改另一边立刻红；
//   ② config 的 per-type 覆盖真的改了 buildSubAgentSpec()/SubAgentFactory.create()
//      解出来的 model；
//   ③ 解析优先级：显式 override > per-type config > 全局 defaultModel > 代码常量。
// 全部用 { root, env } 隔离配置，不碰真实 ~/.spark-research（与 config.test.ts 同一套
// 纪律），所以不依赖、也不污染跑测试这台机器的真实配置状态。
describe("V16 · 子代理独立模型配置项", () => {
  function isolatedRoot() {
    return mkdtempSync(join(tmpdir(), "spark-subagent-model-"));
  }

  test("SUB_AGENT_TYPE_NAMES 与 CONFIG_SETTINGS 的 SUB_AGENT_MODEL_CONFIG_TYPES 集合相等", () => {
    expect([...SUB_AGENT_TYPE_NAMES].sort()).toEqual([...SUB_AGENT_MODEL_CONFIG_TYPES].sort());
  });

  test("不配置任何东西时，解析出的默认模型仍是 LLMRouter.DEFAULT_MODEL（向后兼容基线）", () => {
    const root = isolatedRoot();
    for (const type of ALL_TYPES) {
      const spec = buildSubAgentSpec(type, { configOptions: { root, env: {} } });
      expect(spec.model).toBe(LLMRouter.DEFAULT_MODEL);
    }
  });

  test("subAgentModel_<type> 覆盖只影响对应 type，不影响其它 type", () => {
    const root = isolatedRoot();
    saveConfig({ subAgentModel_review: "strong/review-model" }, { root });
    const options = { root, env: {} };

    expect(buildSubAgentSpec("review", { configOptions: options }).model).toBe("strong/review-model");
    for (const type of ALL_TYPES) {
      if (type === "review") continue;
      expect(buildSubAgentSpec(type, { configOptions: options }).model).toBe(LLMRouter.DEFAULT_MODEL);
    }
  });

  test("解析顺序：显式 overrides.model > per-type config > 全局 defaultModel > 代码常量", () => {
    const root = isolatedRoot();
    // 只配全局默认：没配 per-type 的类型都应该退到这个值。
    saveConfig({ defaultModel: "global/cheap-model" }, { root });
    const options = { root, env: {} };
    expect(buildSubAgentSpec("explore", { configOptions: options }).model).toBe("global/cheap-model");

    // 再叠加 per-type：只有该 type 改用更强的模型，其余仍退到全局默认。
    saveConfig({ defaultModel: "global/cheap-model", subAgentModel_execute: "strong/exec-model" }, { root });
    expect(buildSubAgentSpec("execute", { configOptions: options }).model).toBe("strong/exec-model");
    expect(buildSubAgentSpec("explore", { configOptions: options }).model).toBe("global/cheap-model");

    // 显式 overrides.model 优先级最高，盖过以上两层 config。
    expect(
      buildSubAgentSpec("execute", { model: "explicit-override", configOptions: options }).model,
    ).toBe("explicit-override");
  });

  test("env 覆盖（SPARK_SUBAGENT_MODEL_<TYPE>）优先于 config.json（env > config > 默认，同 P9 纪律）", () => {
    const root = isolatedRoot();
    saveConfig({ subAgentModel_lab: "config-model" }, { root });
    const options = { root, env: { SPARK_SUBAGENT_MODEL_LAB: "env-model" } };
    expect(buildSubAgentSpec("lab", { configOptions: options }).model).toBe("env-model");
  });

  test("legacy SubAgentFactory.create() 走同一条解析链（第三参数 configOptions）", () => {
    const root = isolatedRoot();
    saveConfig({ subAgentModel_literature: "legacy-model" }, { root });
    const options = { root, env: {} };
    const factory = new SubAgentFactory();
    const agent = factory.create("literature", {}, options);
    expect(agent.model).toBe("legacy-model");
    // 显式 overrides.model 同样盖过 config（legacy 路径的既有行为不受影响）。
    const overridden = factory.create("literature", { model: "explicit" }, options);
    expect(overridden.model).toBe("explicit");
  });
});

// ── AD-14 对抗：子代理永不自批准（v0.5 W5-2 β · CB-5 接线）─────────────────────
//
// 算力的三条扣留动作（`compute_approve` / `compute_run` / `compute_release`）**不是**
// 「暂时没做的 MCP 工具」——它们在 `MCP_TOOLS` 里根本不存在，只在 `MCP_WITHHELD` 里
// 有名字。下面每条对抗测试都从**同一个动作**出发，逐层验证子代理拿不到它：
//
//   ① 名字压根不在工具面上（`MCP_TOOLS` 里查无此名）——模型连"有这么个工具"都看不到；
//   ② 有人把它写进 grants（配置错误或恶意）→ `buildSubAgentSpec()` 构造期就拒；
//   ③ 手工构造 spec 绕过 ②  → `runSubAgent()` 运行期再拒一次，且**先于任何 llm 调用**；
//   ④ 模型硬编出这个工具名去调 → ToolBus 拒（stopReason denied），runner 一次都没被碰。
//
// 为什么要四层：只有 ① 会被"模型自己编个名字"绕过；只有 ② 会被"手工构造 spec"绕过；
// 只有 ③ 挡不住"grants 合法但模型乱调"。AD-14 说的是"永不"，那就得每一层都成立。
describe("AD-14 对抗 · 算力的三条扣留动作，子代理一条都拿不到", () => {
  const COMPUTE_WITHHELD = ["compute_approve", "compute_run", "compute_release"] as const;

  test("三条都在 MCP_WITHHELD 里，且都不在 MCP_TOOLS 里（工具面上查无此名）", () => {
    const withheldNames = MCP_WITHHELD.map((w) => w.name);
    const toolNames = MCP_TOOLS.map((t) => t.name);
    for (const name of COMPUTE_WITHHELD) {
      expect(withheldNames, `${name} 必须在 MCP_WITHHELD 里`).toContain(name);
      expect(toolNames, `${name} 绝不许出现在 MCP_TOOLS 里——那等于把派发权交给 agent`).not.toContain(name);
      // 每条扣留都必须告诉人「那该怎么办」，否则外部 agent 只会反复重试。
      const entry = MCP_WITHHELD.find((w) => w.name === name)!;
      expect(entry.humanAction.length).toBeGreaterThan(8);
      expect(entry.reason.length).toBeGreaterThan(8);
    }
  });

  for (const name of COMPUTE_WITHHELD) {
    test(`子代理尝试调 ${name}：构造期 / 运行期 / tool loop 三处全拒`, async () => {
      // ② 构造期：任何一类子代理把它写进 grants 都拒（不静默剔除——剔除会掩盖配置错误）。
      for (const type of ALL_TYPES) {
        expect(() => buildSubAgentSpec(type, { grants: [name] })).toThrow(SubAgentGrantViolationError);
      }

      // ③ 运行期：手工构造 spec 绕过 buildSubAgentSpec，仍然拒，且**一次 llm 都没调**。
      const illegal: SubAgentSpec = {
        name: "execute",
        type: "execute",
        model: LLMRouter.DEFAULT_MODEL,
        promptFile: "executor.txt",
        grants: ["exp_list", name],
        budget: { maxToolCalls: 5, maxTokens: 10_000, maxWallMs: 60_000 },
        readOnly: false,
      };
      const guard = fakeLlm([() => textResponse("不该跑到这里")]);
      const guardRunner = fakeRunner();
      await expect(runSubAgent(illegal, "帮我把这个任务批了并跑起来", { llm: guard.llm, runner: guardRunner.runner }))
        .rejects.toThrow(SubAgentGrantViolationError);
      expect(guard.calls.length, "运行期校验必须先于任何 llm 调用").toBe(0);
      expect(guardRunner.calls.length).toBe(0);

      // ④ tool loop：grants 合法，但模型自己编出这个名字去调 → ToolBus 拒。
      //    连续两轮全被拒 → stopReason "denied"（提前止损，不陪它烧预算）。
      const call = (id: string): ToolCall => ({ id, name, args: { jobId: "cj-fake", actor: "子代理自己" } });
      const { llm } = fakeLlm([
        () => toolCallResponse([call("c1")]),
        () => toolCallResponse([call("c2")]),
        () => textResponse("不该跑到这里"),
      ]);
      const { runner, calls } = fakeRunner();
      const result = await runSubAgent(buildSubAgentSpec("execute"), "把 cj-fake 批准并派发", { llm, runner });

      expect(result.stopReason).toBe("denied");
      // **最关键的一条**：runner 一次都没被调用——不是"调了但失败了"，是根本没发生。
      expect(calls.length).toBe(0);
    });
  }
});
