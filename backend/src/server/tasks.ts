import { randomUUID } from "node:crypto";
import { configuredTaskTimeoutMs } from "../config";

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
  // timeout=true 时这是 D-2 的超时兜底触发的失败，不是任务体自己抛的错——
  // 让轮询/SSE 的消费方能把「上游挂起」和「上游报错」分开处理。
  error: { message: string; timeout?: boolean } | null;
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
  // 单个任务的超时上限（毫秒），覆盖 TaskRegistry 的默认值。传 0 或负数显式关闭。
  timeoutMs?: number;
}

// D-2：任务体本身可能因为一次没设超时的上游调用（旧代码路径、第三方库内部裸 fetch
// 之类）而永久挂起——TaskRegistry 是长任务的最后一道兜底，即便任务体自己没有任何
// 超时逻辑，也不能让 `GET /api/tasks/:id` 或 `{"await":true}` 的调用方永远等下去。
// config/ 面板（P9）没有对应设置项（只读不改，见 docs/devlog/P10-b.md），走
// env + 常量默认。10 分钟：比 config 里已有的 mcpTimeoutMs（300_000ms，MCP 工具
// 同步等长任务的上限）更宽——这里包的是任务体的整个生命周期（可能内含多轮
// review 修正循环），不是单次工具调用，需要更大的余量；同时仍然是个有限值，
// 一次真正挂死的调用最终会被结构化地报出来而不是让任务句柄永远停在 running。
// P10 收口：默认值收进 config 注册表（`CONFIG_SETTINGS.taskTimeoutMs`），优先级仍是
// env > config.json > 常量默认，与仓库其余配置项走同一套解析（P9「配置面收口」）。
// 做成函数而不是模块级常量：改了 config.json 不必重启进程。
function defaultTaskTimeoutMs(): number {
  return configuredTaskTimeoutMs(600_000);
}

export class TaskTimeoutError extends Error {
  readonly timeout = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`task timed out after ${timeoutMs}ms`);
    this.name = "TaskTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TaskTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class TaskRegistry {
  private entries = new Map<string, TaskEntry>();
  private readonly now: () => string;
  // 只保留最近 N 条：本地单用户场景下够用，也避免长跑进程无上限吃内存。
  private readonly capacity: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: { now?: () => string; capacity?: number; timeoutMs?: number } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.capacity = options.capacity ?? 200;
    this.defaultTimeoutMs = options.timeoutMs ?? defaultTaskTimeoutMs();
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

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    void (async () => {
      try {
        const result = await withTimeout(options.run(handle), timeoutMs);
        entry.snapshot.state = "succeeded";
        entry.snapshot.result = result ?? null;
        entry.snapshot.finishedAt = this.now();
        this.emit(entry, "result", null, result ?? null);
      } catch (error) {
        const timeout = error instanceof TaskTimeoutError;
        const message = error instanceof Error ? error.message : String(error);
        entry.snapshot.state = "failed";
        entry.snapshot.error = timeout ? { message, timeout: true } : { message };
        entry.snapshot.finishedAt = this.now();
        this.emit(entry, "error", message, { message, timeout });
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
