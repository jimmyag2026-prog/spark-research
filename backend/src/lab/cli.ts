import { join } from "node:path";
import { configuredWetBackend } from "../config";
import { ExperimentLoop } from "../experiment/loop";
import { ProjectError, ProjectManager, type Project } from "../project/manager";
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

// ── V19（BACKLOG）：审批动作要求可交互终端 ────────────────────────────────────
//
// AD-9 裁定的推论：`sub_agent.ts` 已经把 `lab_approve`/`lab_simulate` 塞进
// MCP_WITHHELD（子代理走 MCP 工具面拿不到这两个动作），但那只挡住了「默认路径」——
// AD-9 明确指出这不是技术上的绕道：任何能跑 Bash 的 agent（比如这条 lane 自己）都能
// 直接 `spark-research lab approve <id> --actor "随便编的名字"`，CLI 从不区分
// 「真人在敲键盘」与「脚本在拼参数」。V10 记录的是同一个缺口的另一半：approve 的
// actor 是「谁自称就是谁」——单用户本地场景下诚实，但要让审批审计真的成立，必须先
// 有这条技术防线，不能只喊"不要自动化审批"。
//
// 判据：`process.stdin.isTTY && process.stdout.isTTY`——Node/Bun 对「这个文件描述符
// 连着真终端」的标准探测。管道（`echo yes | lab approve ...`）、重定向、子进程、
// Bash 工具调用全都是 false：piping 一个答案进 stdin 不会让 isTTY 变 true，所以
// 「伪造一次交互」本身就先过不了这一步判定，不需要额外去防「stdin 被脚本控制」这件事。
//
// 两条分支都不静默放行（AD-2/AD-9 同一套纪律：默认拒绝，旁路必须显式且留痕）：
//   ① 交互终端：必须真的在这次调用里读到一行确认——默认从真实 stdin/stdout 读
//      （node:readline），测试注入 `deps.approvalConfirm`。没有 TTY 就没有这条路可走。
//   ② 非交互环境：**默认拒绝**。需要同时满足三样都是显式给出的：
//      - `--ci-bypass-token` 等于环境变量 `SPARK_LAB_CI_BYPASS_TOKEN`
//        （必须由运维/CI 流水线的所有者显式配置——不在这里帮它兜底出任何默认值）；
//      - `--ci-bypass-reason "<理由>"`（人工写清楚为什么这次批准可以不经真人终端）；
//      这不是一条牢不可破的安全边界（拿到 shell 就能读 env），但满足「显式、留痕」的
//      最低要求：没给全就硬失败，不是静默通过；给全了，旁路的事实与理由会被拼进
//      `note`，随 decision record 一起落盘（wet_loop.ts 的 approve()/reject() 把
//      note 写进 record content 与 metadata.note 两处，是持久审计轨迹，不是打印一行
//      就丢的日志）——**在此之前不要声称审批"无法被自动化"**，这条旁路本身就是
//      技术上仍然可以被自动化的部分，只是不再是默认路径，且每一次都可追溯。
export class ApprovalGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalGateError";
  }
}

function defaultIsInteractiveTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function defaultApprovalConfirm(prompt: string): Promise<string | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

interface ApprovalGateResult {
  /** 非 null = 走了 CI 旁路，必须并入 decision record 的 note（留痕，见上面的大段注释）。 */
  bypassNote: string | null;
}

async function requireApprovalGate(
  ref: string,
  action: "approve" | "reject",
  deps: LabCliDeps,
  flags: Record<string, string | true>,
): Promise<ApprovalGateResult> {
  const isTty = deps.approvalIsInteractiveTty ? deps.approvalIsInteractiveTty() : defaultIsInteractiveTty();
  const verb = action === "approve" ? "批准" : "拒绝";

  if (isTty) {
    const confirm = deps.approvalConfirm ?? defaultApprovalConfirm;
    const answer = await confirm(
      `[V19] 即将${verb}实验 ${ref}——这是 AD-6 要求的人工判断，输入 'yes' 确认：`,
    );
    if ((answer ?? "").trim().toLowerCase() !== "yes") {
      throw new ApprovalGateError(
        `[V19] 终端交互没有收到 'yes'（收到 ${JSON.stringify(answer)}）——${verb}已取消。` +
          `批准/拒绝必须来自一次真实的交互确认，不接受静默通过。`,
      );
    }
    return { bypassNote: null };
  }

  const token = flagString(flags["ci-bypass-token"]);
  const reason = flagString(flags["ci-bypass-reason"]);
  const expected = process.env.SPARK_LAB_CI_BYPASS_TOKEN;

  if (!expected) {
    throw new ApprovalGateError(
      `[V19] 当前不是交互终端（process.stdin/stdout 不是 TTY），且未配置环境变量 ` +
        `SPARK_LAB_CI_BYPASS_TOKEN——拒绝${verb}。这是 AD-9 的技术防线：非交互环境` +
        `（脚本/CI/Bash 工具子进程）默认拿不到审批权限，不存在"跑一条命令就能${verb}"的路子。` +
        `真人请在一个真实终端里重跑本命令；CI/自动化场景需要运维显式配置 ` +
        `SPARK_LAB_CI_BYPASS_TOKEN，并在命令行显式传 --ci-bypass-token 与 --ci-bypass-reason。`,
    );
  }
  if (!token || token !== expected) {
    throw new ApprovalGateError(
      `[V19] 非交互终端下${verb}需要 --ci-bypass-token 的值与环境变量 SPARK_LAB_CI_BYPASS_TOKEN ` +
        `一致——${token ? "两者不匹配。" : "缺少 --ci-bypass-token。"}`,
    );
  }
  if (!reason) {
    throw new ApprovalGateError(
      `[V19] 非交互终端的旁路必须显式说明理由：加 --ci-bypass-reason "<为什么这次可以不经真人终端>"` +
        `——旁路要留痕进 decision record，不是静默放行。`,
    );
  }
  return {
    bypassNote: `[V19 CI 旁路：非交互终端，SPARK_LAB_CI_BYPASS_TOKEN 校验通过] ${reason}`,
  };
}

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
        project = manager.defaultProject();
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
        project = manager.defaultProject();
        const loop = makeLoop(project, deps);
        const signer = resolveActor(deps, flagString(flags.actor));
        const gate = await requireApprovalGate(ref, "approve", deps, flags);
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
        project = manager.defaultProject();
        const loop = makeLoop(project, deps);
        const signer = resolveActor(deps, flagString(flags.actor));
        const gate = await requireApprovalGate(ref, "reject", deps, flags);
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
        project = manager.defaultProject();
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
        project = manager.defaultProject();
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
