import { ProjectManager, ProjectError, type Project } from "./manager";

export const PROJECT_HELP = `用法:
  spark-research project new <slug> [--name 名称] [--desc 描述]   新建项目
  spark-research project list [--all]                            列出项目（--all 含已归档）
  spark-research project open <slug>                             打开项目并设为【全局】当前项目
  spark-research project use <slug> [--global]                   默认只把【当前会话】绑定到该项目，
                                                                    不改全局指针（V64 根治：并发会话
                                                                    互不打扰）；加 --global 才等同 open，
                                                                    改全局指针。会话身份来自 env
                                                                    SPARK_RESEARCH_SESSION——没设置这个
                                                                    环境变量时退化为改全局指针（会提示）
  spark-research project archive <slug>                          归档项目
`;

export interface ProjectCliDeps {
  manager?: ProjectManager;
  // 测试注入的工作区根目录；未给则用 ~/.spark-research（或 SPARK_RESEARCH_DATA_DIR）。
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // W7-C1（V64 根治）：`project use` 用来判定「绑定哪个会话」的 session id。
  // 测试注入优先；不注入时落 env SPARK_RESEARCH_SESSION（与 `openProjectResolved`
  // 的读取来源保持同一套，见 project/manager.ts 顶部大注释里的如实交代）。
  sessionId?: string;
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
        // S3（W5-2 末外部验收）：**建完不切当前项目，而且不说**。
        // 验收者建完新项目直接 `compute plan`，任务静默落进了一个他从没打开过的既有项目。
        // 这里补上最关键的一句下一步——`project new` 刻意不自动切换（切换是显式动作），
        // 但「不自动切换」这件事必须让用户知道，否则它就是个陷阱。
        out("");
        out(`下一步：spark-research project open ${project.slug}`);
        out("      （`project new` 不会自动切换当前项目——不 open 的话，后续命令仍然写进原来那个项目）");
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
      case "open": {
        // 不变：`open` 一直是「打开并改全局指针」的语义（向后兼容，既有脚本/文档不受影响）。
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
      case "use": {
        // W7-C1（V64 根治）：`use` 与 `open` 分家——默认只改**当前会话**的绑定
        // （`state.json.sessions[sessionId]`），不碰全局指针，这样两个并发会话各自
        // `project use` 不会再互相改写对方的落库目标。`--global` 才退回 `open` 的语义。
        const slug = positional[0];
        if (!slug) {
          err("用法: spark-research project use <slug> [--global]");
          return 1;
        }
        const project = manager.open(slug);
        const useGlobal = flags.global === true;
        const sessionId = deps.sessionId ?? process.env.SPARK_RESEARCH_SESSION;
        if (useGlobal || !sessionId) {
          manager.setCurrent(project.slug);
          if (!useGlobal) {
            // 如实标注（任务书明文要求）：没有可用的会话身份时，`use` 悄悄退化成
            // `open` 的全局语义——这里把退化的事实打印出来，不让它悄悄发生。
            out("⚠️ 未检测到会话 ID（env SPARK_RESEARCH_SESSION 未设置，也未 --global）：退化为修改全局指针");
          }
          out(`✅ 当前项目已切换为 '${project.slug}'（全局指针）`);
        } else {
          manager.bindSession(sessionId, project.slug);
          out(`✅ 会话 '${sessionId}' 已绑定到项目 '${project.slug}'（未改全局指针；加 --global 才改全局）`);
        }
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
