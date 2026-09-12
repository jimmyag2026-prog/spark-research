import { createHash } from "node:crypto";
import { LineageGraph } from "../artifacts/lineage.ts";
import type { ArtifactVersion, ExecutionRecord } from "../artifacts/models.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import type { FindingHit, FindingsStore, FindingTarget } from "./findings_store.ts";
import type { CitationBaseline, CitationJudge, Finding, ReviewResult } from "./rules.ts";
import {
  CITATION_RULE,
  artifactLocation,
  citationIntegrity,
  findProducingCell,
  hasClaim,
  isFigureOrReport,
  lineageFindings,
} from "./rules.ts";

export const ALLOWED_TOOLS = [
  "read_frames",
  "read_artifacts",
  "read_lineage",
  "scoped_query",
] as const;

export const DISABLED_TOOLS = [
  "python",
  "r",
  "bash",
  "plan",
  "delegate",
  "web_search",
  "write_artifact",
  "edit_file",
] as const;

// P3：引用真实性检查的接入配置。不注入时 ReviewerAgent 行为与 P1/P2 完全一致。
export interface CitationCheckConfig {
  // 库内全部可用 bibtex key（真源：libraryKeyIndex(library.list()).keys）
  knownKeys: Iterable<string>;
  // key → 精读卡对照基准；缺省则只做「key 是否在库」与强断言检查
  baselines?: Map<string, CitationBaseline>;
  judge?: CitationJudge;
}

// v0.4 W3-c：接 findings_store（W1-b 交付，本文件只读复用）的配置。不注入时 review() 行为
// 与接线之前完全一致（findings 不落库）——与 CitationCheckConfig 同一套「caller 显式配好才
// 生效」的口径。store/project 由调用方构造好传入：ReviewerAgent 不知道自己跑在哪个 project
// 目录下（构造它的三个参数 store/executionLog/graph 都不带 project 身份），这层身份必须由
// 调用方补上，见 docs/devlog/W3-c.md「production wiring 的现状」一节。
export interface FindingsWiringConfig {
  store: FindingsStore;
  project: string;
  // 缺省用 review(sessionId) 的 sessionId——多数调用方两者本来就是同一个值。
  session?: string | null;
}

export interface ReviewerOptions {
  citations?: CitationCheckConfig;
  findings?: FindingsWiringConfig;
}

// review() 内部三个检查方法各自的 checker id——用于 findings_store 的
// (checker, target, fingerprint) 去重键。citation-integrity 的 checker id 复用
// CITATION_RULE（rules.ts 已经把这个字符串刻在每条 finding 的 `rule` 字段里，这里保持
// 同源，不另起一个名字）。traceability/lineage 两个检查器目前不往 Finding.rule 写值
// （见 rules.ts checkTraceability/lineageFindings 的输出），所以这两个 id 只存在于
// agent.ts 这一层，不从 finding 本身读。
const TRACEABILITY_CHECKER = "traceability";
const LINEAGE_CHECKER = "lineage";

// V14：位置加权豁免白名单。
//
// 旧写法（`applyLocationWeight` 内联 `if (f.rule === CITATION_RULE) return f;`）把「哪些
// 规则不参与位置加权」这件事藏在一条个例判断里——豁免名单只存在于调用路径的隐式对比中，
// 读代码的人（以及未来加新规则的人）看不出这是一份需要维护的清单，也没有地方写「为什么
// 豁免」。显式化成列表 + 逐条注释理由，豁免范围之外的规则一律加权（这与旧行为完全一致，
// 只是把隐式判断变成显式数据）。
// export：给 tests/unit/w8_delta_location_weight.test.ts 的阴性对照③用——直接对真实
// 白名单对象 `.clear()` 再恢复，跑一遍真实 ReviewerAgent.review()，而不是在测试里另写
// 一份重复的判定逻辑（那样测的是测试自己的实现，不是产品代码）。
export const LOCATION_WEIGHT_EXEMPT: Set<string> = new Set([
  // citation-integrity：严重度由规则自身定义——hard=伪造引用（库外 key），
  // soft=推断类提示（judge 判冲突、强断言无引用）。这三条的分级已经是规则自己
  // 权衡过的结论，「figure/report 里 soft 升 hard」这条位置加权规则会把 soft
  // 提示错杀成 veto，与 rules.ts citationIntegrity 头部注释里写明的分级口径直接冲突
  // （见 rules.ts 第 59–67 行）。
  CITATION_RULE,
]);

// 一次「针对某个 (checker, artifact) 的检查是否真的跑过」的记录——即便这一轮零命中，
// 只要检查真的跑了，也要报给 findings_store 一次「hits=[]」，否则上一轮报的问题在这一轮
// 被修好之后永远停在 open（reviewTarget 的 resolve 分支需要看到「这一轮查过、确实不在了」
// 才会把状态转成 resolved——不调用就等于「这一轮没查」，语义完全不同）。
// citation-integrity 检查在没配置 CitationCheckConfig 或 artifact 不是 markdown 时
// **不会跑**（checkCitations 直接返回 []），这种「跳过」不能和「跑了、零命中」混为一谈，
// 否则会把从未真正复核过的 citation finding 误判成 resolved——这也是本文件唯一需要
// 用「有没有跑」而不是「有没有命中」来判断该不该调用 reviewTarget 的地方。
interface CheckAttempt {
  checker: string;
  target: FindingTarget;
  findings: Finding[];
}

// ── fingerprint 设计 ─────────────────────────────────────────────────────────
// 目标：识别「同一个问题跨轮复现」，但不能因为无关的措辞变化就认成新问题。
// Finding 类型（rules.ts，本文件只读）没有 fingerprint 字段——W1-b 的 devlog 早就点明这是
// 接线时需要设计的一部分，见 docs/devlog/W1-b.md §7。
//
// 唯一真正会有「无关措辞变化」的地方是 citation-integrity 的 LLM judge：
// citation_conflict 这类 finding 的 detail.reason / message 都嵌了 judge 给的自然语言
// 理由，同一个冲突换一轮跑，judge 的措辞几乎不可能字字相同；judge_unavailable 的
// message/detail 还带着 judgeErrors/judgedCount 计数，这两个数字会因为「这一轮哪几条引用
// 抢到判定窗口」而抖动，不代表问题本身变了。这两类如果直接拿 message 整段做 fingerprint，
// 每一轮都会被判成「新问题」，去重与复核闭环全部失效——这正是任务书点名要求的阴性对照③。
//
// 其余两类 citation finding（unknown_citation / unsupported_claim）和 traceability/lineage
// 两个检查器完全没有 LLM 参与，message 是纯程序拼接、结构化 detail 里也没有自由文本，
// 直接用 message 做身份是安全的。
//
// 于是分两条路径：
//   citation-integrity：按 detail 的字段组合识别 finding 的「kind」（不解析 message 文案，
//     因为 message 本身就嵌了要排除的 reason），身份取「结构化、不随 judge 措辞变化」的
//     那部分字段；citation_conflict 显式排除 detail.reason，judge_unavailable 显式排除
//     judgeErrors/judgedCount 两个计数，只保留固定字面量。
//   其余 checker：message 全文本身就是确定性程序输出，直接用作身份。
export function citationFindingIdentity(finding: Finding): string {
  const detail = (finding.detail ?? {}) as Record<string, unknown>;
  if ("key" in detail && "sentence" in detail && "reason" in detail) {
    // citation_conflict（rules.ts citationIntegrity 第②段）：身份 = key + 陈述所在的句子。
    // reason 是 judge 给的自然语言理由，同一个冲突换一轮跑几乎不可能字字相同，故意不进身份。
    return `citation_conflict ${String(detail.key)} ${String(detail.sentence)}`;
  }
  if ("key" in detail && "sentenceIndex" in detail) {
    // unknown_citation（第①段）：身份 = key 本身。同一个库外 key 不管在文中出现几次、
    // 句子怎么改写，都是同一个「这个 key 不在库里」的问题；sentenceIndex 不进身份，
    // 避免文档其他地方的无关编辑把 sentenceIndex 顶下去、被误判成新问题。
    return `unknown_citation ${String(detail.key)}`;
  }
  if ("sentence" in detail && "sentenceIndex" in detail) {
    // unsupported_claim（第③段）：身份 = 句子原文，同样不含 sentenceIndex。
    return `unsupported_claim ${String(detail.sentence)}`;
  }
  if ("judgeErrors" in detail && "judgedCount" in detail) {
    // judge_unavailable（第②段末尾）：固定身份，不含具体计数——「判定器这轮挂了」本身才是
    // 要跟踪的问题，挂了几条是随机的，不该让每一轮的计数差异都生成一条新 finding。
    return "citation_judge_unavailable";
  }
  // 未识别的 detail 形状（未来新增的 citation finding kind 忘了在这里补一条时的保底）：
  // 退到 message 冒号前的 kind 标签（"unknown_citation: ..." 的 "unknown_citation" 部分），
  // 不用整条 message——冒号后的文案里可能仍然嵌了 judge 措辞，保守起见只取标签。
  return `unrecognized ${finding.message.split(":")[0]?.trim() ?? finding.message}`;
}

export function computeFingerprint(checker: string, finding: Finding): string {
  const identity = checker === CITATION_RULE ? citationFindingIdentity(finding) : finding.message;
  return createHash("sha256").update(`${checker} ${identity}`).digest("hex").slice(0, 16);
}

export class ReviewerAgent {
  static readonly ALLOWED_TOOLS = ALLOWED_TOOLS;
  static readonly DISABLED_TOOLS = DISABLED_TOOLS;

  private options: ReviewerOptions;

  constructor(
    private store: ArtifactStore,
    private executionLog: ExecutionRecord[],
    private graph: LineageGraph,
    options: ReviewerOptions = {},
  ) {
    this.options = options;
  }

  async review(sessionId: string): Promise<ReviewResult> {
    const artifacts = await this.store.listBySession(sessionId);
    const findings: Finding[] = [];
    // 每个 (checker, artifact) 只要真的跑过检查（不论命不命中）就记一条 attempt——
    // recordFindings() 用它来决定该不该调用 reviewTarget（见 CheckAttempt 的注释）。
    const attempts: CheckAttempt[] = [];

    for (const artifact of artifacts) {
      const target: FindingTarget = { kind: "artifact", id: artifact.id };

      const traceability = this.applyLocationWeight(this.checkTraceability(artifact), [artifact]);
      findings.push(...traceability);
      attempts.push({ checker: TRACEABILITY_CHECKER, target, findings: traceability });

      const lineage = this.applyLocationWeight(this.checkLineage(artifact), [artifact]);
      findings.push(...lineage);
      attempts.push({ checker: LINEAGE_CHECKER, target, findings: lineage });

      const citations = await this.checkCitations(artifact);
      if (citations.ran) {
        // applyLocationWeight 对 CITATION_RULE 的 finding 原样透传（不受位置加权影响，
        // 理由见该方法内注释），这里照样过一遍只是为了跟另外两个检查器走同一条代码路径，
        // 不会改变结果。
        const weighted = this.applyLocationWeight(citations.findings, [artifact]);
        findings.push(...weighted);
        attempts.push({ checker: CITATION_RULE, target, findings: weighted });
      }
    }

    const hard = findings.filter((f) => f.severity === "hard");

    this.recordFindings(sessionId, attempts);

    if (hard.length > 0) {
      return {
        approved: false,
        findings,
        action: "inject_notice_and_veto_completion",
        notice: `Review vetoed: ${hard.length} hard finding(s) found. Findings injected; completion blocked.`,
      };
    }
    return { approved: true, findings };
  }

  // v0.4 W3-c：把这一轮实际跑过的每个 (checker, artifact) upsert 进 findings_store——
  // 这是 findings 状态机（W1-b 交付）在本仓库唯一的生产写入方。`this.options.findings`
  // 未配置时整段是 no-op，行为与接线之前完全一致（见 FindingsWiringConfig 的注释）。
  private recordFindings(sessionId: string, attempts: CheckAttempt[]): void {
    const wiring = this.options.findings;
    if (!wiring) return;
    for (const attempt of attempts) {
      const hits: FindingHit[] = attempt.findings.map((f) => ({
        severity: f.severity,
        fingerprint: computeFingerprint(attempt.checker, f),
        evidence: f.message,
      }));
      wiring.store.reviewTarget({
        project: wiring.project,
        session: wiring.session ?? sessionId,
        target: attempt.target,
        checker: attempt.checker,
        hits,
      });
    }
  }

  private checkTraceability(artifact: ArtifactVersion): Finding[] {
    if (!hasClaim(artifact)) return [];
    if (findProducingCell(artifact, this.executionLog)) return [];
    return [
      {
        severity: "hard",
        artifactId: artifact.id,
        message: `unverifiable claim: artifact ${artifact.filename} 包含代码声明但未找到产生它的 cell`,
        location: artifactLocation(artifact),
      },
    ];
  }

  private checkLineage(artifact: ArtifactVersion): Finding[] {
    const conflicts = this.graph.hasVersionConflicts(artifact.id);
    return lineageFindings(artifact, conflicts);
  }

  // 只对 markdown 类 artifact 跑引用核验（综述草稿、报告）。`ran=false` 的三种情形
  // （没配置 CitationCheckConfig / 不是 markdown / artifact 查不到内容）都是「没有真的
  // 检查」，不是「检查了、零命中」——调用方（review()/recordFindings()）靠这个区分来
  // 决定该不该拿这一轮的结果去 resolve 上一轮报过的 citation finding，见 CheckAttempt
  // 的注释：跳过检查时绝不能把历史 finding 误判成已解决。
  private async checkCitations(artifact: ArtifactVersion): Promise<{ ran: boolean; findings: Finding[] }> {
    const config = this.options.citations;
    if (!config || artifact.contentType !== "text/markdown") return { ran: false, findings: [] };
    const stored = this.store.get(artifact.id);
    if (!stored) return { ran: false, findings: [] };
    const result = await citationIntegrity({
      draft: stored.content,
      knownKeys: config.knownKeys,
      baselines: config.baselines,
      judge: config.judge,
      artifactId: artifact.id,
      location: artifactLocation(artifact),
    });
    return { ran: true, findings: result.findings };
  }

  private applyLocationWeight(findings: Finding[], artifacts: ArtifactVersion[]): Finding[] {
    return findings.map((f) => {
      // 白名单命中 → 原样透传，不参与位置加权。见上面 LOCATION_WEIGHT_EXEMPT 的注释。
      if (f.rule && LOCATION_WEIGHT_EXEMPT.has(f.rule)) return f;
      const artifact = artifacts.find((a) => a.id === f.artifactId);
      if (!artifact || !isFigureOrReport(artifact)) return f;
      if (f.severity === "soft") {
        return { ...f, severity: "hard" };
      }
      return f;
    });
  }
}
