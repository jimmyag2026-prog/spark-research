export interface ChatRequest {
  sessionId: string;
  message: string;
  model?: string;
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
