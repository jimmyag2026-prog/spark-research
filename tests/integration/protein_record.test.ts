import { describe, expect, test } from "bun:test";
import { fixtureModeFromEnv } from "../../backend/src/http/fixture";
import {
  MISSING_ALPHAFOLD_ACCESSION,
  PROTEIN_ACCESSION,
  PROTEIN_ENTRY_NAME,
  PROTEIN_QUERY,
  proteinAnalysis,
} from "../helpers/protein_scenario";

// P5 protein-analysis 真实网络验证 + fixture 录制
//（DEVELOPMENT_PLAN 三、「e2e 真实：本地验证 + 录制 fixture」）。
//
//   本地录制：FIXTURE_MODE=record bun test tests/integration/protein_record.test.ts
//   平时（含 CI）：默认 replay 模式 → 整个套件跳过（回放版在 tests/unit/protein_e2e.test.ts）
//
// 这个文件**不在** `bun test tests/unit` 的范围内，不影响单测基线。

const MODE = fixtureModeFromEnv();
const RECORDING = MODE === "record" || MODE === "live";

describe.skipIf(!RECORDING)("真实网络 · protein-analysis 链路录制", () => {
  test(
    "UniProt → PDB → AlphaFold 三段链路",
    async () => {
      const analysis = proteinAnalysis(MODE);
      const result = await analysis.analyze(PROTEIN_QUERY, { persist: false });

      console.log(`\n[record] UniProt: ${result.identity.accession} ${result.identity.entryName}`);
      console.log(`  ${result.identity.proteinName} · ${result.identity.organism} · ${result.identity.sequenceLength} aa`);
      console.log(`[record] PDB: 共 ${result.experimentalStructureCount} 条，取前 ${result.structures.length} 条`);
      for (const s of result.structures) {
        console.log(`    · ${s.pdbId} ${s.method} ${s.resolutionAngstrom ?? "—"}Å ${s.title?.slice(0, 60)}`);
      }
      console.log(
        `[record] AlphaFold: ${result.alphafold.available ? result.alphafold.modelEntityId : "不可用"} ` +
          `pLDDT=${result.alphafold.meanPlddt}`,
      );

      expect(result.identity.accession).toBe(PROTEIN_ACCESSION);
      expect(result.identity.entryName).toBe(PROTEIN_ENTRY_NAME);
      expect(result.structures.length).toBeGreaterThan(0);
      expect(result.alphafold.available).toBe(true);
    },
    180_000,
  );

  test(
    "AlphaFold 未收录的 accession：是结论不是故障",
    async () => {
      const analysis = proteinAnalysis(MODE);
      const summary = await analysis.alphafold(MISSING_ALPHAFOLD_ACCESSION);
      console.log(`\n[record] AlphaFold ${MISSING_ALPHAFOLD_ACCESSION}: available=${summary.available} note=${summary.note}`);
      expect(summary.available).toBe(false);
      expect(summary.note).toBeTruthy();
    },
    120_000,
  );
});
