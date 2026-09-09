import type {
  ArtifactVersion,
  DryExperiment,
  IdeaCard,
  LibraryPaper,
  ProjectMeta,
  ProjectSummary,
  ReadingCard,
  RecordEdge,
  ResearchRecord,
  StateMachine,
  TaskSnapshot,
  WetExperiment,
} from "./types";

// API 客户端。一条纪律：**UI 不许有 API 之外的能力**——这里没有的东西，界面上就不该出现。

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers,
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const body = isJson && text ? (JSON.parse(text) as unknown) : text;
  if (!res.ok) {
    const message =
      isJson && body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, message, isJson ? (body as { detail?: unknown }).detail : body);
  }
  return body as T;
}

function withProject(path: string, project?: string): string {
  if (!project) return path;
  return path + (path.includes("?") ? "&" : "?") + `project=${encodeURIComponent(project)}`;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

// 长任务：提交拿句柄 → 订阅 SSE → 落定。
// 订阅失败（连接被切）时退化成轮询，不让界面卡在「运行中」。
export interface TaskRun {
  task: TaskSnapshot;
  onEvent?: (task: TaskSnapshot) => void;
}

export async function runTask(
  path: string,
  body: unknown,
  onProgress?: (message: string, task: TaskSnapshot) => void,
): Promise<TaskSnapshot> {
  const submitted = await post<{ task: TaskSnapshot }>(path, body);
  return waitForTask(submitted.task.id, onProgress);
}

export async function waitForTask(
  id: string,
  onProgress?: (message: string, task: TaskSnapshot) => void,
): Promise<TaskSnapshot> {
  try {
    await streamTask(id, (message) => {
      if (onProgress) void pollTask(id).then((task) => onProgress(message, task));
    });
  } catch {
    // SSE 不可用（代理、断线）时退化成轮询——功能不能依赖流。
    for (;;) {
      const task = await pollTask(id);
      if (task.state === "succeeded" || task.state === "failed") return task;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return pollTask(id);
}

export function pollTask(id: string): Promise<TaskSnapshot> {
  return request<{ task: TaskSnapshot }>(`/api/tasks/${id}`).then((r) => r.task);
}

// 订阅任务事件流，直到 done。
function streamTask(id: string, onMessage: (message: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/tasks/${id}/stream`);
    const finish = () => {
      source.close();
      resolve();
    };
    source.addEventListener("progress", (e) => {
      const payload = JSON.parse((e as MessageEvent).data) as { message: string | null };
      if (payload.message) onMessage(payload.message);
    });
    source.addEventListener("done", finish);
    source.addEventListener("error", () => {
      // EventSource 的 error 既可能是「连不上」也可能是「服务端关流」；
      // 两种都收敛到 resolve/reject 之后由调用方再拉一次快照定夺。
      source.close();
      reject(new Error("task stream closed"));
    });
  });
}

// ── 会话流（SSE over POST，EventSource 不支持 POST，所以自己读 body） ─────────

export interface StreamHandlers {
  onStart?: (data: { sessionId: string; mode: string }) => void;
  onProgress?: (data: { message: string }) => void;
  onResult?: (data: { response: string; review?: unknown; ideaRecordId?: string | null }) => void;
  onError?: (data: { message: string }) => void;
}

export async function streamChat(
  body: { sessionId: string; message: string; mode?: string },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/session/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    let message = `HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      /* 非 JSON 错误体，保留状态码 */
    }
    handlers.onError?.({ message });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      if (chunk.startsWith(":")) continue;
      const name = chunk.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
      const raw = chunk.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      if (!name || !raw) continue;
      const data = JSON.parse(raw) as never;
      if (name === "start") handlers.onStart?.(data);
      else if (name === "progress") handlers.onProgress?.(data);
      else if (name === "result") handlers.onResult?.(data);
      else if (name === "error") handlers.onError?.(data);
      else if (name === "done") return;
    }
  }
}

// ── 端点 ─────────────────────────────────────────────────────────────────────

export const api = {
  health: () => request<{ status: string; version: string }>("/api/health"),

  projects: {
    list: (all = false) =>
      request<{ projects: ProjectMeta[]; current: string | null }>(`/api/projects${all ? "?all=1" : ""}`),
    current: () => request<{ project: ProjectSummary }>("/api/projects/current"),
    create: (body: { slug: string; name?: string; description?: string }) =>
      post<{ project: ProjectSummary }>("/api/projects", body),
    open: (slug: string) => post<{ project: ProjectSummary }>("/api/projects/current", { slug }),
    archive: (slug: string) => post<{ project: ProjectMeta }>(`/api/projects/${slug}/archive`),
  },

  lit: {
    sources: () =>
      request<{
        sources: Array<{
          name: string;
          description: string;
          apiKeyRequired: boolean;
          credentialConfigured: boolean | null;
        }>;
        defaults: string[];
      }>("/api/lit/sources"),
    papers: (project?: string, filter: { tag?: string; status?: string; q?: string } = {}) => {
      const params = new URLSearchParams();
      if (filter.tag) params.set("tag", filter.tag);
      if (filter.status) params.set("status", filter.status);
      if (filter.q) params.set("q", filter.q);
      const qs = params.toString();
      return request<{ papers: LibraryPaper[]; citations: number }>(
        withProject(`/api/lit/papers${qs ? `?${qs}` : ""}`, project),
      );
    },
    cards: (project?: string) =>
      request<{ cards: ReadingCard[] }>(withProject("/api/lit/cards", project)),
    search: (
      body: { query: string; sources?: string[]; limit?: number; add?: boolean; tags?: string[] },
      project?: string,
      onProgress?: (m: string) => void,
    ) => runTask(withProject("/api/lit/search", project), body, onProgress),
    read: (body: { paperId?: string; all?: boolean; tag?: string }, project?: string, onProgress?: (m: string) => void) =>
      runTask(withProject("/api/lit/read", project), body, onProgress),
    review: (body: { topic?: string }, project?: string, onProgress?: (m: string) => void) =>
      runTask(withProject("/api/lit/review", project), body, onProgress),
    exportUrl: (format: "bibtex" | "csl", project?: string) =>
      withProject(`/api/lit/export?format=${format}`, project),
  },

  ideas: {
    list: (project?: string, status?: string) =>
      request<{ ideas: IdeaCard[] }>(
        withProject(`/api/ideas${status ? `?status=${encodeURIComponent(status)}` : ""}`, project),
      ),
    get: (id: string, project?: string) =>
      request<{ idea: IdeaCard; edges: { outgoing: RecordEdge[]; incoming: RecordEdge[] } }>(
        withProject(`/api/ideas/${id}`, project),
      ),
    coexplore: (
      body: { message: string; sessionId?: string; persist?: boolean },
      project?: string,
      onProgress?: (m: string) => void,
    ) => runTask(withProject("/api/ideas", project), body, onProgress),
    check: (id: string, project?: string, onProgress?: (m: string) => void) =>
      runTask(withProject(`/api/ideas/${id}/check`, project), {}, onProgress),
  },

  experiments: {
    machine: () => request<StateMachine>("/api/experiments/machine"),
    platforms: (project?: string) =>
      request<{ platforms: Array<{ id: string; description: string; ok: boolean; reason: string | null }>; default: string }>(
        withProject("/api/experiments/platforms", project),
      ),
    list: (project?: string, state?: string) =>
      request<{ experiments: DryExperiment[] }>(
        withProject(`/api/experiments${state ? `?state=${state}` : ""}`, project),
      ),
    get: (id: string, project?: string) =>
      request<{ experiment: DryExperiment; runStatus: { state: string } | null }>(
        withProject(`/api/experiments/${id}`, project),
      ),
    create: (
      body: { title: string; platform?: string; kind?: string; params?: Record<string, unknown>; hypothesis?: string },
      project?: string,
    ) => post<{ experiment: DryExperiment }>(withProject("/api/experiments", project), body),
    run: (id: string, body: { conclude?: string } = {}, project?: string, onProgress?: (m: string) => void) =>
      runTask(withProject(`/api/experiments/${id}/run`, project), body, onProgress),
  },

  lab: {
    machine: () => request<StateMachine>("/api/lab/machine"),
    backends: () =>
      request<{ backends: Array<{ id: string; description: string; ok: boolean; reason: string | null; default: boolean }> }>(
        "/api/lab/backends",
      ),
    list: (project?: string, state?: string) =>
      request<{ experiments: WetExperiment[] }>(
        withProject(`/api/lab/experiments${state ? `?state=${state}` : ""}`, project),
      ),
    get: (id: string, project?: string) =>
      request<{ experiment: WetExperiment }>(withProject(`/api/lab/experiments/${id}`, project)),
    compile: (body: { naturalLanguage: string; title?: string; hypothesis?: string; fromDry?: string }, project?: string) =>
      post<{ experiment: WetExperiment; safetyReport: { passed: boolean }; next: string }>(
        withProject("/api/lab/experiments", project),
        body,
      ),
    recompile: (id: string, body: { naturalLanguage?: string }, project?: string) =>
      post<{ experiment: WetExperiment; approvalCleared: boolean }>(
        withProject(`/api/lab/experiments/${id}/compile`, project),
        body,
      ),
    approve: (id: string, body: { actor: string; note?: string }, project?: string) =>
      post<{ experiment: WetExperiment; decisionId: string; decision: ResearchRecord }>(
        withProject(`/api/lab/experiments/${id}/approve`, project),
        body,
      ),
    reject: (id: string, body: { actor: string; reason: string }, project?: string) =>
      post<{ experiment: WetExperiment; decisionId: string; decision: ResearchRecord }>(
        withProject(`/api/lab/experiments/${id}/reject`, project),
        body,
      ),
    simulate: (id: string, body: { conclude?: string } = {}, project?: string, onProgress?: (m: string) => void) =>
      runTask(withProject(`/api/lab/experiments/${id}/simulate`, project), body, onProgress),
  },

  records: {
    meta: () => request<{ types: string[]; evidence: string[] }>("/api/records/meta"),
    list: (
      project?: string,
      filter: { type?: string[]; evidence?: string; since?: string; until?: string; limit?: number; offset?: number } = {},
    ) => {
      const params = new URLSearchParams();
      if (filter.type?.length) params.set("type", filter.type.join(","));
      if (filter.evidence) params.set("evidence", filter.evidence);
      if (filter.since) params.set("since", filter.since);
      if (filter.until) params.set("until", filter.until);
      params.set("limit", String(filter.limit ?? 100));
      params.set("offset", String(filter.offset ?? 0));
      return request<{ records: ResearchRecord[]; total: number; offset: number; limit: number }>(
        withProject(`/api/records?${params.toString()}`, project),
      );
    },
    get: (id: string, project?: string) =>
      request<{
        record: ResearchRecord;
        outgoing: RecordEdge[];
        incoming: RecordEdge[];
        artifact: (ArtifactVersion & { content: string }) | null;
      }>(withProject(`/api/records/${id}`, project)),
    graph: (id: string, depth = 2, project?: string) =>
      request<{ rootId: string; nodes: ResearchRecord[]; edges: RecordEdge[]; depth: number }>(
        withProject(`/api/records/${id}/graph?depth=${depth}`, project),
      ),
  },

  artifacts: {
    list: (project?: string) =>
      request<{ artifacts: ArtifactVersion[] }>(withProject("/api/artifacts", project)),
    get: (versionId: string, project?: string) =>
      request<{ artifact: ArtifactVersion & { content: string } }>(
        withProject(`/api/artifacts/version/${versionId}`, project),
      ),
  },

  session: {
    chat: (body: { sessionId: string; message: string; mode?: string }) =>
      post<{ response: string; ideaRecordId?: string | null; projectSlug: string | null }>(
        "/api/session/chat",
        body,
      ),
  },
};
