import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

// v0.4 P13 lane W1-b：findings 状态机（DEVELOPMENT_PLAN_v0.4.md §4.3 / v0.3 §4.3.4）。
//
// 补的是什么：外部评审对比 Claude Science 指出，Claude 的 REVIEWER 是常驻后台 +
// findings 状态机 + `mark_addressed` 复核闭环；spark 现有的 `ReviewerAgent.review()`
// （见同目录 agent.ts，只读参考）是**一次性 pass**——每次调用都从头产生一批 Finding[]，
// 不落库、无法回答「这条上次报过吗」「标了 addressed 之后真的修好了吗」。
// 这个文件补的正是持久化 + 状态机那一层，不改 agent.ts / rules.ts 的检查逻辑本身。
//
// 与 records.ts（RecordStore）的关系：**故意不共用那张表、不共用那个 db 文件**——
// v0.4 方案原话「findings 状态机（C-b）与 contract/replan（C-a）零文件重叠，全程并行」，
// 独立建库是这条零耦合原则最直接的落实（RecordStore 的 schema.sql / migrateRevColumn
// 只读参考，本文件不 import 它，也不新增一列到 records 表）。

export type FindingSeverity = "hard" | "soft";

// open      = 刚报出来，没人处理过
// addressed = 人工标记「已处理」，等下一轮复核
// resolved  = 复核时检查器不再命中（不论是从 open 直接消失，还是从 addressed 复核通过）
// reflagged = 曾经 addressed 或 resolved，复核时检查器又命中了——「以为修好了，其实没有」
export type FindingState = "open" | "addressed" | "resolved" | "reflagged";
export const FINDING_STATES: readonly FindingState[] = ["open", "addressed", "resolved", "reflagged"];

// target 用「种类 + id」表达，而不是让调用方自己塞一个裸字符串——
// 证据图上 record 和 artifact 是两张不同的表，id 的唯一性各自成立，
// 裸字符串会让「同一个 id 撞在不同种类的两个目标上」这种边角情况无法区分。
export type FindingTargetKind = "record" | "artifact";

export interface FindingTarget {
  kind: FindingTargetKind;
  id: string;
}

export interface FindingRecord {
  id: string;
  project: string;
  session: string | null;
  target: FindingTarget;
  checker: string;
  severity: FindingSeverity;
  fingerprint: string;
  state: FindingState;
  evidence: string | null;
  note: string | null;
  reflagCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedBy: string | null;
}

interface FindingRow {
  id: string;
  project: string;
  session: string | null;
  target_kind: string;
  target_id: string;
  checker: string;
  severity: string;
  fingerprint: string;
  state: string;
  evidence: string | null;
  note: string | null;
  reflag_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_by: string | null;
}

function mapRow(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    project: row.project,
    session: row.session,
    target: { kind: row.target_kind as FindingTargetKind, id: row.target_id },
    checker: row.checker,
    severity: row.severity as FindingSeverity,
    fingerprint: row.fingerprint,
    state: row.state as FindingState,
    evidence: row.evidence,
    note: row.note,
    reflagCount: row.reflag_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedBy: row.resolved_by,
  };
}

export class FindingsStoreError extends Error {
  constructor(message: string) {
    super(`FindingsStore: ${message}`);
    this.name = "FindingsStoreError";
  }
}

// 一轮检查器命中的一条原始 finding（还没落库）。
export interface FindingHit {
  severity: FindingSeverity;
  fingerprint: string;
  evidence?: string | null;
}

export interface ReviewTargetInput {
  project: string;
  session?: string | null;
  target: FindingTarget;
  checker: string;
  hits: FindingHit[];
}

export interface ReviewTargetResult {
  // 本轮命中、upsert 之后的最新状态（open 首次出现 / open 或 reflagged 续命中 / 从
  // addressed·resolved 转 reflagged）。
  findings: FindingRecord[];
  // 本轮没有命中、因此被判定为已解决的记录。
  resolved: FindingRecord[];
}

export interface ListFilter {
  project?: string;
  // true：只要「仍需要人关注」的（open / reflagged）——CLI `--open` 与 soft finding
  // 的「主动查」入口都是这个口径。
  open?: boolean;
  state?: FindingState;
  checker?: string;
}

// ── 并发写入口径（devlog 详述，这里留精简版注释） ──────────────────────────
//
// records.ts 的 rev/CAS 是给**通用 patch**（调用方决定 title/content 怎么改）用的：
// store 本身不知道「对」的合并结果是什么，只能靠调用方带着 expectedRev 来保证
// 「没有人在我读之后、写之前抢先改过」。
//
// findings 状态机不是通用 patch——它的状态转移是一张**封闭、确定性**的规则表
// （见上面 FindingState 的注释），store 自己就知道「命中一次该怎么转」。
// 于是这里选择把整条转移规则写成**单条原子 SQL 语句**（`INSERT ... ON CONFLICT
// DO UPDATE` 的 CASE 表达式），而不是「先 SELECT 读状态、在应用层判断、再 UPDATE」——
// 后者才需要 rev/CAS 来防「读写之间被别人抢跑」，前者从设计上就不存在这个窗口：
// SQLite 对单条语句的执行本身是原子的，多个进程/连接并发对同一行触发
// upsert，谁先谁后由 SQLite 的写锁天然序列化，都会各自读到「当前」状态并正确转移，
// 不会有一个写入把另一个写入的状态判断基于的旧值覆盖掉。
//
// `markAddressed` 同理：`UPDATE ... WHERE id=? AND state IN ('open','reflagged')`
// 本身就是状态守卫——两个并发的 markAddressed 只有一个能匹配到 WHERE，
// 另一个 changes=0，读回真实状态后抛出明确错误，而不是静默地把 note 覆盖掉。
// 这是与 rev 数字版本号等价的守卫机制，只是守卫条件是「状态」本身而不是一个计数器。
//
// journal_mode=WAL + busy_timeout：跨进程的两次写入仍然会被 SQLite 的文件锁串行化
// （WAL 下允许读不阻塞写，但同一时刻只有一个写者）；busy_timeout 让第二个写者等锁
// 而不是立刻收到 SQLITE_BUSY 报错——与 records.ts / artifacts/store.ts 的 WAL 设置
// 同一套纪律，额外加了 busy_timeout（那两处没加，但这里的 upsert 更可能撞并发写）。
export class FindingsStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        session TEXT,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        checker TEXT NOT NULL,
        severity TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        evidence TEXT,
        note TEXT,
        reflag_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_by TEXT
      );

      -- 去重键（reviewer 每轮按 checker+target+fingerprint upsert，同一个问题反复被报
      -- 不应该变成 N 条）。target_kind 一并入键：record 与 artifact 的 id 各自的
      -- 唯一性互不保证，理论上可能撞同一个字符串。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_dedupe
        ON findings (checker, target_kind, target_id, fingerprint);

      CREATE INDEX IF NOT EXISTS idx_findings_project_state ON findings (project, state);
      CREATE INDEX IF NOT EXISTS idx_findings_target ON findings (target_kind, target_id);
    `);
  }

  // 一轮 review 针对某个 (checker, target) 重新跑过之后调用一次：
  // - hits 里的每个 fingerprint → upsert（首次 open；从 addressed/resolved 命中 → reflagged
  //   + reflagCount++；open/reflagged 续命中 → 只刷新 lastSeenAt/evidence，不算 reflag——
  //   reflag 记的是「以为处理好了结果没有」，不是「还没处理它一直都在」）。
  // - 上一轮还是 open/addressed/reflagged、这一轮 fingerprint 集合里已经不存在的
  //   → resolved。
  //
  // 这一个方法把「去重 upsert」与「复核闭环」绑在同一次调用里，因为二者共享同一个
  // 「这一轮到底检查了哪些 fingerprint」的上下文——拆成两个独立方法会把这份上下文
  // 让调用方自己传两遍，容易传漏。
  reviewTarget(input: ReviewTargetInput): ReviewTargetResult {
    const { project, target, checker } = input;
    const session = input.session ?? null;
    const now = new Date().toISOString();
    const hitFingerprints = input.hits.map((h) => h.fingerprint);

    const upsertStmt = this.db.query(`
      INSERT INTO findings (
        id, project, session, target_kind, target_id, checker, severity, fingerprint,
        state, evidence, note, reflag_count, first_seen_at, last_seen_at, resolved_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, 0, ?, ?, NULL)
      ON CONFLICT(checker, target_kind, target_id, fingerprint) DO UPDATE SET
        severity = excluded.severity,
        evidence = excluded.evidence,
        session = excluded.session,
        last_seen_at = excluded.last_seen_at,
        state = CASE
          WHEN findings.state IN ('addressed', 'resolved') THEN 'reflagged'
          ELSE findings.state
        END,
        reflag_count = CASE
          WHEN findings.state IN ('addressed', 'resolved') THEN findings.reflag_count + 1
          ELSE findings.reflag_count
        END
    `);

    const resolveStmt =
      hitFingerprints.length > 0
        ? this.db.query(`
            UPDATE findings SET state = 'resolved'
            WHERE checker = ? AND target_kind = ? AND target_id = ?
              AND state IN ('open', 'addressed', 'reflagged')
              AND fingerprint NOT IN (${hitFingerprints.map(() => "?").join(", ")})
          `)
        : this.db.query(`
            UPDATE findings SET state = 'resolved'
            WHERE checker = ? AND target_kind = ? AND target_id = ?
              AND state IN ('open', 'addressed', 'reflagged')
          `);

    // 整批（N 条 upsert + 1 条 resolve）包一个事务：要么这一轮 reviewTarget 完整生效，
    // 要么完全不生效——不会出现「upsert 了一半，resolve 用了另一轮的 hits 列表」这种
    // 半成品状态。SQLite 的写锁保证与另一次并发的 reviewTarget（哪怕目标不同）互相
    // 串行，不会交叉写坏同一行。
    const run = this.db.transaction((hits: FindingHit[]) => {
      for (const hit of hits) {
        upsertStmt.run(
          randomUUID(),
          project,
          session,
          target.kind,
          target.id,
          checker,
          hit.severity,
          hit.fingerprint,
          hit.evidence ?? null,
          now,
          now,
        );
      }
      if (hitFingerprints.length > 0) {
        resolveStmt.run(checker, target.kind, target.id, ...hitFingerprints);
      } else {
        resolveStmt.run(checker, target.kind, target.id);
      }
    });
    run(input.hits);

    const rows = this.db
      .query(
        `SELECT * FROM findings WHERE checker = ? AND target_kind = ? AND target_id = ? ORDER BY first_seen_at`,
      )
      .all(checker, target.kind, target.id) as FindingRow[];
    const all = rows.map(mapRow);
    const hitSet = new Set(hitFingerprints);
    return {
      findings: all.filter((f) => hitSet.has(f.fingerprint)),
      resolved: all.filter((f) => !hitSet.has(f.fingerprint) && f.state === "resolved"),
    };
  }

  // 人工标记「已处理」——只能从 open/reflagged 转过去（并发守卫见上面的大段注释）。
  markAddressed(id: string, opts: { note?: string | null; actor?: string | null } = {}): FindingRecord {
    const now = new Date().toISOString();
    const result = this.db
      .query(`UPDATE findings SET state = 'addressed', note = ?, resolved_by = ?, last_seen_at = ?
              WHERE id = ? AND state IN ('open', 'reflagged')`)
      .run(opts.note ?? null, opts.actor ?? null, now, id);
    if (result.changes === 0) {
      const existing = this.get(id);
      if (!existing) throw new FindingsStoreError(`finding '${id}' 不存在`);
      throw new FindingsStoreError(
        `finding '${id}' 当前状态是 '${existing.state}'，只能从 open/reflagged 标记为 addressed`,
      );
    }
    return this.get(id)!;
  }

  get(id: string): FindingRecord | null {
    const row = this.db.query("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | null;
    return row ? mapRow(row) : null;
  }

  list(filter: ListFilter = {}): FindingRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.project) {
      clauses.push("project = ?");
      params.push(filter.project);
    }
    if (filter.checker) {
      clauses.push("checker = ?");
      params.push(filter.checker);
    }
    if (filter.state) {
      clauses.push("state = ?");
      params.push(filter.state);
    } else if (filter.open) {
      clauses.push("state IN ('open', 'reflagged')");
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM findings${where} ORDER BY last_seen_at DESC`)
      .all(...params) as FindingRow[];
    return rows.map(mapRow);
  }

  close(): void {
    this.db.close();
  }
}
