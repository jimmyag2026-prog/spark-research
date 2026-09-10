import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXP_HELP, runExpCommand } from "../../backend/src/experiment/cli";
import { ProjectManager } from "../../backend/src/project/manager";
import { SIMULATION_PLATFORM_IDS } from "../../backend/src/simulation/registry";

// P5 CLI 单测（风格同 project/cli、ideation/cli）：注入 out/err + 返回退出码，不打真实网络。
// 仿真走 pyref（零依赖、秒级），所以这些用例是真跑，不是打桩。

function cli() {
  const root = mkdtempSync(join(tmpdir(), "exp-cli-"));
  const manager = new ProjectManager(root);
  manager.create("cli-proj");
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[]) =>
    runExpCommand(args, { manager, out: (l) => out.push(l), err: (l) => err.push(l), pollIntervalMs: 50 });
  return { manager, run, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

const FAST = ["--param", "steps=200", "--param", "sampleInterval=20"];

describe("exp CLI · new", () => {
  test("new 建实验并给出下一步", async () => {
    const c = cli();
    expect(await c.run(["new", "阻尼振子基线", ...FAST, "--hypothesis", "能量单调衰减"])).toBe(0);
    expect(c.text()).toContain("✅ 实验已建档");
    expect(c.text()).toContain("阻尼振子基线");
    expect(c.text()).toContain("design · pyref/damped-oscillator");
    expect(c.text()).toContain("spark-research exp run");
  });

  test("new --json 输出结构化视图（不含 record 本体）", async () => {
    const c = cli();
    expect(await c.run(["new", "J", ...FAST, "--json"])).toBe(0);
    const view = JSON.parse(c.text());
    expect(view.state).toBe("design");
    expect(view.platform).toBe("pyref");
    expect(view.simKind).toBe("damped-oscillator");
    expect(view.params.steps).toBe(200);
    expect(view.record).toBeUndefined();
  });

  test("new 缺标题 → 退出码 1 + 用法", async () => {
    const c = cli();
    expect(await c.run(["new"])).toBe(1);
    expect(c.errText()).toContain("用法");
  });

  test("--param 必须是 k=v", async () => {
    const c = cli();
    expect(await c.run(["new", "X", "--param", "steps"])).toBe(1);
    expect(c.errText()).toContain("k=v");
    expect(await c.run(["new", "X", "--param"])).toBe(1);
  });

  test("非法参数值在 new 阶段就被拒（不建半成品）", async () => {
    const c = cli();
    expect(await c.run(["new", "X", "--param", "steps=-5"])).toBe(1);
    expect(c.errText()).toContain("steps");
    expect(await c.run(["list", "--json"])).toBe(0);
    expect(JSON.parse(c.text().split("\n").slice(-1)[0] || "[]")).toEqual([]);
  });

  test("未知平台报错并列出可用平台", async () => {
    const c = cli();
    expect(await c.run(["new", "X", "--platform", "vasp"])).toBe(1);
    expect(c.errText()).toContain("未知仿真平台");
    expect(c.errText()).toContain("pyref");
  });

  test("--platform openmm 时默认 kind 自动取该平台第一个种类", async () => {
    const c = cli();
    expect(await c.run(["new", "水盒子", "--platform", "openmm", "--json"])).toBe(0);
    const view = JSON.parse(c.text());
    expect(view.platform).toBe("openmm");
    expect(view.simKind).toBe("water-box-md");
    // design 不跑仿真，所以即使本机没有 openmm 也能建档（真正的可用性检查在 dryRun）。
    expect(view.state).toBe("design");
  });
});

describe("exp CLI · run / status / list", () => {
  test("run 把闭环推到 analyze 并打印摘要", async () => {
    const c = cli();
    await c.run(["new", "R", ...FAST, "--json"]);
    const id = JSON.parse(c.text()).id as string;
    c.out.length = 0;

    expect(await c.run(["run", id.slice(0, 8), "--note", "欠阻尼"])).toBe(0);
    expect(c.text()).toContain("analyze");
    expect(c.text()).toContain("摘要：");
    expect(c.text()).toContain("maxAbsErrorVsAnalytic");
    expect(c.text()).toContain("observation:");
  }, 60_000);

  test("run --conclude 顺手落结论卡（review pending）", async () => {
    const c = cli();
    await c.run(["new", "C", ...FAST, "--json"]);
    const id = JSON.parse(c.text()).id as string;
    c.out.length = 0;
    expect(await c.run(["run", id, "--conclude", "数值解与解析解一致"])).toBe(0);
    expect(c.text()).toContain("conclusion:");
    expect(c.text()).toContain("review pending");
  }, 60_000);

  test("run --resume 在无事可恢复时是 no-op，然后照常推进", async () => {
    const c = cli();
    await c.run(["new", "RS", ...FAST, "--json"]);
    const id = JSON.parse(c.text()).id as string;
    c.out.length = 0;
    expect(await c.run(["run", id, "--resume", "--json"])).toBe(0);
    expect(c.text()).toContain("无需恢复");
    expect(JSON.parse(c.text().split("\n").slice(1).join("\n")).state).toBe("analyze");
  }, 60_000);

  test("仿真失败 → run 退出码 1，状态落 failed", async () => {
    const c = cli();
    // dt=5 远大于固有周期 → RK4 发散。
    await c.run(["new", "F", "--param", "dt=5", "--param", "steps=200", "--json"]);
    const id = JSON.parse(c.text()).id as string;
    c.out.length = 0;
    expect(await c.run(["run", id])).toBe(1);
    expect(c.errText()).toContain("发散");
    c.out.length = 0;
    expect(await c.run(["list", "--state", "failed", "--json"])).toBe(0);
    expect(JSON.parse(c.text()).length).toBe(1);
  }, 60_000);

  test("status 打实验正文与当前 run 状态", async () => {
    const c = cli();
    await c.run(["new", "S", ...FAST, "--json"]);
    const id = JSON.parse(c.text()).id as string;
    await c.run(["run", id]);
    c.out.length = 0;
    expect(await c.run(["status", id.slice(0, 8)])).toBe(0);
    expect(c.text()).toContain("# 实验 · S");
    expect(c.text()).toContain("状态：**analyze**");
    expect(c.text()).toContain("## 状态轨迹");
    expect(c.text()).toContain("当前 run 状态：completed");
  }, 60_000);

  test("status --json 带 runStatus", async () => {
    const c = cli();
    await c.run(["new", "SJ", ...FAST, "--json"]);
    const id = JSON.parse(c.text()).id as string;
    await c.run(["run", id]);
    c.out.length = 0;
    expect(await c.run(["status", id, "--json"])).toBe(0);
    const payload = JSON.parse(c.text());
    expect(payload.runStatus.state).toBe("completed");
    expect(payload.summary.steps).toBe(200);
  }, 60_000);

  test("list 空项目给出上手提示；--state 非法值报错", async () => {
    const c = cli();
    expect(await c.run(["list"])).toBe(0);
    expect(c.text()).toContain("还没有实验");
    expect(await c.run(["list", "--state", "running"])).toBe(1);
    expect(c.errText()).toContain("未知状态");
  });

  test("list 按状态与平台过滤", async () => {
    const c = cli();
    await c.run(["new", "A", ...FAST, "--json"]);
    const id = JSON.parse(c.text()).id as string;
    await c.run(["new", "B", ...FAST, "--param", "damping=0.7"]);
    await c.run(["run", id]);
    c.out.length = 0;
    expect(await c.run(["list", "--state", "design", "--json"])).toBe(0);
    expect(JSON.parse(c.text()).map((v: { title: string }) => v.title)).toEqual(["B"]);
    c.out.length = 0;
    expect(await c.run(["list", "--platform", "openmm", "--json"])).toBe(0);
    expect(JSON.parse(c.text())).toEqual([]);
  }, 60_000);

  test("run / status 缺 id 或 id 不存在", async () => {
    const c = cli();
    expect(await c.run(["run"])).toBe(1);
    expect(await c.run(["status"])).toBe(1);
    expect(await c.run(["status", "deadbeef"])).toBe(1);
    expect(c.errText()).toContain("找不到 experiment record");
  });
});

describe("exp CLI · platforms 与帮助", () => {
  test("platforms 列出全部平台与可用性", async () => {
    const c = cli();
    const code = await c.run(["platforms", "--json"]);
    const list = JSON.parse(c.text()) as { id: string; ok: boolean; reason: string | null }[];
    // W5-3 β：C3 三件套（scanpy / pydeseq2 / cobrapy）进注册表后这里跟着长。
    expect(list.map((p) => p.id)).toEqual([...SIMULATION_PLATFORM_IDS]);
    // pyref 必然可用（零依赖）；openmm 视本机环境而定，不可用时必须给出可操作的原因。
    expect(list.find((p) => p.id === "pyref")!.ok).toBe(true);
    const openmm = list.find((p) => p.id === "openmm")!;
    if (!openmm.ok) expect(openmm.reason).toContain("openmm");
    expect(code).toBe(0);
  }, 60_000);

  test("help / 无子命令 / 未知子命令", async () => {
    const c = cli();
    expect(await c.run(["help"])).toBe(0);
    expect(c.text()).toBe(EXP_HELP);
    expect(await c.run([])).toBe(1);
    expect(await c.run(["frobnicate"])).toBe(1);
    expect(c.errText()).toContain("未知的 exp 子命令");
  });
});
