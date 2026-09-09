import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactVersion } from "../artifacts/models";
import {
  EDGE_TYPES,
  EVIDENCE_LABELS,
  ORIGIN_KINDS,
  RECORD_TYPES,
  type EdgeType,
  type EvidenceLabel,
  type RecordEdge,
  type RecordFilter,
  type RecordGraphData,
  type RecordInput,
  type RecordOrigin,
  type RecordType,
  type ResearchRecord,
} from "./models";

interface RecordRow {
  id: string;
  project: string;
  type: string;
  title: string;
  content: string;
  evidence: string;
  origin_kind: string;
  origin_ref: string | null;
  origin_connector: string | null;
  session_id: string | null;
  artifact_id: string | null;
  metadata: string;
  created_at: string;
}

// P10-d · D-9：乐观并发版本号。**不**放进 `ResearchRecord`/schema.sql（避免动共享类型、
// 影响其他 lane）——`rev` 只在 records 表这一列里，读写都走 RecordStore 自己的窄口
// （`getRev` / `update(..., { expectedRev })`），对外仍是原来的 `ResearchRecord` 形状。
export class RecordConflictError extends Error {
  constructor(
    readonly id: string,
    readonly expectedRev: number,
    readonly currentRev: number | null,
  ) {
    super(
      `RecordConflict: record '${id}' 并发写入冲突（期望 rev=${expectedRev}，当前 rev=${
        currentRev ?? "(记录已不存在)"
      }）——本次写入被拒绝，不是静默覆盖`,
    );
    this.name = "RecordConflictError";
  }
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  type: string;
  created_at: string;
}

export class RecordValidationError extends Error {
  constructor(message: string) {
    super(`RecordValidation: ${message}`);
    this.name = "RecordValidationError";
  }
}

function mapRow(row: RecordRow): ResearchRecord {
  const origin: RecordOrigin = {
    kind: row.origin_kind as RecordOrigin["kind"],
    sessionId: row.session_id,
    ref: row.origin_ref,
    connector: row.origin_connector,
  };
  return {
    id: row.id,
    project: row.project,
    type: row.type as RecordType,
    title: row.title,
    content: row.content,
    evidence: row.evidence as EvidenceLabel,
    origin,
    artifactId: row.artifact_id,
    metadata: JSON.parse(row.metadata),
    createdAt: row.created_at,
  };
}

function mapEdgeRow(row: EdgeRow): RecordEdge {
  return {
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type as EdgeType,
    createdAt: row.created_at,
  };
}

// Research Record 存储：7 种 record 类型 + 5 种边（DESIGN 域 C1）。
// 与 ArtifactStore 同样用 bun:sqlite，schema 见同目录 schema.sql；
// AD-3：record 与 artifact 同一张证据图、不同表，artifact 类型 record 靠 artifactId 互链。
export class RecordStore {
  private db: Database;
  readonly project: string;

  constructor(dbPath: string, project: string) {
    this.project = project;
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  initSchema(): void {
    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
    this.db.exec(schema);
    this.migrateRevColumn();
  }

  // P10-d · D-9：老 records.db 没有 rev 列 —— 不能让老项目打不开。
  // schema.sql 刻意**不**加这一列（那是所有 lane 共用的建表脚本，改它风险面更大）；
  // 迁移完全在这里做，对全新库和老库是同一条路径：新库先被上面的 CREATE TABLE IF NOT EXISTS
  // 建出来（自然没有 rev 列），然后这里统一 ALTER 补上，新库和老库补出来的列完全一样。
  private migrateRevColumn(): void {
    const columns = this.db.query("PRAGMA table_info(records)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "rev")) {
      // 老库里已有的行没有 rev：DEFAULT 1 是唯一诚实的起点——它们「从这一刻起」被纳入版本管理，
      // 之前的历史无从追溯（旧库本来就没记录过）。
      this.db.exec("ALTER TABLE records ADD COLUMN rev INTEGER NOT NULL DEFAULT 1");
    }
  }

  // rev 不进 ResearchRecord（那是共享类型，改了会牵连其他 lane）。需要 CAS 的调用方
  // （目前只有湿实验 execute() 的「声明执行权」）单独读这一列。
  getRev(id: string): number | null {
    const row = this.db.query("SELECT rev FROM records WHERE id = ?").get(id) as { rev: number } | null;
    return row ? row.rev : null;
  }

  create(input: RecordInput): ResearchRecord {
    const type = input.type;
    if (!RECORD_TYPES.includes(type)) {
      throw new RecordValidationError(`unknown record type '${type}'`);
    }
    const evidence = input.evidence ?? "inferred";
    if (!EVIDENCE_LABELS.includes(evidence)) {
      throw new RecordValidationError(`unknown evidence label '${evidence}'`);
    }
    const origin: RecordOrigin = input.origin ?? { kind: "manual" };
    if (!ORIGIN_KINDS.includes(origin.kind)) {
      throw new RecordValidationError(`unknown origin kind '${origin.kind}'`);
    }
    const artifactId = input.artifactId ?? null;
    // AD-3：artifact 类型的 record 必须指向 artifacts 表里的某个版本，否则图会断链。
    if (type === "artifact" && !artifactId) {
      throw new RecordValidationError("record type 'artifact' requires artifactId");
    }

    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .query(
        `INSERT INTO records
         (id, project, type, title, content, evidence, origin_kind, origin_ref,
          origin_connector, session_id, artifact_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.project,
        type,
        input.title ?? "",
        input.content ?? "",
        evidence,
        origin.kind,
        origin.ref ?? null,
        origin.connector ?? null,
        origin.sessionId ?? null,
        artifactId,
        JSON.stringify(input.metadata ?? {}),
        createdAt,
      );
    return this.get(id)!;
  }

  // 便捷入口：把一个 artifact 版本登记成证据图上的 artifact record。
  createFromArtifact(
    artifact: Pick<ArtifactVersion, "id" | "filename" | "producingCellId">,
    extra: Partial<RecordInput> = {},
  ): ResearchRecord {
    const sessionId = artifact.producingCellId?.split(":")[0] ?? null;
    return this.create({
      type: "artifact",
      title: extra.title ?? artifact.filename,
      content: extra.content ?? `artifact ${artifact.filename}`,
      evidence: extra.evidence ?? "computed",
      origin: extra.origin ?? {
        kind: artifact.producingCellId ? "cell" : "manual",
        sessionId,
        ref: artifact.producingCellId,
      },
      artifactId: artifact.id,
      metadata: extra.metadata ?? {},
    });
  }

  get(id: string): ResearchRecord | null {
    const row = this.db.query("SELECT * FROM records WHERE id = ?").get(id) as RecordRow | null;
    return row ? mapRow(row) : null;
  }

  // 窄口更新：只允许改 title / content / metadata（浅合并）。
  // type / evidence / origin / artifactId / createdAt 一律不可变——它们是这条 record
  // 「是什么、从哪来」的身份，改了就不是同一条证据了（要改用 supersedes 边另立一条）。
  //
  // 为什么需要它（P4）：idea 卡的 novelty 状态是**生命周期字段**（unchecked → checked-*），
  // 与 library.reading_status 同类；审计痕迹由 novelty 报告 record + derives_from 边承担，
  // 不靠在思路库里堆同一个 idea 的历史副本。
  // P10-d · D-9：`opts.expectedRev` 是**可选**的（新增可选参数，不改变有 rev 的签名）——
  // 不给就是原来的行为（无条件覆盖，last-write-wins，rev 仍然 +1，只是没人核对它）；
  // 给了就是 `UPDATE ... WHERE id=? AND rev=?`：影响行数为 0 说明别的写入抢先了，
  // 抛 RecordConflictError 而不是静默覆盖——这是并发执行/并发审批那类物理世界操作要的语义。
  update(
    id: string,
    patch: { title?: string; content?: string; metadata?: Record<string, unknown> },
    opts: { expectedRev?: number } = {},
  ): ResearchRecord {
    const existing = this.get(id);
    if (!existing) throw new RecordValidationError(`record '${id}' not found`);
    const metadata = patch.metadata ? { ...existing.metadata, ...patch.metadata } : existing.metadata;
    const title = patch.title ?? existing.title;
    const content = patch.content ?? existing.content;
    const metadataJson = JSON.stringify(metadata);

    if (opts.expectedRev !== undefined) {
      const result = this.db
        .query("UPDATE records SET title = ?, content = ?, metadata = ?, rev = rev + 1 WHERE id = ? AND rev = ?")
        .run(title, content, metadataJson, id, opts.expectedRev);
      if (result.changes === 0) {
        throw new RecordConflictError(id, opts.expectedRev, this.getRev(id));
      }
      return this.get(id)!;
    }

    this.db
      .query("UPDATE records SET title = ?, content = ?, metadata = ?, rev = rev + 1 WHERE id = ?")
      .run(title, content, metadataJson, id);
    return this.get(id)!;
  }

  // 过滤谓词的单一真源：list() 与 count() 共用，保证「这一页」与「总数」口径一致。
  private whereClause(filter: RecordFilter): { where: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      clauses.push(`type IN (${types.map(() => "?").join(", ")})`);
      params.push(...types);
    }
    if (filter.evidence) {
      clauses.push("evidence = ?");
      params.push(filter.evidence);
    }
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.artifactId) {
      clauses.push("artifact_id = ?");
      params.push(filter.artifactId);
    }
    if (filter.since) {
      clauses.push("created_at >= ?");
      params.push(filter.since);
    }
    if (filter.until) {
      clauses.push("created_at <= ?");
      params.push(filter.until);
    }
    return { where: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  }

  list(filter: RecordFilter = {}): ResearchRecord[] {
    const { where, params } = this.whereClause(filter);
    // SQLite 的 OFFSET 必须跟在 LIMIT 后面；只给 offset 时用 -1 表示「不限条数」。
    let tail = "";
    if (filter.limit) {
      tail += " LIMIT ?";
      params.push(filter.limit);
    } else if (filter.offset) {
      tail += " LIMIT -1";
    }
    if (filter.offset) {
      tail += " OFFSET ?";
      params.push(filter.offset);
    }
    // 次序键用 rowid 而不是 id：同一毫秒内创建的多条 record（如批量生成精读卡）
    // created_at 完全相同，用随机 uuid 排序会让「哪条更新」不确定；rowid 就是插入顺序。
    const rows = this.db
      .query(`SELECT * FROM records${where} ORDER BY created_at, rowid${tail}`)
      .all(...params) as RecordRow[];
    return rows.map(mapRow);
  }

  // 无参 = 全表条数（P1 起的既有语义）；带 filter = 该谓词下的条数（P7 分页用）。
  count(filter: RecordFilter = {}): number {
    const { where, params } = this.whereClause(filter);
    const row = this.db.query(`SELECT COUNT(*) AS n FROM records${where}`).get(...params) as { n: number };
    return row.n;
  }

  // 建边前两端都必须存在，避免证据图出现悬空引用。
  link(sourceId: string, targetId: string, type: EdgeType): RecordEdge {
    if (!EDGE_TYPES.includes(type)) {
      throw new RecordValidationError(`unknown edge type '${type}'`);
    }
    if (sourceId === targetId) {
      throw new RecordValidationError("self edge is not allowed");
    }
    if (!this.get(sourceId)) {
      throw new RecordValidationError(`source record '${sourceId}' not found`);
    }
    if (!this.get(targetId)) {
      throw new RecordValidationError(`target record '${targetId}' not found`);
    }
    const createdAt = new Date().toISOString();
    this.db
      .query(
        "INSERT OR IGNORE INTO record_edges (source_id, target_id, type, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sourceId, targetId, type, createdAt);
    return { sourceId, targetId, type, createdAt };
  }

  edgesOf(id: string): { outgoing: RecordEdge[]; incoming: RecordEdge[] } {
    const outgoing = this.db
      .query("SELECT * FROM record_edges WHERE source_id = ? ORDER BY created_at")
      .all(id) as EdgeRow[];
    const incoming = this.db
      .query("SELECT * FROM record_edges WHERE target_id = ? ORDER BY created_at")
      .all(id) as EdgeRow[];
    return { outgoing: outgoing.map(mapEdgeRow), incoming: incoming.map(mapEdgeRow) };
  }

  listEdges(type?: EdgeType): RecordEdge[] {
    const rows = type
      ? (this.db
          .query("SELECT * FROM record_edges WHERE type = ? ORDER BY created_at")
          .all(type) as EdgeRow[])
      : (this.db.query("SELECT * FROM record_edges ORDER BY created_at").all() as EdgeRow[]);
    return rows.map(mapEdgeRow);
  }

  // 以 rootId 为中心按 depth 双向展开，得到一张可直接渲染的子图。
  graph(rootId: string, depth = 2): RecordGraphData {
    const root = this.get(rootId);
    if (!root) throw new RecordValidationError(`record '${rootId}' not found`);
    const visited = new Map<string, ResearchRecord>([[rootId, root]]);
    const edges = new Map<string, RecordEdge>();
    let frontier = [rootId];
    for (let level = 0; level < depth && frontier.length > 0; level++) {
      const next: string[] = [];
      for (const id of frontier) {
        const { outgoing, incoming } = this.edgesOf(id);
        for (const edge of [...outgoing, ...incoming]) {
          edges.set(`${edge.sourceId}->${edge.targetId}:${edge.type}`, edge);
          for (const side of [edge.sourceId, edge.targetId]) {
            if (visited.has(side)) continue;
            const rec = this.get(side);
            if (!rec) continue;
            visited.set(side, rec);
            next.push(side);
          }
        }
      }
      frontier = next;
    }
    return { rootId, nodes: [...visited.values()], edges: [...edges.values()] };
  }

  close(): void {
    this.db.close();
  }
}
