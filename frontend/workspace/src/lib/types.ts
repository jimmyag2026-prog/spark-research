// 前端用的 API 形状。刻意手写而不是从后端类型导入：
// 前端与后端各自 tsconfig（一个有 DOM 一个没有），跨目录 import 会把 bun 类型拖进来。
// 字段名与 backend/src/server/types.ts 保持一致，两边不一致会在 e2e 里立刻暴露。

export type RecordType =
  | "idea"
  | "decision"
  | "experiment"
  | "observation"
  | "reading"
  | "conclusion"
  | "paper"
  | "artifact";

export type EvidenceLabel = "observed" | "sourced" | "computed" | "inferred";

export type EdgeType = "supports" | "contradicts" | "derives_from" | "cites" | "supersedes";

export interface ResearchRecord {
  id: string;
  project: string;
  type: RecordType;
  title: string;
  content: string;
  evidence: EvidenceLabel;
  origin: { kind: string; sessionId: string | null; ref: string | null; connector: string | null };
  artifactId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RecordEdge {
  sourceId: string;
  targetId: string;
  type: EdgeType;
  createdAt: string;
}

export interface ProjectMeta {
  slug: string;
  name: string;
  description: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary extends ProjectMeta {
  current: boolean;
  counts: {
    records: number;
    papers: number;
    ideas: number;
    dryExperiments: number;
    wetExperiments: number;
  };
  paths: { root: string; papersDir: string; artifactsDir: string; experimentsDir: string };
}

export interface LibraryPaper {
  id: string;
  title: string;
  authors: Array<{ name: string }>;
  year: number | null;
  venue: string | null;
  doi: string | null;
  abstract: string | null;
  tags: string[];
  readingStatus: "unread" | "reading" | "read" | "skimmed";
  pdfStatus: "absent" | "downloaded" | "unavailable";
  bibtexKey: string | null;
}

export interface ReadingCard {
  recordId: string;
  paperId: string;
  bibtexKey: string;
  researchQuestion: string;
  methods: string;
  keyFindings: string[];
  limitations: string[];
  relationToProject: string;
}

export interface IdeaCard {
  recordId: string;
  hypothesis: string;
  critique: string;
  supporting: Array<{ key?: string; note: string; inferred?: boolean }>;
  contradicting: Array<{ key?: string; note: string; inferred?: boolean }>;
  openQuestions: string[];
  noveltyStatus: "unchecked" | "checked-novel" | "checked-incremental" | "checked-overlap";
  noveltyReportRecordId: string | null;
  checkedAt: string | null;
}

export type SummaryValue = string | number | boolean | null;

export interface DryExperiment {
  id: string;
  title: string;
  state: string;
  platform: string;
  simKind: string;
  params: Record<string, unknown>;
  hypothesis: string | null;
  runId: string | null;
  attempts: number;
  iteration: number;
  history: Array<{ from: string; to: string; at: string; note: string | null }>;
  summary: Record<string, SummaryValue> | null;
  observationId: string | null;
  conclusionId: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface WetExperiment {
  id: string;
  title: string;
  state: string;
  backend: string;
  naturalLanguage: string;
  protocolHash: string | null;
  robotType: string | null;
  apiLevel: string | null;
  deck: Array<{ slot: string; load: string; label?: string }>;
  compiledSteps: Array<{ stepId: string; action: string; detail?: string; execution?: string }>;
  compileWarnings: string[];
  safetyChecks: Array<{ check: string; passed: boolean; detail: string | null }>;
  safetyPassed: boolean | null;
  approval: { actor: string; at: string; protocolHash: string; note: string | null; decisionRecordId: string } | null;
  rejection: { actor: string; at: string; reason: string; decisionRecordId: string } | null;
  runId: string | null;
  attempts: number;
  iteration: number;
  history: Array<{ from: string; to: string; at: string; note: string | null }>;
  summary: Record<string, SummaryValue> | null;
  runLogEntryCount: number | null;
  artifactRecordIds: string[];
  observationId: string | null;
  conclusionId: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface StateMachine {
  mode: "dry" | "wet";
  states: string[];
  transitions: Record<string, string[]>;
  terminal: string[];
  awaiting: string | null;
  approvalGate?: { from: string; to: string; requires: string[] };
}

export type TaskState = "pending" | "running" | "succeeded" | "failed";

export interface TaskEvent {
  seq: number;
  at: string;
  type: "state" | "progress" | "result" | "error";
  message: string | null;
  data: unknown;
}

export interface TaskSnapshot {
  id: string;
  kind: string;
  project: string | null;
  state: TaskState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { done: number; total: number | null; message: string | null } | null;
  result: unknown;
  error: { message: string } | null;
  events: TaskEvent[];
}

export interface CitationFinding {
  severity: "hard" | "soft";
  message: string;
  key?: string;
}

export interface ReviewResult {
  draft: { markdown: string; path: string; artifactId: string | null; recordId: string | null; citedKeys: string[] };
  cardCount: number;
  citation: { citations: unknown[]; findings: CitationFinding[]; unknownKeys?: string[] };
  vetoed: boolean;
}

export interface NoveltyResult {
  ideaId: string;
  status: { status: string; conclusive: boolean };
  claims: Array<{ id: string; statement: string; queries: string[] }>;
  assessments: Array<{
    claimId: string;
    rating: string;
    declaredRating: string;
    nearestWorks: Array<{ key: string; sameness: string; difference: string }>;
    violations: Array<{ code: string; message: string }>;
  }>;
  markdown: string;
  citation: { findings: CitationFinding[] };
  conclusive: boolean;
  vetoed: boolean;
}

export interface ArtifactVersion {
  id: string;
  filename: string;
  version: number;
  contentType: string;
  checksum: string;
  createdAt: string;
  producingCellId: string | null;
}
