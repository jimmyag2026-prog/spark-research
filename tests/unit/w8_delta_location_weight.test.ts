import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageGraph } from "../../backend/src/artifacts/lineage.ts";
import { ArtifactStore } from "../../backend/src/artifacts/store.ts";
import { LOCATION_WEIGHT_EXEMPT, ReviewerAgent } from "../../backend/src/reviewer/agent.ts";
import { CITATION_RULE } from "../../backend/src/reviewer/rules.ts";

// V14（W8-δ · lanes/W8-delta.md）：位置加权豁免从「调用路径里的一条 `===` 判断」
// 改成显式白名单（`LOCATION_WEIGHT_EXEMPT`，agent.ts）。这里验证：
//   ① 白名单内规则（citation-integrity）不参与位置加权——report 里的 soft 仍是 soft；
//   ② 白名单外规则（lineage）照常参与位置加权——report 里的 soft 升级为 hard；
//   ③ 阴性对照：把白名单清空，①的行为立刻反转（soft 也被升级），证明白名单是
//      真正在起作用的那道闸，不是摆设。

const SESSION = "s1";

function makeStore(): { store: ArtifactStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "spark-w8-delta-locw-"));
  const store = new ArtifactStore(join(dir, "artifacts.db"), join(dir, "storage"));
  return { store, dir };
}

// content 与 extractedCode 分开传：extractedCode 留空避免触发 traceability 检查
// （hasClaim() 对空 extractedCode 直接返回 false，见 rules.ts 注释），让每个测试
// 只产生我们要观察的那一条 finding，不被无关的 traceability hard finding 干扰。
function saveMarkdown(store: ArtifactStore, dir: string, name: string, content: string) {
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return store.save(filePath, "", [], { sessionId: SESSION, cellIndex: 0 }, "proj");
}

describe("V14 · 位置加权豁免白名单", () => {
  test("① 白名单内：citation-integrity 的 soft finding 在 report(.md) 里保持 soft，不被升级为 hard", async () => {
    const { store, dir } = makeStore();
    // 强断言无引用支撑 → soft、rule=CITATION_RULE（checkUnsupportedClaims 默认开）。
    const art = saveMarkdown(store, dir, "review.md", "本方法显著优于所有已有基线。");

    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: { knownKeys: [] },
    });
    const result = await reviewer.review(SESSION);

    const citationFindings = result.findings.filter((f) => f.artifactId === art.id && f.rule === CITATION_RULE);
    expect(citationFindings.length).toBeGreaterThan(0);
    expect(citationFindings.every((f) => f.severity === "soft")).toBe(true);
    // 整体 approved：唯一的 finding 是白名单豁免的 soft，不应该产生任何 hard。
    expect(result.findings.filter((f) => f.artifactId === art.id && f.severity === "hard")).toHaveLength(0);
  });

  test("② 白名单外：lineage 的 version_mix（无 rule 字段）在同一份 report(.md) 里从 soft 升级为 hard", async () => {
    const { store, dir } = makeStore();
    const art = saveMarkdown(store, dir, "report.md", "纯文本内容，不含任何 citation 检查器管辖的问题。");

    const graph = new LineageGraph();
    graph.registerVersion({ id: "data-v1", filename: "data.csv", version: 1 });
    graph.registerVersion({ id: "data-v2", filename: "data.csv", version: 2 });
    graph.addEdge("data-v1", art.id);
    graph.addEdge("data-v2", art.id);

    const reviewer = new ReviewerAgent(store, [], graph);
    const result = await reviewer.review(SESSION);

    const mix = result.findings.find((f) => f.artifactId === art.id && f.message.includes("version_mix"));
    expect(mix).toBeDefined();
    // lineageFindings() 产出时是 soft（见 rules.ts），report 位置把它加权升级为 hard——
    // 证明「不在白名单里的规则一律加权」这条默认行为成立。
    expect(mix!.severity).toBe("hard");
  });

  test("③ 阴性对照：清空白名单后，①里本该豁免的 citation soft finding 被真实升级为 hard；恢复后回到 soft", async () => {
    const { store, dir } = makeStore();
    const art = saveMarkdown(store, dir, "review2.md", "本方法首次实现了端到端训练。");

    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: { knownKeys: [] },
    });

    expect(LOCATION_WEIGHT_EXEMPT.has(CITATION_RULE)).toBe(true); // 前提：真实白名单里有它

    // 红：直接清空生产代码里那个白名单对象（同一个引用，不是测试自己另写的副本），
    // 再跑一遍真实 ReviewerAgent.review()。
    const saved = [...LOCATION_WEIGHT_EXEMPT];
    LOCATION_WEIGHT_EXEMPT.clear();
    try {
      const redResult = await reviewer.review(SESSION);
      const citationFindings = redResult.findings.filter((f) => f.artifactId === art.id && f.rule === CITATION_RULE);
      expect(citationFindings.length).toBeGreaterThan(0);
      expect(citationFindings.every((f) => f.severity === "hard")).toBe(true); // 红：被误杀成 hard
    } finally {
      // 恢复：不能让这个测试污染同一进程里跑在它之后的其它测试文件。
      for (const rule of saved) LOCATION_WEIGHT_EXEMPT.add(rule);
    }

    // 绿：白名单恢复后，同一个 reviewer 对同一份草稿再跑一遍，回到 soft。
    const greenResult = await reviewer.review(SESSION);
    const citationFindingsAfter = greenResult.findings.filter(
      (f) => f.artifactId === art.id && f.rule === CITATION_RULE,
    );
    expect(citationFindingsAfter.length).toBeGreaterThan(0);
    expect(citationFindingsAfter.every((f) => f.severity === "soft")).toBe(true);
  });
});
