import type { ArtifactVersion } from "../artifacts/models";
import type { EdgeType, EvidenceLabel, RecordEdge, RecordType, ResearchRecord } from "../project/models";
import type { ProjectMeta } from "../project/models";
import type { SessionMode } from "../agents/orchestrator";
import type { TaskSnapshot } from "./tasks";

// ── v0.1 既有形态（保持不变，老端点与老测试依赖它） ───────────────────────────

export interface ChatRequest {
  sessionId: string;
  message: string;
  model?: string;
  mode?: SessionMode;
  /**
   * V119 的预算闸入口。A7 验收指出：路由**接受**这两个字段，但 `ChatRequest` 没声明，
   * 于是 `contract --json` 与据其生成的 SDK 都看不到它们——契约以遗漏的方式说了谎。
   * 契约必须反映真实接口（AD-12）。
   */
  budgetUsd?: number;
  allowUnpriced?: boolean;
}

export interface ChatResponse {
  response: string;
  artifacts?: unknown[];
  reviewResult?: unknown;
}

export interface ArtifactListResponse {
  artifacts: unknown[];
}

export interface LineageResponse {
  graph: unknown;
}

// ── P7 ────────────────────────────────────────────────────────────────────────

// 所有错误响应同一形状：UI 只需要认一种。
export interface ApiErrorBody {
  error: string;
  detail?: unknown;
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
  paths: {
    root: string;
    papersDir: string;
    artifactsDir: string;
    experimentsDir: string;
  };
}

export interface ProjectListResponse {
  projects: ProjectMeta[];
  current: string | null;
}

export interface RecordTimelinePage {
  project: string;
  records: ResearchRecord[];
  total: number;
  offset: number;
  limit: number;
  // 本页里出现过的类型（UI 的过滤器用它点亮可选项）。
  types: RecordType[];
}

export interface RecordGraphResponse {
  project: string;
  rootId: string;
  depth: number;
  nodes: ResearchRecord[];
  edges: RecordEdge[];
}

export interface RecordDetailResponse {
  project: string;
  record: ResearchRecord;
  outgoing: RecordEdge[];
  incoming: RecordEdge[];
  artifact: (ArtifactVersion & { content: string }) | null;
}

export interface TaskResponse {
  task: TaskSnapshot;
}

export type { EdgeType, EvidenceLabel, RecordType, TaskSnapshot };
