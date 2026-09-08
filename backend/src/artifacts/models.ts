export interface ArtifactVersion {
  id: string;
  // project：历史上的自由字符串字段，保留以兼容旧数据。
  project: string;
  // projectSlug：解析到真实 project 的引用（P1 起）；解析不出来时为 null。
  projectSlug: string | null;
  filename: string;
  version: number;
  contentType: string;
  checksum: string;
  storagePath: string;
  extractedCode: string | null;
  codeDescription: string | null;
  lineageMessages: LineageMessage[];
  environmentSnapshot: Record<string, unknown> | null;
  parentVersionId: string | null;
  producingCellId: string | null;
  dependencyMappings: DependencyMapping[];
  createdAt: string;
}

export interface LineageMessage {
  role?: string;
  content?: string;
  file?: string;
  kind?: "read" | "write" | "message";
  dependsOn?: string[];
}

export interface DependencyMapping {
  file: string;
  versionId: string;
}

export interface ExecutionRecord {
  id: string;
  frame: string;
  cellIndex: number;
  kernelId: string | null;
  language: string;
  source: string;
  stdout: string;
  stderr: string;
  status: string;
  filesWritten: string[];
  filesRead: string[];
  wallTime: number | null;
  cpuTime: number | null;
  peakMemory: number | null;
  createdAt: string;
}

export interface DependencyEdge {
  sourceVersionId: string;
  targetVersionId: string;
}
