import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";
import { LLMRouter, type ChatMessage } from "../../backend/src/llm/router";
import { llmExtras, type LlmResponse } from "../../backend/src/llm/types";
import { ProjectManager } from "../../backend/src/project/manager";

// V82（v0.7 W7-D2）：execution_records 从 v0.1 起没有生产写入方——orchestrator 的 code task 是 kernel
// 执行的唯一生产路径，现在每次执行落一行。阴性对照：把 recordExecution() 调用注释掉 → 本测试红。

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 规划轮回一个只含 code task 的 JSON 计划；其余轮回普通文本。
const planningLlm = {
  call: async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const content = lastUser.includes("JSON array of tasks")
      ? JSON.stringify([{ id: "t1", kind: "code", description: "run", params: { code: "print(40 + 2)" } }])
      : `[test:${model}] ok`;
    return { ok: true, provider: "kimi", model, content, ...llmExtras() };
  },
  listModels: () => ({ kimi: [LLMRouter.DEFAULT_MODEL], openai: [], anthropic: [], deepseek: [], qwen: [], openrouter: [] }),
};

describe("V82 · code task 落 execution_records", () => {
  test("processRequest 跑一个 code task → 本会话 frame 下有一条 execution_record，source/status 对得上", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-v82-"));
    dirs.push(root);
    const manager = new ProjectManager(root);
    manager.create("v82");
    manager.bindSession("sess-v82", "v82");
    const daemon = new SparkResearchDaemon({ projects: manager });
    const orch = new OrchestratorAgent(daemon, { llm: planningLlm, projects: manager, workspaceRoot: join(root, "ws") });
    try {
      const result = await orch.processRequest("跑一段代码", "sess-v82");
      expect(result.projectSlug).toBe("v82");
      const project = manager.open("v82");
      const execs = project.artifacts().listExecutionsByFrame("sess-v82");
      expect(execs.length).toBe(1);
      expect(execs[0]!.source).toBe("print(40 + 2)");
      expect(execs[0]!.cellIndex).toBe(0);
      expect(["ok", "error", "timeout"]).toContain(execs[0]!.status);
      // 再跑一次 → cell_index 递增
      await orch.processRequest("再跑", "sess-v82");
      expect(project.artifacts().listExecutionsByFrame("sess-v82").map((e) => e.cellIndex)).toEqual([0, 1]);
      project.close();
    } finally {
      daemon.kernelManager.dispose();
    }
  });
});
