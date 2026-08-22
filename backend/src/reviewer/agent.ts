import { LineageGraph } from "../artifacts/lineage.ts";
import type { ArtifactVersion, ExecutionRecord } from "../artifacts/models.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import type { Finding, ReviewResult } from "./rules.ts";
import { artifactLocation, findProducingCell, hasClaim, isFigureOrReport, lineageFindings } from "./rules.ts";

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

export class ReviewerAgent {
  static readonly ALLOWED_TOOLS = ALLOWED_TOOLS;
  static readonly DISABLED_TOOLS = DISABLED_TOOLS;

  constructor(
    private store: ArtifactStore,
    private executionLog: ExecutionRecord[],
    private graph: LineageGraph,
  ) {}

  async review(sessionId: string): Promise<ReviewResult> {
    const artifacts = await this.store.listBySession(sessionId);
    const findings: Finding[] = [];

    for (const artifact of artifacts) {
      findings.push(...this.checkTraceability(artifact));
      findings.push(...this.checkLineage(artifact));
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

  private applyLocationWeight(findings: Finding[], artifacts: ArtifactVersion[]): Finding[] {
    return findings.map((f) => {
      const artifact = artifacts.find((a) => a.id === f.artifactId);
      if (!artifact || !isFigureOrReport(artifact)) return f;
      if (f.severity === "soft") {
        return { ...f, severity: "hard" };
      }
      return f;
    });
  }
}
