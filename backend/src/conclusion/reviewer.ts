import type { RecordStore } from "../project/records";
import type { Finding } from "../reviewer/rules";
import {
  capabilityLabeling,
  dataConsistency,
  statsPlausibility,
  type ForeignProjectLookup,
  type ReconciliationMode,
  type ResolvedEvidence,
} from "../reviewer/conclusion_rules";
import type { ConclusionCard, ConclusionFindingStamp, ConclusionReviewStamp } from "./models";
import { ConclusionStore } from "./store";

// 结论卡评审（DESIGN 域 E2 + P8-gate G1）。
//
// 判定规则只有一条，故意做成不可协商的：**任何 hard finding → vetoed，零 hard → approved**。
// 评审人不能「看一眼觉得没事」就放行一条带 hard finding 的结论；他能做的是
// 修结论/补证据后重新评审，或者反向地人工否决一条自动通过的结论（`veto` 选项）。
// 不给「人工推翻 hard」这条路，是因为 hard finding 全部是可核对的事实判断
//（证据不存在、类型不对、模拟数据没标注），不是审美问题。

export interface ConclusionReviewOptions {
  actor?: string | null;
  // 与 AD-6 同一套：explicit / env:SPARK_ACTOR / env:USER / http:explicit / unknown。
  actorSource?: string | null;
  // 人工否决：即使检查器全过也判 vetoed，理由必填。
  veto?: string | null;
  sessionId?: string | null;
}

export interface ConclusionAssessment {
  card: ConclusionCard;
  findings: Finding[];
  resolved: ResolvedEvidence[];
  reconciliation: ReconciliationMode;
  hardCount: number;
  softCount: number;
  // 只看检查器的结论（不含人工否决）。
  wouldApprove: boolean;
}

export interface ConclusionReviewResult extends ConclusionAssessment {
  card: ConclusionCard;
  approved: boolean;
  decisionRecordId: string;
}

export class ConclusionReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConclusionReviewError";
  }
}

function toStamp(finding: Finding): ConclusionFindingStamp {
  return {
    rule: finding.rule ?? "unknown",
    severity: finding.severity,
    message: finding.message,
    ...(finding.detail ? { detail: finding.detail } : {}),
  };
}

export class ConclusionReviewer {
  readonly store: ConclusionStore;
  private readonly foreign: ForeignProjectLookup | undefined;

  constructor(
    private records: RecordStore,
    options: { store?: ConclusionStore; foreign?: ForeignProjectLookup } = {},
  ) {
    this.store = options.store ?? new ConclusionStore(records);
    this.foreign = options.foreign;
  }

  // 跑三个检查器但**不写任何东西**。报告导出与 UI 预览走这条。
  assess(cardOrRef: ConclusionCard | string): ConclusionAssessment {
    const card = typeof cardOrRef === "string" ? this.store.get(cardOrRef) : cardOrRef;
    if (!card) throw new ConclusionReviewError(`找不到结论卡 '${String(cardOrRef)}'`);

    const consistency = dataConsistency({ card, lookup: this.records, foreign: this.foreign });
    const capability = capabilityLabeling({ card, resolved: consistency.resolved });
    // 样本量与 p 值常常写在 observation 正文里而不是 claim 里，一并喂给启发式检查器。
    const evidenceText = consistency.resolved
      .filter((r) => r.ok && r.record)
      .map((r) => r.record!.content)
      .join("\n");
    const stats = statsPlausibility({ card, resolved: consistency.resolved, evidenceText });

    const findings = [...consistency.findings, ...capability.findings, ...stats.findings];
    const hardCount = findings.filter((f) => f.severity === "hard").length;
    return {
      card,
      findings,
      resolved: consistency.resolved,
      reconciliation: capability.reconciliation,
      hardCount,
      softCount: findings.length - hardCount,
      wouldApprove: hardCount === 0,
    };
  }

  // 跑检查 + 落判定 + 落一条 decision record（谁、何时、依据什么）。
  review(cardOrRef: ConclusionCard | string, options: ConclusionReviewOptions = {}): ConclusionReviewResult {
    const assessment = this.assess(cardOrRef);
    const vetoReason = options.veto?.trim() || null;
    if (options.veto !== undefined && options.veto !== null && !vetoReason) {
      throw new ConclusionReviewError("人工否决必须给理由：--veto 后面要跟一句话说明否决什么");
    }
    const approved = assessment.wouldApprove && !vetoReason;
    const at = new Date().toISOString();

    const decision = this.records.create({
      type: "decision",
      title: `${approved ? "通过" : "否决"}结论 · ${assessment.card.title}`,
      content: renderDecision(assessment, approved, options.actor ?? null, vetoReason, at),
      // 评审是人的判断（即便判据是确定性的，做不做这次评审是人决定的）。
      evidence: "inferred",
      origin: { kind: "session", sessionId: options.sessionId ?? null, ref: assessment.card.recordId },
      metadata: {
        kind: "conclusion_review",
        verdict: approved ? "approved" : "vetoed",
        conclusionId: assessment.card.recordId,
        actor: options.actor ?? null,
        actorSource: options.actorSource ?? null,
        hardCount: assessment.hardCount,
        softCount: assessment.softCount,
        reconciliation: assessment.reconciliation,
        manualVeto: vetoReason !== null,
        reason: vetoReason,
        findings: assessment.findings.map(toStamp),
        at,
      },
    });
    this.records.link(decision.id, assessment.card.recordId, "derives_from");

    const stamp: ConclusionReviewStamp = {
      state: approved ? "approved" : "vetoed",
      at,
      actor: options.actor ?? null,
      actorSource: options.actorSource ?? null,
      hardCount: assessment.hardCount,
      softCount: assessment.softCount,
      findings: assessment.findings.map(toStamp),
      reason: vetoReason,
      decisionRecordId: decision.id,
    };
    const card = this.store.setReview(assessment.card.recordId, stamp);
    return { ...assessment, card, approved, decisionRecordId: decision.id };
  }
}

function renderDecision(
  assessment: ConclusionAssessment,
  approved: boolean,
  actor: string | null,
  vetoReason: string | null,
  at: string,
): string {
  const lines: string[] = [];
  lines.push(`# 结论评审 · ${approved ? "approved" : "vetoed"}`);
  lines.push("");
  lines.push(`- 结论卡：\`${assessment.card.recordId}\``);
  lines.push(`- 评审人：${actor ?? "(未记名)"}`);
  lines.push(`- 时间：${at}`);
  lines.push(`- finding：${assessment.hardCount} hard / ${assessment.softCount} soft`);
  lines.push(`- 对账口径：${assessment.reconciliation}`);
  if (vetoReason) {
    lines.push("");
    lines.push(`## 人工否决理由`);
    lines.push("");
    lines.push(vetoReason);
  }
  if (assessment.findings.length > 0) {
    lines.push("");
    lines.push("## finding");
    lines.push("");
    for (const f of assessment.findings) {
      lines.push(`- **${f.severity}** \`${f.rule ?? "unknown"}\` — ${f.message}`);
    }
  }
  return lines.join("\n");
}
