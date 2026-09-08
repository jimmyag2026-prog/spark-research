import { LineageGraph } from "../artifacts/lineage.ts";
import type { ArtifactVersion, ExecutionRecord } from "../artifacts/models.ts";
import { ArtifactStore } from "../artifacts/store.ts";
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

export interface ReviewerOptions {
  citations?: CitationCheckConfig;
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

    for (const artifact of artifacts) {
      findings.push(...this.checkTraceability(artifact));
      findings.push(...this.checkLineage(artifact));
      findings.push(...(await this.checkCitations(artifact)));
    }

    const weighted = this.applyLocationWeight(findings, artifacts);
    const hard = weighted.filter((f) => f.severity === "hard");

    if (hard.length > 0) {
      return {
        approved: false,
        findings: weighted,
        action: "inject_notice_and_veto_completion",
        notice: `Review vetoed: ${hard.length} hard finding(s) found. Findings injected; completion blocked.`,
      };
    }
    return { approved: true, findings: weighted };
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

  // 只对 markdown 类 artifact 跑引用核验（综述草稿、报告）。
  private async checkCitations(artifact: ArtifactVersion): Promise<Finding[]> {
    const config = this.options.citations;
    if (!config || artifact.contentType !== "text/markdown") return [];
    const stored = this.store.get(artifact.id);
    if (!stored) return [];
    const result = await citationIntegrity({
      draft: stored.content,
      knownKeys: config.knownKeys,
      baselines: config.baselines,
      judge: config.judge,
      artifactId: artifact.id,
      location: artifactLocation(artifact),
    });
    return result.findings;
  }

  private applyLocationWeight(findings: Finding[], artifacts: ArtifactVersion[]): Finding[] {
    return findings.map((f) => {
      // citation-integrity 的严重度由规则自身定义（hard=伪造引用，soft=推断类提示），
      // 不受「figure/report 里 soft 升 hard」的位置加权影响——否则 soft 提示会变成误杀。
      if (f.rule === CITATION_RULE) return f;
      const artifact = artifacts.find((a) => a.id === f.artifactId);
      if (!artifact || !isFigureOrReport(artifact)) return f;
      if (f.severity === "soft") {
        return { ...f, severity: "hard" };
      }
      return f;
    });
  }
}
