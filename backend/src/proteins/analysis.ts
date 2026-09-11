import type { ConnectorRegistry } from "../connectors/registry";
import type { RecordStore } from "../project/records";
import type { ResearchRecord } from "../project/models";

// 蛋白分析链路（技能 protein-analysis，DESIGN §5.3）：
//   UniProt 查询 → RCSB PDB 实验结构元数据 → AlphaFold 预测模型链接
//
// 这是**纯读取**链路，三个 connector 一个也不带凭据。它与 P5 干实验的关系是前置：
// 先搞清楚「这个蛋白有没有实验结构、分辨率多少、AlphaFold 置信度多高」，
// 才谈得上拿哪个结构去跑 MD。

export interface ProteinIdentity {
  accession: string;
  entryName: string;
  proteinName: string;
  gene: string | null;
  organism: string | null;
  taxonId: number | null;
  sequenceLength: number | null;
  reviewed: boolean;
  functions: string[];
}

export interface StructureSummary {
  pdbId: string;
  title: string | null;
  method: string | null;
  // 埃（Å）；NMR/冷冻电镜可能没有。
  resolutionAngstrom: number | null;
  releasedAt: string | null;
  polymerEntityCount: number | null;
  url: string;
}

export interface AlphaFoldSummary {
  available: boolean;
  modelEntityId: string | null;
  latestVersion: number | null;
  // 全局 pLDDT（0-100）。<70 的区域不该当结构用。
  meanPlddt: number | null;
  fractionVeryHigh: number | null;
  fractionVeryLow: number | null;
  pdbUrl: string | null;
  cifUrl: string | null;
  paeUrl: string | null;
  note: string | null;
}

export interface ProteinAnalysisResult {
  query: string;
  identity: ProteinIdentity;
  experimentalStructureCount: number;
  structures: StructureSummary[];
  alphafold: AlphaFoldSummary;
  markdown: string;
  recordId: string | null;
}

export interface ProteinAnalysisOptions {
  registry: ConnectorRegistry;
  // 取几条实验结构的详细元数据（服务端截断，默认 3）。
  structureLimit?: number;
  records?: RecordStore;
}

export class ProteinAnalysisError extends Error {
  constructor(message: string) {
    super(`ProteinAnalysis: ${message}`);
    this.name = "ProteinAnalysisError";
  }
}

// UniProt 检索只取用得上的字段：默认响应把整条注释都带回来（几百 KB），
// 对这条链路是纯噪声，也会把 fixture 撑大。
const UNIPROT_FIELDS = "accession,id,protein_name,organism_name,length,gene_names,cc_function,reviewed";

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class ProteinAnalysis {
  private readonly registry: ConnectorRegistry;
  private readonly structureLimit: number;
  private readonly records?: RecordStore;

  constructor(options: ProteinAnalysisOptions) {
    this.registry = options.registry;
    this.structureLimit = options.structureLimit ?? 3;
    this.records = options.records;
  }

  // ① UniProt：自然语言/基因名/accession → 唯一条目。
  async identify(query: string): Promise<ProteinIdentity> {
    const raw = (await this.registry.call("uniprot", "search", {
      query,
      format: "json",
      size: 1,
      fields: UNIPROT_FIELDS,
    })) as { results?: unknown[] };
    const entry = (raw.results ?? [])[0] as Record<string, unknown> | undefined;
    if (!entry) throw new ProteinAnalysisError(`UniProt 没有匹配 '${query}' 的条目`);

    const description = entry.proteinDescription as
      | { recommendedName?: { fullName?: { value?: string } } }
      | undefined;
    const organism = entry.organism as { scientificName?: string; taxonId?: number } | undefined;
    const genes = (entry.genes as { geneName?: { value?: string } }[] | undefined) ?? [];
    const comments = (entry.comments as { commentType?: string; texts?: { value?: string }[] }[] | undefined) ?? [];

    return {
      accession: String(entry.primaryAccession ?? ""),
      entryName: String(entry.uniProtkbId ?? ""),
      proteinName: description?.recommendedName?.fullName?.value ?? String(entry.uniProtkbId ?? query),
      gene: genes[0]?.geneName?.value ?? null,
      organism: organism?.scientificName ?? null,
      taxonId: typeof organism?.taxonId === "number" ? organism.taxonId : null,
      sequenceLength: typeof entry.sequence === "object" && entry.sequence
        ? Number((entry.sequence as { length?: number }).length ?? 0) || null
        : typeof entry.length === "number"
          ? entry.length
          : null,
      reviewed: String(entry.entryType ?? "").includes("reviewed"),
      functions: comments
        .filter((c) => c.commentType === "FUNCTION")
        .flatMap((c) => (c.texts ?? []).map((t) => t.value).filter((v): v is string => Boolean(v))),
    };
  }

  // ② RCSB PDB：按 accession 取实验结构清单（服务端截断）+ 逐条取元数据。
  async structures(accession: string): Promise<{ total: number; entries: StructureSummary[] }> {
    let search: { total_count?: number; result_set?: { identifier?: string }[] };
    try {
      search = (await this.registry.call("pdb", "searchByUniProt", {
        accession,
        rows: this.structureLimit,
      })) as typeof search;
    } catch (error) {
      // RCSB 对「一条都没有」返回 204，connector 会当成非 2xx 抛错。
      // 没有实验结构是一个**正常结论**（正是 AlphaFold 存在的理由），不该让整条链路挂掉。
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP (204|404)/.test(message)) return { total: 0, entries: [] };
      throw error;
    }

    const ids = (search.result_set ?? [])
      .map((entry) => firstString(entry.identifier))
      .filter((id): id is string => id !== null)
      .slice(0, this.structureLimit);

    const entries: StructureSummary[] = [];
    for (const pdbId of ids) {
      // 串行：RCSB 没有明确的并发额度，同 P2 的礼貌纪律，不给公共 API 制造尖峰。
      const detail = (await this.registry.call("pdb", "getStructure", { pdbId })) as Record<string, unknown>;
      const info = (detail.rcsb_entry_info ?? {}) as Record<string, unknown>;
      const resolutions = (info.resolution_combined as number[] | undefined) ?? [];
      entries.push({
        pdbId,
        title: firstString((detail.struct as { title?: string } | undefined)?.title),
        method: firstString(((detail.exptl as { method?: string }[] | undefined) ?? [])[0]?.method),
        resolutionAngstrom: typeof resolutions[0] === "number" ? resolutions[0] : null,
        releasedAt: firstString(
          (detail.rcsb_accession_info as { initial_release_date?: string } | undefined)?.initial_release_date,
        ),
        polymerEntityCount: typeof info.polymer_entity_count === "number" ? info.polymer_entity_count : null,
        url: `https://www.rcsb.org/structure/${pdbId}`,
      });
    }
    return { total: Number(search.total_count ?? entries.length), entries };
  }

  // ③ AlphaFold：预测模型 + 全局置信度。
  async alphafold(accession: string): Promise<AlphaFoldSummary> {
    const empty: AlphaFoldSummary = {
      available: false,
      modelEntityId: null,
      latestVersion: null,
      meanPlddt: null,
      fractionVeryHigh: null,
      fractionVeryLow: null,
      pdbUrl: null,
      cifUrl: null,
      paeUrl: null,
      note: null,
    };
    let raw: unknown;
    try {
      raw = await this.registry.call("alphafold", "getModel", { id: accession });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 取不到模型（标识符非法 / 未收录 / 服务不可用）同样是**结论**，不是故障——
      // 整条链路不该因为第三段拿不到东西就全挂。
      return { ...empty, note: `AlphaFold 取不到 '${accession}' 的模型：${message}` };
    }
    const model = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
    if (!model) return { ...empty, note: "AlphaFold 返回空结果" };
    return {
      available: true,
      modelEntityId: firstString(model.modelEntityId),
      latestVersion: typeof model.latestVersion === "number" ? model.latestVersion : null,
      meanPlddt: typeof model.globalMetricValue === "number" ? model.globalMetricValue : null,
      fractionVeryHigh: typeof model.fractionPlddtVeryHigh === "number" ? model.fractionPlddtVeryHigh : null,
      fractionVeryLow: typeof model.fractionPlddtVeryLow === "number" ? model.fractionPlddtVeryLow : null,
      pdbUrl: firstString(model.pdbUrl),
      cifUrl: firstString(model.cifUrl),
      paeUrl: firstString(model.paeImageUrl),
      note: null,
    };
  }

  // 全链路。sessionId 给了就顺手把结果落成 observation record（evidence=sourced：
  // 这些数字是从外部数据库读来的，不是本地算出来的，也不是推出来的）。
  async analyze(
    query: string,
    options: { sessionId?: string | null; persist?: boolean } = {},
  ): Promise<ProteinAnalysisResult> {
    const identity = await this.identify(query);
    if (!identity.accession) throw new ProteinAnalysisError(`UniProt 条目缺少 accession（query='${query}'）`);
    const { total, entries } = await this.structures(identity.accession);
    const alphafold = await this.alphafold(identity.accession);
    const markdown = renderProteinReport(query, identity, total, entries, alphafold);

    let recordId: string | null = null;
    if (options.persist !== false && this.records) {
      const record: ResearchRecord = this.records.create({
        type: "observation",
        provenanceClass: "upstream",
        title: `蛋白分析 · ${identity.proteinName}（${identity.accession}）`,
        content: markdown,
        evidence: "sourced",
        origin: { kind: "connector", connector: "uniprot", sessionId: options.sessionId ?? null, ref: identity.accession },
        metadata: {
          kind: "protein_analysis",
          query,
          accession: identity.accession,
          entryName: identity.entryName,
          organism: identity.organism,
          sequenceLength: identity.sequenceLength,
          experimentalStructureCount: total,
          bestResolutionAngstrom: bestResolution(entries),
          pdbIds: entries.map((e) => e.pdbId),
          alphafoldMeanPlddt: alphafold.meanPlddt,
          alphafoldModelUrl: alphafold.pdbUrl,
        },
      });
      recordId = record.id;
    }

    return { query, identity, experimentalStructureCount: total, structures: entries, alphafold, markdown, recordId };
  }
}

export function bestResolution(entries: StructureSummary[]): number | null {
  const values = entries
    .map((entry) => entry.resolutionAngstrom)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.min(...values) : null;
}

// 报告正文由代码渲染（同 P4/P5 的纪律）：数字与链接必须是确定的。
export function renderProteinReport(
  query: string,
  identity: ProteinIdentity,
  total: number,
  structures: StructureSummary[],
  alphafold: AlphaFoldSummary,
): string {
  const lines: string[] = [];
  lines.push(`# 蛋白分析 · ${identity.proteinName}`);
  lines.push("");
  lines.push(`> 查询：\`${query}\` → UniProt \`${identity.accession}\`（${identity.entryName}）`);
  lines.push("");
  lines.push("## 身份");
  lines.push("");
  lines.push("| 字段 | 值 |");
  lines.push("|------|-----|");
  lines.push(`| accession | ${identity.accession} |`);
  lines.push(`| 基因 | ${identity.gene ?? "—"} |`);
  lines.push(`| 物种 | ${identity.organism ?? "—"}${identity.taxonId ? `（taxid ${identity.taxonId}）` : ""} |`);
  lines.push(`| 序列长度 | ${identity.sequenceLength ?? "—"} aa |`);
  lines.push(`| 审编状态 | ${identity.reviewed ? "Swiss-Prot（人工审编）" : "TrEMBL（自动注释）"} |`);
  if (identity.functions.length > 0) {
    lines.push("");
    lines.push("功能注释（UniProt FUNCTION）：");
    for (const fn of identity.functions) lines.push(`- ${fn}`);
  }

  lines.push("");
  lines.push(`## 实验结构（RCSB PDB，共 ${total} 条，下列为前 ${structures.length} 条）`);
  lines.push("");
  if (structures.length === 0) {
    lines.push("_没有检索到实验结构_ —— 这类蛋白只能靠预测模型，下面的 pLDDT 就是唯一的置信度依据。");
  } else {
    lines.push("| PDB | 方法 | 分辨率 (Å) | 发布 | 标题 |");
    lines.push("|-----|------|-----------|------|------|");
    for (const s of structures) {
      lines.push(
        `| [${s.pdbId}](${s.url}) | ${s.method ?? "—"} | ${s.resolutionAngstrom ?? "—"} | ` +
          `${s.releasedAt?.slice(0, 10) ?? "—"} | ${s.title ?? "—"} |`,
      );
    }
    const best = bestResolution(structures);
    if (best !== null) lines.push("");
    if (best !== null) lines.push(`最佳分辨率：**${best} Å**`);
  }

  lines.push("");
  lines.push("## AlphaFold 预测模型");
  lines.push("");
  if (!alphafold.available) {
    lines.push(`_不可用_ — ${alphafold.note ?? "AlphaFold DB 未收录"}`);
  } else {
    lines.push(`- 模型：\`${alphafold.modelEntityId}\`（v${alphafold.latestVersion}）`);
    lines.push(`- 全局 pLDDT：**${alphafold.meanPlddt ?? "—"}**（>90 极高置信 · 70-90 可信 · <70 不可当结构用）`);
    if (alphafold.fractionVeryHigh !== null) {
      lines.push(
        `- 残基置信分布：极高 ${(alphafold.fractionVeryHigh * 100).toFixed(1)}% · ` +
          `极低 ${((alphafold.fractionVeryLow ?? 0) * 100).toFixed(1)}%`,
      );
    }
    if (alphafold.pdbUrl) lines.push(`- 模型下载：[PDB](${alphafold.pdbUrl})` + (alphafold.cifUrl ? ` · [mmCIF](${alphafold.cifUrl})` : ""));
    if (alphafold.paeUrl) lines.push(`- PAE 图：${alphafold.paeUrl}`);
  }

  lines.push("");
  lines.push("## 拿哪个结构去跑干实验");
  lines.push("");
  const best = bestResolution(structures);
  if (best !== null && best <= 2.5) {
    lines.push(
      `优先用实验结构 **${structures.find((s) => s.resolutionAngstrom === best)!.pdbId}**（${best} Å）：` +
        `分辨率足够，预测模型在这里没有增量。`,
    );
  } else if (structures.length > 0) {
    lines.push(
      `实验结构分辨率偏低（最佳 ${best ?? "未知"} Å），若 AlphaFold pLDDT > 90 可作为交叉验证；` +
        `两者不一致的区域要单独标出来，不要挑一个顺眼的用。`,
    );
  } else if (alphafold.available && (alphafold.meanPlddt ?? 0) >= 90) {
    lines.push(`只有预测模型可用，但 pLDDT ${alphafold.meanPlddt} 属极高置信，可作为 MD 起始构象。`);
  } else {
    lines.push(`既无高质量实验结构、预测置信度也不高——**这一步应当停下**，而不是硬跑一个不可信的构象。`);
  }
  return lines.join("\n");
}
