import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResearchThread } from "../../scripts/demo-research-thread";

// DESIGN §7 判据 1 的 CI 入口：一条完整研究线索必须走得通。
//
// 演练脚本自己就带断言（每一步没达到预期就抛 DemoFailure），这里做两件事：
//  1. 在 CI 里真跑一遍（含**真的** pyref 子进程，不是打桩）；
//  2. 把「报告结论区只有过了 review 的结论」这条最关键的性质再断言一次——
//     它是 v0.2 的核心主张，值得在两个地方各钉一颗钉子。

describe("完整研究线索（可重放演练）", () => {
  test(
    "文献 → 精读 → 综述 → idea → novelty → 干实验 → 结论 → review → 报告",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "spark-demo-test-"));
      const result = await runResearchThread({ root, slug: "ci-demo" });

      expect(result.steps.length).toBe(8);
      expect(result.report.counts.papers).toBeGreaterThanOrEqual(2);
      expect(result.report.counts.readings).toBeGreaterThan(0);
      expect(result.report.counts.ideas).toBe(1);
      expect(result.report.counts.dryExperiments).toBe(1);
      expect(result.report.counts.observations).toBeGreaterThan(0);

      // 门槛：通过的进结论区，被否决的只在待验证区。
      expect(result.report.counts.approvedConclusions).toBe(1);
      expect(result.report.counts.unverifiedConclusions).toBe(1);
      expect(result.conclusionSection).toContain("能量单调衰减");
      expect(result.conclusionSection).not.toContain("普遍适用于所有序列任务");
      expect(result.pendingSection).toContain("普遍适用于所有序列任务");
      expect(result.pendingSection).toContain("dangling_evidence");

      // 证据链：报告里每个 record id 都能在项目里找到（附录索引不许有幽灵条目）。
      expect(result.report.recordIds.length).toBeGreaterThan(5);
    },
    120_000,
  );
});
