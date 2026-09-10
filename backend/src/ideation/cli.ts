import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { configuredDefaultModel } from "../config";
import { UsageStore, parseBudgetUsd, usageTrackingLlm } from "../usage/ledger";
import { ConnectorRegistry } from "../connectors/registry";
import { CredentialStore } from "../daemon/credentials";
import type { HttpClient } from "../http/client";
import { LibraryStore } from "../literature/library";
import { DEFAULT_SEARCH_SOURCES, LITERATURE_SOURCES, type LiteratureSource } from "../literature/models";
import { LiteratureSearcher } from "../literature/search";
import { LLMRouter } from "../llm/router";
import { ProjectManager, ProjectError, type Project } from "../project/manager";
import type { CitationJudge } from "../reviewer/rules";
import { CoExploreError, CoExploreSession } from "./coexplore";
import { renderIdeaCard, type NoveltyStatus, type StoredIdeaCard } from "./models";
import { NoveltyChecker } from "./novelty";
import { IdeaStore } from "./store";

// `spark-research idea ...` 子命令。风格与 project/cli.ts、literature/cli.ts 一致：
// 返回退出码 + 输出走注入的 out/err，便于单测；不直接 process.exit。

export const IDEA_HELP = `用法:
  spark-research idea new [-m "你的思路"] [--session id] [--json]
                                                  Co-explore 共探 → 产出 Idea 卡入思路库
                                                  不带 -m 时进入多轮交互（/card 定卡，exit 退出）
  spark-research idea list [--status unchecked|checked-novel|checked-incremental|checked-overlap] [--json]
                                                  列出思路库
  spark-research idea check <record-id> [--sources a,b] [--per-source N] [--out 文件] [--json]
                                                  跑 novelty check（claim 提取 → 密集检索 → 对比报告 → 回写）
`;

export interface IdeaCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  http?: HttpClient;
  searcher?: LiteratureSearcher;
  credentials?: CredentialStore;
  llm?: Pick<LLMRouter, "call">;
  model?: string;
  judge?: CitationJudge;
  // 交互式 `idea new` 的输入源；不注入时用 readline（测试一律注入或走 -m）。
  ask?: (prompt: string) => Promise<string | null>;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-m") {
      const next = args[i + 1];
      if (next !== undefined) {
        flags.message = next;
        i++;
      } else {
        flags.message = true;
      }
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSources(raw: string | undefined): LiteratureSource[] {
  if (!raw) return DEFAULT_SEARCH_SOURCES;
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = names.filter((n) => !LITERATURE_SOURCES.includes(n as LiteratureSource));
  if (invalid.length > 0) {
    throw new Error(`未知文献源: ${invalid.join(", ")}（可用: ${LITERATURE_SOURCES.join(", ")}）`);
  }
  return names as LiteratureSource[];
}

function openProject(manager: ProjectManager): { project: Project; library: LibraryStore } {
  const project = manager.defaultProject();
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  return { project, library };
}

function printCard(card: StoredIdeaCard, out: (line: string) => void): void {
  out(`[${card.recordId.slice(0, 8)}] ${card.hypothesis}`);
  out(
    `    novelty ${card.noveltyStatus} · 支持 ${card.supporting.length} · 反对 ${card.contradicting.length}` +
      ` · 待验证 ${card.openQuestions.length}${card.checkedAt ? ` · 查于 ${card.checkedAt.slice(0, 10)}` : ""}`,
  );
}

// V36：`idea new` 的契约校验失败（CoExploreError，见 coexplore.ts）之前只把原始错误
// 打印出来——外部验收者靠猜才绕过去。样板是 `lab approve` 的 V19 拒绝消息
// （backend/src/lab/cli.ts 的 requireApprovalGate）：不止说错在哪，还给出具体能敲的
// 下一步命令。这里不区分「模型调用失败」与「schema 校验失败」两种子情形——两者都
// 已经在 CoExploreError.message 里带了具体原因（校验失败原因 / 模型两次都没内容），
// 这段只补「拿到这条错误之后该做什么」，覆盖两种子情形都成立的三条路：重试
// （LLM 结构化输出本身非确定性）、查 key（doctor/auth）、查文献库（常见的库外引用 /
// 空库导致 contradicting 给不出反面证据）。
function printCoExploreNextSteps(err: (line: string) => void, options: { interactive: boolean }): void {
  err("下一步：");
  err(
    options.interactive
      ? "  · 多数情况下是 LLM 结构化输出的偶发问题（非确定性）：换个说法把这轮想法重新输入一次，通常就能过"
      : '  · 多数情况下是 LLM 结构化输出的偶发问题（非确定性）：重试一次通常就能过——' +
          'spark-research idea new -m "<同样的思路>"',
  );
  err("  · 反复失败：先确认 API Key 已配置——spark-research auth（或 spark-research doctor 看 provider 一节）");
  err(
    "  · 反复失败且提示引用了库外 key / 给不出反对证据：先确认文献库不是空的——" +
      'spark-research lit list（为空就 spark-research lit search "<关键词>" --add）',
  );
}

function defaultAsk(prompt: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function runIdeaCommand(args: string[], deps: IdeaCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;
  const { positional, flags } = parseFlags(rest);
  // G-1（v0.6）：与 literature/cli.ts 同一条模型解析链（--model > 注入 > defaultModel
  // 配置 > 内部默认）。解析逻辑在 config 层的 configuredDefaultModel 单点实现，
  // 两个 CLI 只是消费——不留第二份手写副本（V46 形状）。
  const model = flagString(flags.model) ?? deps.model ?? configuredDefaultModel({ root: deps.root });

  const makeSearcher = (): LiteratureSearcher => {
    if (deps.searcher) return deps.searcher;
    const credentials = deps.credentials ?? new CredentialStore({ root: deps.root });
    return new LiteratureSearcher(new ConnectorRegistry({ http: deps.http, credentials }).registerBuiltins());
  };

  try {
    switch (sub) {
      case "new": {
        const { project, library } = openProject(manager);
        const records = project.records();
        const budget = parseBudgetUsd(flags["budget-usd"], err);
        if (!budget.ok) {
          library.close();
          project.close();
          return 1;
        }
        // G-3：LLM 调用过台账（usage.jsonl 与 lit 系命令同一份，按项目累计）。
        const session = new CoExploreSession({
          llm: usageTrackingLlm({
            llm: deps.llm ?? new LLMRouter(),
            store: new UsageStore(join(project.paths.root, "usage.jsonl")),
            command: "idea-new",
            budgetUsd: budget.value,
            configOptions: { root: deps.root },
          }),
          library,
          records,
          model,
          projectContext: project.meta.description || undefined,
        });
        const sessionId = flagString(flags.session) ?? `idea_${Date.now()}`;
        const message = flagString(flags.message);

        if (library.count() === 0) {
          // 不拦死：库为空时 co-explore 仍能跑（全部标 inferred），但必须让用户知道
          // 这次共探没有文献基础——这是「诚实」，不是免责声明。
          err("⚠️  项目文献库为空：本次共探的所有观点都只能是推断（inferred），没有文献支撑。");
          err("   建议先跑 spark-research lit search \"<关键词>\" --add 把相关文献入库。");
        }

        if (message) {
          const result = await session.explore(message, { sessionId });
          if (flags.json === true) {
            out(JSON.stringify({ card: result.stored, grounding: result.grounding }, null, 2));
          } else {
            out(result.card.critique);
            out("");
            out(renderIdeaCard(result.stored, result.stored.noveltyStatus));
            out("");
            out(`✅ Idea 卡已入思路库（项目 ${project.slug}） record: ${result.stored.recordId}`);
            for (const claim of result.grounding.ungroundedClaims) {
              err(`⚠️  强断言无引用也无 inferred 标注: "${claim.slice(0, 100)}"`);
            }
            out(`下一步：spark-research idea check ${result.stored.recordId.slice(0, 8)}`);
          }
          library.close();
          project.close();
          return 0;
        }

        // 交互式多轮共探：每轮都给一次批判性反馈 + 一张候选卡，/card 定卡入库。
        const ask = deps.ask ?? defaultAsk;
        out("Co-explore 共探模式（/card 定卡入库，exit 退出）");
        let history: Awaited<ReturnType<typeof session.turn>>["history"] = [];
        let pending: Awaited<ReturnType<typeof session.turn>> | null = null;
        for (;;) {
          const line = await ask("idea> ");
          if (line === null) break;
          const input = line.trim();
          if (!input) continue;
          if (input === "exit" || input === "quit") break;
          if (input === "/card") {
            if (!pending) {
              err("还没有可定的卡：先说说你的思路。");
              continue;
            }
            const stored = session.save(pending.card, { sessionId, model: pending.model });
            out(renderIdeaCard(stored, stored.noveltyStatus));
            out(`✅ Idea 卡已入思路库 record: ${stored.recordId}`);
            out(`下一步：spark-research idea check ${stored.recordId.slice(0, 8)}`);
            break;
          }
          try {
            pending = await session.turn(input, { history, sessionId });
            history = pending.history;
            out("");
            out(pending.card.critique);
            out("");
            out(`（候选假设：${pending.card.hypothesis}；反对证据 ${pending.card.contradicting.length} 条。/card 定卡）`);
          } catch (error) {
            if (error instanceof CoExploreError) {
              err(`❌ ${error.message}`);
              printCoExploreNextSteps(err, { interactive: true });
            } else {
              err(`❌ ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        library.close();
        project.close();
        return 0;
      }

      case "list": {
        const { project, library } = openProject(manager);
        const store = new IdeaStore(project.records(), library);
        const cards = store.list({ status: flagString(flags.status) as NoveltyStatus | undefined });
        if (flags.json === true) {
          out(JSON.stringify(cards, null, 2));
        } else if (cards.length === 0) {
          out(`项目 '${project.slug}' 的思路库为空。用 spark-research idea new -m "<你的思路>" 开始共探。`);
        } else {
          out(`项目 '${project.slug}' 思路库：${cards.length} 条`);
          cards.forEach((card) => printCard(card, out));
        }
        library.close();
        project.close();
        return 0;
      }

      case "check": {
        const target = positional[0];
        if (!target) {
          err("用法: spark-research idea check <record-id>");
          return 1;
        }
        const { project, library } = openProject(manager);
        const records = project.records();
        const store = new IdeaStore(records, library);
        const idea = store.get(target);
        if (!idea) {
          err(`❌ 思路库里没有 record '${target}'`);
          library.close();
          project.close();
          return 1;
        }

        const checkBudget = parseBudgetUsd(flags["budget-usd"], err);
        if (!checkBudget.ok) {
          library.close();
          project.close();
          return 1;
        }
        const checker = new NoveltyChecker({
          llm: usageTrackingLlm({
            llm: deps.llm ?? new LLMRouter(),
            store: new UsageStore(join(project.paths.root, "usage.jsonl")),
            command: "novelty-check",
            budgetUsd: checkBudget.value,
            configOptions: { root: deps.root },
          }),
          searcher: makeSearcher(),
          library,
          records,
          artifacts: project.artifacts(),
          model,
          workDir: project.paths.artifactsDir,
          sources: parseSources(flagString(flags.sources)),
          perSource: Number(flagString(flags["per-source"]) ?? 5) || 5,
          judge: deps.judge,
        });
        const result = await checker.check(idea, { sessionId: flagString(flags.session) ?? null });

        const outFile = flagString(flags.out);
        if (outFile) writeFileSync(outFile, `${result.markdown}\n`);

        if (flags.json === true) {
          out(
            JSON.stringify(
              {
                status: result.aggregate,
                assessments: result.assessments,
                recordId: result.recordId,
                artifactId: result.artifactId,
                path: result.path,
              },
              null,
              2,
            ),
          );
        } else {
          out(`Novelty check：${idea.hypothesis}`);
          out(`  claim ${result.claims.length} 条 · 候选 ${result.retrievals.reduce((n, r) => n + r.candidates.length, 0)} 篇`);
          out("");
          for (const a of result.assessments) {
            const claim = result.claims.find((c) => c.id === a.claimId);
            out(`${a.claimId} ${a.rating}${a.rating !== a.declaredRating ? `（模型原判 ${a.declaredRating}，已校正）` : ""}: ${claim?.statement ?? ""}`);
            for (const work of a.nearestWorks) out(`    最近邻 [@${work.key}] 差异：${work.difference}`);
            for (const v of a.violations) err(`    ⚠️  ${v.code}: ${v.message}`);
          }
          out("");
          out(`报告: ${outFile ?? result.path}`);
          out(`  artifact ${result.artifactId ?? "未入库"} · record ${result.recordId ?? "未入库"}`);
          const hard = result.citation.findings.filter((f) => f.severity === "hard");
          out(
            `citation-integrity: 解析引用 ${result.citation.citations.length} 处` +
              (hard.length > 0 ? `，${hard.length} 条 hard finding` : "，0 条 hard finding"),
          );
          for (const finding of result.citation.findings) {
            out(`  ${finding.severity === "hard" ? "⛔" : "⚠️ "} ${finding.message}`);
          }
          if (result.aggregate.conclusive) {
            out(`✅ 思路库状态 → ${result.aggregate.status}`);
          } else {
            err("⚠️  本次未得出可用结论（见上面的评级校验违规），思路库状态维持 unchecked");
          }
          if (hard.length > 0) {
            err(`⛔ 报告引用核验未通过：${hard.length} 条 hard finding`);
          }
        }

        const failed =
          result.citation.findings.some((f) => f.severity === "hard") || !result.aggregate.conclusive;
        library.close();
        project.close();
        return failed ? 1 : 0;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(IDEA_HELP);
        return sub === undefined ? 1 : 0;

      default:
        err(`未知的 idea 子命令 '${sub}'`);
        err(IDEA_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ProjectError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    if (error instanceof CoExploreError) {
      err(`❌ ${error.message}`);
      printCoExploreNextSteps(err, { interactive: false });
      return 1;
    }
    err(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
