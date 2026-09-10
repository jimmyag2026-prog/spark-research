import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PyDESeq2Platform } from "../../backend/src/simulation/pydeseq2";
import { resolvePython } from "../../backend/src/simulation/platform";
import { describeSimulationContract } from "../helpers/simulation_contract";

// W5-3 β · C3 三件套之二。契约部分与 pyref / openmm / scanpy 逐字节相同（AD-4）；
// 额外守两条：探测与真跑同一条路径（V27）、依赖缺失必须报安装命令。

const FIXTURES = resolve(import.meta.dir, "../fixtures/pydeseq2");
const COUNTS = join(FIXTURES, "counts.csv");
const METADATA = join(FIXTURES, "metadata.csv");

/** 见 scanpy_contract.test.ts 里同名函数的注释（Bun.spawn 不反映 process.env 的运行期修改）。 */
function pythonWithoutModule(moduleName: string): string {
  const dir = mkdtempSync(join(tmpdir(), `py-without-${moduleName}-`));
  writeFileSync(join(dir, `${moduleName}.py`), `raise ImportError("No module named '${moduleName}'")\n`);
  const wrapper = join(dir, "python");
  writeFileSync(wrapper, `#!/bin/sh\nPYTHONPATH="${dir}" exec "${resolvePython()}" "$@"\n`, { mode: 0o755 });
  return wrapper;
}

const probeRoot = mkdtempSync(join(tmpdir(), "pydeseq2-probe-"));
const status = await new PyDESeq2Platform({ root: probeRoot }).available();
if (!status.ok) {
  console.warn(`[W5-3 β 契约测试] pydeseq2 侧整套 skip：${status.reason}`);
}

describeSimulationContract({
  name: "pydeseq2",
  make: (root: string) => new PyDESeq2Platform({ root }),
  okSpec: {
    platform: "pydeseq2",
    kind: "bulk-de",
    params: {
      countsPath: COUNTS,
      metadataPath: METADATA,
      designFactor: "condition",
      testLevel: "treated",
      referenceLevel: "control",
    },
  },
  equivalentSpec: {
    platform: "pydeseq2",
    kind: "bulk-de",
    params: {
      independentFilter: true,
      referenceLevel: "control",
      alpha: 0.05,
      metadataPath: METADATA,
      cooksFilter: true,
      designFactor: "condition",
      fitType: "parametric",
      countsPath: COUNTS,
      refitCooks: true,
      minTotalCount: 10,
      testLevel: "treated",
    },
  },
  differentSpec: {
    platform: "pydeseq2",
    kind: "bulk-de",
    params: {
      countsPath: COUNTS,
      metadataPath: METADATA,
      designFactor: "condition",
      testLevel: "treated",
      referenceLevel: "control",
      alpha: 0.01,
    },
  },
  // 不做低表达过滤 → 全部 300 个基因都要拟合 dispersion，比 okSpec 慢一截。
  slowSpec: {
    platform: "pydeseq2",
    kind: "bulk-de",
    params: {
      countsPath: COUNTS,
      metadataPath: METADATA,
      designFactor: "condition",
      testLevel: "treated",
      referenceLevel: "control",
      minTotalCount: 0,
      fitType: "parametric",
    },
  },
  // 低表达过滤阈值给到天上 → 矩阵被滤空。DESeq2 用户最常撞的一条真实失败。
  failingSpec: {
    platform: "pydeseq2",
    kind: "bulk-de",
    params: {
      countsPath: COUNTS,
      metadataPath: METADATA,
      designFactor: "condition",
      testLevel: "treated",
      referenceLevel: "control",
      minTotalCount: 100_000,
    },
  },
  invalidSpec: {
    platform: "pydeseq2",
    kind: "bulk-de",
    params: { countsPath: COUNTS, metadataPath: METADATA, alpha: 5 },
  },
  expectedOutputs: ["results.csv", "size_factors.csv"],
  summaryKeys: ["samples", "genesTested", "significantGenes", "contrast", "pydeseq2Version"],
  runTimeoutMs: 180_000,
  skip: !status.ok,
  skipReason: status.reason ?? undefined,
});

describe("pydeseq2 · 探测与真跑指向同一条路径", () => {
  const platform = new PyDESeq2Platform({ root: mkdtempSync(join(tmpdir(), "pydeseq2-path-")) });
  const entryPoint = (platform as unknown as { entryPointFor: (k: string) => string }).entryPointFor(
    "bulk-de",
  );

  test("probeCode 里带的就是 entryPointFor 的绝对路径（不是另写一段内联 python）", () => {
    const code = (platform as unknown as { probeCode: () => string }).probeCode();
    expect(code).toContain(entryPoint);
    expect(entryPoint).not.toContain("/$bunfs");
    expect(code).toContain("spec_from_file_location");
    expect(code).toContain("exec_module");
  });

  test("entryPoint 不存在时 available() 必须报不可用", async () => {
    class MissingRunner extends PyDESeq2Platform {
      protected override entryPointFor(): string {
        return join(entryPoint, "..", "no-such-runner.py");
      }
    }
    const broken = new MissingRunner({ root: mkdtempSync(join(tmpdir(), "pydeseq2-broken-")) });
    const available = await broken.available();
    expect(available.ok).toBe(false);
    expect(available.reason).toContain("no-such-runner.py");
    const prepared = await broken.prepare({
      platform: "pydeseq2",
      kind: "bulk-de",
      params: { countsPath: COUNTS, metadataPath: METADATA },
    });
    await expect(broken.submit(prepared)).rejects.toThrow(/runner 脚本不存在/);
  });
});

describe("pydeseq2 · 依赖缺失时给出可操作的安装命令", () => {
  test("pydeseq2 装不上时 available() 报不可用，且 reason 里有 uv pip install", async () => {
    const platform = new PyDESeq2Platform({
      root: mkdtempSync(join(tmpdir(), "pydeseq2-missing-")),
      python: pythonWithoutModule("pydeseq2"),
    });
    const available = await platform.available();
    expect(available.ok).toBe(false);
    expect(available.reason).toContain("pydeseq2 不可用");
    // 同 scanpy_contract.test.ts：缺哪一环是环境属性，语义是「透出 python 原始报错」。
    expect(available.reason).toContain("No module named");
    expect(available.reason).toContain("uv pip install pydeseq2");
    expect(available.detail.exitCode).not.toBe(0);
  }, 120_000);
});

describe("pydeseq2 · prepare 阶段就把坏输入拒掉", () => {
  const platform = new PyDESeq2Platform({ root: mkdtempSync(join(tmpdir(), "pydeseq2-params-")) });

  test("countsPath / metadataPath 都是必填", async () => {
    await expect(platform.prepare({ platform: "pydeseq2", kind: "bulk-de", params: {} })).rejects.toThrow(
      /countsPath.*必填/,
    );
    await expect(
      platform.prepare({ platform: "pydeseq2", kind: "bulk-de", params: { countsPath: COUNTS } }),
    ).rejects.toThrow(/metadataPath.*必填/);
  });

  test("metadataPath 指向不存在的文件 → 当场拒", async () => {
    await expect(
      platform.prepare({
        platform: "pydeseq2",
        kind: "bulk-de",
        params: { countsPath: COUNTS, metadataPath: join(FIXTURES, "nope.csv") },
      }),
    ).rejects.toThrow(/文件不存在/);
  });

  test("过高的 minTotalCount 只警告不拒绝", async () => {
    const prepared = await platform.prepare({
      platform: "pydeseq2",
      kind: "bulk-de",
      params: { countsPath: COUNTS, metadataPath: METADATA, minTotalCount: 100_000 },
    });
    expect(prepared.warnings.join(" ")).toContain("minTotalCount");
  });

  test("合法参数不产生警告", async () => {
    const prepared = await platform.prepare({
      platform: "pydeseq2",
      kind: "bulk-de",
      params: { countsPath: COUNTS, metadataPath: METADATA, designFactor: "condition" },
    });
    expect(prepared.warnings).toEqual([]);
  });
});
