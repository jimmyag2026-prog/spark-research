import type { ConclusionCard } from "../conclusion/models";
import type { RecordEdge, ResearchRecord } from "../project/models";
import type { Finding, Severity } from "./rules";

// 结论卡检查器（DESIGN 域 E1 的后两条 + P8-gate G2/G3/G4）。
//
// 三个独立规则，全部零 IO、可单测，与 citation-integrity 同一形态：
//   data-consistency     结论引用的 observation 必须真实存在于执行记录  → hard
//   capability-labeling  能力位（simulated / deterministic）的消费端    → hard
//   stats-plausibility   统计合理性的启发式提示                        → soft only
//
// 与 citation-integrity 同一条豁免：这些 finding 的严重度由规则自己定，
// **不参与 applyLocationWeight**。结论卡正文是 markdown，位置加权会把所有 soft
// 升成 veto，直接毁掉「启发式只提示不否决」的语义。

export const DATA_CONSISTENCY_RULE = "data-consistency";
export const CAPABILITY_RULE = "capability-labeling";
export const STATS_RULE = "stats-plausibility";

export const CONCLUSION_RULES = [DATA_CONSISTENCY_RULE, CAPABILITY_RULE, STATS_RULE] as const;

// RecordStore 结构上就满足这个接口；测试可以注入更窄的假实现。
export interface RecordLookup {
  readonly project: string;
  get(id: string): ResearchRecord | null;
  edgesOf(id: string): { outgoing: RecordEdge[]; incoming: RecordEdge[] };
}

// 「这条 id 在别的项目里吗」——只用来把错误信息说准（跨项目引用 vs 凭空捏造），
// 两者都是 hard。给不出来就不给，检查结论不变。
export type ForeignProjectLookup = (id: string) => string | null;

export interface ResolvedEvidence {
  id: string;
  record: ResearchRecord | null;
  // 该证据是否可用（存在、类型对、同项目）。
  ok: boolean;
  // 能力位（P5 deterministic / P6 simulated），取自 observation 的 metadata。
  simulated: boolean;
  deterministic: boolean | null;
  // 执行记录锚点：仿真 runId / 实验 record id。两个都没有 = 手工登记的观察。
  runId: string | null;
  experimentId: string | null;
  // 证据图上 conclusion --derives_from--> observation 的边在不在。
  linked: boolean;
}

function metaOf(record: ResearchRecord | null): Record<string, unknown> {
  return (record?.metadata ?? {}) as Record<string, unknown>;
}

function finding(
  severity: Severity,
  rule: string,
  card: ConclusionCard,
  location: string,
  message: string,
  detail: Record<string, unknown>,
): Finding {
  return { severity, artifactId: card.recordId, location, rule, message, detail };
}

// ── G2 数据-结论一致性 ───────────────────────────────────────────────────────

export interface DataConsistencyInput {
  card: ConclusionCard;
  lookup: RecordLookup;
  foreign?: ForeignProjectLookup;
  location?: string;
}

export interface DataConsistencyResult {
  findings: Finding[];
  resolved: ResolvedEvidence[];
}

export function resolveEvidence(
  card: ConclusionCard,
  lookup: RecordLookup,
): ResolvedEvidence[] {
  const edges = lookup.edgesOf(card.recordId);
  const linkedTargets = new Set(
    edges.outgoing.filter((e) => e.type === "derives_from").map((e) => e.targetId),
  );
  return card.evidenceIds.map((id) => {
    const record = lookup.get(id);
    const meta = metaOf(record);
    const sameProject = record !== null && record.project === lookup.project;
    const isObservation = record?.type === "observation";
    return {
      id,
      record,
      ok: record !== null && sameProject && isObservation,
      simulated: meta.simulated === true,
      deterministic: typeof meta.deterministic === "boolean" ? meta.deterministic : null,
      runId: typeof meta.runId === "string" && meta.runId ? meta.runId : null,
      experimentId: typeof meta.experimentId === "string" && meta.experimentId ? meta.experimentId : null,
      linked: linkedTargets.has(id),
    };
  });
}

export function dataConsistency(input: DataConsistencyInput): DataConsistencyResult {
  const { card, lookup } = input;
  const location = input.location ?? "conclusion-card";
  const resolved = resolveEvidence(card, lookup);
  const findings: Finding[] = [];

  // 文献推导的结论（域 A3 综述/理论推演）证据是精读卡与文献，不是实验观察。
  // 其余模式一律要求 observation。
  const literatureMode = card.mode === "literature";
  const allowedTypes = literatureMode ? ["reading", "paper"] : ["observation"];
  const evidenceNoun = literatureMode ? "精读卡或文献" : "observation";

  // ① 一条证据都没有 = 这不是结论，是主张。hard。
  if (card.evidenceIds.length === 0) {
    findings.push(
      finding("hard", DATA_CONSISTENCY_RULE, card, location, `no_evidence: 结论卡没有引用任何${evidenceNoun}。`, {
        claim: card.claim.slice(0, 160),
        mode: card.mode,
      }),
    );
  }

  for (const item of resolved) {
    // ② 断链：引用的 record 在本项目里根本不存在。
    if (!item.record) {
      const owner = input.foreign?.(item.id) ?? null;
      findings.push(
        owner
          ? finding(
              "hard",
              DATA_CONSISTENCY_RULE,
              card,
              location,
              `cross_project_evidence: 引用的 observation \`${item.id}\` 属于项目 '${owner}'，` +
                `不在本项目 '${lookup.project}' 的执行记录里。`,
              { evidenceId: item.id, ownerProject: owner, project: lookup.project },
            )
          : finding(
              "hard",
              DATA_CONSISTENCY_RULE,
              card,
              location,
              `dangling_evidence: 引用的 observation \`${item.id}\` 不存在于执行记录。`,
              { evidenceId: item.id, project: lookup.project },
            ),
      );
      continue;
    }

    // ③ 同一个 id 在库里但属于别的项目（同一 records.db 被改过 project 标记的情况）。
    if (item.record.project !== lookup.project) {
      findings.push(
        finding(
          "hard",
          DATA_CONSISTENCY_RULE,
          card,
          location,
          `cross_project_evidence: 引用的 record \`${item.id}\` 属于项目 '${item.record.project}'，` +
            `不是本项目 '${lookup.project}'。`,
          { evidenceId: item.id, ownerProject: item.record.project, project: lookup.project },
        ),
      );
      continue;
    }

    // ④ 类型不对：拿 idea / 另一条 conclusion 当「数据」。
    // 允许的类型随 mode 变：实验结论要 observation，文献结论要 reading/paper。
    if (!allowedTypes.includes(item.record.type)) {
      findings.push(
        finding(
          "hard",
          DATA_CONSISTENCY_RULE,
          card,
          location,
          `evidence_type_mismatch: \`${item.id}\` 是 ${item.record.type} record——` +
            `${card.mode} 模式结论的证据只能是 ${allowedTypes.join(" / ")}。`,
          { evidenceId: item.id, actualType: item.record.type },
        ),
      );
      continue;
    }

    // ⑤ observation 存在但没有执行锚点 = 手工登记的观察。soft：合法但要被看见。
    // 文献证据（reading/paper）本就不来自执行，不适用这条。
    if (!literatureMode && !item.runId && !item.experimentId) {
      findings.push(
        finding(
          "soft",
          DATA_CONSISTENCY_RULE,
          card,
          location,
          `evidence_without_execution: observation \`${item.id}\` 没有 runId/experimentId 锚点，` +
            `无法回溯到一次真实执行（手工登记的观察）。`,
          { evidenceId: item.id },
        ),
      );
    }

    // ⑥ 证据图上没连边：读图的人顺着边走不到这条证据。soft（数据本身没问题）。
    if (!item.linked) {
      findings.push(
        finding(
          "soft",
          DATA_CONSISTENCY_RULE,
          card,
          location,
          `evidence_not_linked: 结论卡与 observation \`${item.id}\` 之间没有 derives_from 边，` +
            `证据图上追不到它。`,
          { evidenceId: item.id },
        ),
      );
    }
  }

  return { findings, resolved };
}

// ── G4 能力位消费端（simulated / deterministic）─────────────────────────────

// 声称「逐位复现」的措辞。刻意收窄：只抓真的在说 bit-level 一致的说法，
// 「可复现」「可重复」这类正常表述不算（那在非确定性平台上照样成立，靠的是区间对账）。
export const BITWISE_CLAIM_PATTERNS: RegExp[] = [
  /逐位(复现|一致|相同|重现)/,
  /逐比特/,
  /位级(一致|复现)/,
  /数值完全(一致|相同|吻合)/,
  /结果完全(一致|相同)/,
  /完全可复现/,
  /bit[-\s]?(wise|level|exact)/i,
  /bit[-\s]?for[-\s]?bit/i,
  /numerically identical/i,
  /exactly reproducible/i,
];

// 承认模拟来源的措辞。
export const SIMULATION_ACK_PATTERNS: RegExp[] = [
  /模拟(器|执行|读数|数据|结果|运行)/,
  /仿真(读数|数据|结果)/,
  /未上真机/,
  /非真实(实验|设备|硬件)/,
  /simulat(ed|or|ion)/i,
  /in silico/i,
];

export function mentionsSimulation(text: string): boolean {
  return SIMULATION_ACK_PATTERNS.some((p) => p.test(text));
}

export function claimsBitwiseReproducibility(text: string): boolean {
  return BITWISE_CLAIM_PATTERNS.some((p) => p.test(text));
}

// 报告与检查器共用的对账口径：
//   bitwise  全部证据来自确定性平台 → 可以说「逐位重算对账」
//   interval 任一证据来自非确定性平台 → 只能说「区间/趋势对账」
//   unknown  证据没带能力位（湿实验 observation 不带 deterministic）→ 不做承诺
export type ReconciliationMode = "bitwise" | "interval" | "unknown";

export function reconciliationMode(resolved: ResolvedEvidence[]): ReconciliationMode {
  const usable = resolved.filter((r) => r.ok);
  if (usable.length === 0) return "unknown";
  if (usable.some((r) => r.deterministic === false)) return "interval";
  if (usable.every((r) => r.deterministic === true)) return "bitwise";
  return "unknown";
}

export const RECONCILIATION_WORDING: Record<ReconciliationMode, string> = {
  bitwise: "逐位重算对账（证据全部来自确定性平台，同参数重跑应逐位一致）",
  interval: "区间/趋势对账（证据含非确定性平台产出，重跑只保证落在同一区间/趋势，不逐位一致）",
  unknown: "对账方式未定（证据未携带 deterministic 能力位，不对可复现性做承诺）",
};

export interface CapabilityInput {
  card: ConclusionCard;
  resolved: ResolvedEvidence[];
  location?: string;
}

export interface CapabilityResult {
  findings: Finding[];
  reconciliation: ReconciliationMode;
  simulatedEvidenceIds: string[];
  acknowledged: boolean;
}

export function capabilityLabeling(input: CapabilityInput): CapabilityResult {
  const { card, resolved } = input;
  const location = input.location ?? "conclusion-card";
  const findings: Finding[] = [];
  const text = `${card.claim}\n${card.limitations ?? ""}`;
  const simulatedEvidenceIds = resolved.filter((r) => r.ok && r.simulated).map((r) => r.id);
  const acknowledged = mentionsSimulation(text);

  // ① 模拟读数没标注 = 把 Opentrons 的 0.0 当成真实实验数据写进结论。hard。
  if (simulatedEvidenceIds.length > 0 && !acknowledged) {
    findings.push(
      finding(
        "hard",
        CAPABILITY_RULE,
        card,
        location,
        `unlabeled_simulated_evidence: 结论引用了模拟执行产生的 observation` +
          `（${simulatedEvidenceIds.map((id) => `\`${id}\``).join("、")}），` +
          `但 claim 与 limitations 里都没有说明数据来自模拟。` +
          `修复：在 limitations 里写明「读数来自 Opentrons 模拟器，非真实实验数据」，或换成真机执行的观察。`,
        { evidenceIds: simulatedEvidenceIds, acknowledged: false },
      ),
    );
  }

  // ② 在非确定性平台上声称逐位复现。hard——这是对数据性质的错误陈述。
  const reconciliation = reconciliationMode(resolved);
  if (reconciliation === "interval" && claimsBitwiseReproducibility(text)) {
    const nondet = resolved.filter((r) => r.ok && r.deterministic === false).map((r) => r.id);
    findings.push(
      finding(
        "hard",
        CAPABILITY_RULE,
        card,
        location,
        `bitwise_claim_on_nondeterministic: 结论声称逐位/完全一致的可复现性，但证据` +
          `（${nondet.map((id) => `\`${id}\``).join("、")}）来自非确定性平台（deterministic=false）。` +
          `修复：改成区间/趋势对账的措辞，或补一次同种子重跑的证据。`,
        { evidenceIds: nondet, reconciliation },
      ),
    );
  }

  return { findings, reconciliation, simulatedEvidenceIds, acknowledged };
}

// ── G3 统计合理性（启发式，一律 soft）────────────────────────────────────────
//
// 这一组明确标为**启发式**：误报可接受（提示而已），漏报也可接受（它不是统计审稿人）。
// 每条 finding 的 detail 都带 `heuristic: true`，前端/报告据此弱化呈现。

const SMALL_SAMPLE_THRESHOLD = 6;

export interface StatsSignals {
  sampleSizes: number[];
  pValues: number[];
  comparisonCount: number | null;
  hasCorrection: boolean;
  mentionsMultipleTests: boolean;
}

const SAMPLE_PATTERNS: RegExp[] = [
  /\bn\s*[=＝]\s*(\d+)/gi,
  /样本量[^\d]{0,6}(\d+)/g,
  /重复\s*(\d+)\s*次/g,
  /(\d+)\s*(?:次重复|个重复|个样本|例样本|个平行样)/g,
  /(\d+)\s*(?:replicates?|samples?|runs?)\b/gi,
];

// 只认 `p = 0.043` 这种给了具体值的；`p < 0.05` 是阈值声明不是观测值。
const P_VALUE_PATTERNS: RegExp[] = [/\bp\s*[-\s]?value\s*[=＝]\s*(0?\.\d+)/gi, /\bp\s*[=＝≈]\s*(0?\.\d+)/gi];

const CORRECTION_PATTERNS: RegExp[] = [
  /bonferroni/i,
  /holm/i,
  /(?:š|s)id[áa]k/i,
  /\bFDR\b/,
  /benjamini/i,
  /错误发现率/,
  /多重比较(?:已)?校正/,
  /(?:已)?做了?多重(?:比较|检验)校正/,
  /adjusted\s+p/i,
  /corrected\s+for\s+multiple/i,
];

const MULTIPLE_TEST_PATTERNS: RegExp[] = [
  /多重比较/,
  /multiple\s+(?:comparisons?|testing|hypotheses)/i,
  /比较了\s*(\d+)\s*(?:组|个|种|条)/,
  /(\d+)\s*(?:个|次)\s*假设检验/,
  /(\d+)\s*组\s*(?:对比|比较)/,
  /(\d+)\s*(?:pairwise|group)\s+comparisons?/i,
];

// 强因果/普适断言。与 citation-integrity 的 STRONG_CLAIM_PATTERNS 是两套：
// 那边管「有没有引用」，这边管「数据撑不撑得住这个强度」。
export const OVERCLAIM_PATTERNS: RegExp[] = [
  /证明了?/,
  /(?:因此|从而)?(?:可以)?确证/,
  /存在因果(?:关系)?/,
  /必然(?:会|能)?/,
  /普遍适用/,
  /适用于(?:所有|一切)/,
  /完全(?:消除|解决)/,
  /一定(?:能|会)/,
  /\bprove[sd]?\b/i,
  /\bcauses?\b/i,
  /\bcausal(?:ly)?\b/i,
  /\balways\b/i,
  /\bguarantee[sd]?\b/i,
  /\bin all cases\b/i,
];

function collectNumbers(text: string, patterns: RegExp[]): number[] {
  const out: number[] = [];
  for (const pattern of patterns) {
    // 每次用新的 RegExp，避免 lastIndex 在多次调用间串味。
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(re)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) out.push(value);
    }
  }
  return out;
}

export function extractStatsSignals(text: string): StatsSignals {
  const sampleSizes = collectNumbers(text, SAMPLE_PATTERNS).filter((n) => n > 0);
  const pValues = collectNumbers(text, P_VALUE_PATTERNS).filter((p) => p >= 0 && p <= 1);
  const comparisonCounts = collectNumbers(text, MULTIPLE_TEST_PATTERNS);
  const mentionsMultipleTests = MULTIPLE_TEST_PATTERNS.some((p) => new RegExp(p.source, p.flags).test(text));
  return {
    sampleSizes,
    pValues,
    comparisonCount: comparisonCounts.length > 0 ? Math.max(...comparisonCounts) : null,
    hasCorrection: CORRECTION_PATTERNS.some((p) => p.test(text)),
    mentionsMultipleTests,
  };
}

export interface StatsInput {
  card: ConclusionCard;
  resolved: ResolvedEvidence[];
  // observation 正文（含摘要表）——样本量与 p 值经常写在观察里而不是结论里。
  evidenceText?: string;
  location?: string;
}

export interface StatsResult {
  findings: Finding[];
  signals: StatsSignals;
}

export function statsPlausibility(input: StatsInput): StatsResult {
  const { card, resolved } = input;
  const location = input.location ?? "conclusion-card";
  const text = [card.claim, card.limitations ?? "", input.evidenceText ?? ""].join("\n");
  const signals = extractStatsSignals(text);
  const findings: Finding[] = [];
  const soft = (message: string, detail: Record<string, unknown>) =>
    findings.push(finding("soft", STATS_RULE, card, location, message, { ...detail, heuristic: true }));

  // ① 样本量过小。
  const minSample = signals.sampleSizes.length > 0 ? Math.min(...signals.sampleSizes) : null;
  if (minSample !== null && minSample < SMALL_SAMPLE_THRESHOLD) {
    soft(
      `small_sample (启发式): 文本里出现的最小样本量是 n=${minSample}（阈值 ${SMALL_SAMPLE_THRESHOLD}）。` +
        `这个量级下效应量估计不稳定，请确认结论强度与之匹配。`,
      { rule: "small_sample", minSample, threshold: SMALL_SAMPLE_THRESHOLD, sampleSizes: signals.sampleSizes },
    );
  }

  // ② 多重比较未校正。判据：说了在做多组比较（或列出 ≥3 个 p 值），且没提任何校正方法。
  const manyPValues = signals.pValues.length >= 3;
  const multipleComparisons =
    signals.mentionsMultipleTests || manyPValues || (signals.comparisonCount ?? 0) >= 3;
  if (multipleComparisons && !signals.hasCorrection) {
    soft(
      `multiple_comparisons_uncorrected (启发式): 看起来做了多组比较` +
        `（${signals.comparisonCount !== null ? `声明 ${signals.comparisonCount} 组；` : ""}` +
        `文本中出现 ${signals.pValues.length} 个 p 值），但没有提到任何多重比较校正` +
        `（Bonferroni / Holm / FDR …）。`,
      {
        rule: "multiple_comparisons",
        comparisonCount: signals.comparisonCount,
        pValueCount: signals.pValues.length,
      },
    );
  }

  // ③ p 值边缘。
  const marginal = signals.pValues.filter((p) => p >= 0.04 && p <= 0.05);
  if (marginal.length > 0) {
    soft(
      `marginal_p_value (启发式): p = ${marginal.map((p) => p.toFixed(3)).join(", ")} 落在 0.04–0.05 的边缘区间。` +
        `换一个随机种子/多一个样本就可能翻面，不宜按「显著」下强结论。`,
      { rule: "marginal_p", pValues: marginal },
    );
  }

  // ④ 结论强度超过数据支撑：强因果/普适断言 + 弱证据基础。
  const overclaims = OVERCLAIM_PATTERNS.filter((p) => p.test(card.claim)).map((p) => p.source);
  if (overclaims.length > 0) {
    const usable = resolved.filter((r) => r.ok);
    const weak: string[] = [];
    if (minSample !== null && minSample < SMALL_SAMPLE_THRESHOLD) weak.push(`样本量 n=${minSample}`);
    if (usable.length <= 1) weak.push(`只有 ${usable.length} 条 observation 支撑`);
    if (usable.some((r) => r.simulated)) weak.push("证据来自模拟执行");
    if (marginal.length > 0) weak.push("p 值处于边缘区间");
    if (weak.length > 0) {
      soft(
        `overclaim_vs_evidence (启发式): claim 里出现因果/普适性断言，但证据基础偏弱（${weak.join("；")}）。` +
          `建议把措辞降到「与…一致」「在本条件下观察到…」。`,
        { rule: "overclaim", patterns: overclaims, weakness: weak },
      );
    }
  }

  return { findings, signals };
}
