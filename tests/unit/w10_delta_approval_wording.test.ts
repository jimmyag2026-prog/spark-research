import { describe, expect, test } from "bun:test";
import { requireApprovalGate, ApprovalGateError } from "../../backend/src/approval/gate";
import { LAB_HELP } from "../../backend/src/lab/cli";

// δ-5（V167）门禁。
//
// 实测（pty 下 `lab approve` 全流程，输出原文见 docs/devlog/W10-delta.md §δ-5）已经证明
// TTY 检测不是安全边界。代码行为**没有改**（那道门该留着，它挡误触、并逼旁路留痕），
// 改的是措辞——所以门禁钉的是两件事：
//   ① 措辞：任何地方都不能再把 TTY 说成「过不了这一关」；
//   ② 行为：isTTY=true 那条分支的真正判据是**那句字面 'yes'**，不是别的。

const SPEC = { tag: "V19", envVar: "SPARK_LAB_CI_BYPASS_TOKEN", subject: "实验", rationale: "这是 AD-6 要求的人工判断" };

describe("δ-5 V167 · 措辞", () => {
  test("lab 帮助里明说 TTY 检测不是安全边界，并指出真正的门", () => {
    expect(LAB_HELP).toContain("别把 TTY 检测当成安全边界");
    expect(LAB_HELP).toContain("V167");
    expect(LAB_HELP).toContain("script -q /dev/null");
  });

  test("approval/gate.ts 与 readme_for_agent.md 不再声称伪造交互过不了这一关", async () => {
    const gate = await Bun.file("backend/src/approval/gate.ts").text();
    expect(gate).not.toContain("「伪造一次交互」本身就先过不了这一步判定");
    expect(gate).toContain("TTY 检测不是安全边界");
    const agentReadme = await Bun.file("readme_for_agent.md").text();
    expect(agentReadme).toContain("不是安全边界");
    expect(agentReadme).toContain("script -q /dev/null");
  });
});

describe("δ-5 V167 · 行为（TTY 分支的真正判据是那句 'yes'）", () => {
  test("isTTY=true + 'yes' → 放行，且不产生旁路留痕", async () => {
    const result = await requireApprovalGate(
      SPEC,
      "exp1",
      "approve",
      { approvalIsInteractiveTty: () => true, approvalConfirm: async () => "yes" },
      {},
      {},
    );
    expect(result.bypassNote).toBe(null);
  });

  test("isTTY=true 但答的不是 'yes' → 拒绝（pty 包装满足了 TTY 也救不了它）", async () => {
    for (const answer of ["no", "", "y", null]) {
      let caught: unknown;
      try {
        await requireApprovalGate(
          SPEC,
          "exp1",
          "approve",
          { approvalIsInteractiveTty: () => true, approvalConfirm: async () => answer },
          {},
          {},
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApprovalGateError);
    }
  });

  test("非交互分支未变：没 token 硬失败，token+reason 齐了才放行并留痕", async () => {
    const env = { SPARK_LAB_CI_BYPASS_TOKEN: "t0ken" };
    await expect(
      requireApprovalGate(SPEC, "exp1", "approve", { approvalIsInteractiveTty: () => false }, {}, env),
    ).rejects.toThrow(ApprovalGateError);
    const ok = await requireApprovalGate(
      SPEC,
      "exp1",
      "approve",
      { approvalIsInteractiveTty: () => false },
      { "ci-bypass-token": "t0ken", "ci-bypass-reason": "流水线夜间批准" },
      env,
    );
    expect(ok.bypassNote).toContain("流水线夜间批准");
  });
});
