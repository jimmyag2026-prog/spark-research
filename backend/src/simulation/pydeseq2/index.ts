import { join } from "node:path";
// V27：解包单位是整棵包树，理由与 pyref / openmm / scanpy 相同（见 scanpy/index.ts 文件头）。
import SIM_PACKAGE_INIT_PY from "../__init__.py" with { type: "text" };
import SIM_RUNTIME_PY from "../sim_runtime.py" with { type: "text" };
import PYDESEQ2_PACKAGE_INIT_PY from "./__init__.py" with { type: "text" };
import RUNNER_PY from "./runner.py" with { type: "text" };
import { materializeAssetTree } from "../../assets/embedded";
// V51（W8-δ）：probeCodeFor/datasetParam 搬到 simulation/probe.ts 顶层，import 行改指那里。
import { datasetParam, probeCodeFor } from "../probe";
import {
  SubprocessSimulationPlatform,
  boolParam,
  enumParam,
  numberParam,
  type NormalizedSpec,
  type SubprocessPlatformOptions,
} from "../platform";

const PYDESEQ2_RUNNER_TREE = {
  "simulation/__init__.py": SIM_PACKAGE_INIT_PY,
  "simulation/sim_runtime.py": SIM_RUNTIME_PY,
  "simulation/pydeseq2/__init__.py": PYDESEQ2_PACKAGE_INIT_PY,
  "simulation/pydeseq2/runner.py": RUNNER_PY,
} as const;

export const PYDESEQ2_KINDS = ["bulk-de"] as const;
export type PyDESeq2Kind = (typeof PYDESEQ2_KINDS)[number];

export const DISPERSION_FIT_TYPES = ["parametric", "mean"] as const;

/** 安装命令：探测失败时原样打给用户。 */
export const PYDESEQ2_INSTALL_HINT = "uv pip install pydeseq2（进仓库 .venv，不要动系统 python）";

// pydeseq2 adapter（C3 平台三件套之二）：bulk RNA-seq 计数矩阵 → size factor →
// dispersion 估计 → Wald 检验 → 差异表达表（DESeq2 口径的 Python 实现）。
export class PyDESeq2Platform extends SubprocessSimulationPlatform {
  readonly id = "pydeseq2";
  // runner 把 DefaultInference 的 n_cpus 钉成 1（joblib 多进程会让浮点尾数漂），
  // 且 PyDESeq2 本身没有随机数来源。实测同一 spec 两次跑出的产出逐字节一致，
  // 每次跑 tests/unit/pydeseq2_e2e.test.ts 都会重新验一遍这条声称。
  readonly deterministic = true;
  readonly description = "PyDESeq2 差异表达分析（size factor → dispersion → Wald 检验 → 差异基因表）";
  readonly kinds = PYDESEQ2_KINDS;

  constructor(options: SubprocessPlatformOptions) {
    super(options);
  }

  protected entryPointFor(): string {
    return join(
      materializeAssetTree("sim-pydeseq2", PYDESEQ2_RUNNER_TREE),
      "simulation",
      "pydeseq2",
      "runner.py",
    );
  }

  // 探测走 runner 本身，理由见 ../probe.ts 的 probeCodeFor 注释（V27）。
  protected probeCode(): string {
    return probeCodeFor(this.entryPointFor(), "pydeseq2", PYDESEQ2_INSTALL_HINT);
  }

  protected normalize(_kind: string, params: Record<string, unknown>): NormalizedSpec {
    const minTotalCount = numberParam(params, "minTotalCount", 10, { min: 0, max: 1e9, integer: true });
    const normalized = {
      countsPath: datasetParam(params, "countsPath", [".csv"]),
      metadataPath: datasetParam(params, "metadataPath", [".csv"]),
      designFactor: stringParam(params, "designFactor", "condition"),
      // 空串 = 用样本表里出现的头两个水平（runner 里解析）。
      testLevel: stringParam(params, "testLevel", ""),
      referenceLevel: stringParam(params, "referenceLevel", ""),
      minTotalCount,
      alpha: numberParam(params, "alpha", 0.05, { min: 1e-6, max: 1 }),
      fitType: enumParam(params, "fitType", DISPERSION_FIT_TYPES, "parametric"),
      refitCooks: boolParam(params, "refitCooks", true),
      cooksFilter: boolParam(params, "cooksFilter", true),
      independentFilter: boolParam(params, "independentFilter", true),
    };

    // 只警告不拒绝：低表达过滤是 DESeq2 的标准前处理，但阈值给大了会把矩阵滤空——
    // 这是这个平台上「参数合法、算例自己失败」最真实的一条路径。
    const warnings: string[] = [];
    if (minTotalCount > 10_000) {
      warnings.push(
        `minTotalCount=${minTotalCount} 非常高：低表达过滤可能把所有基因都滤掉，` +
          `留下空矩阵会让 PyDESeq2 直接失败`,
      );
    }
    if (normalized.testLevel !== "" && normalized.testLevel === normalized.referenceLevel) {
      warnings.push(`testLevel 与 referenceLevel 都是 '${normalized.testLevel}'——没有可比的两组，算例会失败`);
    }
    return { params: normalized, expectedOutputs: ["results.csv", "size_factors.csv"], warnings };
  }
}

// 自由文本参数（列名 / 因子水平）。没有可枚举的取值集合——它们是用户数据里的字符串，
// 所以只做「必须是字符串、去掉首尾空白」这一层，真伪由 runner 拿着样本表核实并报错。
function stringParam(params: Record<string, unknown>, name: string, fallback: string): string {
  const raw = params[name];
  if (raw === undefined || raw === null) return fallback;
  return String(raw).trim();
}
