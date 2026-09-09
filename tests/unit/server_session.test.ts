import { describe, expect, test } from "bun:test";
import { FakeLlm } from "../helpers/review_scenario";
import { ScriptedLlm } from "../helpers/ideation_scenario";
import { makeServer, seedLibrary } from "../helpers/server_scenario";

// P7 · 会话端点（chat / coexplore）、SSE 流与任务句柄。

// 读一段 SSE 直到 `done`，把事件按名字收集起来。
async function readSse(
  url: string,
  init: RequestInit,
  limitMs = 10_000,
): Promise<{ status: number; events: Array<{ event: string; data: unknown }> }> {
  const res = await fetch(url, init);
  const events: Array<{ event: string; data: unknown }> = [];
  if (!res.body) return { status: res.status, events };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + limitMs;
  let buffer = "";
  for (;;) {
    if (Date.now() > deadline) break;
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      // 注释行（心跳）不是事件。
      if (chunk.startsWith(":")) continue;
      const nameLine = chunk.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!nameLine) continue;
      events.push({
        event: nameLine.slice(7),
        data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
      });
    }
    if (events.some((e) => e.event === "done")) break;
  }
  await reader.cancel().catch(() => {});
  return { status: res.status, events };
}

const chatLlm = () =>
  new FakeLlm([JSON.stringify({ tasks: [{ kind: "analysis", description: "直接回答" }] }), "这是回答。"]);

describe("HTTP · session chat", () => {
  test("GET /api/session/modes 列出会话模式", async () => {
    const fx = makeServer({ llm: chatLlm() });
    try {
      const { body } = await fx.get<{ modes: string[]; default: string }>("/api/session/modes");
      expect(body.modes).toEqual(["chat", "coexplore"]);
      expect(body.default).toBe("chat");
    } finally {
      await fx.stop();
    }
  });

  test("POST /api/session/chat 返回正文并带上 session 归属的项目（AD-1）", async () => {
    const fx = makeServer({ llm: chatLlm(), slug: "chatproj" });
    try {
      const { status, body } = await fx.post<{ response: string; projectSlug: string; mode: string }>(
        "/api/session/chat",
        { sessionId: "s-http", message: "你好" },
      );
      expect(status).toBe(200);
      expect(body.response).toContain("s-http");
      expect(body.mode).toBe("chat");
      expect(body.projectSlug).toBe("chatproj");
    } finally {
      await fx.stop();
    }
  });

  test("缺 sessionId / message → 400；未知 mode → 400", async () => {
    const fx = makeServer({ llm: chatLlm() });
    try {
      expect((await fx.post("/api/session/chat", { message: "x" })).status).toBe(400);
      expect((await fx.post("/api/session/chat", { sessionId: "s" })).status).toBe(400);
      expect(
        (await fx.post("/api/session/chat", { sessionId: "s", message: "x", mode: "nope" })).status,
      ).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  test("mode=coexplore 走思路共探并回 ideaRecordId", async () => {
    let keys: string[] = [];
    const llm = new ScriptedLlm([
      (user) =>
        user.includes("可用引用 key 白名单")
          ? JSON.stringify({
              critique: `这条思路的前提值得推敲[@${keys[0]}]（inferred）。`,
              hypothesis: "自注意力可替代循环结构",
              supporting: [{ key: keys[0], note: "同一范式下的代表性结果" }],
              contradicting: [{ key: keys[1], note: "该工作提示结论对评测口径敏感" }],
              openQuestions: ["长序列上是否成立"],
            })
          : null,
    ]);
    const fx = makeServer({ llm });
    try {
      seedLibrary(fx.project, 2);
      keys = (await fx.get<{ papers: Array<{ bibtexKey: string }> }>("/api/lit/papers")).body.papers.map(
        (p) => p.bibtexKey,
      );
      const { status, body } = await fx.post<{ response: string; ideaRecordId: string | null; mode: string }>(
        "/api/session/chat",
        { sessionId: "s-coex", message: "我想用自注意力替代循环结构", mode: "coexplore" },
      );
      expect(status).toBe(200);
      expect(body.mode).toBe("coexplore");
      expect(body.response).toContain("coexplore");
      expect(body.ideaRecordId).toBeTruthy();
      const ideas = await fx.get<{ ideas: unknown[] }>("/api/ideas");
      expect(ideas.body.ideas).toHaveLength(1);
    } finally {
      await fx.stop();
    }
  });

  test("模型产不出合契约的 Idea 卡 → 422（服务端没坏，是这次生成不可用）", async () => {
    const llm = new ScriptedLlm([
      (user) => (user.includes("可用引用 key 白名单") ? JSON.stringify({ critique: "只有一句话" }) : null),
    ]);
    const fx = makeServer({ llm });
    try {
      seedLibrary(fx.project, 2);
      const res = await fx.post<{ error: string }>("/api/session/chat", {
        sessionId: "s-bad",
        message: "随便说说",
        mode: "coexplore",
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("CoExplore");
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/session/:id 给出该会话产出的 record / artifact；未绑定会话回空", async () => {
    const fx = makeServer({ llm: chatLlm() });
    try {
      await fx.post("/api/session/chat", { sessionId: "s-bound", message: "你好" });
      const bound = await fx.get<{ projectSlug: string | null }>("/api/session/s-bound");
      expect(bound.body.projectSlug).toBe(fx.project.slug);
      const unbound = await fx.get<{ projectSlug: string | null; records: unknown[] }>(
        "/api/session/never-seen",
      );
      expect(unbound.body.projectSlug).toBeNull();
      expect(unbound.body.records).toEqual([]);
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · SSE", () => {
  test("POST /api/session/stream 依次发 start → progress → result → done", async () => {
    const fx = makeServer({ llm: chatLlm() });
    try {
      const { status, events } = await readSse(`${fx.base}/api/session/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s-sse", message: "你好" }),
      });
      expect(status).toBe(200);
      expect(events.map((e) => e.event)).toEqual(["start", "progress", "result", "done"]);
      const result = events.find((e) => e.event === "result")!.data as { response: string };
      expect(result.response).toContain("s-sse");
    } finally {
      await fx.stop();
    }
  });

  test("流里的异常走 error 事件而不是把连接掐掉", async () => {
    // 缺 message 在进入流之前就被挡住 → 400 JSON（不是一条空流）。
    const fx = makeServer({ llm: chatLlm() });
    try {
      const res = await fetch(`${fx.base}/api/session/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s" }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
    } finally {
      await fx.stop();
    }
  });

  test("任务 SSE：晚订阅也能补齐历史事件并收到 done", async () => {
    const fx = makeServer({ llm: chatLlm() });
    try {
      const designed = await fx.post<{ experiment: { id: string } }>("/api/experiments", {
        title: "SSE 实验",
        params: { steps: 200, sampleInterval: 20 },
      });
      const submitted = await fx.post<{ task: { id: string } }>(
        `/api/experiments/${designed.body.experiment.id}/run`,
        { pollIntervalMs: 50 },
      );
      const taskId = submitted.body.task.id;
      const { status, events } = await readSse(`${fx.base}/api/tasks/${taskId}/stream`, { method: "GET" });
      expect(status).toBe(200);
      // 第一条一定是 running（历史补齐），最后一条是 done。
      expect(events[0]!.event).toBe("state");
      expect(events[events.length - 1]!.event).toBe("done");
      expect((events[events.length - 1]!.data as { state: string }).state).toBe("succeeded");
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · tasks", () => {
  test("GET /api/tasks 列出任务；:id 不存在 → 404", async () => {
    const fx = makeServer({ llm: chatLlm() });
    try {
      const designed = await fx.post<{ experiment: { id: string } }>("/api/experiments", {
        title: "任务列表",
        params: { steps: 200, sampleInterval: 20 },
      });
      await fx.run(`/api/experiments/${designed.body.experiment.id}/run`, { pollIntervalMs: 50 });
      const list = await fx.get<{ tasks: Array<{ kind: string; state: string; project: string | null }> }>(
        "/api/tasks",
      );
      expect(list.body.tasks).toHaveLength(1);
      expect(list.body.tasks[0]!.kind).toBe("exp.run");
      expect(list.body.tasks[0]!.state).toBe("succeeded");
      expect((await fx.get("/api/tasks/missing")).status).toBe(404);
      expect((await fx.get("/api/tasks/missing/stream")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });

  test("任务快照带进度事件序列，失败任务留下 error", async () => {
    const fx = makeServer({ llm: new FakeLlm(["不是 JSON"]) });
    try {
      seedLibrary(fx.project, 1);
      const { task } = await fx.run("/api/lit/read", { all: true });
      expect(task.state).toBe("failed");
      expect(task.error?.message).toBeTruthy();
      expect(task.finishedAt).toBeTruthy();
      expect(task.events.some((e) => e.type === "error")).toBe(true);
      // 事件序号是连续的只增日志。
      expect(task.events.map((e) => e.seq)).toEqual(task.events.map((_, i) => i));
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · 通用约定", () => {
  test("未知 /api/* 路径回 JSON 404（不掉进 SPA 兜底）", async () => {
    const fx = makeServer({ llm: chatLlm() });
    try {
      const res = await fetch(`${fx.base}/api/nope`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    } finally {
      await fx.stop();
    }
  });

  test("非法 JSON 请求体 → 400 而不是 500", async () => {
    const fx = makeServer({ llm: chatLlm() });
    try {
      const res = await fetch(`${fx.base}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ 这不是 json",
      });
      expect(res.status).toBe(400);
    } finally {
      await fx.stop();
    }
  });
});
