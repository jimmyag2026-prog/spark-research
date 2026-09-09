import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenMMPlatform } from "../../backend/src/simulation/openmm";
import { PyRefPlatform } from "../../backend/src/simulation/pyref";
import { describeSimulationContract } from "../helpers/simulation_contract";

// P5 契约测试矩阵：**同一组测试**参数化跑在两个实现上（DEVELOPMENT_PLAN P5 退出标准）。
//
// pyref 侧必须永远全绿（零外部依赖）；openmm 侧在环境不可用时整套 skip，
// 并把原因打出来——静默跳过等于假装测过了。

const pyrefCase = {
  name: "pyref",
  make: (root: string) => new PyRefPlatform({ root }),
  okSpec: { platform: "pyref", kind: "damped-oscillator", params: { steps: 400 } },
  // 显式写出默认值 + 换书写顺序：归一化后必须与 okSpec 逐字段相同。
  equivalentSpec: {
    platform: "pyref",
    kind: "damped-oscillator",
    params: { sampleInterval: 10, damping: 0.2, steps: 400, dt: 0.01, mass: 1, stiffness: 4, x0: 1, v0: 0 },
  },
  differentSpec: { platform: "pyref", kind: "damped-oscillator", params: { steps: 400, damping: 0.9 } },
  slowSpec: { platform: "pyref", kind: "damped-oscillator", params: { steps: 100, stallSeconds: 8 } },
  // dt 远大于固有周期 → RK4 指数发散。这是 ODE 求解最真实的失败模式，不是人为开关。
  failingSpec: { platform: "pyref", kind: "damped-oscillator", params: { dt: 5, steps: 200 } },
  invalidSpec: { platform: "pyref", kind: "damped-oscillator", params: { steps: -1 } },
  expectedOutputs: ["trajectory.csv", "final_state.json"],
  summaryKeys: ["steps", "finalPosition", "analyticFinalPosition", "maxAbsErrorVsAnalytic", "regime"],
  runTimeoutMs: 60_000,
};

const openmmProbeRoot = mkdtempSync(join(tmpdir(), "openmm-probe-"));
const openmmStatus = await new OpenMMPlatform({ root: openmmProbeRoot }).available();
if (!openmmStatus.ok) {
  console.warn(`[P5 契约测试] OpenMM 侧整套 skip：${openmmStatus.reason}`);
}

const openmmCase = {
  name: "openmm",
  make: (root: string) => new OpenMMPlatform({ root }),
  okSpec: { platform: "openmm", kind: "water-box-md", params: { steps: 100, boxSizeNm: 1.8 } },
  equivalentSpec: {
    platform: "openmm",
    kind: "water-box-md",
    params: {
      boxSizeNm: 1.8,
      steps: 100,
      cutoffNm: 0.9,
      waterModel: "tip3pfb",
      timestepPs: 0.002,
      temperatureK: 300,
      frictionPerPs: 1,
      reportInterval: 50,
      seed: 12345,
      computePlatform: "CPU",
      minimize: true,
    },
  },
  differentSpec: { platform: "openmm", kind: "water-box-md", params: { steps: 100, boxSizeNm: 2.2 } },
  slowSpec: { platform: "openmm", kind: "water-box-md", params: { steps: 40_000, boxSizeNm: 2.5 } },
  // PME 的硬约束：截断半径不得超过盒边长的一半。OpenMM 自己会拒——MD 用户最常撞的那条。
  failingSpec: { platform: "openmm", kind: "water-box-md", params: { boxSizeNm: 1.2, cutoffNm: 0.9, steps: 10 } },
  invalidSpec: { platform: "openmm", kind: "water-box-md", params: { waterModel: "tip9p" } },
  expectedOutputs: ["energy.csv", "final_state.xml"],
  summaryKeys: [
    "atoms",
    "initialPotentialKJPerMol",
    "minimizedPotentialKJPerMol",
    "finalPotentialKJPerMol",
    "meanEquilibratedTemperatureK",
    "openmmVersion",
  ],
  runTimeoutMs: 180_000,
  skip: !openmmStatus.ok,
  skipReason: openmmStatus.reason ?? undefined,
};

describeSimulationContract(pyrefCase);
describeSimulationContract(openmmCase);
