export interface SubTask {
  id: string;
  description: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
}

export interface SwarmResult {
  subTaskId: string;
  success: boolean;
  output: unknown;
  error?: string;
  durationMs: number;
}

export interface SwarmSummary {
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  maxConcurrency: number;
  peakConcurrency?: number;
  results: SwarmResult[];
}

export interface SwarmRunOptions {
  concurrencyLimit?: number;
}

export interface SwarmRunOutput {
  subTasks: SubTask[];
  summary: SwarmSummary;
  aggregate: Record<string, unknown>;
}
