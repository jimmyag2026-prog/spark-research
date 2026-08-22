import type { LineageConflict } from "../artifacts/lineage.ts";
import type { ArtifactVersion, ExecutionRecord } from "../artifacts/models.ts";

export type Severity = "hard" | "soft";

export interface Finding {
  severity: Severity;
  artifactId: string;
  message: string;
  location: string;
}

export type ReviewAction = "inject_notice_and_veto_completion";

export interface ReviewResult {
  approved: boolean;
  findings: Finding[];
  action?: ReviewAction;
  notice?: string;
}

export function hasClaim(artifact: ArtifactVersion): boolean {
  return artifact.extractedCode != null;
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
