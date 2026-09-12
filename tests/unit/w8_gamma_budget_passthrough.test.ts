import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmExtras } from "../../backend/src/llm/types";
import { ProjectManager } from "../../backend/src/project/manager";
import { ServerContext } from "../../backend/src/server/context";

// V79③（W8-1 γ）：花钱操作的 UI「预算 $」输入要真的能拦下调用，不能只是个摆设的输入框。
// 链路是 UI 输入 → 路由 body.budgetUsd → `ctx.llmFor(project, command, sessionId, options)`
// → `usageTrackingLlm`（闸的判定逻辑，属于 usage/ledger.ts，不是本 lane 的地盘）。
// 这里只测**本 lane 改的那一段**——`llmFor` 是否把 budgetUsd/allowUnpriced 原样递给
// usageTrackingLlm，不测闸本身怎么判（那是 g3_budget_gate.test.ts 的范围）。

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spark-w8-gamma-budget-"));
  roots.push(root);
  const manager = new ProjectManager(root);
  const project = manager.create("budget-passthrough", { name: "budget passthrough" });
  return { root, manager, project };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// 底层 llm 永远答应——闸如果没拦住，这条就是「本来会发出去的调用」。
const alwaysOkLlm = {
  call: async () => ({
    ok: true as const,
    provider: "openrouter",
    model: "moonshotai/kimi-k2.6",
    content: "ok",
    ...llmExtras(),
  }),
};

describe("V79③ · context.llmFor budgetUsd/allowUnpriced 透传", () => {
  test("给了极小 budgetUsd → 闸触发，kind=budget，消息里有下一步，调用没有真的发出", async () => {
    const { project, manager } = fixture();
    const ctx = new ServerContext({ root: project.paths.root, projects: manager, llm: alwaysOkLlm });
    const llm = ctx.llmFor(project, "lit-read", null, { budgetUsd: 0.0001 });
    // 默认模型 moonshotai/kimi-k2.6 单价表里有价——即使消息很短，仅 maxTokens 默认
    // 4096 的输出侧估价就已经远超 $0.0001（见 llm/budget.ts 的 estimateCallCostUsd）。
    const res = await llm.call([{ role: "user", content: "随便写点什么用来估价" }]);
    expect(res.ok).toBe(false);
    expect((res as { error?: { kind?: string } }).error?.kind).toBe("budget");
    expect((res as { error?: { message?: string } }).error?.message ?? "").toContain("下一步");
  });

  test("阴性对照：不给 budgetUsd（老调用方式）→ 闸不生效，调用照发", async () => {
    const { project, manager } = fixture();
    const ctx = new ServerContext({ root: project.paths.root, projects: manager, llm: alwaysOkLlm });
    const llm = ctx.llmFor(project, "lit-read"); // 不传第四个参数——老调用点的形态。
    const res = await llm.call([{ role: "user", content: "随便写点什么" }]);
    expect(res.ok).toBe(true);
  });

  test("allowUnpriced 同样透传：预算闸开着但模型无单价时按 allowUnpriced 决定放不放行", async () => {
    const { project, manager } = fixture();
    const ctx = new ServerContext({ root: project.paths.root, projects: manager, llm: alwaysOkLlm });
    const unpricedModel = "definitely-not-in-pricing-table/v1";

    const blocked = ctx.llmFor(project, "lit-read", null, { budgetUsd: 1 });
    const blockedRes = await blocked.call([{ role: "user", content: "x" }], unpricedModel);
    expect(blockedRes.ok).toBe(false);
    expect((blockedRes as { error?: { kind?: string } }).error?.kind).toBe("budget");

    const allowed = ctx.llmFor(project, "lit-read", null, { budgetUsd: 1, allowUnpriced: true });
    const allowedRes = await allowed.call([{ role: "user", content: "x" }], unpricedModel);
    expect(allowedRes.ok).toBe(true);
  });
});
