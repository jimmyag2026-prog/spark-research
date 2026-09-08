// Project 与 Research Record 的数据模型（DESIGN §5.2 AD-1/AD-3、域 C1）。

export const RECORD_TYPES = [
  "idea",
  "decision",
  "experiment",
  "observation",
  "reading",
  "conclusion",
  "paper",
  "artifact",
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
  sessionId?: string;
  artifactId?: string;
  limit?: number;
}

export interface RecordGraphData {
  rootId: string;
  nodes: ResearchRecord[];
  edges: RecordEdge[];
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
}

// 根目录状态：当前项目 + session→project 归属（AD-1）。
export interface WorkspaceState {
  currentProject: string | null;
  sessions: Record<string, string>;
}
