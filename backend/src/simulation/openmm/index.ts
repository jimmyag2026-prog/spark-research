import { join } from "node:path";
// V27：同 pyref —— `runner.py` 也做 `sys.path.insert(..., parents[2])` +
// `from simulation.sim_runtime import ...`，解包单位是整棵包树。
import SIM_PACKAGE_INIT_PY from "../__init__.py" with { type: "text" };
import SIM_RUNTIME_PY from "../sim_runtime.py" with { type: "text" };
import OPENMM_PACKAGE_INIT_PY from "./__init__.py" with { type: "text" };
import RUNNER_PY from "./runner.py" with { type: "text" };
import { materializeAssetTree } from "../../assets/embedded";
import { probeCodeFor } from "../probe";
import {
  SubprocessSimulationPlatform,
  boolParam,
  enumParam,
  numberParam,
  type NormalizedSpec,
  type SubprocessPlatformOptions,
} from "../platform";

const OPENMM_RUNNER_TREE = {
  "simulation/__init__.py": SIM_PACKAGE_INIT_PY,
  "simulation/sim_runtime.py": SIM_RUNTIME_PY,
  "simulation/openmm/__init__.py": OPENMM_PACKAGE_INIT_PY,
  "simulation/openmm/runner.py": RUNNER_PY,
} as const;

export const OPENMM_KINDS = ["water-box-md"] as const;
export type OpenMMKind = (typeof OPENMM_KINDS)[number];

export const WATER_MODELS = ["tip3p", "tip3pfb", "spce"] as const;
export const COMPUTE_PLATFORMS = ["CPU", "Reference", "OpenCL", "CUDA", "HIP"] as const;

// OpenMM adapter（本地进程型，DESIGN 域 B1 首批参考实现之一）。
//
// 走子进程而不是 stateful kernel：MD 任务动辄几分钟到几小时，占着 kernel
// 会把整个会话堵死；而且 P5 的退出标准要求「编排进程被 kill 后任务还在跑」，
// 那就必须是一个独立进程 + 磁盘状态（见 platform.ts 的注释）。
export class OpenMMPlatform extends SubprocessSimulationPlatform {
  readonly id = "openmm";
  // CPU 平台多线程浮点归约 → 逐位不可复现（P5 实测三次 E_min 各不相同）。
  readonly deterministic = false;
  readonly description = "OpenMM 分子动力学（水盒子能量最小化 + 短时 NVT 平衡，纯 CPU 秒级）";
  readonly kinds = OPENMM_KINDS;

  constructor(options: SubprocessPlatformOptions) {
    super(options);
  }

  protected entryPointFor(): string {
    return join(materializeAssetTree("sim-openmm", OPENMM_RUNNER_TREE), "simulation", "openmm", "runner.py");
  }

  // V118：探测与真提交同源——走 runner.py 的 probe()（probeCodeFor），与 scanpy/pydeseq2/cobrapy 一致。
  protected probeCode(): string {
    return probeCodeFor(this.entryPointFor(), "openmm", "uv pip install openmm（进仓库 .venv，不要动系统 python）");
  }

  protected normalize(_kind: string, params: Record<string, unknown>): NormalizedSpec {
    const boxSizeNm = numberParam(params, "boxSizeNm", 2.0, { min: 0.1, max: 20 });
    const cutoffNm = numberParam(params, "cutoffNm", 0.9, { min: 0.1, max: 5 });
    const normalized = {
      boxSizeNm,
      cutoffNm,
      waterModel: enumParam(params, "waterModel", WATER_MODELS, "tip3pfb"),
      steps: numberParam(params, "steps", 500, { min: 1, max: 10_000_000, integer: true }),
      timestepPs: numberParam(params, "timestepPs", 0.002, { min: 1e-5, max: 0.01 }),
      temperatureK: numberParam(params, "temperatureK", 300, { min: 1, max: 1000 }),
      frictionPerPs: numberParam(params, "frictionPerPs", 1.0, { min: 0 }),
      reportInterval: numberParam(params, "reportInterval", 50, { min: 1, integer: true }),
      seed: numberParam(params, "seed", 12345, { min: 0, integer: true }),
      computePlatform: enumParam(params, "computePlatform", COMPUTE_PLATFORMS, "CPU"),
      minimize: boolParam(params, "minimize", true),
    };

    // PME 的硬约束：截断半径不得超过周期盒边长的一半。这里只警告不拒绝——
    // 契约测试要一条「参数合法但 OpenMM 自己会拒」的真实失败路径，
    // 而这正是 MD 用户最常撞的那一条。
    const warnings: string[] = [];
    if (cutoffNm > boxSizeNm / 2) {
      warnings.push(
        `cutoffNm=${cutoffNm} 超过盒边长的一半（${(boxSizeNm / 2).toFixed(2)}nm），OpenMM 会拒绝创建 PME 体系`,
      );
    }
    return { params: normalized, expectedOutputs: ["energy.csv", "final_state.xml"], warnings };
  }
}
