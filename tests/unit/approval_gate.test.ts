import { describe, expect, test } from "bun:test";
import {
  ApprovalGateError,
  COMPUTE_APPROVAL_GATE,
  LAB_APPROVAL_GATE,
  defaultIsInteractiveTty,
  mergeApprovalNote,
  requireApprovalGate,
  type ApprovalGateSpec,
} from "../../backend/src/approval/gate";

// V19 审批终端门（W5-2 β 从 lab/cli.ts 搬出来之后的独立测试）。
//
// 这份文件测的是**门本身**，不是某条命令的语义：
//   ① 非交互（piping / 重定向 / 子进程 / Bash 工具）默认拒绝；
//   ② CI 旁路必须三样齐全（env 配了 + --ci-bypass-token 匹配 + --ci-bypass-reason），
//      且旁路事实要能被拼进 decision record 的 note（留痕，不是静默放行）；
//   ③ 交互终端里没收到 'yes' 同样拒绝；
//   ④ **两把钥匙互不通用**：能批湿实验的 CI token 不该顺带获得「花钱跑 GPU」的权限。
//
// lab 侧的端到端行为（错误信息、退出码、note 真的进了 record）仍由
// tests/unit/lab_cli.test.ts 覆盖——搬出来之后那 5 条用例一字未改仍然全绿，
// 这本身就是「搬家没有改变行为」的证据。

const NO_FLAGS: Record<string, string | true> = {};

function tty(answer: string | null) {
  return {
    approvalIsInteractiveTty: () => true,
    approvalConfirm: async () => answer,
  };
}

const PIPED = { approvalIsInteractiveTty: () => false };

/** 拿到门抛出来的那个错误。**不许**让它悄悄通过——没抛就是这条断言本身失效了。 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("期望 requireApprovalGate 抛 ApprovalGateError，但它放行了");
}

describe("V19 审批终端门 · 非交互环境默认拒绝", () => {
  for (const spec of [LAB_APPROVAL_GATE, COMPUTE_APPROVAL_GATE]) {
    test(`${spec.subject}：piping（非 TTY）+ 未配置 ${spec.envVar} → 拒`, async () => {
      await expect(
        requireApprovalGate(spec, "x1", "approve", PIPED, NO_FLAGS, {}),
      ).rejects.toThrow(ApprovalGateError);

      // 错误信息必须说清楚缺什么、真人该怎么办——不是一句「拒绝」了事。
      const error = await rejection(requireApprovalGate(spec, "x1", "approve", PIPED, NO_FLAGS, {}));
      expect(error.message).toContain(`[${spec.tag}]`);
      expect(error.message).toContain(spec.envVar);
      expect(error.message).toContain("真实终端");
    });

    test(`${spec.subject}：配了 ${spec.envVar} 但 --ci-bypass-token 缺失/不匹配 → 拒`, async () => {
      const env = { [spec.envVar]: "correct-token" };
      const missing = await rejection(requireApprovalGate(spec, "x1", "approve", PIPED, NO_FLAGS, env));
      expect(missing).toBeInstanceOf(ApprovalGateError);
      expect(missing.message).toContain("缺少 --ci-bypass-token");

      const wrong = await rejection(requireApprovalGate(
        spec,
        "x1",
        "approve",
        PIPED,
        { "ci-bypass-token": "wrong", "ci-bypass-reason": "测试" },
        env,
      ));
      expect(wrong).toBeInstanceOf(ApprovalGateError);
      expect(wrong.message).toContain("不匹配");
    });

    test(`${spec.subject}：token 对了但缺 --ci-bypass-reason → 拒（旁路必须写明理由）`, async () => {
      const error = await rejection(requireApprovalGate(
        spec,
        "x1",
        "approve",
        PIPED,
        { "ci-bypass-token": "correct-token" },
        { [spec.envVar]: "correct-token" },
      ));
      expect(error).toBeInstanceOf(ApprovalGateError);
      expect(error.message).toContain("--ci-bypass-reason");
    });

    test(`${spec.subject}：三样齐全 → 放行，且旁路事实进 bypassNote（留痕）`, async () => {
      const result = await requireApprovalGate(
        spec,
        "x1",
        "approve",
        PIPED,
        { "ci-bypass-token": "correct-token", "ci-bypass-reason": "CI 要跑通闭环" },
        { [spec.envVar]: "correct-token" },
      );
      expect(result.bypassNote).toContain(`${spec.tag} CI 旁路`);
      expect(result.bypassNote).toContain(spec.envVar);
      expect(result.bypassNote).toContain("CI 要跑通闭环");
    });
  }

  // **这条是任务书点名要钉死的那一条**：piping 一个 'yes' 进 stdin 不会让 isTTY 变 true，
  // 所以「伪造一次交互」在第一步判定就过不去——不需要额外去防「stdin 被脚本控制」。
  test("piping 必拒：即便 stdin 里真的有一行 'yes'，非 TTY 也不给交互分支", async () => {
    let confirmCalled = 0;
    const deps = {
      approvalIsInteractiveTty: () => false,
      approvalConfirm: async () => {
        confirmCalled += 1;
        return "yes";
      },
    };
    await expect(
      requireApprovalGate(COMPUTE_APPROVAL_GATE, "cj-1", "approve", deps, NO_FLAGS, {}),
    ).rejects.toThrow(ApprovalGateError);
    // 交互确认压根没被调用——非交互分支不会去读 stdin，读到什么都不算数。
    expect(confirmCalled).toBe(0);
  });

  // 真实探测的物理事实：bun test 跑在子进程里，stdin/stdout 都不是 tty。
  // 这条断言把「Bash 工具/CI 天然落进非交互分支」从一句注释变成一条可核实的事实。
  test("默认探测在测试子进程里就是 false（不是靠注入假装的）", () => {
    expect(defaultIsInteractiveTty()).toBe(false);
  });
});

describe("V19 审批终端门 · 交互终端分支", () => {
  test("收到 'yes'（大小写/空白不敏感）→ 放行，bypassNote 为 null", async () => {
    for (const answer of ["yes", "YES", "  Yes  "]) {
      const result = await requireApprovalGate(COMPUTE_APPROVAL_GATE, "cj-1", "approve", tty(answer), NO_FLAGS, {});
      expect(result.bypassNote).toBeNull();
    }
  });

  test("收到别的 / 什么都没收到 → 拒", async () => {
    for (const answer of ["no", "y", "", null]) {
      const error = await rejection(requireApprovalGate(
        COMPUTE_APPROVAL_GATE,
        "cj-1",
        "approve",
        tty(answer),
        NO_FLAGS,
        {},
      ));
      expect(error).toBeInstanceOf(ApprovalGateError);
      expect(error.message).toContain("没有收到 'yes'");
    }
  });

  test("提示语说清楚「要批的是什么、是哪一条」——人得看得见对象才谈得上判断", async () => {
    const prompts: string[] = [];
    await requireApprovalGate(
      COMPUTE_APPROVAL_GATE,
      "cj-abc",
      "approve",
      {
        approvalIsInteractiveTty: () => true,
        approvalConfirm: async (p) => {
          prompts.push(p);
          return "yes";
        },
      },
      NO_FLAGS,
      {},
    );
    expect(prompts[0]).toContain("算力任务");
    expect(prompts[0]).toContain("cj-abc");
    expect(prompts[0]).toContain("批准");
  });

  test("reject 走同一道门（拒绝也是记名决策，不能绕）", async () => {
    await expect(
      requireApprovalGate(LAB_APPROVAL_GATE, "e1", "reject", tty("no"), NO_FLAGS, {}),
    ).rejects.toThrow(ApprovalGateError);
    const ok = await requireApprovalGate(LAB_APPROVAL_GATE, "e1", "reject", tty("yes"), NO_FLAGS, {});
    expect(ok.bypassNote).toBeNull();
  });
});

describe("V19 审批终端门 · 两把钥匙互不通用", () => {
  // 配了 CI 能批湿实验的流水线，**不该**顺带获得「花钱跑 GPU」的权限。
  // 这不是洁癖：两者的失败代价完全不同（一个是试剂，一个是账单），
  // 共用一把钥匙意味着任何一边的泄漏都同时打开两扇门。
  test("SPARK_LAB_CI_BYPASS_TOKEN 旁路不了算力门", async () => {
    const env = { SPARK_LAB_CI_BYPASS_TOKEN: "lab-token" };
    const error = await rejection(requireApprovalGate(
      COMPUTE_APPROVAL_GATE,
      "cj-1",
      "approve",
      PIPED,
      { "ci-bypass-token": "lab-token", "ci-bypass-reason": "我有 lab 的 token" },
      env,
    ));
    expect(error).toBeInstanceOf(ApprovalGateError);
    expect(error.message).toContain("SPARK_RESEARCH_COMPUTE_CI_BYPASS_TOKEN");
  });

  test("反过来也一样：算力 token 旁路不了湿实验门", async () => {
    const env = { SPARK_RESEARCH_COMPUTE_CI_BYPASS_TOKEN: "compute-token" };
    const error = await rejection(requireApprovalGate(
      LAB_APPROVAL_GATE,
      "e1",
      "approve",
      PIPED,
      { "ci-bypass-token": "compute-token", "ci-bypass-reason": "我有算力的 token" },
      env,
    ));
    expect(error).toBeInstanceOf(ApprovalGateError);
    expect(error.message).toContain("SPARK_LAB_CI_BYPASS_TOKEN");
  });

  test("两个内置 spec 的 envVar 必须不同（防止有人图省事把它们合并）", () => {
    const specs: ApprovalGateSpec[] = [LAB_APPROVAL_GATE, COMPUTE_APPROVAL_GATE];
    expect(new Set(specs.map((s) => s.envVar)).size).toBe(specs.length);
  });
});

describe("mergeApprovalNote", () => {
  test("用户备注与旁路留痕并存时拼在一起；两者都空返回 undefined（不写空字符串）", () => {
    expect(mergeApprovalNote("我的备注", "[旁路]")).toBe("我的备注 [旁路]");
    expect(mergeApprovalNote(undefined, "[旁路]")).toBe("[旁路]");
    expect(mergeApprovalNote("我的备注", null)).toBe("我的备注");
    expect(mergeApprovalNote(undefined, null)).toBeUndefined();
    expect(mergeApprovalNote("", null)).toBeUndefined();
  });
});
