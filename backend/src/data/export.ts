// v0.7 W7-D2 · `spark-research data export`（DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md §六.1）。
//
// 产物只有 JSONL + manifest（用户裁定：Parquet 不做）；目录按 Hive 分区（type= / kind= / date=），
// DuckDB `read_json_auto('export/*/records/**/*.jsonl')` 直查。
//
// `--for-sharing`（AD-16）：先按 shareable() 过滤再算图闭包——被排除的 record 以 **stub** 保留
// （只有 id/type/hash/provenanceClass，无内容），边不断；journal 里指向 stub 的行整条丢弃
// （patch 里有内容）；raw 的 connector 行（upstream）整体丢弃；library（上游镜像）整体丢弃。
// 什么被排除了 manifest 里写计数，不静默。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Project } from "../project/manager";
import { LibraryStore } from "../literature/library";
import { shareable, type ProvenanceClass } from "../provenance/policy";
import { JsonlRawSink, type RawEntry } from "../raw";
import { PACKAGE_VERSION } from "../version";
import { MANIFEST_SCHEMA_VERSION, manifestHash, rootHashOf, sha256Hex, type ExportManifest } from "./manifest";

export interface ExportOptions {
  since?: string | null;
  until?: string | null;
  forSharing?: boolean;
  /** 输出目录；缺省 `<project>/export/<ISO ts>`。 */
  out?: string;
  now?: () => string;
}

export interface ExportResult {
  dir: string;
  manifest: ExportManifest;
  manifestHash: string;
}

function dateOf(ts: string): string {
  return String(ts).slice(0, 10);
}

function inRange(ts: string, since: string | null, until: string | null): boolean {
  if (since && ts < since) return false;
  if (until && ts > until) return false;
  return true;
}

class Writer {
  readonly files: Array<{ path: string; sha256: string; bytes: number }> = [];
  private buffers = new Map<string, string[]>();
  constructor(readonly root: string) {}

  line(rel: string, obj: unknown): void {
    const list = this.buffers.get(rel) ?? [];
    list.push(JSON.stringify(obj));
    this.buffers.set(rel, list);
  }

  bytes(rel: string, data: string | Uint8Array): void {
    const full = join(this.root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
    this.files.push({ path: rel, sha256: sha256Hex(data), bytes: typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength });
  }

  flush(): void {
    for (const [rel, lines] of this.buffers) this.bytes(rel, `${lines.join("\n")}\n`);
    this.buffers.clear();
  }
}

/** 上一份 manifest（同一项目 export/ 目录下最新的）——增量导出时成链。 */
export function latestManifest(project: Project): { path: string; hash: string } | null {
  const dir = join(project.paths.root, "export");
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .map((name) => join(dir, name, "manifest.json"))
    .filter((p) => existsSync(p))
    .sort();
  const last = candidates[candidates.length - 1];
  if (!last) return null;
  const manifest = JSON.parse(readFileSync(last, "utf8")) as ExportManifest;
  return { path: last, hash: manifestHash(manifest) };
}

export function exportProject(project: Project, options: ExportOptions = {}): ExportResult {
  const now = options.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const since = options.since ?? null;
  const until = options.until ?? null;
  const forSharing = options.forSharing === true;
  const dir = options.out ?? join(project.paths.root, "export", createdAt.replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const w = new Writer(dir);
  const prev = latestManifest(project);

  const records = project.records();
  const licenses: Record<string, number> = {};
  const classes: Record<string, number> = {};
  const recordTables: Record<string, number> = {};
  const excluded = { recordsStubbed: 0, journalStubbed: 0, rawDropped: 0, libraryDropped: 0 };
  const stubbed = new Set<string>();

  // ── records ──
  for (const row of records.exportRecordRows()) {
    const createdAtRow = String(row.created_at);
    if (!inRange(createdAtRow, since, until)) continue;
    const cls = String(row.provenance_class ?? "derived") as ProvenanceClass;
    const license = (row.license as string | null) ?? null;
    const { project: _project, ...rest } = row; // share 名在 manifest 里，行里不重复
    let out: Record<string, unknown> = rest;
    if (forSharing && !shareable({ provenanceClass: cls, license }).ok) {
      stubbed.add(String(row.id));
      excluded.recordsStubbed += 1;
      out = {
        id: row.id,
        type: row.type,
        created_at: row.created_at,
        rev: row.rev,
        provenance_class: cls,
        license,
        stub: true,
        content_sha256: sha256Hex(String(row.content ?? "")),
      };
    } else {
      licenses[license ?? "unknown"] = (licenses[license ?? "unknown"] ?? 0) + 1;
      classes[cls] = (classes[cls] ?? 0) + 1;
    }
    const type = String(row.type);
    recordTables[type] = (recordTables[type] ?? 0) + 1;
    w.line(`records/type=${type}/date=${dateOf(createdAtRow)}/part-0.jsonl`, out);
  }

  // ── edges（stub 也保边——买方能看到「这里引用了一篇上游论文」）──
  let edgeCount = 0;
  for (const e of records.exportEdgeRows()) {
    if (!inRange(e.created_at, since, until)) continue;
    w.line("edges/part-0.jsonl", e);
    edgeCount += 1;
  }

  // ── journal ──
  let journalCount = 0;
  for (const j of records.journalEntries()) {
    if (!inRange(j.createdAt, since, until)) continue;
    if (forSharing && stubbed.has(j.recordId)) {
      // 打桩不丢：seq/prevHash/hash 原样（链的形状保住），patch 换成骨架——内容不出门。
      // 导入侧 verifyJournal() 对 stub 行只核链不核 hash（hash 覆盖了被拿掉的 patch）。
      excluded.journalStubbed += 1;
      w.line(`records_journal/date=${dateOf(j.createdAt)}/part-0.jsonl`, { ...j, patch: { stub: true, patch_sha256: sha256Hex(JSON.stringify(j.patch)) } });
      journalCount += 1;
      continue;
    }
    w.line(`records_journal/date=${dateOf(j.createdAt)}/part-0.jsonl`, j);
    journalCount += 1;
  }

  // ── raw ──
  const rawTables: Record<string, number> = {};
  const sink = project.raw() as JsonlRawSink;
  const blobs = new Set<string>();
  for (const entry of sink.iterate()) {
    if (!inRange(entry.ts, since, until)) continue;
    if (forSharing && (entry.kind === "connector" || entry.provenanceClass === "upstream")) {
      excluded.rawDropped += 1;
      continue;
    }
    rawTables[entry.kind] = (rawTables[entry.kind] ?? 0) + 1;
    w.line(`raw/kind=${entry.kind}/date=${dateOf(entry.ts)}/part-0.jsonl`, entry);
    collectBlobs(entry, blobs);
  }
  for (const sha of blobs) {
    const text = sink.readBlob(sha);
    if (text !== null) w.bytes(`raw/blobs/${sha.slice(0, 2)}/${sha}`, text);
  }

  // ── artifacts ──
  const artifacts = project.artifacts();
  const versions = artifacts.exportVersions().filter((v) => inRange(String(v.row.created_at), since, until));
  for (const v of versions) {
    const { project: _p, project_slug: _ps, storage_path: _sp, ...rest } = v.row;
    w.line("artifacts/versions.jsonl", rest);
    if (v.contentBase64 !== null) w.bytes(`artifacts/files/${v.row.id}__${v.row.filename}`, Buffer.from(v.contentBase64, "base64"));
  }
  const deps = artifacts.exportDependencies();
  for (const d of deps) w.line("artifacts/dependencies.jsonl", d);
  const executions = artifacts.exportExecutions();
  for (const x of executions) w.line("artifacts/execution_records.jsonl", x);

  // ── library（上游镜像：for-sharing 整体不出）──
  let paperCount = 0;
  const library = new LibraryStore(project.paths.libraryDb, { records });
  try {
    for (const row of library.exportRows()) {
      if (!inRange(String(row.created_at), since, until)) continue;
      if (forSharing) {
        excluded.libraryDropped += 1;
        continue;
      }
      w.line("library/papers.jsonl", row);
      paperCount += 1;
    }
  } finally {
    library.close();
  }

  // ── usage.jsonl（无上游内容，原样带）──
  const usagePath = join(project.paths.root, "usage.jsonl");
  const usagePresent = existsSync(usagePath);
  if (usagePresent) w.bytes("usage.jsonl", readFileSync(usagePath, "utf8"));

  w.flush();
  const licenseKeys = Object.keys(licenses);
  const manifest: ExportManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    share: project.slug,
    generator: { name: "spark-research", version: PACKAGE_VERSION },
    createdAt,
    range: { since, until },
    forSharing,
    prevManifestHash: prev?.hash ?? null,
    dcat: {
      title: project.meta.name,
      description: project.meta.description,
      issued: project.meta.createdAt,
      modified: project.meta.updatedAt,
      publisher: null,
      license: licenseKeys.length === 1 ? licenseKeys[0]! : "mixed",
    },
    schemas: {
      records: { tables: recordTables },
      records_journal: { count: journalCount },
      edges: { count: edgeCount },
      raw: { tables: rawTables },
      artifacts: { versions: versions.length, dependencies: deps.length, executionRecords: executions.length },
      library: { papers: paperCount },
      usage: { present: usagePresent },
    },
    licenses,
    provenanceClasses: classes,
    excluded,
    rootHash: rootHashOf(w.files),
    files: w.files,
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifest, manifestHash: manifestHash(manifest) };
}

function collectBlobs(entry: RawEntry, into: Set<string>): void {
  const scan = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if ("blob" in (v as Record<string, unknown>) && typeof (v as { blob: unknown }).blob === "string") into.add((v as { blob: string }).blob);
    for (const x of Object.values(v as Record<string, unknown>)) scan(x);
  };
  scan(entry.payload);
}

export function relativeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, name.name);
      if (name.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}
