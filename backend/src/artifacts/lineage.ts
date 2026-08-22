import type { DependencyEdge } from "./models";

export interface VersionMeta {
  id: string;
  filename: string;
  version: number;
}

export type LineageConflict =
  | { type: "stale_input"; versionId: string; artifact: string; latestVersionId: string }
  | { type: "version_mix"; versionId: string; artifact: string; versions: string[] };

export interface LineageGraphData {
  versionId: string;
  nodes: { id: string; filename: string; version: number }[];
  edges: DependencyEdge[];
}

export class LineageGraph {
  private edges = new Map<string, Set<string>>();
  private versions = new Map<string, VersionMeta>();

  constructor(versions: VersionMeta[] = []) {
    for (const v of versions) this.versions.set(v.id, v);
  }

  addEdge(sourceVersionId: string, targetVersionId: string): void {
    let sources = this.edges.get(targetVersionId);
    if (!sources) {
      sources = new Set();
      this.edges.set(targetVersionId, sources);
    }
    sources.add(sourceVersionId);
  }

  registerVersion(meta: VersionMeta): void {
    this.versions.set(meta.id, meta);
  }

  private ancestors(versionId: string): Set<string> {
    const result = new Set<string>();
    const stack = [versionId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const src of this.edges.get(cur) ?? []) {
        if (!result.has(src)) {
          result.add(src);
          stack.push(src);
        }
      }
    }
    return result;
  }

  getGraph(versionId: string): LineageGraphData {
    const anc = this.ancestors(versionId);
    anc.add(versionId);
    const nodes = [...anc].map((id) => {
      const meta = this.versions.get(id);
      return meta
        ? { id, filename: meta.filename, version: meta.version }
        : { id, filename: id, version: 0 };
    });
    const edges: DependencyEdge[] = [];
    for (const [target, sources] of this.edges) {
      if (!anc.has(target)) continue;
      for (const source of sources) {
        if (anc.has(source)) {
          edges.push({ sourceVersionId: source, targetVersionId: target });
        }
      }
    }
    return { versionId, nodes, edges };
  }

  hasVersionConflicts(versionId: string): LineageConflict[] {
    const anc = this.ancestors(versionId);
    const conflicts: LineageConflict[] = [];
    if (anc.size === 0) return conflicts;

    const latestByFile = new Map<string, VersionMeta>();
    for (const meta of this.versions.values()) {
      const cur = latestByFile.get(meta.filename);
      if (!cur || meta.version > cur.version) latestByFile.set(meta.filename, meta);
    }

    const byFile = new Map<string, string[]>();
    for (const id of anc) {
      const meta = this.versions.get(id);
      if (!meta) continue;
      const list = byFile.get(meta.filename) ?? [];
      list.push(id);
      byFile.set(meta.filename, list);
    }

    for (const [file, ids] of byFile) {
      const unique = [...new Set(ids)];
      if (unique.length > 1) {
        conflicts.push({ type: "version_mix", versionId, artifact: file, versions: unique });
      }
    }

    for (const id of anc) {
      const meta = this.versions.get(id);
      if (!meta) continue;
      const latest = latestByFile.get(meta.filename);
      if (latest && latest.id !== id) {
        conflicts.push({ type: "stale_input", versionId, artifact: meta.filename, latestVersionId: latest.id });
      }
    }

    return conflicts;
  }
}
