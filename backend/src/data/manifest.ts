// v0.7 W7-D2 · L2 导出的 manifest（DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md §六、§7.6）。
//
// 命名对齐 Delta Sharing 的 share → schema → table 三级（将来的只读端点直接映射，不改格式）；
// 数据集描述取 DCAT 核心字段；许可用 SPDX 表达式（policy.ts 登记）。**v0.7 只有 manifest 形状**，
// 没有端点、没有 recipient、没有计费（用户 2026-09-11 决定：售卖环节不开发）。
//
// 单位 = 项目（§7.5）；同一项目后续增量用 `--since`，manifest 带 `prevManifestHash` 成链。

import { createHash } from "node:crypto";

export const MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestTableCounts {
  [table: string]: number;
}

export interface ExportManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  /** Delta Sharing 的 share 名 = 项目 slug。 */
  share: string;
  generator: { name: "spark-research"; version: string };
  createdAt: string;
  range: { since: string | null; until: string | null };
  forSharing: boolean;
  /** 增量导出时指向上一份 manifest 的 hash；首份为 null。 */
  prevManifestHash: string | null;
  dcat: {
    title: string;
    description: string;
    issued: string;
    modified: string;
    publisher: string | null;
    /** 数据集整体许可：for-sharing 时全部行都可出门时取其公约数，否则 mixed。 */
    license: string;
  };
  schemas: {
    records: { tables: ManifestTableCounts };
    records_journal: { count: number };
    edges: { count: number };
    raw: { tables: ManifestTableCounts };
    artifacts: { versions: number; dependencies: number; executionRecords: number };
    library: { papers: number };
    usage: { present: boolean };
  };
  licenses: ManifestTableCounts;
  provenanceClasses: ManifestTableCounts;
  /** for-sharing 下被排除/打桩的计数（AD-16 的可见面）。 */
  excluded: { recordsStubbed: number; journalStubbed: number; rawDropped: number; libraryDropped: number; llmPromptsHashed: number };
  /** 所有数据文件（不含 manifest 自身）的 (相对路径, sha256) 排序后再 sha256。 */
  rootHash: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function rootHashOf(files: Array<{ path: string; sha256: string }>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(sorted.map((f) => `${f.path}\t${f.sha256}`).join("\n"));
}

/** manifest 自身的 hash（链用）：整个 JSON canonical 后 sha256。 */
export function manifestHash(manifest: ExportManifest): string {
  return sha256Hex(JSON.stringify(manifest));
}
