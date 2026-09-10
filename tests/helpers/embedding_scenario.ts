import { join } from "node:path";
import { FixtureHttp, type FixtureMode } from "../../backend/src/http/fixture";
import { embeddingCassette } from "../../backend/src/llm/embeddings/calibration";
import { EmbeddingRouter } from "../../backend/src/llm/embeddings/router";
import { paperEmbedText } from "../../backend/src/ideation/affinity";
import { emptyPaper, type Paper } from "../../backend/src/literature/models";

// C4 标定/回放场景的单一真源。
//
// 录制（FIXTURE_MODE=record，对着本机 Ollama）与回放（默认，CI 零网络）**必须**共用这里的
// 模型 id、baseUrl 与文本构造——否则 fixture key（method + 规范化 URL + body 哈希）对不上，
// 回放会 FixtureMiss。任何一处改了都必须重新录制。

export const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "embeddings");
export const CALIBRATION_PATH = join(import.meta.dir, "..", "fixtures", "novelty", "calibration.json");

/** 已标定并录过磁带的模型。换模型 = 重录 + 重标定。 */
export const CALIBRATED_MODEL = "local/bge-m3";

/** 录制时用的本地端点。回放时这个值只参与 fixture key 的计算，不会真的被访问。 */
export const LOCAL_BASE_URL = "http://localhost:11434/v1";

export interface CalibrationPaper {
  key: string;
  identity: string;
  cassette: string;
  title: string;
  year: number | null;
  abstract: string;
}

export interface CalibrationClaim {
  id: string;
  lang: string;
  expected: "existing" | "novel";
  cassette: string;
  claim: string;
  queries: string[];
  positives: string[];
  negatives: string[];
}

export interface CalibrationFixture {
  note: string;
  textRule: string;
  papers: CalibrationPaper[];
  claims: CalibrationClaim[];
}

export async function loadCalibration(): Promise<CalibrationFixture> {
  return JSON.parse(await Bun.file(CALIBRATION_PATH).text()) as CalibrationFixture;
}

/** 标定语料里的一条 → 一个 Paper（走生产的 paperEmbedText，不另写一份文本规则）。 */
export function calibrationPaperAsPaper(paper: CalibrationPaper): Paper {
  return { ...emptyPaper(), title: paper.title, abstract: paper.abstract, year: paper.year };
}

export function calibrationPaperText(paper: CalibrationPaper): string {
  return paperEmbedText(calibrationPaperAsPaper(paper));
}

export function embeddingFixtureHttp(modelId: string, mode: FixtureMode): FixtureHttp {
  return new FixtureHttp({ dir: FIXTURE_DIR, cassette: embeddingCassette(modelId), mode });
}

/**
 * 回放（或录制）用的 router。**不读真实 config**：modelId 显式注入，env 只给本地 baseUrl，
 * 免得开发机上的 SPARK_RESEARCH_EMBEDDING_MODEL 把测试带偏。
 */
export function fixtureEmbeddingRouter(
  modelId: string,
  mode: FixtureMode,
  cassetteModelId = modelId,
): EmbeddingRouter {
  return new EmbeddingRouter({
    modelId,
    env: { SPARK_LOCAL_LLM_BASE_URL: LOCAL_BASE_URL },
    http: embeddingFixtureHttp(cassetteModelId, mode),
    timeoutMs: 600_000,
  });
}

/**
 * 标定用到的**全部文本**，顺序确定：先 40 篇论文，再逐条 claim 的「陈述 + 各检索式」。
 * 分批由 EmbeddingRouter 按字符预算切，同一个数组永远切成同一批 → fixture key 稳定。
 */
export function calibrationTexts(fixture: CalibrationFixture): string[] {
  return [
    ...fixture.papers.map(calibrationPaperText),
    ...fixture.claims.flatMap((c) => [c.claim, ...c.queries]),
  ];
}
