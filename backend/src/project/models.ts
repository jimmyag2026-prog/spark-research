// Project 与 Research Record 的数据模型（DESIGN §5.2 AD-1/AD-3、域 C1）。

import type { ProvenanceClass } from "../provenance/policy";

export const RECORD_TYPES = [
  "idea",
  "decision",
  "experiment",
  "observation",
  "reading",
  "conclusion",
  "paper",
  "artifact",
  // 第 9 类（v0.4 W3-b）：一次 agent / 子代理运行的帧级记账。
  // 落图而不是另起一张表——于是 report / lineage / UI 时间线全部免费获得
  // （它们本来就读图）。同时带 systemHash / promptHash，回答「这个产物是
  // 哪个模型、哪版 prompt 产的」（OpenScience 的 harness 指纹等价物）。
  "agent_run",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const EDGE_TYPES = [
  "supports",
  "contradicts",
  "derives_from",
  "cites",
  "supersedes",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

// core.txt 定义的证据分类：观察 / 引用外部来源 / 计算得出 / 推理得出。
export const EVIDENCE_LABELS = ["observed", "sourced", "computed", "inferred"] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export const ORIGIN_KINDS = ["session", "cell", "connector", "manual", "import"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

// record 的来源：会话 / cell / connector 调用（DESIGN 域 C1）。
export interface RecordOrigin {
  kind: OriginKind;
  sessionId?: string | null;
  // cell id、connector 调用 id 或导入来源路径，按 kind 解释。
  ref?: string | null;
  connector?: string | null;
}

export interface ResearchRecord {
  id: string;
  project: string;
  type: RecordType;
  title: string;
  content: string;
  evidence: EvidenceLabel;
  origin: RecordOrigin;
  // AD-3：artifact 类型 record 通过 artifactId 指向 artifacts 表的版本 id。
  artifactId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  // v0.7 W7-D0 · L3 三列（DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md §五）：
  // 来源分级（AD-16 的判据）· 来源自述许可 · 统一质量标签（把散在各处 metadata 里的
  // deterministic / basis / simulated 等收成一列，导出与回流时可机器过滤）。
  provenanceClass: ProvenanceClass;
  license: string | null;
  quality: string[];
}

export interface RecordInput {
  type: RecordType;
  content: string;
  title?: string;
  evidence?: EvidenceLabel;
  origin?: RecordOrigin;
  artifactId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  /**
   * v0.7：生产写入方**必须显式声明**（源码门禁 tests/unit/provenance.test.ts 逐个写入点核）。
   * 省略时按 `classForOrigin()` 兜底——那是给老库回填与测试用的口径，不是给生产代码偷懒的。
   */
  provenanceClass?: ProvenanceClass;
  license?: string | null;
  quality?: string[];
}

export interface RecordEdge {
  sourceId: string;
  targetId: string;
  type: EdgeType;
  createdAt: string;
}

export interface RecordFilter {
  type?: RecordType | RecordType[];
  evidence?: EvidenceLabel;
  provenanceClass?: ProvenanceClass;
  sessionId?: string;
  artifactId?: string;
  limit?: number;
  // P7 时间线：时间窗（含端点，ISO8601 字符串按字典序比较即时序）+ 分页偏移。
  // 过滤放在 SQL 里而不是取全量再切，是为了 total 与 page 用同一套谓词。
  since?: string;
  until?: string;
  offset?: number;
}

export interface RecordGraphData {
  rootId: string;
  nodes: ResearchRecord[];
  edges: RecordEdge[];
}

// v0.7 W7-D1 · L1 记录日志（DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md §五）：records 是可变投影
// （状态机需要 CAS 改写），它下面的 records_journal 只追加——每次 create/update/link/
// tombstone/repair 一行，带 prevHash 链。AD-15：证据图可由日志重建（repair 就是局部重建）。
export const JOURNAL_OPS = ["create", "backfill", "update", "link", "tombstone", "repair"] as const;
export type JournalOp = (typeof JOURNAL_OPS)[number];

export interface JournalEntry {
  seq: number;
  recordId: string;
  op: JournalOp;
  revBefore: number | null;
  revAfter: number | null;
  actor: string | null;
  actorSource: string | null;
  /** create/backfill：全量快照；update：调用方传入的 patch；link：{targetId,type}；repair：{toSeq}。 */
  patch: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
  createdAt: string;
}

export type ProjectStatus = "active" | "archived";

// project.json 的内容；schemaVersion 便于后续迁移。
export interface ProjectMeta {
  schemaVersion: number;
  slug: string;
  name: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPaths {
  root: string;
  metaFile: string;
  recordsDb: string;
  libraryDb: string;
  artifactsDir: string;
  artifactsDb: string;
  papersDir: string;
  experimentsDir: string;
  /** v0.7 · L0 原始层：`raw/{connector,llm,kernel,device}/<date>.jsonl` + `raw/blobs/`。 */
  rawDir: string;
}

// 根目录状态：当前项目 + session→project 归属（AD-1）。
export interface WorkspaceState {
  currentProject: string | null;
  sessions: Record<string, string>;
}
