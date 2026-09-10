import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChemCommand } from "../../backend/src/chem/cli";
import { ProjectManager } from "../../backend/src/project/manager";

// C5-②（v0.5 W5-1-c）：`spark-research chem depict <SMILES>` 的 CLI 单测。
//
// 这条测试验的是 **CLI handler 本身**，不经过 `backend/src/index.ts` 的 `case "chem"`——
// 那一行由 lane η 的收口接（本 lane 的文件所有权不含 index.ts，见 devlog 的「收口接线
// 清单」）。`runChemCommand` 可以在完全不改 index.ts 的前提下被直接调用与验证，
// 所以「CLI 永远接不进去」这个风险不会发生在 handler 这一层——只发生在
// 「没人从 index.ts 调它」这一层，那一层的缺口已经在 devlog 里写清楚了。

function cli() {
  const root = mkdtempSync(join(tmpdir(), "chem-cli-"));
  const manager = new ProjectManager(root);
  manager.create("cli-proj");
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[]) => runChemCommand(args, { manager, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { manager, run, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

describe("chem CLI", () => {
  test("无子命令 / 未知子命令：打印用法并返回非零", async () => {
    const c = cli();
    expect(await c.run([])).toBe(1);
    expect(c.errText()).toContain("用法");

    const c2 = cli();
    expect(await c2.run(["frobnicate"])).toBe(1);
    expect(c2.errText()).toContain("用法");
  });

  test("depict 缺 SMILES：打印用法并返回非零", async () => {
    const c = cli();
    expect(await c.run(["depict"])).toBe(1);
    expect(c.errText()).toContain("用法");
  });

  test("depict 成功：正文报告 + artifact/record id", async () => {
    const c = cli();
    expect(await c.run(["depict", "CCO", "--name", "ethanol"])).toBe(0);
    expect(c.text()).toContain("CCO");
    expect(c.text()).toContain("artifact:");
    expect(c.text()).toContain("record:");
  });

  test("--json 输出结构化结果", async () => {
    const c = cli();
    expect(await c.run(["depict", "CCO", "--json"])).toBe(0);
    const result = JSON.parse(c.text());
    expect(result.canonicalSmiles).toBe("CCO");
    expect(result.formula).toBe("C2H6O");
    expect(typeof result.artifactId).toBe("string");
    expect(typeof result.recordId).toBe("string");
  });

  test("非法 SMILES：❌ + kind，返回非零，不吞掉 depict.py 的诊断", async () => {
    const c = cli();
    expect(await c.run(["depict", "not a smiles((("])).toBe(1);
    expect(c.errText()).toContain("❌");
    expect(c.errText()).toContain("invalid_smiles");
  });
});
