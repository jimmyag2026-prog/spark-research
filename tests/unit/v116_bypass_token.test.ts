import { describe, expect, test } from "bun:test";
import { COMPUTE_APPROVAL_GATE, LAB_APPROVAL_GATE, constantTimeEqual, requireApprovalGate } from "../../backend/src/approval/gate";

// V116：CI 旁路 token ① 常量时间比较 ② 可从环境变量取（不走 argv）。
const PIPED = { approvalIsInteractiveTty: () => false };

describe("V116 · CI bypass token", () => {
  test("constantTimeEqual：相等 true；不等 false；长度不同也 false 且不抛", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  for (const spec of [LAB_APPROVAL_GATE, COMPUTE_APPROVAL_GATE]) {
    test(`${spec.subject}：--ci-bypass-token-env 从环境变量取 token，argv 里没有 token 本体也放行`, async () => {
      const result = await requireApprovalGate(
        spec, "x1", "approve", PIPED,
        { "ci-bypass-token-env": "MY_CI_TOKEN", "ci-bypass-reason": "CI" },
        { [spec.envVar]: "correct-token", MY_CI_TOKEN: "correct-token" },
      );
      expect(result.bypassNote).toContain("CI 旁路");
    });
    test(`${spec.subject}：--ci-bypass-token-env 指向的变量不匹配/不存在 → 拒`, async () => {
      for (const env of [{ [spec.envVar]: "correct-token", MY_CI_TOKEN: "wrong" }, { [spec.envVar]: "correct-token" }]) {
        let msg = "";
        try {
          await requireApprovalGate(spec, "x1", "approve", PIPED, { "ci-bypass-token-env": "MY_CI_TOKEN", "ci-bypass-reason": "CI" }, env);
        } catch (e) {
          msg = (e as Error).message;
        }
        expect(msg).toContain("ci-bypass-token");
      }
    });
  }
});
