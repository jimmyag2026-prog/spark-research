import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, dataDir, type ConfigOptions } from "../config";
import { DEFAULT_FRONTEND_DIR } from "../server/app";
import { PROVIDER_API_KEY_ENV } from "../llm/providers/registry";
import { resolvePython } from "../simulation/platform";
import { SimulationRegistry } from "../simulation/registry";
import { OpentronsSimulatorBackend } from "../lab/wet_backend";
import { PACKAGE_VERSION } from "../version";

// W1-d（B-a 打包分发）：`spark-research doctor`。
//
// 依赖分层的运行时版本（见 docs/devlog/W1-d.md 「为什么没动 pyproject.toml」）：
// `pyproject.toml` 的 `[dependencies]` 不是 PEP 621 形态（应为 `[project] dependencies = [...]`），
// `uv sync` 读不到它，装出来的环境跟这份声明脱节。这条 lane 的文件所有权不含
// `pyproject.toml`，改它风险自担不起（还可能跟其他并行 lane 撞车）。于是分层落在**运行时探测**：
// 不问 pyproject 声明了什么，直接去问"这个 Python 解释器真的 import 得到这个包吗"——
// 复用 simulation/registry.ts 与 lab/wet_backend.ts 已经写好的 probe 子进程（P5/P6 的产物，
// 装没装的判断口径与 `capabilities --probe` 完全一致，不会出现两套真源打架）。
//
// 三档：
//   core    —— 零 Python 依赖：文献 / idea / novelty / 记录 / 报告全部只需要 bun。
//   science —— 干实验仿真，需要 openmm（SimulationRegistry 的 openmm 平台）。
//   lab     —— 湿实验模拟器，需要 opentrons（wetBackend 的 opentrons_simulate 后端）。

export interface DependencyTierStatus {
  id: "core" | "science" | "lab";
  label: string;
  summary: string;
  available: boolean;
  reason: string | null;
}

export interface ProviderKeyStatus {
  id: string;
  envVar: string;
  configured: boolean;
}

export interface PythonStatus {
  path: string;
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface DoctorReport {
  version: string;
  bunVersion: string;
  platform: string;
  python: PythonStatus;
  tiers: DependencyTierStatus[];
  providers: ProviderKeyStatus[];
  frontendBuilt: boolean;
  frontendDir: string;
  dataDir: string;
  timestamp: string;
}

export interface TierProbeResult {
  ok: boolean;
  reason: string | null;
}

export interface DoctorOptions extends ConfigOptions {
  // 覆盖 Python 解释器（默认走 simulation/platform.ts 的 resolvePython：
  // SPARK_PYTHON > 仓库 .venv > python3——与仿真/湿实验层同一口径）。
  python?: string;
  // 仿真平台探测用的临时根目录；不给就现建一个（探测不写业务数据，同 capabilities 的做法）。
  simulationRoot?: string;
  frontendDir?: string;
  // 依赖注入，主要给测试用：用真实探测器之外的假实现验证 doctor 的渲染/汇总逻辑，
  // 也是阴性对照①的钩子——见 tests/unit/doctor.test.ts。
  probeScience?: (python: string) => Promise<TierProbeResult>;
  probeLab?: (python: string) => Promise<TierProbeResult>;
  probePython?: (python: string) => Promise<PythonStatus>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

async function defaultProbePython(python: string): Promise<PythonStatus> {
  try {
    const proc = Bun.spawn([python, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // `python --version` 在部分老版本上写到 stderr，两边都要看。
    const text = (stdout + stderr).trim();
    if (exitCode !== 0) {
      return { path: python, ok: false, version: null, error: text || `退出码 ${exitCode}` };
    }
    return { path: python, ok: true, version: text || null, error: null };
  } catch (err) {
    return { path: python, ok: false, version: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function defaultProbeScience(python: string, simulationRoot: string): Promise<TierProbeResult> {
  const registry = new SimulationRegistry({ root: simulationRoot, python });
  const status = await registry.get("openmm").available();
  return { ok: status.ok, reason: status.reason };
}

async function defaultProbeLab(python: string): Promise<TierProbeResult> {
  // `wetBackend()`（../lab/wet_backend.ts 的工厂函数）不接受 python 覆盖参数，
  // 直接实例化后端类自己传——与 capabilities/index.ts 走同一个类，只是绕开工厂的默认口径。
  const backend = new OpentronsSimulatorBackend({ python });
  const status = await backend.available();
  return { ok: status.ok, reason: status.reason };
}

export async function buildDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const config = loadConfig(options);
  const python = options.python ?? resolvePython();
  const now = options.now ?? (() => new Date());

  const probePython = options.probePython ?? defaultProbePython;
  const pythonStatus = await probePython(python);

  const simulationRoot = options.simulationRoot ?? mkdtempSync(join(tmpdir(), "spark-doctor-"));
  const probeScience = options.probeScience ?? ((py: string) => defaultProbeScience(py, simulationRoot));
  const probeLab = options.probeLab ?? defaultProbeLab;

  const [science, lab] = await Promise.all([probeScience(python), probeLab(python)]);

  const tiers: DependencyTierStatus[] = [
    {
      id: "core",
      label: "core",
      summary: "文献 / idea / novelty / 记录 / 报告（零 Python 依赖，只需要 bun）",
      available: true,
      reason: null,
    },
    {
      id: "science",
      label: "science",
      summary: "干实验仿真（openmm）",
      available: science.ok,
      reason: science.reason,
    },
    {
      id: "lab",
      label: "lab",
      summary: "湿实验模拟器（opentrons）",
      available: lab.ok,
      reason: lab.reason,
    },
  ];

  const providers: ProviderKeyStatus[] = Object.entries(PROVIDER_API_KEY_ENV)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, envVar]) => ({
      id,
      envVar,
      // AD-2 的延伸：只报"已配置/未配置"，值永不出现在这份报告里。
      configured: Boolean(env[envVar] ?? config[envVar]),
    }));

  const frontendDir = options.frontendDir ?? DEFAULT_FRONTEND_DIR;
  const frontendBuilt = existsSync(join(frontendDir, "index.html"));

  return {
    version: PACKAGE_VERSION,
    bunVersion: Bun.version,
    platform: `${process.platform}/${process.arch}`,
    python: pythonStatus,
    tiers,
    providers,
    frontendBuilt,
    frontendDir,
    dataDir: dataDir(options),
    timestamp: now().toISOString(),
  };
}
