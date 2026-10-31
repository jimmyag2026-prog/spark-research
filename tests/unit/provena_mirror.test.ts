import { describe, expect, test } from "bun:test";
import { ProvenaMirror } from "../../backend/src/extensions/provena_mirror";
import type { ExternalMcpAttachment } from "../../backend/src/extensions/mcp_client";
import type { ToolAuditEntry } from "../../backend/src/agents/toolbus";

function attachment(withProvena: boolean, calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const registry = {
    get: (name: string) => (withProvena && name === "provena" ? ({} as object) : undefined),
    call: async (name: string, args: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 5));
      calls.push({ name, args });
      return { ok: true, payload: {} };
    },
  };
  return { registry, connected: [], failed: [], skipped: [], async close() {} } as unknown as ExternalMcpAttachment;
}

const entry = (tool: string, ok = true, denied?: string): ToolAuditEntry =>
  ({ tool, argsSummary: "{\"q\":\"x\"}", ok, durationMs: 3, resultSize: 10, timestamp: 1, ...(denied ? { denied } : {}) }) as ToolAuditEntry;

describe("ProvenaMirror：子代理的每次工具调用自动记进 Provena", () => {
  test("记普通工具（含失败）；不记 provena 自己的工具、不记被拒绝的调用；flush 等全部落完", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mirror = new ProvenaMirror(attachment(true, calls));
    mirror.sink(entry("lit_search"));
    mirror.sink(entry("pubmed.esearch", false));
    mirror.sink(entry("mcp:provena:record_step"));
    mirror.sink(entry("lit_search", true, "not_granted"));
    const done = await mirror.flush();
    expect(done).toEqual({ recorded: 2, failed: 0 });
    expect(calls.map((c) => c.name)).toEqual(["mcp:provena:record_step", "mcp:provena:record_step"]);
    expect(calls[0]!.args.tool).toBe("lit_search");
    expect(calls[1]!.args.exit_code).toBe(1);
  });

  test("编排层任务（skill 等不经 ToolBus 的路径）同样记一步", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mirror = new ProvenaMirror(attachment(true, calls));
    mirror.recordTask({ id: "t1", kind: "skill", description: "文献检索", params: { skill: "literature-search" } },
      { ok: true, output: "26 hits" });
    mirror.recordTask({ id: "t2", kind: "code", description: "fit" }, { ok: false, output: "Traceback" });
    expect(await mirror.flush()).toEqual({ recorded: 2, failed: 0 });
    expect(calls[0]!.args.tool).toBe("spark:skill:literature-search");
    expect(calls[1]!.args.exit_code).toBe(1);
    expect(calls[1]!.args.error).toBe("Traceback");
  });

  test("没装 provena 扩展：空操作", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mirror = new ProvenaMirror(attachment(false, calls));
    mirror.sink(entry("lit_search"));
    expect(await mirror.flush()).toEqual({ recorded: 0, failed: 0 });
    expect(calls).toEqual([]);
  });
});
