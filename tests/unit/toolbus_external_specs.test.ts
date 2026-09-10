import { describe, expect, test } from "bun:test";
import { AgentToolBus } from "../../backend/src/agents/toolbus";
import { BudgetLedger } from "../../backend/src/llm/budget";
import type { McpToolRunner } from "../../backend/src/mcp/server";

// V32 收口（W5-3）：外部 MCP 工具必须出现在**模型可见的 tools 列表**里。
//
// γ 把执行链路接通了（runner 能路由 `mcp:` 名字、grants 里也加了这些名字），
// 但它自己戳破了一件事：`AgentToolBus.specs()` 原本只返回 `MCP_TOOLS.filter(...)`
// 一张固定表——**`mcp:` 前缀的工具永远进不了给模型的列表**。γ 的原话：
// 「我的测试用 mock LLM 直接发出工具名，证明的是『发出来就能执行』，
//  不是『模型会发出来』——真实模型不会自己想到调一个它从没被告知存在的工具。」
//
// 没有这一环，「agent 能自主使用外部 MCP 工具」就是谎话。
function bus(grants: string[], externalSpecs?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) {
  return new AgentToolBus({
    runner: {} as McpToolRunner,
    grants,
    budget: new BudgetLedger(),
    audit: () => {},
    timeoutMs: 1000,
    externalSpecs,
  });
}

const EXT = {
  name: "mcp:demo/search",
  description: "[外部 MCP · demo] 搜索",
  inputSchema: { type: "object", properties: {} } as Record<string, unknown>,
};

describe("V32 · 外部工具必须进模型可见的 tools 列表", () => {
  test("授权了外部工具 → specs() 里必须有它（这就是 V32 缺的那一环）", () => {
    const names = bus(["lit_search", EXT.name], [EXT]).specs().map((s) => s.name);
    expect(names).toContain(EXT.name);
    // 内建工具照旧在，不是把一个换成另一个。
    expect(names).toContain("lit_search");
  });

  test("没授权的外部工具不许出现（接线 ≠ 放开授权）", () => {
    const names = bus(["lit_search"], [EXT]).specs().map((s) => s.name);
    expect(names).not.toContain(EXT.name);
  });

  test("不给 externalSpecs → 与接线前逐字节同行为（没装扩展的用户不受影响）", () => {
    const before = bus(["lit_search"]).specs();
    const after = bus(["lit_search"], []).specs();
    expect(after).toEqual(before);
    expect(before.every((s) => !s.name.startsWith("mcp:"))).toBe(true);
  });
});
