import { join } from "node:path";
import { OpenMMPlatform } from "./openmm";
import { PyRefPlatform } from "./pyref";
import { SimulationSpecError, type SimulationPlatform } from "./models";

export const SIMULATION_PLATFORM_IDS = ["pyref", "openmm"] as const;
export type SimulationPlatformId = (typeof SIMULATION_PLATFORM_IDS)[number];

export const DEFAULT_SIMULATION_PLATFORM: SimulationPlatformId = "pyref";

export interface SimulationRegistryOptions {
  // 仿真根目录，一般是 project.paths.experimentsDir。
  root: string;
  python?: string;
}

// 平台注册表：按 id 惰性构造并缓存。每个平台一个子目录，run 状态互不干扰。
export class SimulationRegistry {
  private cache = new Map<string, SimulationPlatform>();
  private readonly root: string;
  private readonly python?: string;

  constructor(options: SimulationRegistryOptions) {
    this.root = options.root;
    this.python = options.python;
  }

  static ids(): readonly SimulationPlatformId[] {
    return SIMULATION_PLATFORM_IDS;
  }

  get(id: string): SimulationPlatform {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const options = { root: join(this.root, id), python: this.python };
    let platform: SimulationPlatform;
    switch (id) {
      case "pyref":
        platform = new PyRefPlatform(options);
        break;
      case "openmm":
        platform = new OpenMMPlatform(options);
        break;
      default:
        throw new SimulationSpecError(
          `未知仿真平台 '${id}'（可用：${SIMULATION_PLATFORM_IDS.join(", ")}）`,
        );
    }
    this.cache.set(id, platform);
    return platform;
  }

  // 逐个探测可用性；不可用的给出可操作的原因（供 CLI 直接打印）。
  async availability(): Promise<Array<{ id: string; description: string; ok: boolean; reason: string | null }>> {
    const out: Array<{ id: string; description: string; ok: boolean; reason: string | null }> = [];
    for (const id of SIMULATION_PLATFORM_IDS) {
      const platform = this.get(id);
      const status = await platform.available();
      out.push({ id, description: platform.description, ok: status.ok, reason: status.reason });
    }
    return out;
  }
}
