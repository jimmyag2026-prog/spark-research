import { describe, expect, test } from "bun:test";
import { BudgetExceededError, BudgetLedger, estimateCallCostUsd } from "../../backend/src/llm/budget";

const usage = (costUsd: number) => ({ inputTokens: 1, outputTokens: 1, costUsd, usageUnavailable: false });

describe("V93 · BudgetLedger.tryReserve / settle / release", () => {
  test("预留计入 inFlight，不计入 knownCostUsd；settle 后转为已结算", () => {
    const l = new BudgetLedger({ maxCostUsd: 0.1 });
    const r = l.tryReserve(0.03)!;
    expect(r).not.toBeNull();
    expect(l.snapshot().inFlightUsd).toBeCloseTo(0.03, 8);
    expect(l.snapshot().knownCostUsd).toBe(0);
    r.settle(usage(0.02));
    expect(l.snapshot().inFlightUsd).toBe(0);
    expect(l.snapshot().knownCostUsd).toBeCloseTo(0.02, 8);
    expect(r.settled).toBe(true);
  });

  test("已结算 + 在飞 + 新估价 > 上限 → tryReserve 返回 null，reserve 抛 BudgetExceededError", () => {
    const l = new BudgetLedger({ maxCostUsd: 0.1 });
    l.record(usage(0.05));
    expect(l.tryReserve(0.03)).not.toBeNull(); // 0.05 + 0.03 = 0.08
    expect(l.tryReserve(0.03)).toBeNull(); // 0.08 + 0.03 > 0.1
    expect(() => l.reserve(0.03)).toThrow(BudgetExceededError);
  });

  test("release 只释放不记账；settle/release 幂等", () => {
    const l = new BudgetLedger({ maxCostUsd: 0.1 });
    const r = l.tryReserve(0.05)!;
    r.release();
    r.release();
    expect(l.snapshot().inFlightUsd).toBe(0);
    expect(l.snapshot().calls).toBe(0);
    const r2 = l.tryReserve(0.05)!;
    r2.settle(usage(0.01));
    const again = r2.settle(usage(0.01));
    expect(again.costUnavailable).toBe(true);
    expect(l.snapshot().calls).toBe(1);
  });

  test("父账本全局上限拦住子账本在飞合计（每个子都没超、加起来超）", () => {
    const parent = new BudgetLedger({ maxCostUsd: 0.1 });
    const a = parent.child({ maxCostUsd: 0.08 });
    const b = parent.child({ maxCostUsd: 0.08 });
    expect(a.tryReserve(0.06)).not.toBeNull();
    expect(b.tryReserve(0.06)).toBeNull(); // 父：0.06 + 0.06 > 0.1
    expect(parent.snapshot().inFlightUsd).toBeCloseTo(0.06, 8);
  });

  test("estimateCallCostUsd：查不到单价返回 null 不是 0；能定价时按 maxTokens 上限估", () => {
    expect(estimateCallCostUsd([{ role: "user", content: "hi" }], {}, { provider: "nope", model: "x" })).toBeNull();
    const e = estimateCallCostUsd([{ role: "user", content: "a".repeat(300) }], { maxTokens: 1000 }, { provider: "deepseek", model: "deepseek-chat" });
    expect(e).not.toBeNull();
    expect(e!).toBeGreaterThan(0);
  });
});
