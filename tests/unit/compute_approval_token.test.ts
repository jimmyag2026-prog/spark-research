import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalTokenError, consume, issue } from "../../backend/src/compute/approval_token";

// V135 (Gate H-2) · compute 域的一次性 HTTP 审批令牌——与 lab 侧 V95
// (`tests/unit/w8_epsilon_approval_token.test.ts`) 完全同构的纯逻辑单测，只把
// `experimentId` 换成 `jobId`，目录从 `lab` 换成 `compute`。issue()/consume()
// 不经过 CLI 的 TTY 门（那道门单独测，见 compute_cli.test.ts）。
//
// 隔离：每个测试用 mkdtemp 造一个独立的项目根目录，绝不碰 ~/.spark-research。

function tmpProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-compute-approval-token-"));
}

describe("V135 · compute/approval_token.issue()/consume()", () => {
  test("issue() 落盘 0600、含 jobId/hash/issuedAt/expiresAt/used:false，不存原始令牌", () => {
    const root = tmpProjectRoot();
    const issued = issue(root, "job-1");
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.jobId).toBe("job-1");

    const file = join(root, "compute", "approval_tokens.json");
    expect(existsSync(file)).toBe(true);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = JSON.parse(readFileSync(file, "utf8")) as { tokens: Array<Record<string, unknown>> };
    expect(raw.tokens).toHaveLength(1);
    const record = raw.tokens[0]!;
    expect(record.jobId).toBe("job-1");
    expect(record.used).toBe(false);
    expect(typeof record.tokenHash).toBe("string");
    expect(record.tokenHash).not.toBe(issued.token);
    expect(JSON.stringify(raw)).not.toContain(issued.token);
    expect(record.issuedAt).toBe(issued.issuedAt);
    expect(record.expiresAt).toBe(issued.expiresAt);
  });

  test("issue() 有效期恰好 10 分钟", () => {
    const root = tmpProjectRoot();
    const issued = issue(root, "job-ttl");
    const deltaMs = Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt);
    expect(deltaMs).toBe(10 * 60 * 1000);
  });

  test("consume() 成功一次，第二次同一枚令牌 → 拒（已被使用过）", () => {
    const root = tmpProjectRoot();
    const { token } = issue(root, "job-2");
    expect(() => consume(root, "job-2", token)).not.toThrow();
    expect(() => consume(root, "job-2", token)).toThrow(ApprovalTokenError);
    expect(() => consume(root, "job-2", token)).toThrow(/已被使用过/);
  });

  test("consume() 过期拒（手工写一条已过期的记录，不真等 10 分钟）", () => {
    const root = tmpProjectRoot();
    const { token } = issue(root, "job-3");
    const file = join(root, "compute", "approval_tokens.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { tokens: Array<Record<string, unknown>> };
    data.tokens[0]!.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(file, JSON.stringify(data, null, 2));
    expect(() => consume(root, "job-3", token)).toThrow(ApprovalTokenError);
    expect(() => consume(root, "job-3", token)).toThrow(/已过期/);
  });

  test("consume() 篡改令牌（hash 对不上）→ 拒（令牌无效）", () => {
    const root = tmpProjectRoot();
    issue(root, "job-4");
    expect(() => consume(root, "job-4", "0".repeat(64))).toThrow(ApprovalTokenError);
    expect(() => consume(root, "job-4", "0".repeat(64))).toThrow(/无效/);
  });

  test("consume() 缺 approvalToken（空字符串）→ 拒，消息指路径", () => {
    const root = tmpProjectRoot();
    expect(() => consume(root, "job-5", "")).toThrow(ApprovalTokenError);
    expect(() => consume(root, "job-5", "")).toThrow(/spark-research compute token/);
  });

  test("令牌绑定 jobId：consume() 用在另一个 jobId 上 → 拒（不能跨任务借用）", () => {
    const root = tmpProjectRoot();
    const { token } = issue(root, "job-a");
    expect(() => consume(root, "job-b", token)).toThrow(ApprovalTokenError);
  });

  test("同一项目下不同任务各自独立签发/消费，互不影响", () => {
    const root = tmpProjectRoot();
    const a = issue(root, "job-x");
    const b = issue(root, "job-y");
    expect(() => consume(root, "job-x", a.token)).not.toThrow();
    expect(() => consume(root, "job-y", b.token)).not.toThrow();
  });

  test("阴性对照：去掉 used 标记的写回，第二次 consume 不会再被拒——证明测试真的在测单次消费", () => {
    const root = tmpProjectRoot();
    const { token } = issue(root, "job-neg");
    const file = join(root, "compute", "approval_tokens.json");
    consume(root, "job-neg", token);
    const data = JSON.parse(readFileSync(file, "utf8")) as { tokens: Array<Record<string, unknown>> };
    expect(data.tokens[0]!.used).toBe(true);
    data.tokens[0]!.used = false;
    writeFileSync(file, JSON.stringify(data, null, 2));
    expect(() => consume(root, "job-neg", token)).not.toThrow();
  });
});
