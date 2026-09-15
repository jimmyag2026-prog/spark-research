import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUN_SERVE_IDLE_TIMEOUT_CEILING_MS,
  CHAT_SYNC_MAX_MS_DEFAULT,
  chatAcceptedBody,
  chatSyncMaxMs,
  runChatWithSyncDeadline,
} from "../../backend/src/server/chat_sync";
import { TaskRegistry } from "../../backend/src/server/tasks";

// δ-4（V156 ①②）门禁。
//
// 用**真的 TaskRegistry**（不是假件）跑：要钉的正是「超时那一路，任务真的还在注册表里
// 继续跑，句柄查得到最终结果」——假一个 registry 就把这条最关键的性质假掉了。
// 假的只有 LLM（一个可控延时的 promise）与 deadline 的计时。

function fakeChat(delayMs: number, value: unknown = { summary: "答案" }) {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

describe("δ-4 V156 · chatSyncMaxMs", () => {
  test("默认 200s，且低于 Bun.serve 的 255s 上限（留余量，否则兜底本身会被掐）", () => {
    expect(CHAT_SYNC_MAX_MS_DEFAULT).toBe(200_000);
    expect(CHAT_SYNC_MAX_MS_DEFAULT).toBeLessThan(BUN_SERVE_IDLE_TIMEOUT_CEILING_MS);
    expect(chatSyncMaxMs({ root: mkdtempSync(join(tmpdir(), "w10-delta-cs-")) })).toBe(200_000);
  });

  test("接线：config.json 里的 chatSyncMaxMs 真的被读到（不是只注册了没人读）", () => {
    const root = mkdtempSync(join(tmpdir(), "w10-delta-cs2-"));
    writeFileSync(join(root, "config.json"), JSON.stringify({ chatSyncMaxMs: 1234 }));
    expect(chatSyncMaxMs({ root })).toBe(1234);
  });
});

describe("δ-4 V156 · 同步 chat 超阈值改 202", () => {
  test("快于阈值 → result（调用方一个字都不用改）", async () => {
    const tasks = new TaskRegistry();
    const outcome = await runChatWithSyncDeadline({ tasks, run: fakeChat(5), maxMs: 500 });
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") expect(outcome.result).toEqual({ summary: "答案" });
  });

  test("慢于阈值 → accepted + taskId，且任务在后台继续跑到有结果", async () => {
    const tasks = new TaskRegistry();
    const outcome = await runChatWithSyncDeadline({ tasks, run: fakeChat(200, { summary: "迟到的答案" }), maxMs: 30 });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.task.id).toBeTruthy();
    expect(outcome.task.kind).toBe("session.chat");

    // V156 的全部意义就在这一句：结果**没有蒸发**，句柄接得回来。
    const settled = await tasks.settle(outcome.task.id);
    expect(settled?.state).toBe("succeeded");
    expect(settled?.result).toEqual({ summary: "迟到的答案" });
  });

  test("任务体抛错 → 原始异常抛给调用方（路由层的 422 映射不能被降级成 500）", async () => {
    const tasks = new TaskRegistry();
    class Boom extends Error {}
    let caught: unknown;
    try {
      await runChatWithSyncDeadline({
        tasks,
        run: () => Promise.reject(new Boom("模型两次都产不出合契约的卡")),
        maxMs: 500,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Boom);
  });

  test("202 的 body 带 taskId 与该敲什么的下一步，并指向 /stream", () => {
    const tasks = new TaskRegistry();
    const snapshot = tasks.start({ kind: "session.chat", run: async () => null });
    const body = chatAcceptedBody({ sessionId: "s1", mode: "chat", task: snapshot, maxMs: 200_000 });
    expect(body.taskId).toBe(snapshot.id);
    expect(String(body.hint)).toContain(`/api/tasks/${snapshot.id}`);
    expect(String(body.hint)).toContain("/api/session/stream");
    expect(String(body.hint)).toContain("200s");
  });
});

describe("δ-4 V156 ② · 文档一律推 /stream", () => {
  test("readme_for_human.md 提到 /api/session/chat 的地方要同时指出长任务走 /stream", async () => {
    const text = await Bun.file("readme_for_human.md").text();
    expect(text).toContain("/api/session/stream");
    // 同步路由不能在文档里被说成「等着就行」——它有 200s 的上限。
    expect(text).toContain("chatSyncMaxMs");
  });
});
