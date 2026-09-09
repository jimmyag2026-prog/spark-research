import { describe, expect, test } from "bun:test";
import { makeMcp } from "../helpers/mcp_scenario";
import { PROTEIN_ACCESSION, PROTEIN_QUERY, proteinRegistry } from "../helpers/protein_scenario";

// R-d-2（v0.4 P11 lane R-d）：`protein_analyze` MCP 工具单测。
//
// 与 mcp_server.test.ts 的通用断言（描述四段式、schema 合法、名字唯一等）分开放，
// 这里只验这一个工具**具体**的行为：真的能通过 MCP → app.fetch() → /api/proteins/analyze
// 打通，而不是一个挂了名字却调不到任何代码的假入口（正是 protein-analysis 当初的问题）。

interface AnalyzePayload {
  project: string;
  result: {
    identity: { accession: string };
    experimentalStructureCount: number;
    alphafold: { available: boolean };
    recordId: string | null;
  };
}

describe("MCP · protein_analyze", () => {
  test("真的打通到 HTTP 路由并回落 observation record", async () => {
    const fx = makeMcp({ connectors: proteinRegistry("replay") });
    const { ok, payload } = await fx.call<AnalyzePayload>("protein_analyze", { query: PROTEIN_QUERY });
    expect(ok).toBe(true);
    expect(payload.result.identity.accession).toBe(PROTEIN_ACCESSION);
    expect(payload.result.experimentalStructureCount).toBe(350);
    expect(payload.result.recordId).toBeTruthy();
  });

  test("persist:false 时不落 record", async () => {
    const fx = makeMcp({ connectors: proteinRegistry("replay") });
    const { ok, payload } = await fx.call<AnalyzePayload>("protein_analyze", {
      query: PROTEIN_QUERY,
      persist: false,
    });
    expect(ok).toBe(true);
    expect(payload.result.recordId).toBeNull();
  });

  test("缺 query 参数：MCP 层返回失败（HTTP 400 映射为 ok:false）", async () => {
    const fx = makeMcp({ connectors: proteinRegistry("replay") });
    const { ok } = await fx.call<{ error: string }>("protein_analyze", {});
    expect(ok).toBe(false);
  });
});
