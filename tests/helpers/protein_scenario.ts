import { join } from "node:path";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { FixtureHttp, type FixtureMode } from "../../backend/src/http/fixture";
import { ProteinAnalysis } from "../../backend/src/proteins/analysis";

// P5 protein-analysis e2e 的单一真源。
//
// 录制（tests/integration/protein_record.test.ts）与回放（tests/unit/protein_e2e.test.ts）
// **必须**共用这里的查询与参数，否则 fixture key 对不上，回放会 miss。
// 换句话说：下面任何一个常量改了，就必须重新录制 fixture。

export const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "proteins");
export const PROTEIN_CASSETTE = "protein-analysis";

// 人类血红蛋白 β 链：Swiss-Prot 审编、实验结构数百条、AlphaFold 也收录，
// 三段链路都有真实内容可断言（不像很多蛋白只有其中一段）。
export const PROTEIN_QUERY = "hemoglobin subunit beta AND organism_id:9606 AND reviewed:true";
export const PROTEIN_ACCESSION = "P68871";
export const PROTEIN_ENTRY_NAME = "HBB_HUMAN";
export const PROTEIN_SEQUENCE_LENGTH = 147;
// 取 3 条：RCSB 在**服务端**截断，不然血红蛋白 350 条结构会把 cassette 撑爆。
export const STRUCTURE_LIMIT = 3;

// AlphaFold 取不到模型的对照，用来验证「没有模型」是结论不是故障。
// 实测：AlphaFold DB 对**任何格式合法**的 accession 都会返回 200（哪怕 pLDDT 只有 57），
// 所以「未收录」这条路径只能用格式非法的标识符触发（返回 400）。
export const MISSING_ALPHAFOLD_ACCESSION = "ZZZ999";

export function proteinHttp(mode: FixtureMode): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette: PROTEIN_CASSETTE, mode });
}

export function proteinRegistry(mode: FixtureMode): ConnectorRegistry {
  return new ConnectorRegistry({ http: proteinHttp(mode) }).registerBuiltins();
}

export function proteinAnalysis(mode: FixtureMode, records?: ConstructorParameters<typeof ProteinAnalysis>[0]["records"]): ProteinAnalysis {
  return new ProteinAnalysis({
    registry: proteinRegistry(mode),
    structureLimit: STRUCTURE_LIMIT,
    records,
  });
}
