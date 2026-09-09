import { join } from "node:path";
import {
  SubprocessSimulationPlatform,
  boolParam,
  enumParam,
  numberParam,
  type NormalizedSpec,
  type SubprocessPlatformOptions,
} from "../platform";

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
  readonly description = "OpenMM 分子动力学（水盒子能量最小化 + 短时 NVT 平衡，纯 CPU 秒级）";
  readonly kinds = OPENMM_KINDS;

  constructor(options: SubprocessPlatformOptions) {
    super(options);
  }

  protected entryPointFor(): string {
    return join(import.meta.dir, "runner.py");
  }

  protected probeCode(): string {
    return [
      "import json, sys",
      "try:",
      "    import openmm",
      "    from openmm import Platform",
      "    names = [Platform.getPlatform(i).getName() for i in range(Platform.getNumPlatforms())]",
      "    print(json.dumps({'openmm': openmm.version.version, 'platforms': ','.join(names), 'python': sys.version.split()[0]}))",
      "except Exception as exc:",
      "    sys.stderr.write('openmm 不可用: %s\\n' % exc)",
      "    sys.stderr.write('安装：uv pip install openmm（进仓库 .venv，不要动系统 python）\\n')",
      "    raise SystemExit(1)",
    ].join("\n");
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
