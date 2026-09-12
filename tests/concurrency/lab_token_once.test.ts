import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalTokenError, consume, issue } from "../../backend/src/lab/approval_token";

// W8-1 ε · V95 验收测试（任务书明点：「并发 20 次 consume 只 1 成功」）。
//
// 评审关注点与 `tests/concurrency/approve_once.test.ts`（D-9）同构：一次签发的
// 令牌只能被兑现一次，即便多个调用几乎同时到达（HTTP 层两个并发请求各自读到
// 「令牌还没被用过」，双双通过校验）。`consume()` 的实现在读-改-写外面包了一把
// 同目录锁文件（`.lock`，`wx` 独占创建），真正的正确性来源是这把锁——不是「谁先
// 跑到」的时序巧合（虽然在单进程/单事件循环里，同步函数本身也天然互斥，这里用
// 「几乎同时发起」的 Promise.allSettled 逼近跨进程/跨请求的真实并发形状）。
describe("V95 · 一次性审批令牌并发消费（N=20 次 consume 同一枚令牌 → 恰好 1 次成功）", () => {
  test("并发 20 次 consume() 同一枚令牌，只有 1 次成功，其余全部 ApprovalTokenError", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-lab-token-once-"));
    const { token } = issue(root, "exp-concurrent");

    const N = 20;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => Promise.resolve().then(() => consume(root, "exp-concurrent", token))),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ApprovalTokenError);
      expect((r.reason as Error).message).toContain("已被使用过");
    }
  });

  test("并发 20 次分别签发+消费各自不同的令牌，互不影响（排除「锁把所有请求都挡住」的假阳性）", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-lab-token-once-distinct-"));
    const N = 20;
    const tokens = Array.from({ length: N }, (_, i) => issue(root, `exp-${i}`));

    const results = await Promise.allSettled(
      tokens.map((t, i) => Promise.resolve().then(() => consume(root, `exp-${i}`, t.token))),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
