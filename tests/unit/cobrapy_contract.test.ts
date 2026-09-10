import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CobraPyPlatform } from "../../backend/src/simulation/cobrapy";
import { resolvePython } from "../../backend/src/simulation/platform";
import { describeSimulationContract } from "../helpers/simulation_contract";

// W5-3 β · C3 三件套之三。契约部分与 pyref / openmm / scanpy / pydeseq2 逐字节相同（AD-4）。

const FIXTURES = resolve(import.meta.dir, "../fixtures/cobrapy");
const MODEL = join(FIXTURES, "e_coli_core.xml");

/** 见 scanpy_contract.test.ts 里同名函数的注释（Bun.spawn 不反映 process.env 的运行期修改）。 */
function pythonWithoutModule(moduleName: string): string {
  const dir = mkdtempSync(join(tmpdir(), `py-without-${moduleName}-`));
  writeFileSync(join(dir, `${moduleName}.py`), `raise ImportError("No module named '${moduleName}'")\n`);
  const wrapper = join(dir, "python");
  writeFileSync(wrapper, `#!/bin/sh\nPYTHONPATH="${dir}" exec "${resolvePython()}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

const probeRoot = mkdtempSync(join(tmpdir(), "cobrapy-probe-"));
const status = await new CobraPyPlatform({ root: probeRoot }).available();
if (!status.ok) {
  console.warn(`[W5-3 β 契约测试] cobrapy 侧整套 skip：${status.reason}`);
}

describeSimulationContract({
  name: "cobrapy",
  make: (root: string) => new CobraPyPlatform({ root }),
  okSpec: { platform: "cobrapy", kind: "fba", params: { modelPath: MODEL } },
  equivalentSpec: {
    platform: "cobrapy",
    kind: "fba",
    params: {
      fvaFraction: 0.9,
      medium: "model-default",
      modelPath: MODEL,
      parsimonious: true,
      objective: "",
      fluxVariability: false,
      knockouts: "",
    },
  },
  differentSpec: { platform: "cobrapy", kind: "fba", params: { modelPath: MODEL, medium: "anaerobic" } },
  // FVA 要为每个反应各解两个 LP（95 × 2），比单次 FBA 慢一大截。
  slowSpec: {
    platform: "cobrapy",
    kind: "fba",
    params: { modelPath: MODEL, fluxVariability: true, fvaFraction: 1 },
  },
  // 目标函数指向一个模型里没有的反应 id —— cobrapy 用户改目标时最常撞的一条。
  failingSpec: {
    platform: "cobrapy",
    kind: "fba",
    params: { modelPath: MODEL, objective: "NOT_A_REACTION" },
  },
  invalidSpec: { platform: "cobrapy", kind: "fba", params: { modelPath: MODEL, medium: "martian" } },
  expectedOutputs: ["fluxes.csv", "solution.json"],
  summaryKeys: ["reactions", "metabolites", "genes", "objectiveValue", "status", "cobraVersion"],
  runTimeoutMs: 180_000,
  skip: !status.ok,
  skipReason: status.reason ?? undefined,
});

describe("cobrapy · 探测与真跑指向同一条路径", () => {
  const platform = new CobraPyPlatform({ root: mkdtempSync(join(tmpdir(), "cobrapy-path-")) });
  const entryPoint = (platform as unknown as { entryPointFor: (k: string) => string }).entryPointFor("fba");

  test("probeCode 里带的就是 entryPointFor 的绝对路径（不是另写一段内联 python）", () => {
    const code = (platform as unknown as { probeCode: () => string }).probeCode();
    expect(code).toContain(entryPoint);
    expect(entryPoint).not.toContain("/$bunfs");
    expect(code).toContain("spec_from_file_location");
    expect(code).toContain("exec_module");
  });

  test("entryPoint 不存在时 available() 必须报不可用", async () => {
    class MissingRunner extends CobraPyPlatform {
      protected override entryPointFor(): string {
        return join(entryPoint, "..", "no-such-runner.py");
      }
    }
    const broken = new MissingRunner({ root: mkdtempSync(join(tmpdir(), "cobrapy-broken-")) });
    const available = await broken.available();
    expect(available.ok).toBe(false);
    expect(available.reason).toContain("no-such-runner.py");
    const prepared = await broken.prepare({ platform: "cobrapy", kind: "fba", params: { modelPath: MODEL } });
    await expect(broken.submit(prepared)).rejects.toThrow(/runner 脚本不存在/);
  });

  test("探测出来的 detail 带上求解器清单（import cobra 成功 ≠ 有 LP 求解器）", async () => {
    if (!status.ok) return;
    expect(String(status.detail.solvers ?? "")).toContain("glpk");
    expect(status.detail.runner).toBe(entryPoint);
  });
});

describe("cobrapy · 依赖缺失时给出可操作的安装命令", () => {
  test("cobra 装不上时 available() 报不可用，且 reason 里有 uv pip install", async () => {
    const platform = new CobraPyPlatform({
      root: mkdtempSync(join(tmpdir(), "cobrapy-missing-")),
      python: pythonWithoutModule("cobra"),
    });
    const available = await platform.available();
    expect(available.ok).toBe(false);
    expect(available.reason).toContain("cobrapy 不可用");
    expect(available.reason).toContain("No module named 'cobra'");
    expect(available.reason).toContain("uv pip install cobra");
    expect(available.detail.exitCode).not.toBe(0);
  }, 120_000);
});

describe("cobrapy · prepare 阶段就把坏输入拒掉", () => {
  const platform = new CobraPyPlatform({ root: mkdtempSync(join(tmpdir(), "cobrapy-params-")) });

  test("modelPath 必填、且必须是认识的模型格式", async () => {
    await expect(platform.prepare({ platform: "cobrapy", kind: "fba", params: {} })).rejects.toThrow(
      /modelPath.*必填/,
    );
    await expect(
      platform.prepare({
        platform: "cobrapy",
        kind: "fba",
        params: { modelPath: join(FIXTURES, "generate.txt") },
      }),
    ).rejects.toThrow(/扩展名/);
  });

  test("反应 / 基因 id 里的 shell 元字符当场拒（不带进 runner）", async () => {
    await expect(
      platform.prepare({
        platform: "cobrapy",
        kind: "fba",
        params: { modelPath: MODEL, knockouts: "b0008; rm -rf /" },
      }),
    ).rejects.toThrow(/不是合法的 id/);
  });

  test("knockouts 去重 + 排序：'b0008,b0114' 与 'b0114,b0008,b0114' 是同一个算例", async () => {
    const a = await platform.prepare({
      platform: "cobrapy",
      kind: "fba",
      params: { modelPath: MODEL, knockouts: "b0008,b0114" },
    });
    const b = await platform.prepare({
      platform: "cobrapy",
      kind: "fba",
      params: { modelPath: MODEL, knockouts: "b0114,b0008,b0114" },
    });
    expect(b.specHash).toBe(a.specHash);
    expect(a.params.knockouts).toBe("b0008,b0114");
  });

  test("覆盖目标函数 / 敲除基因只警告不拒绝（prepare 刻意不读模型文件）", async () => {
    const prepared = await platform.prepare({
      platform: "cobrapy",
      kind: "fba",
      params: { modelPath: MODEL, objective: "NOT_A_REACTION", knockouts: "b9999" },
    });
    expect(prepared.warnings.length).toBe(2);
    expect(prepared.warnings.join(" ")).toContain("objective");
    expect(prepared.warnings.join(" ")).toContain("knockouts");
  });

  test("合法参数不产生警告", async () => {
    const prepared = await platform.prepare({
      platform: "cobrapy",
      kind: "fba",
      params: { modelPath: MODEL, medium: "anaerobic" },
    });
    expect(prepared.warnings).toEqual([]);
  });
});
