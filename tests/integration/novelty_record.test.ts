import { beforeAll, describe, expect, test } from "bun:test";
import { fixtureModeFromEnv } from "../../backend/src/http/fixture";
import {
  FABRICATED_CLAIM,
  NOVELTY_LIMIT,
  NOVELTY_PER_SOURCE,
  NOVELTY_SOURCES,
  PUBLISHED_CLAIM,
  noveltySearcher,
} from "../helpers/ideation_scenario";

// P4 真实网络验证 + fixture 录制（DEVELOPMENT_PLAN 三、「e2e 真实：本地验证 + 录制 fixture」）。
//
//   本地录制：FIXTURE_MODE=record bun test tests/integration/novelty_record.test.ts
//   平时（含 CI）：默认 replay 模式 → **照常执行**，回放 tests/fixtures/literature/novelty-check.json，零网络
//                  （另有一套独立的回放用例在 tests/unit/novelty_e2e.test.ts，覆盖面不同，不是本文件的替代）
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

describe("novelty 检索式 · 已发表 claim 与杜撰 claim 的双向对照（FIXTURE_MODE 决定回放还是打网络）", () => {
  test(
    "(a) 已发表工作的核心 claim：检索式必须能真的把原文捞回来",
    async () => {
      const searcher = noveltySearcher(MODE);
      const titles: string[] = [];
      for (const query of PUBLISHED_CLAIM.queries) {
        const result = await searcher.search(query, {
          sources: NOVELTY_SOURCES,
          perSource: NOVELTY_PER_SOURCE,
          limit: NOVELTY_LIMIT,
        });
        console.log(`\n[${MODE}] (a) "${query}"`);
        for (const status of result.sources) {
          console.log(
            `  ${status.source.padEnd(16)} ${status.outcome.padEnd(8)} ${status.count} 条 ` +
              `${status.elapsedMs}ms ${status.error ?? status.note ?? ""}`,
          );
        }
        for (const paper of result.papers) {
          titles.push(paper.title);
          console.log(`    · ${paper.year ?? "n.d."} ${paper.title.slice(0, 80)}`);
        }
      }
      // 这条断言就是「(a) 场景成立」的真实性判据：原文确实能被这几条检索式检回。
      expect(titles.some((t) => t.toLowerCase().includes(PUBLISHED_CLAIM.expectTitle))).toBe(true);
    },
    180_000,
  );

  test(
    "(b) 杜撰组合 claim：检索有结果但没有直接匹配",
    async () => {
      const searcher = noveltySearcher(MODE);
      for (const query of FABRICATED_CLAIM.queries) {
        const result = await searcher.search(query, {
          sources: NOVELTY_SOURCES,
          perSource: NOVELTY_PER_SOURCE,
          limit: NOVELTY_LIMIT,
        });
        console.log(`\n[${MODE}] (b) "${query}"`);
        for (const status of result.sources) {
          console.log(
            `  ${status.source.padEnd(16)} ${status.outcome.padEnd(8)} ${status.count} 条 ` +
              `${status.elapsedMs}ms ${status.error ?? status.note ?? ""}`,
          );
        }
        for (const paper of result.papers) console.log(`    · ${paper.year ?? "n.d."} ${paper.title.slice(0, 80)}`);
      }
      // 杜撰的组合当然没有直接匹配，但检索**必须**有结果——否则 novelty check
      // 就变成「查不到 = 新颖」，那正是这套管线要防的失效模式。
      const first = await searcher.search(FABRICATED_CLAIM.queries[0]!, {
        sources: NOVELTY_SOURCES,
        perSource: NOVELTY_PER_SOURCE,
        limit: NOVELTY_LIMIT,
      });
      expect(first.papers.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
