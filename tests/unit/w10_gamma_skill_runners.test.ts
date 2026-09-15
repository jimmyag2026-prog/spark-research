import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { SKILL_RUNNERS, runSkill } from "../../backend/src/agents/skill_runners";
import { LibraryStore } from "../../backend/src/literature/library";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

// v0.10 lane γ-4（V172 后半）门禁：按盘点表再接 3 个技能。
//
// 钉的是「注册表真的分发」与「没接的技能行为不变」，不是各管线自己的正确性
// （PdfDownloader / buildReport / NoveltyChecker 各有自己的既有套件）。

class NoopLlm {
  readonly calls: string[] = [];
  async call(messages: ChatMessage[]): Promise<LlmResponse> {
    this.calls.push(messages.map((m) => m.content).join("\n"));
    return { ok: true, content: "{}", provider: "kimi", model: "t", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as LlmResponse;
  }
}

let root: string;
let pm: ProjectManager;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "w10g4-")); pm = new ProjectManager(root); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const ctxFor = (slug: string) => {
  const project = pm.create(slug, { name: slug, description: "γ-4 门禁" });
  return { project, ctx: { llm: new NoopLlm(), project, sessionId: `s-${slug}` } };
};

describe("γ-4 ① 注册表与盘点表对得上", () => {
  test("本轮接的就是这 3 个，一个不多一个不少", () => {
    expect(Object.keys(SKILL_RUNNERS).sort()).toEqual(["novelty-check", "paper-download", "research-report"]);
  });

  test("表里没有的技能 → handled=false（没接的 10 个行为逐字节不变）", async () => {
    const { project, ctx } = ctxFor("g4-unknown");
    for (const name of ["wet-protocol", "scanpy", "dry-experiment", "idea-coexplore", "literature-review"]) {
      const r = await runSkill(name, ctx);
      expect(r.handled).toBe(false);
      expect(r.digest).toBeUndefined();
    }
    project.close();
  });

  test("runner 抛异常 → handled=true + ok=false + 看得见的原因（不是静默 ok）", async () => {
    const { project, ctx } = ctxFor("g4-throw");
    const original = SKILL_RUNNERS["paper-download"]!;
    SKILL_RUNNERS["paper-download"] = async () => { throw new Error("boom from upstream"); };
    try {
      const r = await runSkill("paper-download", ctx);
      expect(r.handled).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.digest).toContain("boom from upstream");
    } finally {
      SKILL_RUNNERS["paper-download"] = original;
      project.close();
    }
  });
});

describe("γ-4 ② paper-download", () => {
  test("空文献库 → 不去网络，给一句可执行的下一步", async () => {
    const { project, ctx } = ctxFor("g4-dl-empty");
    const r = await runSkill("paper-download", ctx);
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.digest).toContain("先跑 literature-search");
    project.close();
  });

  test("库里每篇都已有 PDF → 明说没有要下的（不是报错，也不是空跑）", async () => {
    const { project, ctx } = ctxFor("g4-dl-done");
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    const added = library.add({
      title: "Already downloaded", authors: [{ name: "A" }], year: 2020, venue: null,
      doi: "10.1/dl", ids: { doi: "10.1/dl" }, abstract: "x", url: null, pdfUrl: null,
      citedByCount: 1, isOpenAccess: true, sources: ["openalex"], references: [],
    } as never);
    library.update(added.paper.id, { pdfPath: "/tmp/fake.pdf", checksum: "deadbeef" });
    library.close();
    const r = await runSkill("paper-download", ctx);
    expect(r.digest).toContain("没有要下的");
    project.close();
  });
});

describe("γ-4 ③ research-report", () => {
  test("零 LLM 调用；报告落 artifact 并回一个可回链的 id", async () => {
    const { project, ctx } = ctxFor("g4-report");
    const r = await runSkill("research-report", ctx);
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(true);
    expect((ctx.llm as NoopLlm).calls).toHaveLength(0); // buildReport 是纯函数
    expect(r.artifacts?.[0]?.id).toBeTruthy();
    expect(existsSync(join(project.paths.artifactsDir, `research-report-${ctx.sessionId}.md`))).toBe(true);
    // U44：进对话历史的是摘要，不是整篇正文。
    expect(r.digest!.length).toBeLessThanOrEqual(1500);
    project.close();
  });
});

describe("γ-4 ④ novelty-check", () => {
  test("思路库为空 → 拒绝执行并说清为什么（「检索不到 ≠ 新颖」，不许编一张卡去查）", async () => {
    const { project, ctx } = ctxFor("g4-novelty");
    const r = await runSkill("novelty-check", ctx);
    expect(r.handled).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.digest).toContain("idea-coexplore");
    expect(r.digest).toContain("检索不到 ≠ 新颖");
    // 没有卡就一次模型调用都不该发生（更别说发检索请求）。
    expect((ctx.llm as NoopLlm).calls).toHaveLength(0);
    project.close();
  });

  test("指定了不存在的 ideaId → 点名那个 id，不退回「拿第一张卡」", async () => {
    const { project, ctx } = ctxFor("g4-novelty-id");
    const r = await runSkill("novelty-check", ctx, { ideaId: "nosuchrecord" });
    expect(r.ok).toBe(false);
    expect(r.digest).toContain("nosuchrecord");
    project.close();
  });
});
