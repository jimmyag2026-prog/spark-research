import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// V118：openmm 探测与真提交同源——runner.py 暴露 probe()，TS 侧走 probeCodeFor（不再内联探测串）。
// 阴性对照（已验红）：删掉 runner.py 的 probe() → 第二条红（openmm 探测失败，P5 契约整套 skip 的形状）。
const REPO = join(import.meta.dir, "../..");

describe("V118 · openmm 探测同源", () => {
  test("openmm/index.ts 的 probeCode 走 probeCodeFor，且不再含内联 'import openmm' 探测串", () => {
    const src = readFileSync(join(REPO, "backend/src/simulation/openmm/index.ts"), "utf8");
    expect(src).toContain('probeCodeFor(this.entryPointFor(), "openmm"');
    expect(src).not.toContain('"    import openmm",');
  });

  test("runner.py 暴露 probe()，返回 openmm 版本与 platforms（有 openmm 才跑；没装则 skip 并说明）", async () => {
    const runner = readFileSync(join(REPO, "backend/src/simulation/openmm/runner.py"), "utf8");
    expect(runner).toContain("def probe() -> dict:");
    const { probeCodeFor } = await import("../../backend/src/simulation/probe");
    const code = probeCodeFor(join(REPO, "backend/src/simulation/openmm/runner.py"), "openmm", "uv pip install openmm");
    const python = join(REPO, ".venv/bin/python");
    const proc = Bun.spawnSync([python, "-c", code], { stdout: "pipe", stderr: "pipe" });
    const stderr = proc.stderr.toString();
    if (proc.exitCode !== 0 && /No module named 'openmm'/.test(stderr)) {
      console.log("[V118] .venv 没装 openmm，跳过真实探测");
      return;
    }
    expect(proc.exitCode).toBe(0);
    const detail = JSON.parse(proc.stdout.toString()) as { openmm: string; platforms: string };
    expect(detail.openmm).toMatch(/^\d+/);
    expect(detail.platforms.length).toBeGreaterThan(0);
  });
});
