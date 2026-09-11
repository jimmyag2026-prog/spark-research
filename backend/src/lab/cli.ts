import { join } from "node:path";
import { configuredWetBackend } from "../config";
import { ExperimentLoop } from "../experiment/loop";
import { ProjectError, ProjectManager, type Project, openProjectResolved } from "../project/manager";
import { SimulationRegistry } from "../simulation/registry";
import { LabSafetyError } from "./orchestrator";
import { DEFAULT_WET_BACKEND, WET_BACKEND_IDS, wetBackend, type WetLabBackend } from "./wet_backend";
import { WetLabLoop } from "./wet_loop";
import {
  ApprovalRequiredError,
  WET_EXPERIMENT_STATES,
  isWetExperimentState,
  type WetExperimentState,
  type WetExperimentView,
} from "./wet_models";

// `spark-research lab ...` 子命令（DEVELOPMENT_PLAN P6）。
// 风格与 project/cli.ts、experiment/cli.ts 一致：返回退出码 + 输出走注入的 out/err，
// 不直接 process.exit，便于单测。

export const LAB_HELP = `用法:
  spark-research lab compile "<自然语言协议>" [--title T] [--hypothesis H]
                        [--from-dry <干实验id>] [--backend ${WET_BACKEND_IDS.join("|")}] [--json]
                                        新建湿实验 → 编译成 Opentrons 协议 → 过安全门
                                        → **停在 awaiting_approval**（安全门通过 ≠ 可以执行）
  spark-research lab compile --experiment <id> [--protocol "<新协议>"] [--json]
                                        重新编译已有实验（会作废先前的 approve）
  spark-research lab approve <id> [--actor 谁] [--note 备注] [--json]
                                        人工批准执行（AD-6）。落 decision record，记协议 hash。
                                        V19：必须来自真实交互终端（会现场要求输入 'yes' 确认），
                                        非交互环境（脚本/CI/Bash 工具）默认拒绝，除非同时给出
                                        --ci-bypass-token <与 SPARK_LAB_CI_BYPASS_TOKEN 一致>
                                        与 --ci-bypass-reason "<理由>"（旁路会写进 decision record）
  spark-research lab reject <id> --reason <理由> [--actor 谁] [--json]
                                        人工拒绝。同样落 decision record，同样受 V19 终端门约束
  spark-research lab simulate <id> [--note 分析备注] [--conclude "结论"] [--json]
                                        执行湿实验（**必须已 approve**）→ 回收产出 → observation
  spark-research lab status [<id>] [--state S] [--json]
                                        不给 id 就列出本项目全部湿实验
  spark-research lab backends [--json]  列出湿实验后端与可用性
`;

export interface LabCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // 测试注入：换成 mock 后端就不需要装 opentrons。
  backend?: WetLabBackend;
  loop?: (project: Project) => WetLabLoop;
  dryLoop?: (project: Project) => ExperimentLoop;
  actor?: string;
  /**
   * V19：审批门（approve/reject）的交互终端探测。省略时用真实探测
   * `process.stdin.isTTY && process.stdout.isTTY`——测试注入以模拟「真人在一个真实
   * 终端里」（Claude Code 的 Bash 工具跑子进程，stdin/stdout 天然不是 tty，落进
   * 非交互分支，不需要特意伪装）。
   */
  approvalIsInteractiveTty?: () => boolean;
  /**
   * V19：交互终端下的确认读取。省略时用 node:readline 从真实 stdin/stdout 读一行。
   * 测试注入一个假实现，返回 Promise<string | null>（null = 没读到任何输入）。
   */
  approvalConfirm?: (prompt: string) => Promise<string | null>;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function makeLoop(project: Project, deps: LabCliDeps, backendId?: string): WetLabLoop {
  if (deps.loop) return deps.loop(project);
  return new WetLabLoop({
    records: project.records(),
    artifacts: project.artifacts(),
    root: join(project.paths.experimentsDir, "wet"),
    // 默认后端的解析顺序：--backend 显式 > 用户 config.json > 代码默认（P9 配置面收口）。
    backend: deps.backend ?? wetBackend(backendId ?? configuredWetBackend(DEFAULT_WET_BACKEND)),
  });
}

function makeDryLoop(project: Project, deps: LabCliDeps): ExperimentLoop {
  if (deps.dryLoop) return deps.dryLoop(project);
  return new ExperimentLoop({
    records: project.records(),
    artifacts: project.artifacts(),
    platforms: new SimulationRegistry({ root: project.paths.experimentsDir }),
  });
}

function viewJson(view: WetExperimentView): Record<string, unknown> {
  const { record: _record, ...rest } = view;
  return rest;
}

function printView(view: WetExperimentView, out: (line: string) => void): void {
  out(`[${view.id.slice(0, 8)}] ${view.title}`);
  out(
    `    ${view.state} · ${view.backend} · 第 ${view.iteration} 轮 · 执行 ${view.attempts} 次` +
      (view.protocolHash ? ` · hash ${view.protocolHash}` : ""),
  );
  if (view.approval) out(`    ✅ ${view.approval.actor} @ ${view.approval.at} 批准 ${view.approval.protocolHash}`);
  if (view.rejection) out(`    ❌ ${view.rejection.actor} 拒绝：${view.rejection.reason}`);
  if (view.lastError) out(`    ⚠️  ${view.lastError}`);
  // D-8：approve 之前最后一次看到这份实验的地方也必须提醒——批准是人的判断，
  // 判断的输入里不能漏掉「安全门根本没看见」这部分。
  for (const warning of view.unconsumedWarnings) out(`    🚨 未被安全门消费：${warning}`);
}

function resolveActor(deps: LabCliDeps, flag: string | undefined): { actor: string; source: string } {
  // 落到 $USER 是诚实的：**就是**这个人在这台机器上敲的命令。
  // record 里记下 source，审计时能分清「显式署名」与「取自环境」。
  if (flag) return { actor: flag, source: "explicit" };
  if (deps.actor) return { actor: deps.actor, source: "explicit" };
  if (process.env.SPARK_ACTOR) return { actor: process.env.SPARK_ACTOR, source: "env:SPARK_ACTOR" };
  if (process.env.USER) return { actor: process.env.USER, source: "env:USER" };
  return { actor: "unknown", source: "unknown" };
}

// ── V19：审批动作要求可交互终端 ─────────────────────────────────────────────
//
// W5-2 β：这道门原本整段写在本文件（`lab/cli.ts:150-251`）。算力审批（`compute approve`）
// 花的是真钱，与湿实验「动物理世界」同构，必须受**同一道**门约束——复制一份是最坏的
// 做法（两份实现会各自漂移，而漂移的方向永远是「新的那份更松」）。所以整段搬进
// `backend/src/approval/gate.ts`，lab 与 compute 共用同一份代码；本文件只保留调用点。
// 判据、两条分支、四种拒绝理由、bypassNote 形状**一字未改**，只把三处名词参数化
// （tag / 旁路 env 名 / 被审批对象的称呼）——见 gate.ts 顶部的大段注释。
import {
  ApprovalGateError,
  LAB_APPROVAL_GATE,
  requireApprovalGate,
} from "../approval/gate";

export { ApprovalGateError };

function mergeNote(userNote: string | undefined, bypassNote: string | null): string | undefined {
  const parts = [userNote, bypassNote ?? undefined].filter((p): p is string => Boolean(p && p.length > 0));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export async function runLabCommand(args: string[], deps: LabCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;
  const { positional, flags } = parseArgs(rest);

  let project: Project | null = null;
  try {
    switch (sub) {
      case "compile": {
        project = openProjectResolved(manager, flagString(flags.project));
        const loop = makeLoop(project, deps, flagString(flags.backend));
        const existingRef = flagString(flags.experiment);
        let view: WetExperimentView;
        if (existingRef) {
          const compiled = loop.compile(existingRef, { naturalLanguage: flagString(flags.protocol) });
          view = compiled.view;
        } else {
          const naturalLanguage = positional.join(" ").trim();
          if (!naturalLanguage) {
            err('用法: spark-research lab compile "<自然语言协议>" [--title T]');
            return 1;
          }
          const fromDry = flagString(flags["from-dry"]);
          const title = flagString(flags.title) ?? naturalLanguage.slice(0, 32);
          if (fromDry) {
            const derived = await loop.deriveFromDry(makeDryLoop(project, deps), fromDry, {
              title,
              naturalLanguage,
              hypothesis: flagString(flags.hypothesis),
            });
            out(`🔗 干实验 ${fromDry.slice(0, 8)} → ${derived.dry.state}，派生湿实验 ${derived.wet.id.slice(0, 8)}`);
            view = derived.wet;
          } else {
            view = loop.design({
              title,
              naturalLanguage,
              hypothesis: flagString(flags.hypothesis),
            });
          }
          view = loop.compile(view.id).view;
        }

        // 编译完立刻过安全门。通过就停在 awaiting_approval —— 绝不自动执行。
        let report;
        try {
          const checked = loop.safetyCheck(view.id);
          view = checked.view;
          report = checked.report;
        } catch (error) {
          if (error instanceof LabSafetyError) {
            const blocked = error.report.checks.filter((c) => !c.passed);
            err(`🚫 安全门拦截（实验 ${view.id.slice(0, 8)} 已标记 failed）：`);
            for (const check of blocked) err(`   ❌ ${check.check} — ${check.detail ?? "无详情"}`);
            if (flags.json === true) {
              out(JSON.stringify({ ...viewJson(loop.get(view.id)), safetyReport: error.report }, null, 2));
            }
            return 1;
          }
          throw error;
        }

        if (flags.json === true) {
          out(JSON.stringify({ ...viewJson(view), safetyReport: report }, null, 2));
        } else {
          out(`✅ 编译完成（项目 ${project.slug}）`);
          printView(view, out);
          for (const check of report.checks) {
            out(`    安全门 ✅ ${check.check}${check.detail ? ` — ${check.detail}` : ""}`);
          }
          for (const warning of view.compileWarnings) out(`    ⚠️  ${warning}`);
          // D-8：**必须显示**——安全门没看见的信号不能只在 JSON 里才翻得到。
          if (view.unconsumedWarnings.length > 0) {
            out("");
            out("🚨 以下内容安全门没有看见（编译器识别到了信号，但没有规则消费它）：");
            for (const warning of view.unconsumedWarnings) out(`    🚨 ${warning}`);
          }
          out("");
          out(`⏸  安全门通过 ≠ 可以执行。下一步需要**人工确认**（AD-6）：`);
          out(`   spark-research lab approve ${view.id.slice(0, 8)} --actor <你的名字>`);
        }
        return 0;
      }

      case "approve": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research lab approve <id> [--actor 谁]");
          return 1;
        }
        project = openProjectResolved(manager, flagString(flags.project));
        const loop = makeLoop(project, deps);
        const signer = resolveActor(deps, flagString(flags.actor));
        const gate = await requireApprovalGate(LAB_APPROVAL_GATE, ref, "approve", deps, flags);
        const { view, decisionId } = loop.approve(ref, {
          actor: signer.actor,
          actorSource: signer.source,
          note: mergeNote(flagString(flags.note), gate.bypassNote),
        });
        if (flags.json === true) {
          out(JSON.stringify({ ...viewJson(view), decisionId }, null, 2));
        } else {
          out(`✅ 已批准（decision record ${decisionId.slice(0, 8)}）`);
          printView(view, out);
          out(`下一步：spark-research lab simulate ${view.id.slice(0, 8)}`);
        }
        return 0;
      }

      case "reject": {
        const ref = positional[0];
        const reason = flagString(flags.reason);
        if (!ref || !reason) {
          err("用法: spark-research lab reject <id> --reason <理由>");
          return 1;
        }
        project = openProjectResolved(manager, flagString(flags.project));
        const loop = makeLoop(project, deps);
        const signer = resolveActor(deps, flagString(flags.actor));
        const gate = await requireApprovalGate(LAB_APPROVAL_GATE, ref, "reject", deps, flags);
        const { view, decisionId } = loop.reject(ref, {
          actor: signer.actor,
          actorSource: signer.source,
          reason: mergeNote(reason, gate.bypassNote) ?? reason,
        });
        if (flags.json === true) {
          out(JSON.stringify({ ...viewJson(view), decisionId }, null, 2));
        } else {
          out(`❌ 已拒绝（decision record ${decisionId.slice(0, 8)}）`);
          printView(view, out);
        }
        return 0;
      }

      case "simulate": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research lab simulate <id>");
          return 1;
        }
        project = openProjectResolved(manager, flagString(flags.project));
        const loop = makeLoop(project, deps);
        let view = await loop.execute(ref, { note: flagString(flags.note) });
        view = loop.analyze(view.id, { note: flagString(flags.note) });
        const claim = flagString(flags.conclude);
        if (claim) view = loop.conclude(view.id, { claim });

        if (flags.json === true) {
          out(JSON.stringify(viewJson(view), null, 2));
        } else {
          printView(view, out);
          if (view.summary) {
            out("  run log 摘要：");
            for (const [key, value] of Object.entries(view.summary)) out(`    ${key} = ${value}`);
          }
          if (view.observationId) out(`  observation: ${view.observationId}（evidence=observed）`);
          if (view.conclusionId) out(`  conclusion: ${view.conclusionId}（review pending）`);
        }
        return 0;
      }

      case "status": {
        project = openProjectResolved(manager, flagString(flags.project));
        const loop = makeLoop(project, deps);
        const ref = positional[0];
        if (ref) {
          const view = loop.get(ref);
          if (flags.json === true) out(JSON.stringify(viewJson(view), null, 2));
          else out(view.record.content);
          return 0;
        }
        const stateFlag = flagString(flags.state);
        if (stateFlag && !isWetExperimentState(stateFlag)) {
          err(`❌ 未知状态 '${stateFlag}'（可用：${WET_EXPERIMENT_STATES.join(", ")}）`);
          return 1;
        }
        const views = loop.list({ state: stateFlag as WetExperimentState | undefined });
        if (flags.json === true) {
          out(JSON.stringify(views.map(viewJson), null, 2));
        } else if (views.length === 0) {
          out(`项目 '${project.slug}' 还没有湿实验。用 spark-research lab compile "<协议>" 开始。`);
        } else {
          out(`项目 '${project.slug}' 湿实验：${views.length} 条`);
          for (const view of views) printView(view, out);
        }
        return 0;
      }

      case "backends": {
        const entries: Array<{ id: string; description: string; ok: boolean; reason: string | null }> = [];
        for (const id of WET_BACKEND_IDS) {
          const backend = deps.backend && deps.backend.id === id ? deps.backend : wetBackend(id);
          const status = await backend.available();
          entries.push({ id, description: backend.description, ok: status.ok, reason: status.reason });
        }
        if (flags.json === true) {
          out(JSON.stringify(entries, null, 2));
        } else {
          for (const entry of entries) {
            out(
              `${entry.ok ? "✅" : "❌"} ${entry.id}${entry.id === DEFAULT_WET_BACKEND ? "（默认）" : ""} — ${entry.description}`,
            );
            if (!entry.ok && entry.reason) err(`   ${entry.reason}`);
          }
        }
        return entries.some((e) => e.ok) ? 0 : 1;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(LAB_HELP);
        return sub === undefined ? 1 : 0;

      default:
        err(`未知的 lab 子命令 '${sub}'`);
        err(LAB_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ApprovalGateError) {
      // V19：终端门没过——不是「协议/状态机不允许」，是「这次调用没有可信的人工确认」。
      err(`🚫 ${error.message}`);
      return 1;
    }
    if (error instanceof ApprovalRequiredError) {
      // approve gate 被绕过：这是最该被看见的一类错误，单独给一段可操作的提示。
      err(`🚫 ${error.message}`);
      return 1;
    }
    if (error instanceof LabSafetyError) {
      err(`🚫 ${error.message}`);
      return 1;
    }
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
