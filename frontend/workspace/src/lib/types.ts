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
  // v0.7 · L3 三列（后端保证非空；老快照可能缺，故可选）。
  provenanceClass?: "upstream" | "derived" | "user_authored" | "model_generated";
  license?: string | null;
  quality?: string[];
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
  // V79①：后端 `/api/lit/papers` 早就透传了这个字段（backend/src/literature/library.ts
  // 的 LibraryPaper），前端类型此前没声明——综述引用 span 想跳转证据图对应 record，
  // 就靠它把 bibtexKey 映射回 record id（见 state.tsx 的 recordIdForKey）。
  recordId: string | null;
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
  compiledSteps: Array<{
    stepId: string;
    action: string;
    detail?: string;
    execution?: string;
    // V60（BACKLOG）：这一步引用的试剂一个都不在词表内时才有值——`rawText` 是解析器
    // 从用户原句里抠出来的候选原文（抠不出时字段仍在，只是没有 rawText）。批准弹窗
    // 必须显示它并标「词表外，安全规则未覆盖」：人批准的是物理世界的操作（AD-6），
    // 不能批一个自己看不到原文、也不知道安全规则根本没检查过的东西。
    unrecognizedReagent?: { rawText?: string };
  }>;
  compileWarnings: string[];
  // R-d-3（v0.4 P11 lane R-d / V23）：编译器看到了量纲/试剂/浓度/生物安全等级之类的信号，
  // 但没有任何安全门规则消费它——「用户写了但安全门没看见」。concentration_limit /
  // biosafety 两条规则在自然语言主管线上恒空转（BACKLOG V25），这是唯一的兜底告警，
  // 批准弹窗必须显眼展示，不能只是 JSON 字段里悄悄带着。
  unconsumedWarnings: string[];
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
  error: { message: string; timeout?: boolean } | null;
  events: TaskEvent[];
  // V11：进程重启后从磁盘 hydrate 回来、且仍非终态的快照才带这个字段——本进程没有
  // 真实执行体在跑它，只是诚实地继续报 running（不是 failed 也不是 succeeded）。
  // 见 backend/src/server/tasks.ts 顶部大注释。
  recovered?: { at: string; reason: "no-terminal-record-on-disk" } | null;
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

// P8：结论卡与研究报告。字段与 backend/src/conclusion/models.ts 一一对应
// （UI 不推导任何后端没给的状态）。
export interface ConclusionFinding {
  rule: string;
  severity: "hard" | "soft";
  message: string;
  detail?: Record<string, unknown>;
}

export interface ConclusionReviewStamp {
  state: "pending" | "approved" | "vetoed";
  at: string | null;
  actor: string | null;
  actorSource: string | null;
  hardCount: number;
  softCount: number;
  findings: ConclusionFinding[];
  reason: string | null;
  decisionRecordId: string | null;
}

export interface ConclusionCard {
  recordId: string;
  project: string;
  title: string;
  claim: string;
  limitations: string | null;
  confidence: string | null;
  mode: "dry" | "wet" | "manual";
  experimentId: string | null;
  evidenceIds: string[];
  review: ConclusionReviewStamp;
  createdAt: string;
}

export interface ConclusionAssessment {
  hardCount: number;
  softCount: number;
  wouldApprove: boolean;
  reconciliation: "bitwise" | "interval" | "unknown";
  findings: Array<{ rule?: string; severity: "hard" | "soft"; message: string }>;
  evidence: Array<{ id: string; ok: boolean; simulated: boolean; deterministic: boolean | null; linked: boolean }>;
}

export interface ReportCounts {
  papers: number;
  readings: number;
  ideas: number;
  dryExperiments: number;
  wetExperiments: number;
  observations: number;
  approvedConclusions: number;
  unverifiedConclusions: number;
  decisions: number;
}

// W6-1 β：工作台四面板契约类型。字段名与各自后端出口逐字段一致——
// backend/src/usage/ledger.ts UsageTotals · backend/src/usage/api_ledger.ts ApiCallTotals ·
// backend/src/compute/job_store.ts ComputeJobView · backend/src/compute/plan.ts ComputePlan/CostEstimate。
// 手写而不是导入：与本文件顶部注释同一条纪律（前后端各自 tsconfig）。

export interface UsageAgg {
  calls: number;
  knownCostUsd: number;
  unknownCostCalls: number;
}

export interface UsageTotals {
  project: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 已知成本之和——真实总花费的下界，绝不是「总花费」。 */
  knownCostUsd: number;
  unknownCostCalls: number;
  byCommand: Record<string, UsageAgg>;
  byModel: Record<string, UsageAgg>;
  corruptLines: number;
}

export interface ApiCallAgg {
  calls: number;
  count429: number;
  count401: number;
  otherNon2xx: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface ApiCallTotals extends ApiCallAgg {
  byConnector: Record<string, ApiCallAgg>;
  byHost: Record<string, ApiCallAgg>;
  corruptLines: number;
}

export type ComputeExecutionState =
  | "planned"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted";
export type ComputeDeliveryState = "none" | "pending" | "complete" | "rejected" | "failed";
export type ComputeResourceState = "none" | "starting" | "active" | "closed" | "unknown";

export interface ComputeLifecycle {
  execution: ComputeExecutionState;
  delivery: ComputeDeliveryState;
  resource: ComputeResourceState;
  recoverable: boolean;
}

export interface ComputeTargetRef {
  kind: "local" | "modal" | "ssh";
  environment?: string;
}

export interface ComputeCostEstimate {
  unit: "computeSeconds";
  quantity: number;
  unitPriceUsd: number | null;
  upperBoundUsd: number | null;
  source: string | null;
  verifiedDate: string | null;
}

export interface ComputePlanView {
  digest: string;
  target: ComputeTargetRef;
  purpose: string;
  command: string[];
  env: Record<string, string>;
  resources: { gpu: string | null; cpus: number; memoryGb: number; timeoutMinutes: number };
  network: "none" | "unrestricted";
  uploads: Array<{ path: string; size: number; sha256: string }>;
  uploadBytes: number;
  outputs: string[];
  approvalRequired: boolean;
  estimate: ComputeCostEstimate;
  warning: string;
}

export interface ComputeApprovalMeta {
  decisionRecordId: string;
  actor: string;
  actorSource: string;
  at: string;
  planDigest: string;
  note: string | null;
}

// 只读投影（DESIGN V47 裁定）：这个类型故意不包含任何"派发/审批可以做什么"的
// 前端推导——UI 只展示后端给的字段，不推断下一步动作按钮。
export interface ComputeJobView {
  jobId: string;
  projectSlug: string;
  experimentId: string | null;
  target: ComputeTargetRef;
  lifecycle: ComputeLifecycle;
  rev: number;
  approval: ComputeApprovalMeta | null;
  consumedApproval: ComputeApprovalMeta | null;
  supersededApproval: ComputeApprovalMeta | null;
  rejection: (ComputeApprovalMeta & { reason: string }) | null;
  adapterHandle: unknown;
  createdAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  message: string | null;
  actualCostUsd: number | null;
  jobDir: string;
  plan: ComputePlanView;
  next: string;
}
