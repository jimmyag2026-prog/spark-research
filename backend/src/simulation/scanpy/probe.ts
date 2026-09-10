// C3 组学三件套（scanpy / pydeseq2 / cobrapy）共用的两件小事：
//   ① 探测代码生成器 `probeCodeFor`——三个平台的探测形状必须**完全一样**，
//      不同的只有装什么包；
//   ② 数据集路径参数 `datasetParam`——三个平台都吃外部数据文件，
//      而 platform.ts 的参数工具只覆盖数字/枚举/布尔。
//
// 为什么它放在 `scanpy/` 而不是 `simulation/` 顶层：W5-3 的文件所有权把本 lane 限死在
// 三个平台目录 + registry.ts 里（§三·补.8.3 的足迹表），顶层新建文件不在授权范围内。
// 收口若要把它搬去 `simulation/omics.ts`，是一次**纯移动**，没有语义要改。
//
// 三份手写副本是明确要躲的形状（V46 的教训：同一件事两份副本，单条 lane 的门禁看不见分叉），
// 所以宁可要这个别扭的 import 方向，也不要三个几乎一样的 probeCode()。

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SimulationSpecError } from "../models";

/**
 * 生成一段可用性探测代码。
 *
 * **判据只有一条：探测必须真的摸到 runner 那条路径。**
 *
 * V27 那阵的形状是这样坏的：`doctor.ts` 的 `probeCode()` 是一段与 runner 无关的内联 python
 * （`import openmm` 之类）。runner 没被解包出来、包树缺件、`sim_runtime.py` 改坏——
 * 三种情况探测都照样报「可用」，等到真提交任务才 ENOENT。**探测与真跑不是同一条路径，
 * 探测的结论就没有意义。**
 *
 * 所以这里生成的代码做三件事：用 importlib 加载 `entryPoint` **本身** →
 * 执行它的模块级 import（scanpy / pydeseq2 / cobra 全在 runner 的文件头）→ 调它的 `probe()`。
 * 任何一环坏掉都在探测阶段就红，并原样打出安装命令。
 */
export function probeCodeFor(entryPoint: string, platformId: string, installHint: string): string {
  return [
    "import importlib.util, json, sys",
    `RUNNER = ${JSON.stringify(entryPoint)}`,
    "try:",
    `    spec = importlib.util.spec_from_file_location("spark_probe_${platformId}", RUNNER)`,
    "    if spec is None or spec.loader is None:",
    "        raise ImportError('无法把 runner 当模块加载: %s' % RUNNER)",
    "    module = importlib.util.module_from_spec(spec)",
    "    spec.loader.exec_module(module)",
    "    detail = dict(module.probe())",
    "    detail['runner'] = RUNNER",
    "    print(json.dumps(detail))",
    "except Exception as exc:",
    `    sys.stderr.write('${platformId} 不可用: %s\\n' % exc)`,
    `    sys.stderr.write('安装：${installHint}\\n')`,
    "    raise SystemExit(1)",
  ].join("\n");
}

/**
 * 数据集路径参数：必填、扩展名受限、**prepare 阶段就核实文件存在**。
 *
 * 为什么在 prepare 拒而不是留给 runner：prepare 是确定性的、不起进程、不花钱，
 * 错在这里最便宜；留到 runner 里就变成一条 failed run，还要人去读 stderr 才知道
 * 只是路径打错了。
 */
export function datasetParam(
  params: Record<string, unknown>,
  name: string,
  extensions: readonly string[],
): string {
  const raw = params[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new SimulationSpecError(`参数 '${name}' 是必填的：要分析哪份数据（${extensions.join(" / ")}）`);
  }
  const value = String(raw).trim();
  const path = isAbsolute(value) ? value : resolve(value);
  if (!extensions.some((ext) => path.toLowerCase().endsWith(ext))) {
    throw new SimulationSpecError(`参数 '${name}' 的扩展名必须是 ${extensions.join(" / ")}，收到 '${value}'`);
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new SimulationSpecError(`参数 '${name}' 指向的文件不存在: ${path}`);
  }
  return path;
}
