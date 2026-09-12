import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";
import { UsageStore, resetSharedInFlightForTests, usageTrackingLlm } from "../../backend/src/usage/ledger";

// V125（A7 Blocker-1）：HTTP 面每个请求各建一个 ledger，在飞预留互不可见；闸的另一半（实时重读
// usage.jsonl）只看得到**已结算**花费。于是 N 个并发请求同时过闸同时开跑 —— A7 实测 10 并发
// × budgetUsd=0.03 实际花掉 $0.0807。修法：在飞额按 usage.jsonl 路径聚合到进程级注册表。
// 阴性对照（已验红）：闸只看 ledger 自己的 inFlight（不看共享注册表）→ 第一条红（10 个全放行）。

afterEach(() => resetSharedInFlightForTests());

function slowLlm(costUsd: number, delayMs = 20) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    call: async (_m: ChatMessage[], _o?: unknown): Promise<LlmResponse> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        ok: true,
        provider: "openrouter",
        model: "moonshotai/kimi-k2.6",
        content: "ok",
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 10, costUsd, usageUnavailable: false },
      };
    },
  };
}

describe("V125 · 并发请求共享在飞预留（每请求一个 ledger 的 HTTP 形状）", () => {
  test("10 个独立 wrapper（模拟 10 个 HTTP 请求）各 budgetUsd=0.03、每次估价/实花 0.014 → 合计不越 0.03", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v125-"));
    const file = join(dir, "usage.jsonl");
    const inner = slowLlm(0.014);
    // 每个请求都新建 wrapper —— 这正是 ctx.llmFor() 的形状
    const calls = Array.from({ length: 10 }, () =>
      usageTrackingLlm({
        llm: inner,
        store: new UsageStore(file),
        command: "lit-read",
        budgetUsd: 0.03,
        estimateUsd: () => 0.014,
      }).call([{ role: "user", content: "hi" }]),
    );
    const results = await Promise.all(calls);
    const ok = results.filter((r) => r.ok).length;
    const denied = results.filter((r) => !r.ok);
    expect(ok).toBe(2); // 0.014 × 2 = 0.028 ≤ 0.03；第 3 个会越线
    expect(inner.calls).toBe(2);
    for (const d of denied) if (!d.ok) expect(d.error.kind).toBe("budget");
    const spent = new UsageStore(file).totals().knownCostUsd;
    expect(spent).toBeLessThanOrEqual(0.03);
  });

  test("结算后在飞额归零：第二波调用能按剩余预算继续放行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v125-"));
    const file = join(dir, "usage.jsonl");
    const inner = slowLlm(0.01, 0);
    const mk = () =>
      usageTrackingLlm({ llm: inner, store: new UsageStore(file), command: "c", budgetUsd: 0.05, estimateUsd: () => 0.01 });
    expect((await mk().call([{ role: "user", content: "1" }])).ok).toBe(true);
    expect((await mk().call([{ role: "user", content: "2" }])).ok).toBe(true);
    // 已结算 0.02，在飞 0 → 还能继续
    expect((await mk().call([{ role: "user", content: "3" }])).ok).toBe(true);
    expect(new UsageStore(file).totals().knownCostUsd).toBeCloseTo(0.03, 8);
  });

  test("不同项目（不同 usage.jsonl）互不影响", async () => {
    const a = join(mkdtempSync(join(tmpdir(), "v125a-")), "usage.jsonl");
    const b = join(mkdtempSync(join(tmpdir(), "v125b-")), "usage.jsonl");
    const inner = slowLlm(0.02);
    const mk = (file: string) =>
      usageTrackingLlm({ llm: inner, store: new UsageStore(file), command: "c", budgetUsd: 0.025, estimateUsd: () => 0.02 });
    const [ra, rb] = await Promise.all([
      mk(a).call([{ role: "user", content: "a" }]),
      mk(b).call([{ role: "user", content: "b" }]),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
  });
});
