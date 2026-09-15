import { describe, expect, test } from "bun:test";
import {
  guardLlmCall,
  IDLE_TIMEOUT_LABEL,
  outputWatchdog,
  resolveCallTimeouts,
  TOTAL_TIMEOUT_LABEL,
  type WatchdogClock,
} from "../../backend/src/llm/watchdog";
import type { CallOptions, ProviderCapabilities } from "../../backend/src/llm/types";
import { llmText } from "../../backend/src/llm/types";

// lane α-1（USAGE_LOG U4）：输出看门狗。
// **全部用假时钟**——真 sleep 会让这五条用例慢到没人愿意跑，而且「1800ms 的流不超时」
// 这种断言用真时间跑本身就是不稳定源。

function fakeClock(): WatchdogClock & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

function makeWatchdog(clock: WatchdogClock, opts: { idle: number | false; total?: number | false }) {
  const controller = new AbortController();
  const fired: string[] = [];
  const watchdog = outputWatchdog({
    timeoutMs: opts.idle,
    totalTimeoutMs: opts.total ?? false,
    signal: controller.signal,
    expire: () => new Error(`${IDLE_TIMEOUT_LABEL}`),
    expireTotal: () => new Error(`${TOTAL_TIMEOUT_LABEL}`),
    onTimeout: (error) => fired.push(error.message),
    clock,
  });
  return { watchdog, fired, controller };
}

/** 一个永远不自己结束的等待——只有看门狗能终结它。 */
function never(): Promise<never> {
  return new Promise<never>(() => {});
}

describe("α-1 · 输出看门狗：超时只计模型等待时间", () => {
  test("① 静默超过 idle → 超时", async () => {
    const clock = fakeClock();
    const { watchdog, fired } = makeWatchdog(clock, { idle: 1_000 });
    watchdog.start();
    const pending = watchdog.next(() => never());
    clock.advance(999);
    expect(fired).toEqual([]);
    clock.advance(2);
    await expect(pending).rejects.toThrow(IDLE_TIMEOUT_LABEL);
    expect(fired).toEqual([IDLE_TIMEOUT_LABEL]);
  });

  test("② 持续增量：总时长远超 idle，但每次间隔 < idle → 不超时", async () => {
    const clock = fakeClock();
    const { watchdog, fired } = makeWatchdog(clock, { idle: 1_000 });
    watchdog.start();
    let resolve: (v: string) => void = () => {};
    const pending = watchdog.next(() => new Promise<string>((r) => (resolve = r)));
    for (let i = 0; i < 5; i++) {
      clock.advance(600);
      expect(watchdog.delta(`chunk-${i}`)).toBe(true);
    }
    // 累计静默墙钟 3000ms ≫ idle 1000ms，但每段都只有 600ms。
    expect(fired).toEqual([]);
    resolve("done");
    await expect(pending).resolves.toBe("done");
  });

  test("③ 元数据帧（空 delta）不续期", async () => {
    const clock = fakeClock();
    const { watchdog, fired } = makeWatchdog(clock, { idle: 1_000 });
    watchdog.start();
    const pending = watchdog.next(() => never());
    clock.advance(400);
    expect(watchdog.delta("")).toBe(false); // usage 帧 / role 帧 / 空 delta
    clock.advance(400);
    expect(watchdog.delta("")).toBe(false);
    expect(fired).toEqual([]);
    clock.advance(201); // 累计静默 1001ms —— 两个元数据帧一次都没续上
    await expect(pending).rejects.toThrow(IDLE_TIMEOUT_LABEL);
    expect(fired).toEqual([IDLE_TIMEOUT_LABEL]);
  });

  test("④ pause 期间不计时（工具执行 / 权限等待）", async () => {
    const clock = fakeClock();
    const { watchdog, fired } = makeWatchdog(clock, { idle: 1_000 });
    watchdog.start();
    const pending = watchdog.next(() => never());
    clock.advance(500);
    watchdog.pause(true);
    clock.advance(60_000); // 一分钟的工具执行
    watchdog.pause(false);
    clock.advance(400); // 静默累计 900ms
    expect(fired).toEqual([]);
    clock.advance(200); // 越过 1000ms
    await expect(pending).rejects.toThrow(IDLE_TIMEOUT_LABEL);
  });

  test("⑤ 总时长硬上限仍生效：一直有增量也到点结束", async () => {
    const clock = fakeClock();
    const { watchdog, fired } = makeWatchdog(clock, { idle: 1_000, total: 2_500 });
    watchdog.start();
    const pending = watchdog.next(() => never());
    for (let i = 0; i < 3; i++) {
      clock.advance(600);
      watchdog.delta(`chunk-${i}`); // 静默预算永远续得上
    }
    expect(fired).toEqual([]);
    clock.advance(1_000); // 墙钟到 2800 > 2500
    await expect(pending).rejects.toThrow(TOTAL_TIMEOUT_LABEL);
    expect(fired).toEqual([TOTAL_TIMEOUT_LABEL]);
  });

  test("dispose 之后不再留下计时器", () => {
    const clock = fakeClock();
    const { watchdog } = makeWatchdog(clock, { idle: 1_000, total: 5_000 });
    watchdog.start();
    expect(clock.pending()).toBeGreaterThan(0);
    watchdog.dispose();
    expect(clock.pending()).toBe(0);
  });
});

const STREAMING: ProviderCapabilities = { toolCalling: true, jsonMode: true, streaming: true, usageReported: true };
const NON_STREAMING: ProviderCapabilities = { ...STREAMING, streaming: false };

describe("α-1 · resolveCallTimeouts：idleTimeoutMs 与总时长的分工", () => {
  test("默认：idle = llmTimeoutMs，总时长 = idle × 3", () => {
    const r = resolveCallTimeouts({
      options: { onDelta: () => {} },
      capabilities: STREAMING,
      defaultIdleTimeoutMs: 120_000,
    });
    expect(r.idleTimeoutMs).toBe(120_000);
    expect(r.totalTimeoutMs).toBe(360_000);
  });

  test("显式 timeoutMs 仍是总时长硬上限，不被 idle 覆盖", () => {
    const r = resolveCallTimeouts({
      options: { onDelta: () => {}, idleTimeoutMs: 5_000, timeoutMs: 9_000 },
      capabilities: STREAMING,
      defaultIdleTimeoutMs: 120_000,
    });
    expect(r).toEqual({ idleTimeoutMs: 5_000, totalTimeoutMs: 9_000 });
  });

  test("provider 不支持流式 / 没传 onDelta → 静默看门狗不生效，只剩总时长", () => {
    expect(
      resolveCallTimeouts({ options: { onDelta: () => {} }, capabilities: NON_STREAMING, defaultIdleTimeoutMs: 1_000 })
        .idleTimeoutMs,
    ).toBe(false);
    expect(
      resolveCallTimeouts({ options: {}, capabilities: STREAMING, defaultIdleTimeoutMs: 1_000 }).idleTimeoutMs,
    ).toBe(false);
  });
});

describe("α-1 · guardLlmCall：超时落 LlmError.kind=timeout，message 区分两种超时", () => {
  test("静默超时 → ok:false / kind timeout / message 说是静默超时", async () => {
    const clock = fakeClock();
    const guard = guardLlmCall({
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      options: { onDelta: () => {}, idleTimeoutMs: 1_000 },
      capabilities: STREAMING,
      defaultIdleTimeoutMs: 120_000,
      clock,
    });
    const pending = guard.run(() => never());
    clock.advance(1_001);
    const res = await pending;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.kind).toBe("timeout");
    expect(res.error.message).toContain(IDLE_TIMEOUT_LABEL);
    expect(res.error.message).not.toContain(TOTAL_TIMEOUT_LABEL);
    expect(res.error.retryable).toBe(true);
    expect(res.content).toBe(""); // AD-13 不变式
  });

  test("总时长超时 → message 说是总时长超时", async () => {
    const clock = fakeClock();
    const guard = guardLlmCall({
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      options: { onDelta: () => {}, idleTimeoutMs: 1_000, timeoutMs: 2_500 },
      capabilities: STREAMING,
      defaultIdleTimeoutMs: 120_000,
      clock,
    });
    const pending = guard.run((guarded) => {
      for (let i = 0; i < 3; i++) {
        clock.advance(600);
        guarded.onDelta!(`chunk-${i}`);
      }
      clock.advance(1_000);
      return never();
    });
    const res = await pending;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.message).toContain(TOTAL_TIMEOUT_LABEL);
  });

  test("正常返回原样透出，且 onDelta 仍然回调给原调用方", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const options: CallOptions = { onDelta: (c) => seen.push(c), idleTimeoutMs: 1_000 };
    const guard = guardLlmCall({
      provider: "openrouter",
      model: "m",
      options,
      capabilities: STREAMING,
      defaultIdleTimeoutMs: 120_000,
      clock,
    });
    const res = await guard.run(async (guarded) => {
      guarded.onDelta!("hello ");
      guarded.onDelta!("world");
      return llmText({ provider: "openrouter", model: "m", content: "hello world" });
    });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["hello ", "world"]);
  });
});
