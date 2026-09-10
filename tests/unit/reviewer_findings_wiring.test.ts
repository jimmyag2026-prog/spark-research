import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineageGraph } from "../../backend/src/artifacts/lineage.ts";
import type { ArtifactVersion, ExecutionRecord } from "../../backend/src/artifacts/models.ts";
import { ArtifactStore } from "../../backend/src/artifacts/store.ts";
import { FindingsStore } from "../../backend/src/reviewer/findings_store.ts";
import { ReviewerAgent } from "../../backend/src/reviewer/agent.ts";
import type { CitationJudge, CitationJudgeInput, CitationJudgement } from "../../backend/src/reviewer/rules.ts";

// v0.4 波次 W3 lane W3-c：ReviewerAgent.review() 接 findings_store（W1-b 交付）。
//
// W1-b 把存储层 + CLI 建好了（backend/src/reviewer/findings_store.ts / cli.ts），但
// ReviewerAgent.review()（本文件测的这个）此前从不调用 reviewTarget()——表永远是空的，
// 复核闭环（reflagged/resolved）无从谈起。这里验证接线之后的三件事：
//   ① 每轮 review 真的把 Finding[] upsert 进 findings_store（不是只多了个可选参数摆着不用）；
//   ② 复核闭环真的转起来：问题修好后下一轮 resolve，mark-addressed 之后复发变 reflagged；
//   ③ fingerprint 设计经受得住「无关措辞变化」——citation-integrity 的 LLM judge 换一轮换一种
//     说法，不该被误判成新问题（这也是任务书要求的阴性对照③的正面对照）。

const SESSION = "s1";

const stores: FindingsStore[] = [];
function newFindingsStore(): FindingsStore {
  const dir = mkdtempSync(join(tmpdir(), "spark-findings-wiring-"));
  const store = new FindingsStore(join(dir, "findings.db"));
  stores.push(store);
  return store;
}
afterAll(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* 已关 */
    }
  }
});

function makeArtifactStore(): { store: ArtifactStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "spark-reviewer-wiring-"));
  const store = new ArtifactStore(join(dir, "artifacts.db"), join(dir, "storage"));
  return { store, dir };
}

function saveArtifact(
  store: ArtifactStore,
  dir: string,
  name: string,
  code: string,
  env: Record<string, unknown> | null,
): ArtifactVersion {
  const filePath = join(dir, name);
  writeFileSync(filePath, code);
  return store.save(filePath, code, [], env, "proj");
}

function saveMarkdown(store: ArtifactStore, dir: string, name: string, markdown: string): ArtifactVersion {
  const filePath = join(dir, name);
  writeFileSync(filePath, markdown);
  // extractedCode 传空串：markdown 草稿不是代码产物，不该触发 traceability 检查
  // （见 rules.ts hasClaim，与 literature/review.ts persist() 同一个理由）。
  return store.save(filePath, "", [], { sessionId: SESSION }, "proj");
}

function execRecord(store: ArtifactStore, frame: string, cellIndex: number, filesWritten: string[]): ExecutionRecord {
  return store.saveExecution({
    frame,
    cellIndex,
    kernelId: null,
    language: "python",
    source: "print(1)",
    stdout: "",
    stderr: "",
    status: "success",
    filesWritten,
    filesRead: [],
    wallTime: 0,
    cpuTime: 0,
    peakMemory: 0,
  });
}

describe("ReviewerAgent → findings_store 接线", () => {
  test("review() 把 traceability hard finding upsert 进 findings_store（checker='traceability'，state=open）", async () => {
    const { store, dir } = makeArtifactStore();
    const findings = newFindingsStore();
    const artifact = saveArtifact(store, dir, "result.txt", "df.mean()", { sessionId: SESSION, cellIndex: 0 });

    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      findings: { store: findings, project: "p1" },
    });
    const result = await reviewer.review(SESSION);
    expect(result.approved).toBe(false);

    const rows = findings.list({ project: "p1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.checker).toBe("traceability");
    expect(rows[0]!.state).toBe("open");
    expect(rows[0]!.target).toEqual({ kind: "artifact", id: artifact.id });
    expect(rows[0]!.severity).toBe("hard");
  });

  test("不配置 findings 选项时行为与接线之前完全一致（不落库，findings 结果不变）", async () => {
    const { store, dir } = makeArtifactStore();
    saveArtifact(store, dir, "result.txt", "df.mean()", { sessionId: SESSION, cellIndex: 0 });
    const reviewer = new ReviewerAgent(store, [], new LineageGraph());
    const result = await reviewer.review(SESSION);
    expect(result.approved).toBe(false);
    expect(result.findings).toHaveLength(1);
    // 没有第二个断言好做——这条测试的意义是「不会抛错、不会因为可选配置缺失而崩」。
  });

  test("复核闭环：下一轮问题修好（能找到 producing cell）→ 之前的 finding 变 resolved", async () => {
    const { store, dir } = makeArtifactStore();
    const findings = newFindingsStore();
    const artifact = saveArtifact(store, dir, "result.txt", "df.mean()", { sessionId: SESSION, cellIndex: 0 });

    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      findings: { store: findings, project: "p1" },
    });
    await reviewer.review(SESSION);
    expect(findings.list({ project: "p1", open: true })).toHaveLength(1);

    // 修好：补一条能对上 producingCellId 的 execution record。
    execRecord(store, SESSION, 0, ["result.txt"]);
    const reviewer2 = new ReviewerAgent(store, store.listExecutionsByFrame(SESSION), new LineageGraph(), {
      findings: { store: findings, project: "p1" },
    });
    const second = await reviewer2.review(SESSION);
    expect(second.findings.filter((f) => f.severity === "hard")).toHaveLength(0);

    const rows = findings.list({ project: "p1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("resolved");
    void artifact;
  });

  test("mark-addressed 之后同一个问题复现 → reflagged 且 reflagCount 递增", async () => {
    const { store, dir } = makeArtifactStore();
    const findings = newFindingsStore();
    saveArtifact(store, dir, "result.txt", "df.mean()", { sessionId: SESSION, cellIndex: 0 });
    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      findings: { store: findings, project: "p1" },
    });

    await reviewer.review(SESSION);
    const [first] = findings.list({ project: "p1" });
    findings.markAddressed(first!.id, { actor: "jimmy", note: "以为修好了" });
    expect(findings.get(first!.id)!.state).toBe("addressed");

    // 问题其实没修（还是同一个 artifact，还是没有 producing cell）——再跑一轮。
    await reviewer.review(SESSION);
    const after = findings.get(first!.id)!;
    expect(after.state).toBe("reflagged");
    expect(after.reflagCount).toBe(1);
  });

  test("citation-integrity 检查被跳过（未配置 CitationCheckConfig）时，不会把历史 finding 误判成 resolved", async () => {
    const { store, dir } = makeArtifactStore();
    const findings = newFindingsStore();
    const artifact = saveMarkdown(store, dir, "draft.md", "这是背景陈述[@ghost]。");

    // 模拟「上一轮」已经报过一条 citation-integrity 的 open finding
    // （比如上一次调用时配置了 citations，这一次没配置）。
    findings.reviewTarget({
      project: "p1",
      target: { kind: "artifact", id: artifact.id },
      checker: "citation-integrity",
      hits: [{ severity: "hard", fingerprint: "stale-fp" }],
    });

    // 这一轮 ReviewerAgent 没有配置 citations —— checkCitations 直接跳过（ran=false），
    // review() 不该替这个 (checker, target) 调用 reviewTarget，否则会把「根本没查」
    // 误判成「查了、零命中 → resolved」。
    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      findings: { store: findings, project: "p1" },
    });
    await reviewer.review(SESSION);

    const row = findings.list({ project: "p1", checker: "citation-integrity" })[0]!;
    expect(row.state).toBe("open");
  });

  test("citation-integrity 检查真的跑了、这一轮零命中 → 之前的 finding 才会 resolved", async () => {
    const { store, dir } = makeArtifactStore();
    const findings = newFindingsStore();
    const artifact = saveMarkdown(store, dir, "draft.md", "这是背景陈述[@k1]。");

    findings.reviewTarget({
      project: "p1",
      target: { kind: "artifact", id: artifact.id },
      checker: "citation-integrity",
      hits: [{ severity: "hard", fingerprint: "stale-fp" }],
    });

    // 这一轮配置了 citations，且 k1 在白名单里、没有强断言——citationIntegrity 真的跑了、
    // 零命中。
    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: { knownKeys: ["k1"] },
      findings: { store: findings, project: "p1" },
    });
    const result = await reviewer.review(SESSION);
    expect(result.findings.filter((f) => f.rule === "citation-integrity")).toHaveLength(0);

    const row = findings.list({ project: "p1", checker: "citation-integrity" })[0]!;
    expect(row.state).toBe("resolved");
  });

  // fingerprint 设计的核心断言：citation_conflict 的身份不能包含 judge 给的自然语言理由，
  // 否则同一个冲突换一轮跑（judge 的措辞几乎不可能字字相同）会被误判成两条不同的 finding，
  // 去重与复核闭环全部失效——这正是任务书要求的阴性对照③。
  class VaryingReasonJudge implements CitationJudge {
    private n = 0;
    async judge(_input: CitationJudgeInput): Promise<CitationJudgement> {
      this.n++;
      return { verdict: "conflict", reason: `理由措辞第 ${this.n} 版：与精读卡不一致（用词不同）` };
    }
  }

  test("fingerprint 不受 judge 措辞变化影响：同一个 citation_conflict 跑两轮仍是同一条 finding", async () => {
    const { store, dir } = makeArtifactStore();
    const findings = newFindingsStore();
    const artifact = saveMarkdown(store, dir, "draft.md", "这项工作效果很好[@k1]。");
    const judge = new VaryingReasonJudge();
    const baselines = new Map([["k1", { key: "k1", title: "T", summary: "S" }]]);

    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: { knownKeys: ["k1"], baselines, judge },
      findings: { store: findings, project: "p1" },
    });

    const first = await reviewer.review(SESSION);
    const conflict1 = first.findings.find((f) => f.message.includes("citation_conflict"));
    expect(conflict1).toBeTruthy();
    expect(conflict1!.detail).toMatchObject({ reason: "理由措辞第 1 版：与精读卡不一致（用词不同）" });

    const second = await reviewer.review(SESSION);
    const conflict2 = second.findings.find((f) => f.message.includes("citation_conflict"));
    expect(conflict2!.detail).toMatchObject({ reason: "理由措辞第 2 版：与精读卡不一致（用词不同）" });

    // 两轮的 reason 文案确实不同（judge 换了措辞），但 findings_store 里必须还是同一条
    // open finding，reflagCount 仍是 0——不是「resolved 又复发」，是从始至终就没消失过。
    const rows = findings.list({ project: "p1", checker: "citation-integrity" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("open");
    expect(rows[0]!.reflagCount).toBe(0);
    // 证据字段本身允许随每一轮刷新（存的是最近一次 judge 的理由，供人工排查），
    // fingerprint 不受影响的断言已经由「只有 1 行」证明过了。
    expect(rows[0]!.evidence).toContain("第 2 版");
  });

  test("fingerprint 不会过度合并：两个不同的库外引用 key 各自独立成一条 finding", async () => {
    const { store, dir } = makeArtifactStore();
    const findings = newFindingsStore();
    saveMarkdown(store, dir, "draft.md", "第一处引用[@ghost-a]。第二处引用[@ghost-b]。");
    const reviewer = new ReviewerAgent(store, [], new LineageGraph(), {
      citations: { knownKeys: [] },
      findings: { store: findings, project: "p1" },
    });
    await reviewer.review(SESSION);
    const rows = findings.list({ project: "p1", checker: "citation-integrity" });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2);
  });
});
