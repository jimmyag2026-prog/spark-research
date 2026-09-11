import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// V27：同 project/records.ts —— schema 走静态 import，编译期进二进制。
import SCHEMA_SQL from "./schema.sql" with { type: "text" };
import type {
  ArtifactVersion,
  DependencyEdge,
  DependencyMapping,
  ExecutionRecord,
  LineageMessage,
} from "./models";
import { LineageGraph, type VersionMeta } from "./lineage";
import { slugify } from "../project/slug";

// 只依赖「能把自由字符串解析成真实 project slug」这一能力，
// 用结构化接口而非直接 import ProjectManager，避免 project ↔ artifacts 循环依赖。
export interface ProjectRefResolver {
  resolveRef(raw: string): string | null;
}

export interface ArtifactStoreOptions {
  // 绑定到某个真实 project 时的默认 slug（Project.artifacts() 会传）。
  projectSlug?: string;
  // 可选解析器：把 save() 传入的自由字符串解析成真实 project 引用。
  projects?: ProjectRefResolver;
}

interface ArtifactRow {
  id: string;
  project: string;
  project_slug: string | null;
  filename: string;
  version: number;
  content_type: string;
  checksum: string;
  storage_path: string;
  extracted_code: string | null;
  code_description: string | null;
  lineage_messages: string;
  environment_snapshot: string | null;
  parent_version_id: string | null;
  producing_cell_id: string | null;
  dependency_mappings: string;
  created_at: string;
}

interface ExecRow {
  id: string;
  frame: string;
  cell_index: number;
  kernel_id: string | null;
  language: string;
  source: string;
  stdout: string;
  stderr: string;
  status: string;
  files_written: string;
  files_read: string;
  wall_time: number | null;
  cpu_time: number | null;
  peak_memory: number | null;
  created_at: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".py": "text/x-python",
  ".ipynb": "application/x-ipynb+json",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".json": "application/json",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".r": "text/x-r",
  ".jl": "text/x-julia",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

function contentTypeFor(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function mapRow(row: ArtifactRow): ArtifactVersion {
  return {
    id: row.id,
    project: row.project,
    projectSlug: row.project_slug ?? null,
    filename: row.filename,
    version: row.version,
    contentType: row.content_type,
    checksum: row.checksum,
    storagePath: row.storage_path,
    extractedCode: row.extracted_code,
    codeDescription: row.code_description,
    lineageMessages: JSON.parse(row.lineage_messages),
    environmentSnapshot: row.environment_snapshot ? JSON.parse(row.environment_snapshot) : null,
    parentVersionId: row.parent_version_id,
    producingCellId: row.producing_cell_id,
    dependencyMappings: JSON.parse(row.dependency_mappings),
    createdAt: row.created_at,
  };
}

function mapExecRow(row: ExecRow): ExecutionRecord {
  return {
    id: row.id,
    frame: row.frame,
    cellIndex: row.cell_index,
    kernelId: row.kernel_id,
    language: row.language,
    source: row.source,
    stdout: row.stdout,
    stderr: row.stderr,
    status: row.status,
    filesWritten: JSON.parse(row.files_written),
    filesRead: JSON.parse(row.files_read),
    wallTime: row.wall_time,
    cpuTime: row.cpu_time,
    peakMemory: row.peak_memory,
    createdAt: row.created_at,
  };
}

// 持久化方案：Bun 内置 bun:sqlite（Database，零额外依赖，better-sqlite3 未安装故不用），
// 元数据存 SQLite，文件本体落盘到 storageDir；schema 见同目录 schema.sql。
export class ArtifactStore {
  private db: Database;
  private storageDir: string;
  private projectSlug?: string;
  private projects?: ProjectRefResolver;

  constructor(dbPath: string, storageDir: string, options: ArtifactStoreOptions = {}) {
    this.storageDir = resolve(storageDir);
    mkdirSync(this.storageDir, { recursive: true });
    this.projectSlug = options.projectSlug;
    this.projects = options.projects;
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;"); // V80（v0.7 C-4）
    this.initSchema();
  }

  initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  // P1 迁移：老库没有 project_slug 列，补列并用旧的自由字符串回填，保证旧数据不炸。
  private migrate(): void {
    const columns = this.db.query("PRAGMA table_info(artifacts)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "project_slug")) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN project_slug TEXT");
      const rows = this.db.query("SELECT id, project FROM artifacts").all() as {
        id: string;
        project: string;
      }[];
      const update = this.db.query("UPDATE artifacts SET project_slug = ? WHERE id = ?");
      for (const row of rows) update.run(this.resolveProjectSlug(row.project), row.id);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_project_slug ON artifacts (project_slug)");
  }

  // 自由字符串 → 真实 project 引用：有解析器就问解析器，否则退回 slug 归一化；都不行则 null。
  private resolveProjectSlug(project: string): string | null {
    return this.projects?.resolveRef(project) ?? slugify(project);
  }

  save(
    filePath: string,
    code: string,
    messages: LineageMessage[],
    env: Record<string, unknown> | null,
    project: string = this.projectSlug ?? "default",
  ): ArtifactVersion & { content: string } {
    const filename = basename(filePath);
    const content = readFileSync(filePath);
    const checksum = createHash("sha256").update(content).digest("hex");
    const id = randomUUID();
    const storagePath = join(this.storageDir, `${id}__${filename}`);
    copyFileSync(filePath, storagePath);

    const latest = this.getRawLatest(project, filename);
    const version = latest ? latest.version + 1 : 1;

    const sessionId = env?.sessionId;
    const cellIndex = env?.cellIndex;
    const producingCellId =
      typeof sessionId === "string"
        ? typeof cellIndex === "number"
          ? `${sessionId}:${cellIndex}`
          : sessionId
        : null;

    const { mappings, edges } = this.resolveDependencies(id, project, filename, messages);

    this.db
      .query(
        `INSERT INTO artifacts
         (id, project, project_slug, filename, version, content_type, checksum, storage_path,
          extracted_code, code_description, lineage_messages, environment_snapshot,
          parent_version_id, producing_cell_id, dependency_mappings, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        project,
        this.resolveProjectSlug(project),
        filename,
        version,
        contentTypeFor(filename),
        checksum,
        storagePath,
        code,
        null,
        JSON.stringify(messages ?? []),
        JSON.stringify(env ?? null),
        latest?.id ?? null,
        producingCellId,
        JSON.stringify(mappings),
        new Date().toISOString(),
      );

    const insertEdge = this.db.query(
      "INSERT OR IGNORE INTO dependencies (source_version_id, target_version_id) VALUES (?, ?)",
    );
    for (const e of edges) insertEdge.run(e.sourceVersionId, e.targetVersionId);

    return this.get(id)!;
  }

  get(versionId: string): (ArtifactVersion & { content: string }) | null {
    const row = this.db.query("SELECT * FROM artifacts WHERE id = ?").get(versionId) as
      | ArtifactRow
      | null;
    if (!row) return null;
    return { ...mapRow(row), content: readFileSync(row.storage_path, "utf8") };
  }

  listByProject(project: string): ArtifactVersion[] {
    const rows = this.db
      .query("SELECT * FROM artifacts WHERE project = ? ORDER BY created_at, version")
      .all(project) as ArtifactRow[];
    return rows.map(mapRow);
  }

  // 按真实 project 引用查询（P1 起）；旧数据回填过 project_slug，故一并可查。
  listByProjectSlug(slug: string): ArtifactVersion[] {
    const rows = this.db
      .query("SELECT * FROM artifacts WHERE project_slug = ? ORDER BY created_at, version")
      .all(slug) as ArtifactRow[];
    return rows.map(mapRow);
  }

  // producingCellId 约定为 `${sessionId}:${cellIndex}`，故按前缀匹配 session。
  listBySession(sessionId: string): ArtifactVersion[] {
    const rows = this.db
      .query(
        "SELECT * FROM artifacts WHERE producing_cell_id = ? OR producing_cell_id LIKE ? ORDER BY created_at",
      )
      .all(sessionId, `${sessionId}:%`) as ArtifactRow[];
    return rows.map(mapRow);
  }

  getLineageGraph(versionId: string): ReturnType<LineageGraph["getGraph"]> {
    return this.buildGraph().getGraph(versionId);
  }

  // ── v0.7 W7-D2 · 导出/导入 ─────────────────────────────────────────────────
  /** 全部版本原样行 + 文件内容（base64，二进制安全）。 */
  exportVersions(): Array<{ row: Record<string, unknown>; contentBase64: string | null }> {
    const rows = this.db.query("SELECT * FROM artifacts ORDER BY created_at, version").all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const path = row.storage_path as string;
      const contentBase64 = existsSync(path) ? readFileSync(path).toString("base64") : null;
      return { row, contentBase64 };
    });
  }

  exportDependencies(): Array<{ source_version_id: string; target_version_id: string }> {
    return this.db.query("SELECT * FROM dependencies").all() as Array<{ source_version_id: string; target_version_id: string }>;
  }

  exportExecutions(): ExecutionRecord[] {
    return (this.db.query("SELECT * FROM execution_records ORDER BY created_at").all() as ExecRow[]).map(mapExecRow);
  }

  /** 导入到空库：文件落 storageDir、行原样（storage_path / project_slug 改写成本库的）。 */
  importVersions(
    versions: Array<{ row: Record<string, unknown>; contentBase64: string | null }>,
    dependencies: Array<{ source_version_id: string; target_version_id: string }>,
    projectSlug: string,
  ): number {
    const existing = (this.db.query("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n;
    if (existing > 0) throw new Error(`importVersions 只能导入空 artifacts 库（当前已有 ${existing} 个版本）`);
    const cols = (this.db.query("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>).map((c) => c.name);
    const ins = this.db.query(`INSERT INTO artifacts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    const insDep = this.db.query("INSERT OR IGNORE INTO dependencies (source_version_id, target_version_id) VALUES (?, ?)");
    const tx = this.db.transaction(() => {
      for (const v of versions) {
        const id = v.row.id as string;
        const filename = v.row.filename as string;
        const storagePath = join(this.storageDir, `${id}__${filename}`);
        if (v.contentBase64 !== null) writeFileSync(storagePath, Buffer.from(v.contentBase64, "base64"));
        ins.run(
          ...cols.map((c) => {
            if (c === "storage_path") return storagePath;
            if (c === "project_slug") return projectSlug;
            if (c === "project") return projectSlug;
            return (v.row[c] ?? null) as string | number | null;
          }),
        );
      }
      for (const d of dependencies) insDep.run(d.source_version_id, d.target_version_id);
    });
    tx();
    return versions.length;
  }

  saveExecution(record: Omit<ExecutionRecord, "id" | "createdAt">): ExecutionRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO execution_records
         (id, frame, cell_index, kernel_id, language, source, stdout, stderr, status,
          files_written, files_read, wall_time, cpu_time, peak_memory, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.frame,
        record.cellIndex,
        record.kernelId,
        record.language,
        record.source,
        record.stdout,
        record.stderr,
        record.status,
        JSON.stringify(record.filesWritten ?? []),
        JSON.stringify(record.filesRead ?? []),
        record.wallTime,
        record.cpuTime,
        record.peakMemory,
        createdAt,
      );
    return { id, createdAt, ...record };
  }

  listExecutionsByFrame(frame: string): ExecutionRecord[] {
    const rows = this.db
      .query("SELECT * FROM execution_records WHERE frame = ? ORDER BY cell_index")
      .all(frame) as ExecRow[];
    return rows.map(mapExecRow);
  }

  close(): void {
    this.db.close();
  }

  private getRaw(versionId: string): ArtifactRow | null {
    return this.db.query("SELECT * FROM artifacts WHERE id = ?").get(versionId) as ArtifactRow | null;
  }

  private getRawLatest(project: string, filename: string): ArtifactRow | null {
    return this.db
      .query("SELECT * FROM artifacts WHERE project = ? AND filename = ? ORDER BY version DESC LIMIT 1")
      .get(project, filename) as ArtifactRow | null;
  }

  private resolveDependencies(
    targetId: string,
    project: string,
    filename: string,
    messages: LineageMessage[],
  ): { mappings: DependencyMapping[]; edges: DependencyEdge[] } {
    const mappings: DependencyMapping[] = [];
    const edges: DependencyEdge[] = [];
    const seen = new Set<string>();
    for (const m of messages ?? []) {
      for (const vid of m.dependsOn ?? []) {
        const dep = this.getRaw(vid);
        if (!dep || seen.has(vid)) continue;
        seen.add(vid);
        mappings.push({ file: dep.filename, versionId: vid });
        edges.push({ sourceVersionId: vid, targetVersionId: targetId });
      }
      if (m.kind === "read" && m.file && basename(m.file) !== filename) {
        const dep = this.getRawLatest(project, basename(m.file));
        if (dep && !seen.has(dep.id)) {
          seen.add(dep.id);
          mappings.push({ file: dep.filename, versionId: dep.id });
          edges.push({ sourceVersionId: dep.id, targetVersionId: targetId });
        }
      }
    }
    return { mappings, edges };
  }

  private buildGraph(): LineageGraph {
    const versions = this.db
      .query("SELECT id, filename, version FROM artifacts")
      .all() as VersionMeta[];
    const rows = this.db
      .query("SELECT source_version_id, target_version_id FROM dependencies")
      .all() as { source_version_id: string; target_version_id: string }[];
    const graph = new LineageGraph(versions);
    for (const r of rows) graph.addEdge(r.source_version_id, r.target_version_id);
    return graph;
  }
}
