import type { SafetyRule } from "../../backend/src/lab/safety";
import type { ProtocolStep } from "../../backend/src/lab/protocol";

// docs/EXTENDING.md 第五节「安全门规则」的最小可运行示例。
//
// 场景：易燃试剂（乙醇、丙酮、甲醇）不得出现在超过其闪点附近温度的加热步骤里。
// 这是真实实验室最基础的一条规矩，也正好演示安全门规则的三个特点：
//
//   1. **纯函数**：入参是协议（可选地加上编译产物），出参是一条 SafetyCheckResult。
//      零 IO、不读文件、不打网络、不看时间——所以它可以被穷举地对抗测试。
//   2. **一条规则一个 id**：id 进 record metadata（机器读），check 是显示名（人读）。
//      混在别的规则里的 if 分支没法被单独打，测「超温被拦」时你其实同时依赖了
//      另外几条规则没误报。
//   3. **安全门是必要非充分条件**：这条规则通过只意味着可以进 awaiting_approval，
//      绝不意味着可以执行（AD-6 由状态机守，不由规则守）。
//
// 装上它只要一步：在 backend/src/lab/safety.ts 的 SAFETY_RULES 数组里加一项。
// 加进去之后 `spark-research capabilities` 会自动列出它——不用手写清单。

// 闪点（°C）。低于这个温度加热就已经在产生可燃蒸气了。
export const FLAMMABLE_FLASH_POINT_C: Readonly<Record<string, number>> = {
  ethanol: 13,
  acetone: -20,
  methanol: 11,
  isopropanol: 12,
};

// 密闭加热的额外裕量：孵育器不是明火环境，低温孵育（如 37 °C 细胞培养里的
// 微量乙醇）不该被拦。阈值定在 60 °C——文献与实验室通则里常见的「不得在
// 60 °C 以上加热易燃溶剂」那条线。定在闪点上会把 37 °C 孵育全部误杀，
// 那种规则会在两周内被人注释掉。
export const HEAT_THRESHOLD_C = 60;

interface ReagentLike {
  name: string;
  reagentId?: string;
}

function reagentsOfStep(step: ProtocolStep): ReagentLike[] {
  return (step.params.reagents ?? []) as ReagentLike[];
}

function temperatureOf(step: ProtocolStep): number | null {
  const raw = step.params.temperature ?? step.params.temperatureC;
  if (raw === undefined || raw === null) return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : null;
}

export const flammableOverHeatRule: SafetyRule = {
  id: "flammable_over_heat",
  check: "flammable over heat",
  description: `易燃试剂（${Object.keys(FLAMMABLE_FLASH_POINT_C).join(" / ")}）不得出现在高于 ${HEAT_THRESHOLD_C} °C 的加热步骤中`,
  evaluate({ protocol }) {
    const violations: string[] = [];
    for (const step of protocol.steps) {
      const temperature = temperatureOf(step);
      if (temperature === null || temperature <= HEAT_THRESHOLD_C) continue;
      for (const reagent of reagentsOfStep(step)) {
        // 按 reagentId 匹配而不是按 name：name 是自然语言里抄下来的，
        // 「无水乙醇」「Ethanol (200 proof)」是同一个东西，靠 name 匹配必漏。
        const flashPoint = reagent.reagentId ? FLAMMABLE_FLASH_POINT_C[reagent.reagentId] : undefined;
        if (flashPoint === undefined) continue;
        violations.push(`${step.id}: ${reagent.name}（闪点 ${flashPoint} °C）在 ${temperature} °C 加热`);
      }
    }
    return {
      check: "flammable over heat",
      passed: violations.length === 0,
      // detail 写给人看：说清**哪一步、哪个试剂、什么温度**，
      // 否则用户拿到一句「不安全」只能全协议重读。
      detail: violations.length ? `flammable reagents heated above limit: ${violations.join("; ")}` : undefined,
    };
  },
};
