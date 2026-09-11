import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";
import { UsageStore, usageTrackingLlm } from "../../backend/src/usage/ledger";

// V93（v0.8 G-3）· 预算闸 TOCTOU。
//
// 改动前：闸检查与记账隔着整个 `await llm.call`——`Promise.all` 下 N 个在飞调用全部先过闸、
// 后记账，$0.1 的闸能放行 10 个 $0.03 的调用（花 $0.30）。
// 改动后：发前按估价**预留**进 inFlight，闸判 `已知(实时重读文件) + 在飞 + 本次估价 > 上限`；
// 预留在同步段完成，后来者一定看到先到者的预留。
//
// 阴性对照（已验红）：把 `usage/ledger.ts` 里 `ledger.tryReserve(estimate)` 前的闸改回只看
// `live >= budgetUsd`、且不把 inFlight 计入 → 第一条测试 10 个全部放行，红。

function slowLlm(costUsd: number, delayMs = 15) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    call: async (_m: ChatMessage[], _mo?: unknown): Promise<LlmResponse> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, delayMs)); // 让所有并发者都先过闸再有人结算
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

describe("V93 · 预算闸在飞预留", () => {
  test("10 并发、闸 $0.1、每次估价与实花 $0.03 → 恰好 3 个放行，7 个 kind:budget 且未发出", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v93-"));
    const inner = slowLlm(0.03);
    const wrapped = usageTrackingLlm({
      llm: inner,
      store: new UsageStore(join(dir, "usage.jsonl")),
      command: "test",
      budgetUsd: 0.1,
      estimateUsd: () => 0.03,
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => wrapped.call([{ role: "user", content: "hi" }], "moonshotai/kimi-k2.6")),
    );
    const passed = results.filter((r) => r.ok);
    const denied = results.filter((r) => !r.ok);
    expect(passed.length).toBe(3);
    expect(denied.length).toBe(7);
    for (const d of denied) if (!d.ok) expect(d.error.kind).toBe("budget");
    expect(inner.calls).toBe(3); // 被拒的 7 个一次都没碰到上游
    const snap = wrapped.ledger.snapshot();
    expect(snap.inFlightUsd).toBe(0); // 全部结算，无残留预留
    expect(snap.inFlightCalls).toBe(0);
    expect(snap.knownCostUsd).toBeCloseTo(0.09, 8);
  });

  test("发前预检：单次估价就超预算 → 拒绝，一分钱不花（改前：单次可花掉预算 158%）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v93-"));
    const inner = slowLlm(0.079);
    const wrapped = usageTrackingLlm({
      llm: inner,
      store: new UsageStore(join(dir, "usage.jsonl")),
      command: "test",
      budgetUsd: 0.05,
      estimateUsd: () => 0.079,
    });
    const res = await wrapped.call([{ role: "user", content: "hi" }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("budget");
    expect(inner.calls).toBe(0);
  });

  test("跨进程：闸实时重读 usage.jsonl——另一个进程刚花的钱立刻算进来（改前只在构造时读一次）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v93-"));
    const file = join(dir, "usage.jsonl");
    const mk = () =>
      usageTrackingLlm({
        llm: slowLlm(0.04, 0),
        store: new UsageStore(file),
        command: "test",
        budgetUsd: 0.1,
        estimateUsd: () => 0.04,
      });
    const procA = mk();
    const procB = mk(); // 两个"进程"同时启动，构造时历史都是 $0
    expect((await procA.call([{ role: "user", content: "1" }])).ok).toBe(true); // A: 0.04
    expect((await procB.call([{ role: "user", content: "2" }])).ok).toBe(true); // B: 看到文件里 0.04，+0.04 = 0.08
    const third = await procA.call([{ role: "user", content: "3" }]); // A: 文件 0.08 + 0.04 > 0.1 → 拒
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.kind).toBe("budget");
  });

  test("上游抛异常 → 预留释放，不残留在飞额", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v93-"));
    const wrapped = usageTrackingLlm({
      llm: {
        call: async () => {
          throw new Error("boom");
        },
      },
      store: new UsageStore(join(dir, "usage.jsonl")),
      command: "test",
      budgetUsd: 1,
      estimateUsd: () => 0.5,
    });
    await expect(wrapped.call([{ role: "user", content: "hi" }])).rejects.toThrow("boom");
    expect(wrapped.ledger.snapshot().inFlightUsd).toBe(0);
    expect((await wrapped.call([{ role: "user", content: "hi" }]).catch(() => null))).toBeNull(); // 再来仍能过闸（会再抛），说明没被残留预留卡死
  });
});
