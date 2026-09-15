// 输出看门狗（lane α-1 · USAGE_LOG U4 的另一半：等待期的可预期性）。
//
// **来源**：`outputWatchdog` / `watchOutput` 的计时状态机逐字移植自 OpenScience
// `backend/cli/src/session/output-watchdog.ts`（Apache-2.0）。移植时只做了两处改动：
//   ① `timeout` 改名 `timeoutMs`（本仓库的毫秒字段一律带 Ms 后缀）；
//   ② 时钟注入（`clock`）与「总时长硬上限」是本仓库新增，上游没有——
//      前者为了让单测用假时钟跑完整条时间线而不真 sleep，后者见下面的「两个超时」。
// 其余控制流（clear / arm / next 的 race、pause 的语义、dispose）与上游一致。
//
// **为什么要它**：`llmTimeoutMs`（默认 120000）是**整个调用**的平摊墙钟超时，于是
// 两种错误同时存在——一次真卡住的调用要等满 120s 才失败（实测等了 75 秒）；
// 一个正在稳定吐 token 的长回答会在第 120 秒被无辜杀掉。
// 看门狗把「超时」重新定义成**静默时长**：只计等待模型事件的时间，
// **真实内容增量**到达就把预算重置为满额；**元数据事件（usage 帧 / role 帧 / 空 delta）
// 不续期**——它们不代表模型在产出，靠它们续期等于把看门狗关掉。
//
// **两个超时都落 `LlmError.kind = "timeout"`，但 message 里区分**：
//   - 静默超时：idleTimeoutMs 内没有任何内容增量（可能仍在「慢慢来」，也可能已经死了）；
//   - 总时长超时：硬上限，无论多活跃都到点结束（防止无限续期的病态流）。

import { failure } from "./providers/types";
import type { CallOptions, LlmResponse, ProviderCapabilities } from "./types";

/** 可注入时钟：生产用真实计时器，单测用假时钟把整条时间线走完而不真 sleep。 */
export interface WatchdogClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: WatchdogClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const IDLE_TIMEOUT_LABEL = "静默超时";
export const TOTAL_TIMEOUT_LABEL = "总时长超时";

export function idleTimeoutMessage(ms: number): string {
  // 措辞里不出现 TOTAL_TIMEOUT_LABEL：两条 message 靠「各自只含自己的标签」区分，
  // 一旦在这里提一句「不是总时长超时」，按标签判型的调用点/测试就会同时匹配两条。
  return `${IDLE_TIMEOUT_LABEL}：${ms}ms 内没有收到任何内容增量（元数据帧不续期）。调用可能从未真正开始产出。`;
}

export function totalTimeoutMessage(ms: number): string {
  return `${TOTAL_TIMEOUT_LABEL}：整次调用已超过 ${ms}ms 硬上限（即使一直有增量也到此为止）。`;
}

export interface OutputWatchdog {
  /** 开始计时。重复调用无效（与上游一致）。 */
  start(): void;
  /** **真实内容增量**到达：把静默预算重置为满额。 */
  progress(): void;
  /**
   * 一个流式增量。**空串 = 元数据帧（role 帧 / 空 delta / usage 帧），不续期**——
   * 这是「元数据不续期」这条语义的唯一落点，调用点只要把每个 chunk 原样递进来即可，
   * 不需要自己判断哪种帧算数（判断散落到调用点就会各写各的）。
   * 返回是否真的续期了，便于测试与诊断。
   */
  delta(chunk: string): boolean;
  /** 工具执行 / 权限等待期间暂停计时（那段时间模型本来就不该有输出）。 */
  pause(paused: boolean): void;
  /** 把一次等待包起来：run() 与「超时/中止」赛跑。 */
  next<T>(run: () => Promise<T>): Promise<T>;
  dispose(): void;
}

/**
 * 只计「等待模型事件」的时间，不计本地持久化、工具执行、权限对话框。
 * 元数据事件不续期这条预算。
 */
export function outputWatchdog(input: {
  /** 静默预算（毫秒）。`false` / 0 = 不设静默超时。 */
  timeoutMs: number | false;
  /** 总时长硬上限（毫秒）。`false` / 0 = 不设硬上限。**不因 progress() 续期**。 */
  totalTimeoutMs?: number | false;
  signal: AbortSignal;
  /** 静默超时时构造要抛的错误。 */
  expire: () => Error;
  /** 总时长超时时构造要抛的错误。不给就复用 `expire`。 */
  expireTotal?: () => Error;
  onTimeout: (error: Error) => void;
  clock?: WatchdogClock;
}): OutputWatchdog {
  const clock = input.clock ?? REAL_CLOCK;
  let remaining = input.timeoutMs || 0;
  let started = false;
  let paused = false;
  let waiting = false;
  let stamp: number | undefined;
  let timer: unknown;
  let totalTimer: unknown;
  let failed: Error | undefined;
  let reject: ((reason: unknown) => void) | undefined;

  function clear() {
    clock.clearTimeout(timer);
    timer = undefined;
    if (stamp === undefined) return;
    remaining -= clock.now() - stamp;
    stamp = undefined;
  }

  function fire(error: Error) {
    failed = error;
    reject?.(error);
    input.onTimeout(error);
  }

  function arm() {
    if (!input.timeoutMs || !started || paused || !waiting || failed || input.signal.aborted) return;
    stamp = clock.now();
    timer = clock.setTimeout(() => {
      clear();
      fire(input.expire());
    }, Math.max(0, remaining));
  }

  function armTotal() {
    const total = input.totalTimeoutMs;
    if (!total || totalTimer !== undefined) return;
    totalTimer = clock.setTimeout(() => {
      totalTimer = undefined;
      if (failed || input.signal.aborted) return;
      clear();
      fire((input.expireTotal ?? input.expire)());
    }, Math.max(0, total));
  }

  function progress() {
    clear();
    remaining = input.timeoutMs || 0;
    arm();
  }

  return {
    start() {
      if (started) return;
      started = true;
      armTotal();
      arm();
    },
    progress,
    delta(chunk: string): boolean {
      // 空串（role 帧 / 空 delta / 纯 usage 帧在上游就被折叠成空串）不算产出。
      // 不走 `this.progress()`：解构出去单独调用时 `this` 会丢。
      if (chunk === "") return false;
      progress();
      return true;
    },
    pause(value: boolean) {
      if (paused === value) return;
      clear();
      paused = value;
      arm();
    },
    async next<T>(run: () => Promise<T>): Promise<T> {
      input.signal.throwIfAborted();
      if (failed) throw failed;
      const pending = Promise.withResolvers<never>();
      // 没有人 await 的 rejection 在 Bun 里会被算成 unhandled——这条 promise 只在
      // race 里被 await，超时先于 run() 结束时另一端已经被 race 消费，安全。
      pending.promise.catch(() => {});
      reject = pending.reject;
      const abort = () => pending.reject(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      waiting = true;
      arm();
      try {
        return await Promise.race([run(), pending.promise]);
      } finally {
        clear();
        waiting = false;
        reject = undefined;
        input.signal.removeEventListener("abort", abort);
      }
    },
    dispose() {
      clear();
      clock.clearTimeout(totalTimer);
      totalTimer = undefined;
      started = false;
    },
  };
}

/** 上游 `watchOutput` 的等价物：把一个异步迭代器每一步的等待都放进看门狗。 */
export async function* watchOutput<T>(watchdog: OutputWatchdog, iterable: AsyncIterable<T>): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await watchdog.next(() => iterator.next());
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    // 坏源可能忽略取消、next() 仍挂着。请求清理，但不让它的 return() 拖住超时收尾。
    if (!completed) void iterator.return?.().catch(() => {});
  }
}

/**
 * 从 `CallOptions` + provider 能力位解出这次调用的两个超时。
 *
 * - `idleTimeoutMs` 默认取 `llmTimeoutMs`（router 的 `defaultIdleTimeoutMs`）。
 *   **语义变了**：从「总时长」变「静默时长」。
 * - `timeoutMs` 保留为总时长硬上限，默认 `idleTimeoutMs × 3`。
 * - **`capabilities.streaming === false` 或没传 `onDelta` 时静默看门狗不生效**：
 *   非流式调用根本没有中途事件可言，唯一能计的就是总时长——对它开静默看门狗
 *   等于用一个更短的名字重新实现总超时，会把正常的慢响应杀掉。
 */
export function resolveCallTimeouts(input: {
  options: CallOptions;
  capabilities: ProviderCapabilities;
  defaultIdleTimeoutMs: number;
}): { idleTimeoutMs: number | false; totalTimeoutMs: number } {
  const idle = input.options.idleTimeoutMs ?? input.defaultIdleTimeoutMs;
  const watched = input.capabilities.streaming && input.options.onDelta !== undefined;
  const total = input.options.timeoutMs ?? Math.max(idle, 1) * 3;
  return { idleTimeoutMs: watched && idle > 0 ? idle : false, totalTimeoutMs: total };
}

/**
 * 给 `LLMRouter.call()` 用的收口壳：把一次 adapter 调用包进看门狗。
 *
 * 用法（router.ts 的收口 diff，≤10 行）：
 * ```ts
 * const guard = guardLlmCall({ provider, model, options, capabilities, defaultIdleTimeoutMs: this.timeoutMs });
 * const response = await guard.run((guarded) => entry.adapter.call({ ...req, options: guarded }));
 * ```
 * `guard.options` 是把 `onDelta` 包过一层的 CallOptions——每个**内容**增量续期，
 * 空增量不续期；超时时通过内部 AbortController 真正中止上游请求（不只是不等它）。
 */
export function guardLlmCall(input: {
  provider: string;
  model: string;
  options: CallOptions;
  capabilities: ProviderCapabilities;
  defaultIdleTimeoutMs: number;
  clock?: WatchdogClock;
}): { options: CallOptions; run(task: (options: CallOptions) => Promise<LlmResponse>): Promise<LlmResponse> } {
  const { idleTimeoutMs, totalTimeoutMs } = resolveCallTimeouts({
    options: input.options,
    capabilities: input.capabilities,
    defaultIdleTimeoutMs: input.defaultIdleTimeoutMs,
  });
  const controller = new AbortController();
  const upstream = input.options.signal;
  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });
  }
  let timedOutMessage: string | undefined;
  const watchdog = outputWatchdog({
    timeoutMs: idleTimeoutMs,
    totalTimeoutMs,
    signal: controller.signal,
    expire: () => new Error(idleTimeoutMessage(idleTimeoutMs || 0)),
    expireTotal: () => new Error(totalTimeoutMessage(totalTimeoutMs)),
    onTimeout: (error) => {
      timedOutMessage = error.message;
      controller.abort(error);
    },
    ...(input.clock ? { clock: input.clock } : {}),
  });
  const inner = input.options.onDelta;
  const guarded: CallOptions = {
    ...input.options,
    signal: controller.signal,
    ...(inner
      ? {
          onDelta: (chunk: string) => {
            watchdog.delta(chunk);
            inner(chunk);
          },
        }
      : {}),
  };
  return {
    options: guarded,
    async run(task) {
      watchdog.start();
      try {
        return await watchdog.next(() => task(guarded));
      } catch (error) {
        if (timedOutMessage) {
          return failure(input.provider, input.model, {
            kind: "timeout",
            message: timedOutMessage,
            // 静默/总时长超时都是幂等失败，可重试；流式路径由 router 自己排除重试（V137）。
            retryable: true,
          });
        }
        throw error;
      } finally {
        watchdog.dispose();
      }
    },
  };
}
