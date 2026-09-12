import { join } from "node:path";
// V27：解包单位是整棵包树，理由与 pyref / openmm / scanpy 相同（见 scanpy/index.ts 文件头）。
import SIM_PACKAGE_INIT_PY from "../__init__.py" with { type: "text" };
import SIM_RUNTIME_PY from "../sim_runtime.py" with { type: "text" };
import COBRAPY_PACKAGE_INIT_PY from "./__init__.py" with { type: "text" };
import RUNNER_PY from "./runner.py" with { type: "text" };
import { materializeAssetTree } from "../../assets/embedded";
import { SimulationSpecError } from "../models";
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

const COBRAPY_RUNNER_TREE = {
  "simulation/__init__.py": SIM_PACKAGE_INIT_PY,
  "simulation/sim_runtime.py": SIM_RUNTIME_PY,
  "simulation/cobrapy/__init__.py": COBRAPY_PACKAGE_INIT_PY,
  "simulation/cobrapy/runner.py": RUNNER_PY,
} as const;

export const COBRAPY_KINDS = ["fba"] as const;
export type CobraPyKind = (typeof COBRAPY_KINDS)[number];

export const COBRAPY_MEDIA = ["model-default", "aerobic", "anaerobic"] as const;

/** 安装命令：探测失败时原样打给用户。 */
export const COBRAPY_INSTALL_HINT = "uv pip install cobra（进仓库 .venv，不要动系统 python）";

// cobrapy adapter（C3 平台三件套之三）：基因组尺度代谢模型 → 通量平衡分析。
//
// FBA 本身是个 LP，秒级出解，看起来「用不着子进程」。仍然走同一套契约有两个理由：
// ① FVA / 基因逐个敲除扫描会把秒级变成分钟级，届时没有磁盘状态就没法续跑；
// ② 三件套共用一套契约测试才谈得上「接口通用」（AD-4）。
export class CobraPyPlatform extends SubprocessSimulationPlatform {
  readonly id = "cobrapy";
  // LP 求解是确定性的（同一模型、同一求解器、同一边界 → 同一顶点），
  // 而且 runner 默认再跑一次 pFBA 把 alternate optima 收敛到最小总通量解。
  // 实测两次跑出的通量表逐字节一致；tests/unit/cobrapy_e2e.test.ts 每次重验。
  readonly deterministic = true;
  readonly description = "cobrapy 代谢通量平衡分析（FBA / pFBA / FVA，支持基因敲除与有氧-厌氧切换）";
  readonly kinds = COBRAPY_KINDS;

  constructor(options: SubprocessPlatformOptions) {
    super(options);
  }

  protected entryPointFor(): string {
    return join(materializeAssetTree("sim-cobrapy", COBRAPY_RUNNER_TREE), "simulation", "cobrapy", "runner.py");
  }

  // 探测走 runner 本身，理由见 ../scanpy/probe.ts 的 probeCodeFor 注释（V27）。
  // cobra 这一条尤其要紧：`import cobra` 成功 ≠ 有 LP 求解器，runner 的 probe()
  // 会把 optlang 认得的求解器列出来，一个都没有就算不可用。
  protected probeCode(): string {
    return probeCodeFor(this.entryPointFor(), "cobrapy", COBRAPY_INSTALL_HINT);
  }

  protected normalize(_kind: string, params: Record<string, unknown>): NormalizedSpec {
    const objective = idParam(params, "objective", "");
    const knockouts = idListParam(params, "knockouts");
    const normalized = {
      modelPath: datasetParam(params, "modelPath", [".xml", ".xml.gz", ".sbml", ".json", ".yml", ".yaml"]),
      // 空串 = 用模型自带的目标函数（生物量反应）。
      objective,
      medium: enumParam(params, "medium", COBRAPY_MEDIA, "model-default"),
      knockouts: knockouts.join(","),
      parsimonious: boolParam(params, "parsimonious", true),
      fluxVariability: boolParam(params, "fluxVariability", false),
      fvaFraction: numberParam(params, "fvaFraction", 0.9, { min: 0, max: 1 }),
    };

    // 只警告不拒绝：模型里有没有这个 id，只有读到模型才知道——而 prepare 刻意不读模型
    //（它必须是纯函数：同一 spec 到哪台机器都得到同一个 specHash）。
    // 于是这里给出「写错了会怎样」的预告，真伪留给 runner 报错。
    const warnings: string[] = [];
    if (objective) {
      warnings.push(
        `objective='${objective}' 会覆盖模型自带的目标函数；模型里没有这个反应 id 时算例会失败` +
          `（prepare 不读模型文件，所以这里核实不了）`,
      );
    }
    if (knockouts.length > 0) {
      warnings.push(
        `knockouts=${knockouts.join(",")} 会逐个敲除；其中任何一个不是模型里的基因 id，算例都会失败`,
      );
    }
    return { params: normalized, expectedOutputs: ["fluxes.csv", "solution.json"], warnings };
  }
}

// 反应 / 基因 id：SBML 的 id 语法（字母数字下划线，允许 BiGG 的括号写法）。
// 拒非法字符是为了不把 shell 元字符之类的东西带进 runner，而不是为了校验「存在」。
const ID_PATTERN = /^[A-Za-z0-9_.()[\]-]+$/;

function idParam(params: Record<string, unknown>, name: string, fallback: string): string {
  const raw = params[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = String(raw).trim();
  if (!ID_PATTERN.test(value)) {
    throw new SimulationSpecError(`参数 '${name}' 不是合法的 id（字母数字 _ . - () []）：'${value}'`);
  }
  return value;
}

function idListParam(params: Record<string, unknown>, name: string): string[] {
  const raw = params[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return [];
  const items = (Array.isArray(raw) ? raw.map(String) : String(raw).split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  for (const item of items) {
    if (!ID_PATTERN.test(item)) {
      throw new SimulationSpecError(`参数 '${name}' 里 '${item}' 不是合法的 id（字母数字 _ . - () []）`);
    }
  }
  // 排序 + 去重：`a,b` 与 `b,a,b` 是同一个算例，specHash 必须相同（契约 #1）。
  return [...new Set(items)].sort();
}
