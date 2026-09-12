import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalTokenError, consume, issue } from "../../backend/src/lab/approval_token";

// W8-1 ε · V95：`lab/approval_token.ts` 的纯逻辑单测——issue()/consume() 不经过
// CLI 的 TTY 门（那道门单独测，见 lab_cli.test.ts / approval_gate.test.ts），
// 只测「令牌本身的账本」：签发、单次消费、过期、篡改、并发（并发见
// tests/concurrency/lab_token_once.test.ts，这里只测顺序逻辑）。
//
// 隔离：每个测试用 mkdtemp 造一个独立的项目根目录，绝不碰 ~/.spark-research。

function tmpProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-approval-token-"));
}

describe("V95 · approval_token.issue()/consume()", () => {
  test("issue() 落盘 0600、含 experimentId/hash/issuedAt/expiresAt/used:false，不存原始令牌", () => {
    const root = tmpProjectRoot();
    const issued = issue(root, "exp-1");
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/); // 32 字节十六进制。
    expect(issued.experimentId).toBe("exp-1");

    const file = join(root, "lab", "approval_tokens.json");
    expect(existsSync(file)).toBe(true);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = JSON.parse(readFileSync(file, "utf8")) as { tokens: Array<Record<string, unknown>> };
    expect(raw.tokens).toHaveLength(1);
    const record = raw.tokens[0]!;
    expect(record.experimentId).toBe("exp-1");
    expect(record.used).toBe(false);
    expect(typeof record.tokenHash).toBe("string");
    expect(record.tokenHash).not.toBe(issued.token); // 只存 hash，不存原始令牌。
    expect(JSON.stringify(raw)).not.toContain(issued.token);
    expect(record.issuedAt).toBe(issued.issuedAt);
    expect(record.expiresAt).toBe(issued.expiresAt);
  });

  test("issue() 有效期恰好 10 分钟", () => {
    const root = tmpProjectRoot();
    const issued = issue(root, "exp-ttl");
    const deltaMs = Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt);
    expect(deltaMs).toBe(10 * 60 * 1000);
  });

  test("consume() 成功一次，第二次同一枚令牌 → 拒（已被使用过）", () => {
    const root = tmpProjectRoot();
    const { token } = issue(root, "exp-2");
    expect(() => consume(root, "exp-2", token)).not.toThrow();
    expect(() => consume(root, "exp-2", token)).toThrow(ApprovalTokenError);
    expect(() => consume(root, "exp-2", token)).toThrow(/已被使用过/);
  });

  test("consume() 过期拒（手工写一条已过期的记录，不真等 10 分钟）", () => {
    const root = tmpProjectRoot();
    const { token } = issue(root, "exp-3");
    const file = join(root, "lab", "approval_tokens.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { tokens: Array<Record<string, unknown>> };
    data.tokens[0]!.expiresAt = new Date(Date.now() - 1000).toISOString(); // 1 秒前就过期了。
    writeFileSync(file, JSON.stringify(data, null, 2));
    expect(() => consume(root, "exp-3", token)).toThrow(ApprovalTokenError);
    expect(() => consume(root, "exp-3", token)).toThrow(/已过期/);
  });

  test("consume() 篡改令牌（hash 对不上）→ 拒（令牌无效）", () => {
    const root = tmpProjectRoot();
    issue(root, "exp-4");
    expect(() => consume(root, "exp-4", "0".repeat(64))).toThrow(ApprovalTokenError);
    expect(() => consume(root, "exp-4", "0".repeat(64))).toThrow(/无效/);
  });

  test("consume() 缺 approvalToken（空字符串）→ 拒，消息指路径", () => {
    const root = tmpProjectRoot();
    expect(() => consume(root, "exp-5", "")).toThrow(ApprovalTokenError);
    expect(() => consume(root, "exp-5", "")).toThrow(/spark-research lab token/);
  });

  test("令牌绑定 experimentId：consume() 用在另一个 experimentId 上 → 拒（不能跨实验借用）", () => {
    const root = tmpProjectRoot();
    const { token } = issue(root, "exp-a");
    expect(() => consume(root, "exp-b", token)).toThrow(ApprovalTokenError);
  });

  test("同一项目下不同实验各自独立签发/消费，互不影响", () => {
    const root = tmpProjectRoot();
    const a = issue(root, "exp-x");
    const b = issue(root, "exp-y");
    expect(() => consume(root, "exp-x", a.token)).not.toThrow();
    // exp-y 的令牌没被动过，仍然有效。
    expect(() => consume(root, "exp-y", b.token)).not.toThrow();
  });

  // **阴性对照**：如果 consume() 忘了检查 used 标记（比如把「标 used」那一行删掉），
  // 「第二次同一枚令牌应当被拒」这条断言就会变成「不抛错」——真跑验证过，记进 devlog。
  test("阴性对照：去掉 used 标记的写回，第二次 consume 不会再被拒——证明测试真的在测单次消费", () => {
    const root = tmpProjectRoot();
    const { token } = issue(root, "exp-neg");
    const file = join(root, "lab", "approval_tokens.json");
    // 手工模拟「consume() 忘记持久化 used:true」：consume 一次之后，把磁盘上的记录
    // 强制改回 used:false——等价于验证「如果实现漏了这一步，测试会红」。
    consume(root, "exp-neg", token);
    const data = JSON.parse(readFileSync(file, "utf8")) as { tokens: Array<Record<string, unknown>> };
    expect(data.tokens[0]!.used).toBe(true); // 先确认正常路径确实写回了 used:true。
    data.tokens[0]!.used = false;
    writeFileSync(file, JSON.stringify(data, null, 2));
    // 人为抹掉 used 标记之后，同一枚令牌真的又能被消费一次——这正是「阴性对照」要展示的：
    // 单次消费的保证**来自** used 标记的持久化，不是来自某种巧合。
    expect(() => consume(root, "exp-neg", token)).not.toThrow();
  });
});
