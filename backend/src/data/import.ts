// v0.7 W7-D2 · `spark-research data import <dir> --project <slug>`：只做「重建到空项目」，
// 用途是验收对账（G5：export → import → report diff 为空）与迁移。链式 manifest 按顺序逐份喂。
//
// 原样导入：records 行（project 列改写成目标 slug）、edges、journal（seq/hash 不重算）、raw 行
// （hash 覆盖了 project 字段，**原样保留**——链完整性优先于 slug 一致性，manifest.share 记着来源）、
// artifacts 文件与行、library 行、usage.jsonl。stub 行导入成内容为空的 record（metadata.stub=true）。

import { existsSync, readFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, ProjectManager } from "../project/manager";
import { LibraryStore } from "../literature/library";
import { JsonlRawSink, RAW_KINDS, type RawEntry } from "../raw";
import type { JournalEntry } from "../project/models";
import { manifestHash, rootHashOf, sha256Hex, type ExportManifest } from "./manifest";

export interface ImportResult {
  project: Project;
  manifest: ExportManifest;
  counts: { records: number; edges: number; journal: number; raw: number; artifacts: number; papers: number };
  /** 全部链都核过且都对得上；细节看 verification。 */
  verified: boolean;
  verification: {
    journal: { ok: boolean; lines: number; reason?: string };
    raw: Record<string, { ok: boolean; lines: number; reason?: string }>;
  };
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

function walk(dir: string, out: string[] = [], base = dir): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out, base);
    else out.push(full.slice(base.length + 1));
  }
  return out.sort();
}

/** 先核 manifest：每个文件的 sha256 与 rootHash 都对得上才导。 */
export function verifyExportDir(dir: string): { ok: boolean; reason?: string; manifest: ExportManifest } {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new ImportError(`${dir} 里没有 manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExportManifest;
  for (const f of manifest.files) {
    const full = join(dir, f.path);
    if (!existsSync(full)) return { ok: false, reason: `缺文件 ${f.path}`, manifest };
    const sha = sha256Hex(readFileSync(full));
    if (sha !== f.sha256) return { ok: false, reason: `${f.path} 的 sha256 对不上（manifest ${f.sha256.slice(0, 12)}，实际 ${sha.slice(0, 12)}）`, manifest };
  }
  if (rootHashOf(manifest.files) !== manifest.rootHash) return { ok: false, reason: "rootHash 对不上", manifest };
  return { ok: true, manifest };
}

export function importExport(manager: ProjectManager, dir: string, slug: string): ImportResult {
  const v = verifyExportDir(dir);
  if (!v.ok) throw new ImportError(`导出目录校验失败：${v.reason}`);
  const manifest = v.manifest;
  if (manager.exists(slug)) throw new ImportError(`项目 '${slug}' 已存在——import 只重建到空项目`);
  const project = manager.create(slug, { name: manifest.dcat.title, description: manifest.dcat.description });

  // records / edges / journal
  const recordRows: Array<Record<string, unknown>> = [];
  for (const rel of walk(dir).filter((p) => p.startsWith("records/") && p.endsWith(".jsonl"))) {
    for (const row of readLines<Record<string, unknown>>(join(dir, rel))) {
      if (row.stub === true) {
        recordRows.push({
          id: row.id,
          type: row.type,
          title: typeof row.title === "string" ? row.title : "",
          content: "",
          evidence: "sourced",
          origin_kind: "import",
          origin_ref: (row.origin_ref as string | null) ?? null,
          origin_connector: (row.origin_connector as string | null) ?? null,
          session_id: null,
          artifact_id: null,
          metadata: JSON.stringify({ stub: true, contentSha256: row.content_sha256 }),
          created_at: row.created_at,
          rev: row.rev,
          provenance_class: row.provenance_class,
          license: row.license,
          quality: "[]",
        });
      } else {
        recordRows.push(row);
      }
    }
  }
  recordRows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const edges = readLines<{ source_id: string; target_id: string; type: string; created_at: string }>(join(dir, "edges/part-0.jsonl"));
  const journal: JournalEntry[] = [];
  for (const rel of walk(dir).filter((p) => p.startsWith("records_journal/") && p.endsWith(".jsonl"))) journal.push(...readLines<JournalEntry>(join(dir, rel)));
  journal.sort((a, b) => a.seq - b.seq);
  const records = project.records();
  const rc = records.importRows({ records: recordRows, edges, journal });

  // raw（原样，按文件顺序 = 导出顺序）
  const sink = project.raw() as JsonlRawSink;
  let rawCount = 0;
  const rawFiles = walk(dir).filter((p) => p.startsWith("raw/kind=") && p.endsWith(".jsonl"));
  const entries: RawEntry[] = [];
  for (const rel of rawFiles) entries.push(...readLines<RawEntry>(join(dir, rel)));
  // A6 抓到的断链（V91）：此前这里按 ts 重排——同一 connector 文件里并发 append 的行 ts 可能同毫秒
  // 或非单调，重排后 prevHash 对不上原来的上一行。导出是按源文件顺序写的，导入照原顺序回放，不排序。
  for (const e of entries) {
    sink.importEntry(e);
    rawCount += 1;
  }
  const blobDir = join(dir, "raw", "blobs");
  if (existsSync(blobDir)) {
    for (const rel of walk(blobDir)) sink.writeBlob(rel.split("/").pop()!, readFileSync(join(blobDir, rel), "utf8"));
  }

  // artifacts
  const versions = readLines<Record<string, unknown>>(join(dir, "artifacts/versions.jsonl")).map((row) => {
    const filePath = join(dir, "artifacts", "files", `${row.id}__${row.filename}`);
    return { row, contentBase64: existsSync(filePath) ? readFileSync(filePath).toString("base64") : null };
  });
  const deps = readLines<{ source_version_id: string; target_version_id: string }>(join(dir, "artifacts/dependencies.jsonl"));
  const ac = versions.length > 0 ? project.artifacts().importVersions(versions, deps, slug) : 0;

  // library
  const papers = readLines<Record<string, unknown>>(join(dir, "library/papers.jsonl"));
  let pc = 0;
  if (papers.length > 0) {
    const library = new LibraryStore(project.paths.libraryDb, { records });
    try {
      pc = library.importRows(papers);
    } finally {
      library.close();
    }
  }

  // usage.jsonl
  if (existsSync(join(dir, "usage.jsonl"))) copyFileSync(join(dir, "usage.jsonl"), join(project.paths.root, "usage.jsonl"));

  // 导入后逐链复核并**逐项**报告——A6 把裸 `verified:false` 误读成「没顺带校验」；实际那次是 raw 链真断了。
  const journalCheck = records.verifyJournal();
  const raw: Record<string, { ok: boolean; lines: number; reason?: string }> = {};
  // V85：走 RAW_KINDS 单一真源而不是手抄一份 kind 列表——加 "simulation" 那天，这里
  // 自动跟上，不需要在两处同步改（V46「同一件事两份手写副本」的同款教训）。
  for (const kind of RAW_KINDS) {
    const v = sink.verify(kind);
    raw[kind] = { ok: v.ok, lines: v.lines, ...(v.reason ? { reason: v.reason } : {}) };
  }
  const verified = journalCheck.ok && Object.values(raw).every((v) => v.ok);
  return {
    project,
    manifest,
    counts: { records: rc.records, edges: rc.edges, journal: rc.journal, raw: rawCount, artifacts: ac, papers: pc },
    verified,
    verification: { journal: { ok: journalCheck.ok, lines: journalCheck.lines, ...(journalCheck.reason ? { reason: journalCheck.reason } : {}) }, raw },
  };
}

export { manifestHash };
