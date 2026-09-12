import type { LineageConflict } from "../artifacts/lineage.ts";
import type { ArtifactVersion, ExecutionRecord } from "../artifacts/models.ts";

export type Severity = "hard" | "soft";

export interface Finding {
  severity: Severity;
  artifactId: string;
  message: string;
  location: string;
  // 产生该 finding 的检查器 id（P3 起）。旧检查器不带此字段，行为不变。
  rule?: string;
  // 结构化细节，便于 CLI/前端渲染与测试断言（不进 message 文案）。
  detail?: Record<string, unknown>;
}

export type ReviewAction = "inject_notice_and_veto_completion";

export interface ReviewResult {
  approved: boolean;
  findings: Finding[];
  action?: ReviewAction;
  notice?: string;
}

// 「带代码声明」= 有非空的 extractedCode。空串不算——P3 起有了非代码产出的 artifact
// （综述草稿是 LLM 写的 Markdown，没有产生它的 cell），空 extractedCode 不该被当成待溯源的 claim。
export function hasClaim(artifact: ArtifactVersion): boolean {
  return artifact.extractedCode != null && artifact.extractedCode.trim().length > 0;
}

export function findProducingCell(
  artifact: ArtifactVersion,
  executionLog: ExecutionRecord[],
): ExecutionRecord | undefined {
  if (artifact.producingCellId) {
    const [session, idx] = artifact.producingCellId.split(":");
    const cellIndex = Number(idx);
    if (session && Number.isInteger(cellIndex)) {
      const byId = executionLog.find((r) => r.frame === session && r.cellIndex === cellIndex);
      if (byId) return byId;
    }
  }
  return executionLog.find((r) => r.filesWritten.includes(artifact.filename));
}

export function isFigureOrReport(artifact: ArtifactVersion): boolean {
  const t = artifact.contentType;
  if (t.startsWith("image/")) return true;
  if (t === "application/pdf" || t === "text/markdown") return true;
  if (t.includes("presentationml")) return true;
  return false;
}

export function artifactLocation(artifact: ArtifactVersion): string {
  return isFigureOrReport(artifact) ? artifact.contentType : "chat";
}

// ── citation-integrity（P3，DESIGN 域 E1「引用真实性」）────────────────────────
//
// 分级口径（DEVELOPMENT_PLAN P3 退出标准）：
//   key 不在库内            → hard（veto）：这是伪造引用，读者无法核对，必须挡住
//   key 在库但陈述与卡片冲突 → soft：判定本身是 LLM 推断（evidence=inferred），不该单凭它否决
//   强断言句无引用支撑       → soft：可能是常识句，也可能是漏引，交给人判断
//
// 这三条的严重度由规则**自己**决定，不参与 applyLocationWeight 的「figure/report 里 soft 升 hard」，
// 否则综述草稿（text/markdown）里的所有 soft 都会变成 veto，与上面的口径直接冲突。

export const CITATION_RULE = "citation-integrity";

export interface ParsedCitation {
  key: string;
  // 该引用所在的句子（原文片段，用于 finding 定位与 LLM 对照）
  sentence: string;
  sentenceIndex: number;
}

// 去掉围栏代码块与行内代码：代码里的 [@x] 不是引用。
export function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

// 句子切分：中英文句末标点 + 换行/列表项边界。保留原文本片段（trim 后）。
// 两个刻意的取舍：
//  - **不**按分号切：`[@a; @b]` 是合法的并列引用形式，按分号切会把它劈成两半、漏掉后一个 key。
//  - 英文句点只在其后**跟空白**时才算句末：这样 `10.1000/x.1` 这类 DOI/版本号不会被切碎
//    （代价是 "et al. 2021" 会多切一刀，只影响 finding 里的引文片段长度，不影响判定）。
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])\s*|(?<=\.)\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// 引用标记：[@key]、[@key1; @key2]、[@key1, @key2]。key 允许字母数字、中文（\p{Script=Han}）与 -_: 。
//
// V92：库内不少 key 是中文作者名+年份+关键词拼出来的（如 `[@李某2023神经解码]`——
// bibtex key 生成器直接拿中文字符做 key，不强制转拼音）。旧正则只认 `[A-Za-z0-9...]`，
// 这类 key 整条引用标记连 `matchAll` 都匹配不到，后果是「这条引用」在 citationIntegrity
// 眼里压根不存在：既不会因为库外伪造被 hard 挡（① 库外 key 门），也不会被送进 judge
// 做一致性核验（② judge 输入提取），等于对中文 key 全盘失明——比「库外 key」更糟，
// 因为连「查过、没通过」的记录都不会留下。
//
// 加 `\p{Script=Han}` 到首字符与续字符两处字符类，并给正则加 `u` 标志（Unicode
// property escape 必须配 `u` 才能解析，否则是语法错误）。`u` 标志本身不改变既有
// ASCII 字符类的匹配语义（`\-` 在 unicode 模式的字符类里仍是合法的连字符转义），
// 上面 `regex_test.ts` 的手工验证：中英文混排、多 key 一括号、标点粘连、纯 ASCII
// key 五种形态全部按预期解析，没有因为加 `u` 标志破坏原有 ASCII 路径。
const CITATION_TOKEN =
  /\[@([A-Za-z0-9\p{Script=Han}][A-Za-z0-9\p{Script=Han}_\-:]*(?:\s*[;,]\s*@[A-Za-z0-9\p{Script=Han}][A-Za-z0-9\p{Script=Han}_\-:]*)*)\]/gu;

export function parseCitations(markdown: string): ParsedCitation[] {
  const sentences = splitSentences(stripCode(markdown));
  const out: ParsedCitation[] = [];
  sentences.forEach((sentence, sentenceIndex) => {
    for (const match of sentence.matchAll(CITATION_TOKEN)) {
      for (const raw of match[1]!.split(/[;,]/)) {
        const key = raw.replace(/^\s*@?/, "").trim();
        if (key) out.push({ key, sentence, sentenceIndex });
      }
    }
  });
  return out;
}

export function citedKeys(markdown: string): string[] {
  return [...new Set(parseCitations(markdown).map((c) => c.key))];
}

// 强断言模式：中英文各一组。命中且句内无引用 → soft finding。
export const STRONG_CLAIM_PATTERNS: RegExp[] = [
  /证明了?/,
  /首次/,
  /显著优于/,
  /大幅(提升|超过|领先)/,
  /(唯一|最好|最优|最先进)的?(方法|模型|方案)/,
  /已被证实/,
  /\bprove[sd]?\b/i,
  /\bfirst to\b/i,
  /\bsignificantly (out)?perform(s|ed)?\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bdemonstrably\b/i,
];

export function isStrongClaim(sentence: string): boolean {
  return STRONG_CLAIM_PATTERNS.some((p) => p.test(sentence));
}

// 参考文献条目：引用标记就是这一行的开头（`- [@key] 标题. 作者. 年. venue.`），
// 前面没有任何对该文献的陈述。这类行不做一致性判定。
export function isReferenceEntry(sentence: string, key: string): boolean {
  return new RegExp(`^[-*\\d.)\\s]*\\[@${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[;,\\]]`).test(sentence.trim());
}

// 引用核验的对照基准：来自精读卡（reading.ts 的 cardBaselineText）。
export interface CitationBaseline {
  key: string;
  title: string;
  summary: string;
}

export type CitationVerdict = "consistent" | "conflict" | "unclear";

export interface CitationJudgeInput {
  key: string;
  statement: string;
  baseline: CitationBaseline;
}

export interface CitationJudgement {
  verdict: CitationVerdict;
  reason: string;
}

// LLM 辅助判定器。判不了就抛异常，由 citationIntegrity 汇总成一条可见的 soft finding，
// 不允许静默当作「没问题」。
export interface CitationJudge {
  judge(input: CitationJudgeInput): Promise<CitationJudgement>;
}

export interface CitationIntegrityInput {
  draft: string;
  // 库内全部可用 bibtex key（真源：libraryKeyIndex(library.list()).keys）
  knownKeys: Iterable<string>;
  // key → 精读卡对照基准；没有卡片的 key 跳过冲突检查（并在 detail 里标出来）
  baselines?: Map<string, CitationBaseline>;
  judge?: CitationJudge;
  artifactId?: string;
  location?: string;
  // 关掉强断言检查（例如对非综述类文本复用本检查器时）
  checkUnsupportedClaims?: boolean;
}

export interface CitationIntegrityResult {
  findings: Finding[];
  // 供 CLI/测试汇报：解析出的引用总数、未知 key、被判冲突的 key
  citations: ParsedCitation[];
  unknownKeys: string[];
  conflictKeys: string[];
  judgedCount: number;
  judgeErrors: number;
}

export async function citationIntegrity(input: CitationIntegrityInput): Promise<CitationIntegrityResult> {
  const known = new Set(input.knownKeys);
  const artifactId = input.artifactId ?? "";
  const location = input.location ?? "review-draft";
  const citations = parseCitations(input.draft);
  const findings: Finding[] = [];
  const unknownKeys: string[] = [];
  const conflictKeys: string[] = [];
  let judgedCount = 0;
  let judgeErrors = 0;

  // ① 库外 key（含凭空编造的 key 与「真实存在但不在库里」的文献）→ hard。
  //    这两种在检查器看来是同一件事：读者无法从项目文献库核对这条引用。
  for (const citation of citations) {
    if (known.has(citation.key)) continue;
    unknownKeys.push(citation.key);
    findings.push({
      severity: "hard",
      artifactId,
      location,
      rule: CITATION_RULE,
      message:
        `unknown_citation: 引用 [@${citation.key}] 不存在于项目文献库。` +
        `修复：用 spark-research lit search/add 把该文献入库后重新生成，或删除该引用。` +
        `句子："${citation.sentence.slice(0, 120)}"`,
      detail: { key: citation.key, sentence: citation.sentence, sentenceIndex: citation.sentenceIndex },
    });
  }

  // ② 库内 key 但陈述与精读卡冲突 → soft（判定结果是 inferred）。
  if (input.judge && input.baselines) {
    // v0.4 W4 收口：这里原本是串行 `for ... await judge()`——30 引用的综述 = 30 次串行往返。
    // W4-b 在 `LlmCitationJudge` 内部做了两件事：按 `(key, sha256(statement))` 去重
    // （对串行链也直接生效），以及一个默认上限 4 的并发闸。但**并发闸在串行调用方下从不触发**，
    // 所以降速那一半收益一直没兑现（W4-b 如实报告过：rules.ts 不在它的文件所有权内）。
    //
    // 这里把循环改成一次性发起、并发执行、按原序处理结果：
    //   - 限流由判定器内部的闸兜（调用方不重复实现一套）
    //   - findings 的顺序、judgedCount / judgeErrors 的语义与串行时逐条一致
    //   - 单个判定失败仍然只计入 judgeErrors 并跳过该条，不影响其它条
    const judgeable = citations.filter((citation) => {
      const baseline = input.baselines!.get(citation.key);
      if (!known.has(citation.key) || !baseline) return false;
      return !isReferenceEntry(citation.sentence, citation.key);
    });
    judgedCount += judgeable.length;
    const settled = await Promise.all(
      judgeable.map(async (citation) => {
        try {
          return {
            citation,
            judgement: await input.judge!.judge({
              key: citation.key,
              statement: citation.sentence,
              baseline: input.baselines!.get(citation.key)!,
            }),
          };
        } catch {
          return { citation, judgement: null };
        }
      }),
    );
    for (const { citation, judgement } of settled) {
      if (!judgement) {
        judgeErrors++;
        continue;
      }
      if (judgement.verdict !== "conflict") continue;
      conflictKeys.push(citation.key);
      findings.push({
        severity: "soft",
        artifactId,
        location,
        rule: CITATION_RULE,
        message:
          `citation_conflict (inferred): 草稿对 [@${citation.key}] 的陈述与该文献的精读卡不一致 — ` +
          `${judgement.reason}。句子："${citation.sentence.slice(0, 120)}"`,
        detail: {
          key: citation.key,
          sentence: citation.sentence,
          reason: judgement.reason,
          evidence: "inferred",
        },
      });
    }
  }

  // 判定器失效必须可见：降级不静默（否则「0 conflict」会被误读成「全都对得上」）。
  if (judgeErrors > 0) {
    findings.push({
      severity: "soft",
      artifactId,
      location,
      rule: CITATION_RULE,
      message:
        `citation_judge_unavailable: ${judgeErrors}/${judgedCount} 条引用的一致性判定未能完成，` +
        `这些引用的「陈述是否与文献相符」本次没有被检查过。`,
      detail: { judgeErrors, judgedCount },
    });
  }

  // ③ 强断言无引用支撑 → soft。
  if (input.checkUnsupportedClaims !== false) {
    for (const [index, sentence] of splitSentences(stripCode(input.draft)).entries()) {
      if (!isStrongClaim(sentence)) continue;
      // 非全局正则：避免 lastIndex 状态在多次 test 之间串味。
      if (/\[@[A-Za-z0-9]/.test(sentence)) continue;
      findings.push({
        severity: "soft",
        artifactId,
        location,
        rule: CITATION_RULE,
        message: `unsupported_claim: 强断言句没有引用支撑 — "${sentence.slice(0, 120)}"`,
        detail: { sentence, sentenceIndex: index },
      });
    }
  }

  return {
    findings,
    citations,
    unknownKeys: [...new Set(unknownKeys)],
    conflictKeys: [...new Set(conflictKeys)],
    judgedCount,
    judgeErrors,
  };
}

export function lineageFindings(artifact: ArtifactVersion, conflicts: LineageConflict[]): Finding[] {
  return conflicts.map((c) => {
    const message =
      c.type === "stale_input"
        ? `stale_input: artifact ${artifact.filename} 依赖的 ${c.artifact} 版本过期（latest ${c.latestVersionId}）`
        : `version_mix: artifact ${artifact.filename} 混用版本 ${c.versions.join(", ")}`;
    return {
      severity: "soft",
      artifactId: artifact.id,
      message,
      location: artifactLocation(artifact),
    };
  });
}
