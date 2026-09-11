import { join } from "node:path";
import { ProjectError, ProjectManager, type Project, openProjectResolved } from "../project/manager";
import {
  FindingsStore,
  FindingsStoreError,
  type FindingRecord,
  type FindingState,
} from "./findings_store";

// `spark-research review ...` 子命令（v0.4 P13 lane W1-b）。
// 风格与 project/lab/conclusion CLI 一致：返回退出码 + 输出走注入的 out/err。
//
// 这是「findings 状态机」对外的唯一入口——`ReviewerAgent.review()`（agent.ts，只读参考）
// 产生的一次性 Finding[] 目前还没有生产调用方把结果灌进这张表（接线是另一条 lane 的事，
// 见 docs/devlog/W1-b.md 的「未接线」说明）；这里先把存储层 + CLI 落好，CLI 本身也是
// 单元测试用来驱动「报一次 / 再报一次 / mark-addressed / 再报一次」这条状态机路径的入口。

export const REVIEW_HELP = `用法:
  spark-research review findings [--open] [--checker <id>] [--json]
                                        列出 findings。--open 只看仍需要关注的
                                        （open / reflagged）——这是 soft finding
                                        「主动查」的入口，soft finding 本身不打断会话。
  spark-research review mark-addressed <id> [--note "..."] [--actor 谁] [--json]
                                        人工标记一条 finding 为已处理，等下一轮复核：
                                        复核仍命中 → reflagged；不再命中 → resolved。

退出码 1 = 命令用错 / 找不到 finding / 状态不允许该操作。
`;

export interface ReviewCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  actor?: string;
  store?: (project: Project) => FindingsStore;
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

// 与 conclusion CLI 同一套口径（AD-6）：落到 $USER 是诚实的，但 source 要记下来。
function resolveActor(deps: ReviewCliDeps, flag: string | undefined): { actor: string; source: string } {
  if (flag) return { actor: flag, source: "explicit" };
  if (deps.actor) return { actor: deps.actor, source: "explicit" };
  if (process.env.SPARK_ACTOR) return { actor: process.env.SPARK_ACTOR, source: "env:SPARK_ACTOR" };
  if (process.env.USER) return { actor: process.env.USER, source: "env:USER" };
  return { actor: "unknown", source: "unknown" };
}

const STATE_ICON: Record<FindingState, string> = {
  open: "🔵",
  addressed: "🟡",
  resolved: "✅",
  reflagged: "⛔",
};

function printFinding(f: FindingRecord, out: (line: string) => void): void {
  out(
    `${STATE_ICON[f.state]} [${f.id.slice(0, 8)}] ${f.severity} · ${f.checker} · ${f.target.kind}:${f.target.id.slice(0, 8)}`,
  );
  out(`    ${f.state}${f.reflagCount > 0 ? ` (reflag×${f.reflagCount})` : ""} · fp=${f.fingerprint}`);
  if (f.evidence) out(`    证据: ${f.evidence}`);
  if (f.note) out(`    备注: ${f.note}`);
  out(`    首次: ${f.firstSeenAt} · 最近: ${f.lastSeenAt}${f.resolvedBy ? ` · 处理人: ${f.resolvedBy}` : ""}`);
}

// findings.db 与 records.db 是同一个 project 目录下的兄弟文件、各自独立的 SQLite 库
// （见 findings_store.ts 顶部注释：故意不共用 RecordStore 的表/db）。ProjectPaths 类型
// 本身不在本 lane 的文件所有权范围内，不新增字段，这里直接从 project.paths.root 拼路径。
function findingsDbPath(project: Project): string {
  return join(project.paths.root, "findings.db");
}

function makeStore(project: Project, deps: ReviewCliDeps): FindingsStore {
  if (deps.store) return deps.store(project);
  return new FindingsStore(findingsDbPath(project));
}

export async function runReviewCommand(args: string[], deps: ReviewCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;
  const { positional, flags } = parseArgs(rest);

  let project: Project | null = null;
  let store: FindingsStore | null = null;
  try {
    switch (sub) {
      case "findings": {
        project = openProjectResolved(manager, flagString(flags.project));
        store = makeStore(project, deps);
        const checker = flagString(flags.checker);
        const findings = store.list({ project: project.slug, open: flags.open === true, checker });
        if (flags.json === true) {
          out(JSON.stringify(findings, null, 2));
        } else if (findings.length === 0) {
          out(
            flags.open === true
              ? `项目 '${project.slug}' 没有仍需要关注的 finding。`
              : `项目 '${project.slug}' 还没有任何 finding。`,
          );
        } else {
          out(`项目 '${project.slug}' findings：${findings.length} 条`);
          for (const f of findings) printFinding(f, out);
        }
        return 0;
      }

      case "mark-addressed": {
        const id = positional[0];
        if (!id) {
          err('用法: spark-research review mark-addressed <id> [--note "..."]');
          return 1;
        }
        const noteFlag = flags.note;
        if (noteFlag === true) {
          err('❌ --note 建议带上处理说明：--note "为什么认为已经处理好了"');
        }
        project = openProjectResolved(manager, flagString(flags.project));
        store = makeStore(project, deps);
        const signer = resolveActor(deps, flagString(flags.actor));
        const updated = store.markAddressed(id, {
          note: typeof noteFlag === "string" ? noteFlag : null,
          actor: signer.actor,
        });
        if (flags.json === true) {
          out(JSON.stringify(updated, null, 2));
        } else {
          out(`🟡 addressed — [${updated.id.slice(0, 8)}] ${updated.checker}`);
          out(`  处理人：${signer.actor}（${signer.source}）`);
          out(`  下一轮复核：仍命中 → reflagged；不再命中 → resolved`);
        }
        return 0;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(REVIEW_HELP);
        return sub === undefined ? 1 : 0;

      default:
        err(`未知的 review 子命令 '${sub}'`);
        err(REVIEW_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ProjectError || error instanceof FindingsStoreError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    err(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    store?.close();
    project?.close();
  }
}
