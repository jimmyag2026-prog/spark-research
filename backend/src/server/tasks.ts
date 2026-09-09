import { randomUUID } from "node:crypto";

// 长任务句柄（P7）。
//
// 为什么需要它：文献检索、精读卡、综述、novelty check、干实验 run、湿实验 simulate
// 都是数秒到数分钟的任务。HTTP 请求上直接 await 会让浏览器超时、也没法给进度。
// 口径：**提交即返回任务句柄**，客户端用 `GET /api/tasks/:id` 轮询或 `.../stream` 走 SSE。
//
// 三条纪律：
//   1. 任务函数**自己持有**它需要的存储句柄并在结束时关掉——请求早已返回，
//      不能依赖请求作用域里的 project handle。
//   2. 失败是一等结果：`state=failed` + `error`，不是把异常吞掉留个「running」。
//   3. 事件是**只增日志**（`events`），晚订阅的客户端能补齐历史，不会丢开头。

export const TASK_STATES = ["pending", "running", "succeeded", "failed"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type TaskEventType = "state" | "progress" | "result" | "error";

export interface TaskEvent {
  seq: number;
  at: string;
  type: TaskEventType;
  message: string | null;
  data: unknown;
}

export interface TaskProgress {
  done: number;
  total: number | null;
  message: string | null;
}

export interface TaskSnapshot {
  id: string;
  kind: string;
  project: string | null;
  state: TaskState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: TaskProgress | null;
  result: unknown;
  error: { message: string } | null;
  events: TaskEvent[];
}

export interface TaskHandle {
  progress(done: number, total: number | null, message?: string): void;
  note(message: string, data?: unknown): void;
}

interface TaskEntry {
  snapshot: TaskSnapshot;
  subscribers: Set<(event: TaskEvent) => void>;
  settled: Promise<TaskSnapshot>;
}

export interface StartTaskOptions {
  kind: string;
  project?: string | null;
  run: (handle: TaskHandle) => Promise<unknown>;
}

export class TaskRegistry {
  private entries = new Map<string, TaskEntry>();
  private readonly now: () => string;
  // 只保留最近 N 条：本地单用户场景下够用，也避免长跑进程无上限吃内存。
  private readonly capacity: number;

  constructor(options: { now?: () => string; capacity?: number } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.capacity = options.capacity ?? 200;
  }

  start(options: StartTaskOptions): TaskSnapshot {
    const id = randomUUID();
    const createdAt = this.now();
    const snapshot: TaskSnapshot = {
      id,
      kind: options.kind,
      project: options.project ?? null,
      state: "pending",
      createdAt,
      startedAt: null,
      finishedAt: null,
      progress: null,
      result: null,
      error: null,
      events: [],
    };
    let resolveSettled: (value: TaskSnapshot) => void;
    const settled = new Promise<TaskSnapshot>((resolve) => {
      resolveSettled = resolve;
    });
    const entry: TaskEntry = { snapshot, subscribers: new Set(), settled };
    this.entries.set(id, entry);
    this.evict();

    const handle: TaskHandle = {
      progress: (done, total, message) => {
        if (entry.snapshot.state === "succeeded" || entry.snapshot.state === "failed") return;
        entry.snapshot.progress = { done, total, message: message ?? null };
        this.emit(entry, "progress", message ?? null, entry.snapshot.progress);
      },
      note: (message, data) => {
        if (entry.snapshot.state === "succeeded" || entry.snapshot.state === "failed") return;
        this.emit(entry, "progress", message, data ?? null);
      },
    };

    // 先把 pending → running 落下，再进异步体：轮询端点在第一次 tick 前也能看到正确状态。
    entry.snapshot.state = "running";
    entry.snapshot.startedAt = this.now();
    this.emit(entry, "state", "running", { state: "running" });

    void (async () => {
      try {
        const result = await options.run(handle);
        entry.snapshot.state = "succeeded";
        entry.snapshot.result = result ?? null;
        entry.snapshot.finishedAt = this.now();
        this.emit(entry, "result", null, result ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.snapshot.state = "failed";
        entry.snapshot.error = { message };
        entry.snapshot.finishedAt = this.now();
        this.emit(entry, "error", message, { message });
      } finally {
        this.emit(entry, "state", entry.snapshot.state, { state: entry.snapshot.state });
        entry.subscribers.clear();
        resolveSettled!(entry.snapshot);
      }
    })();

    return entry.snapshot;
  }

  get(id: string): TaskSnapshot | null {
    return this.entries.get(id)?.snapshot ?? null;
  }

  list(filter: { project?: string; state?: TaskState; limit?: number } = {}): TaskSnapshot[] {
    const all = [...this.entries.values()]
      .map((e) => e.snapshot)
      .filter((s) => (filter.project ? s.project === filter.project : true))
      .filter((s) => (filter.state ? s.state === filter.state : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter.limit ? all.slice(0, filter.limit) : all;
  }

  // 订阅返回「历史事件 + 取消订阅函数」：晚订阅者也拿得到开头。
  subscribe(id: string, listener: (event: TaskEvent) => void): { history: TaskEvent[]; cancel: () => void } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const history = [...entry.snapshot.events];
    if (entry.snapshot.state === "succeeded" || entry.snapshot.state === "failed") {
      return { history, cancel: () => {} };
    }
    entry.subscribers.add(listener);
    return { history, cancel: () => entry.subscribers.delete(listener) };
  }

  // 等任务落定。给「同步模式」（`await=true`）与测试用；UI 走轮询/SSE。
  async settle(id: string): Promise<TaskSnapshot | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return entry.settled;
  }

  private emit(entry: TaskEntry, type: TaskEventType, message: string | null, data: unknown): void {
    const event: TaskEvent = {
      seq: entry.snapshot.events.length,
      at: this.now(),
      type,
      message,
      data,
    };
    entry.snapshot.events.push(event);
    for (const subscriber of entry.subscribers) {
      try {
        subscriber(event);
      } catch {
        // 单个订阅者（断开的 SSE 连接）不该影响任务本身。
      }
    }
  }

  private evict(): void {
    if (this.entries.size <= this.capacity) return;
    const done = [...this.entries.entries()]
      .filter(([, e]) => e.snapshot.state === "succeeded" || e.snapshot.state === "failed")
      .sort((a, b) => a[1].snapshot.createdAt.localeCompare(b[1].snapshot.createdAt));
    for (const [id] of done.slice(0, this.entries.size - this.capacity)) {
      this.entries.delete(id);
    }
  }
}
