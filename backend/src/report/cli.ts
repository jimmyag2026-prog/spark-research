import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LibraryStore } from "../literature/library";
import { RECORD_TYPES, type RecordFilter, type RecordType } from "../project/models";
import { RecordValidationError } from "../project/records";
import { ProjectError, ProjectManager, type Project, openProjectResolved } from "../project/manager";
import { buildReport, type ResearchReport } from "./export";

// `spark-research report ...` 子命令（P8-gate G7 + S11：证据图可见性）。

export const REPORT_HELP = `用法:
  spark-research report export [--out 文件] [--verbose] [--json]
                                        证据图 → Markdown 研究报告
                                        （问题 / 思路 / 实验 / 结论 / 待验证 + 证据索引）
                                        不给 --out 就打到 stdout
  spark-research report stats [--json]  只看统计：各类 record 与结论卡的评审状态分布
  spark-research report records [--type <t>] [--limit N] [--json]
  spark-research report records --history <recordId> [--json]
                                        某条 record 的 append-only 日志（create/update/link/tombstone/repair）
  spark-research report records --repair <recordId> --to-seq <N> --actor <署名>
                                        按日志把投影重建到第 N 步（V24 恢复路径，落 op=repair 日志）
                                        列出证据图里的原始 record（含 artifact）——
                                        不用开 sqlite 就能回答「它进证据图了吗」
                                        --type 按类型过滤（${RECORD_TYPES.join(" / ")}）
  spark-research report show <recordId> [--json]
                                        单条 record 详情 + 它的入边/出边（edgesOf）

结论区只收录 review 为 approved 的结论卡（\`spark-research conclusion review <id>\`）；
pending / vetoed 一律进「待验证」区，并列出阻塞它的 hard finding。
`;

export interface ReportCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // 测试注入：固定生成时间，报告才有可比对的确定性输出。
  now?: string;
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

// 报告要不要带参考文献区，取决于文献库能不能打开。打不开就少一节，不让整份报告失败。
export function reportFor(project: Project, options: { verbose?: boolean; now?: string } = {}): ResearchReport {
  let library: LibraryStore | null = null;
  try {
    library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    return buildReport({
      meta: project.meta,
      records: project.records(),
      papers: library.list(),
      generatedAt: options.now,
      verbose: options.verbose,
    });
  } finally {
    library?.close();
  }
}

export async function runReportCommand(args: string[], deps: ReportCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;
  const { flags, positional } = parseArgs(rest);

  let project: Project | null = null;
  // R1-P0：--project 显式覆盖（同 literature/ideation CLI——全局项目指针并发会话下
  // 会互相改写）。四个 case 原来各写一遍 defaultProject()，这里收成单点。
  const resolveProject = (): Project => {
    const slug = flagString(flags.project);
    return openProjectResolved(manager, slug);
  };
  try {
    // V39 家族（R2-T2 点名）：`report export --help` 此前真的执行导出。与 lit 同款：
    // 在 switch 之前统一拦截，对新加子命令一视同仁。
    if (rest.includes("--help") || rest.includes("-h")) {
      out(REPORT_HELP);
      return 0;
    }
    switch (sub) {
      case "export": {
        project = resolveProject();
        const report = reportFor(project, { verbose: flags.verbose === true, now: deps.now });
        const target = flagString(flags.out);
        if (flags.json === true) {
          out(
            JSON.stringify(
              {
                project: report.project,
                title: report.title,
                generatedAt: report.generatedAt,
                counts: report.counts,
                recordIds: report.recordIds,
                markdown: report.markdown,
              },
              null,
              2,
            ),
          );
          return 0;
        }
        if (target) {
          const path = resolve(target);
          writeFileSync(path, report.markdown);
          out(`✅ 报告已写入 ${path}`);
          out(
            `   结论 ${report.counts.approvedConclusions} 条通过 / ` +
              `${report.counts.unverifiedConclusions} 条待验证 · 引用 ${report.recordIds.length} 条 record`,
          );
          if (report.counts.approvedConclusions === 0 && report.counts.unverifiedConclusions > 0) {
            err("⚠️  结论区是空的：所有结论卡都还没通过 review（spark-research conclusion review <id>）");
          }
          return 0;
        }
        out(report.markdown);
        return 0;
      }

      case "stats": {
        project = resolveProject();
        const report = reportFor(project, { now: deps.now });
        if (flags.json === true) {
          out(JSON.stringify({ project: report.project, counts: report.counts }, null, 2));
        } else {
          out(`项目 '${report.project}' 证据图统计：`);
          for (const [key, value] of Object.entries(report.counts)) out(`  ${key}: ${value}`);
        }
        return 0;
      }

      // S11（外部验收 2 里最要紧的一条）：验收者为回答「它到底进没进证据图」，
      // 猜了 records/record/graph 三个命令名都不是，最后只能自己开 sqlite 查
      // `records.db`。这里补上——`RecordStore.list()`/`get()`/`edgesOf()` 都是
      // 既有只读 API（`backend/src/project/records.ts`，本 lane 不改它），
      // 只是之前没有 CLI 出口。
      case "records": {
        project = resolveProject();
        const records = project.records();
        // v0.7 W7-D1：日志视图与恢复入口（V24）。`--history <id>` 只读；`--repair <id> --to-seq N --actor X`
        // 把投影重建到日志第 N 步——需要署名，落一行 op=repair 日志，不删任何历史。
        const historyId = flagString(flags.history);
        if (historyId !== undefined) {
          if (!records.get(historyId)) {
            err(`❌ record '${historyId}' 不存在`);
            return 1;
          }
          const entries = records.history(historyId);
          if (flags.json === true) {
            out(JSON.stringify({ project: project.meta.slug, recordId: historyId, entries }, null, 2));
            return 0;
          }
          out(`record ${historyId.slice(0, 8)} 的日志：${entries.length} 条（append-only，prevHash 成链）`);
          for (const e of entries) {
            const who = e.actor ? ` · ${e.actor}` : "";
            const rev = e.revBefore === null && e.revAfter === null ? "" : ` rev ${e.revBefore ?? "-"}→${e.revAfter ?? "-"}`;
            out(`  #${String(e.seq).padStart(4)}  ${e.op.padEnd(9)}${rev}${who}  ${e.createdAt}  ${JSON.stringify(e.patch).slice(0, 80)}`);
          }
          return 0;
        }
        const repairId = flagString(flags.repair);
        if (repairId !== undefined) {
          const toSeq = Number(flagString(flags["to-seq"]));
          const actor = flagString(flags.actor);
          if (!Number.isInteger(toSeq) || toSeq < 1 || !actor) {
            err("用法: spark-research report records --repair <recordId> --to-seq <N> --actor <署名>");
            return 1;
          }
          try {
            const repaired = records.repair(repairId, { toSeq, actor });
            out(`✅ record ${repairId.slice(0, 8)} 已按日志重建到 #${toSeq}（署名 ${actor}）；投影 rev 已 +1，日志新增一行 op=repair`);
            out(`   标题：${repaired.title}`);
            return 0;
          } catch (error) {
            if (error instanceof RecordValidationError) {
              err(`❌ ${error.message}`);
              return 1;
            }
            throw error;
          }
        }
        const typeFlag = flagString(flags.type);
        if (typeFlag !== undefined && !RECORD_TYPES.includes(typeFlag as RecordType)) {
          err(`❌ 未知的 record 类型 '${typeFlag}'（可选：${RECORD_TYPES.join(" / ")}）`);
          return 1;
        }
        let limit: number | undefined;
        const limitFlag = flagString(flags.limit);
        if (limitFlag !== undefined) {
          const n = Number(limitFlag);
          if (!Number.isInteger(n) || n < 1) {
            err(`❌ --limit 必须是正整数，收到 '${limitFlag}'`);
            return 1;
          }
          limit = n;
        }
        const countFilter: RecordFilter = typeFlag ? { type: typeFlag as RecordType } : {};
        const total = records.count(countFilter);
        const listFilter: RecordFilter = { ...countFilter };
        if (limit) listFilter.limit = limit;
        const list = records.list(listFilter);
        if (flags.json === true) {
          out(JSON.stringify({ project: project.meta.slug, total, shown: list.length, records: list }, null, 2));
          return 0;
        }
        if (list.length === 0) {
          out(
            typeFlag
              ? `项目 '${project.meta.slug}' 里没有类型为 '${typeFlag}' 的 record。`
              : `项目 '${project.meta.slug}' 里还没有任何 record。`,
          );
          return 0;
        }
        out(
          `项目 '${project.meta.slug}' 的 record${typeFlag ? `（类型=${typeFlag}）` : ""}：共 ${total} 条` +
            (limit && total > list.length ? `，本次显示前 ${list.length} 条（加 --limit 看更多）` : ""),
        );
        for (const record of list) {
          const artifactSuffix = record.artifactId ? ` · artifact ${record.artifactId.slice(0, 8)}` : "";
          out(
            `  ${record.id.slice(0, 8)}  ${record.type.padEnd(10)} ${record.evidence.padEnd(9)} ` +
              `${record.title}${artifactSuffix}`,
          );
        }
        out("");
        out("单条详情（含入边/出边）：spark-research report show <recordId>（上面的短 id 或完整 id 都行）");
        return 0;
      }

      case "show": {
        const recordId = positional[0];
        if (!recordId) {
          err("用法: spark-research report show <recordId> [--json]");
          return 1;
        }
        project = resolveProject();
        const records = project.records();
        const record = records.get(recordId);
        if (!record) {
          err(
            `❌ record '${recordId}' 不存在——检查 id 是否完整或有拼写误差。` +
              `\`spark-research report records\` 能列出项目里的全部 record 及其 id。`,
          );
          return 1;
        }
        const edges = records.edgesOf(record.id);
        if (flags.json === true) {
          out(JSON.stringify({ record, edges }, null, 2));
          return 0;
        }
        out(`record ${record.id}`);
        out(`  类型 ${record.type} · 证据标签 ${record.evidence} · 创建于 ${record.createdAt}`);
        out(`  标题 ${record.title}`);
        if (record.artifactId) out(`  artifact ${record.artifactId}`);
        out(
          `  来源 ${record.origin.kind}` +
            (record.origin.ref ? ` · ref ${record.origin.ref}` : "") +
            (record.origin.sessionId ? ` · session ${record.origin.sessionId}` : "") +
            (record.origin.connector ? ` · connector ${record.origin.connector}` : ""),
        );
        if (Object.keys(record.metadata).length > 0) {
          out(`  metadata ${JSON.stringify(record.metadata)}`);
        }
        out("");
        out(record.content);
        out("");
        if (edges.outgoing.length > 0) {
          out(`出边（${edges.outgoing.length}）：`);
          for (const e of edges.outgoing) out(`  ${record.id.slice(0, 8)} --${e.type}--> ${e.targetId}`);
        }
        if (edges.incoming.length > 0) {
          out(`入边（${edges.incoming.length}）：`);
          for (const e of edges.incoming) out(`  ${e.sourceId} --${e.type}--> ${record.id.slice(0, 8)}`);
        }
        if (edges.outgoing.length === 0 && edges.incoming.length === 0) {
          out("（这条 record 目前没有边——没被别的 record 引用，也没引用别的 record）");
        }
        return 0;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(REPORT_HELP);
        return sub === undefined ? 1 : 0;

      default:
        err(`未知的 report 子命令 '${sub}'`);
        err(REPORT_HELP);
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
