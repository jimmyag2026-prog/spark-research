import { ProjectError, ProjectManager, type Project, openProjectResolved } from "../project/manager";
import { CONCLUSION_REVIEW_STATES, reviewStateLabel, type ConclusionCard, type ConclusionReviewState } from "./models";
import { ConclusionReviewer, ConclusionReviewError } from "./reviewer";
import { ConclusionStore, ConclusionStoreError } from "./store";

// `spark-research conclusion ...` 子命令（P8-gate G1）。
// 风格与 project/experiment/lab CLI 一致：返回退出码 + 输出走注入的 out/err。

export const CONCLUSION_HELP = `用法:
  spark-research conclusion list [--review ${CONCLUSION_REVIEW_STATES.join("|")}] [--json]
                                        列出本项目的结论卡与 review 状态
  spark-research conclusion show <id> [--json]
                                        看一张结论卡：主张 / 证据 / 局限 / 最近一次评审
  spark-research conclusion review <id> [--actor 谁] [--veto "否决理由"] [--json]
                                        跑检查器（data-consistency / capability-labeling /
                                        stats-plausibility）并落判定：
                                        任一 hard finding → vetoed，零 hard → approved
                                        --veto：人工否决一条本来会通过的结论（理由必填）

只有 approved 的结论进研究报告的「结论」区；pending/vetoed 进「待验证」区。
退出码 1 = 结论被否决 / 命令用错。
`;

export interface ConclusionCliDeps {
  manager?: ProjectManager;
  root?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  actor?: string;
  reviewer?: (project: Project) => ConclusionReviewer;
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
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

// 与 lab CLI 同一套口径（AD-6）：落到 $USER 是诚实的，但 source 要记下来。
function resolveActor(deps: ConclusionCliDeps, flag: string | undefined): { actor: string; source: string } {
  if (flag) return { actor: flag, source: "explicit" };
  if (deps.actor) return { actor: deps.actor, source: "explicit" };
  if (process.env.SPARK_ACTOR) return { actor: process.env.SPARK_ACTOR, source: "env:SPARK_ACTOR" };
  if (process.env.USER) return { actor: process.env.USER, source: "env:USER" };
  return { actor: "unknown", source: "unknown" };
}

const STATE_ICON: Record<ConclusionReviewState, string> = {
  pending: "⏳",
  approved: "✅",
  vetoed: "⛔",
};

function printCard(card: ConclusionCard, out: (line: string) => void): void {
  out(`${STATE_ICON[card.review.state]} [${card.recordId.slice(0, 8)}] ${card.title}`);
  out(`    ${reviewStateLabel(card.review.state)} · 证据 ${card.evidenceIds.length} 条 · ${card.mode}`);
  if (card.review.at) {
    out(
      `    评审：${card.review.actor ?? "(未记名)"} @ ${card.review.at} · ` +
        `${card.review.hardCount} hard / ${card.review.softCount} soft`,
    );
  }
}

function cardJson(card: ConclusionCard): Record<string, unknown> {
  const { record: _record, ...rest } = card;
  return rest;
}

function makeReviewer(project: Project, deps: ConclusionCliDeps): ConclusionReviewer {
  if (deps.reviewer) return deps.reviewer(project);
  return new ConclusionReviewer(project.records());
}

export async function runConclusionCommand(args: string[], deps: ConclusionCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const manager = deps.manager ?? new ProjectManager(deps.root);
  const [sub, ...rest] = args;
  const { positional, flags } = parseArgs(rest);

  let project: Project | null = null;
  try {
    switch (sub) {
      case "list": {
        project = openProjectResolved(manager, flagString(flags.project));
        const store = new ConclusionStore(project.records());
        const reviewFlag = flagString(flags.review);
        if (reviewFlag && !(CONCLUSION_REVIEW_STATES as readonly string[]).includes(reviewFlag)) {
          err(`❌ 未知 review 状态 '${reviewFlag}'（可用：${CONCLUSION_REVIEW_STATES.join(", ")}）`);
          return 1;
        }
        const cards = store.list({ review: reviewFlag as ConclusionReviewState | undefined });
        if (flags.json === true) {
          out(JSON.stringify(cards.map(cardJson), null, 2));
        } else if (cards.length === 0) {
          out(`项目 '${project.slug}' 还没有结论卡（干/湿实验 conclude 后会生成）。`);
        } else {
          out(`项目 '${project.slug}' 结论卡：${cards.length} 条`);
          for (const card of cards) printCard(card, out);
        }
        return 0;
      }

      case "show": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research conclusion show <id>");
          return 1;
        }
        project = openProjectResolved(manager, flagString(flags.project));
        const reviewer = makeReviewer(project, deps);
        const card = reviewer.store.get(ref);
        if (!card) {
          err(`❌ 找不到结论卡 '${ref}'`);
          return 1;
        }
        // show 顺带跑一次**不落库**的评估：让人看到「现在重新评审会是什么结果」。
        const assessment = reviewer.assess(card);
        if (flags.json === true) {
          out(
            JSON.stringify(
              {
                ...cardJson(card),
                assessment: {
                  hardCount: assessment.hardCount,
                  softCount: assessment.softCount,
                  wouldApprove: assessment.wouldApprove,
                  reconciliation: assessment.reconciliation,
                  findings: assessment.findings,
                },
              },
              null,
              2,
            ),
          );
        } else {
          out(card.record.content);
          out("");
          out(
            `当前重新评审的结果会是：${assessment.wouldApprove ? "approved" : "vetoed"}` +
              `（${assessment.hardCount} hard / ${assessment.softCount} soft）`,
          );
          for (const f of assessment.findings) out(`  ${f.severity === "hard" ? "⛔" : "⚠️ "} ${f.message}`);
        }
        return 0;
      }

      case "review": {
        const ref = positional[0];
        if (!ref) {
          err("用法: spark-research conclusion review <id> [--actor 谁] [--veto 理由]");
          return 1;
        }
        project = openProjectResolved(manager, flagString(flags.project));
        const reviewer = makeReviewer(project, deps);
        const card = reviewer.store.get(ref);
        if (!card) {
          err(`❌ 找不到结论卡 '${ref}'`);
          return 1;
        }
        const signer = resolveActor(deps, flagString(flags.actor));
        const vetoFlag = flags.veto;
        if (vetoFlag === true) {
          err("❌ --veto 必须带理由：--veto \"为什么否决\"");
          return 1;
        }
        const result = reviewer.review(card, {
          actor: signer.actor,
          actorSource: signer.source,
          veto: typeof vetoFlag === "string" ? vetoFlag : null,
        });
        if (flags.json === true) {
          out(
            JSON.stringify(
              {
                ...cardJson(result.card),
                approved: result.approved,
                decisionRecordId: result.decisionRecordId,
                reconciliation: result.reconciliation,
                findings: result.findings,
              },
              null,
              2,
            ),
          );
        } else {
          out(
            `${result.approved ? "✅ approved" : "⛔ vetoed"} — ${result.card.title}` +
              `（${result.hardCount} hard / ${result.softCount} soft）`,
          );
          out(`  评审人：${signer.actor}（${signer.source}）· decision \`${result.decisionRecordId}\``);
          out(`  对账口径：${result.reconciliation}`);
          for (const f of result.findings) {
            const line = `  ${f.severity === "hard" ? "⛔" : "⚠️ "} ${f.message}`;
            if (f.severity === "hard") err(line);
            else out(line);
          }
          if (!result.approved) {
            err("  这条结论不会进入研究报告的「结论」区，只会出现在「待验证」区。");
          }
        }
        return result.approved ? 0 : 1;
      }

      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(CONCLUSION_HELP);
        return sub === undefined ? 1 : 0;

      default:
        err(`未知的 conclusion 子命令 '${sub}'`);
        err(CONCLUSION_HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof ProjectError || error instanceof ConclusionStoreError || error instanceof ConclusionReviewError) {
      err(`❌ ${error.message}`);
      return 1;
    }
    err(`❌ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    project?.close();
  }
}
