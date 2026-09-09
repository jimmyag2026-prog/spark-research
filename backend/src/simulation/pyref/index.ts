import { join } from "node:path";
import {
  SubprocessSimulationPlatform,
  numberParam,
  type NormalizedSpec,
  type SubprocessPlatformOptions,
} from "../platform";

export const PYREF_KINDS = ["damped-oscillator"] as const;
export type PyRefKind = (typeof PYREF_KINDS)[number];

// 纯 Python 参考实现（第二个 adapter，DESIGN 域 B1「证明接口通用性」的那一个）。
//
// 为什么是它而不是 GROMACS：contract 需要一个在**任何**环境里都能跑的实现，
// 否则契约测试在 CI 里就永远是 skip，等于没有。阻尼谐振子零依赖、确定性、
// 而且有解析解可对照——它验证的是接口而不是运气。
export class PyRefPlatform extends SubprocessSimulationPlatform {
  readonly id = "pyref";
  readonly deterministic = true;
  readonly description = "纯 Python 阻尼谐振子参考仿真（零外部依赖，确定性，有解析解对照）";
  readonly kinds = PYREF_KINDS;

  constructor(options: SubprocessPlatformOptions) {
    super(options);
  }

  protected entryPointFor(): string {
    return join(import.meta.dir, "runner.py");
  }

  protected probeCode(): string {
    return "import sys, json; print(json.dumps({'python': sys.version.split()[0]}))";
  }

  protected normalize(_kind: string, params: Record<string, unknown>): NormalizedSpec {
    const dt = numberParam(params, "dt", 0.01, { min: 1e-6, max: 10 });
    const steps = numberParam(params, "steps", 2000, { min: 1, max: 5_000_000, integer: true });
    const mass = numberParam(params, "mass", 1.0, { min: 1e-9 });
    const stiffness = numberParam(params, "stiffness", 4.0, { min: 1e-9 });
    const damping = numberParam(params, "damping", 0.2, { min: 0 });
    const normalized = {
      mass,
      stiffness,
      damping,
      x0: numberParam(params, "x0", 1.0),
      v0: numberParam(params, "v0", 0.0),
      dt,
      steps,
      sampleInterval: numberParam(params, "sampleInterval", 10, { min: 1, integer: true }),
      stallSeconds: numberParam(params, "stallSeconds", 0, { min: 0, max: 600 }),
    };

    // 步长相对固有周期太大时 RK4 会发散。这里只**警告**不拒绝：
    // 契约测试需要一条「参数合法但算例会失败」的路径，而这正是最真实的一条
    //（数值发散是 MD/ODE 里最常见的失败模式，不是人为造的错误开关）。
    const warnings: string[] = [];
    const period = (2 * Math.PI) / Math.sqrt(stiffness / mass);
    if (dt > period / 10) {
      warnings.push(
        `dt=${dt} 大于固有周期 ${period.toFixed(3)}s 的 1/10，RK4 可能发散（发散时 runner 会报 failed）`,
      );
    }
    return { params: normalized, expectedOutputs: ["trajectory.csv", "final_state.json"], warnings };
  }
}
