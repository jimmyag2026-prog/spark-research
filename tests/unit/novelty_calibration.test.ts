import { beforeAll, describe, expect, test } from "bun:test";
import { claimAffinity } from "../../backend/src/ideation/affinity";
import { HIGH_AFFINITY } from "../../backend/src/ideation/novelty";
import { SEMANTIC_THRESHOLDS } from "../../backend/src/llm/embeddings/calibration";
import { cosine } from "../../backend/src/llm/embeddings/types";
import {
  CALIBRATED_MODEL,
  calibrationPaperAsPaper,
  calibrationPaperText,
  calibrationTexts,
  fixtureEmbeddingRouter,
  loadCalibration,
  type CalibrationClaim,
  type CalibrationFixture,
} from "../helpers/embedding_scenario";

// v0.5 C4 · **语义阈值的标定测试**（DEVELOPMENT_PLAN_v0.5_MODULES.md §1.2.3）。
//
// 这个文件回答的问题是：「novelty 该不该改用语义相似度做评级判据？」
// 答案不是拍的，是量出来的——30 条 claim（17 条改述已发表工作 + 13 条杜撰组合）
// × 59 篇**真实录制**的论文，向量走 fixture 回放（零网络），
// 把语义口径与现行词面口径放在**同一份样本、同一个取法**下逐条对账。
//
// 量出来的结论：**没有证据表明语义更好**，所以 `SEMANTIC_THRESHOLDS` 空着，
// novelty 强制走词面（K-4）。下面的用例把这个结论的每一个数字都钉住——
// 哪天有人想推翻它，得先让这些断言红，而不是直接往登记表里塞一个数。
//
// ── 与规划文档 §1.2.3 的偏离（照做但如实记录，见 docs/devlog/W5-1-b.md） ─────
//
// §1.2.3 要求断言「阈值落在最高负样本与最低正样本之间且两侧余量各 ≥ 0.05」。
// **在这份样本上，两种口径都无解**：正负分布本来就重叠（语义 0.579 vs 0.660，
// 词面 0.714 vs 0.857）。P4 那次 0.75 是在 2 条样本上标的，样本一多就露馅了。
// 所以这里换成一套在真实分布上可达成、且负性更强的判据（见下面各用例）。

let fixture: CalibrationFixture;
let semanticOf: (claim: CalibrationClaim, paperKey: string) => number;
let lexicalOf: (claim: CalibrationClaim, paperKey: string) => number;

beforeAll(async () => {
  fixture = await loadCalibration();
  const texts = calibrationTexts(fixture);
  const response = await fixtureEmbeddingRouter(CALIBRATED_MODEL, "replay").embed(texts);
  if (!response.ok) {
    throw new Error(
      `标定 fixture 回放失败：${response.error.message}\n` +
        `  用 FIXTURE_MODE=record 对着本机 Ollama 重录 tests/fixtures/embeddings/ 后再跑。`,
    );
  }
  const vectorOf = new Map(texts.map((text, i) => [text, response.vectors[i]!]));
  const paperVector = new Map(fixture.papers.map((p) => [p.key, vectorOf.get(calibrationPaperText(p))!]));
  const paperByKey = new Map(fixture.papers.map((p) => [p.key, p]));

  // **与生产逐字同构**：semanticAffinity = max over [陈述, ...检索式] 的余弦
  // （novelty.ts 的 applySemanticAffinity 用的就是这个取法）。
  semanticOf = (claim, paperKey) =>
    [claim.claim, ...claim.queries].reduce(
      (max, text) => Math.max(max, cosine(vectorOf.get(text)!, paperVector.get(paperKey)!)),
      -1,
    );
  // 词面口径同样 max over 同一批文本（claimAffinity 本身就是这个取法）。
  lexicalOf = (claim, paperKey) =>
    claimAffinity([claim.claim, ...claim.queries], calibrationPaperAsPaper(paperByKey.get(paperKey)!));
});

interface Sample {
  id: string;
  score: number;
}

/**
 * 一份口径下的正/负样本分布。
 *   existing 类：正样本 = 该 claim 改述的原文；负样本 = 同领域最难的那条邻近工作。
 *   novel 类：没有正样本；负样本 = **全语料里最近的那一篇**（§1.2.3 的口径）。
 */
function distribution(score: (c: CalibrationClaim, k: string) => number) {
  const positives: Sample[] = [];
  const negatives: Sample[] = [];
  for (const claim of fixture.claims) {
    if (claim.expected === "existing") {
      positives.push({ id: claim.id, score: Math.min(...claim.positives.map((k) => score(claim, k))) });
      negatives.push({ id: `${claim.id}/neg`, score: Math.max(...claim.negatives.map((k) => score(claim, k))) });
    } else {
      negatives.push({ id: claim.id, score: Math.max(...fixture.papers.map((p) => score(claim, p.key))) });
    }
  }
  return { positives, negatives };
}

function errorsAt(dist: ReturnType<typeof distribution>, threshold: number) {
  const falseNegatives = dist.positives.filter((s) => s.score < threshold);
  const falsePositives = dist.negatives.filter((s) => s.score >= threshold);
  return { falseNegatives, falsePositives, total: falseNegatives.length + falsePositives.length };
}

/** 使错分最少的阈值区间（步长 0.005 扫描）。 */
function bestThresholdBand(dist: ReturnType<typeof distribution>): { low: number; high: number; errors: number } {
  const scan: Array<{ t: number; errors: number }> = [];
  for (let t = 0.05; t < 0.95; t += 0.005) {
    const rounded = Number(t.toFixed(3));
    scan.push({ t: rounded, errors: errorsAt(dist, rounded).total });
  }
  const min = Math.min(...scan.map((s) => s.errors));
  const band = scan.filter((s) => s.errors === min).map((s) => s.t);
  return { low: band[0]!, high: band[band.length - 1]!, errors: min };
}

/** 让假阳性归零的最低阈值（AD-8 关键的那个方向，见下面的大注释）。 */
function zeroFalsePositiveThreshold(dist: ReturnType<typeof distribution>): { threshold: number; falseNegatives: number } {
  for (let t = 0.05; t < 1.0; t += 0.005) {
    const rounded = Number(t.toFixed(3));
    const at = errorsAt(dist, rounded);
    if (at.falsePositives.length === 0) return { threshold: rounded, falseNegatives: at.falseNegatives.length };
  }
  throw new Error("没有任何阈值能让假阳性归零");
}

describe("标定样本 · 与生产分布一致", () => {
  test("样本量与构成满足 §1.2.3 的下限：≥10 条改述 + ≥10 条杜撰 + P4 原有 2 条", () => {
    const existing = fixture.claims.filter((c) => c.expected === "existing");
    const novel = fixture.claims.filter((c) => c.expected === "novel");
    expect(existing.length).toBeGreaterThanOrEqual(10);
    expect(novel.length).toBeGreaterThanOrEqual(10);
    expect(fixture.claims.map((c) => c.id)).toContain("h01");
    expect(fixture.claims.map((c) => c.id)).toContain("h02");
    expect(fixture.claims).toHaveLength(30);
  });

  test("**语料必须包含没有摘要的条目**——管线真的会检索到它们", () => {
    // 本 lane 踩过的坑（devlog W5-1-b「语料分布的教训」）：第一版语料只收有摘要的 40 篇，
    // 阈值标在 0.645、测试全绿，然后 e2e 当场打脸——真实候选里那些只有标题的条目
    // 分数系统性偏高（裸标题是一句没有背景稀释的高密度主题陈述），直接把阈值顶穿。
    // 用一个比生产更干净的语料标定出来的阈值，在生产上必然偏。
    const withoutAbstract = fixture.papers.filter((p) => p.abstract.trim().length < 80);
    expect(withoutAbstract.length).toBeGreaterThanOrEqual(10);
    expect(fixture.papers).toHaveLength(59);
    // 这些条目的嵌入文本确实退化成只有标题
    for (const paper of withoutAbstract) expect(calibrationPaperText(paper)).toBe(paper.title);
  });

  test("每条样本引用的 paperKey 都真实存在；existing 至少 3 条同领域负样本", () => {
    const keys = new Set(fixture.papers.map((p) => p.key));
    for (const claim of fixture.claims) {
      for (const key of [...claim.positives, ...claim.negatives]) expect(keys.has(key)).toBe(true);
      if (claim.expected === "existing") {
        expect(claim.positives.length).toBeGreaterThanOrEqual(1);
        expect(claim.negatives.length).toBeGreaterThanOrEqual(3);
      } else {
        // novel 类约定：positives/negatives 均空 = 整个语料都是负样本
        expect(claim.positives).toEqual([]);
        expect(claim.negatives).toEqual([]);
      }
    }
  });

  test("语料全部来自真实录制的检索磁带", () => {
    for (const paper of fixture.papers) {
      expect(["search-alphafold", "novelty-check"]).toContain(paper.cassette);
      expect(paper.identity).toMatch(/^(doi:|title:)/);
      expect(calibrationPaperText(paper).trim().length).toBeGreaterThan(10);
    }
  });
});

describe("语义口径 · 实测分布", () => {
  test("正/负样本区间钉死（换模型、换文本规则、换语料都会让这条红）", () => {
    const dist = distribution(semanticOf);
    expect(Math.min(...dist.positives.map((s) => s.score))).toBeCloseTo(0.579, 2);
    expect(Math.max(...dist.positives.map((s) => s.score))).toBeCloseTo(0.746, 2);
    expect(Math.max(...dist.negatives.map((s) => s.score))).toBeCloseTo(0.660, 2);
  });

  test("正负分布确实重叠：§1.2.3 设想的「两侧各 ≥0.05 余量」在这份样本上无解", () => {
    const dist = distribution(semanticOf);
    // 如实断言这个事实，免得以后有人以为它成立过。
    expect(Math.min(...dist.positives.map((s) => s.score))).toBeLessThan(
      Math.max(...dist.negatives.map((s) => s.score)),
    );
  });

  test("最优阈值区间 [0.64, 0.66]，错分 3/47", () => {
    const band = bestThresholdBand(distribution(semanticOf));
    expect(band.low).toBeCloseTo(0.64, 3);
    expect(band.high).toBeCloseTo(0.66, 3);
    expect(band.errors).toBe(3);
  });

  test("零假阳性点 = 0.665，此时假阴性 4 条", () => {
    // 为什么单独盯「零假阳性」：确定性层的两条规则对两类错误不对称。
    //   假阳性 = 把「同一个领域的邻近工作」当成「就是这件事」→ R5 会把一条本来正确的
    //            novel 升级成 existing，等于确定性层**凭空造出**一条不存在的「已有工作」。
    //   假阴性 = 少抓一次 R5、多降一级 R4，方向都是更保守。
    // 所以任何将来要登记的阈值，都必须先满足零假阳性。
    const zero = zeroFalsePositiveThreshold(distribution(semanticOf));
    expect(zero.threshold).toBeCloseTo(0.665, 3);
    expect(zero.falseNegatives).toBe(4);
  });

  test("阴性对照③：把语义阈值换回词面阈值 0.75 → 一条正样本都够不着，R5 永不触发", () => {
    const dist = distribution(semanticOf);
    const at = errorsAt(dist, HIGH_AFFINITY);
    expect(at.falseNegatives.length).toBe(dist.positives.length);
    expect(at.falsePositives.length).toBe(0);
    expect(Math.max(...dist.positives.map((s) => s.score))).toBeLessThan(HIGH_AFFINITY);
  });

  test("阈值挪 ±0.1 判据就不成立（这套断言真的在卡这个数）", () => {
    const dist = distribution(semanticOf);
    const zero = zeroFalsePositiveThreshold(dist).threshold;
    expect(errorsAt(dist, zero - 0.1).falsePositives.length).toBeGreaterThan(0);
    expect(errorsAt(dist, zero + 0.1).falseNegatives.length).toBeGreaterThan(4);
  });
});

describe("词面口径 · 同一份样本下的对照", () => {
  test("词面在生产阈值 0.75 上错分 2/47（假阴 1 / 假阳 1）", () => {
    const at = errorsAt(distribution(lexicalOf), HIGH_AFFINITY);
    expect(at.falseNegatives.map((s) => s.id)).toEqual(["e07"]);
    // h01 的邻近工作词面覆盖率 0.857 —— 正是 novelty.ts 注释里预警过的
    // 「用词高度重合的邻近工作被 judge 得偏高」。语义确实修掉了这一条（只给 0.615）。
    expect(at.falsePositives.map((s) => s.id)).toEqual(["h01/neg"]);
    expect(at.total).toBe(2);
  });

  test("词面自己的最优区间是 [0.67, 0.71]（错分 1），并不包含 0.75", () => {
    // P4 那个 0.75 是在 2 条样本上标的。样本一多，它连自己的最优区间都不在。
    const band = bestThresholdBand(distribution(lexicalOf));
    expect(band.low).toBeCloseTo(0.67, 3);
    expect(band.high).toBeCloseTo(0.71, 3);
    expect(band.errors).toBe(1);
    expect(HIGH_AFFINITY).toBeGreaterThan(band.high);
  });
});

describe("结论：语义没有赢过词面，所以不登记（K-4）", () => {
  test("逐个维度对照：最优错分、生产阈值错分、零假阳性点的假阴数", () => {
    const semantic = distribution(semanticOf);
    const lexical = distribution(lexicalOf);
    // ① 最优错分：语义 3，词面 1 —— 词面更好
    expect(bestThresholdBand(semantic).errors).toBe(3);
    expect(bestThresholdBand(lexical).errors).toBe(1);
    // ② 各自生产阈值上的错分：语义（零假阳性点 0.665）4，词面（0.75）2 —— 词面更好
    expect(errorsAt(semantic, zeroFalsePositiveThreshold(semantic).threshold).total).toBe(4);
    expect(errorsAt(lexical, HIGH_AFFINITY).total).toBe(2);
    // ③ 零假阳性点上的假阴数：4 vs 4 —— 打平
    expect(zeroFalsePositiveThreshold(semantic).falseNegatives).toBe(4);
    expect(zeroFalsePositiveThreshold(lexical).falseNegatives).toBe(4);
  });

  test("既然没赢，SEMANTIC_THRESHOLDS 就必须是空的 ⇒ novelty 强制词面", () => {
    // 本 lane 的结论落点。要推翻它：补样本 / 换模型 / 重跑标定，让上面那组对照翻过来，
    // 再来动这张表——而不是绕过这条断言。
    expect(Object.keys(SEMANTIC_THRESHOLDS)).toEqual([]);
  });

  test("**将来若有人登记阈值**，必须同时满足：零假阳性 + 落在最优区间内 + 样本数对得上", () => {
    // 这条用例现在是空转（表为空）。它守的是「以后」：任何一条登记都得过这三关，
    // 否则这个门禁就只是一句注释里的君子协定。
    const semantic = distribution(semanticOf);
    const band = bestThresholdBand(semantic);
    const zero = zeroFalsePositiveThreshold(semantic);
    for (const [modelId, entry] of Object.entries(SEMANTIC_THRESHOLDS)) {
      expect(modelId).toBe(CALIBRATED_MODEL);
      expect(entry.sampleSize).toBe(fixture.claims.length);
      expect(errorsAt(semantic, entry.high).falsePositives).toEqual([]);
      expect(entry.high).toBeGreaterThanOrEqual(zero.threshold);
      expect(entry.high).toBeGreaterThanOrEqual(band.low);
      // 还得真的赢过词面，否则不该登记
      expect(errorsAt(semantic, entry.high).total).toBeLessThan(errorsAt(distribution(lexicalOf), HIGH_AFFINITY).total);
    }
  });
});
