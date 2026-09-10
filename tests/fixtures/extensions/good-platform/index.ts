import { join } from "node:path";
import {
  SubprocessSimulationPlatform,
  numberParam,
  type NormalizedSpec,
  type SubprocessPlatformOptions,
  type SimulationPlatform,
} from "../../../../backend/src/simulation/platform";

// 示例 platform 扩展（tests/fixtures/extensions/good-platform）——结构上照抄
// `spark-research new platform` 生成的模板（backend/src/scaffold/templates.ts
// platformTemplate()），因为那就是本仓库对"怎么接一个新仿真平台"给出的标准答案，
// ext verify 复用的正是同一套 P5 契约测试。

export const GOOD_PLATFORM_KINDS = ["demo-run"] as const;

export class GoodPlatform extends SubprocessSimulationPlatform {
  readonly id = "good-platform";
  readonly deterministic = true;
  readonly description = "ext verify 测试夹具：一个合规的 TS 仿真平台扩展";
  readonly kinds = GOOD_PLATFORM_KINDS;

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
    const steps = numberParam(params, "steps", 100, { min: 1, max: 1_000_000, integer: true });
    const scale = numberParam(params, "scale", 1.0, { min: 1e-9 });
    const warnings: string[] = [];
    if (scale > 10) {
      warnings.push(`scale=${scale} 会让递推快速发散（value ← value*scale+1），算例可能以 failed 结束`);
    }
    return {
      params: { steps, scale, stallSeconds: numberParam(params, "stallSeconds", 0, { min: 0, max: 600 }) },
      expectedOutputs: ["series.csv", "final_state.json"],
      warnings,
    };
  }
}

// ext verify / loader 约定的入口：kind="platform" 的扩展导出一个
// `createPlatform(root)` 工厂（而不是直接导出类），装载器与 platform_verify.ts
// 都只依赖这个函数签名，不关心背后是不是 SubprocessSimulationPlatform 的子类。
export function createPlatform(root: string): SimulationPlatform {
  return new GoodPlatform({ root });
}
