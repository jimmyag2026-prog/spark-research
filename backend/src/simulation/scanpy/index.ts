import { join } from "node:path";
// V27：同 pyref / openmm —— `runner.py` 由**外部** python 按路径执行，而且它开头就
// `sys.path.insert(0, parents[2])` + `from simulation.sim_runtime import ...`，
// 所以解包单位是整棵包树，不是单个文件。只靠 `with { type: "file" }` 拿到的是
// `/$bunfs/root/...` 虚拟路径，外部 python 打不开（docs/devlog/F-c.md §3.2）。
import SIM_PACKAGE_INIT_PY from "../__init__.py" with { type: "text" };
import SIM_RUNTIME_PY from "../sim_runtime.py" with { type: "text" };
import SCANPY_PACKAGE_INIT_PY from "./__init__.py" with { type: "text" };
import RUNNER_PY from "./runner.py" with { type: "text" };
import { materializeAssetTree } from "../../assets/embedded";
import { datasetParam, probeCodeFor } from "./probe";
import {
  SubprocessSimulationPlatform,
  boolParam,
  enumParam,
  numberParam,
  type NormalizedSpec,
  type SubprocessPlatformOptions,
} from "../platform";

const SCANPY_RUNNER_TREE = {
  "simulation/__init__.py": SIM_PACKAGE_INIT_PY,
  "simulation/sim_runtime.py": SIM_RUNTIME_PY,
  "simulation/scanpy/__init__.py": SCANPY_PACKAGE_INIT_PY,
  "simulation/scanpy/runner.py": RUNNER_PY,
} as const;

export const SCANPY_KINDS = ["sc-cluster"] as const;
export type ScanpyKind = (typeof SCANPY_KINDS)[number];

export const RANK_METHODS = ["wilcoxon", "t-test", "t-test_overestim_var", "logreg"] as const;

/** 安装命令：探测失败时原样打给用户（openmm 的口径——只说「不可用」等于没说）。 */
export const SCANPY_INSTALL_HINT = "uv pip install scanpy leidenalg igraph（进仓库 .venv，不要动系统 python）";

// scanpy adapter（C3 平台三件套之一）：单细胞表达矩阵 → 质控 → 降维 → leiden 聚类 →
// 每簇 marker 基因排名。
//
// 走子进程而不是 stateful kernel 的理由与 openmm 相同（见 platform.ts）：真实数据集
// 动辄几万细胞，占着 kernel 会把会话堵死；而且状态必须在磁盘上，编排进程被杀了任务还在。
export class ScanpyPlatform extends SubprocessSimulationPlatform {
  readonly id = "scanpy";
  // runner 把 sc.settings.n_jobs 钉成 1、PCA 用 arpack + 固定 seed、leiden 传 random_state，
  // 实测同一 spec 两次跑出的三份产出逐字节一致（tests/unit/scanpy_e2e.test.ts 每次都重测这条，
  // 不是靠这行注释）。任何一处随机性失去种子，那条测试就会红。
  readonly deterministic = true;
  readonly description = "scanpy 单细胞分析（质控 → HVG → PCA → leiden 聚类 → marker 基因排名）";
  readonly kinds = SCANPY_KINDS;

  constructor(options: SubprocessPlatformOptions) {
    super(options);
  }

  protected entryPointFor(): string {
    return join(materializeAssetTree("sim-scanpy", SCANPY_RUNNER_TREE), "simulation", "scanpy", "runner.py");
  }

  // V27 的教训落在这里：探测**必须走它将来真会用的那条路径**。
  // 老写法（doctor.ts 的 probeCode / pyref 的 `import sys, json`）是一段与 runner 无关的
  // 内联 python——runner 没解包出来、包树缺件、sim_runtime 改坏，探测照样报「可用」，
  // 等到 submit 才 ENOENT。这里改成：用 importlib 加载**这个平台的 entryPoint 本身**，
  // 执行它的模块级 import（scanpy/anndata/leidenalg 全在里面），再调它的 probe()。
  // 于是「探测说可用」= 「这条路径真的能起来」，两者不可能分叉。
  protected probeCode(): string {
    return probeCodeFor(this.entryPointFor(), "scanpy", SCANPY_INSTALL_HINT);
  }

  protected normalize(_kind: string, params: Record<string, unknown>): NormalizedSpec {
    const nTopGenes = numberParam(params, "nTopGenes", 2000, { min: 10, max: 50_000, integer: true });
    const nPcs = numberParam(params, "nPcs", 50, { min: 2, max: 500, integer: true });
    const normalized = {
      countsPath: datasetParam(params, "countsPath", [".csv"]),
      minGenesPerCell: numberParam(params, "minGenesPerCell", 200, { min: 0, max: 100_000, integer: true }),
      minCellsPerGene: numberParam(params, "minCellsPerGene", 3, { min: 0, max: 100_000, integer: true }),
      targetSum: numberParam(params, "targetSum", 10_000, { min: 1 }),
      nTopGenes,
      nPcs,
      nNeighbors: numberParam(params, "nNeighbors", 15, { min: 2, max: 500, integer: true }),
      resolution: numberParam(params, "resolution", 1.0, { min: 0.01, max: 100 }),
      leidenIterations: numberParam(params, "leidenIterations", 2, { min: 1, max: 100, integer: true }),
      rankMethod: enumParam(params, "rankMethod", RANK_METHODS, "wilcoxon"),
      nMarkersPerCluster: numberParam(params, "nMarkersPerCluster", 10, { min: 1, max: 500, integer: true }),
      nEmbeddingDims: numberParam(params, "nEmbeddingDims", 5, { min: 1, max: 100, integer: true }),
      randomSeed: numberParam(params, "randomSeed", 0, { min: 0, integer: true }),
      computeUmap: boolParam(params, "computeUmap", false),
    };

    // 只警告不拒绝：契约测试需要一条「参数合法、算例自己会失败」的真实路径，
    // 而 PCA 的成分数不能 ≥ 特征数是单细胞流水线上最常撞的那一条。
    const warnings: string[] = [];
    if (nPcs >= nTopGenes) {
      warnings.push(
        `nPcs=${nPcs} 不小于 nTopGenes=${nTopGenes}：HVG 子集最多 ${nTopGenes} 个特征，` +
          `PCA 要求成分数严格小于特征数，这个算例会失败`,
      );
    }
    return {
      params: normalized,
      expectedOutputs: ["clusters.csv", "markers.csv", "embedding.csv"],
      warnings,
    };
  }
}
