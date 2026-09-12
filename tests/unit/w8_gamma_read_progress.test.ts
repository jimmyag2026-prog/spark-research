import { describe, expect, test } from "bun:test";
import { FakeLlm, cardJson } from "../helpers/review_scenario";
import { makeServer, seedLibrary } from "../helpers/server_scenario";

// V88（BACKLOG 行 203，A6 Medium C-1 / A5 也记过 0/9）：`lit read --all` 批量精读时，
// 任务面板的 progress.done 全程停在 0，直到任务结束才一次性跳满。
//
// 根因：CLI 侧（literature/cli.ts）早就把 `generator.generateMany()` 的逐篇
// `onProgress` 回调接到了 `handle.progress()`（V35 已经做完，`α` 的地盘）；但 HTTP
// 路由 `server/routes/literature.ts` 的 `POST /api/lit/read` 只在批量开始/结束各调了
// 一次 `task.progress()`，从来没把同一个 `onProgress` 接上——这是 HTTP 面自己的漏接，
// 不是 CLI 那边的问题，改动因此全部落在本 lane 足迹内的 `server/routes/literature.ts`。
//
// 断言用的是任务落定后的 **完整事件日志**（`task.events`，只增不改，见 server/tasks.ts
// 的「事件是只增日志」纪律），不是轮询过程中的瞬时状态——这样不依赖真实定时器/轮询
// 时序，测的是「回传了多少次」这个确定性事实。
describe("V88 · 批量精读逐篇回传进度", () => {
  test("POST /api/lit/read all:true（3 篇）→ 事件日志里能看到 1/3 与 2/3 两个中间态", async () => {
    const fx = makeServer({ llm: new FakeLlm([cardJson()]) });
    try {
      seedLibrary(fx.project, 3);
      const { task } = await fx.run("/api/lit/read", { all: true });
      expect(task.state).toBe("succeeded");

      const progressDones = task.events
        .filter((e) => e.type === "progress")
        .map((e) => (e.data as { done?: number; total?: number } | null) ?? null)
        .filter((d): d is { done: number; total?: number } => d !== null && typeof d.done === "number")
        .map((d) => d.done);

      // 老行为（修复前）只有两个刻度：起（0）与讫（3）。修复后每篇完成都应该多一条，
      // 至少要出现 1 与 2 这两个中间态——对应任务书里「1/3 与 2/3 两个中间态」的要求。
      expect(progressDones).toContain(1);
      expect(progressDones).toContain(2);
      expect(progressDones).toContain(3);
    } finally {
      await fx.stop();
    }
  });

  test("单篇精读（paperId，非 all）不受影响：仍然只有一步", async () => {
    const fx = makeServer({ llm: new FakeLlm([cardJson()]) });
    try {
      const { ids } = seedLibrary(fx.project, 1);
      const { task } = await fx.run("/api/lit/read", { paperId: ids[0]! });
      expect(task.state).toBe("succeeded");
      const result = task.result as { cards: unknown[] };
      expect(result.cards).toHaveLength(1);
    } finally {
      await fx.stop();
    }
  });
});
