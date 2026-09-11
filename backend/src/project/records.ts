import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
// V27：schema 从静态 import 拿内容，不再 `readFileSync(join(import.meta.dir, "schema.sql"))`——
// `bun build --compile` 不把 `.sql` 打进产物，那条路径在单二进制里必然
// `ENOENT: /$bunfs/root/schema.sql`，而 `project new` 一开局就会踩到它（见 docs/devlog/W5-1-e.md）。
import SCHEMA_SQL from "./schema.sql" with { type: "text" };
import type { ArtifactVersion } from "../artifacts/models";
import type { Usage } from "../llm/types";
import {
  PROVENANCE_CLASSES,
  USER_OWNED_LICENSE,
  classForOrigin,
  licenseForClass,
  type ProvenanceClass,
} from "../provenance/policy";
import { sha256Of } from "../raw/sink";
import {
  EDGE_TYPES,
  EVIDENCE_LABELS,
  ORIGIN_KINDS,
  RECORD_TYPES,
  type EdgeType,
  type EvidenceLabel,
  type RecordEdge,
  type RecordFilter,
  type JournalEntry,
  type JournalOp,
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
  // v0.7 W7-D0：三列由 migrateProvenanceColumns() 补上（老库 ALTER，与 rev 同一条路径）。
  provenance_class: string | null;
  license: string | null;
  quality: string | null;
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

// ── W3-b · 第 9 类 record：`agent_run`（帧级记账，DEVELOPMENT_PLAN_v0.4.md §4.3） ──
//
// `RECORD_TYPES`/`RecordType`（`./models`）是跨多条 lane 共享的文件，本 lane
// （W3-b，文件所有权只到 `records.ts`）不持有它的编辑权——同一波次里其他 lane
// 也在并行改代码，抢着改共享常量表只会造成合并冲突。所以这里不把 "agent_run" 塞进
// `RECORD_TYPES` 数组，而是让它走一条**平行窄口** `createAgentRun()`：校验规则单独写，
// 但落库复用与 `create()` 完全相同的一段 INSERT（见下面私有的 `insertRow()`，
// `create()` 自己也改造成调它）——同一张表、同一套默认 `rev`、同一次 `get()` 回读，
// 不是分叉出第二套写入路径。等收口时主会话把 "agent_run" 并入 `RECORD_TYPES`，
// 这条窄口可以原样合并回 `create()` 的 type 分支，调用方（`agents/ledger.ts`）的
// 接口不需要跟着变。
export const AGENT_RUN_RECORD_TYPE = "agent_run" as const;

// usage 的形状直接复用 `llm/types.ts` 的 `Usage`——不重新定义一遍
// `{inputTokens, outputTokens, costUsd, usageUnavailable?}`，那正是 P13 帧级账本
// 要求的形状，两处定义迟早漂移。诚实铁律（拿不到 usage/单价就是 `costUsd: null`，
// 绝不填 0）由 `Usage` 类型自己的注释钉住，本文件只做「形状对不对」的运行时校验。
export interface AgentRunRecordInput {
  agent: string;
  model: string;
  provider: string;
  systemHash: string;
  promptHash: string;
  usage: Usage;
  toolCalls: number;
  stopReason: string;
  /** 顶层 run 传 `null`/不传；子代理 run 挂父 run 的 record id（边由调用方另建，见 ledger.ts）。 */
  parentRunId?: string | null;
  /** 调用方（`AgentRunLedger`）算好的额外字段，目前只有 `integrityHash`。浅合并进 metadata。 */
  extraMetadata?: Record<string, unknown>;
  title?: string;
  content?: string;
  evidence?: EvidenceLabel;
  origin?: RecordOrigin;
  createdAt?: string;
}

function validateAgentRunInput(input: AgentRunRecordInput): void {
  if (!input.agent) throw new RecordValidationError("agent_run 记录需要非空 'agent'");
  if (!input.model) throw new RecordValidationError("agent_run 记录需要非空 'model'");
  if (!input.provider) throw new RecordValidationError("agent_run 记录需要非空 'provider'");
  if (!input.systemHash) throw new RecordValidationError("agent_run 记录需要非空 'systemHash'");
  if (!input.promptHash) throw new RecordValidationError("agent_run 记录需要非空 'promptHash'");
  if (!input.usage) throw new RecordValidationError("agent_run 记录需要 'usage'");
  if (typeof input.usage.inputTokens !== "number" || typeof input.usage.outputTokens !== "number") {
    throw new RecordValidationError("agent_run 记录的 usage.inputTokens/outputTokens 必须是 number");
  }
  if (input.usage.costUsd !== null && typeof input.usage.costUsd !== "number") {
    throw new RecordValidationError(
      "agent_run 记录的 usage.costUsd 必须是 number 或 null（诚实铁律：拿不到就是 null，不许填 0 冒充免费）",
    );
  }
  if (!Number.isInteger(input.toolCalls) || input.toolCalls < 0) {
    throw new RecordValidationError("agent_run 记录的 toolCalls 必须是非负整数");
  }
  if (!input.stopReason) throw new RecordValidationError("agent_run 记录需要非空 'stopReason'");
}

function mapRow(row: RecordRow): ResearchRecord {
  const origin: RecordOrigin = {
    kind: row.origin_kind as RecordOrigin["kind"],
    sessionId: row.session_id,
    ref: row.origin_ref,
    connector: row.origin_connector,
  };
  const type = row.type as RecordType;
  return {
    id: row.id,
    project: row.project,
    type,
    title: row.title,
    content: row.content,
    evidence: row.evidence as EvidenceLabel,
    origin,
    artifactId: row.artifact_id,
    metadata: JSON.parse(row.metadata),
    createdAt: row.created_at,
    // 回填迁移保证列非空；这里的兜底只防「迁移前的行被并发读到」这一瞬。
    provenanceClass: (row.provenance_class as ProvenanceClass | null) ?? classForOrigin(origin, type),
    license: row.license ?? null,
    quality: row.quality ? (JSON.parse(row.quality) as string[]) : [],
  };
}

/**
 * v0.7 · 统一质量标签：把写入方已经放在 metadata 里的几个「确定性层输入」收成一列——
 * V49 deterministic · V66 basis · G4 simulated · V54 caveat。不动 metadata 原样（其他读者
 * 还在读它），只是多写一列让导出/回流能机器过滤。显式传入的 quality 排前面、去重。
 */
export function deriveQuality(metadata: Record<string, unknown>, explicit: string[] = []): string[] {
  const tags = [...explicit];
  if (typeof metadata.deterministic === "boolean") tags.push(`deterministic:${metadata.deterministic}`);
  if (typeof metadata.basis === "string") tags.push(`basis:${metadata.basis}`);
  if (metadata.simulated === true) tags.push("simulated");
  if (typeof metadata.caveat === "string" && metadata.caveat) tags.push("caveat");
  return [...new Set(tags)];
}

interface JournalRow {
  seq: number;
  record_id: string;
  op: string;
  rev_before: number | null;
  rev_after: number | null;
  actor: string | null;
  actor_source: string | null;
  patch: string;
  prev_hash: string | null;
  hash: string;
  created_at: string;
}

function mapJournalRow(row: JournalRow): JournalEntry {
  return {
    seq: row.seq,
    recordId: row.record_id,
    op: row.op as JournalOp,
    revBefore: row.rev_before,
    revAfter: row.rev_after,
    actor: row.actor,
    actorSource: row.actor_source,
    patch: JSON.parse(row.patch) as Record<string, unknown>,
    prevHash: row.prev_hash,
    hash: row.hash,
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
    // V80（v0.7 C-4）：同项目并发写（idea new × idea check）实测 `database is locked`——
    // findings_store.ts 早就设了 5s busy_timeout，其余三库没有。补齐。
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.migrateRevColumn();
    this.migrateProvenanceColumns();
    this.migrateJournal();
  }

  // v0.7 W7-D1 · records_journal：append-only，与 records 同库同事务。schema.sql 不动
  //（与 rev / 三列同一条路径）。老库首次打开：给每条既有 record 落一行 op=backfill 全量快照，
  // 让历史从「这一刻」起可追溯（更早的改写本来就没记录，不编造）。幂等：journal 非空即跳过。
  private migrateJournal(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS records_journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL,
      op TEXT NOT NULL,
      rev_before INTEGER,
      rev_after INTEGER,
      actor TEXT,
      actor_source TEXT,
      patch TEXT NOT NULL,
      prev_hash TEXT,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_records_journal_record ON records_journal (record_id, seq)");
    const n = (this.db.query("SELECT COUNT(*) AS n FROM records_journal").get() as { n: number }).n;
    if (n > 0) return;
    const rows = this.db.query("SELECT * FROM records ORDER BY created_at, rowid").all() as Array<RecordRow & { rev: number }>;
    if (rows.length === 0) return;
    const tx = this.db.transaction((all: typeof rows) => {
      for (const row of all) {
        this.journal({ recordId: row.id, op: "backfill", revBefore: null, revAfter: row.rev, patch: this.snapshotOf(row) });
      }
    });
    tx(rows);
  }

  private snapshotOf(row: RecordRow): Record<string, unknown> {
    const { rev: _rev, ...rest } = row as RecordRow & { rev?: number };
    return { ...rest };
  }

  private lastJournalHash(): string | null {
    const row = this.db.query("SELECT hash FROM records_journal ORDER BY seq DESC LIMIT 1").get() as { hash: string } | null;
    return row ? row.hash : null;
  }

  /** 写一行日志（调用方保证在同一事务内）。hash 覆盖除 hash 外全部字段，prevHash 指向上一行。 */
  private journal(entry: {
    recordId: string;
    op: JournalOp;
    revBefore: number | null;
    revAfter: number | null;
    patch: Record<string, unknown>;
    actor?: string | null;
    actorSource?: string | null;
  }): void {
    const createdAt = new Date().toISOString();
    const prevHash = this.lastJournalHash();
    const body = {
      recordId: entry.recordId,
      op: entry.op,
      revBefore: entry.revBefore,
      revAfter: entry.revAfter,
      actor: entry.actor ?? null,
      actorSource: entry.actorSource ?? null,
      patch: entry.patch,
      prevHash,
      createdAt,
    };
    this.db
      .query(
        `INSERT INTO records_journal (record_id, op, rev_before, rev_after, actor, actor_source, patch, prev_hash, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.recordId,
        body.op,
        body.revBefore,
        body.revAfter,
        body.actor,
        body.actorSource,
        JSON.stringify(body.patch),
        prevHash,
        sha256Of(body),
        createdAt,
      );
  }

  /** 某条 record 的全部日志（按 seq）。 */
  history(recordId: string): JournalEntry[] {
    const rows = this.db
      .query("SELECT * FROM records_journal WHERE record_id = ? ORDER BY seq")
      .all(recordId) as JournalRow[];
    return rows.map(mapJournalRow);
  }

  /** 整本日志（导出用，按 seq）。 */
  journalEntries(since = 0): JournalEntry[] {
    const rows = this.db.query("SELECT * FROM records_journal WHERE seq > ? ORDER BY seq").all(since) as JournalRow[];
    return rows.map(mapJournalRow);
  }

  /** 逐行重算 hash 与链（门禁 G4 的阴性对照靠它）。 */
  verifyJournal(): { ok: boolean; lines: number; brokenAt?: number; reason?: string } {
    let prev: string | null = null;
    let lines = 0;
    for (const e of this.journalEntries()) {
      lines += 1;
      const body = {
        recordId: e.recordId,
        op: e.op,
        revBefore: e.revBefore,
        revAfter: e.revAfter,
        actor: e.actor,
        actorSource: e.actorSource,
        patch: e.patch,
        prevHash: e.prevHash,
        createdAt: e.createdAt,
      };
      if (sha256Of(body) !== e.hash) return { ok: false, lines, brokenAt: e.seq, reason: `seq ${e.seq} hash 对不上` };
      if (e.prevHash !== prev) return { ok: false, lines, brokenAt: e.seq, reason: `seq ${e.seq} prevHash 断链` };
      prev = e.hash;
    }
    return { ok: true, lines };
  }

  /**
   * V24 的恢复路径：把某条 record 的投影重建到日志的第 toSeq 步（含）。只重放 create/backfill/
   * update/repair 的 patch（link 与 tombstone 不改 title/content/metadata）。需要署名——这是人
   * 确认后的动作，落一行 op=repair 日志，投影 rev+1。
   */
  repair(recordId: string, options: { toSeq: number; actor: string; actorSource?: string }): ResearchRecord {
    const entries = this.history(recordId).filter((e) => e.seq <= options.toSeq);
    const base = entries.find((e) => e.op === "create" || e.op === "backfill");
    if (!base) throw new RecordValidationError(`record '${recordId}' 在 seq ≤ ${options.toSeq} 内没有 create/backfill 日志，无从重建`);
    if (!options.actor?.trim()) throw new RecordValidationError("repair 需要署名 actor");
    let title = String(base.patch.title ?? "");
    let content = String(base.patch.content ?? "");
    let metadata: Record<string, unknown> =
      typeof base.patch.metadata === "string" ? (JSON.parse(base.patch.metadata as string) as Record<string, unknown>) : ((base.patch.metadata as Record<string, unknown>) ?? {});
    for (const e of entries) {
      if (e.seq <= base.seq) continue;
      if (e.op === "update" || e.op === "tombstone") {
        if (typeof e.patch.title === "string") title = e.patch.title;
        if (typeof e.patch.content === "string") content = e.patch.content;
        if (e.patch.metadata && typeof e.patch.metadata === "object") metadata = { ...metadata, ...(e.patch.metadata as Record<string, unknown>) };
      } else if (e.op === "repair") {
        const snap = e.patch.snapshot as { title: string; content: string; metadata: Record<string, unknown> } | undefined;
        if (snap) ({ title, content, metadata } = snap);
      }
    }
    const revBefore = this.getRev(recordId);
    if (revBefore === null) throw new RecordValidationError(`record '${recordId}' not found`);
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE records SET title = ?, content = ?, metadata = ?, rev = rev + 1 WHERE id = ?")
        .run(title, content, JSON.stringify(metadata), recordId);
      this.journal({
        recordId,
        op: "repair",
        revBefore,
        revAfter: revBefore + 1,
        actor: options.actor,
        actorSource: options.actorSource ?? "explicit",
        patch: { toSeq: options.toSeq, snapshot: { title, content, metadata } },
      });
    });
    tx();
    return this.get(recordId)!;
  }

  /** V30：撤回（不删）——metadata 打 retracted 标记，日志 op=tombstone。 */
  tombstone(recordId: string, reason: string, actor: string | null = null): ResearchRecord {
    const existing = this.get(recordId);
    if (!existing) throw new RecordValidationError(`record '${recordId}' not found`);
    const patch = { metadata: { retracted: true, retractedAt: new Date().toISOString(), retractedReason: reason } };
    const revBefore = this.getRev(recordId)!;
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE records SET metadata = ?, rev = rev + 1 WHERE id = ?")
        .run(JSON.stringify({ ...existing.metadata, ...patch.metadata }), recordId);
      this.journal({ recordId, op: "tombstone", revBefore, revAfter: revBefore + 1, actor, patch });
    });
    tx();
    return this.get(recordId)!;
  }

  // v0.7 W7-D0 · L3 三列。与 rev 同一条路径：schema.sql 不动，这里 ALTER 补列；
  // 老行按 classForOrigin() 回填（§五 回填规则，幂等——只填 NULL 的行）。license 老行
  // 按 class 推：upstream 用 connector 的登记许可，其余 user-owned 占位。
  private migrateProvenanceColumns(): void {
    const columns = new Set(
      (this.db.query("PRAGMA table_info(records)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!columns.has("provenance_class")) this.db.exec("ALTER TABLE records ADD COLUMN provenance_class TEXT");
    if (!columns.has("license")) this.db.exec("ALTER TABLE records ADD COLUMN license TEXT");
    if (!columns.has("quality")) this.db.exec("ALTER TABLE records ADD COLUMN quality TEXT NOT NULL DEFAULT '[]'");
    const pending = this.db
      .query("SELECT id, type, origin_kind, origin_ref, origin_connector, session_id, metadata FROM records WHERE provenance_class IS NULL")
      .all() as Array<Pick<RecordRow, "id" | "type" | "origin_kind" | "origin_ref" | "origin_connector" | "session_id" | "metadata">>;
    if (pending.length === 0) return;
    const update = this.db.query("UPDATE records SET provenance_class = ?, license = ?, quality = ? WHERE id = ?");
    const tx = this.db.transaction((rows: typeof pending) => {
      for (const r of rows) {
        const origin: RecordOrigin = {
          kind: r.origin_kind as RecordOrigin["kind"],
          ref: r.origin_ref,
          connector: r.origin_connector,
          sessionId: r.session_id,
        };
        const cls = classForOrigin(origin, r.type as RecordType);
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(r.metadata) as Record<string, unknown>;
        } catch {
          metadata = {};
        }
        update.run(cls, licenseForClass(cls, origin), JSON.stringify(deriveQuality(metadata)), r.id);
      }
    });
    tx(pending);
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

    const provenanceClass = input.provenanceClass ?? classForOrigin(origin, type);
    if (!PROVENANCE_CLASSES.includes(provenanceClass)) {
      throw new RecordValidationError(`unknown provenanceClass '${provenanceClass}'`);
    }
    const metadata = input.metadata ?? {};
    return this.insertRow({
      type,
      title: input.title ?? "",
      content: input.content ?? "",
      evidence,
      origin,
      artifactId,
      metadata,
      createdAt: input.createdAt,
      provenanceClass,
      license: input.license === undefined ? licenseForClass(provenanceClass, origin) : input.license,
      quality: deriveQuality(metadata, input.quality),
    });
  }

  // W3-b：`create()` 与 `createAgentRun()` 共用的底层写入——同一张表、同一段 INSERT、
  // 同一个 `get()` 回读，两条窄口只在**校验**上分叉，落库路径永远是这一处。
  private insertRow(row: {
    type: string;
    title: string;
    content: string;
    evidence: EvidenceLabel;
    origin: RecordOrigin;
    artifactId: string | null;
    metadata: Record<string, unknown>;
    createdAt?: string;
    provenanceClass: ProvenanceClass;
    license: string | null;
    quality: string[];
  }): ResearchRecord {
    const id = randomUUID();
    const createdAt = row.createdAt ?? new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO records
           (id, project, type, title, content, evidence, origin_kind, origin_ref,
            origin_connector, session_id, artifact_id, metadata, created_at,
            provenance_class, license, quality)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.project,
          row.type,
          row.title,
          row.content,
          row.evidence,
          row.origin.kind,
          row.origin.ref ?? null,
          row.origin.connector ?? null,
          row.origin.sessionId ?? null,
          row.artifactId,
          JSON.stringify(row.metadata),
          createdAt,
          row.provenanceClass,
          row.license,
          JSON.stringify(row.quality),
        );
      // W7-D1：同一事务落日志（op=create，全量快照）。
      const inserted = this.db.query("SELECT * FROM records WHERE id = ?").get(id) as RecordRow & { rev: number };
      this.journal({ recordId: id, op: "create", revBefore: null, revAfter: inserted.rev, patch: this.snapshotOf(inserted) });
    });
    tx();
    return this.get(id)!;
  }

  // W3-b · 第 9 类 record 的写入窄口——见上面 `AGENT_RUN_RECORD_TYPE` 大注释：
  // 不动 `RECORD_TYPES`，校验在 `validateAgentRunInput()` 单独做，落库走
  // 与 `create()` 完全相同的 `insertRow()`（同一套 rev 默认值、同一张表）。
  createAgentRun(input: AgentRunRecordInput): ResearchRecord {
    validateAgentRunInput(input);
    const evidence = input.evidence ?? "observed";
    if (!EVIDENCE_LABELS.includes(evidence)) {
      throw new RecordValidationError(`unknown evidence label '${evidence}'`);
    }
    const origin: RecordOrigin = input.origin ?? { kind: "session" };
    if (!ORIGIN_KINDS.includes(origin.kind)) {
      throw new RecordValidationError(`unknown origin kind '${origin.kind}'`);
    }
    const metadata: Record<string, unknown> = {
      agent: input.agent,
      model: input.model,
      provider: input.provider,
      systemHash: input.systemHash,
      promptHash: input.promptHash,
      usage: input.usage,
      toolCalls: input.toolCalls,
      stopReason: input.stopReason,
      parentRunId: input.parentRunId ?? null,
      ...(input.extraMetadata ?? {}),
    };
    return this.insertRow({
      type: AGENT_RUN_RECORD_TYPE,
      title: input.title ?? `agent_run:${input.agent}`,
      content: input.content ?? `${input.agent} · ${input.provider}/${input.model} · stop=${input.stopReason}`,
      evidence,
      origin,
      artifactId: null,
      metadata,
      createdAt: input.createdAt,
      // 帧级记账天然是模型产出（§7.1）。
      provenanceClass: "model_generated",
      license: USER_OWNED_LICENSE,
      quality: deriveQuality(metadata),
    });
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
      provenanceClass: extra.provenanceClass ?? "derived",
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

    // W7-D1：投影改写与日志同一事务；journal 的 patch 是调用方传入的原样 patch（不是全量）。
    const journalPatch: Record<string, unknown> = {};
    if (patch.title !== undefined) journalPatch.title = patch.title;
    if (patch.content !== undefined) journalPatch.content = patch.content;
    if (patch.metadata !== undefined) journalPatch.metadata = patch.metadata;

    if (opts.expectedRev !== undefined) {
      const expected = opts.expectedRev;
      const tx = this.db.transaction(() => {
        const result = this.db
          .query("UPDATE records SET title = ?, content = ?, metadata = ?, rev = rev + 1 WHERE id = ? AND rev = ?")
          .run(title, content, metadataJson, id, expected);
        if (result.changes === 0) {
          throw new RecordConflictError(id, expected, this.getRev(id));
        }
        this.journal({ recordId: id, op: "update", revBefore: expected, revAfter: expected + 1, patch: journalPatch });
      });
      tx();
      return this.get(id)!;
    }

    const revBefore = this.getRev(id);
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE records SET title = ?, content = ?, metadata = ?, rev = rev + 1 WHERE id = ?")
        .run(title, content, metadataJson, id);
      this.journal({ recordId: id, op: "update", revBefore, revAfter: revBefore === null ? null : revBefore + 1, patch: journalPatch });
    });
    tx();
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
    if (filter.provenanceClass) {
      clauses.push("provenance_class = ?");
      params.push(filter.provenanceClass);
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
    const tx = this.db.transaction(() => {
      const result = this.db
        .query(
          "INSERT OR IGNORE INTO record_edges (source_id, target_id, type, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(sourceId, targetId, type, createdAt);
      // 幂等的重复 link 不落日志（边没变）。
      if (result.changes > 0) {
        this.journal({ recordId: sourceId, op: "link", revBefore: null, revAfter: null, patch: { targetId, type } });
      }
    });
    tx();
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
