import { join } from "node:path";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { FixtureHttp, type FixtureMode } from "../../backend/src/http/fixture";
import { LiteratureSearcher } from "../../backend/src/literature/search";
import type { LiteratureSource } from "../../backend/src/literature/models";

// P2 e2e 场景的单一真源。
// 录制（tests/integration/literature_record.test.ts）与回放（tests/unit/literature_e2e.test.ts）
// **必须**共用这里的参数，否则 fixture key 对不上，回放会 miss。
// 换句话说：任何一个常量改了，就必须重新录制 fixture。

export const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "literature");

export const SEARCH_QUERY = "AlphaFold protein structure prediction";
export const SEARCH_SOURCES: LiteratureSource[] = ["openalex", "crossref", "europepmc", "semanticscholar"];
export const PER_SOURCE = 10;

// AlphaFold 的 Nature 论文，元数据在四个源里都稳定存在。
export const ADD_DOI = "10.1038/s41586-021-03819-2";

// PDF 真实下载的两个样本：arXiv 一篇 + Europe PMC 一篇。
export const ARXIV_SAMPLE = {
  title: "Attention Is All You Need",
  arxivId: "1706.03762",
  year: 2017,
  author: "Ashish Vaswani",
};
// 必须挑 Europe PMC **OA 子集内**的文章（isOpenAccess=Y 且 inEPMC=Y），
// 否则 ?pdf=render 也拿不到 PDF。PMC8371605（AlphaFold 那篇）就不在 OA 子集里。
export const EUROPEPMC_SAMPLE = {
  title: "Adversarial Sequence Mutations in AlphaFold and ESMFold Reveal Nonphysical Predictions",
  pmcid: "PMC13311257",
  year: 2025,
  author: "Anonymous Author",
};

export const CASSETTES = {
  search: "search-alphafold",
  fetchById: "fetch-by-id",
  pdf: "pdf-download",
  aminer: "aminer-search",
} as const;

export function fixtureHttp(cassette: string, mode: FixtureMode): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette, mode });
}

export function searcherWith(cassette: string, mode: FixtureMode): LiteratureSearcher {
  // cassette 在 perSource=10 下录制（FixtureHttp 精确匹配 URL）；blended 深池默认 30 会 miss，
  // 这里如实按录制条件注入 deepPool=10，不改生产默认。
  return new LiteratureSearcher(
    new ConnectorRegistry({ http: fixtureHttp(cassette, mode) }).registerBuiltins(),
    { deepPool: 10 },
  );
}
