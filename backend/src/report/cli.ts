import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LibraryStore } from "../literature/library";
import { ProjectError, ProjectManager, type Project } from "../project/manager";
import { buildReport, type ResearchReport } from "./export";

// `spark-research report ...` 子命令（P8-gate G7）。

export const REPORT_HELP = `用法:
  spark-research report export [--out 文件] [--verbose] [--json]
                                        证据图 → Markdown 研究报告
                                        （问题 / 思路 / 实验 / 结论 / 待验证 + 证据索引）
                                        不给 --out 就打到 stdout
  spark-research report stats [--json]  只看统计：各类 record 与结论卡的评审状态分布

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
  const { flags } = parseArgs(rest);

  let project: Project | null = null;
  try {
    switch (sub) {
      case "export": {
        project = manager.defaultProject();
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
        project = manager.defaultProject();
        const report = reportFor(project, { now: deps.now });
        if (flags.json === true) {
          out(JSON.stringify({ project: report.project, counts: report.counts }, null, 2));
        } else {
          out(`项目 '${report.project}' 证据图统计：`);
          for (const [key, value] of Object.entries(report.counts)) out(`  ${key}: ${value}`);
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
