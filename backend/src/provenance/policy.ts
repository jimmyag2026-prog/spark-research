// v0.7 W7-D0 · L3 来源分级（DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md §七）。
//
// 这张表回答两个问题：「这条数据是从哪来的（class）」和「它带着什么许可（license）」。
// 它是回流/导出时 `shareable()` 的唯一判据来源——AD-16：`upstream` 永不进入共享集合。
//
// **这里登记的 license 是「来源自述的许可标识」，不是法律意见。** 公共源用其官方声明的
// SPDX 标识；查不到明确 SPDX 的用 `LicenseRef-<源>-terms` 指向该源的使用条款；带凭据协议
// 的源一律 `LicenseRef-proprietary-<源>`。用户/模型产出先占位 `LicenseRef-spark-user-owned`
// （售卖阶段再定真实许可文本——用户 2026-09-11 决定）。
//
// 门禁（tests/unit/provenance.test.ts）：`BUILTIN_CONNECTORS` 里的每个 connector 在
// `CONNECTOR_LICENSES` 里必须有条目——V34「能力做好了、默认表没跟上」的形状，靠测试对账
// 而不是靠自觉。

import type { RecordOrigin, RecordType } from "../project/models";

export const PROVENANCE_CLASSES = ["upstream", "derived", "user_authored", "model_generated"] as const;
export type ProvenanceClass = (typeof PROVENANCE_CLASSES)[number];

/** 用户/模型产出的占位许可（SPDX `LicenseRef-` 语法）。真实许可文本售卖阶段再定。 */
export const USER_OWNED_LICENSE = "LicenseRef-spark-user-owned";
/** 来源许可查不到时的诚实取值——不编造 SPDX。`shareable()` 对它一律拒绝。 */
export const UNKNOWN_LICENSE = "unknown";

export function proprietaryLicense(connector: string): string {
  return `LicenseRef-proprietary-${connector}`;
}

/**
 * 内置 connector → 来源自述许可。键集合与 `connectors/registry.ts` 的 BUILTIN_CONNECTORS
 * 逐字一致（门禁核）。带凭据协议的三个中文源标 proprietary；其余按各源官方声明。
 */
export const CONNECTOR_LICENSES: Readonly<Record<string, string>> = {
  // proteins
  uniprot: "CC-BY-4.0",
  pdb: "CC0-1.0",
  alphafold: "CC-BY-4.0",
  // genomics
  ensembl: "LicenseRef-ensembl-terms",
  ncbi: "LicenseRef-ncbi-terms",
  cncb: "LicenseRef-cncb-terms",
  clinvar: "LicenseRef-ncbi-terms",
  // chemistry
  chembl: "CC-BY-SA-3.0",
  pubchem: "LicenseRef-pubchem-terms",
  // literature
  pubmed: "LicenseRef-ncbi-terms",
  arxiv: "CC0-1.0",
  openalex: "CC0-1.0",
  crossref: "LicenseRef-crossref-terms",
  europepmc: "LicenseRef-europepmc-terms",
  semanticscholar: "ODC-By-1.0",
  aminer: proprietaryLicense("aminer"),
  cnki: proprietaryLicense("cnki"),
  wanfang: proprietaryLicense("wanfang"),
  biorxiv: "LicenseRef-biorxiv-terms",
  // pathways
  reactome: "CC0-1.0",
  "string-db": "CC-BY-4.0",
};

export function connectorLicense(connector: string | null | undefined): string {
  if (!connector) return UNKNOWN_LICENSE;
  return CONNECTOR_LICENSES[connector] ?? UNKNOWN_LICENSE;
}

/** 凭据源的原始响应体默认只存 hash 不存 inline（ToS 风险）——判据就是 license 前缀。 */
export function isProprietaryLicense(license: string | null | undefined): boolean {
  return typeof license === "string" && license.startsWith("LicenseRef-proprietary-");
}

/**
 * 写入方没显式声明时的兜底推断，也是老库回填（§五 回填规则）的唯一口径：
 * connector 来的是 upstream；agent_run 是 model_generated；manual/import 是 user_authored；
 * 其余（session/cell）保守记 derived。**生产写入方应显式声明**（源码门禁核），这里只兜底。
 */
export function classForOrigin(origin: RecordOrigin, type: RecordType): ProvenanceClass {
  if (origin.kind === "connector") return "upstream";
  if (type === "agent_run") return "model_generated";
  if (origin.kind === "manual" || origin.kind === "import") return "user_authored";
  return "derived";
}

export function licenseForClass(cls: ProvenanceClass, origin: RecordOrigin): string {
  return cls === "upstream" ? connectorLicense(origin.connector) : USER_OWNED_LICENSE;
}

export interface ShareVerdict {
  ok: boolean;
  reason: string;
}

/** §7.3：三条规则，写死、可测。不做「部分共享」「脱敏后共享」。 */
export function shareable(entry: { provenanceClass: ProvenanceClass; license: string | null }): ShareVerdict {
  if (entry.provenanceClass === "upstream") {
    return { ok: false, reason: "AD-16：upstream（上游镜像）永不进入共享集合" };
  }
  if (!entry.license || entry.license === UNKNOWN_LICENSE) {
    return { ok: false, reason: "license 未知，不出门" };
  }
  if (isProprietaryLicense(entry.license)) {
    return { ok: false, reason: `license ${entry.license} 为凭据协议源，不出门` };
  }
  return { ok: true, reason: `${entry.provenanceClass} · ${entry.license}` };
}
