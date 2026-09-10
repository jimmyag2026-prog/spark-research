import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store";
import { mergePapers } from "../literature/dedupe";
import { assignBibtexKeys, libraryKeyIndex } from "../literature/export";
import type { LibraryPaper, LibraryStore } from "../literature/library";
import { DEFAULT_SEARCH_SOURCES, titleKey, type LiteratureSource, type Paper } from "../literature/models";
import { extractJsonObject } from "../literature/reading";
import type { LiteratureSearcher, SourceStatus } from "../literature/search";
import type { ChatMessage, LLMRouter } from "../llm/router";
import type { RecordStore } from "../project/records";
import { citationIntegrity, type CitationIntegrityResult, type CitationJudge } from "../reviewer/rules";
import { EmbeddingRouter } from "../llm/embeddings/router";
import { isCalibrated, semanticHighAffinity, type SemanticThreshold } from "../llm/embeddings/calibration";
import { cosine } from "../llm/embeddings/types";
import { claimAffinity, paperEmbedText, paperIdentity } from "./affinity";
import {
  NOVELTY_RATINGS,
  NOVELTY_REPORT_KIND,
  ideaTitle,
  statusFromRatings,
  type NoveltyRating,
  type NoveltyStatus,
  type StoredIdeaCard,
} from "./models";
import { IdeaStore } from "./store";

// Novelty check pipeline（DESIGN 域 D1）：
//   ① claim 提取（LLM + schema）
//   ② 密集检索（每条 claim 2-3 个检索式 → P2 统一检索）
//   ③ 对比报告（逐 claim：最近邻 + 相同点 + 不同点 + 评级）
//   ④ 评级校验层（**确定性代码**，见 constrainRating）
//   ⑤ 引用核验（复用 P3 citationIntegrity）
//   ⑥ 回写：idea 的 novelty 状态 + 报告 artifact/record + derives_from 边
//
// 第 ④ 步是本阶段的重点。没有它，「新颖性评级」就等于让模型给自己的想法打分——
// 模型说 novel 就 novel，检索结果只是装饰。评级校验层用检索结果的**可计算特征**
// （候选相似度）去约束模型的结论：说 existing 就得指出那条高相似的工作，
// 说 novel 就得先给出最近邻，而且不许在明明有高相似候选时说 novel。

export const MAX_CLAIMS = 5;
export const MIN_QUERIES_PER_CLAIM = 2;
export const MAX_QUERIES_PER_CLAIM = 3;
// 「高相似候选」的门槛：候选的标题+摘要要覆盖 claim（或它某条检索式）足够多的内容词。
//
// **v0.5 W5-1 收口重标定：0.75 → 0.70。** 原值是 P4 在**2 条样本**上定的；
// W5-1 β 为标定语义阈值录了一份 68 样本的真实语料（`tests/fixtures/novelty/calibration.json`，
// 论文全部来自 P2/P4 真实录制的检索响应），顺带量出 0.75 连自己的最优区间都不在。
//
// 在那份语料上用生产函数 `claimAffinity()` 扫阈值：
//   0.75  → 错分 2：假阴 1（e07 → adversarial-mutations，0.714）+ 假阳 1（h01 → attend-and-diagnose，0.857）
//   0.70  → 错分 1：假阴 0 + 假阳 1（**同一条**，那条降阈值修不掉——要修得把阈值抬到 0.857 以上，
//                    代价是大批假阴）
// 所以 0.70 严格优于 0.75。最优点其实是 0.714，但它正压在一个样本上、零余量；
// 0.70 落在最大负样本（0.667）与最小正样本（0.714）之间，两侧都有余量。
//
// **方向也是安全的那边**：阈值降低 → R5 更常触发 → 更多「novel」被降级为 existing。
// novelty checker 宁可错说「已存在」（用户一看就能反驳），也不该错发一张新颖性通行证。
//
// 这个值**不许再当魔数改**：`tests/unit/novelty_threshold.test.ts` 在同一份语料上
// 用生产函数重算最优区间并断言 HIGH_AFFINITY 落在里面。改了 `affinity.ts` 的打分规则
// 而没重标定，那条测试会当场变红。
//
// 注意这是**词面覆盖率**不是语义相似度：它会把用词高度重合的邻近工作 judge 得偏高，
// 所以它只用来做「不许在有高相似候选时说 novel」这类**约束**，不用来直接下结论。
export const HIGH_AFFINITY = 0.7;

// v0.5 C4：**词面口径的阈值就到此为止**。语义口径（embedding 余弦）是完全不同的量纲，
// 阈值另标一套，登记在 `llm/embeddings/calibration.ts` 的 SEMANTIC_THRESHOLDS 里——
// 那里有实测分布与标定方法。把 0.75 套到余弦上会让确定性层的 R5 永不触发（实测最高正样本才 0.746）。

/** 相似度口径。语义口径只有在「模型已标定」时才会真的被用来做评级约束（K-4）。 */
export type AffinityBasis = "semantic" | "lexical";

export class NoveltyError extends Error {
  readonly validationErrors: string[];
  constructor(message: string, validationErrors: string[] = []) {
    super(`Novelty: ${message}`);
    this.name = "NoveltyError";
    this.validationErrors = validationErrors;
  }
}

// ── ① claim 提取 ────────────────────────────────────────────────────────────

export interface NoveltyClaim {
  id: string;
  statement: string;
  queries: string[];
}

export const CLAIM_SYSTEM_PROMPT = `你是科研创新性核验助手。给定一张 idea 卡，抽出其中**可检验的创新点陈述**（claim）。

只输出一个 JSON 对象，不要任何解释文字：
{
  "claims": [
    {
      "statement": "一条可检验的创新点陈述：谁 + 用什么方法 + 做什么 + 相对什么更好",
      "queries": ["英文检索式 1", "英文检索式 2"]
    }
  ]
}

纪律（违反即视为无效输出）：
- claim 必须是**可以被一篇已有论文证伪**的具体陈述。「本方法很有前景」不是 claim。
- 一张卡抽 1-${MAX_CLAIMS} 条，宁少勿滥：把同一件事换个说法拆成两条只会让报告变长。
- 每条 claim 给 ${MIN_QUERIES_PER_CLAIM}-${MAX_QUERIES_PER_CLAIM} 个检索式，**用英文**（主流文献库对中文查询召回极差），
  且要覆盖不同的措辞角度（方法名 / 任务名 / 机制描述），不要三条同义重复。
- 检索式是给文献检索引擎用的关键词串，不是自然语言问句，不要加引号或布尔算符。
- 不要把 idea 卡里没有的东西写进 claim。`;

export function buildClaimPrompt(idea: StoredIdeaCard): string {
  const evidence = [...idea.supporting, ...idea.contradicting]
    .map((e) => `- ${e.key ? `[@${e.key}]` : "（inferred）"} ${e.note}`)
    .join("\n");
  return [
    `假设陈述：${idea.hypothesis}`,
    "",
    `已有证据：\n${evidence || "- （无）"}`,
    "",
    `待验证点：\n${idea.openQuestions.map((q) => `- ${q}`).join("\n") || "- （无）"}`,
  ].join("\n");
}

export interface ClaimValidation {
  ok: boolean;
  errors: string[];
  claims: NoveltyClaim[];
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// claim id 由代码分配（c1..cN），不信任模型给的 id——重复/缺失的 id 会让整份报告错位。
export function validateClaimsPayload(payload: unknown): ClaimValidation {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["输出不是 JSON 对象"], claims: [] };
  }
  const raw = (payload as Record<string, unknown>).claims;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, errors: ["字段 'claims' 必须是至少 1 条的数组"], claims: [] };
  }
  if (raw.length > MAX_CLAIMS) {
    errors.push(`claims 超过上限 ${MAX_CLAIMS} 条（收到 ${raw.length} 条），请合并同义的创新点`);
  }
  const claims: NoveltyClaim[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`claims[${i}] 不是对象`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    if (!nonEmptyString(obj.statement)) {
      errors.push(`claims[${i}].statement 缺失或不是非空字符串`);
      return;
    }
    const queries = obj.queries;
    if (
      !Array.isArray(queries) ||
      queries.length < MIN_QUERIES_PER_CLAIM ||
      queries.length > MAX_QUERIES_PER_CLAIM ||
      !queries.every(nonEmptyString)
    ) {
      errors.push(
        `claims[${i}].queries 必须是 ${MIN_QUERIES_PER_CLAIM}-${MAX_QUERIES_PER_CLAIM} 条非空检索式的数组`,
      );
      return;
    }
    claims.push({
      id: `c${claims.length + 1}`,
      statement: (obj.statement as string).trim(),
      queries: (queries as string[]).map((q) => q.trim()),
    });
  });
  if (errors.length > 0) return { ok: false, errors, claims: [] };
  return { ok: true, errors: [], claims };
}

// ── ② 密集检索 ──────────────────────────────────────────────────────────────

export interface NoveltyCandidate {
  // 引用 key：库内论文用它在 P3 里的 bibtex key，库外候选按同一规则新分配。
  key: string;
  paper: Paper;
  // 与该 claim 的**词面**确定性相似度（affinity.ts 的内容词覆盖率），0~1。恒有值。
  affinity: number;
  // 与该 claim 的**语义**相似度（embedding 余弦），0~1。
  // null = 本次没有可用向量（未配置 embedding / 调用失败）——**不是 0**，
  // 0 是「算过了，确实不相似」，null 是「没算成」，两者绝不能混。
  semanticAffinity: number | null;
  // 本条候选在**评级约束**里按哪个口径计分。语义向量算出来了但模型未标定时，
  // 这里仍是 "lexical"：向量只在报告里作参考列，不参与约束（K-4）。
  affinityBasis: AffinityBasis;
  inLibrary: boolean;
  libraryPaperId: string | null;
  libraryRecordId: string | null;
  // 由哪几条检索式命中（同一篇被多条检索式命中是「确实相关」的弱信号）。
  queries: string[];
}

export interface ClaimRetrieval {
  claim: NoveltyClaim;
  candidates: NoveltyCandidate[];
  sources: SourceStatus[];
}

// 库外候选的 key 与库内 key 在**同一个序列**里分配：
// 库内论文排在前面，所以它们的 key 与 `lit export --format bibtex` 完全一致（P3 不受影响），
// 库外候选只可能拿到后缀更靠后的 key，不会把库内 key 顶掉。
export function assignCandidateKeys(
  libraryPapers: LibraryPaper[],
  externals: Paper[],
): { libraryKeys: string[]; externalKeys: string[] } {
  const all = assignBibtexKeys([...libraryPapers, ...externals]);
  return {
    libraryKeys: all.slice(0, libraryPapers.length),
    externalKeys: all.slice(libraryPapers.length),
  };
}

// ── ③ 对比报告（模型输出） ──────────────────────────────────────────────────

export interface NearestWork {
  key: string;
  sameness: string;
  difference: string;
}

export interface DeclaredAssessment {
  claimId: string;
  rating: NoveltyRating;
  nearestWorks: NearestWork[];
  verdict: string;
}

export const COMPARE_SYSTEM_PROMPT = `你是科研创新性核验助手。给定若干条创新点 claim，以及**本次真实检索**返回的候选工作，
逐条判断这个 claim 相对已有工作有多新。

只输出一个 JSON 对象，不要任何解释文字：
{
  "claims": [
    {
      "claimId": "c1",
      "rating": "novel" | "incremental" | "existing",
      "nearestWorks": [
        {"key": "候选清单里的 key", "sameness": "与该工作相同的部分", "difference": "与该工作不同的部分"}
      ],
      "verdict": "一句话结论"
    }
  ]
}

纪律（违反即视为无效输出）：
- key **只能**来自该 claim 的候选清单。不许引用清单之外的任何文献，包括你记得的经典论文——
  它没在这次检索里出现，就不能作为「已有工作」的证据。
- 每条 claim 至少给 1 条 nearestWorks，即使你认为它是全新的：**必须说清最接近的是什么**。
  「没有相关工作」不是结论，是没做功课。
- rating 口径：
  - existing = 已有工作实质上做过同一件事（此时必须把那条工作列进 nearestWorks）
  - incremental = 已有工作很接近，本 claim 只是改进/迁移/组合
  - novel = 检索范围内没有实质相同的工作，但仍要给出最近邻并说清差异
- sameness / difference 必须具体到方法或结论层面，不要写「都用了深度学习」这种废话。
- 不要凭记忆补全候选的结论；候选清单里没写的，就当它没说。`;

function candidateBlock(candidate: NoveltyCandidate): string {
  const paper = candidate.paper;
  const bits = [paper.year ?? "n.d.", paper.venue ?? "未知 venue"].join(", ");
  const gist = paper.abstract ? paper.abstract.replace(/\s+/g, " ").slice(0, 300) : "（无摘要）";
  const similarity =
    candidate.semanticAffinity !== null
      ? `词面相似度 ${candidate.affinity.toFixed(2)} · 语义相似度 ${candidate.semanticAffinity.toFixed(2)}`
      : `词面相似度 ${candidate.affinity.toFixed(2)}`;
  return (
    `- [@${candidate.key}] ${paper.title} (${bits})` +
    `${paper.doi ? ` doi:${paper.doi}` : ""} · ${similarity}` +
    `${candidate.inLibrary ? " · 已在项目文献库" : ""}\n  摘要: ${gist}`
  );
}

export function buildComparePrompt(retrievals: ClaimRetrieval[]): string {
  const blocks = retrievals.map((r) => {
    const list =
      r.candidates.length > 0
        ? r.candidates.map(candidateBlock).join("\n")
        : "（本次检索没有返回任何候选——不要因此判 novel，如实说明检索为空）";
    return [
      `### ${r.claim.id}: ${r.claim.statement}`,
      `检索式: ${r.claim.queries.map((q) => `"${q}"`).join(" / ")}`,
      "",
      `候选工作（共 ${r.candidates.length} 条，按相似度排序，只能引用这里的 key）:`,
      list,
    ].join("\n");
  });
  return blocks.join("\n\n");
}

export interface AssessmentValidation {
  ok: boolean;
  errors: string[];
  assessments: DeclaredAssessment[];
}

export function validateAssessmentPayload(
  payload: unknown,
  retrievals: ClaimRetrieval[],
): AssessmentValidation {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["输出不是 JSON 对象"], assessments: [] };
  }
  const raw = (payload as Record<string, unknown>).claims;
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["字段 'claims' 必须是数组"], assessments: [] };
  }
  const byId = new Map(retrievals.map((r) => [r.claim.id, r]));
  const seen = new Set<string>();
  const assessments: DeclaredAssessment[] = [];

  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`claims[${i}] 不是对象`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    const claimId = typeof obj.claimId === "string" ? obj.claimId.trim() : "";
    const retrieval = byId.get(claimId);
    if (!retrieval) {
      errors.push(`claims[${i}].claimId '${claimId}' 不是本次的 claim id`);
      return;
    }
    if (seen.has(claimId)) {
      errors.push(`claim '${claimId}' 被评了两次`);
      return;
    }
    seen.add(claimId);

    const rating = obj.rating as NoveltyRating;
    if (!NOVELTY_RATINGS.includes(rating)) {
      errors.push(`claims[${i}].rating '${String(obj.rating)}' 不是 ${NOVELTY_RATINGS.join("/")} 之一`);
      return;
    }
    if (!nonEmptyString(obj.verdict)) {
      errors.push(`claims[${i}].verdict 缺失或不是非空字符串`);
      return;
    }
    const works = obj.nearestWorks;
    if (!Array.isArray(works)) {
      errors.push(`claims[${i}].nearestWorks 必须是数组`);
      return;
    }
    const allowed = new Set(retrieval.candidates.map((c) => c.key));
    const nearest: NearestWork[] = [];
    works.forEach((work, j) => {
      if (!work || typeof work !== "object" || Array.isArray(work)) {
        errors.push(`claims[${i}].nearestWorks[${j}] 不是对象`);
        return;
      }
      const w = work as Record<string, unknown>;
      const key = typeof w.key === "string" ? w.key.trim().replace(/^\[?@?/, "").replace(/\]$/, "") : "";
      // 生成器这道闸的作用与 P3 综述的白名单一致：不生产已知带假引用的产物。
      // 兜底仍有 citationIntegrity（对任何来源的报告都重验一遍）。
      if (!allowed.has(key)) {
        errors.push(
          `claims[${i}].nearestWorks[${j}].key '${key}' 不在 ${claimId} 的候选清单里` +
            "（只能引用本次检索返回的工作）",
        );
        return;
      }
      if (!nonEmptyString(w.sameness) || !nonEmptyString(w.difference)) {
        errors.push(`claims[${i}].nearestWorks[${j}] 的 sameness/difference 必须都是非空字符串`);
        return;
      }
      nearest.push({
        key,
        sameness: (w.sameness as string).trim(),
        difference: (w.difference as string).trim(),
      });
    });
    assessments.push({ claimId, rating, nearestWorks: nearest, verdict: (obj.verdict as string).trim() });
  });

  for (const retrieval of retrievals) {
    if (!seen.has(retrieval.claim.id)) errors.push(`claim '${retrieval.claim.id}' 没有被评级`);
  }
  if (errors.length > 0) return { ok: false, errors, assessments: [] };
  return { ok: true, errors: [], assessments };
}

// ── ④ 评级校验层（确定性） ──────────────────────────────────────────────────

export const RATING_VIOLATION_CODES = [
  "no_candidates",
  "rating_without_nearest",
  "unknown_work",
  "existing_without_high_affinity",
  "novel_despite_high_affinity",
] as const;
export type RatingViolationCode = (typeof RATING_VIOLATION_CODES)[number];

export interface RatingViolation {
  code: RatingViolationCode;
  message: string;
}

export interface ConstrainedAssessment extends DeclaredAssessment {
  // 模型给的评级（保留原值，报告里两个都列出来，谁改了谁看得见）。
  declaredRating: NoveltyRating;
  // 校验层校正后的评级。
  rating: NoveltyRating;
  // false = 这条 claim 本次**没能得出可用结论**（不是「新颖」，是没查出来）。
  conclusive: boolean;
  violations: RatingViolation[];
  // 本次约束真正使用的口径与门槛（报告与 record metadata 都要写清楚，AD-12）。
  affinityBasis: AffinityBasis;
  affinityThreshold: number;
  // **按 affinityBasis 计的**最高候选相似度。
  topAffinity: number;
  // 词面口径下的最高相似度，恒有值——语义口径生效时它仍然留着做对照（AD-8 的「两个都留」再加一层）。
  topLexicalAffinity: number;
  citedAffinities: Array<{ key: string; affinity: number; semanticAffinity: number | null }>;
}

// 五条规则，全部是纯函数、零 IO，可以单独喂任意 assessment 来测。
//
// R1 no_candidates            检索为空 → 什么都不知道，结论不可用（检索不到 ≠ 新颖）
// R2 rating_without_nearest   有候选却一条最近邻都不给 → 没做功课，结论不可用
// R3 unknown_work             引用了候选清单外的 key → 伪造引用，结论不可用
// R4 existing_without_high_affinity  评 existing 却没引到高相似候选 → **降级**为 incremental
// R5 novel_despite_high_affinity     明明存在高相似候选却评 novel → **升级**为 existing
export function constrainRating(
  declared: DeclaredAssessment,
  candidates: NoveltyCandidate[],
  options: RatingConstraintOptions = {},
): ConstrainedAssessment {
  const basis = constraintBasis(candidates);
  if (basis === "semantic" && (options.semanticHighAffinity === undefined || options.semanticHighAffinity === null)) {
    // 语义分数配词面阈值 = 拿摄氏度去卡华氏度。这是编程错误，当场炸而不是算出一个像模像样的数——
    // 管线（applySemanticAffinity）只在「模型已标定」时才把候选标成 semantic，走不到这里。
    throw new NoveltyError(
      "候选标着语义口径（affinityBasis=semantic）却没有传语义阈值 semanticHighAffinity；" +
        "绝不允许拿词面阈值去卡语义分数",
    );
  }
  const high = basis === "semantic" ? options.semanticHighAffinity! : (options.highAffinity ?? HIGH_AFFINITY);
  const score = (c: NoveltyCandidate): number => (basis === "semantic" ? c.semanticAffinity! : c.affinity);
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const violations: RatingViolation[] = [];
  let conclusive = true;

  const cited: NoveltyCandidate[] = [];
  for (const work of declared.nearestWorks) {
    const candidate = byKey.get(work.key);
    if (!candidate) {
      violations.push({
        code: "unknown_work",
        message: `[@${work.key}] 不在本次检索的候选清单里，无法作为「已有工作」的证据`,
      });
      conclusive = false;
      continue;
    }
    cited.push(candidate);
  }

  if (candidates.length === 0) {
    violations.push({
      code: "no_candidates",
      message: "本次检索没有返回任何候选工作；检索不到不等于新颖，该 claim 未得出可用结论",
    });
    conclusive = false;
  } else if (declared.nearestWorks.length === 0) {
    violations.push({
      code: "rating_without_nearest",
      message: "有候选工作却没有列出任何最近邻；评级必须指出最接近的已有工作",
    });
    conclusive = false;
  }

  const topAffinity = candidates.reduce((max, c) => Math.max(max, score(c)), 0);
  const topLexicalAffinity = candidates.reduce((max, c) => Math.max(max, c.affinity), 0);
  const label = basis === "semantic" ? "语义相似度" : "词面相似度";
  let rating = declared.rating;

  if (declared.rating === "existing" && !cited.some((c) => score(c) >= high)) {
    violations.push({
      code: "existing_without_high_affinity",
      message:
        `评级 existing 但引用的最近邻${label}都低于 ${high}` +
        `（最高 ${cited.reduce((m, c) => Math.max(m, score(c)), 0).toFixed(2)}）；` +
        "已按检索证据降级为 incremental",
    });
    rating = "incremental";
  }

  if (declared.rating === "novel" && topAffinity >= high) {
    const top = candidates.find((c) => score(c) === topAffinity)!;
    violations.push({
      code: "novel_despite_high_affinity",
      message:
        `评级 novel 但检索到高相似候选 [@${top.key}]（${label} ${topAffinity.toFixed(2)} ≥ ${high}）；` +
        "已按检索证据升级为 existing",
    });
    rating = "existing";
  }

  return {
    ...declared,
    declaredRating: declared.rating,
    rating,
    conclusive,
    violations,
    affinityBasis: basis,
    affinityThreshold: high,
    topAffinity,
    topLexicalAffinity,
    citedAffinities: cited.map((c) => ({
      key: c.key,
      affinity: c.affinity,
      semanticAffinity: c.semanticAffinity,
    })),
  };
}

export interface RatingConstraintOptions {
  /** 词面口径的门槛（既有注入位）。语义口径生效时这项不参与判定。 */
  highAffinity?: number;
  /**
   * 语义口径的门槛。**必须来自 `SEMANTIC_THRESHOLDS`**（该模型标定过的值）。
   * null / 不传 = 没有标定阈值：此时候选也不该被标成 semantic，标了就是 bug，见上面的抛错。
   */
  semanticHighAffinity?: number | null;
}

/**
 * 一条 claim 的候选清单按哪个口径约束。
 *
 * **要么全语义、要么全词面，不许混**：两个量纲的数混在同一次 max/比较里，
 * 算出来的「最高相似度」没有任何意义。只要有一条候选没有可用语义分数
 * （embedding 失败、或该模型未标定被降级），整条 claim 一律退回词面。
 */
export function constraintBasis(candidates: NoveltyCandidate[]): AffinityBasis {
  if (candidates.length === 0) return "lexical";
  return candidates.every((c) => c.affinityBasis === "semantic" && c.semanticAffinity !== null)
    ? "semantic"
    : "lexical";
}

export interface NoveltyAggregate {
  status: NoveltyStatus;
  conclusive: boolean;
}

// 只要有一条 claim 没查出可用结论，整个 idea 的状态就**不推进**——
// 半张检查过的报告不该让 idea 看起来「已核验」。
export function aggregateNovelty(assessments: ConstrainedAssessment[]): NoveltyAggregate {
  if (assessments.length === 0) return { status: "unchecked", conclusive: false };
  if (assessments.some((a) => !a.conclusive)) return { status: "unchecked", conclusive: false };
  return { status: statusFromRatings(assessments.map((a) => a.rating)), conclusive: true };
}

// ── ⑤ 报告渲染 ──────────────────────────────────────────────────────────────

export interface NoveltyReportInput {
  idea: StoredIdeaCard;
  retrievals: ClaimRetrieval[];
  assessments: ConstrainedAssessment[];
  aggregate: NoveltyAggregate;
  sources: LiteratureSource[];
  embedding?: EmbeddingState;
  generatedAt?: string;
}

// 一条 claim 的 sourceStatus 是「每个检索式 × 每个源」的展开，直接打出来是一串重复的
// `openalex=ok · openalex=ok`，读者看不出哪条检索式挂了。按源汇总成
// 「成功检索式数 / 总检索式数 + 返回条数 + 失败原因」，失败原因去重保留（它是排障入口）。
export function summarizeSources(statuses: SourceStatus[]): string {
  const agg = new Map<string, { ok: number; total: number; count: number; notes: Set<string> }>();
  for (const status of statuses) {
    const entry = agg.get(status.source) ?? { ok: 0, total: 0, count: 0, notes: new Set<string>() };
    entry.total++;
    if (status.outcome === "ok") entry.ok++;
    entry.count += status.count;
    const note = status.error ?? status.note;
    if (note) entry.notes.add(note);
    agg.set(status.source, entry);
  }
  return [...agg.entries()]
    .map(([source, e]) => {
      const notes = e.notes.size > 0 ? `，${[...e.notes].join("；")}` : "";
      return `${source} ${e.ok}/${e.total} 成功，${e.count} 条${notes}`;
    })
    .join(" · ");
}

const RATING_LABEL: Record<NoveltyRating, string> = {
  novel: "novel（检索范围内未见实质相同工作）",
  incremental: "incremental（已有工作很接近）",
  existing: "existing（已被做过）",
};

// 报告正文由**代码**渲染，不是模型写的：引用形态、相似度、评级校正记录都得是确定的。
// 模型只负责 sameness / difference / verdict 这些需要判断力的字段。
export function renderNoveltyReport(input: NoveltyReportInput): string {
  const { idea, retrievals, assessments, aggregate } = input;
  const byId = new Map(retrievals.map((r) => [r.claim.id, r]));
  const lines: string[] = [];

  lines.push(`# Novelty check 报告：${ideaTitle(idea.hypothesis)}`);
  lines.push("");
  lines.push(
    `> idea record: \`${idea.recordId}\` · 检索源 ${input.sources.join("/")} · ` +
      `claim ${assessments.length} 条 · 生成于 ${input.generatedAt ?? new Date().toISOString()}`,
  );
  lines.push("");
  lines.push(`**假设陈述**：${idea.hypothesis}`);
  lines.push("");
  lines.push(
    `**结论**：${aggregate.conclusive ? `思路库状态 → \`${aggregate.status}\`` : "本次未得出可用结论，思路库状态维持 `unchecked`"}`,
  );
  lines.push("");

  lines.push("| claim | 校正后评级 | 模型评级 | 候选数 | 最高相似度（词面） | 最高相似度（语义） | 判据口径 | 结论可用 |");
  lines.push("|-------|-----------|---------|-------|------------------|------------------|---------|---------|");
  for (const a of assessments) {
    const retrieval = byId.get(a.claimId);
    const semanticTop = retrieval
      ? retrieval.candidates.reduce<number | null>(
          (max, c) => (c.semanticAffinity === null ? max : Math.max(max ?? 0, c.semanticAffinity)),
          null,
        )
      : null;
    lines.push(
      `| ${a.claimId} | ${a.rating} | ${a.declaredRating} | ${retrieval?.candidates.length ?? 0} | ` +
        `${a.topLexicalAffinity.toFixed(2)} | ${semanticTop === null ? "n/a" : semanticTop.toFixed(2)} | ` +
        `${a.affinityBasis} | ${a.conclusive ? "是" : "否"} |`,
    );
  }
  lines.push("");

  for (const a of assessments) {
    const retrieval = byId.get(a.claimId);
    if (!retrieval) continue;
    const byKey = new Map(retrieval.candidates.map((c) => [c.key, c]));
    lines.push(`## ${a.claimId}: ${retrieval.claim.statement}`);
    lines.push("");
    lines.push(`检索式：${retrieval.claim.queries.map((q) => `\`${q}\``).join(" · ")}`);
    lines.push("");
    lines.push(`评级：**${RATING_LABEL[a.rating]}**${a.rating !== a.declaredRating ? `（模型原判 ${a.declaredRating}，已被评级校验层校正）` : ""}`);
    lines.push("");
    lines.push(`判词：${a.verdict}`);
    lines.push("");
    lines.push("最接近的已有工作：");
    lines.push("");
    if (a.nearestWorks.length === 0) {
      lines.push("- （未列出——这本身是一条评级校验违规，见下）");
    }
    for (const work of a.nearestWorks) {
      const candidate = byKey.get(work.key);
      const paper = candidate?.paper;
      const meta = paper
        ? `${paper.year ?? "n.d."}, ${paper.venue ?? "未知 venue"}${paper.doi ? `, doi:${paper.doi}` : ""}`
        : "（该 key 不在候选清单里）";
      lines.push(`- **[@${work.key}]** ${paper?.title ?? "未知标题"} — ${meta}`);
      lines.push(
        `  - 相似度（确定性计算）：词面 ${candidate ? candidate.affinity.toFixed(2) : "n/a"} · ` +
          `语义 ${candidate?.semanticAffinity != null ? candidate.semanticAffinity.toFixed(2) : "n/a"}` +
          `（本条按 ${a.affinityBasis} 口径判定）`,
      );
      lines.push(`  - 相同点：${work.sameness}`);
      lines.push(`  - 不同点：${work.difference}`);
    }
    lines.push("");
    if (a.violations.length > 0) {
      lines.push("评级校验层：");
      for (const v of a.violations) lines.push(`- ⚠️ \`${v.code}\` ${v.message}`);
      lines.push("");
    }
    const rest = retrieval.candidates.filter((c) => !a.nearestWorks.some((w) => w.key === c.key)).slice(0, 5);
    if (rest.length > 0) {
      lines.push(`其余候选（相似度前 ${rest.length} 条，未被列为最近邻）：`);
      for (const c of rest) {
        lines.push(
          `- [@${c.key}] ${c.paper.title}（词面 ${c.affinity.toFixed(2)} · ` +
            `语义 ${c.semanticAffinity === null ? "n/a" : c.semanticAffinity.toFixed(2)}）`,
        );
      }
      lines.push("");
    }
  }

  lines.push("## 检索源状态");
  lines.push("");
  lines.push("（每条 claim 有多个检索式，下面按源汇总「成功的检索式数 / 总检索式数」与返回条数）");
  lines.push("");
  for (const retrieval of retrievals) {
    lines.push(`- ${retrieval.claim.id}: ${summarizeSources(retrieval.sources)}`);
  }
  lines.push("");
  lines.push("## 口径说明");
  lines.push("");
  lines.push(
    "- 本报告里的每条「已有工作」都来自本次真实检索返回的结果，引用 key 与项目文献库（`lit export --format bibtex`）同一套规则分配。",
  );
  const embedding = input.embedding;
  const basis = embedding?.basis ?? "lexical";
  const threshold = embedding?.threshold ?? HIGH_AFFINITY;
  lines.push(
    "- 相似度是**确定性计算**，不是模型给的分。两列都留：" +
      "「词面」= claim/检索式与候选标题摘要的内容词覆盖率；" +
      "「语义」= 同样这些文本的 embedding 余弦（没配 embedding 或本次没算成时为 n/a）。",
  );
  lines.push(
    `- **本次评级约束按「${basis === "semantic" ? "语义" : "词面"}」口径**，门槛 ${threshold}` +
      (basis === "semantic"
        ? `（模型 \`${embedding!.modelId}\`，标定见 backend/src/llm/embeddings/calibration.ts）。`
        : "（backend/src/ideation/novelty.ts 的 HIGH_AFFINITY）。"),
  );
  if (embedding?.degradedReason) {
    // 不静默降级：为什么没按语义判，必须写在读者看得见的地方。
    lines.push(`- ⚠️ **本次未能按语义口径判定，已退回词面**：${embedding.degradedReason}`);
  }
  lines.push(
    `- 评级由模型给出后经评级校验层校正：评 existing 必须引到相似度 ≥ ${threshold} 的候选，` +
      "存在高相似候选时不许评 novel，任何评级都必须列出最近邻。" +
      "**语义相似度只是这层校验的输入，不是结论本身**——确定性层的降级/升级规则一条不少（AD-8）。",
  );
  lines.push("- 检索覆盖面 = 结论的边界。检索不到不等于新颖，只等于这几条检索式没查到。");
  return lines.join("\n");
}

// ── 管线 ────────────────────────────────────────────────────────────────────

export interface NoveltyDeps {
  llm: Pick<LLMRouter, "call">;
  searcher: LiteratureSearcher;
  library: LibraryStore;
  records?: RecordStore;
  artifacts?: ArtifactStore;
  model?: string;
  workDir?: string;
  sources?: LiteratureSource[];
  perSource?: number;
  // 每条检索式合并去重后保留多少条候选（默认 8）。
  limitPerQuery?: number;
  highAffinity?: number;
  judge?: CitationJudge;
  /**
   * 语义相似度来源（v0.5 C4）。
   *   - 不传（undefined）：按 config 的 `embeddingModel` 自动构造一个 EmbeddingRouter；
   *     没配这项时它 `configured()===false`，**一次网络请求都不会发**，行为与 v0.4 完全一致。
   *   - 传 null：**显式关掉**语义口径，强制词面（单测用，免得开发机上的
   *     SPARK_RESEARCH_EMBEDDING_MODEL 让测试偷偷打真实网络）。
   *   - 传对象：注入自己的实现（回放 fixture 的 router、或假实现）。
   */
  embedder?: Embedder | null;
  /**
   * 语义阈值登记表的注入位。生产路径不传 = 用 `SEMANTIC_THRESHOLDS`（当前为空 ⇒ 强制词面）。
   * 测试注入一张表，是为了让**语义约束这条分支**被完整测到——否则它会变成
   * 「哪天真登记了阈值才第一次被执行」的死角。
   */
  semanticThresholds?: Readonly<Record<string, SemanticThreshold>>;
}

/** novelty 只需要 EmbeddingRouter 的这两个方法（§1.2.2 的注入位）。 */
export type Embedder = Pick<EmbeddingRouter, "embed" | "modelId">;

/**
 * 本次核验的相似度口径**状态**。它会同时进报告的「口径说明」与 record metadata——
 * 「这次到底是按词面还是按语义判的、为什么」必须是外部可读的事实，不能只活在日志里。
 */
export interface EmbeddingState {
  /** 配置的 embedding 模型 id；null = 没配（本次纯词面，不算降级）。 */
  modelId: string | null;
  /** 评级约束真正使用的口径。 */
  basis: AffinityBasis;
  /** 该口径下的门槛。 */
  threshold: number;
  /** modelId 是否登记过标定阈值。 */
  calibrated: boolean;
  /** 向量是否真的算出来了（报告里的「语义」参考列有没有值）。 */
  vectorsAvailable: boolean;
  /**
   * 配了 embedding 却仍然按词面判的原因。
   * **不静默降级**（feedback_silent_fallback_logging 同一纪律）：这里非 null 时，
   * 报告的「口径说明」必须把它原样打出来。
   */
  degradedReason: string | null;
}

export interface NoveltyCheckOptions {
  sessionId?: string | null;
  filename?: string;
  // 只跑不落库（CLI 的 --dry-run 与单测用）。
  persist?: boolean;
}

export interface NoveltyCheckResult {
  idea: StoredIdeaCard;
  claims: NoveltyClaim[];
  retrievals: ClaimRetrieval[];
  assessments: ConstrainedAssessment[];
  aggregate: NoveltyAggregate;
  markdown: string;
  citation: CitationIntegrityResult;
  embedding: EmbeddingState;
  path: string | null;
  artifactId: string | null;
  recordId: string | null;
  attempts: { claims: number; compare: number };
}

export class NoveltyChecker {
  constructor(private deps: NoveltyDeps) {}

  async check(idea: StoredIdeaCard, options: NoveltyCheckOptions = {}): Promise<NoveltyCheckResult> {
    const sources = this.deps.sources ?? DEFAULT_SEARCH_SOURCES;
    const { claims, attempts: claimAttempts } = await this.extractClaims(idea);
    const lexicalOnly = await this.retrieve(claims, sources);
    // ④ 之前先定口径：语义分数是**输入**，不是最终判据——确定性层照样在下面跑，
    //    只是它比较的那个数换了口径（AD-8 不因语义化而变松，见 constrainRating）。
    const { retrievals, embedding } = await this.applySemanticAffinity(lexicalOnly);
    const { assessments: declared, attempts: compareAttempts } = await this.compare(retrievals);

    const assessments = declared.map((d) =>
      constrainRating(d, retrievals.find((r) => r.claim.id === d.claimId)?.candidates ?? [], {
        highAffinity: this.deps.highAffinity,
        semanticHighAffinity: embedding.basis === "semantic" ? embedding.threshold : null,
      }),
    );
    const aggregate = aggregateNovelty(assessments);
    const markdown = renderNoveltyReport({ idea, retrievals, assessments, aggregate, sources, embedding });

    // ⑤ 引用核验：报告里的每个 [@key] 都必须落在「库内论文 ∪ 本次检索候选」上。
    const knownKeys = new Set<string>([
      ...libraryKeyIndex(this.deps.library.list()).keys,
      ...retrievals.flatMap((r) => r.candidates.map((c) => c.key)),
    ]);
    const citation = await citationIntegrity({
      draft: markdown,
      knownKeys,
      judge: this.deps.judge,
      location: "text/markdown",
      // 报告正文里的「评 existing」这类措辞不是学术强断言，强断言检查在这里只会刷噪声；
      // 真正的约束是上面的评级校验层。
      checkUnsupportedClaims: false,
    });

    const persisted =
      options.persist === false
        ? { path: null, artifactId: null, recordId: null, idea }
        : this.persist(idea, markdown, retrievals, assessments, aggregate, embedding, options);

    return {
      idea: persisted.idea,
      claims,
      retrievals,
      assessments,
      aggregate,
      markdown,
      citation,
      embedding,
      path: persisted.path,
      artifactId: persisted.artifactId,
      recordId: persisted.recordId,
      attempts: { claims: claimAttempts, compare: compareAttempts },
    };
  }

  // ① claim 提取
  private async extractClaims(idea: StoredIdeaCard): Promise<{ claims: NoveltyClaim[]; attempts: number }> {
    const userPrompt = buildClaimPrompt(idea);
    let lastErrors: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages: ChatMessage[] = [
        { role: "system", content: CLAIM_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ];
      if (attempt === 2) {
        messages.push({
          role: "user",
          content:
            "上一次输出不合 claim schema，请只重新输出修正后的 JSON 对象。校验失败原因：\n" +
            lastErrors.map((e) => `- ${e}`).join("\n"),
        });
      }
      const response = this.deps.model
        ? await this.deps.llm.call(messages, this.deps.model)
        : await this.deps.llm.call(messages);
      if (!response.ok) {
        lastErrors = [`模型调用失败: ${response.error?.message ?? "未知原因"}`];
        continue;
      }
      const validation = validateClaimsPayload(extractJsonObject(response.content));
      if (!validation.ok) {
        lastErrors = validation.errors;
        continue;
      }
      return { claims: validation.claims, attempts: attempt };
    }
    throw new NoveltyError(`claim 提取失败（重试 1 次后仍不合 schema）: ${lastErrors.join("; ")}`, lastErrors);
  }

  // ② 密集检索：每条 claim 的每个检索式各跑一次统一检索，合并去重后按相似度排序。
  private async retrieve(claims: NoveltyClaim[], sources: LiteratureSource[]): Promise<ClaimRetrieval[]> {
    const perSource = this.deps.perSource ?? 5;
    const limit = this.deps.limitPerQuery ?? 8;

    // 全局候选池：同一篇论文在不同 claim / 不同检索式下必须拿到同一个引用 key，
    // 否则同一份报告里会出现两个 key 指向同一篇文献，读者无从核对。
    const pool = new Map<string, Paper>();
    const byDoi = new Map<string, string>();
    const byTitle = new Map<string, string>();
    const identify = (paper: Paper): string => {
      const tk = titleKey(paper.title);
      const hit = (paper.doi ? byDoi.get(paper.doi) : undefined) ?? (tk ? byTitle.get(tk) : undefined);
      const identity = hit ?? paperIdentity(paper);
      // 跨源/跨检索式补齐字段（一次带 DOI、一次带摘要是常态）。
      const merged = hit ? mergePapers(pool.get(hit)!, paper) : paper;
      pool.set(identity, merged);
      if (merged.doi) byDoi.set(merged.doi, identity);
      const mergedTitleKey = titleKey(merged.title);
      if (mergedTitleKey) byTitle.set(mergedTitleKey, identity);
      if (tk) byTitle.set(tk, identity);
      return identity;
    };

    const claimIdentities = new Map<string, Map<string, Set<string>>>();
    const statusByClaim = new Map<string, SourceStatus[]>();

    for (const claim of claims) {
      const statuses: SourceStatus[] = [];
      const queriesOf = new Map<string, Set<string>>();
      // 检索式之间串行：不并发打同一批公共 API（与 P2 PDF 下载同一条礼貌纪律）。
      for (const query of claim.queries) {
        const result = await this.deps.searcher.search(query, { sources, perSource, limit });
        statuses.push(...result.sources);
        for (const paper of result.papers) {
          const identity = identify(paper);
          const bucket = queriesOf.get(identity) ?? new Set<string>();
          bucket.add(query);
          queriesOf.set(identity, bucket);
        }
      }
      claimIdentities.set(claim.id, queriesOf);
      statusByClaim.set(claim.id, statuses);
    }

    // key 分配：库内论文在前（key 与 P3 完全一致），库外候选接在后面。
    const libraryPapers = this.deps.library.list();
    const poolEntries = [...pool.entries()];
    const inLibrary = new Map<string, LibraryPaper>();
    const externals: Array<{ identity: string; paper: Paper }> = [];
    for (const [identity, paper] of poolEntries) {
      const match = this.deps.library.findMatch(paper);
      if (match) inLibrary.set(identity, match);
      else externals.push({ identity, paper });
    }
    const keys = assignCandidateKeys(
      libraryPapers,
      externals.map((e) => e.paper),
    );
    const libraryKeyById = new Map(libraryPapers.map((p, i) => [p.id, keys.libraryKeys[i]!]));
    const keyByIdentity = new Map<string, string>();
    for (const [identity, match] of inLibrary) keyByIdentity.set(identity, libraryKeyById.get(match.id)!);
    externals.forEach((e, i) => keyByIdentity.set(e.identity, keys.externalKeys[i]!));

    return claims.map((claim) => {
      const queriesOf = claimIdentities.get(claim.id) ?? new Map<string, Set<string>>();
      const texts = [claim.statement, ...claim.queries];
      const candidates: NoveltyCandidate[] = [...queriesOf.keys()].map((identity) => {
        const paper = pool.get(identity)!;
        const match = inLibrary.get(identity) ?? null;
        return {
          key: keyByIdentity.get(identity)!,
          paper,
          affinity: claimAffinity(texts, paper),
          // 语义分数在 applySemanticAffinity() 里补；检索这一步只出词面口径。
          semanticAffinity: null,
          affinityBasis: "lexical" as const,
          inLibrary: match !== null,
          libraryPaperId: match?.id ?? null,
          libraryRecordId: match?.recordId ?? null,
          queries: [...(queriesOf.get(identity) ?? [])],
        };
      });
      // 相似度降序；同分时按标题保证确定性（CI 与本地结果一致）。
      candidates.sort((a, b) => b.affinity - a.affinity || a.paper.title.localeCompare(b.paper.title));
      return {
        claim,
        candidates: candidates.slice(0, limit),
        sources: statusByClaim.get(claim.id) ?? [],
      };
    });
  }

  // ②-b 语义相似度（v0.5 C4）
  //
  // 一次批量 embed 覆盖「全部 claim 文本 + 全部候选文本」，去重后发出去（同一篇论文被多条
  // claim 命中只嵌一次）。任何一步不成立就**整体退回词面并把原因带出去**——
  // 不静默降级，报告的「口径说明」会原样打出这条原因。
  private async applySemanticAffinity(
    retrievals: ClaimRetrieval[],
  ): Promise<{ retrievals: ClaimRetrieval[]; embedding: EmbeddingState }> {
    const lexical = (degradedReason: string | null, modelId: string | null, calibrated: boolean, vectorsAvailable = false): EmbeddingState => ({
      modelId,
      basis: "lexical",
      threshold: this.deps.highAffinity ?? HIGH_AFFINITY,
      calibrated,
      vectorsAvailable,
      degradedReason,
    });

    // undefined = 按 config 自动接线；null = 调用方显式关掉。
    const embedder: Embedder | null =
      this.deps.embedder === undefined ? new EmbeddingRouter() : this.deps.embedder;
    if (embedder === null) return { retrievals, embedding: lexical(null, null, false) };

    const modelId = embedder.modelId();
    if (modelId === null) return { retrievals, embedding: lexical(null, null, false) };

    const thresholds = this.deps.semanticThresholds;
    const calibrated = thresholds ? isCalibrated(modelId, thresholds) : isCalibrated(modelId);
    const threshold = thresholds ? semanticHighAffinity(modelId, thresholds) : semanticHighAffinity(modelId);

    // 去重的文本清单。顺序确定（claim 在前、候选按出现序），fixture 回放才对得上。
    const texts: string[] = [];
    const indexOf = new Map<string, number>();
    const intern = (text: string): number => {
      const hit = indexOf.get(text);
      if (hit !== undefined) return hit;
      const idx = texts.length;
      texts.push(text);
      indexOf.set(text, idx);
      return idx;
    };
    const claimTextIdx = new Map<string, number[]>();
    const paperTextIdx = new Map<string, number>();
    for (const retrieval of retrievals) {
      claimTextIdx.set(
        retrieval.claim.id,
        [retrieval.claim.statement, ...retrieval.claim.queries].map((t) => intern(t)),
      );
      for (const candidate of retrieval.candidates) {
        paperTextIdx.set(`${retrieval.claim.id}:${candidate.key}`, intern(paperEmbedText(candidate.paper)));
      }
    }
    if (texts.length === 0) {
      return { retrievals, embedding: lexical(null, modelId, calibrated) };
    }

    const response = await embedder.embed(texts);
    if (!response.ok) {
      // AD-13：失败就是失败，**不许静默退回词面还报成功**。词面结果照样能出报告，
      // 但「本次是降级跑的、因为什么降级」必须写进报告，调用方也能从 result.embedding 读到。
      return {
        retrievals,
        embedding: lexical(
          `embedding 调用失败（${response.error.kind}）：${response.error.message}`,
          modelId,
          calibrated,
        ),
      };
    }
    if (response.vectors.length !== texts.length) {
      return {
        retrievals,
        embedding: lexical(
          `embedding 返回 ${response.vectors.length} 条向量，与请求的 ${texts.length} 条不符`,
          modelId,
          calibrated,
        ),
      };
    }

    // K-4：模型没标定过 → 向量照算、报告里作参考列，但**不拿来做评级约束**。
    const basis: AffinityBasis = calibrated ? "semantic" : "lexical";
    const vectors = response.vectors;
    const withSemantic = retrievals.map((retrieval) => {
      const claimVectors = (claimTextIdx.get(retrieval.claim.id) ?? []).map((i) => vectors[i]!);
      const candidates = retrieval.candidates.map((candidate) => {
        const paperVector = vectors[paperTextIdx.get(`${retrieval.claim.id}:${candidate.key}`)!]!;
        // 与 claimAffinity 同一个取法：陈述 + 各检索式里最高的那个。
        const semantic = claimVectors.reduce((max, v) => Math.max(max, cosine(v, paperVector)), -1);
        return {
          ...candidate,
          semanticAffinity: Math.round(semantic * 1000) / 1000,
          affinityBasis: basis,
        };
      });
      // 排序换成生效口径：报告与 prompt 里的「按相似度排序」得跟判据是同一个数。
      candidates.sort((a, b) => {
        const av = basis === "semantic" ? a.semanticAffinity! : a.affinity;
        const bv = basis === "semantic" ? b.semanticAffinity! : b.affinity;
        return bv - av || a.paper.title.localeCompare(b.paper.title);
      });
      return { ...retrieval, candidates };
    });

    if (!calibrated) {
      return {
        retrievals: withSemantic,
        embedding: lexical(
          `模型 '${modelId}' 没有登记标定阈值（llm/embeddings/calibration.ts 的 SEMANTIC_THRESHOLDS）；` +
            "语义相似度只作参考列，评级约束仍按词面",
          modelId,
          false,
          true,
        ),
      };
    }
    return {
      retrievals: withSemantic,
      embedding: {
        modelId,
        basis: "semantic",
        threshold: threshold!,
        calibrated: true,
        vectorsAvailable: true,
        degradedReason: null,
      },
    };
  }

  // ③ 对比评级
  private async compare(
    retrievals: ClaimRetrieval[],
  ): Promise<{ assessments: DeclaredAssessment[]; attempts: number }> {
    const userPrompt = buildComparePrompt(retrievals);
    let lastErrors: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages: ChatMessage[] = [
        { role: "system", content: COMPARE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ];
      if (attempt === 2) {
        messages.push({
          role: "user",
          content:
            "上一次输出不合对比报告 schema，请只重新输出修正后的 JSON 对象。校验失败原因：\n" +
            lastErrors.map((e) => `- ${e}`).join("\n"),
        });
      }
      const response = this.deps.model
        ? await this.deps.llm.call(messages, this.deps.model)
        : await this.deps.llm.call(messages);
      if (!response.ok) {
        lastErrors = [`模型调用失败: ${response.content}`];
        continue;
      }
      const validation = validateAssessmentPayload(extractJsonObject(response.content), retrievals);
      if (!validation.ok) {
        lastErrors = validation.errors;
        continue;
      }
      return { assessments: validation.assessments, attempts: attempt };
    }
    throw new NoveltyError(`对比报告生成失败（重试 1 次后仍不合 schema）: ${lastErrors.join("; ")}`, lastErrors);
  }

  // ⑥ 回写
  private persist(
    idea: StoredIdeaCard,
    markdown: string,
    retrievals: ClaimRetrieval[],
    assessments: ConstrainedAssessment[],
    aggregate: NoveltyAggregate,
    embedding: EmbeddingState,
    options: NoveltyCheckOptions,
  ): { path: string | null; artifactId: string | null; recordId: string | null; idea: StoredIdeaCard } {
    const filename = options.filename ?? `novelty-${idea.recordId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.md`;
    const dir = this.deps.workDir ?? tmpdir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, `${markdown}\n`);

    const artifacts = this.deps.artifacts;
    const records = this.deps.records;
    if (!artifacts || !records) return { path, artifactId: null, recordId: null, idea };

    // extractedCode 传空串：报告不是代码产物（同 P3 综述草稿，见 rules.hasClaim）。
    const artifact = artifacts.save(path, "", [], {
      sessionId: options.sessionId ?? null,
      generator: "novelty-check",
    });
    const record = records.createFromArtifact(artifact, {
      title: `Novelty 报告：${ideaTitle(idea.hypothesis)}`,
      content: markdown,
      evidence: "inferred",
      origin: { kind: "session", sessionId: options.sessionId ?? null, ref: artifact.id },
      metadata: {
        kind: NOVELTY_REPORT_KIND,
        ideaRecordId: idea.recordId,
        status: aggregate.status,
        conclusive: aggregate.conclusive,
        // AD-12：口径是事实的一部分，外部 agent 读 record 就该知道这份报告是怎么判出来的。
        affinityBasis: embedding.basis,
        affinityThreshold: embedding.threshold,
        embeddingModel: embedding.modelId,
        embeddingDegradedReason: embedding.degradedReason,
        claims: retrievals.map((r) => ({
          id: r.claim.id,
          statement: r.claim.statement,
          queries: r.claim.queries,
          candidateCount: r.candidates.length,
        })),
        assessments: assessments.map((a) => ({
          claimId: a.claimId,
          rating: a.rating,
          declaredRating: a.declaredRating,
          conclusive: a.conclusive,
          affinityBasis: a.affinityBasis,
          topAffinity: a.topAffinity,
          topLexicalAffinity: a.topLexicalAffinity,
          violations: a.violations,
          nearestWorks: a.nearestWorks,
        })),
      },
    });

    // 证据图：报告 --derives_from--> idea；候选中已在库的论文再连一条 cites。
    records.link(record.id, idea.recordId, "derives_from");
    const linked = new Set<string>();
    for (const retrieval of retrievals) {
      for (const candidate of retrieval.candidates) {
        if (!candidate.libraryRecordId || linked.has(candidate.libraryRecordId)) continue;
        linked.add(candidate.libraryRecordId);
        records.link(record.id, candidate.libraryRecordId, "cites");
      }
    }

    const store = new IdeaStore(records, this.deps.library);
    // 结论不可用时状态**不推进**（保持 unchecked），但报告指针照样写回去：
    // 「查过但没查出来」与「没查过」要能区分开。
    const updated = store.setNovelty(idea.recordId, aggregate.status, { reportRecordId: record.id });

    return { path, artifactId: artifact.id, recordId: record.id, idea: updated };
  }
}
