import { ConnectorRegistry } from "../connectors/registry";
import { CredentialStore } from "../daemon/credentials";
import type { HttpClient } from "../http/client";
import { ProjectManager, type Project } from "../project/manager";
import { ProteinAnalysis, ProteinAnalysisError, type ProteinAnalysisResult } from "./analysis";

// `spark-research protein <query>` —— R-d-2（v0.4 P11 lane R-d）。
//
// 背景：protein-analysis 技能在 v0.4 制订时被发现是 10 个技能里唯一 CLI / HTTP / MCP
// 三个入口全无的一个（BACKLOG V22）——`capabilities --json` 照常把它当可用能力广播，
// 外部 agent 读了 triggers 会确信自己能调用它，实际调不到。这个文件是补的那条 CLI 入口。
//
// 风格与 lit / idea / exp 等既有域 CLI 一致：退出码 + 注入 out/err，不直接 process.exit；
// registry 可注入（测试用 fixture 回放，生产走真实网络）。

export const PROTEIN_HELP = `用法:
  spark-research protein <query> [--project P] [--no-persist] [--json]
                                              蛋白结构调研：UniProt 身份确认 → RCSB PDB 实验结构
                                              → AlphaFold 预测模型，给出「拿哪个结构去做下游计算」的判断
                                              --no-persist：只看报告，不落 observation record
`;

export interface ProteinCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // 测试注入：FixtureHttp 回放；生产走真实网络。
  http?: HttpClient;
  registry?: ConnectorRegistry;
  credentials?: CredentialStore;
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

// --json 输出：markdown 正文之外，把身份/结构/AlphaFold 的结构化字段原样给出，
// 供脚本消费（不重复渲染，直接是 ProteinAnalysisResult 的字段）。
function resultJson(result: ProteinAnalysisResult): Record<string, unknown> {
  return {
    query: result.query,
    identity: result.identity,
    experimentalStructureCount: result.experimentalStructureCount,
    structures: result.structures,
    alphafold: result.alphafold,
    recordId: result.recordId,
  };
}

export async function runProteinCommand(args: string[], deps: ProteinCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const { positional, flags } = parseArgs(args);

  const query = positional.join(" ").trim();
  if (!query) {
    err(PROTEIN_HELP);
    return 1;
  }

  const registry =
    deps.registry ??
    new ConnectorRegistry({
      http: deps.http,
      credentials: deps.credentials ?? new CredentialStore({ root: deps.root }),
    }).registerBuiltins();

  let project: Project | null = null;
  try {
    project = manager.defaultProject();
    const analysis = new ProteinAnalysis({ registry, records: project.records() });
    const persist = flags["no-persist"] !== true;
    const result = await analysis.analyze(query, { persist });

    if (flags.json === true) {
      out(JSON.stringify(resultJson(result), null, 2));
    } else {
      out(result.markdown);
      out("");
      out(result.recordId ? `observation: ${result.recordId}` : "（--no-persist：未落 observation record）");
    }
    return 0;
  } catch (error) {
    if (error instanceof ProteinAnalysisError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    project?.close();
  }
}
