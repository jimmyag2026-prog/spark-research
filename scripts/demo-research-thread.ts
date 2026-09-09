#!/usr/bin/env bun
// 一条完整研究线索的可重放演练（DESIGN §7 判据 1）。
//
//   提出问题 → 文献调研入库 → 精读卡 → 综述 → Co-explore 出 idea → novelty check
//   → 干实验（真 pyref）→ 结论卡 → **过 review 门槛** → 导出带证据链的研究报告
//
// 三条设计口径：
//  1. **走的是真正的 CLI 入口**（`runLitCommand` / `runIdeaCommand` / …），不是绕过 CLI
//     直接调模块。演练要证明的是「用户敲这些命令能走通」，不是「内部函数能串起来」。
//  2. **外部依赖用 P2/P4 录制的 cassette + 脚本化 fake LLM**，干实验用**真的** pyref
//     （零依赖、秒级、确定性）。所以这个脚本在 CI 里可跑、不打任何网络。
//  3. **不放水**：每一步都断言它该产生的东西真的进了证据图，最后校验报告结论区里
//     确实只有过了 review 的结论。任何一步没达到预期就抛错退出码 1。
//
// 用法：
//   bun scripts/demo-research-thread.ts [--keep] [--out report.md]
//   （--keep 保留临时工作区路径，便于事后 `SPARK_RESEARCH_DATA_DIR=… spark-research report export`）
//
// CI 入口是 `tests/unit/demo_thread.test.ts`（同一个 runResearchThread 函数）。

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConclusionCommand } from "../backend/src/conclusion/cli";
import { ConclusionStore } from "../backend/src/conclusion/store";
import { runExpCommand } from "../backend/src/experiment/cli";
import { runIdeaCommand } from "../backend/src/ideation/cli";
import { runLitCommand } from "../backend/src/literature/cli";
import type { LiteratureSearcher } from "../backend/src/literature/search";
import { LibraryStore } from "../backend/src/literature/library";
import { libraryKeyIndex } from "../backend/src/literature/export";
import { ProjectManager } from "../backend/src/project/manager";
import { reportFor } from "../backend/src/report/cli";
import type { ResearchReport } from "../backend/src/report/export";
import { CASSETTES, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../tests/helpers/literature_scenario";
import { PUBLISHED_CLAIM, ScriptedLlm, candidatesByClaim, noveltySearcher } from "../tests/helpers/ideation_scenario";
import { cardJson } from "../tests/helpers/review_scenario";

export interface ThreadStep {
  name: string;
  detail: string;
}

export interface ThreadResult {
  root: string;
  slug: string;
  steps: ThreadStep[];
  report: ResearchReport;
  // 报告结论区的正文（用于断言门槛真的生效）。
  conclusionSection: string;
  pendingSection: string;
}

export interface ThreadOptions {
  root?: string;
  slug?: string;
  log?: (line: string) => void;
}

class DemoFailure extends Error {
  constructor(step: string, message: string) {
    super(`[${step}] ${message}`);
    this.name = "DemoFailure";
  }
}

// fake LLM：按 prompt 分派，与 e2e fixture server 同一套脚本（同一条链路的两个入口）。
function demoLlm(keysNow: () => string[]): ScriptedLlm {
  return new ScriptedLlm([
    // Co-explore：Idea 卡必须引库内 key，且至少一条反面证据。
    (user) => {
      if (!user.includes("可用引用 key 白名单")) return null;
      const keys = keysNow();
      if (keys.length < 2) return null;
      return JSON.stringify({
        critique:
          `这条思路的关键假设是注意力足以替代循环结构[@${keys[0]}]；` +
          `同一批工作也提示评测口径本身不稳定[@${keys[1]}]。怎么证伪它？（inferred）`,
        hypothesis: "用 Transformer 的自注意力完全替代循环结构做序列转导",
        supporting: [{ key: keys[0], note: "同一范式下的代表性结果" }],
        contradicting: [{ key: keys[1], note: "该工作提示结论对评测口径敏感" }],
        openQuestions: ["在长序列与低资源设定下是否同样成立"],
      });
    },
    // novelty claim 提取
    (user) =>
      user.includes("待验证点")
        ? JSON.stringify({ claims: [{ statement: PUBLISHED_CLAIM.statement, queries: PUBLISHED_CLAIM.queries }] })
        : null,
    // novelty 对比评级（只能引 prompt 里真实检索到的候选）
    (user) => {
      if (!user.includes("候选工作")) return null;
      const candidates = candidatesByClaim(user).get("c1") ?? [];
      const hit =
        candidates.find((c) => c.title.toLowerCase().includes(PUBLISHED_CLAIM.expectTitle)) ?? candidates[0];
      if (!hit) return JSON.stringify({ claims: [] });
      return JSON.stringify({
        claims: [
          {
            claimId: "c1",
            rating: "existing",
            verdict: "见最近邻对比",
            nearestWorks: [
              {
                key: hit.key,
                sameness: "同样用自注意力替代循环结构做序列转导",
                difference: "本 claim 没有提出任何新机制",
              },
            ],
          },
        ],
      });
    },
    // 精读卡
    (user) => (user.includes("精读") || user.includes("结构化精读卡") ? cardJson() : null),
    // 综述草稿：只引库内 key
    (user) => {
      if (!user.includes("精读卡") && !user.includes("综述")) return null;
      const keys = keysNow();
      if (keys.length === 0) return null;
      return (
        `# 蛋白结构预测方法综述\n\n` +
        `近年来端到端预测方法成为主线 [@${keys[0]}]。` +
        (keys[1] ? ` 与之互补的评测工作提示结论对口径敏感 [@${keys[1]}]。` : "")
      );
    },
  ]);
}

// 两个 cassette 按 query 分派（与 e2e fixture server 一致）。
class DualCassetteSearcher {
  private library = searcherWith(CASSETTES.search, "replay");
  private novelty = noveltySearcher("replay");

  search: LiteratureSearcher["search"] = (query, options) =>
    (query === SEARCH_QUERY ? this.library : this.novelty).search(query, options);

  fetchById: LiteratureSearcher["fetchById"] = (id, options) => this.library.fetchById(id, options);
}

export async function runResearchThread(options: ThreadOptions = {}): Promise<ThreadResult> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "spark-demo-"));
  const slug = options.slug ?? "demo-thread";
  const log = options.log ?? (() => {});
  const steps: ThreadStep[] = [];
  const record = (name: string, detail: string) => {
    steps.push({ name, detail });
    log(`✅ ${name} — ${detail}`);
  };

  const manager = new ProjectManager(root);
  const searcher = new DualCassetteSearcher() as unknown as LiteratureSearcher;
  const keysNow = (): string[] => {
    const current = manager.currentSlug();
    if (!current) return [];
    const project = manager.open(current);
    const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
    try {
      return libraryKeyIndex(library.list()).keys;
    } finally {
      library.close();
      project.close();
    }
  };
  const llm = demoLlm(keysNow);
  const sink = { out: () => {}, err: () => {} };
  const shared = { manager, searcher, llm, ...sink };

  // ① 提出问题 —— 项目描述就是研究问题，报告的第一节直接用它。
  const question = "端到端方法能否在不引入循环结构的前提下做好序列转导？";
  manager
    .create(slug, { name: "Demo · 序列转导", description: question })
    .close();
  manager.setCurrent(slug);
  record("① 提出问题", question);

  // ② 文献调研入库（cassette 回放，5 源跨源检索）
  const searchCode = await runLitCommand(
    ["search", SEARCH_QUERY, "--sources", SEARCH_SOURCES.join(","), "--limit", "10", "--add"],
    shared,
  );
  if (searchCode !== 0) throw new DemoFailure("② 文献入库", `lit search 退出码 ${searchCode}`);
  const keys = keysNow();
  if (keys.length < 2) throw new DemoFailure("② 文献入库", `库内论文不足 2 篇（实得 ${keys.length}）`);
  record("② 文献调研入库", `${keys.length} 篇论文，bibtex key 已分配`);

  // ③ 精读卡 + 综述（综述会跑一次 citation-integrity）
  if ((await runLitCommand(["read", "--all"], shared)) !== 0) {
    throw new DemoFailure("③ 精读卡", "lit read --all 失败");
  }
  if ((await runLitCommand(["review", "--topic", "序列转导"], shared)) !== 0) {
    throw new DemoFailure("③ 综述", "lit review 失败（引用核验没过）");
  }
  record("③ 精读卡 → 综述", "综述草稿的引用全部落在库内（citation-integrity 通过）");

  // ④ Co-explore 出 idea
  const ideaOut: string[] = [];
  const ideaCode = await runIdeaCommand(["new", "-m", "能不能完全丢掉循环结构？", "--json"], {
    ...shared,
    out: (line) => ideaOut.push(line),
  });
  if (ideaCode !== 0) throw new DemoFailure("④ Co-explore", `idea new 退出码 ${ideaCode}`);
  const ideaId = String(
    (JSON.parse(ideaOut.join("\n")) as { card?: { recordId?: string } }).card?.recordId ?? "",
  );
  if (!ideaId) throw new DemoFailure("④ Co-explore", "没拿到 idea record id");
  record("④ Co-explore 出 idea", `idea ${ideaId.slice(0, 8)}（带支持与反对文献）`);

  // ⑤ novelty check —— 拿一个已发表工作的核心 idea 去查，必须评为 overlap
  const noveltyOut: string[] = [];
  await runIdeaCommand(["check", ideaId, "--json"], { ...shared, out: (line) => noveltyOut.push(line) });
  const novelty = JSON.parse(noveltyOut.join("\n")) as { status?: { status?: string } };
  if (novelty.status?.status !== "checked-overlap") {
    throw new DemoFailure("⑤ novelty", `已发表工作应评为 checked-overlap，实得 ${String(novelty.status?.status)}`);
  }
  record("⑤ novelty check", "已发表工作被正确评为 checked-overlap（不是「查不到就算新颖」）");

  // ⑥ 干实验（**真** pyref 子进程，不是打桩）
  const expOut: string[] = [];
  const newCode = await runExpCommand(
    ["new", "阻尼振子基线", "--platform", "pyref", "--param", "steps=200", "--param", "sampleInterval=20",
      "--hypothesis", "能量单调衰减", "--json"],
    { manager, out: (line) => expOut.push(line), err: () => {} },
  );
  if (newCode !== 0) throw new DemoFailure("⑥ 干实验", `exp new 退出码 ${newCode}`);
  const expId = String((JSON.parse(expOut.join("\n")) as { id?: string }).id ?? "");
  const runOut: string[] = [];
  const runCode = await runExpCommand(["run", expId, "--json"], {
    manager,
    out: (line) => runOut.push(line),
    err: () => {},
  });
  if (runCode !== 0) throw new DemoFailure("⑥ 干实验", `exp run 退出码 ${runCode}`);
  const view = JSON.parse(runOut.join("\n")) as { state?: string; observationId?: string | null };
  if (view.state !== "analyze" || !view.observationId) {
    throw new DemoFailure("⑥ 干实验", `闭环没走到 analyze/observation（state=${view.state}）`);
  }
  record("⑥ 干实验闭环", `pyref 真跑 → observation ${view.observationId.slice(0, 8)}`);

  // ⑦ 结论卡：先写一条**证据说不通**的（必须被否决），再写一条站得住的。
  // 两条一起写，是为了让演练同时覆盖门槛的两个方向——只演「通过」的流程等于没演门槛。
  const project = manager.open(slug);
  let goodConclusionId = "";
  let badConclusionId = "";
  try {
    const store = new ConclusionStore(project.records());
    badConclusionId = store.create({
      claim: "该模型普遍适用于所有序列任务，证明了注意力机制的因果作用",
      // 故意引一条不存在的 observation：对抗用例，必须被 data-consistency 挡下。
      evidenceIds: ["00000000-0000-4000-8000-000000000000"],
    }).recordId;
    goodConclusionId = store.create({
      claim: "在 steps=200 的阻尼振子上观察到能量单调衰减，与假设一致",
      limitations: "只跑了一组参数，未做多初值对照",
      confidence: "medium",
      evidenceIds: [view.observationId],
      experimentId: expId,
      mode: "dry",
    }).recordId;
  } finally {
    project.close();
  }

  // ⑧ 过 review 门槛：伪造证据的那条必须 vetoed（退出码 1），站得住的那条 approved
  const vetoCode = await runConclusionCommand(["review", badConclusionId, "--actor", "demo-reviewer"], {
    manager,
    ...sink,
  });
  if (vetoCode !== 1) throw new DemoFailure("⑧ review", "伪造证据的结论居然通过了评审");
  const okCode = await runConclusionCommand(["review", goodConclusionId, "--actor", "demo-reviewer"], {
    manager,
    ...sink,
  });
  if (okCode !== 0) throw new DemoFailure("⑧ review", "证据齐备的结论没能通过评审");
  record("⑦⑧ 结论卡 → review 门槛", "伪造证据的结论被否决，证据齐备的通过（各一条对照）");

  // ⑨ 导出报告，并验证门槛在报告里真的生效
  const finalProject = manager.open(slug);
  let report: ResearchReport;
  try {
    report = reportFor(finalProject);
  } finally {
    finalProject.close();
  }
  const conclusionSection = report.markdown.split("## 四、结论")[1]?.split("## 五、待验证")[0] ?? "";
  const pendingSection = report.markdown.split("## 五、待验证")[1]?.split("## 附录 A")[0] ?? "";
  if (report.counts.approvedConclusions !== 1) {
    throw new DemoFailure("⑨ 报告", `结论区应恰好 1 条，实得 ${report.counts.approvedConclusions}`);
  }
  if (!conclusionSection.includes("能量单调衰减")) {
    throw new DemoFailure("⑨ 报告", "通过评审的结论没有出现在结论区");
  }
  if (conclusionSection.includes("普遍适用于所有序列任务")) {
    throw new DemoFailure("⑨ 报告", "被否决的结论混进了结论区");
  }
  if (!pendingSection.includes("dangling_evidence")) {
    throw new DemoFailure("⑨ 报告", "待验证区没有说明它为什么被挡住");
  }
  if (!report.markdown.includes(view.observationId)) {
    throw new DemoFailure("⑨ 报告", "证据链断了：observation id 没出现在报告里");
  }
  record(
    "⑨ 导出研究报告",
    `${report.counts.approvedConclusions} 条结论 / ${report.counts.unverifiedConclusions} 条待验证 · ` +
      `引用 ${report.recordIds.length} 条 record`,
  );

  return { root, slug, steps, report, conclusionSection, pendingSection };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outFile = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const keep = args.includes("--keep");
  console.log("Spark Research · 完整研究线索演练（DESIGN §7 判据 1）\n");
  try {
    const result = await runResearchThread({ log: (line) => console.log(line) });
    console.log("");
    console.log(`工作区：${result.root}${keep ? "（已保留）" : ""}`);
    if (outFile) {
      writeFileSync(outFile, result.report.markdown);
      console.log(`报告已写入：${outFile}`);
    }
    console.log(`\n全部 ${result.steps.length} 步通过。`);
  } catch (error) {
    console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
