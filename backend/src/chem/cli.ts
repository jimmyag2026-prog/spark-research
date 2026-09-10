import { ProjectManager, type Project } from "../project/manager";
import { depictSmiles } from "./depict";

// `spark-research chem depict "<SMILES>"` —— C5-②（v0.5 W5-1-c）。
//
// 风格与 proteins/cli.ts 一致：退出码 + 注入 out/err，不直接 process.exit；
// python 可执行文件可注入（测试用桩脚本触发 rdkit_unavailable/timeout 等分支，
// 不需要真的卸载 rdkit）。

export const CHEM_HELP = `用法:
  spark-research chem depict "<SMILES>" [--name mol] [--width 400] [--height 300] [--json]
                                              SMILES → 2D 结构图（SVG）。
                                              落一条 artifact（image/svg+xml）+ 一条 computed record。
                                              非法 SMILES：报错退出，不落任何 artifact/record。
`;

export interface ChemCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // 测试注入点：换一个 python 可执行文件就能控制 rdkit_unavailable / timeout 等分支，
  // 不需要真的卸载 rdkit（与 DepictDeps.python 同一口径）。
  python?: string;
  timeoutMs?: number;
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

function flagNumber(value: string | true | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function runChemCommand(args: string[], deps: ChemCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;

  if (sub !== "depict") {
    err(CHEM_HELP);
    return 1;
  }

  const { positional, flags } = parseArgs(rest);
  const smiles = positional.join(" ").trim();
  if (!smiles) {
    err(CHEM_HELP);
    return 1;
  }

  let project: Project | null = null;
  try {
    project = manager.defaultProject();
    const result = await depictSmiles(
      {
        smiles,
        name: flagString(flags.name),
        width: flagNumber(flags.width),
        height: flagNumber(flags.height),
      },
      {
        artifacts: project.artifacts(),
        records: project.records(),
        projectSlug: project.slug,
        python: deps.python,
        timeoutMs: deps.timeoutMs,
      },
    );

    if (!result.ok) {
      // 可见的失败 + 下一步指引：kind 与 message 都原样带出来，不吞掉 depict.py 的诊断。
      err(`❌ [${result.error.kind}] ${result.error.message}`);
      return 1;
    }

    if (flags.json === true) {
      out(
        JSON.stringify(
          {
            artifactId: result.artifactId,
            recordId: result.recordId,
            canonicalSmiles: result.canonicalSmiles,
            formula: result.formula,
            molWeight: result.molWeight,
            rdkitVersion: result.rdkitVersion,
            path: result.path,
          },
          null,
          2,
        ),
      );
    } else {
      out(`✅ ${result.canonicalSmiles}（${result.formula}，MW=${result.molWeight}）`);
      out(`artifact: ${result.artifactId}`);
      out(`record: ${result.recordId}`);
    }
    return 0;
  } finally {
    project?.close();
  }
}
