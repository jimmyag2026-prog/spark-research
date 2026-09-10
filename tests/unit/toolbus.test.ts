import { describe, expect, test } from "bun:test";
import { MCP_TOOLS, MCP_WITHHELD } from "../../backend/src/mcp/tools";
import type { McpToolRunner, ToolOutcome as McpToolOutcome } from "../../backend/src/mcp/server";
import { BudgetLedger } from "../../backend/src/llm/budget";
import {
  AgentToolBus,
  isDenied,
  type ToolAuditEntry,
  type ToolCallCost,
} from "../../backend/src/agents/toolbus";
import { makeMcp } from "../helpers/mcp_scenario";

// P12 · `AgentToolBus`（v0.4 方案 §4.2，波次 W1-a）。
//
// 四组测试对应任务书的三条硬规则 + 计价维度可扩展性：
//   ① AD-14：`MCP_WITHHELD` 无条件拒绝，即便被误配进 grants
//   ② AD-2：未授权工具结构化拒绝，不抛异常
//   ③ 预算：超限后结构化拒绝，且能与「执行失败」区分
//   ④ 审计：每次调用落一条记录，参数摘要脱敏
// 阴性对照（回退各硬规则确认测试真的会红）见 docs/devlog/W1-a.md。

function collectAudit(): { entries: ToolAuditEntry[]; audit: (e: ToolAuditEntry) => void } {
  const entries: ToolAuditEntry[] = [];
  return { entries, audit: (e) => entries.push(e) };
}

describe("AgentToolBus · specs() 与 MCP_TOOLS 同源", () => {
  test("只暴露 grants 里的工具，schema 与 MCP_TOOLS 逐字段一致", () => {
    const fx = makeMcp();
    const grants = ["research_capabilities", "project_list"];
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants,
      budget: new BudgetLedger(),
      audit: () => {},
      timeoutMs: 5_000,
    });

    const specs = bus.specs();
    expect(specs.map((s) => s.name).sort()).toEqual([...grants].sort());

    for (const spec of specs) {
      const source = MCP_TOOLS.find((t) => t.name === spec.name)!;
      expect(spec.description).toBe(source.description);
      expect(spec.inputSchema).toEqual(source.inputSchema as unknown as Record<string, unknown>);
    }

    // 没在 grants 里的工具，即便存在于 MCP_TOOLS，也不出现在 specs() 里。
    expect(specs.map((s) => s.name)).not.toContain("lit_search");
  });

  test("MCP_WITHHELD 的动作压根不可能出现在 specs() 里（就算误把名字塞进 grants）", () => {
    const fx = makeMcp();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: MCP_WITHHELD.map((w) => w.name),
      budget: new BudgetLedger(),
      audit: () => {},
      timeoutMs: 5_000,
    });
    expect(bus.specs()).toEqual([]);
  });
});

describe("AgentToolBus · 硬规则一：AD-14 子代理永不自批准", () => {
  test("MCP_WITHHELD 的每个动作都被拒绝，且理由/人工动作与 MCP_WITHHELD 同源", async () => {
    const fx = makeMcp();
    const { entries, audit } = collectAudit();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: [], // 未授权，双重覆盖：既没 grant 也是 withheld
      budget: new BudgetLedger(),
      audit,
      timeoutMs: 5_000,
    });

    for (const w of MCP_WITHHELD) {
      const outcome = await bus.call(w.name, { actor: "attacker" });
      expect(outcome.ok).toBe(false);
      expect(isDenied(outcome)).toBe(true);
      if (!isDenied(outcome)) throw new Error("unreachable");
      expect(outcome.denied).toBe("withheld");
      expect(outcome.reason).toBe(w.reason);
      expect(outcome.humanAction).toBe(w.humanAction);
    }

    const withheldEntries = entries.filter((e) => e.denied === "withheld");
    expect(withheldEntries.length).toBe(MCP_WITHHELD.length);
  });

  test("**红线**：即便攻击者把危险动作塞进自己的 grants 列表，ToolBus 依旧拒绝——授权配置错误不能绕过 AD-14", async () => {
    const fx = makeMcp();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["lab_approve", "lab_simulate", "conclusion_review", "project_archive", "lab_reject"],
      budget: new BudgetLedger(),
      audit: () => {},
      timeoutMs: 5_000,
    });

    for (const w of MCP_WITHHELD) {
      const outcome = await bus.call(w.name, { experimentId: "x", conclusionId: "x", slug: "x" });
      expect(outcome.ok).toBe(false);
      if (!isDenied(outcome)) throw new Error("unreachable：危险动作必须走拒绝路径");
      expect(outcome.denied).toBe("withheld");
    }
  });
});

describe("AgentToolBus · 硬规则二：未授权工具结构化拒绝（AD-2）", () => {
  test("不在 grants 里 → {ok:false, denied:'not_granted', granted:[...]}，不抛异常", async () => {
    const fx = makeMcp();
    const grants = ["project_list"];
    const budget = new BudgetLedger();
    const bus = new AgentToolBus({ runner: fx.runner, grants, budget, audit: () => {}, timeoutMs: 5_000 });

    const outcome = await bus.call("research_capabilities", { probe: false });
    expect(outcome.ok).toBe(false);
    if (!isDenied(outcome)) throw new Error("unreachable");
    expect(outcome.denied).toBe("not_granted");
    expect(outcome.granted).toEqual(grants);

    // 未授权的调用没有真的发生：预算账本没有被消耗。
    expect(budget.snapshot().calls).toBe(0);
  });

  test("未知工具名（既不在 MCP_TOOLS 也不在 grants）同样是结构化拒绝而不是异常", async () => {
    const fx = makeMcp();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: [],
      budget: new BudgetLedger(),
      audit: () => {},
      timeoutMs: 5_000,
    });
    const outcome = await bus.call("does_not_exist_at_all", {});
    expect(outcome.ok).toBe(false);
    if (!isDenied(outcome)) throw new Error("unreachable");
    expect(outcome.denied).toBe("not_granted");
  });
});

describe("AgentToolBus · 硬规则三：预算超限结构化拒绝，且与「执行失败」可区分", () => {
  test("已经超限（墙钟）时拒绝调用，且这次拒绝本身不再消耗预算", async () => {
    // 用可控时钟而不是 maxCalls：墙钟维度不需要"先吃一次调用才知道超没超"——
    // 时间流逝本身就能让账本在**任何调用发生之前**就已经处于超限状态，
    // 这样能干净地测「调用前置检查」本身，不掺杂 calls 维度的边界语义
    // （calls 维度见下一条测试：BudgetLedger 的 `exceeded` 判定是"严格大于"，
    // 天然允许恰好越过上限的那一次调用通过，ToolBus 如实复用这个语义，不额外加码）。
    let now = 0;
    const budget = new BudgetLedger({ maxWallMs: 10 }, { now: () => now });
    const fx = makeMcp();
    const { entries, audit } = collectAudit();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["research_capabilities"],
      budget,
      audit,
      timeoutMs: 5_000,
    });

    now = 50; // 墙钟已经超过 maxWallMs:10，且此刻还没有任何调用发生过。
    const outcome = await bus.call("research_capabilities", {});
    expect(outcome.ok).toBe(false);
    if (!isDenied(outcome)) throw new Error("unreachable：预算已超限，这次调用必须被拒绝而不是被执行");
    expect(outcome.denied).toBe("budget_exceeded");
    expect(outcome.exceeded).toContain("wallMs");
    // 拒绝的调用不会让计数继续涨——「被拒绝」不消耗预算。
    expect(budget.snapshot().calls).toBe(0);

    const denials = entries.filter((e) => e.denied === "budget_exceeded");
    expect(denials.length).toBe(1);
  });

  test("calls 维度的边界语义：BudgetLedger 的 exceeded 判定是「严格大于」，恰好越线的那次调用会被放行，" +
    "再下一次才拒绝——ToolBus 如实复用账本的判定，不做自己的预判", async () => {
    const fx = makeMcp();
    const budget = new BudgetLedger({ maxCalls: 1 });
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["research_capabilities"],
      budget,
      audit: () => {},
      timeoutMs: 5_000,
    });

    const first = await bus.call("research_capabilities", {});
    expect(isDenied(first)).toBe(false);
    expect(budget.snapshot().calls).toBe(1);
    expect(budget.snapshot().exceeded).not.toContain("calls"); // 1 > 1 为假，还不算超限

    const second = await bus.call("research_capabilities", {});
    expect(isDenied(second)).toBe(false); // 这次调用把计数推到 2，但检查发生在它之前
    expect(budget.snapshot().calls).toBe(2);
    expect(budget.snapshot().exceeded).toContain("calls"); // 现在 2 > 1，账本认定超限了

    const third = await bus.call("research_capabilities", {});
    expect(third.ok).toBe(false);
    if (!isDenied(third)) throw new Error("unreachable");
    expect(third.denied).toBe("budget_exceeded");
    expect(budget.snapshot().calls).toBe(2); // 第三次调用被挡在执行之前，没有继续消耗
  });

  test("**可区分性**：预算未超时，工具执行失败（超时）仍然是 ok:false 但没有 denied 字段", async () => {
    // 用一个假 runner 制造"执行失败"（超时），验证它与预算拒绝在类型上可区分。
    const slowRunner = {
      call: async (): Promise<McpToolOutcome> => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true, payload: "永远不该被读到——ToolBus 应该已经超时返回了" };
      },
    } as unknown as McpToolRunner;

    const budget = new BudgetLedger(); // 无上限，肯定不是预算问题
    const bus = new AgentToolBus({
      runner: slowRunner,
      grants: ["research_capabilities"],
      budget,
      audit: () => {},
      timeoutMs: 5,
    });

    const outcome = await bus.call("research_capabilities", {});
    expect(outcome.ok).toBe(false);
    expect(isDenied(outcome)).toBe(false); // 关键：执行失败 ≠ 拒绝
    if (isDenied(outcome)) throw new Error("unreachable");
    expect(JSON.stringify(outcome.payload)).toContain("超时");

    // 调用确实"发生"了（只是没在超时前完成）——计入预算，不能假装它没花时间/资源。
    expect(budget.snapshot().calls).toBe(1);
  });
});

describe("AgentToolBus · 计价维度可扩展（v0.4 方案 §4.2 第 6 条的接口预留）", () => {
  test("成本记账走通用维度而不是硬编码 token：inputTokens/outputTokens 恒 0，但 calls 与 unknownCostCalls 照常累计", async () => {
    const fx = makeMcp();
    const budget = new BudgetLedger();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["research_capabilities"],
      budget,
      audit: () => {},
      timeoutMs: 5_000,
    });

    await bus.call("research_capabilities", {});
    const snapshot = budget.snapshot();
    // 工具调用不是 LLM 请求，token 维度天然为 0——不是"忘了填"，是这个维度对工具调用
    // 本来就不适用（正是不该把计价硬编码成 token 的原因）。
    expect(snapshot.inputTokens).toBe(0);
    expect(snapshot.outputTokens).toBe(0);
    // 但"这次调用花了多少钱"被诚实记成"未知"（不是 0）——`costUsd` 因此是 null，
    // 而不是被悄悄吞掉。v0.5 要接算力成本时，只需要让某些工具在这里报出真实数字，
    // 这条不变式（未知记未知，绝不当免费）已经在测试里锁死。
    expect(snapshot.calls).toBe(1);
    expect(snapshot.unknownCostCalls).toBe(1);
    expect(snapshot.costUsd).toBeNull();
  });
});

describe("AgentToolBus · 审计：每次调用落一条记录，参数摘要脱敏", () => {
  test("成功调用的审计记录包含耗时/结果规模，且不是拒绝", async () => {
    const fx = makeMcp();
    const { entries, audit } = collectAudit();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["research_capabilities"],
      budget: new BudgetLedger(),
      audit,
      timeoutMs: 5_000,
    });

    await bus.call("research_capabilities", { probe: false });
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.tool).toBe("research_capabilities");
    expect(entry.ok).toBe(true);
    expect(entry.denied).toBeUndefined();
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.resultSize).toBeGreaterThan(0);
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  test("参数摘要经过 redactSecrets：凭据不出现在审计记录里", async () => {
    const fx = makeMcp();
    const { entries, audit } = collectAudit();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["research_capabilities"],
      budget: new BudgetLedger(),
      audit,
      timeoutMs: 5_000,
    });

    const secretKey = "sk-abcdefghijklmnopqrstuvwxyz123456";
    await bus.call("research_capabilities", {
      probe: false,
      apiKey: secretKey,
      authorization: `Bearer ${secretKey}`,
    });

    expect(entries.length).toBe(1);
    const summary = entries[0]!.argsSummary;
    expect(summary).not.toContain(secretKey);
    expect(summary).toContain("[redacted]");
  });

  test("被拒绝的调用也落审计记录（resultSize 恒为 0），拒绝原因写进 denied", async () => {
    const fx = makeMcp();
    const { entries, audit } = collectAudit();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: [],
      budget: new BudgetLedger(),
      audit,
      timeoutMs: 5_000,
    });

    await bus.call("project_list", {});
    await bus.call("lab_approve", { experimentId: "x", actor: "attacker" });

    expect(entries.length).toBe(2);
    expect(entries[0]!.denied).toBe("not_granted");
    expect(entries[0]!.resultSize).toBe(0);
    expect(entries[1]!.denied).toBe("withheld");
    expect(entries[1]!.resultSize).toBe(0);
  });
});

describe("AgentToolBus · 端到端：真实 P9 McpToolRunner 走通一次正常调用", () => {
  test("research_capabilities 的返回体透传（ToolBus 不重实现业务逻辑）", async () => {
    const fx = makeMcp();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["research_capabilities"],
      budget: new BudgetLedger(),
      audit: () => {},
      timeoutMs: 5_000,
    });

    const direct = await fx.call<{ connectors: unknown[] }>("research_capabilities", {});
    const viaBus = await bus.call("research_capabilities", {});
    expect(viaBus.ok).toBe(true);
    if (isDenied(viaBus)) throw new Error("unreachable");
    expect(viaBus.payload).toEqual(direct.payload);
  });
});

// ── v0.5 W5-2 β（CB-5 接线）：计价维度 + 算力扣留 ─────────────────────────────

describe("AgentToolBus · ToolCostUnit 与算力工具的计价口径", () => {
  test("ToolCostUnit 扩成 call | computeSeconds（类型口子留着，broker 侧记的是计算秒）", () => {
    // 编译期就够了：能把 "computeSeconds" 赋进来，说明 union 真的扩了。
    const call: ToolCallCost = { unit: "call", costUsd: null };
    const seconds: ToolCallCost = { unit: "computeSeconds", costUsd: 1.5 };
    expect(call.unit).toBe("call");
    expect(seconds.unit).toBe("computeSeconds");
  });

  test("暴露出去的 compute_* 工具**恒不计价**（costUsd=null，且 unknownCostCalls 被记上）", async () => {
    const fx = makeMcp({ slug: "toolbus-compute" });
    const budget = new BudgetLedger();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["compute_list"],
      budget,
      audit: () => {},
      timeoutMs: 10_000,
    });

    const outcome = await bus.call("compute_list", {});
    expect(isDenied(outcome)).toBe(false);

    const snapshot = budget.snapshot();
    // 关键：**不是 0**。0 会被读成「这次真的免费」；null + unknownCostCalls 才是
    // 「我们确实不知道这一次值多少钱」。真实花费在 ComputeBroker.collect() 里记账。
    expect(snapshot.costUsd).toBeNull();
    expect(snapshot.unknownCostCalls).toBeGreaterThan(0);
  });

  test("三条算力扣留动作即便被塞进 grants 也拿不到（denied=withheld，runner 一次没碰）", async () => {
    const fx = makeMcp({ slug: "toolbus-compute-withheld" });
    const { entries, audit } = collectAudit();
    const bus = new AgentToolBus({
      runner: fx.runner,
      grants: ["compute_approve", "compute_run", "compute_release"],
      budget: new BudgetLedger(),
      audit,
      timeoutMs: 10_000,
    });

    // specs() 里一个都不该出现——模型连"有这么个工具"都看不到。
    expect(bus.specs()).toEqual([]);

    for (const name of ["compute_approve", "compute_run", "compute_release"]) {
      const outcome = await bus.call(name, { jobId: "cj-fake", actor: "agent 自己" });
      expect(isDenied(outcome)).toBe(true);
      if (!isDenied(outcome)) throw new Error("unreachable");
      // "withheld" 而不是 "not_granted"：这不是"你没被授权"，是"谁都不许"。
      expect(outcome.denied).toBe("withheld");
    }
    expect(entries.map((e) => e.denied)).toEqual(["withheld", "withheld", "withheld"]);
    expect(entries.every((e) => e.resultSize === 0)).toBe(true);
  });
});
