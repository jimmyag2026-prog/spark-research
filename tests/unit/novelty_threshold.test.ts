import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimAffinity } from "../../backend/src/ideation/affinity";
import { HIGH_AFFINITY } from "../../backend/src/ideation/novelty";
import type { Paper } from "../../backend/src/literature/models";

// 词面阈值 HIGH_AFFINITY 不许当魔数改（v0.5 W5-1 收口）。
//
// 它原来是 0.75——P4 在**2 条样本**上定的。W5-1 β 为标定语义阈值录了一份 68 样本的
// 真实语料（论文全部来自 P2/P4 真实录制的检索响应，claim 为人工改述），顺带量出
// 0.75 连自己的最优区间都不在：它把一条真高相似候选（0.714）判在门外。
//
// 这份测试不是「断言它等于 0.70」——那只是把一个魔数换成另一个魔数。它在**同一份语料上
// 用生产函数 `claimAffinity()` 重新扫一遍阈值**，断言当前生产值落在最优区间里。
// 于是：改了 `affinity.ts` 的打分规则却没重标定 → 当场红；
//      有人把阈值随手挪到区间外 → 当场红。
//
// 判据是「错分 = 假阴 + 假阳」的最小值。注意最优区间里那条**假阳性（0.857）挪阈值修不掉**：
// 要修得把阈值抬到 0.857 以上，代价是大批假阴——这是词面口径的固有上限，不是标定没做好。

interface CalibrationClaim {
  id: string;
  claim: string;
  queries?: string[];
  positives?: string[];
  negatives?: string[];
}

const FIXTURE = join(import.meta.dir, "../fixtures/novelty/calibration.json");

function scoredSamples(): { label: "pos" | "neg"; score: number }[] {
  const data = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    papers: (Paper & { key: string })[];
    claims: CalibrationClaim[];
  };
  const byKey = new Map(data.papers.map((p) => [p.key, p]));
  const rows: { label: "pos" | "neg"; score: number }[] = [];
  for (const c of data.claims) {
    // 与生产同取法：claim 正文 + 它的检索式上取 max（applySemanticAffinity 的词面对偶）
    const texts = [c.claim, ...(c.queries ?? [])];
    for (const k of c.positives ?? []) {
      const p = byKey.get(k);
      if (p) rows.push({ label: "pos", score: claimAffinity(texts, p) });
    }
    for (const k of c.negatives ?? []) {
      const p = byKey.get(k);
      if (p) rows.push({ label: "neg", score: claimAffinity(texts, p) });
    }
  }
  return rows;
}

function errorsAt(rows: { label: "pos" | "neg"; score: number }[], t: number): number {
  const falseNegatives = rows.filter((r) => r.label === "pos" && r.score < t).length;
  const falsePositives = rows.filter((r) => r.label === "neg" && r.score >= t).length;
  return falseNegatives + falsePositives;
}

describe("HIGH_AFFINITY 必须落在标定语料的最优区间里", () => {
  const rows = scoredSamples();

  test("语料真的被读进来了，且正负样本都非空（这条门禁不能空转）", () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
    expect(rows.some((r) => r.label === "pos")).toBe(true);
    expect(rows.some((r) => r.label === "neg")).toBe(true);
  });

  test("生产阈值的错分 = 语料上可达的最小错分", () => {
    // 阈值只在跨过某个样本分数时才改变判定，所以候选集就是样本分数本身。
    const candidates = [...new Set(rows.map((r) => r.score))].sort((a, b) => a - b);
    const best = Math.min(...candidates.map((t) => errorsAt(rows, t)));
    expect(errorsAt(rows, HIGH_AFFINITY)).toBe(best);
  });

  test("旧值 0.75 在这份语料上确实更差（说明这次调整不是无谓改动）", () => {
    expect(errorsAt(rows, 0.75)).toBeGreaterThan(errorsAt(rows, HIGH_AFFINITY));
  });

  test("阈值两侧都要有余量：不许正压在某个样本分数上", () => {
    // 压在样本上意味着打分函数一点点浮动就会翻转判定。
    for (const r of rows) expect(Math.abs(r.score - HIGH_AFFINITY)).toBeGreaterThan(0.005);
  });
});
