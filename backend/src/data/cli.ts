// v0.7 W7-D2 · `spark-research data export|import|verify`（DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md §六.1）。

import { ProjectError, ProjectManager, openProjectResolved } from "../project/manager";
import { exportProject } from "./export";
import { ImportError, importExport, verifyExportDir } from "./import";

export const DATA_HELP = `用法:
  spark-research data export [--since <ts>] [--until <ts>] [--for-sharing] [--out <dir>] [--project <slug>] [--json]
                                        把项目导出成 JSONL + manifest（Hive 分区：records/type=…/date=… 等）
                                        --for-sharing  按 AD-16 过滤：upstream 打桩保边、上游 raw/文献库不出门，
                                                       被排除的计数写进 manifest.excluded
                                        增量：--since 取上次导出之后的，manifest.prevManifestHash 成链
  spark-research data import <dir> --project <新slug> [--json]
                                        把一份导出重建到一个**空**项目（验收对账/迁移用）；先核 sha256 与 rootHash
  spark-research data verify <dir>      只核导出目录的完整性

DuckDB 直查示例（导出目录下）：
  SELECT type, count(*) FROM read_json_auto('records/**/*.jsonl', union_by_name=true) GROUP BY type;
  SELECT provenance_class, license, count(*) FROM read_json_auto('records/**/*.jsonl', union_by_name=true) GROUP BY 1,2;
  SELECT kind, count(*) FROM read_json_auto('raw/**/*.jsonl', union_by_name=true) GROUP BY kind;
`;

export interface DataCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => string;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

export async function runDataCommand(args: string[], deps: DataCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;
  const { positional, flags } = parseFlags(rest);
  try {
    switch (sub) {
      case "export": {
        const project = openProjectResolved(manager, str(flags.project));
        try {
          const result = exportProject(project, {
            since: str(flags.since) ?? null,
            until: str(flags.until) ?? null,
            forSharing: flags["for-sharing"] === true,
            out: str(flags.out),
            now: deps.now,
          });
          const m = result.manifest;
          if (flags.json === true) {
            out(JSON.stringify({ dir: result.dir, manifestHash: result.manifestHash, manifest: m }, null, 2));
            return 0;
          }
          out(`✅ 已导出项目 '${m.share}' → ${result.dir}`);
          out(`   records ${Object.values(m.schemas.records.tables).reduce((a, b) => a + b, 0)}（${Object.entries(m.schemas.records.tables).map(([t, n]) => `${t} ${n}`).join(" · ")}）· edges ${m.schemas.edges.count} · journal ${m.schemas.records_journal.count}`);
          out(`   raw ${Object.entries(m.schemas.raw.tables).map(([k, n]) => `${k} ${n}`).join(" · ") || "0"} · artifacts ${m.schemas.artifacts.versions} · papers ${m.schemas.library.papers} · usage ${m.schemas.usage.present ? "有" : "无"}`);
          out(`   来源分级：${Object.entries(m.provenanceClasses).map(([c, n]) => `${c} ${n}`).join(" · ") || "（无）"}；许可：${Object.entries(m.licenses).map(([l, n]) => `${l} ${n}`).join(" · ") || "（无）"}`);
          if (m.forSharing) {
            out(`   --for-sharing（AD-16）：打桩 ${m.excluded.recordsStubbed} 条 upstream/不可共享 record · journal 打桩 ${m.excluded.journalStubbed} · 上游 raw 丢弃 ${m.excluded.rawDropped} · LLM prompt 只存 hash ${m.excluded.llmPromptsHashed} · 文献库 ${m.excluded.libraryDropped}`);
          }
          out(`   manifest hash ${result.manifestHash.slice(0, 16)}${m.prevManifestHash ? `（上一份 ${m.prevManifestHash.slice(0, 16)}）` : "（首份）"} · rootHash ${m.rootHash.slice(0, 16)}`);
          return 0;
        } finally {
          project.close();
        }
      }
      case "verify": {
        const dir = positional[0];
        if (!dir) {
          err(DATA_HELP);
          return 1;
        }
        const v = verifyExportDir(dir);
        if (!v.ok) {
          err(`❌ ${v.reason}`);
          return 1;
        }
        out(`✅ ${dir} 完整：${v.manifest.files.length} 个文件，rootHash ${v.manifest.rootHash.slice(0, 16)}，share '${v.manifest.share}'`);
        return 0;
      }
      case "import": {
        const dir = positional[0];
        const slug = str(flags.project);
        if (!dir || !slug) {
          err("用法: spark-research data import <dir> --project <新slug>");
          return 1;
        }
        const result = importExport(manager, dir, slug);
        try {
          if (flags.json === true) {
            out(JSON.stringify({ project: slug, counts: result.counts, verified: result.verified, share: result.manifest.share }, null, 2));
            return 0;
          }
          out(`✅ 已把 '${result.manifest.share}' 的导出重建到项目 '${slug}'：records ${result.counts.records} · edges ${result.counts.edges} · journal ${result.counts.journal} · raw ${result.counts.raw} · artifacts ${result.counts.artifacts} · papers ${result.counts.papers}`);
          out(`   导入后校验：journal 链 ${result.verified ? "✅" : "❌"}`);
          return result.verified ? 0 : 1;
        } finally {
          result.project.close();
        }
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(DATA_HELP);
        return sub === undefined ? 1 : 0;
      default:
        err(`未知的 data 子命令 '${sub}'`);
        err(DATA_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ProjectError || error instanceof ImportError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    throw error;
  }
}
