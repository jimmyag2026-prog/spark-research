// Research Contract（v0.4 P13 波次 W2-b，AD-10）。
//
// 洞察不是新的（OpenScience 已经有 `contract.stages.every(status === 'completed')` 这个
// 形），新的是**判据从哪来**：OpenScience 的 stage `completed` 由 agent 自报；
// Claude Science 是状态机驱动，但判据仍然在模型侧。两者共享同一个洞——agent 可以宣布
// 自己完成了。
//
// spark 有证据图（`project/records.ts` 的 RecordStore：8 类 record + 5 类边），所以可以
// 做得更硬：**完成判定是对证据图的一次确定性查询，不问模型**。这条落实在类型层面——
// `ContractStage.check()` 的签名只接受 `EvidenceQuery`，没有任何参数能装下模型的自我
// 报告。想让 check() 误判「完成」，唯一的办法是在证据图里真的造出对应的 record；
// 换句话说，伪造完成的成本被抬高到了「伪造证据」的水平，而不是「说一句谎话」的水平。
//
// 本文件只做「契约怎么判」这一件事，不做「谁来跑轮次循环」——观察反馈循环（planner/
// execute/distill）与预算判据的接线权在 W3-a（replan 循环），见文件末尾的
// ALLOWED_ORPHANS 登记与 devlog 的交接说明。

import type { EdgeType, RecordType, ResearchRecord } from "../project/models";
import type { RecordStore } from "../project/records";
import { CITATION_RULE } from "../reviewer/rules";

// ── 契约契约本身（DEVELOPMENT_PLAN_v0.4.md §4.3 / v0.3 §4.3.1 的原始设计） ──────────

export interface StageStatus {
  done: boolean;
  /** 凭什么说完成了——具体的 record id，必须能在证据图里查到，不是一句断言。 */
  evidence: string[];
  /** 人话：完成了写清楚基于什么，没完成写清楚缺什么。 */
  reason: string;
}

export interface ContractStage {
  id: string;
  description: string;
  /**
   * 完成判据：零 IO 之外只读证据图的纯查询。**不接受模型输入**——签名里没有
   * 承载「模型说它完成了」的参数，这不是约定，是类型系统层面的硬约束。
   */
  check(q: EvidenceQuery): StageStatus;
}

export interface ContractStageReport extends StageStatus {
  id: string;
  description: string;
}

export interface ContractReport {
  contractId: string;
  allDone: boolean;
  stages: ContractStageReport[];
  /** 未完成的 stage 子集，供调用方（CLI / replan / UI）直接渲染，不必自己再 filter 一遍。 */
  incomplete: ContractStageReport[];
  /** 给人看的完整文案——「报告未完成时要说人话」的落实处。 */
  summary: string;
}

function describeReport(contractId: string, stages: ContractStageReport[], incomplete: ContractStageReport[]): string {
  if (incomplete.length === 0) {
    const proof = stages.map((s) => `${s.id}（证据 ${s.evidence.length} 条）`).join("、");
    return `契约 '${contractId}' 全部 ${stages.length} 个 stage 已完成：${proof}`;
  }
  const lines = incomplete.map((s) => `  - ${s.id}（${s.description}）未完成：${s.reason}`);
  return [
    `契约 '${contractId}' 未完成，${incomplete.length}/${stages.length} 个 stage 缺证据：`,
    ...lines,
  ].join("\n");
}

// 契约 = 一组 stage 的容器 + 「全部完成」判定。不持有轮次状态（round/plan/observation
// 属于观察反馈循环，那是 W3-a 的职责），只负责「现在这一刻，对着证据图，各 stage 判成
// 什么」。
export class ResearchContract {
  constructor(
    readonly id: string,
    private readonly stageDefs: readonly ContractStage[],
  ) {
    if (stageDefs.length === 0) {
      throw new Error(`ResearchContract '${id}': 至少需要一个 stage`);
    }
    const ids = new Set(stageDefs.map((s) => s.id));
    if (ids.size !== stageDefs.length) {
      throw new Error(`ResearchContract '${id}': stage id 有重复`);
    }
  }

  get stages(): readonly ContractStage[] {
    return this.stageDefs;
  }

  /** 对证据图跑一遍全部 stage 的 check()，返回可直接渲染的报告。 */
  evaluate(q: EvidenceQuery): ContractReport {
    const stages = this.stageDefs.map((stage) => {
      const status = stage.check(q);
      return { id: stage.id, description: stage.description, ...status };
    });
    const incomplete = stages.filter((s) => !s.done);
    const allDone = incomplete.length === 0;
    return { contractId: this.id, allDone, stages, incomplete, summary: describeReport(this.id, stages, incomplete) };
  }

  /** 正常完成的停机条件——三条并行停机条件之一。 */
  allDone(q: EvidenceQuery): boolean {
    return this.evaluate(q).allDone;
  }
}

// ── EvidenceQuery：ContractStage.check() 唯一允许接触证据图的窗口 ──────────────────
//
// 刻意只暴露只读方法，不暴露 RecordStore 的 create/update/link——check() 想顺手写图，
// 这层接口在类型系统里就没给它开口子。基于现有 RecordStore（project/records.ts，
// 只读参考，不改它），不新增表、不碰 rev/integrityHash（那是写入路径的并发控制，
// 本文件从头到尾没有一次写操作）。

export interface EvidenceSnapshot {
  readonly recordIds: ReadonlySet<string>;
}

export interface EvidenceQuery {
  /** 当前证据图的全量 record id 快照——noProgress 判据的唯一输入。 */
  snapshot(): EvidenceSnapshot;
  /** baseline 之后新增的 record（按 id 集合差，不按时间戳——见 NoProgressGuard 的注释）。 */
  newSince(baseline: EvidenceSnapshot, type?: RecordType | RecordType[]): ResearchRecord[];
  /** 按类型列出 record，可选再叠一层谓词（在 metadata 上做结构化判断）。 */
  listByType(type: RecordType | RecordType[], predicate?: (r: ResearchRecord) => boolean): ResearchRecord[];
  get(id: string): ResearchRecord | null;
  /** 指向 id 的入边对端 record（谁 --edgeType--> id）。 */
  incoming(id: string, type?: EdgeType): ResearchRecord[];
  /** id 指出去的出边对端 record（id --edgeType--> 谁）。 */
  outgoing(id: string, type?: EdgeType): ResearchRecord[];
}

// RecordStore 的窄口包装：只转发只读方法。构造参数用 Pick 而不是整个 RecordStore，
// 是为了在类型层面同样体现「这里不该有写权限」——测试里想传一个只实现了这三个方法的
// 假对象也完全合法。
type ReadableRecordStore = Pick<RecordStore, "list" | "get" | "edgesOf">;

export class RecordStoreEvidenceQuery implements EvidenceQuery {
  constructor(private readonly store: ReadableRecordStore) {}

  snapshot(): EvidenceSnapshot {
    return { recordIds: new Set(this.store.list().map((r) => r.id)) };
  }

  newSince(baseline: EvidenceSnapshot, type?: RecordType | RecordType[]): ResearchRecord[] {
    const records = type ? this.store.list({ type }) : this.store.list();
    return records.filter((r) => !baseline.recordIds.has(r.id));
  }

  listByType(type: RecordType | RecordType[], predicate?: (r: ResearchRecord) => boolean): ResearchRecord[] {
    const records = this.store.list({ type });
    return predicate ? records.filter(predicate) : records;
  }

  get(id: string): ResearchRecord | null {
    return this.store.get(id);
  }

  incoming(id: string, type?: EdgeType): ResearchRecord[] {
    const { incoming } = this.store.edgesOf(id);
    return incoming
      .filter((e) => !type || e.type === type)
      .map((e) => this.store.get(e.sourceId))
      .filter((r): r is ResearchRecord => r !== null);
  }

  outgoing(id: string, type?: EdgeType): ResearchRecord[] {
    const { outgoing } = this.store.edgesOf(id);
    return outgoing
      .filter((e) => !type || e.type === type)
      .map((e) => this.store.get(e.targetId))
      .filter((r): r is ResearchRecord => r !== null);
  }
}

// ── 三条并行停机条件之二：noProgress ────────────────────────────────────────────
//
// 判据必须确定性：比较两次快照的 record id 集合，不看时间戳（避免同毫秒/时钟精度问题，
// 见 records.ts 用 rowid 兜底排序的同类考量），更不问模型「你觉得还有进展吗」。
//
// 语义：「连续 n 轮证据图无新增节点」= 最近 n 次 tick() 里，每一次相对于**上一次**
// 都没有新增任何 record id（滚动比较，不是都对着最初的起点比）。这与「累计 n 轮下来
// 一个新节点都没有」在数学上等价——如果任何一轮有新增，streak 归零重新计数。

export interface NoProgressState {
  /** 连续无新增 record 的轮数（含本轮）。 */
  streak: number;
  /** streak 达到阈值——本轮应当触发停机。 */
  triggered: boolean;
  /** 本轮新增的 record 数量（诊断用，不参与判据本身）。 */
  addedRecordCount: number;
  addedRecordIds: string[];
}

function diffIds(prev: EvidenceSnapshot, curr: EvidenceSnapshot): string[] {
  const out: string[] = [];
  for (const id of curr.recordIds) {
    if (!prev.recordIds.has(id)) out.push(id);
  }
  return out;
}

export class NoProgressGuard {
  private prev: EvidenceSnapshot;
  private streak = 0;

  /**
   * @param initial 起始快照（循环开始前、第一轮 execute 之前的证据图状态）。
   * @param threshold 触发停机所需的连续无进展轮数，必须 >= 1。
   */
  constructor(initial: EvidenceSnapshot, private readonly threshold: number) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(`NoProgressGuard: threshold 必须是 >=1 的整数，收到 ${threshold}`);
    }
    this.prev = initial;
  }

  /** 每轮 execute 结束后调用一次，传入这一轮结束时的快照。 */
  tick(snapshot: EvidenceSnapshot): NoProgressState {
    const addedRecordIds = diffIds(this.prev, snapshot);
    this.streak = addedRecordIds.length === 0 ? this.streak + 1 : 0;
    this.prev = snapshot;
    return {
      streak: this.streak,
      triggered: this.streak >= this.threshold,
      addedRecordCount: addedRecordIds.length,
      addedRecordIds,
    };
  }
}

// ── 三条并行停机条件的汇总 ──────────────────────────────────────────────────────
//
// "budget" 耗尽的判据不在本文件：预算状态（已花了多少、上限多少）由调用方（W3-a 的
// replan 循环）持有，本文件只需要保证 StopReason 里有这个值可用、调用方能把它塞进同一套
// 汇报文案——这是任务书里「预算耗尽 → 由调用方处理（你只需保证接口能表达）」的落实。

export type StopReason = "done" | "no_progress" | "budget";

export interface RoundEvaluation {
  report: ContractReport;
  noProgress: NoProgressState;
  /** null = 这一轮还没有停机理由，循环应当继续。 */
  stopReason: StopReason | null;
}

/**
 * 一轮循环结束后调用一次：先看契约是否已经正常完成（`allDone` 优先——哪怕这一轮同时
 * 满足「无新增」，也应该报「正常完成」，不该把一次成功的收官误报成「被迫停下」），
 * 否则再看 noProgress 是否触发。都没触发则 stopReason 为 null，循环继续。
 */
export function evaluateRound(contract: ResearchContract, guard: NoProgressGuard, q: EvidenceQuery): RoundEvaluation {
  const report = contract.evaluate(q);
  const noProgress = guard.tick(q.snapshot());
  const stopReason: StopReason | null = report.allDone ? "done" : noProgress.triggered ? "no_progress" : null;
  return { report, noProgress, stopReason };
}

/** 停机时给人看的话——不是一句「未完成」，而是哪些 stage 缺什么证据。 */
export function describeStop(contractId: string, evaluation: RoundEvaluation): string {
  if (evaluation.stopReason === "done") {
    return `契约 '${contractId}' 已完成：${evaluation.report.summary}`;
  }
  if (evaluation.stopReason === "no_progress") {
    return [
      `契约 '${contractId}' 因连续 ${evaluation.noProgress.streak} 轮证据图无新增节点而停止` +
        `（未完成，不是假装完成——宁可如实报告，不烧钱空转）。`,
      evaluation.report.summary,
    ].join("\n");
  }
  // stopReason === null：循环仍在进行中，调用这个函数多半是想提前看一眼当前状态。
  return evaluation.report.summary;
}

// ── literature-review：至少一个真实契约 ─────────────────────────────────────────
//
// | stage | 确定性判据 |
// |---|---|
// | searched | 本 session（= 契约创建那一刻之后）新增 paper record ≥ 1 |
// | read_cards | 项目里每一篇 paper record 都有 >=1 条 reading record 通过 `cites` 边指向它 |
// | citations_verified | 存在 metadata.kind = CITATION_INTEGRITY_REVIEW_KIND 的 observation
// |   record，且**最近一次**核验的 hardFindingCount === 0 |
//
// citations_verified 依赖的 record 约定目前**没有生产者**：literature/cli.ts 的
// `lit review` 命令会跑 citation-integrity（reviewer/rules.ts 的 CITATION_RULE），但只把
// 结果打印到 stdout / 影响退出码，不落证据图。这是本 lane 交付时的已知缺口，不在
// W2-b 的文件所有权范围内（literature/** 不归本 lane 所有）——详见 devlog 的交接说明。
// 本文件先把「该record 长什么样、check() 怎么判」钉死，产出侧由后续 lane 接上即可，
// 不需要再回来改这个判据。

export const CITATION_INTEGRITY_REVIEW_KIND = "citation-integrity-review";

export interface CitationIntegrityReviewMetadata {
  kind: typeof CITATION_INTEGRITY_REVIEW_KIND;
  /** 与 reviewer/rules.ts 的 CITATION_RULE 同值（"citation-integrity"），重复记一份便于查询侧不依赖 import。 */
  checker: typeof CITATION_RULE;
  /** 被核验的目标 record id（通常是综述草稿的 artifact record）。 */
  targetRecordId: string;
  hardFindingCount: number;
  softFindingCount: number;
}

export interface LiteratureReviewContractOptions {
  /** 契约起点快照；不传则取创建这一刻的 q.snapshot()（"本 session" 从此刻算起）。 */
  baseline?: EvidenceSnapshot;
}

export function createLiteratureReviewContract(
  q: EvidenceQuery,
  options: LiteratureReviewContractOptions = {},
): ResearchContract {
  const baseline = options.baseline ?? q.snapshot();

  const searched: ContractStage = {
    id: "searched",
    description: "本 session 新增 paper record ≥ 1（完成了检索）",
    check(query) {
      const newPapers = query.newSince(baseline, "paper");
      const done = newPapers.length >= 1;
      return {
        done,
        evidence: newPapers.map((r) => r.id),
        reason: done
          ? `本 session 新增 ${newPapers.length} 条 paper record`
          : "本 session 尚未新增任何 paper record（检索还没做，或做了但没有入库）",
      };
    },
  };

  const readCards: ContractStage = {
    id: "read_cards",
    description: "进入综述的每篇 paper 都有对应的 reading record（精读卡覆盖率 = 100%）",
    check(query) {
      const papers = query.listByType("paper");
      if (papers.length === 0) {
        return { done: false, evidence: [], reason: "项目里还没有任何 paper record，无法判定精读卡覆盖率" };
      }
      const missing: string[] = [];
      const evidence: string[] = [];
      for (const paper of papers) {
        const readers = query.incoming(paper.id, "cites").filter((r) => r.type === "reading");
        if (readers.length > 0) {
          evidence.push(...readers.map((r) => r.id));
        } else {
          missing.push(paper.id);
        }
      }
      const done = missing.length === 0;
      return {
        done,
        evidence,
        reason: done
          ? `全部 ${papers.length} 篇 paper 都有精读卡覆盖`
          : `${missing.length}/${papers.length} 篇 paper 还没有精读卡：${missing.join(", ")}`,
      };
    },
  };

  const citationsVerified: ContractStage = {
    id: "citations_verified",
    description: "存在 citation-integrity 的 review 记录，且最近一次核验零 hard finding",
    check(query) {
      const reviews = query
        .listByType("observation", (r) => (r.metadata as Partial<CitationIntegrityReviewMetadata>).kind === CITATION_INTEGRITY_REVIEW_KIND)
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      if (reviews.length === 0) {
        return { done: false, evidence: [], reason: "还没有 citation-integrity 的 review 记录（引用核验没跑过）" };
      }
      const latest = reviews[reviews.length - 1]!;
      const meta = latest.metadata as Partial<CitationIntegrityReviewMetadata>;
      const hardCount = meta.hardFindingCount;
      if (typeof hardCount !== "number" || !Number.isFinite(hardCount)) {
        return {
          done: false,
          evidence: [],
          reason: `record ${latest.id} 的 hardFindingCount 字段缺失或非法，无法判定`,
        };
      }
      const done = hardCount === 0;
      return {
        done,
        evidence: done ? [latest.id] : [],
        reason: done
          ? `最近一次 citation-integrity 核验（record ${latest.id}）零 hard finding`
          : `最近一次 citation-integrity 核验（record ${latest.id}）仍有 ${hardCount} 条 hard finding 未清零`,
      };
    },
  };

  return new ResearchContract("literature-review", [searched, readCards, citationsVerified]);
}
