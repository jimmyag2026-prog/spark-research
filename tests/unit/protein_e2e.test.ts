import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { ProteinAnalysisError, bestResolution, renderProteinReport } from "../../backend/src/proteins/analysis";
import {
  MISSING_ALPHAFOLD_ACCESSION,
  PROTEIN_ACCESSION,
  PROTEIN_ENTRY_NAME,
  PROTEIN_QUERY,
  PROTEIN_SEQUENCE_LENGTH,
  STRUCTURE_LIMIT,
  proteinAnalysis,
} from "../helpers/protein_scenario";

// P5 技能 protein-analysis 的 e2e（AD-5：每个技能必须有配套 e2e 才算完成）。
//
// 数据是**本阶段真实录制**的 fixture 回放（tests/fixtures/proteins/protein-analysis.json，
// 录制脚本 tests/integration/protein_record.test.ts）。零网络，CI 可跑。

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "protein-e2e-"));
  const manager = new ProjectManager(root);
  return manager.create("protein");
}

describe("protein-analysis e2e · UniProt → PDB → AlphaFold（fixture 回放）", () => {
  test("① UniProt 查询：拿到唯一条目与身份字段", async () => {
    const identity = await proteinAnalysis("replay").identify(PROTEIN_QUERY);
    expect(identity.accession).toBe(PROTEIN_ACCESSION);
    expect(identity.entryName).toBe(PROTEIN_ENTRY_NAME);
    expect(identity.proteinName).toBe("Hemoglobin subunit beta");
    expect(identity.gene).toBe("HBB");
    expect(identity.organism).toBe("Homo sapiens");
    expect(identity.taxonId).toBe(9606);
    expect(identity.sequenceLength).toBe(PROTEIN_SEQUENCE_LENGTH);
    expect(identity.reviewed).toBe(true);
    expect(identity.functions.length).toBeGreaterThan(0);
    expect(identity.functions[0]).toContain("oxygen transport");
  });

  test("② PDB 结构元数据：服务端截断 + 逐条元数据", async () => {
    const { total, entries } = await proteinAnalysis("replay").structures(PROTEIN_ACCESSION);
    // 血红蛋白有几百条结构；我们只取前 N 条，total 仍如实报出。
    expect(total).toBe(350);
    expect(entries.length).toBe(STRUCTURE_LIMIT);
    expect(entries.map((e) => e.pdbId)).toEqual(["1A00", "1A01", "1A0U"]);
    for (const entry of entries) {
      expect(entry.method).toBe("X-RAY DIFFRACTION");
      expect(entry.resolutionAngstrom).toBeGreaterThan(0);
      expect(entry.title).toBeTruthy();
      expect(entry.releasedAt).toBeTruthy();
      expect(entry.url).toBe(`https://www.rcsb.org/structure/${entry.pdbId}`);
    }
    expect(bestResolution(entries)).toBe(1.8);
  });

  test("③ AlphaFold 模型链接与置信度", async () => {
    const model = await proteinAnalysis("replay").alphafold(PROTEIN_ACCESSION);
    expect(model.available).toBe(true);
    expect(model.modelEntityId).toBe("AF-P68871-F1");
    expect(model.meanPlddt).toBeCloseTo(97.19, 2);
    expect(model.latestVersion).toBeGreaterThanOrEqual(6);
    expect(model.pdbUrl).toContain("AF-P68871-F1");
    expect(model.pdbUrl).toStartWith("https://alphafold.ebi.ac.uk/");
    expect(model.cifUrl).toBeTruthy();
    expect(model.paeUrl).toBeTruthy();
    expect(model.note).toBeNull();
  });

  test("全链路 analyze：报告可查 + observation 入证据图", async () => {
    const project = workspace();
    const records = project.records();
    const result = await proteinAnalysis("replay", records).analyze(PROTEIN_QUERY, { sessionId: "s1" });

    expect(result.identity.accession).toBe(PROTEIN_ACCESSION);
    expect(result.experimentalStructureCount).toBe(350);
    expect(result.structures.length).toBe(STRUCTURE_LIMIT);
    expect(result.alphafold.available).toBe(true);

    // 报告：三段都在，链接与数字都是代码渲染出来的确定值。
    expect(result.markdown).toContain("# 蛋白分析 · Hemoglobin subunit beta");
    expect(result.markdown).toContain("UniProt `P68871`");
    expect(result.markdown).toContain("[1A01](https://www.rcsb.org/structure/1A01)");
    expect(result.markdown).toContain("最佳分辨率：**1.8 Å**");
    expect(result.markdown).toContain("AF-P68871-F1");
    expect(result.markdown).toContain("97.19");
    // 结论段落：1.8 Å 的实验结构在，就该优先用实验结构。
    expect(result.markdown).toContain("优先用实验结构 **1A01**");

    // 证据图：一条 observation，evidence=sourced（数据是读来的，不是算的也不是推的）。
    const record = records.get(result.recordId!)!;
    expect(record.type).toBe("observation");
    expect(record.evidence).toBe("sourced");
    expect(record.origin.kind).toBe("connector");
    expect(record.origin.connector).toBe("uniprot");
    expect(record.origin.sessionId).toBe("s1");
    const meta = record.metadata as Record<string, unknown>;
    expect(meta.kind).toBe("protein_analysis");
    expect(meta.accession).toBe(PROTEIN_ACCESSION);
    expect(meta.pdbIds).toEqual(["1A00", "1A01", "1A0U"]);
    expect(meta.bestResolutionAngstrom).toBe(1.8);
    expect(meta.alphafoldMeanPlddt).toBeCloseTo(97.19, 2);
    project.close();
  });

  test("persist:false 时不落 record（只看不记）", async () => {
    const project = workspace();
    const records = project.records();
    const result = await proteinAnalysis("replay", records).analyze(PROTEIN_QUERY, { persist: false });
    expect(result.recordId).toBeNull();
    expect(records.count()).toBe(0);
    project.close();
  });

  test("AlphaFold 取不到模型是结论不是故障（真实录制的 HTTP 400）", async () => {
    const model = await proteinAnalysis("replay").alphafold(MISSING_ALPHAFOLD_ACCESSION);
    expect(model.available).toBe(false);
    expect(model.note).toContain(MISSING_ALPHAFOLD_ACCESSION);
    expect(model.note).toContain("HTTP 400");
    expect(model.pdbUrl).toBeNull();
  });

  test("UniProt 查不到条目时明确报错（不返回空壳）", async () => {
    // fixture 里没有这条查询 → FixtureMiss；真实环境是 results:[]。
    // 两种情况都必须是「抛错」而不是「返回一个空的身份」。
    await expect(proteinAnalysis("replay").identify("no-such-protein-query-xyz")).rejects.toThrow();
  });
});

describe("protein-analysis · 报告渲染（纯函数）", () => {
  const identity = {
    accession: "Q9XXXX",
    entryName: "TEST_HUMAN",
    proteinName: "Test protein",
    gene: "TST",
    organism: "Homo sapiens",
    taxonId: 9606,
    sequenceLength: 100,
    reviewed: false,
    functions: [],
  };
  const alphafoldHigh = {
    available: true,
    modelEntityId: "AF-Q9XXXX-F1",
    latestVersion: 4,
    meanPlddt: 95,
    fractionVeryHigh: 0.9,
    fractionVeryLow: 0.01,
    pdbUrl: "https://example.invalid/model.pdb",
    cifUrl: null,
    paeUrl: null,
    note: null,
  };

  test("没有实验结构 + 高 pLDDT → 建议用预测模型", () => {
    const text = renderProteinReport("q", identity, 0, [], alphafoldHigh);
    expect(text).toContain("_没有检索到实验结构_");
    expect(text).toContain("可作为 MD 起始构象");
    expect(text).toContain("TrEMBL（自动注释）");
  });

  test("既无好结构也无高置信模型 → 明说这一步该停下", () => {
    const text = renderProteinReport("q", identity, 0, [], { ...alphafoldHigh, available: false, note: "未收录" });
    expect(text).toContain("这一步应当停下");
    expect(text).toContain("_不可用_");
  });

  test("实验结构分辨率偏低 → 要求交叉验证而不是挑顺眼的用", () => {
    const structures = [
      {
        pdbId: "9ABC",
        title: "low res",
        method: "X-RAY DIFFRACTION",
        resolutionAngstrom: 3.4,
        releasedAt: "2020-01-01T00:00:00.000+00:00",
        polymerEntityCount: 1,
        url: "https://www.rcsb.org/structure/9ABC",
      },
    ];
    const text = renderProteinReport("q", identity, 1, structures, alphafoldHigh);
    expect(text).toContain("分辨率偏低");
    expect(text).toContain("不要挑一个顺眼的用");
    expect(bestResolution(structures)).toBe(3.4);
  });

  test("bestResolution 忽略没有分辨率的条目（NMR/冷冻电镜）", () => {
    expect(
      bestResolution([
        { pdbId: "A", title: null, method: "SOLUTION NMR", resolutionAngstrom: null, releasedAt: null, polymerEntityCount: null, url: "" },
      ]),
    ).toBeNull();
  });

  test("ProteinAnalysisError 带模块前缀，便于定位", () => {
    expect(new ProteinAnalysisError("x").message).toBe("ProteinAnalysis: x");
  });
});
