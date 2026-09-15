import { configuredChatSyncMaxMs } from "../config";
import type { TaskSnapshot } from "./tasks";

// δ-4（V156 ①）：同步 `POST /api/session/chat` 的超时兜底。
//
// 现场（R6 基线 U13）：Bun.serve 的 `idleTimeout` 上限是 255s（A5 已定），基线 20 轮里
// 3 轮 >170s，t2 有一轮 287s。那一轮的结局不是「超时报错」而是**HTTP 0**：连接被 server
// 自己掐断，客户端什么都没拿到，而编排在后台照样跑完——模型的钱花了，结果没人接收，
// 甚至后续调用被算进了下一轮的计数里。这是最坏的失败形状：既没结果，也没人知道出了事。
//
// 做法（方向①，已裁定）：chat 一律**先进任务注册表**（跟其它长任务同一条路），然后同步等
// `chatSyncMaxMs`（默认 200s，留 55s 余量）。等到了就照旧 200 + 完整结果，调用方一个字
// 都不用改；等不到就 202 + `taskId`，任务在后台继续跑，调用方拿句柄去 `/api/tasks/:id`
// 或 `.../stream` 接回——**结果不再蒸发**。
//
// 为什么不是「超时就取消」：取消是方向③（V156 里与 ①② 不互斥的另一条），它要的是客户端
// 断开信号透传进编排，属于 orchestrator 的口子，不在本 lane。这里只保证「已经在跑的东西
// 有人接得住」，不替用户决定该不该停。
//
// 为什么判据放在这个文件：`server/routes/session.ts` 是收口专属，本 lane 只能往它塞几行
// 调用；逻辑与门禁都住在这里。

export const CHAT_SYNC_MAX_MS_DEFAULT = 200_000;

/** Bun.serve 的 idleTimeout 上限（A5 定）。超过它，掐断连接的是 server 自己，兜底就失效了。 */
export const BUN_SERVE_IDLE_TIMEOUT_CEILING_MS = 255_000;

export function chatSyncMaxMs(options: { root?: string } = {}): number {
  return configuredChatSyncMaxMs(CHAT_SYNC_MAX_MS_DEFAULT, options);
}

export type ChatSyncOutcome<T> =
  | { kind: "result"; result: T; task: TaskSnapshot }
  | { kind: "accepted"; task: TaskSnapshot };

export interface ChatSyncTaskRegistry {
  start(options: { kind: string; project?: string | null; run: () => Promise<unknown> }): TaskSnapshot;
  settle(id: string): Promise<TaskSnapshot | null>;
}

export interface ChatSyncOptions<T> {
  tasks: ChatSyncTaskRegistry;
  run: () => Promise<T>;
  maxMs: number;
  kind?: string;
  project?: string | null;
  /** 注入点（测试用）：默认 setTimeout。返回的 cancel 用来清掉定时器——不清的话，
   * 每一次在上限之前正常返回的 chat 都会留一个 200s 的定时器挂在事件循环上。 */
  sleep?: (ms: number) => { promise: Promise<void>; cancel: () => void };
}

function defaultSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * 跑一次 chat，最多同步等 `maxMs`。
 *
 * 等到了 → `{kind:"result"}`（任务同时落成终态，句柄仍可查，不浪费）。
 * 没等到 → `{kind:"accepted"}`，任务继续在后台跑。
 *
 * 任务体自己抛错时**照旧把异常抛给调用方**（路由层原来那套 CoExploreError → 422 的
 * 映射不能因为改走任务注册表就失效——那会把一个 422 静默降级成 500）。
 */
export async function runChatWithSyncDeadline<T>(options: ChatSyncOptions<T>): Promise<ChatSyncOutcome<T>> {
  const sleep = options.sleep ?? defaultSleep;
  let captured: T | undefined;
  let failure: unknown;
  let failed = false;
  const snapshot = options.tasks.start({
    kind: options.kind ?? "session.chat",
    project: options.project ?? null,
    run: async () => {
      try {
        captured = await options.run();
        return captured;
      } catch (error) {
        // 记下来再抛：抛出去是为了让任务落 failed（句柄上看得到真实错误），
        // 记下来是为了让还在同步等待的调用方拿到**原始异常对象**去做它的状态码映射。
        failed = true;
        failure = error;
        throw error;
      }
    },
  });

  const timedOut = Symbol("chat-sync-timeout");
  const deadline = sleep(options.maxMs);
  const settled = await Promise.race([options.tasks.settle(snapshot.id), deadline.promise.then(() => timedOut)]);
  deadline.cancel();
  if (settled === timedOut) return { kind: "accepted", task: snapshot };
  if (failed) throw failure;
  return { kind: "result", result: captured as T, task: (settled as TaskSnapshot | null) ?? snapshot };
}

/** 202 响应体。`hint` 不是装饰——拿到 202 的调用方必须知道下一步敲什么。 */
export function chatAcceptedBody(input: { sessionId: string; mode: string; task: TaskSnapshot; maxMs: number }): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    mode: input.mode,
    taskId: input.task.id,
    task: input.task,
    hint:
      `这次 chat 超过了同步等待上限 ${input.maxMs >= 1000 ? `${Math.round(input.maxMs / 1000)}s` : `${input.maxMs}ms`}（config: chatSyncMaxMs），已改走任务句柄——` +
      `任务仍在后台跑，用 GET /api/tasks/${input.task.id} 轮询或 GET /api/tasks/${input.task.id}/stream 订阅。` +
      `想要全程可见（阶段进度 + 正文流式），下次直接用 POST /api/session/stream。`,
  };
}
