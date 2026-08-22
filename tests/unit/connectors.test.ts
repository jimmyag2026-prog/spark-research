import { describe, test, expect } from "bun:test";
import { BUILTIN_CONNECTORS, ConnectorRegistry } from "../../backend/src/connectors/registry";

function builtinNames(): string[] {
  return Object.values(BUILTIN_CONNECTORS).flatMap((defs) => defs.map((d) => d.name));
}

describe("ConnectorRegistry", () => {
  test("注册了所有内置连接器", () => {
    const registry = new ConnectorRegistry().registerBuiltins();
    const names = registry.listAll().map((c) => c.name);
    for (const name of builtinNames()) {
      expect(names).toContain(name);
    }
    expect(names.length).toBe(builtinNames().length);
  });

  test("listAll 返回完整列表（含中国连接器）", () => {
    const registry = new ConnectorRegistry().registerBuiltins();
    const all = registry.listAll();
    expect(all.length).toBe(builtinNames().length);
    expect(all.some((c) => c.name === "cncb")).toBe(true);
    expect(all.some((c) => c.name === "wanfang")).toBe(true);
    expect(all.some((c) => c.name === "cnki")).toBe(true);
    const domains = new Set(all.map((c) => c.domain));
    expect(domains).toContain("genomics");
    expect(domains).toContain("literature");
    expect(domains).toContain("proteins");
    expect(domains).toContain("chemistry");
  });

  test("调用未知连接器抛出错误", async () => {
    const registry = new ConnectorRegistry().registerBuiltins();
    await expect(registry.call("not-a-connector", "search")).rejects.toThrow(/Unknown connector/);
  });

  test("调用未知工具抛出错误", async () => {
    const registry = new ConnectorRegistry().registerBuiltins();
    await expect(registry.call("uniprot", "not-a-tool")).rejects.toThrow(/Unknown tool/);
    await expect(registry.call("cnki", "getPaper")).rejects.toThrow(/Unknown tool/);
  });

  test("每个连接器的工具列表非空", () => {
    const registry = new ConnectorRegistry().registerBuiltins();
    for (const entry of registry.listAll()) {
      expect(entry.tools.length).toBeGreaterThan(0);
    }
  });

  test("registerCustom 注册自定义连接器", () => {
    const registry = new ConnectorRegistry();
    registry.registerCustom("my-db", {
      baseUrl: "https://example.com",
      description: "自定义数据库",
      tools: [{ name: "query", description: "查询", endpoint: "/query" }],
    });
    const names = registry.listAll().map((c) => c.name);
    expect(names).toContain("my-db");
    expect(registry.listTools("my-db").length).toBe(1);
  });
});
