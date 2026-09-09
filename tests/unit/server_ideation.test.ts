import { describe, expect, test } from "bun:test";
import type { LiteratureSearcher } from "../../backend/src/literature/search";
import {
  NOVELTY_PER_SOURCE,
  NOVELTY_SOURCES,
  PUBLISHED_CLAIM,
  ScriptedLlm,
  candidatesByClaim,
  noveltySearcher,
} from "../helpers/ideation_scenario";
import { CASSETTES, PER_SOURCE, SEARCH_QUERY, SEARCH_SOURCES, searcherWith } from "../helpers/literature_scenario";
import { makeServer, seedLibrary } from "../helpers/server_scenario";

// P7 · 思路库端点（P4 的 HTTP 投影）。
// 检索走 fixture 回放，模型走 ScriptedLlm——它只能引用**管线真的检索到**的 key，
// 评级由 constrainRating 那层确定性代码校正，所以断言检的是管线不是 fake 的嘴。

const HYPOTHESIS = "用 Transformer 的自注意力完全替代循环结构做序列转导";

function scripted(libraryKeys: () => string[]): ScriptedLlm {
  return new ScriptedLlm([
    (user) => {
      if (!user.includes("可用引用 key 白名单")) return null;
      const keys = libraryKeys();
      return JSON.stringify({
        critique:
          `这条思路的关键假设是注意力足以替代循环结构[@${keys[0]}]；` +
          `但同一批工作也提示评测口径本身不稳定[@${keys[1]}]。你打算怎么证伪它？（inferred）`,
        hypothesis: HYPOTHESIS,
        supporting: [{ key: keys[0], note: "同一范式下的代表性结果" }],
        contradicting: [{ key: keys[1], note: "该工作提示结论对评测口径敏感" }],
        openQuestions: ["在长序列与低资源设定下是否同样成立"],
      });
    },
    (user) =>
      user.includes("待验证点")
        ? JSON.stringify({
            claims: [{ statement: PUBLISHED_CLAIM.statement, queries: PUBLISHED_CLAIM.queries }],
          })
        : null,
    (user) => {
      if (!user.includes("候选工作")) return null;
      const candidates = candidatesByClaim(user).get("c1") ?? [];
      const hit =
        candidates.find((c) => c.title.toLowerCase().includes(PUBLISHED_CLAIM.expectTitle)) ?? candidates[0]!;
      return JSON.stringify({
        claims: [
          {
            claimId: "c1",
            rating: "existing",
            verdict: "见最近邻对比",
            nearestWorks: [
              {
                key: hit.key,
                sameness: "同样用自注意力替代循环结构做序列转导",
                difference: "本 claim 没有提出任何新机制",
              },
            ],
          },
        ],
      });
    },
  ]);
}

// 用 fixture 检索把一个真实文献库播进项目（co-explore 需要可引用的 key）。
async function seedFromFixture(fx: ReturnType<typeof makeServer>): Promise<string[]> {
  const { task } = await fx.run("/api/lit/search", {
    query: SEARCH_QUERY,
    sources: SEARCH_SOURCES,
    limit: PER_SOURCE,
    add: true,
  });
  expect(task.state).toBe("succeeded");
  const papers = await fx.get<{ papers: Array<{ bibtexKey: string }> }>("/api/lit/papers");
  return papers.body.papers.map((p) => p.bibtexKey);
}

describe("HTTP · ideas 空态与列表", () => {
  test("GET /api/ideas 空库返回空数组，不是 404", async () => {
    const fx = makeServer();
    try {
      const { status, body } = await fx.get<{ ideas: unknown[]; project: string }>("/api/ideas");
      expect(status).toBe(200);
      expect(body.ideas).toEqual([]);
    } finally {
      await fx.stop();
    }
  });

  test("GET /api/ideas/:id 不存在 → 404", async () => {
    const fx = makeServer();
    try {
      expect((await fx.get("/api/ideas/missing")).status).toBe(404);
    } finally {
      await fx.stop();
    }
  });

  test("POST /api/ideas 缺 message → 400", async () => {
    const fx = makeServer();
    try {
      expect((await fx.post("/api/ideas", {})).status).toBe(400);
    } finally {
      await fx.stop();
    }
  });
});

describe("HTTP · co-explore", () => {
  test("文献库为空时照跑但明确标出「没有文献基础」", async () => {
    const llm = new ScriptedLlm([
      (user) =>
        user.includes("可用引用 key 白名单")
          ? JSON.stringify({
              critique: "库里没有可引用的文献，以下判断都是推断（inferred）。",
              hypothesis: HYPOTHESIS,
              supporting: [{ inferred: true, note: "凭经验推断" }],
              contradicting: [{ inferred: true, note: "也可能不成立（inferred）" }],
              openQuestions: ["先把相关文献入库"],
            })
          : null,
    ]);
    const fx = makeServer({ llm });
    try {
      const { status, task } = await fx.run("/api/ideas", { message: HYPOTHESIS });
      expect(status).toBe(200);
      const result = task.result as { emptyLibrary: boolean; stored: { recordId: string } };
      // 「库为空」不是错误但必须出现在结果里——否则用户会以为这些结论有文献支撑。
      expect(result.emptyLibrary).toBe(true);
      expect(result.stored.recordId).toBeTruthy();
    } finally {
      await fx.stop();
    }
  });

  test("persist:false 只讨论不落库", async () => {
    const fx = makeServer({ llm: scripted(() => cachedKeys) });
    let cachedKeys: string[] = [];
    try {
      seedLibrary(fx.project, 2);
      const papers = await fx.get<{ papers: Array<{ bibtexKey: string }> }>("/api/lit/papers");
      cachedKeys = papers.body.papers.map((p) => p.bibtexKey);
      const { task } = await fx.run("/api/ideas", { message: HYPOTHESIS, persist: false });
      const result = task.result as { stored: unknown; card: { hypothesis: string } };
      expect(result.stored).toBeNull();
      expect(result.card.hypothesis).toBe(HYPOTHESIS);
      const list = await fx.get<{ ideas: unknown[] }>("/api/ideas");
      expect(list.body.ideas).toEqual([]);
    } finally {
      await fx.stop();
    }
  });

  test("落卡：supports / contradicts 边方向按语义（论文 → idea）", async () => {
    let cachedKeys: string[] = [];
    const fx = makeServer({ llm: scripted(() => cachedKeys) });
    try {
      seedLibrary(fx.project, 2);
      cachedKeys = (await fx.get<{ papers: Array<{ bibtexKey: string }> }>("/api/lit/papers")).body.papers.map(
        (p) => p.bibtexKey,
      );
      const { task } = await fx.run("/api/ideas", { message: HYPOTHESIS });
      const stored = (task.result as { stored: { recordId: string; noveltyStatus: string } }).stored;
      expect(stored.noveltyStatus).toBe("unchecked");

      const detail = await fx.get<{
        idea: { hypothesis: string };
        edges: { incoming: Array<{ type: string }> };
      }>(`/api/ideas/${stored.recordId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.idea.hypothesis).toBe(HYPOTHESIS);
      // 查一条 idea 的支撑文献看它的 incoming 边（P4 定的方向口径）。
      expect(detail.body.edges.incoming.filter((e) => e.type === "supports")).toHaveLength(1);
      expect(detail.body.edges.incoming.filter((e) => e.type === "contradicts")).toHaveLength(1);
    } finally {
      await fx.stop();
    }
  });
});

// 两段链路用两个 cassette：播文献库用 alphafold cassette，novelty 密集检索用它自己的。
// 按 query 分派而不是起两台服务器——「同一个项目、同一个 server、走完整条链路」才是要测的东西。
class DualCassetteSearcher {
  constructor(
    private library: LiteratureSearcher,
    private novelty: LiteratureSearcher,
  ) {}

  search: LiteratureSearcher["search"] = (query, options) =>
    (query === SEARCH_QUERY ? this.library : this.novelty).search(query, options);

  fetchById: LiteratureSearcher["fetchById"] = (id, options) => this.library.fetchById(id, options);
}

describe("HTTP · novelty check", () => {
  test("已发表工作的 idea → checked-overlap，报告引到原文、引用核验通过、状态回写", async () => {
    let cachedKeys: string[] = [];
    const llm = scripted(() => cachedKeys);
    const searcher = new DualCassetteSearcher(
      searcherWith(CASSETTES.search, "replay"),
      noveltySearcher("replay"),
    ) as unknown as LiteratureSearcher;
    const fx = makeServer({ llm, searcher });
    try {
      cachedKeys = await seedFromFixture(fx);
      const coexplore = await fx.run("/api/ideas", { message: HYPOTHESIS });
      const stored = (coexplore.task.result as { stored: { recordId: string } }).stored;

      const { status, task } = await fx.run(`/api/ideas/${stored.recordId}/check`, {
        sources: NOVELTY_SOURCES,
        perSource: NOVELTY_PER_SOURCE,
      });
      expect(status).toBe(200);
      expect(task.state).toBe("succeeded");
      const result = task.result as {
        status: { status: string; conclusive: boolean };
        assessments: Array<{ rating: string; violations: unknown[] }>;
        markdown: string;
        citation: { unknownKeys: string[]; findings: Array<{ severity: string }> };
        conclusive: boolean;
        vetoed: boolean;
        recordId: string;
      };
      expect(result.status).toEqual({ status: "checked-overlap", conclusive: true });
      expect(result.assessments[0]!.rating).toBe("existing");
      expect(result.assessments[0]!.violations).toEqual([]);
      expect(result.markdown.toLowerCase()).toContain(PUBLISHED_CLAIM.expectTitle);
      // 引用核验复用 P3 检查器：报告里的 key 都要能回链。
      expect(result.citation.unknownKeys).toEqual([]);
      expect(result.citation.findings.filter((f) => f.severity === "hard")).toEqual([]);
      expect(result.vetoed).toBe(false);
      expect(result.conclusive).toBe(true);

      const idea = await fx.get<{ idea: { noveltyStatus: string; noveltyReportRecordId: string } }>(
        `/api/ideas/${stored.recordId}`,
      );
      expect(idea.body.idea.noveltyStatus).toBe("checked-overlap");
      expect(idea.body.idea.noveltyReportRecordId).toBe(result.recordId);

      // 报告 record 连回 idea（derives_from），两跳内能摸到支撑文献。
      const graph = await fx.get<{ nodes: Array<{ type: string }> }>(
        `/api/records/${result.recordId}/graph?depth=2`,
      );
      expect(graph.body.nodes.filter((n) => n.type === "paper").length).toBeGreaterThanOrEqual(2);

      // 状态过滤器能筛出它。
      const filtered = await fx.get<{ ideas: unknown[] }>("/api/ideas?status=checked-overlap");
      expect(filtered.body.ideas).toHaveLength(1);
    } finally {
      await fx.stop();
    }
  });

  test("对不存在的 idea 跑 check → 任务失败", async () => {
    const fx = makeServer({ llm: new ScriptedLlm([]) });
    try {
      const { status, task } = await fx.run("/api/ideas/missing/check");
      expect(status).toBe(500);
      expect(task.error?.message).toContain("missing");
    } finally {
      await fx.stop();
    }
  });
});
