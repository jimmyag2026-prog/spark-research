// V172 后半（v0.10 lane γ-4）：chat 的 `skill` 任务对**更多技能**真执行。
//
// 背景与盘点表：`docs/taskbooks/v0.10/SKILL_EXEC_INVENTORY.md`。
// 13 个技能里 `literature-search` / `literature-review` 已在 V172 接上（走
// `runLiteraturePipeline`）；本轮按盘点表再接 3 个**乙型**（确定性管线已存在，
// 编排层只需构造入参 → 调用 → digest 回给模型）：
//   · paper-download  → `PdfDownloader`
//   · research-report → `buildReport`
//   · novelty-check   → `NoveltyChecker`
//
// **为什么是注册表而不是往 orchestrator 里加 case**：`agents/orchestrator.ts` 是
// 收口专属文件（_COMMON §足迹）。分发表放这里，收口只需在 `case "skill"` 里加一行
// 接线（见 docs/devlog/W10-gamma.md §收口 diff）。
//
// 一条硬纪律：**表里没有的技能返回 `handled: false`**，编排层照旧退回「加载说明书」。
// 没接的 10 个技能行为逐字节不变——接一个技能的代价不许是把别的技能弄坏。

import { join } from "node:path";
import { LibraryStore } from "../literature/library";
import { PdfDownloader } from "../literature/pdf";
import { LiteratureSearcher } from "../literature/search";
import { llmQueryTranslator } from "../literature/prepare_query";
import { reportFor } from "../report/cli";
import { IdeaStore } from "../ideation/store";
import { NoveltyChecker } from "../ideation/novelty";
import { ConnectorRegistry } from "../connectors/registry";
import { CredentialStore } from "../daemon/credentials";
import type { LLMRouter } from "../llm/router";
import type { Project } from "../project/manager";

export interface SkillRunnerContext {
  llm: Pick<LLMRouter, "call">;
  model?: string;
  project: Project;
  sessionId: string;
  /** 阶段进度（进执行日志 / progress 事件），与 literature_pipeline 同款。 */
  note?: (message: string) => void;
}

export interface SkillArtifactLink {
  id: string;
  label: string;
}

export interface SkillRunResult {
  /** 表里有没有这个技能。false 时编排层退回「加载说明书」。 */
  handled: boolean;
  ok?: boolean;
  /** ≤1500 字符的结构化摘要，直接进对话历史（U44：整份 JSON 进历史会烧掉十几万 token）。 */
  digest?: string;
  artifacts?: SkillArtifactLink[];
}

export type SkillRunner = (
  ctx: SkillRunnerContext,
  params: Record<string, unknown>,
) => Promise<Omit<SkillRunResult, "handled">>;

/**
 * Idea 卡没有 `title` 字段（`IdeaCard` = hypothesis / critique / supporting / ...），
 * 摘要里要给人一个能认出来的名字，就取假设的第一句。**不许编一个标题**。
 */
function ideaTitle(idea: { hypothesis: string }): string {
  const first = idea.hypothesis.split(/[。.\n]/)[0]?.trim() ?? "";
  return (first || idea.hypothesis).slice(0, 60);
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function strList(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ── paper-download（乙）──────────────────────────────────────────────────
//
// 技能说明书的核心纪律是「拿不到就说拿不到」：每个候选直链只试一次，失败记原因、
// **不做退避重试**。`PdfDownloader` 已经是这个行为，这里只负责选出要下的那几篇。
//
// 选法：给了 `paperIds` 就下这几篇；没给就下**库里还没有 PDF 的**前 N 篇
// （默认 8，与精读上限同一档——下了却不读没有意义）。
const paperDownload: SkillRunner = async (ctx, params) => {
  const library = new LibraryStore(ctx.project.paths.libraryDb, { records: ctx.project.records() });
  try {
    const explicit = strList(params, "paperIds");
    const limit = num(params, "limit") ?? 8;
    const all = library.list();
    const targets = explicit.length > 0
      ? all.filter((p) => explicit.some((id) => p.id === id || p.id.startsWith(id)))
      : all.filter((p) => !p.pdfPath).slice(0, limit);

    if (targets.length === 0) {
      return {
        ok: false,
        digest:
          all.length === 0
            ? "paper-download：项目文献库是空的。下一步：先跑 literature-search 把候选入库。"
            : "paper-download：库内每一篇都已经有本地 PDF，没有要下的。",
      };
    }

    ctx.note?.(`下载 PDF：${targets.length} 篇`);
    const downloader = new PdfDownloader({ papersDir: ctx.project.paths.papersDir, library });
    const lines: string[] = [];
    let okCount = 0;
    for (const paper of targets) {
      const r = await downloader.download(paper.id);
      if (r.ok) okCount += 1;
      // 拿不到时**把原因写出来**（403 / 无 OA / 非 PDF），不是笼统一句「失败」。
      lines.push(`  ${r.ok ? "✅" : "❌"} ${paper.title.slice(0, 70)}${r.ok ? "" : `　← ${r.reason ?? "unknown"}${r.message ? `: ${r.message.slice(0, 80)}` : ""}`}`);
    }
    return {
      ok: okCount > 0,
      digest: [`paper-download：${okCount}/${targets.length} 篇拿到 OA PDF（每个候选直链只试一次，不做退避重试）`, ...lines].join("\n").slice(0, 1500),
    };
  } finally {
    library.close();
  }
};

// ── research-report（乙）─────────────────────────────────────────────────
//
// `buildReport` 是纯函数（读 records + library，渲染 markdown），零 LLM 调用。
// 这里把它落成 artifact，让 chat 能给出一个可回链的 id 而不是把整篇正文塞进历史。
const researchReport: SkillRunner = async (ctx, params) => {
  ctx.note?.("汇总证据图 → 研究报告");
  const report = reportFor(ctx.project, { verbose: params.verbose === true });
  const artifacts = ctx.project.artifacts();
  const fileName = `research-report-${ctx.sessionId}.md`;
  const path = join(ctx.project.paths.artifactsDir, fileName);
  let artifactId: string | null = null;
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, report.markdown);
    artifactId = artifacts.save(path, "", [], { sessionId: ctx.sessionId }, ctx.project.slug).id;
  } catch (e) {
    // 落盘/入库失败**不吞**：报告内容还在，但要说清它没有 artifact 身份。
    ctx.note?.(`报告落盘失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const c = report.counts;
  const warn =
    c.approvedConclusions === 0 && c.unverifiedConclusions > 0
      ? "\n  ⚠️ 结论区是空的：所有结论卡都还没通过 review（下一步：conclusion review <id>）"
      : "";
  return {
    ok: true,
    digest:
      `research-report：${report.title}\n` +
      `  结论 ${c.approvedConclusions} 条通过 / ${c.unverifiedConclusions} 条待验证 · 引用 ${report.recordIds.length} 条 record\n` +
      `  artifact ${artifactId ?? "（未入库）"} · ${path}${warn}\n` +
      `  正文首段：${report.markdown.slice(0, 400)}`,
    ...(artifactId ? { artifacts: [{ id: artifactId, label: report.title }] } : {}),
  };
};

// ── novelty-check（乙）───────────────────────────────────────────────────
//
// 前置是一张 Idea 卡（`idea-coexplore` 产出，或 `idea new`）。**这是唯一一个有前置的**：
// 拿不到卡时不许自己编一张——「检索不到 ≠ 新颖」是这条管线要防的头号失效模式，
// 用一张编出来的卡去查，得出的结论连「没查出来」都算不上。
const noveltyCheck: SkillRunner = async (ctx, params) => {
  const library = new LibraryStore(ctx.project.paths.libraryDb, { records: ctx.project.records() });
  try {
    const records = ctx.project.records();
    const store = new IdeaStore(records, library);
    const wanted = str(params, "ideaId") ?? str(params, "recordId");
    const ideas = store.list();
    const idea = wanted
      ? (store.get(wanted) ?? ideas.find((i) => i.recordId.startsWith(wanted)) ?? null)
      : (ideas[0] ?? null);
    if (!idea) {
      return {
        ok: false,
        digest:
          wanted
            ? `novelty-check：思路库里没有 record '${wanted}'。下一步：先跑 idea-coexplore 产出一张 Idea 卡，再拿卡去查。`
            : "novelty-check：思路库是空的。下一步：先跑 idea-coexplore 产出一张 Idea 卡（不许凭空编一张去查——「检索不到 ≠ 新颖」）。",
      };
    }

    ctx.note?.(`创新性核验：${ideaTitle(idea).slice(0, 60)}`);
    const searcher = new LiteratureSearcher(
      new ConnectorRegistry({ credentials: new CredentialStore(), rawSink: ctx.project.raw(), command: "chat" }).registerBuiltins(),
      { cooldownOn429: true, translate: llmQueryTranslator(ctx.llm, ctx.model) },
    );
    const checker = new NoveltyChecker({
      llm: ctx.llm,
      model: ctx.model,
      searcher,
      library,
      records,
      artifacts: ctx.project.artifacts(),
      workDir: ctx.project.paths.artifactsDir,
    });
    const r = await checker.check(idea, { sessionId: ctx.sessionId });
    const byRating = r.assessments.reduce<Record<string, number>>((acc, a) => {
      acc[a.rating] = (acc[a.rating] ?? 0) + 1;
      return acc;
    }, {});
    const lines = r.assessments.slice(0, 6).map((a) => `  · [${a.rating}] ${String(a.claimId).slice(0, 8)} ${a.verdict.slice(0, 100)}`);
    return {
      ok: true,
      digest: [
        `novelty-check：「${ideaTitle(idea)}」→ 总评 ${r.aggregate.status}`,
        `  claim ${r.claims.length} 条 · ${Object.entries(byRating).map(([k, v]) => `${k} ${v}`).join(" / ")}`,
        `  引用核验：${r.citation.findings.length} 条 finding · artifact ${r.artifactId ?? "（未入库）"}`,
        ...lines,
      ].join("\n").slice(0, 1500),
      ...(r.artifactId ? { artifacts: [{ id: r.artifactId, label: `创新性核验：${ideaTitle(idea)}` }] } : {}),
    };
  } finally {
    library.close();
  }
};

/**
 * 分发表。**唯一真源**——盘点表里「已接」那几行与这张表必须对得上。
 *
 * `literature-search` / `literature-review` 不在这里：它们由 `runLiteraturePipeline`
 * 处理，走的是 orchestrator 里既有的那条分支（V172）。把它们搬进来是纯重构，
 * 收益为零而风险是把跑通了三次真实会话的那条路弄坏——本轮不做。
 */
export const SKILL_RUNNERS: Record<string, SkillRunner> = {
  "paper-download": paperDownload,
  "research-report": researchReport,
  "novelty-check": noveltyCheck,
};

/** 编排层的唯一入口。表里没有 → `handled: false`，调用方退回「加载说明书」。 */
export async function runSkill(
  name: string,
  ctx: SkillRunnerContext,
  params: Record<string, unknown> = {},
): Promise<SkillRunResult> {
  const runner = SKILL_RUNNERS[name];
  if (!runner) return { handled: false };
  try {
    return { handled: true, ...(await runner(ctx, params)) };
  } catch (e) {
    // 一个技能炸了不该把整轮 agent 带走，但**必须看得见**（不是静默 ok）。
    const message = e instanceof Error ? e.message : String(e);
    return { handled: true, ok: false, digest: `技能 '${name}' 执行失败：${message.slice(0, 400)}` };
  }
}
