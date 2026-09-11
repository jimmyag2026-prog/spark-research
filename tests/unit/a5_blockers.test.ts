import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_IDLE_TIMEOUT_S } from "../../backend/src/server/server";
import { FakeLlm, cardJson } from "../helpers/review_scenario";
import { makeServer, seedLibrary } from "../helpers/server_scenario";

// A5 浏览器验收的两个 blocker 回归：
// ① Bun.serve 默认 10s 请求超时——UI 的同步 LLM 路由（co-explore 等）一超时前端永久
//    挂起而后端其实算完了。钉住 idleTimeout 配置不许退回默认。
// ② G-3 用量台账只接了 CLI——HTTP/UI 的 LLM 调用不入账，用量面板对真实花费报 $0。
//    钉住：HTTP 路由的 LLM 调用与 CLI 写同一份 usage.jsonl。

describe("A5 blocker 回归", () => {
  test("① server idleTimeout 显式配置且 ≥ 120 秒（默认 10 秒会掐死同步 LLM 路由）", () => {
    expect(SERVER_IDLE_TIMEOUT_S).toBeGreaterThanOrEqual(120);
    expect(SERVER_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255); // Bun 上限
  });

  test("② HTTP /api/lit/read 的 LLM 调用落进项目 usage.jsonl（与 CLI 同一份台账）", async () => {
    const fx = makeServer({ llm: new FakeLlm([cardJson(), cardJson(), cardJson()]) });
    try {
      const { ids } = seedLibrary(fx.project, 1);
      const { status } = await fx.run("/api/lit/read", { paperId: ids[0]! });
      expect(status).toBe(200);
      const usagePath = join(fx.project.paths.root, "usage.jsonl");
      expect(existsSync(usagePath)).toBe(true);
      const entries = readFileSync(usagePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(entries.some((e) => e.command === "lit-read")).toBe(true);
    } finally {
      await fx.stop();
    }
  });
});
