import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMRouter, type ChatMessage, type LlmResponse } from "../../backend/src/llm/router";
import { llmExtras } from "../../backend/src/llm/types";
import { runLitCommand } from "../../backend/src/literature/cli";
import { LibraryStore } from "../../backend/src/literature/library";
import { ReadingCardGenerator } from "../../backend/src/literature/reading";
import { ProjectManager } from "../../backend/src/project/manager";
import { CITATION_RULE } from "../../backend/src/reviewer/rules";
import { CASSETTES, PER_SOURCE, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";

// V71（v0.7 alpha.5 收口）：`lit review` 的逐条 citation finding 必须落 findings.db——此前只写计数摘要，
// `review findings` 永远看不到。阴性对照：注释掉 cli.ts 里的 reviewTarget() 调用 → 本测试红。

class BadCitingLlm {
  call = async (messages: ChatMessage[], model = LLMRouter.DEFAULT_MODEL): Promise<LlmResponse> => {
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    if (user.includes("可用引用 key 白名单")) {
      const keys = [...user.matchAll(/^- \[@([^\]]+)\]/gm)].map((m) => m[1]!);
      // 一条合法引用 + 一句没有任何引用支撑的断言（unsupported_claim → soft finding）。
      // 库外 key 走不到这一步——草稿生成器在白名单阶段就拒了（unknown_citation 不是这条链能产生的）。
      return { ok: true, provider: "kimi", model, content: `背景陈述[@${keys[0]}]。\n这是一句没有任何引用支撑的断言，模型凭空写的。`, ...llmExtras() };
    }
    const title = user.match(/标题: (.+)/)?.[1] ?? "未知标题";
    return {
      ok: true,
      ...llmExtras(),
      provider: "kimi",
      model,
      content: JSON.stringify({ researchQuestion: title, methods: "m", keyFindings: ["k"], limitations: ["l"], relationToProject: "r" }),
    };
  };
  listModels = () => ({ kimi: [], openai: [], anthropic: [], deepseek: [], qwen: [], openrouter: [] });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spark-v71-wire-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("V71 · lit review → findings.db", () => {
  test("有 soft finding 的综述：命令返回 0（不否决），finding 已登记、fingerprint 稳定可复核", async () => {
    const manager = new ProjectManager(tmp);
    const project = manager.create("v71-wire", { name: "v71" });
    const records = project.records();
    const library = new LibraryStore(project.paths.libraryDb, { records });
    const searched = await searcherWith(CASSETTES.search, "replay").search(SEARCH_QUERY, { sources: SEARCH_SOURCES, perSource: PER_SOURCE });
    for (const paper of searched.papers.slice(0, 2)) library.add(paper, { tags: ["background"] });
    const llm = new BadCitingLlm();
    const { failures } = await new ReadingCardGenerator({ llm, library, records }).generateMany(library.list().map((p) => p.id), { sessionId: "s1" });
    expect(failures).toHaveLength(0);

    const out: string[] = [];
    const err: string[] = [];
    const code = await runLitCommand(["review", "--session", "s1"], { manager, llm, out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(err).toEqual([]);
    expect(code).toBe(0); // soft 不否决
    expect(out.join("\n")).toContain("findings.db:");

    const rows = project.findings().list({ project: "v71-wire" });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.checker === CITATION_RULE)).toBe(true);
    expect(rows.some((r) => r.severity === "soft")).toBe(true);
    expect(rows.every((r) => /^[0-9a-f]{16}$/.test(r.fingerprint))).toBe(true);

    // 再跑一次：新草稿 = 新 target（各自一行），但 finding 的身份（fingerprint）稳定——复核闭环靠它对齐。
    await runLitCommand(["review", "--session", "s1"], { manager, llm, out: () => {}, err: () => {} });
    const all = project.findings().list({ project: "v71-wire" });
    const targets = new Set(all.map((r) => r.target.id));
    expect(targets.size).toBe(2);
    const fpsRun1 = new Set(rows.map((r) => r.fingerprint));
    const fpsRun2 = new Set(all.filter((r) => !rows.some((x) => x.id === r.id)).map((r) => r.fingerprint));
    expect(fpsRun2).toEqual(fpsRun1);
    library.close();
    project.close();
  });
});
