import { beforeAll, describe, expect, test } from "bun:test";
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
//   平时（含 CI）：默认 replay 模式 → **照常执行**，回放 tests/fixtures/proteins/protein-analysis.json，零网络
//                  （另有一套独立的回放用例在 tests/unit/protein_e2e.test.ts，覆盖面不同，不是本文件的替代）
//
// 这个文件**不在** `bun test tests/unit` 的范围内（跑它用 `bun run test:integration`），不影响单测基线。

const MODE = fixtureModeFromEnv();
const RECORDING = MODE === "record" || MODE === "live";

// δ-1（USAGE_LOG U7）：这套用例**默认（replay）就跑**。
// 三个文件里每一个 HTTP 客户端都由 `fixtureHttp(cassette, MODE)` 构造，replay 下零网络，
// 所以「不要打网络」不等于「不要执行」——此前整个 describe 被 `skipIf(!RECORDING)` 关掉，
// `bun run test:integration` 恒定 `0 pass / 8 skip / 0 fail`，读起来像绿的却什么都没验。
// 现在只有 `FIXTURE_MODE` 决定打不打网络，不再决定跑不跑。
beforeAll(() => {
  if (RECORDING) {
    console.warn(`\n🌐 集成套件 FIXTURE_MODE=${MODE}——正在打真实网络${MODE === "record" ? "并重录 fixture" : "（不落盘）"}。`);
  } else {
    console.warn(
      `\n▶️ 集成套件 FIXTURE_MODE=${MODE}（回放录制好的响应，零网络）——` +
        "验的是本地管线逻辑，**不校验上游接口是否漂移**。\n" +
        "   要验上游：FIXTURE_MODE=live bun run test:integration（CI 里由每周的 integration-live job 跑）。",
    );
  }
});

describe("protein-analysis · UniProt → PDB → AlphaFold（FIXTURE_MODE 决定回放还是打网络）", () => {
  test(
    "UniProt → PDB → AlphaFold 三段链路",
    async () => {
      const analysis = proteinAnalysis(MODE);
      const result = await analysis.analyze(PROTEIN_QUERY, { persist: false });

      console.log(`\n[${MODE}] UniProt: ${result.identity.accession} ${result.identity.entryName}`);
      console.log(`  ${result.identity.proteinName} · ${result.identity.organism} · ${result.identity.sequenceLength} aa`);
      console.log(`[${MODE}] PDB: 共 ${result.experimentalStructureCount} 条，取前 ${result.structures.length} 条`);
      for (const s of result.structures) {
        console.log(`    · ${s.pdbId} ${s.method} ${s.resolutionAngstrom ?? "—"}Å ${s.title?.slice(0, 60)}`);
      }
      console.log(
        `[${MODE}] AlphaFold: ${result.alphafold.available ? result.alphafold.modelEntityId : "不可用"} ` +
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
      console.log(`\n[${MODE}] AlphaFold ${MISSING_ALPHAFOLD_ACCESSION}: available=${summary.available} note=${summary.note}`);
      expect(summary.available).toBe(false);
      expect(summary.note).toBeTruthy();
    },
    120_000,
  );
});
