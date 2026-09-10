import { describe, expect, test } from "bun:test";
import {
  BudgetExceededError,
  BudgetLedger,
  type BudgetLimitKind,
} from "../../backend/src/llm/budget";
import {
  PRICING,
  parsePricingOverridesJson,
  priceFor,
} from "../../backend/src/llm/providers/registry";
import type { Usage } from "../../backend/src/llm/types";

// R-c-1：单价表 + BudgetLedger。
//
// 核心纪律（与 R-a 一致）：拿不到 usage 或拿不到单价时 costUsd 必须是 null，
// **绝不填 0**——下游要能区分「真没花钱」与「不知道花了多少」。
// 这组测试专门钉住这条纪律，以及「一个账本句柄跨多次调用传递」这条接口设计要求。

function usage(input: number, output: number, extra: Partial<Usage> = {}): Usage {
  return { inputTokens: input, outputTokens: output, costUsd: null, ...extra };
}

describe("registry · priceFor 单价表", () => {
  test("已知 provider/model 返回带来源与核实日期的价格", () => {
    const price = priceFor("openai", "gpt-4o", { env: {} });
    expect(price).not.toBeNull();
    expect(price!.inputPerMillionUsd).toBeGreaterThan(0);
    expect(price!.outputPerMillionUsd).toBeGreaterThan(0);
    expect(price!.source.length).toBeGreaterThan(0);
    expect(price!.verifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("查不到就是 null，不猜一个近似值（未知 provider）", () => {
    expect(priceFor("does-not-exist", "whatever", { env: {} })).toBeNull();
  });

  test("查不到就是 null（已知 provider 但模型名对不上——如 PROVIDER_MODELS.kimi 里已退役的模型名）", () => {
    expect(priceFor("kimi", "kimi-k2", { env: {} })).toBeNull();
    expect(priceFor("qwen", "qwen3", { env: {} })).toBeNull();
  });

  test("内置表里每一条都有正数价格、非空来源、ISO 格式核实日期", () => {
    for (const [provider, models] of Object.entries(PRICING)) {
      for (const [model, pricing] of Object.entries(models)) {
        expect(pricing.inputPerMillionUsd, `${provider}/${model} input`).toBeGreaterThan(0);
        expect(pricing.outputPerMillionUsd, `${provider}/${model} output`).toBeGreaterThan(0);
        expect(pricing.source.length, `${provider}/${model} source`).toBeGreaterThan(0);
        expect(pricing.verifiedDate, `${provider}/${model} verifiedDate`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  test("config 覆盖优先于内置表", () => {
    const overrideJson = JSON.stringify({
      "openai:gpt-4o": { inputPerMillionUsd: 999, outputPerMillionUsd: 999 },
    });
    const price = priceFor("openai", "gpt-4o", { env: { SPARK_LLM_PRICING_JSON: overrideJson } });
    expect(price!.inputPerMillionUsd).toBe(999);
    expect(price!.outputPerMillionUsd).toBe(999);
  });

  test("覆盖 JSON 里没提到的 provider/model 仍然落回内置表", () => {
    const overrideJson = JSON.stringify({
      "openai:gpt-4o": { inputPerMillionUsd: 999, outputPerMillionUsd: 999 },
    });
    const price = priceFor("deepseek", "deepseek-chat", { env: { SPARK_LLM_PRICING_JSON: overrideJson } });
    expect(price!.inputPerMillionUsd).not.toBe(999);
  });

  test("覆盖 JSON 格式错误（不是合法 JSON）→ 静默降级回内置表，不抛异常", () => {
    const price = priceFor("openai", "gpt-4o", { env: { SPARK_LLM_PRICING_JSON: "{ 这不是 JSON" } });
    expect(price).toEqual(PRICING.openai!["gpt-4o"]!);
  });

  test("覆盖 JSON 格式错误（缺 input/output 数字）→ 整个覆盖被忽略，不是部分生效", () => {
    const overrideJson = JSON.stringify({
      "openai:gpt-4o": { inputPerMillionUsd: 999, outputPerMillionUsd: 999 },
      "deepseek:deepseek-chat": { inputPerMillionUsd: "not-a-number" },
    });
    const openaiPrice = priceFor("openai", "gpt-4o", { env: { SPARK_LLM_PRICING_JSON: overrideJson } });
    // 第二项格式错误 → 整个覆盖对象被拒，第一项（本来合法）也不生效。
    expect(openaiPrice).toEqual(PRICING.openai!["gpt-4o"]!);
  });

  test("parsePricingOverridesJson 直接暴露错误原因", () => {
    const bad = parsePricingOverridesJson("not json");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("SPARK_LLM_PRICING_JSON");
    const empty = parsePricingOverridesJson(null);
    expect(empty.ok).toBe(true);
    expect(empty.overrides).toEqual({});
  });
});

describe("BudgetLedger · 累计与诚实记账", () => {
  test("跨多次 record() 累计 token 数与调用数——句柄语义", () => {
    const ledger = new BudgetLedger();
    ledger.record(usage(100, 50, { usageUnavailable: false }));
    ledger.record(usage(200, 80, { usageUnavailable: false }));
    const snap = ledger.snapshot();
    expect(snap.calls).toBe(2);
    expect(snap.inputTokens).toBe(300);
    expect(snap.outputTokens).toBe(130);
    expect(snap.totalTokens).toBe(430);
  });

  test("usage.usageUnavailable=true → 这次调用的 tokens 不计入累计，成本记为未知，绝不填 0", () => {
    const ledger = new BudgetLedger();
    const result = ledger.record({ inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true });
    expect(result.costUsd).toBeNull();
    expect(result.costUnavailable).toBe(true);
    const snap = ledger.snapshot();
    expect(snap.calls).toBe(1);
    expect(snap.inputTokens).toBe(0);
    expect(snap.unknownCostCalls).toBe(1);
    expect(snap.costUsd).toBeNull();
  });

  test("usage 拿到了但查不到单价（没给 provider/model）→ 成本仍是未知，不是 0", () => {
    const ledger = new BudgetLedger();
    const result = ledger.record(usage(1000, 500, { usageUnavailable: false }));
    expect(result.costUsd).toBeNull();
    expect(result.costUnavailable).toBe(true);
    expect(ledger.snapshot().unknownCostCalls).toBe(1);
  });

  test("usage 拿到了、给了 provider/model 但单价表查不到 → 成本仍是未知", () => {
    const ledger = new BudgetLedger();
    const result = ledger.record(usage(1000, 500, { usageUnavailable: false }), {
      provider: "does-not-exist",
      model: "whatever",
    });
    expect(result.costUsd).toBeNull();
    expect(ledger.snapshot().unknownCostCalls).toBe(1);
  });

  test("usage 与单价都拿到了 → 按单价表算出确定成本，计入 knownCostUsd", () => {
    const ledger = new BudgetLedger();
    // 1,000,000 input + 1,000,000 output，gpt-4o: $2.5 in / $10 out → $12.5
    const result = ledger.record(usage(1_000_000, 1_000_000, { usageUnavailable: false }), {
      provider: "openai",
      model: "gpt-4o",
    });
    expect(result.costUnavailable).toBe(false);
    expect(result.costUsd).toBeCloseTo(12.5, 6);
    const snap = ledger.snapshot();
    expect(snap.knownCostUsd).toBeCloseTo(12.5, 6);
    expect(snap.unknownCostCalls).toBe(0);
    expect(snap.costUsd).toBeCloseTo(12.5, 6);
  });

  test("已知成本与未知成本调用混合 → 聚合 costUsd 是 null，但 knownCostUsd 仍是确定下界", () => {
    const ledger = new BudgetLedger();
    ledger.record(usage(1_000_000, 1_000_000, { usageUnavailable: false }), {
      provider: "openai",
      model: "gpt-4o",
    });
    ledger.record(usage(500, 500, { usageUnavailable: false })); // 没给 provider/model → 未知
    const snap = ledger.snapshot();
    expect(snap.unknownCostCalls).toBe(1);
    expect(snap.costUsd).toBeNull(); // 不能诚实报出一个确定总数
    expect(snap.knownCostUsd).toBeCloseTo(12.5, 6); // 但下界仍然可查
  });

  test("usage.costUsd 已经非 null 时（未来 provider 可能直接给账单）优先信任它，不重新估算", () => {
    const ledger = new BudgetLedger();
    const result = ledger.record(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 0.01, usageUnavailable: false },
      { provider: "openai", model: "gpt-4o" }, // 若重新估算会是 12.5，远大于注入的 0.01
    );
    expect(result.costUsd).toBe(0.01);
  });

  test("costUsd 恒不为 0 冒充免费：usageUnavailable 时即便 provider/model 都给了也不算钱", () => {
    const ledger = new BudgetLedger();
    const result = ledger.record(usage(0, 0, { usageUnavailable: true }), {
      provider: "openai",
      model: "gpt-4o",
    });
    expect(result.costUsd).toBeNull();
    expect(result.costUnavailable).toBe(true);
  });
});

describe("BudgetLedger · 上限判定", () => {
  test("maxCalls 超限", () => {
    const ledger = new BudgetLedger({ maxCalls: 1 });
    ledger.record(usage(1, 1, { usageUnavailable: false }));
    let snap = ledger.snapshot();
    expect(snap.exceeded).not.toContain("calls");
    const result = ledger.record(usage(1, 1, { usageUnavailable: false }));
    expect(result.newlyExceeded).toContain("calls");
    snap = ledger.snapshot();
    expect(snap.exceeded).toContain("calls" satisfies BudgetLimitKind);
    expect(ledger.isExceeded()).toBe(true);
  });

  test("maxInputTokens / maxOutputTokens / maxTotalTokens 各自独立判定", () => {
    const ledger = new BudgetLedger({ maxInputTokens: 100, maxOutputTokens: 50, maxTotalTokens: 120 });
    ledger.record(usage(90, 10, { usageUnavailable: false }));
    expect(ledger.snapshot().exceeded).toEqual([]);
    ledger.record(usage(20, 60, { usageUnavailable: false })); // input=110>100, output=70>50, total=180>120
    const exceeded = ledger.snapshot().exceeded;
    expect(exceeded).toContain("inputTokens");
    expect(exceeded).toContain("outputTokens");
    expect(exceeded).toContain("totalTokens");
  });

  test("maxWallMs 用注入的 now() 判定，不依赖真实时间流逝", () => {
    let clock = 1000;
    const ledger = new BudgetLedger({ maxWallMs: 500 }, { now: () => clock });
    expect(ledger.snapshot().exceeded).toEqual([]);
    clock += 600;
    expect(ledger.snapshot().wallMs).toBe(600);
    expect(ledger.snapshot().exceeded).toContain("wallMs");
  });

  test("maxCostUsd：已知成本（下界）超限就判定为确定超，即便存在未知调用", () => {
    const ledger = new BudgetLedger({ maxCostUsd: 5 });
    ledger.record(usage(1_000_000, 1_000_000, { usageUnavailable: false }), {
      provider: "openai",
      model: "gpt-4o",
    }); // 已知成本 12.5 > 5
    ledger.record(usage(1, 1, { usageUnavailable: false })); // 未知成本，costUsd 聚合为 null
    const snap = ledger.snapshot();
    expect(snap.costUsd).toBeNull(); // 聚合确实是 null（诚实）
    expect(snap.exceeded).toContain("costUsd"); // 但已知下界已经确定超限
  });

  test("maxCostUsd：只有未知调用、已知成本为 0 时不判定超限（不能凭空说超）", () => {
    const ledger = new BudgetLedger({ maxCostUsd: 5 });
    ledger.record(usage(1, 1, { usageUnavailable: false })); // 未知成本
    expect(ledger.snapshot().exceeded).not.toContain("costUsd");
  });

  test("assertWithinLimits：超限时抛 BudgetExceededError，未超限时静默通过", () => {
    const ledger = new BudgetLedger({ maxCalls: 1 });
    expect(() => ledger.assertWithinLimits()).not.toThrow();
    ledger.record(usage(1, 1, { usageUnavailable: false }));
    ledger.record(usage(1, 1, { usageUnavailable: false }));
    let caught: unknown;
    try {
      ledger.assertWithinLimits();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect((caught as BudgetExceededError).kind).toBe("calls");
  });

  test("record() 本身不抛异常、不强制停机——账本是观测组件，硬停由调用方决定", () => {
    const ledger = new BudgetLedger({ maxCalls: 0 });
    expect(() => ledger.record(usage(1, 1, { usageUnavailable: false }))).not.toThrow();
    expect(ledger.isExceeded()).toBe(true);
  });
});

describe("BudgetLedger · 父子账本传递（P12 子代理场景）", () => {
  test("child() 记的账会转发到 parent，父账本能看到全局汇总", () => {
    const parent = new BudgetLedger({ maxCostUsd: 10 });
    const childA = parent.child({ maxCalls: 5 }, "sub-agent-a");
    const childB = parent.child({ maxCalls: 5 }, "sub-agent-b");

    childA.record(usage(1_000_000, 1_000_000, { usageUnavailable: false }), { provider: "openai", model: "gpt-4o" });
    childB.record(usage(1_000_000, 1_000_000, { usageUnavailable: false }), { provider: "openai", model: "gpt-4o" });

    expect(childA.snapshot().calls).toBe(1);
    expect(childB.snapshot().calls).toBe(1);
    // 父账本汇总了两个子账本的调用：各自都没超 maxCalls:5，但父账本的 maxCostUsd:10
    // 会被 2*12.5=25 触发——这正是「每个子代理都没超，但加起来超了」的场景。
    const parentSnap = parent.snapshot();
    expect(parentSnap.calls).toBe(2);
    expect(parentSnap.knownCostUsd).toBeCloseTo(25, 6);
    expect(parentSnap.exceeded).toContain("costUsd");
  });

  test("子账本与父账本各自独立计数：子账本自己的 snapshot 不包含兄弟子账本的调用", () => {
    const parent = new BudgetLedger();
    const childA = parent.child();
    const childB = parent.child();
    childA.record(usage(1, 1, { usageUnavailable: false }));
    childB.record(usage(1, 1, { usageUnavailable: false }));
    childB.record(usage(1, 1, { usageUnavailable: false }));
    expect(childA.snapshot().calls).toBe(1);
    expect(childB.snapshot().calls).toBe(2);
    expect(parent.snapshot().calls).toBe(3);
  });

  test("label 默认值与自定义 label", () => {
    const parent = new BudgetLedger({}, { label: "root" });
    expect(parent.snapshot().label).toBe("root");
    const child = parent.child();
    expect(child.snapshot().label).toBe("root.child");
    const namedChild = parent.child({}, "explorer-1");
    expect(namedChild.snapshot().label).toBe("explorer-1");
  });
});
