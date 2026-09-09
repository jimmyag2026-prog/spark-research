import { configuredSimulationPlatform } from "../config";
import { ProjectError, ProjectManager, type Project } from "../project/manager";
import { DEFAULT_SIMULATION_PLATFORM, SIMULATION_PLATFORM_IDS, SimulationRegistry } from "../simulation/registry";
import { ExperimentLoop } from "./loop";
import { EXPERIMENT_STATES, isExperimentState, type ExperimentState, type ExperimentView } from "./models";

// `spark-research exp ...` 子命令。风格与 project/cli.ts、idea/cli.ts 一致：
// 返回退出码 + 输出走注入的 out/err，便于单测；不直接 process.exit。

export const EXP_HELP = `用法:
  spark-research exp new <标题> [--platform ${SIMULATION_PLATFORM_IDS.join("|")}] [--kind K]
                         [--param k=v ...] [--hypothesis "假设"] [--json]
                                              设计一个干实验（建 experiment record，状态 design）
  spark-research exp run <id> [--resume] [--conclude "结论"] [--note "分析备注"]
                         [--timeout ms] [--json]
                                              推进闭环：dry_run → collect → analyze（可选 conclude）
                                              --resume：只接上已在跑的任务，不新提交
  spark-research exp status <id> [--json]     查看单个实验的状态、参数、摘要与状态轨迹
  spark-research exp list [--state ${EXPERIMENT_STATES.join("|")}] [--platform P] [--json]
                                              列出当前项目的实验
  spark-research exp platforms [--json]       列出仿真平台与可用性
`;

export interface ExpCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // 测试注入：跳过真实 python 探测/执行。
  platforms?: SimulationRegistry;
  loop?: (project: Project) => ExperimentLoop;
  pollIntervalMs?: number;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
  params: Record<string, unknown>;
}

// --param k=v 可重复出现，所以单独收集；其余按通用 --flag [value] 解析。
function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const params: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (name === "param" || name === "p") {
      if (next === undefined || next.startsWith("--")) throw new Error("--param 需要 k=v 形式的值");
      const eq = next.indexOf("=");
      if (eq <= 0) throw new Error(`--param 需要 k=v 形式，收到 '${next}'`);
      const key = next.slice(0, eq);
      const raw = next.slice(eq + 1);
      // 数字/布尔按字面量解析，其余当字符串；adapter 的 normalize 会再校验一次。
      params[key] = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
      i++;
      continue;
    }
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags, params };
}

function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function makeLoop(project: Project, deps: ExpCliDeps): ExperimentLoop {
  if (deps.loop) return deps.loop(project);
  return new ExperimentLoop({
    records: project.records(),
    artifacts: project.artifacts(),
    platforms: deps.platforms ?? new SimulationRegistry({ root: project.paths.experimentsDir }),
  });
}

function printView(view: ExperimentView, out: (line: string) => void): void {
  out(`[${view.id.slice(0, 8)}] ${view.title}`);
  out(
    `    ${view.state} · ${view.platform}/${view.simKind} · 第 ${view.iteration} 轮 · 提交 ${view.attempts} 次` +
      (view.runId ? ` · run ${view.runId}` : ""),
  );
  if (view.lastError) out(`    ⚠️  ${view.lastError}`);
}

export async function runExpCommand(args: string[], deps: ExpCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(rest);
  } catch (error) {
    err(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { positional, flags, params } = parsed;

  let project: Project | null = null;
  try {
    switch (sub) {
      case "new": {
        const title = positional.join(" ").trim();
        if (!title) {
          err("用法: spark-research exp new <标题> [--platform pyref] [--param k=v]");
          return 1;
        }
        project = manager.defaultProject();
        const loop = makeLoop(project, deps);
        // --platform 显式 > 用户 config.json > 代码默认（P9 配置面收口）。
        const platform = flagString(flags.platform) ?? configuredSimulationPlatform(DEFAULT_SIMULATION_PLATFORM);
        const kind = flagString(flags.kind) ?? defaultKindFor(platform, deps, project);
        const view = await loop.design({
          title,
          platform,
          kind,
          params,
          hypothesis: flagString(flags.hypothesis),
        });
        if (flags.json === true) {
          out(JSON.stringify(viewJson(view), null, 2));
        } else {
          out(`✅ 实验已建档（项目 ${project.slug}）`);
          printView(view, out);
          out(`下一步：spark-research exp run ${view.id.slice(0, 8)}`);
        }
        return 0;
      }

      case "run": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research exp run <id>");
          return 1;
        }
        project = manager.defaultProject();
        const loop = makeLoop(project, deps);
        let view = loop.get(ref);

        if (flags.resume === true) {
          // --resume 语义：只把已在跑的任务接回来，绝不重新提交。
          const resumed = await loop.resume(view.id);
          view = resumed.view;
          out(`恢复：${resumeMessage(resumed.action)}`);
          if (resumed.action === "marked_failed") {
            err(`⚠️  ${view.lastError ?? "仿真失败"}——用 spark-research exp run ${view.id.slice(0, 8)} 重试`);
            if (flags.json === true) out(JSON.stringify(viewJson(view), null, 2));
            return 1;
          }
        }

        const timeout = Number(flagString(flags.timeout) ?? "") || undefined;
        view = await loop.run(view.id, {
          timeoutMs: timeout,
          pollIntervalMs: deps.pollIntervalMs,
          analysisNote: flagString(flags.note),
          onPoll: (status) => {
            if (flags.json !== true && status.state === "running") {
              out(`  … run ${status.runId} 运行中${status.progress !== null ? ` ${(status.progress * 100).toFixed(0)}%` : ""}`);
            }
          },
        });

        const claim = flagString(flags.conclude);
        if (claim) view = loop.conclude(view.id, { claim });

        if (flags.json === true) {
          out(JSON.stringify(viewJson(view), null, 2));
        } else {
          printView(view, out);
          if (view.summary) {
            out("  摘要：");
            for (const [key, value] of Object.entries(view.summary)) out(`    ${key} = ${value}`);
          }
          if (view.observationId) out(`  observation: ${view.observationId}`);
          if (view.conclusionId) out(`  conclusion: ${view.conclusionId}（review pending）`);
        }
        return 0;
      }

      case "status": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research exp status <id>");
          return 1;
        }
        project = manager.defaultProject();
        const loop = makeLoop(project, deps);
        const view = loop.get(ref);
        const runStatus = view.runId ? await loop.poll(view.id).catch(() => null) : null;
        if (flags.json === true) {
          out(JSON.stringify({ ...viewJson(view), runStatus }, null, 2));
        } else {
          out(view.record.content);
          if (runStatus) {
            out("");
            out(`当前 run 状态：${runStatus.state}${runStatus.message ? ` — ${runStatus.message}` : ""}`);
          }
        }
        return 0;
      }

      case "list": {
        project = manager.defaultProject();
        const loop = makeLoop(project, deps);
        const stateFlag = flagString(flags.state);
        if (stateFlag && !isExperimentState(stateFlag)) {
          err(`❌ 未知状态 '${stateFlag}'（可用：${EXPERIMENT_STATES.join(", ")}）`);
          return 1;
        }
        const views = loop.list({
          state: stateFlag as ExperimentState | undefined,
          platform: flagString(flags.platform),
        });
        if (flags.json === true) {
          out(JSON.stringify(views.map(viewJson), null, 2));
        } else if (views.length === 0) {
          out(`项目 '${project.slug}' 还没有实验。用 spark-research exp new "<标题>" 开始。`);
        } else {
          out(`项目 '${project.slug}' 实验：${views.length} 条`);
          for (const view of views) printView(view, out);
        }
        return 0;
      }

      case "platforms": {
        project = manager.defaultProject();
        const registry = deps.platforms ?? new SimulationRegistry({ root: project.paths.experimentsDir });
        const list = await registry.availability();
        if (flags.json === true) {
          out(JSON.stringify(list, null, 2));
        } else {
          for (const entry of list) {
            out(`${entry.ok ? "✅" : "❌"} ${entry.id} — ${entry.description}`);
            if (!entry.ok && entry.reason) err(`   ${entry.reason}`);
          }
        }
        return list.every((entry) => !entry.ok) ? 1 : 0;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(EXP_HELP);
        return sub === undefined ? 1 : 0;

      default:
        err(`未知的 exp 子命令 '${sub}'`);
        err(EXP_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ProjectError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    err(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    project?.close();
  }
}

function defaultKindFor(platform: string, deps: ExpCliDeps, project: Project): string {
  const registry = deps.platforms ?? new SimulationRegistry({ root: project.paths.experimentsDir });
  const target = registry.get(platform) as { kinds?: readonly string[] };
  const kinds = target.kinds ?? [];
  if (kinds.length === 0) throw new Error(`平台 '${platform}' 没有可用的任务种类`);
  return kinds[0]!;
}

function viewJson(view: ExperimentView): Record<string, unknown> {
  const { record: _record, ...rest } = view;
  return rest;
}

function resumeMessage(action: "still_running" | "ready_to_collect" | "marked_failed" | "noop"): string {
  switch (action) {
    case "still_running":
      return "上一次提交的仿真仍在运行，继续等待";
    case "ready_to_collect":
      return "仿真已完成，直接回收产出";
    case "marked_failed":
      return "仿真已丢失或失败，已标记为 failed（可重试）";
    default:
      return "当前不在 dry_run 状态，无需恢复";
  }
}
