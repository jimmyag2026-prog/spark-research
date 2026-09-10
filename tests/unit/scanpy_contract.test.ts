import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScanpyPlatform } from "../../backend/src/simulation/scanpy";
import { resolvePython } from "../../backend/src/simulation/platform";
import { describeSimulationContract } from "../helpers/simulation_contract";

/**
 * 造一个「这台机器没装 <module>」的 python：一层 shell 包装，把一个会抛 ImportError 的
 * 同名模块用 PYTHONPATH 顶到 site-packages 前面，再 exec 真解释器。
 *
 * 为什么不直接改 `process.env.PYTHONPATH`：实测 Bun.spawn **不反映**运行期对 process.env
 * 的修改（子进程里 `os.environ.get('PYTHONPATH')` 是 None）。
 * 为什么不直接用 `/usr/bin/python3`：那是在赌宿主机的系统解释器长什么样，不同 CI 不一样。
 */
function pythonWithoutModule(moduleName: string): string {
  const dir = mkdtempSync(join(tmpdir(), `py-without-${moduleName}-`));
  writeFileSync(
    join(dir, `${moduleName}.py`),
    `raise ImportError("No module named '${moduleName}'")\n`,
  );
  const wrapper = join(dir, "python");
  writeFileSync(
    wrapper,
    `#!/bin/sh\nPYTHONPATH="${dir}" exec "${resolvePython()}" "$@"\n`,
    { mode: 0o755 },
  );
  return wrapper;
}

// W5-3 β · C3 三件套之一。**同一组契约测试**（tests/helpers/simulation_contract.ts）
// 参数化跑在 scanpy 上，与 pyref / openmm 逐字节相同的断言——AD-4 的验收方式。
//
// 本文件在契约之外多守两条 scanpy（以及另外两个组学平台）特有的东西：
//   ① 探测与真跑必须是同一条路径（V27 的形状：探测报可用、submit 才 ENOENT）；
//   ② 依赖缺失时必须报「未安装」并给出安装命令，不许静默降级。

const FIXTURES = resolve(import.meta.dir, "../fixtures/scanpy");
const COUNTS = join(FIXTURES, "counts.csv");

const scanpyProbeRoot = mkdtempSync(join(tmpdir(), "scanpy-probe-"));
const scanpyStatus = await new ScanpyPlatform({ root: scanpyProbeRoot }).available();
if (!scanpyStatus.ok) {
  console.warn(`[W5-3 β 契约测试] scanpy 侧整套 skip：${scanpyStatus.reason}`);
}

describeSimulationContract({
  name: "scanpy",
  make: (root: string) => new ScanpyPlatform({ root }),
  okSpec: {
    platform: "scanpy",
    kind: "sc-cluster",
    params: { countsPath: COUNTS, nTopGenes: 60, nPcs: 15, resolution: 0.5, minGenesPerCell: 10 },
  },
  // 显式写出全部默认值 + 换书写顺序：归一化后必须与 okSpec 逐字段相同。
  equivalentSpec: {
    platform: "scanpy",
    kind: "sc-cluster",
    params: {
      resolution: 0.5,
      randomSeed: 0,
      nPcs: 15,
      minCellsPerGene: 3,
      countsPath: COUNTS,
      nNeighbors: 15,
      computeUmap: false,
      minGenesPerCell: 10,
      leidenIterations: 2,
      targetSum: 10000,
      nTopGenes: 60,
      rankMethod: "wilcoxon",
      nMarkersPerCluster: 10,
      nEmbeddingDims: 5,
    },
  },
  differentSpec: {
    platform: "scanpy",
    kind: "sc-cluster",
    params: { countsPath: COUNTS, nTopGenes: 60, nPcs: 15, resolution: 1.2, minGenesPerCell: 10 },
  },
  // UMAP 那一步要 numba 现编译，比 okSpec 慢一大截——够我们在「还在跑」的时候做断言。
  slowSpec: {
    platform: "scanpy",
    kind: "sc-cluster",
    params: {
      countsPath: COUNTS,
      nTopGenes: 60,
      nPcs: 15,
      resolution: 0.5,
      minGenesPerCell: 10,
      computeUmap: true,
      nMarkersPerCluster: 50,
    },
  },
  // nPcs ≥ HVG 数 → PCA 无解。这是单细胞流水线上最常撞的一条真实失败，不是人为开关。
  failingSpec: {
    platform: "scanpy",
    kind: "sc-cluster",
    params: { countsPath: COUNTS, nTopGenes: 60, nPcs: 80, minGenesPerCell: 10 },
  },
  invalidSpec: {
    platform: "scanpy",
    kind: "sc-cluster",
    params: { countsPath: COUNTS, nNeighbors: 1 },
  },
  expectedOutputs: ["clusters.csv", "markers.csv", "embedding.csv"],
  summaryKeys: ["cells", "clusters", "hvgGenes", "largestClusterFraction", "scanpyVersion"],
  runTimeoutMs: 180_000,
  skip: !scanpyStatus.ok,
  skipReason: scanpyStatus.reason ?? undefined,
});

// ── 探测与真跑必须是同一条路径（V27） ──────────────────────────────────────
//
// 反面教材就在本仓库里：`doctor.ts` 的 `probeCode()` 是一段内联 python，探测**根本不摸**
// runner.py。于是 runner 没解包出来的时候，探测照样报「可用」，直到 submit 才 ENOENT。
// 下面两条把「探测摸到的路径」与「submit 用的路径」钉成同一个。
describe("scanpy · 探测与真跑指向同一条路径", () => {
  const platform = new ScanpyPlatform({ root: mkdtempSync(join(tmpdir(), "scanpy-path-")) });
  const entryPoint = (platform as unknown as { entryPointFor: (k: string) => string }).entryPointFor(
    "sc-cluster",
  );

  test("probeCode 里带的就是 entryPointFor 的绝对路径（不是另写一段内联 python）", () => {
    const code = (platform as unknown as { probeCode: () => string }).probeCode();
    expect(code).toContain(entryPoint);
    expect(entryPoint).not.toContain("/$bunfs");
    // 探测必须真的把这个文件加载起来跑，而不是只把路径当字符串带着。
    expect(code).toContain("spec_from_file_location");
    expect(code).toContain("exec_module");
  });

  test("entryPoint 不存在时 available() 必须报不可用（而不是靠内联 import 蒙混过关）", async () => {
    class MissingRunner extends ScanpyPlatform {
      protected override entryPointFor(): string {
        return join(entryPoint, "..", "no-such-runner.py");
      }
    }
    const broken = new MissingRunner({ root: mkdtempSync(join(tmpdir(), "scanpy-broken-")) });
    const status = await broken.available();
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("no-such-runner.py");
    // 而且 submit 也确实会在同一条路径上失败——两边结论一致才算「同一条路径」。
    const prepared = await broken.prepare({
      platform: "scanpy",
      kind: "sc-cluster",
      params: { countsPath: COUNTS },
    });
    expect(prepared.entryPoint).toContain("no-such-runner.py");
    await expect(broken.submit(prepared)).rejects.toThrow(/runner 脚本不存在/);
  });
});

// ── 依赖缺失 = 报「未安装」+ 给安装命令，不许静默降级 ────────────────────────
describe("scanpy · 依赖缺失时给出可操作的安装命令", () => {
  test("scanpy 装不上时 available() 报不可用，且 reason 里有 uv pip install", async () => {
    const platform = new ScanpyPlatform({
      root: mkdtempSync(join(tmpdir(), "scanpy-missing-")),
      python: pythonWithoutModule("scanpy"),
    });
    const status = await platform.available();
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("scanpy 不可用");
    // 不锁死具体模块名：宿主 python 缺哪一环（scanpy 本体，或它的依赖 pandas/numpy）
    // 是环境属性，CI 实测会先死在依赖链上。本测试的语义是「探测失败要透出 python 的
    // 原始报错」，不是「报错必须是 scanpy 自己」。
    expect(status.reason).toContain("No module named");
    expect(status.reason).toContain("uv pip install scanpy");
    // 静默降级的形状（ok:true + 空 detail）在这里必须不可能出现。
    expect(status.detail.exitCode).not.toBe(0);
  }, 120_000);
});

// ── 参数归一化的边角（prepare 是纯函数，错要错在这里而不是 runner 里） ─────────
describe("scanpy · prepare 阶段就把坏输入拒掉", () => {
  const platform = new ScanpyPlatform({ root: mkdtempSync(join(tmpdir(), "scanpy-params-")) });

  test("countsPath 必填", async () => {
    await expect(platform.prepare({ platform: "scanpy", kind: "sc-cluster", params: {} })).rejects.toThrow(
      /countsPath.*必填/,
    );
  });

  test("countsPath 指向不存在的文件 → 当场拒（不留给 runner 报 ENOENT）", async () => {
    await expect(
      platform.prepare({
        platform: "scanpy",
        kind: "sc-cluster",
        params: { countsPath: join(FIXTURES, "no-such-counts.csv") },
      }),
    ).rejects.toThrow(/文件不存在/);
  });

  test("nPcs ≥ nTopGenes 只警告不拒绝（算例会失败，但那是算例的事）", async () => {
    const prepared = await platform.prepare({
      platform: "scanpy",
      kind: "sc-cluster",
      params: { countsPath: COUNTS, nTopGenes: 60, nPcs: 80 },
    });
    expect(prepared.warnings.join(" ")).toContain("PCA");
  });

  test("合法参数不产生警告（别让警告变成人人无视的背景噪音）", async () => {
    const prepared = await platform.prepare({
      platform: "scanpy",
      kind: "sc-cluster",
      params: { countsPath: COUNTS, nTopGenes: 60, nPcs: 15 },
    });
    expect(prepared.warnings).toEqual([]);
  });
});
