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
import { callTool, connectClient } from "../helpers/mcp_scenario";

// P9 退出标准的机器版：**用真实 MCP 客户端**跑通
// `lit_search → idea_coexplore → idea_novelty_check` 整条链路。
//
// 全程零网络零真实模型：检索走 P2/P4 录制的 fixture 回放，模型走 ScriptedLlm
// （它只能引用管线**真的检索到**的 key，评级还要过确定性校验层）。
// 所以这条测试验的是「外部 agent 经 MCP 能不能把事做完」，而不是 fake 会不会说话。

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
        ? JSON.stringify({ claims: [{ statement: PUBLISHED_CLAIM.statement, queries: PUBLISHED_CLAIM.queries }] })
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

// 两段链路用两个 cassette：播文献库用 alphafold cassette，novelty 密集检索用它自己的。
class DualCassetteSearcher {
  constructor(
    private library: LiteratureSearcher,
    private novelty: LiteratureSearcher,
  ) {}

  search: LiteratureSearcher["search"] = (query, options) =>
    (query === SEARCH_QUERY ? this.library : this.novelty).search(query, options);

  fetchById: LiteratureSearcher["fetchById"] = (id, options) => this.library.fetchById(id, options);
}

describe("MCP e2e · 检索文献入库 → 建 idea → novelty check（P9 退出标准）", () => {
  test("外部 agent 只用 MCP 工具即可走完整条链路", async () => {
    let cachedKeys: string[] = [];
    const llm = scripted(() => cachedKeys);
    const searcher = new DualCassetteSearcher(
      searcherWith(CASSETTES.search, "replay"),
      noveltySearcher("replay"),
    ) as unknown as LiteratureSearcher;
    const { client, close } = await connectClient({ llm, searcher });

    try {
      // ① 先 introspect：一个陌生 agent 的第一步应该是问「这里有什么」。
      const caps = await callTool<{
        connectors: Array<{ id: string; availability: string }>;
        skills: Array<{ name: string }>;
        mcp: { withheld: Array<{ name: string }> };
      }>(client, "research_capabilities");
      expect(caps.isError).toBe(false);
      expect(caps.payload.skills.map((s) => s.name)).toContain("literature-search");

      // ② 检索并入库。长任务在 MCP 层是同步的：这里直接拿到结果，没有 202。
      const search = await callTool<{
        papers: unknown[];
        added: { added: number };
        sources: Array<{ source: string; outcome: string }>;
      }>(client, "lit_search", {
        query: SEARCH_QUERY,
        sources: SEARCH_SOURCES,
        limit: PER_SOURCE,
        add: true,
        tags: ["background"],
      });
      expect(search.isError).toBe(false);
      expect(search.payload.added.added).toBeGreaterThan(0);
      // 每个源的 outcome 都要能被 agent 读到（失败源不许被静默吞掉）。
      expect(search.payload.sources.every((s) => ["ok", "skipped", "failed"].includes(s.outcome))).toBe(true);

      // ③ 库里有什么，agent 自己能查到，并拿到写引用唯一合法的 bibtexKey。
      const listed = await callTool<{ papers: Array<{ bibtexKey: string }> }>(client, "lit_list", {});
      expect(listed.isError).toBe(false);
      cachedKeys = listed.payload.papers.map((p) => p.bibtexKey);
      expect(cachedKeys.length).toBeGreaterThan(1);

      // ④ 共探出一张 Idea 卡（强制带反对证据）。
      const idea = await callTool<{
        stored: { recordId: string; noveltyStatus: string };
        card: { contradicting: unknown[] };
        emptyLibrary: boolean;
      }>(client, "idea_coexplore", { message: HYPOTHESIS });
      expect(idea.isError).toBe(false);
      expect(idea.payload.emptyLibrary).toBe(false);
      expect(idea.payload.card.contradicting.length).toBeGreaterThan(0);
      expect(idea.payload.stored.noveltyStatus).toBe("unchecked");

      // ⑤ 创新性核验：已发表工作的 idea 必须被判成 checked-overlap。
      const novelty = await callTool<{
        status: { status: string; conclusive: boolean };
        assessments: Array<{ rating: string }>;
        citation: { unknownKeys: string[] };
        vetoed: boolean;
      }>(client, "idea_novelty_check", {
        ideaId: idea.payload.stored.recordId,
        sources: NOVELTY_SOURCES,
        perSource: NOVELTY_PER_SOURCE,
      });
      expect(novelty.isError).toBe(false);
      expect(novelty.payload.status.conclusive).toBe(true);
      expect(novelty.payload.status.status).toBe("checked-overlap");
      // 报告里的引用必须都是真的（库内 ∪ 本次候选），否则 citation-integrity 会 veto。
      expect(novelty.payload.citation.unknownKeys).toEqual([]);
      expect(novelty.payload.vetoed).toBe(false);

      // ⑥ 状态回写到思路库，agent 下次能只捞没查过的。
      const ideas = await callTool<{ ideas: Array<{ recordId: string; noveltyStatus: string }> }>(
        client,
        "idea_list",
        { status: "checked-overlap" },
      );
      expect(ideas.payload.ideas.map((i) => i.recordId)).toContain(idea.payload.stored.recordId);

      // ⑦ 证据链可回溯：novelty 报告挂在 idea 上，时间线看得到全过程。
      const timeline = await callTool<{ records: Array<{ type: string }>; total: number }>(
        client,
        "records_timeline",
        { limit: 200 },
      );
      const types = new Set(timeline.payload.records.map((r) => r.type));
      expect(types.has("paper")).toBe(true);
      expect(types.has("idea")).toBe(true);
      expect(types.has("artifact")).toBe(true);

      // ⑧ 报告导出：走到这一步说明整条链的产物都进了同一张证据图。
      const report = await callTool<{ markdown: string; counts: Record<string, number> }>(
        client,
        "report_export",
        {},
      );
      expect(report.isError).toBe(false);
      expect(report.payload.markdown).toContain("# ");
    } finally {
      await close();
    }
  }, 120_000);
});
