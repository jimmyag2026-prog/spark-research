import { ProjectManager, ProjectError, type Project } from "./manager";

export const PROJECT_HELP = `用法:
  spark-research project new <slug> [--name 名称] [--desc 描述]   新建项目
  spark-research project list [--all]                            列出项目（--all 含已归档）
  spark-research project open <slug>                             打开项目并设为当前项目
  spark-research project archive <slug>                          归档项目
`;

export interface ProjectCliDeps {
  manager?: ProjectManager;
  // 测试注入的工作区根目录；未给则用 ~/.spark-research（或 SPARK_RESEARCH_DATA_DIR）。
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
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
    if (next && !next.startsWith("--")) {
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

function describe(project: Project, out: (line: string) => void): void {
  const records = project.records();
  out(`项目 ${project.slug}（${project.meta.name}）`);
  if (project.meta.description) out(`  描述: ${project.meta.description}`);
  out(`  状态: ${project.meta.status}`);
  out(`  创建: ${project.meta.createdAt}`);
  out(`  目录: ${project.paths.root}`);
  out(`  records.db: ${project.paths.recordsDb}（${records.count()} 条 record）`);
  out(`  artifacts/: ${project.paths.artifactsDir}`);
  out(`  papers/: ${project.paths.papersDir}`);
  out(`  experiments/: ${project.paths.experimentsDir}`);
  project.close();
}

// project 子命令的实现体：返回退出码，输出通过注入的 out/err，便于单测。
export function runProjectCommand(args: string[], deps: ProjectCliDeps = {}): number {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;
  const { positional, flags } = parseFlags(rest);

  try {
    switch (sub) {
      case "new":
      case "create": {
        const slug = positional[0];
        if (!slug) {
          err("用法: spark-research project new <slug>");
          return 1;
        }
        const project = manager.create(slug, {
          name: flagString(flags.name),
          description: flagString(flags.desc) ?? flagString(flags.description),
        });
        out(`✅ 已创建项目 '${project.slug}'`);
        describe(project, out);
        return 0;
      }
      case "list":
      case "ls": {
        const metas = manager.list({ includeArchived: flags.all === true });
        if (metas.length === 0) {
          out("暂无项目。用 spark-research project new <slug> 创建。");
          return 0;
        }
        const current = manager.currentSlug();
        for (const meta of metas) {
          const mark = meta.slug === current ? "*" : " ";
          const archived = meta.status === "archived" ? " [已归档]" : "";
          out(`${mark} ${meta.slug}  ${meta.name}${archived}  创建于 ${meta.createdAt}`);
        }
        return 0;
      }
      case "open":
      case "use": {
        const slug = positional[0];
        if (!slug) {
          err("用法: spark-research project open <slug>");
          return 1;
        }
        const project = manager.open(slug);
        manager.setCurrent(project.slug);
        out(`✅ 当前项目已切换为 '${project.slug}'`);
        describe(project, out);
        return 0;
      }
      case "archive": {
        const slug = positional[0];
        if (!slug) {
          err("用法: spark-research project archive <slug>");
          return 1;
        }
        const meta = manager.archive(slug);
        out(`✅ 项目 '${meta.slug}' 已归档`);
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(PROJECT_HELP);
        return sub === undefined ? 1 : 0;
      default:
        err(`未知的 project 子命令 '${sub}'`);
        err(PROJECT_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ProjectError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    err(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
