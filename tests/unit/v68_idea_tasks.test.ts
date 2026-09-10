import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIdeaCommand } from "../../backend/src/ideation/cli";
import { ProjectManager } from "../../backend/src/project/manager";
import { TaskRegistry } from "../../backend/src/server/tasks";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { llmExtras } from "../../backend/src/llm/types";

// V68（R1-T1 发现）：idea new/check 此前没有任务句柄——进程被杀 100% 丢工作零痕迹，
// 与 lit read/review（V35 已接）能力不对等。这里验证两件事：
// ① 非交互 idea new 走 runCliTask：registry 里有 kind=idea-new 的快照且成功终态
// ② 任务失败时原始错误原因透出（不许被任务包装吞成一句「异常终止」——V36）

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-v68-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ideaCardLlm(): { call: (m: ChatMessage[]) => Promise<LlmResponse> } {
  return {
    call: async (): Promise<LlmResponse> => ({
      ok: true,
      ...llmExtras(),
      provider: "openrouter",
      model: LLMRouter.DEFAULT_MODEL,
      content: JSON.stringify({
        critique: "批判性反馈（inferred）",
        hypothesis: "假设 H",
        supporting: [{ key: null, note: "支持理由（inferred）", inferred: true }],
        // 强制反证机制（R1 正面验证过）：contradicting 至少 1 条
        contradicting: [{ key: null, note: "反例路径（inferred）", inferred: true }],
        openQuestions: ["Q1"],
      }),
    }),
  };
}

describe("V68 · idea 命令的任务句柄", () => {
  test("idea new -m 走任务：registry 有 kind=idea-new 的成功快照，输出带任务行", async () => {
    const manager = new ProjectManager(tmp);
    manager.create("v68", { name: "v68" }).close();
    const registry = new TaskRegistry();
    const out: string[] = [];
    const code = await runIdeaCommand(["new", "-m", "试试这个思路"], {
      manager,
      root: tmp,
      llm: ideaCardLlm(),
      taskRegistry: registry,
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const tasks = registry.list();
    expect(tasks.some((t) => t.kind === "idea-new" && t.state === "succeeded")).toBe(true);
    expect(out.join("\n")).toContain("任务");
  });

  test("任务失败时原始错误原因透出（不被吞成笼统的异常终止）", async () => {
    const manager = new ProjectManager(tmp);
    manager.create("v68b", { name: "v68b" }).close();
    const registry = new TaskRegistry();
    const errs: string[] = [];
    const code = await runIdeaCommand(["new", "-m", "x"], {
      manager,
      root: tmp,
      llm: {
        call: async () => {
          throw new Error("特征性错误标记-XYZ");
        },
      },
      taskRegistry: registry,
      out: () => {},
      err: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("特征性错误标记-XYZ");
    expect(registry.list().some((t) => t.kind === "idea-new" && t.state === "failed")).toBe(true);
  });
});
