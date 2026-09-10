import { describe, expect, test } from "bun:test";
import { MCP_TOOLS, MCP_WITHHELD, toolByName } from "../../backend/src/mcp/tools";
import { makeMcp } from "../helpers/mcp_scenario";

// CB-5 接线 · 算力的 MCP 面（AD-14）。
//
// **暴露四个，扣留三个**，这条分界是本 lane 的核心：
//   暴露：compute_plan（零副作用）· compute_status / compute_list（只读）· compute_collect
//   扣留：compute_approve（批一次就是批一笔账单）· compute_run（派发 = 计费动作本身）
//         · compute_release（删远端卷 = 破坏性）
//
// 「agent 经 MCP 只能 plan 与查状态，从不派发」——下面每一条断言都在钉这句话。

const EXPOSED = ["compute_plan", "compute_status", "compute_list", "compute_collect"] as const;
const WITHHELD = ["compute_approve", "compute_run", "compute_release"] as const;

interface PlanPayload {
  project: string;
  job: { jobId: string; lifecycle: { execution: string }; plan: { approvalRequired: boolean; warning: string } };
  humanAction: string;
  next: string;
}

describe("MCP · 算力工具面的分界", () => {
  test("四个暴露工具都在 MCP_TOOLS 里，三个扣留的一个都不在", () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    for (const name of EXPOSED) expect(names.has(name), `${name} 应当暴露`).toBe(true);
    for (const name of WITHHELD) {
      expect(names.has(name), `${name} 绝不许出现在 MCP_TOOLS 里`).toBe(false);
      expect(toolByName(name)).toBeUndefined();
      // 扣留不是「没做」：必须在 MCP_WITHHELD 里说清理由与人该怎么做。
      const entry = MCP_WITHHELD.find((w) => w.name === name);
      expect(entry, `${name} 必须登记在 MCP_WITHHELD 里，否则就只是「忘了做」`).toBeDefined();
      expect(entry!.humanAction).toContain("spark-research compute");
    }
  });

  test("**AD-14 对抗**：子代理猜到名字直接调这三个 → 一律拒，并被告知人该怎么做", async () => {
    const fx = makeMcp({ slug: "compute-mcp" });
    for (const name of WITHHELD) {
      const { ok, payload } = await fx.call<{ error: string; reason: string; humanAction: string }>(name, {
        jobId: "cj-fake",
        actor: "agent 自己",
      });
      expect(ok, `${name} 必须被拒`).toBe(false);
      expect(payload.error).toContain("刻意不通过 MCP 暴露");
      expect(payload.reason.length).toBeGreaterThan(8);
      expect(payload.humanAction).toContain("spark-research compute");
    }
    fx.dispose();
  });

  test("扣留清单出现在 capabilities 里——外部 agent 一眼看到边界，不是试了才知道", async () => {
    const fx = makeMcp({ slug: "compute-mcp" });
    const { ok, payload } = await fx.call<{
      mcp: { withheld: Array<{ name: string }> };
      compute: { withheld: string[]; targets: Array<{ kind: string; availability: string }> };
    }>("research_capabilities", {});
    expect(ok).toBe(true);
    const withheldNames = payload.mcp.withheld.map((w) => w.name);
    for (const name of WITHHELD) expect(withheldNames).toContain(name);
    expect([...payload.compute.withheld].sort()).toEqual([...WITHHELD].sort());
    // 「未配置」口径也要经 MCP 如实广播（AD-12）。
    const modal = payload.compute.targets.find((t) => t.kind === "modal")!;
    expect(modal.availability).toBe("needs_credential");
    fx.dispose();
  });
});

describe("MCP · 四个暴露工具真的打通到 HTTP 路由", () => {
  test("compute_plan：停在 awaiting_approval，返回体把人拉回环里", async () => {
    const fx = makeMcp({ slug: "compute-mcp" });
    const { ok, payload } = await fx.call<PlanPayload>("compute_plan", {
      purpose: "MCP 接线测试",
      command: ["/bin/echo", "hi"],
      network: "unrestricted",
    });
    expect(ok).toBe(true);
    expect(payload.job.lifecycle.execution).toBe("awaiting_approval");
    expect(payload.job.plan.approvalRequired).toBe(true);
    expect(payload.job.plan.warning).not.toBe("");
    // 这是 agent 唯一该做的下一步：把这条命令转达给人。
    expect(payload.humanAction).toContain("compute approve");
    fx.dispose();
  });

  test("compute_status / compute_list：只读，能查到刚 plan 出来的那条", async () => {
    const fx = makeMcp({ slug: "compute-mcp" });
    const planned = await fx.call<PlanPayload>("compute_plan", {
      purpose: "MCP 接线测试",
      command: ["/bin/echo", "hi"],
      network: "unrestricted",
    });
    const jobId = planned.payload.job.jobId;

    const status = await fx.call<{ job: { jobId: string; lifecycle: { execution: string } } }>("compute_status", {
      jobId,
    });
    expect(status.ok).toBe(true);
    expect(status.payload.job.jobId).toBe(jobId);
    expect(status.payload.job.lifecycle.execution).toBe("awaiting_approval");

    const listed = await fx.call<{ jobs: Array<{ jobId: string }> }>("compute_list", {
      state: "awaiting_approval",
    });
    expect(listed.ok).toBe(true);
    expect(listed.payload.jobs.map((j) => j.jobId)).toContain(jobId);

    const empty = await fx.call<{ jobs: unknown[] }>("compute_list", { state: "succeeded" });
    expect(empty.payload.jobs).toHaveLength(0);
    fx.dispose();
  });

  test("compute_collect 在任务还没到终态时失败（409 → ok:false），不假装收到了空产物", async () => {
    const fx = makeMcp({ slug: "compute-mcp" });
    const planned = await fx.call<PlanPayload>("compute_plan", {
      purpose: "MCP 接线测试",
      command: ["/bin/echo", "hi"],
      network: "unrestricted",
    });
    const { ok, payload } = await fx.call<{ error: string }>("compute_collect", {
      jobId: planned.payload.job.jobId,
    });
    expect(ok).toBe(false);
    expect(payload.error).toContain("终态");
    fx.dispose();
  });

  test("compute_plan 缺 purpose / command → ok:false（参数错误不静默变成一次空 plan）", async () => {
    const fx = makeMcp({ slug: "compute-mcp" });
    expect((await fx.call("compute_plan", { command: ["/bin/echo"] })).ok).toBe(false);
    expect((await fx.call("compute_plan", { purpose: "没有命令" })).ok).toBe(false);
    fx.dispose();
  });

  test("**agent 经 MCP 走不到派发**：plan 之后无论怎么调，任务都停在 awaiting_approval", async () => {
    const fx = makeMcp({ slug: "compute-mcp" });
    const planned = await fx.call<PlanPayload>("compute_plan", {
      purpose: "试图自己批自己跑",
      command: ["/bin/echo", "hi"],
      network: "unrestricted",
    });
    const jobId = planned.payload.job.jobId;

    // 把 agent 能想到的每条路都试一遍：扣留名 + 暴露工具的每一个。
    for (const name of [...WITHHELD, ...EXPOSED]) {
      await fx.call(name, { jobId, actor: "agent 自己", purpose: "x", command: ["/bin/echo", "hi"] });
    }

    const after = await fx.call<{ job: { lifecycle: { execution: string } } }>("compute_status", { jobId });
    expect(after.payload.job.lifecycle.execution).toBe("awaiting_approval");
    fx.dispose();
  });
});
