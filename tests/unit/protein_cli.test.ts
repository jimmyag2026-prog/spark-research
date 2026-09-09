import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProteinCommand } from "../../backend/src/proteins/cli";
import { ProjectManager } from "../../backend/src/project/manager";
import { PROTEIN_ACCESSION, PROTEIN_QUERY, proteinRegistry } from "../helpers/protein_scenario";
import type { ConnectorRegistry } from "../../backend/src/connectors/registry";

// R-d-2（v0.4 P11 lane R-d）：`spark-research protein <query>` 的 CLI 单测。
//
// protein-analysis 技能在 D-12 门禁的可达性核实里被发现是 CLI / HTTP / MCP 三个入口
// 全无的唯一技能（BACKLOG V22）。这个文件验的是补上的 CLI 入口：风格与
// experiment_cli.test.ts / ideation_cli.test.ts 一致——注入 out/err + 返回退出码，
// registry 用 fixture 回放（零网络），复用 protein_e2e.test.ts 的同一份 helper。

function cli() {
  const root = mkdtempSync(join(tmpdir(), "protein-cli-"));
  const manager = new ProjectManager(root);
  manager.create("cli-proj");
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[]) =>
    runProteinCommand(args, {
      manager,
      registry: proteinRegistry("replay"),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return { manager, run, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

describe("protein CLI", () => {
  test("无 query 时打印用法并返回非零", async () => {
    const c = cli();
    expect(await c.run([])).toBe(1);
    expect(c.errText()).toContain("用法");
  });

  test("查询成功：正文报告 + observation record id", async () => {
    const c = cli();
    expect(await c.run([PROTEIN_QUERY])).toBe(0);
    expect(c.text()).toContain(PROTEIN_ACCESSION);
    expect(c.text()).toContain("AlphaFold");
    expect(c.text()).toContain("observation:");
  });

  test("--json 输出结构化结果（含 recordId），--no-persist 时 recordId 为 null", async () => {
    const c = cli();
    expect(await c.run([PROTEIN_QUERY, "--json"])).toBe(0);
    const result = JSON.parse(c.text());
    expect(result.identity.accession).toBe(PROTEIN_ACCESSION);
    expect(result.experimentalStructureCount).toBe(350);
    expect(typeof result.recordId).toBe("string");

    const c2 = cli();
    expect(await c2.run([PROTEIN_QUERY, "--json", "--no-persist"])).toBe(0);
    const result2 = JSON.parse(c2.text());
    expect(result2.recordId).toBeNull();
  });

  test("UniProt 没有唯一匹配时报错并返回非零（不是静默失败）", async () => {
    // 用一个直接返回空结果的假 registry，触发 ProteinAnalysis.identify() 的
    // 「没有匹配条目」分支——不依赖 fixture 里录了什么，判据落在 CLI 的错误处理本身。
    const emptyRegistry = { call: async () => ({ results: [] }) } as unknown as ConnectorRegistry;
    const c = cli();
    expect(
      await runProteinCommand(["query matches nothing"], {
        manager: c.manager,
        registry: emptyRegistry,
        out: (l) => c.out.push(l),
        err: (l) => c.err.push(l),
      }),
    ).toBe(1);
    expect(c.errText()).toContain("❌");
    expect(c.errText()).toContain("没有匹配");
  });
});
