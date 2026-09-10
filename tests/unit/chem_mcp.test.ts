import { describe, expect, test } from "bun:test";
import { makeMcp } from "../helpers/mcp_scenario";

// C5-②（v0.5 W5-1-c）：`chem_depict` MCP 工具单测。
//
// 与 mcp_server.test.ts 的通用断言（描述四段式、schema 合法、名字唯一）分开放，这里
// 只验这一个工具**具体**的行为：真的能通过 MCP → app.fetch() → /api/chem/depict 打通，
// 而不是一个挂了名字却调不到任何代码的假入口。

interface DepictPayload {
  project: string;
  result: {
    svg: string;
    canonicalSmiles: string;
    formula: string;
    artifactId: string;
    recordId: string;
  };
}

describe("MCP · chem_depict", () => {
  test("真的打通到 HTTP 路由并落 artifact/record", async () => {
    const fx = makeMcp({ slug: "chem-mcp" });
    const { ok, payload } = await fx.call<DepictPayload>("chem_depict", { smiles: "CCO", name: "ethanol" });
    expect(ok).toBe(true);
    expect(payload.result.canonicalSmiles).toBe("CCO");
    expect(payload.result.svg.startsWith("<svg")).toBe(true);
    expect(payload.result.artifactId).toBeTruthy();
    expect(payload.result.recordId).toBeTruthy();
    fx.dispose();
  });

  test("缺 smiles 参数：MCP 层返回失败（HTTP 400 映射为 ok:false）", async () => {
    const fx = makeMcp({ slug: "chem-mcp" });
    const { ok } = await fx.call<{ error: string }>("chem_depict", {});
    expect(ok).toBe(false);
    fx.dispose();
  });

  test("非法 SMILES：MCP 层返回失败（HTTP 422 映射为 ok:false）", async () => {
    const fx = makeMcp({ slug: "chem-mcp" });
    const { ok } = await fx.call<{ error: string }>("chem_depict", { smiles: "not a smiles(((" });
    expect(ok).toBe(false);
    fx.dispose();
  });
});
