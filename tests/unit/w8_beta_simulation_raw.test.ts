// v0.8 W8-1 β · V85：`exp run` 驱动的 SimulationPlatform（openmm/pyref/scanpy/pydeseq2/
// cobrapy 共用的 SubprocessSimulationPlatform 骨架）此前 prepare/submit/collect 全程不经
// KernelManager，raw 完全没记。本文件覆盖三件事：
//   1. 三阶段各落一行 raw/simulation（成链、脱敏、runId/specHash 串联三行）。
//   2. `root` 落在真实项目目录下时，不传 `raw` 选项也能自动推导到 `<project>/raw/`
//      并打上项目 slug（生产调用方 experiment/loop.ts 不在本 lane 足迹内，改不了它的
//      调用参数——所以 platform.ts 必须自己把这件事做对）。
//   3. export → import 往返：raw/simulation 链在导入侧 verify ok；--for-sharing 下
//      不被丢弃（用户自产仿真，与 kernel 同口径）。
//
// 用 pyref（零外部依赖、确定性、有解析解对照）跑真实子进程，不是 mock——这是 P5 契约
// 测试矩阵里本来就用于「快、稳」的参考实现（见 tests/helpers/simulation_contract.ts）。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PyRefPlatform } from "../../backend/src/simulation/pyref";
import { SubprocessSimulationPlatform, type NormalizedSpec } from "../../backend/src/simulation/platform";
import type { RunStatus, SimulationPlatform } from "../../backend/src/simulation/models";
import { JsonlRawSink, MemoryRawSink, type RawEntry } from "../../backend/src/raw";
import { ProjectManager } from "../../backend/src/project/manager";
import { exportProject } from "../../backend/src/data/export";
import { importExport } from "../../backend/src/data/import";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function waitTerminal(platform: SimulationPlatform, runId: string, timeoutMs = 30_000): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await platform.poll(runId);
    if (status.state === "completed" || status.state === "failed") return status;
    if (Date.now() > deadline) throw new Error(`等待 run ${runId} 终结超时`);
    await Bun.sleep(50);
  }
}

function simEntries(sink: MemoryRawSink | JsonlRawSink): RawEntry[] {
  return [...sink.iterate({ kind: "simulation" })];
}

// 测试专用最小实现：五个真实 adapter（pyref/openmm/scanpy/pydeseq2/cobrapy）的
// normalize() 全部把参数收窄到固定的白名单键（数字/枚举），没有一个会产出名字像
// "apiKey"/"token" 这样的敏感键——脱敏这条防线在它们身上天然测不出来（不代表没用：
// 防的是未来第六个 adapter 或第三方社区替换点直接透传用户参数）。这个echo实现只
// 覆盖 prepare()（不 spawn 真实子进程，entryPointFor/probeCode 不会被 prepare() 调用），
// 用来单独验证 appendRaw() 里的 redact() 确实生效。
class EchoPlatform extends SubprocessSimulationPlatform {
  readonly id = "echo-test";
  readonly deterministic = true;
  readonly description = "test-only echo platform（只用于验证 raw 层 redact()）";
  readonly kinds = ["echo"] as const;
  protected normalize(_kind: string, params: Record<string, unknown>): NormalizedSpec {
    return { params, expectedOutputs: [] };
  }
  protected entryPointFor(): string {
    return "/nonexistent/entry.py";
  }
  protected probeCode(): string {
    return "print('unused')";
  }
}

describe("V85 · SubprocessSimulationPlatform 的 prepare/submit/collect 落 raw/simulation", () => {
  test("appendRaw 对 params 做脱敏（SENSITIVE_KEY 命中的键整值替换）", async () => {
    const sink = new MemoryRawSink({ project: "beta-test" });
    const platform = new EchoPlatform({
      root: tmpDir("sim-raw-redact-"),
      raw: { sink, project: "beta-test" },
    });
    await platform.prepare({
      platform: "echo-test",
      kind: "echo",
      params: { steps: 50, apiKey: "sk-should-be-redacted-1234567890" },
    });
    const entries = simEntries(sink);
    expect(entries.length).toBe(1);
    expect(JSON.stringify(entries)).not.toContain("sk-should-be-redacted");
    expect((entries[0]!.payload as { params: Record<string, unknown> }).params.apiKey).toBe("<redacted>");
    expect((entries[0]!.payload as { params: Record<string, unknown> }).params.steps).toBe(50);
  });

  test("显式注入 sink：三阶段各落一行、成链、runId/specHash 串联", async () => {
    const sink = new MemoryRawSink({ project: "beta-test" });
    const platform = new PyRefPlatform({
      root: tmpDir("sim-raw-mem-"),
      raw: { sink, project: "beta-test", sessionId: "s1", command: "exp-run" },
    });
    const prepared = await platform.prepare({
      platform: "pyref",
      kind: "damped-oscillator",
      params: { steps: 50 },
    });
    const runId = await platform.submit(prepared);
    const status = await waitTerminal(platform, runId);
    expect(status.state).toBe("completed");
    await platform.collect(runId);

    const entries = simEntries(sink);
    expect(entries.length).toBe(3);
    expect(entries.map((e) => (e.payload as { stage: string }).stage)).toEqual(["prepare", "submit", "collect"]);
    expect(entries.every((e) => e.sessionId === "s1" && e.command === "exp-run" && e.project === "beta-test")).toBe(
      true,
    );
    // runId：prepare 阶段还没有（null），submit/collect 阶段一致。
    expect((entries[0]!.payload as { runId: string | null }).runId).toBeNull();
    expect((entries[1]!.payload as { runId: string | null }).runId).toBe(runId);
    expect((entries[2]!.payload as { runId: string | null }).runId).toBe(runId);
    // specHash 三行一致，串起同一次仿真的生命周期。
    const specHashes = entries.map((e) => (e.payload as { specHash: string | null }).specHash);
    expect(specHashes).toEqual([prepared.specHash, prepared.specHash, prepared.specHash]);
    // collect 行带摘要与产出清单（不含绝对路径）。
    const collectPayload = entries[2]!.payload as { summary: { inline: string } | null; files: Array<{ filename: string; role: string; bytes: number }> | null };
    expect(collectPayload.summary).not.toBeNull();
    expect(JSON.parse(collectPayload.summary!.inline)).toHaveProperty("steps", 50);
    expect(collectPayload.files!.length).toBeGreaterThan(0);
    expect(collectPayload.files!.every((f) => !("path" in f))).toBe(true);

    // 链校验：篡改任一行必须 brokenAt；未篡改必须 ok。
    const ok = sink.verify("simulation");
    expect(ok.ok).toBe(true);
    expect(ok.lines).toBe(3);
  });

  test("root 落在真实项目目录下时，不传 raw 选项也自动推导到 <project>/raw/ 并打上项目 slug", async () => {
    const workspaceRoot = tmpDir("sim-raw-proj-");
    const manager = new ProjectManager(workspaceRoot);
    const project = manager.create("sim-beta", { name: "sim beta" });
    const platformRoot = join(project.paths.experimentsDir, "pyref");
    const platform = new PyRefPlatform({ root: platformRoot }); // 刻意不传 raw

    const prepared = await platform.prepare({ platform: "pyref", kind: "damped-oscillator", params: { steps: 30 } });
    const runId = await platform.submit(prepared);
    await waitTerminal(platform, runId);
    await platform.collect(runId);

    expect(existsSync(join(project.paths.rawDir, "simulation"))).toBe(true);
    const projSink = project.raw() as JsonlRawSink;
    const entries = simEntries(projSink);
    expect(entries.length).toBe(3);
    expect(entries.every((e) => e.project === "sim-beta")).toBe(true);
    expect(projSink.verify("simulation").ok).toBe(true);
  });

  test("非项目根（没有 project.json）时退回全局兜底 sink，不乱写目录", async () => {
    const { globalRawRoot } = await import("../../backend/src/raw");
    const bareRoot = tmpDir("sim-raw-bare-"); // 没有 project.json，形状也不是 <root>/experiments/<id>
    const platform = new PyRefPlatform({ root: join(bareRoot, "experiments", "pyref") });
    const prepared = await platform.prepare({ platform: "pyref", kind: "damped-oscillator", params: { steps: 20 } });
    // prepare 阶段就应该已经落了一行到全局兜底（globalRawRoot），不是项目目录。
    const globalSink = new JsonlRawSink(globalRawRoot());
    const entries = simEntries(globalSink).filter((e) => (e.payload as { specHash: string }).specHash === prepared.specHash);
    expect(entries.length).toBe(1);
    expect(entries[0]!.project).toBeNull();
  });

  test("export → import 往返：raw/simulation 链导入侧 verify ok；--for-sharing 不丢弃（用户自产可共享）", async () => {
    const workspaceRoot = tmpDir("sim-raw-exp-");
    const manager = new ProjectManager(workspaceRoot);
    const project = manager.create("sim-export", { name: "sim export" });
    const platformRoot = join(project.paths.experimentsDir, "pyref");
    const platform = new PyRefPlatform({ root: platformRoot });
    const prepared = await platform.prepare({ platform: "pyref", kind: "damped-oscillator", params: { steps: 30 } });
    const runId = await platform.submit(prepared);
    await waitTerminal(platform, runId);
    await platform.collect(runId);

    const result = exportProject(project, { forSharing: true });
    expect(result.manifest.schemas.raw.tables.simulation).toBe(3);
    expect(result.manifest.excluded.rawDropped).toBe(0);

    const manager2 = new ProjectManager(workspaceRoot);
    const imported = importExport(manager2, result.dir, "sim-export-copy");
    expect(imported.verified).toBe(true);
    expect(imported.verification.raw.simulation?.ok).toBe(true);
    expect(imported.verification.raw.simulation?.lines).toBe(3);
    expect(imported.counts.raw).toBe(3);
  });
});
