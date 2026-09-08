import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { claimAffinity, contentTokens, coverage, paperIdentity, stem } from "../../backend/src/ideation/affinity";
import { CoExploreSession } from "../../backend/src/ideation/coexplore";
import {
  HIGH_AFFINITY,
  MAX_CLAIMS,
  NoveltyChecker,
  aggregateNovelty,
  assignCandidateKeys,
  buildClaimPrompt,
  buildComparePrompt,
  constrainRating,
  renderNoveltyReport,
  validateAssessmentPayload,
  validateClaimsPayload,
  type ClaimRetrieval,
  type DeclaredAssessment,
  type NoveltyCandidate,
} from "../../backend/src/ideation/novelty";
import { IdeaStore } from "../../backend/src/ideation/store";
import { emptyPaper, type Paper } from "../../backend/src/literature/models";
import type { LiteratureSearchOptions, LiteratureSearchResult } from "../../backend/src/literature/search";
import type { LiteratureSearcher } from "../../backend/src/literature/search";
import { FakeLlm, makeProjectWithPapers } from "../helpers/review_scenario";

// P4 · Novelty pipeline 单测。重点在**评级校验层**（constrainRating）：
// 它是唯一一处「模型说了不算」的地方，所以它的每条规则都要单独被打到。

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function paper(overrides: Partial<Paper> & { title: string }): Paper {
  return { ...emptyPaper(), ...overrides };
}

function candidate(key: string, affinity: number, overrides: Partial<NoveltyCandidate> = {}): NoveltyCandidate {
  return {
    key,
    paper: paper({ title: `${key} 的论文`, year: 2020 }),
    affinity,
    inLibrary: false,
    libraryPaperId: null,
    libraryRecordId: null,
    queries: ["q1"],
    ...overrides,
  };
}

function declared(overrides: Partial<DeclaredAssessment> = {}): DeclaredAssessment {
  return {
    claimId: "c1",
    rating: "existing",
    nearestWorks: [{ key: "k1", sameness: "同", difference: "异" }],
    verdict: "判词",
    ...overrides,
  };
}

// ── 相似度（确定性） ────────────────────────────────────────────────────────

describe("claim 相似度（确定性计算）", () => {
  test("轻量词尾归并两边用同一套", () => {
    expect(stem("networks")).toBe("network");
    expect(stem("studies")).toBe("study");
    expect(stem("dispensing")).toBe("dispens");
    expect(stem("sampled")).toBe("sampl");
    expect(stem("sample")).toBe("sampl");
    expect(stem("sampling")).toBe("sampl");
    // 不该动的别动
    expect(stem("sequence")).toBe("sequenc");
    expect(stem("class")).toBe("class");
  });

  test("停用词与短词被剔除", () => {
    const tokens = contentTokens("The use of a new model for the task");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("use");
    expect(tokens).toContain("model");
  });

  test("中文按二元组切，不会整句变成一个 token", () => {
    const tokens = contentTokens("序列转导");
    expect(tokens).toEqual(["序列", "列转", "转导"]);
  });

  test("覆盖率 = query 内容词落在 target 里的比例", () => {
    expect(coverage("transformer sequence transduction", "The Transformer models sequence transduction")).toBe(1);
    expect(coverage("transformer sequence transduction", "A study of protein folding")).toBe(0);
    expect(coverage("", "任何东西")).toBe(0);
  });

  test("claim 相似度取「陈述 + 各检索式」里的最大值", () => {
    const target = paper({
      title: "Attention Is All You Need",
      abstract: "We propose the Transformer, based solely on attention mechanisms, dispensing with recurrence.",
    });
    const texts = ["用自注意力替代循环结构", "transformer dispensing with recurrence"];
    // 中文陈述对英文论文覆盖率为 0，取平均会把命中的英文检索式抹平；取 max 才对
    expect(claimAffinity(["用自注意力替代循环结构"], target)).toBe(0);
    expect(claimAffinity(texts, target)).toBe(1);
  });

  test("候选身份：有 DOI 认 DOI，没有认归一化标题", () => {
    expect(paperIdentity(paper({ title: "T", doi: "10.1/x" }))).toBe("doi:10.1/x");
    expect(paperIdentity(paper({ title: "The Same  Title!" }))).toBe(paperIdentity(paper({ title: "the same title" })));
  });
});

// ── claim 提取 schema ───────────────────────────────────────────────────────

describe("claim 提取 schema 校验", () => {
  test("合法 payload：id 由代码分配", () => {
    const result = validateClaimsPayload({
      claims: [
        { statement: "A", queries: ["q1", "q2"], id: "模型自己编的 id" },
        { statement: "B", queries: ["q3", "q4", "q5"] },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.claims.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  test("检索式少于 2 条或多于 3 条都不合格", () => {
    expect(validateClaimsPayload({ claims: [{ statement: "A", queries: ["only"] }] }).ok).toBe(false);
    expect(
      validateClaimsPayload({ claims: [{ statement: "A", queries: ["1", "2", "3", "4"] }] }).ok,
    ).toBe(false);
  });

  test("claims 为空、非数组、超上限都不合格", () => {
    expect(validateClaimsPayload({ claims: [] }).ok).toBe(false);
    expect(validateClaimsPayload({ claims: "x" }).ok).toBe(false);
    expect(validateClaimsPayload("不是对象").ok).toBe(false);
    const many = { claims: Array.from({ length: MAX_CLAIMS + 1 }, () => ({ statement: "A", queries: ["a", "b"] })) };
    expect(validateClaimsPayload(many).errors.join()).toContain(`上限 ${MAX_CLAIMS}`);
  });

  test("statement 空串不合格", () => {
    expect(validateClaimsPayload({ claims: [{ statement: "  ", queries: ["a", "b"] }] }).ok).toBe(false);
  });
});

// ── 对比报告 schema ─────────────────────────────────────────────────────────

function retrieval(candidates: NoveltyCandidate[]): ClaimRetrieval {
  return {
    claim: { id: "c1", statement: "某创新点", queries: ["q1", "q2"] },
    candidates,
    sources: [{ source: "openalex", outcome: "ok", count: 3, elapsedMs: 1 }],
  };
}

describe("对比报告 schema 校验", () => {
  const r = [retrieval([candidate("k1", 0.9), candidate("k2", 0.3)])];

  test("合法输出通过", () => {
    const result = validateAssessmentPayload({ claims: [declared()] }, r);
    expect(result.ok).toBe(true);
    expect(result.assessments[0]!.rating).toBe("existing");
  });

  test("引用候选清单之外的 key → 生成器这道闸挡下（不产已知带假引用的报告）", () => {
    const bad = declared({ nearestWorks: [{ key: "vaswani2017attention", sameness: "同", difference: "异" }] });
    const result = validateAssessmentPayload({ claims: [bad] }, r);
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain("vaswani2017attention");
  });

  test("未知 rating / 缺 verdict / 漏评 claim / 重复评 claim 都不合格", () => {
    expect(validateAssessmentPayload({ claims: [declared({ rating: "maybe" as never })] }, r).ok).toBe(false);
    expect(validateAssessmentPayload({ claims: [declared({ verdict: "" })] }, r).ok).toBe(false);
    expect(validateAssessmentPayload({ claims: [] }, r).errors.join()).toContain("没有被评级");
    expect(validateAssessmentPayload({ claims: [declared(), declared()] }, r).errors.join()).toContain("评了两次");
  });

  test("sameness/difference 缺一不可", () => {
    const bad = declared({ nearestWorks: [{ key: "k1", sameness: "同", difference: "" }] });
    expect(validateAssessmentPayload({ claims: [bad] }, r).ok).toBe(false);
  });

  test("nearestWorks 为空数组能过 schema（由评级校验层判违规，两层职责分开）", () => {
    const result = validateAssessmentPayload({ claims: [declared({ nearestWorks: [] })] }, r);
    expect(result.ok).toBe(true);
  });
});

// ── 评级校验层（本阶段重点） ────────────────────────────────────────────────

describe("评级校验层 constrainRating", () => {
  test("R0 正常路径：existing 引到高相似候选 → 原样通过", () => {
    const result = constrainRating(declared(), [candidate("k1", 0.9)]);
    expect(result.rating).toBe("existing");
    expect(result.conclusive).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.topAffinity).toBe(0.9);
  });

  test("R1 检索为空 → 结论不可用（检索不到 ≠ 新颖）", () => {
    const result = constrainRating(declared({ rating: "novel", nearestWorks: [] }), []);
    expect(result.conclusive).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("no_candidates");
  });

  test("R2 有候选却不给最近邻 → 结论不可用", () => {
    const result = constrainRating(declared({ rating: "novel", nearestWorks: [] }), [candidate("k1", 0.2)]);
    expect(result.conclusive).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("rating_without_nearest");
  });

  test("R3 引用候选清单外的 key → 结论不可用", () => {
    const result = constrainRating(
      declared({ nearestWorks: [{ key: "幽灵", sameness: "同", difference: "异" }] }),
      [candidate("k1", 0.9)],
    );
    expect(result.conclusive).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("unknown_work");
  });

  test("R4 评 existing 却只引到低相似候选 → 降级为 incremental", () => {
    const result = constrainRating(declared({ rating: "existing" }), [candidate("k1", 0.3)]);
    expect(result.declaredRating).toBe("existing");
    expect(result.rating).toBe("incremental");
    expect(result.violations.map((v) => v.code)).toContain("existing_without_high_affinity");
    // 降级是有依据的校正，不是「没查出来」
    expect(result.conclusive).toBe(true);
  });

  test("R4 只看**被引用**的候选：库里有高相似的但没引，照样降级", () => {
    const result = constrainRating(declared({ rating: "existing" }), [
      candidate("k1", 0.3),
      candidate("k9", 0.95),
    ]);
    expect(result.rating).toBe("incremental");
  });

  test("R5 存在高相似候选却评 novel → 升级为 existing（模型说了不算）", () => {
    const result = constrainRating(
      declared({ rating: "novel", nearestWorks: [{ key: "k2", sameness: "同", difference: "异" }] }),
      [candidate("k1", 0.95), candidate("k2", 0.2)],
    );
    expect(result.declaredRating).toBe("novel");
    expect(result.rating).toBe("existing");
    expect(result.violations.map((v) => v.code)).toContain("novel_despite_high_affinity");
    expect(result.violations.find((v) => v.code === "novel_despite_high_affinity")!.message).toContain("k1");
  });

  test("novel + 最近邻齐全 + 无高相似候选 → 保持 novel", () => {
    const result = constrainRating(
      declared({ rating: "novel", nearestWorks: [{ key: "k1", sameness: "同", difference: "异" }] }),
      [candidate("k1", 0.4)],
    );
    expect(result.rating).toBe("novel");
    expect(result.conclusive).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("incremental 不受相似度约束，但同样必须给最近邻", () => {
    expect(constrainRating(declared({ rating: "incremental" }), [candidate("k1", 0.1)]).rating).toBe("incremental");
    const empty = constrainRating(declared({ rating: "incremental", nearestWorks: [] }), [candidate("k1", 0.1)]);
    expect(empty.conclusive).toBe(false);
  });

  test("阈值可注入，边界值算「高相似」", () => {
    expect(constrainRating(declared(), [candidate("k1", HIGH_AFFINITY)]).rating).toBe("existing");
    expect(constrainRating(declared(), [candidate("k1", 0.5)], { highAffinity: 0.4 }).rating).toBe("existing");
  });
});

describe("聚合到思路库状态", () => {
  test("任一条不可用 → 整体维持 unchecked", () => {
    const good = constrainRating(declared(), [candidate("k1", 0.9)]);
    const bad = constrainRating(declared({ rating: "novel", nearestWorks: [] }), []);
    expect(aggregateNovelty([good, bad])).toEqual({ status: "unchecked", conclusive: false });
  });

  test("全部可用时取最保守的一条", () => {
    const existing = constrainRating(declared(), [candidate("k1", 0.9)]);
    const novel = constrainRating(
      declared({ rating: "novel", nearestWorks: [{ key: "k1", sameness: "同", difference: "异" }] }),
      [candidate("k1", 0.2)],
    );
    expect(aggregateNovelty([existing, novel]).status).toBe("checked-overlap");
    expect(aggregateNovelty([novel]).status).toBe("checked-novel");
    expect(aggregateNovelty([])).toEqual({ status: "unchecked", conclusive: false });
  });
});

// ── key 分配与报告渲染 ──────────────────────────────────────────────────────

describe("候选 key 分配", () => {
  test("库内论文的 key 不被库外候选顶掉", () => {
    const f = makeProjectWithPapers(3, "keys");
    roots.push(f.root);
    const externals = [paper({ title: "Paper 1 on protein structure prediction", authors: [{ name: "Alice Jumper" }], year: 2020 })];
    const { libraryKeys, externalKeys } = assignCandidateKeys(f.library.list(), externals);
    expect(libraryKeys).toEqual(f.keys);
    // 同名同年的库外候选只能拿到带后缀的 key，不会与库内 key 撞车
    expect(externalKeys[0]).not.toBe(libraryKeys[0]);
    expect(new Set([...libraryKeys, ...externalKeys]).size).toBe(4);
    f.library.close();
    f.project.close();
  });
});

describe("报告渲染", () => {
  const idea = {
    recordId: "idea-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    hypothesis: "某个假设",
    critique: "讨论",
    supporting: [],
    contradicting: [],
    openQuestions: [],
    noveltyStatus: "unchecked" as const,
    noveltyReportRecordId: null,
    checkedAt: null,
    model: null,
  };

  test("模型评级被校正时，两个评级都出现在报告里", () => {
    const cands = [candidate("k1", 0.95)];
    const assessment = constrainRating(
      declared({ rating: "novel", nearestWorks: [{ key: "k1", sameness: "同", difference: "异" }] }),
      cands,
    );
    const md = renderNoveltyReport({
      idea,
      retrievals: [retrieval(cands)],
      assessments: [assessment],
      aggregate: aggregateNovelty([assessment]),
      sources: ["openalex"],
      generatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(md).toContain("模型原判 novel");
    expect(md).toContain("novel_despite_high_affinity");
    expect(md).toContain("[@k1]");
    // 相似度由代码算出来写进报告，读者能自己核
    expect(md).toContain("0.95");
  });

  test("结论不可用时报告明说状态维持 unchecked", () => {
    const assessment = constrainRating(declared({ rating: "novel", nearestWorks: [] }), []);
    const md = renderNoveltyReport({
      idea,
      retrievals: [retrieval([])],
      assessments: [assessment],
      aggregate: aggregateNovelty([assessment]),
      sources: ["openalex"],
    });
    expect(md).toContain("本次未得出可用结论");
    expect(md).toContain("no_candidates");
  });
});

describe("prompt 构造", () => {
  test("claim prompt 带上假设、证据与待验证点", () => {
    const prompt = buildClaimPrompt({
      recordId: "i1",
      createdAt: "",
      hypothesis: "自注意力可以替代循环",
      critique: "",
      supporting: [{ key: "a2020x", note: "支持", inferred: false }],
      contradicting: [{ key: null, note: "推断的反例", inferred: true }],
      openQuestions: ["长序列上是否成立"],
      noveltyStatus: "unchecked",
      noveltyReportRecordId: null,
      checkedAt: null,
      model: null,
    });
    expect(prompt).toContain("自注意力可以替代循环");
    expect(prompt).toContain("[@a2020x]");
    expect(prompt).toContain("（inferred）");
    expect(prompt).toContain("长序列上是否成立");
  });

  test("对比 prompt 按 claim 分段列候选，并写明只能引这些 key", () => {
    const prompt = buildComparePrompt([retrieval([candidate("k1", 0.9), candidate("k2", 0.1)])]);
    expect(prompt).toContain("### c1:");
    expect(prompt).toContain("[@k1]");
    expect(prompt).toContain("只能引用这里的 key");
  });

  test("候选为空时 prompt 明确禁止「查不到就判 novel」", () => {
    expect(buildComparePrompt([retrieval([])])).toContain("不要因此判 novel");
  });
});

// ── 管线（注入假 searcher，零网络） ─────────────────────────────────────────

class StubSearcher {
  readonly queries: string[] = [];
  constructor(private byQuery: Record<string, Paper[]>) {}
  search = async (query: string, _options: LiteratureSearchOptions = {}): Promise<LiteratureSearchResult> => {
    this.queries.push(query);
    const papers = this.byQuery[query] ?? [];
    return {
      query,
      papers,
      sources: [{ source: "openalex", outcome: "ok", count: papers.length, elapsedMs: 1 }],
      totalBeforeDedupe: papers.length,
      mergedCount: 0,
    };
  };
}

describe("NoveltyChecker 管线", () => {
  async function seed(slug: string) {
    const f = makeProjectWithPapers(3, slug);
    roots.push(f.root);
    const records = f.project.records();
    const llm = new FakeLlm([
      JSON.stringify({
        critique: `讨论[@${f.keys[0]}]。`,
        hypothesis: "自注意力可以替代循环结构做序列转导",
        supporting: [{ key: f.keys[0], note: "支持" }],
        contradicting: [{ key: f.keys[1], note: "反对" }],
        openQuestions: ["长序列上是否成立"],
      }),
    ]);
    const idea = (await new CoExploreSession({ llm, library: f.library, records }).explore("想法", {
      sessionId: "p4",
    })).stored;
    return { f, records, idea };
  }

  const claimsJson = JSON.stringify({
    claims: [{ statement: "自注意力替代循环结构做序列转导", queries: ["self attention transduction", "transformer recurrence"] }],
  });

  test("全链路：claim → 检索 → 评级 → 报告落 artifact/record → 状态回写", async () => {
    const { f, records, idea } = await seed("novelty-pipeline");
    const hit = paper({
      title: "Attention Is All You Need",
      abstract: "A transformer based solely on self attention, replacing recurrence for sequence transduction.",
      doi: "10.1/attn",
      year: 2017,
    });
    const searcher = new StubSearcher({
      "self attention transduction": [hit],
      "transformer recurrence": [hit, paper({ title: "无关的论文", year: 2001 })],
    });
    const llm = new FakeLlm([
      claimsJson,
      // 第二次调用是对比评级：引用 prompt 里出现的候选 key
      "PLACEHOLDER",
    ]);
    // 对比阶段需要知道候选 key，用一个按 prompt 取 key 的 fake
    const scripted = {
      call: async (messages: Parameters<typeof llm.call>[0], model?: string) => {
        const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        if (!user.includes("候选工作")) return llm.call(messages, model);
        const key = user.match(/- \[@([^\]]+)\] Attention Is All You Need/)![1]!;
        return {
          ok: true as const,
          provider: "kimi" as const,
          model: model ?? "m",
          mock: false,
          content: JSON.stringify({
            claims: [
              {
                claimId: "c1",
                rating: "existing",
                nearestWorks: [{ key, sameness: "同样用自注意力替代循环", difference: "无实质差异" }],
                verdict: "已被做过",
              },
            ],
          }),
        };
      },
    };

    const checker = new NoveltyChecker({
      llm: scripted,
      searcher: searcher as unknown as LiteratureSearcher,
      library: f.library,
      records,
      artifacts: f.project.artifacts(),
      workDir: f.project.paths.artifactsDir,
    });
    const result = await checker.check(idea, { sessionId: "p4" });

    expect(searcher.queries).toEqual(["self attention transduction", "transformer recurrence"]);
    expect(result.assessments[0]!.rating).toBe("existing");
    expect(result.aggregate).toEqual({ status: "checked-overlap", conclusive: true });
    expect(result.citation.findings.filter((f) => f.severity === "hard")).toHaveLength(0);
    expect(result.artifactId).toBeTruthy();

    // 回写：状态 + 报告指针
    const stored = new IdeaStore(records, f.library).get(idea.recordId)!;
    expect(stored.noveltyStatus).toBe("checked-overlap");
    expect(stored.noveltyReportRecordId).toBe(result.recordId);

    // 证据图：报告 --derives_from--> idea
    const outgoing = records.edgesOf(result.recordId!).outgoing;
    expect(outgoing.filter((e) => e.type === "derives_from").map((e) => e.targetId)).toEqual([idea.recordId]);
    f.library.close();
    f.project.close();
  });

  test("候选命中库内论文时补一条 cites 边", async () => {
    const { f, records, idea } = await seed("novelty-cites");
    const inLibrary = f.library.list()[0]!;
    const searcher = new StubSearcher({
      "self attention transduction": [
        paper({ title: inLibrary.title, doi: inLibrary.doi, year: inLibrary.year, abstract: inLibrary.abstract }),
      ],
      "transformer recurrence": [],
    });
    const scripted = {
      call: async (messages: { role: string; content: string }[], model?: string) => {
        const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        if (!user.includes("候选工作")) {
          return { ok: true as const, provider: "kimi" as const, model: model ?? "m", mock: false, content: claimsJson };
        }
        const key = user.match(/- \[@([^\]]+)\]/)![1]!;
        return {
          ok: true as const,
          provider: "kimi" as const,
          model: model ?? "m",
          mock: false,
          content: JSON.stringify({
            claims: [
              {
                claimId: "c1",
                rating: "incremental",
                nearestWorks: [{ key, sameness: "同", difference: "异" }],
                verdict: "接近",
              },
            ],
          }),
        };
      },
    };
    const checker = new NoveltyChecker({
      llm: scripted,
      searcher: searcher as unknown as LiteratureSearcher,
      library: f.library,
      records,
      artifacts: f.project.artifacts(),
      workDir: f.project.paths.artifactsDir,
    });
    const result = await checker.check(idea);
    const outgoing = records.edgesOf(result.recordId!).outgoing;
    expect(outgoing.filter((e) => e.type === "cites").map((e) => e.targetId)).toEqual([inLibrary.recordId!]);
    // 库内候选沿用它在 P3 里的 bibtex key
    expect(result.retrievals[0]!.candidates[0]!.key).toBe(f.keys[0]);
    expect(result.retrievals[0]!.candidates[0]!.inLibrary).toBe(true);
    f.library.close();
    f.project.close();
  });

  test("检索全空 → 状态不推进（unchecked），但报告照样落库", async () => {
    const { f, records, idea } = await seed("novelty-empty");
    const searcher = new StubSearcher({});
    const scripted = {
      call: async (messages: { role: string; content: string }[], model?: string) => {
        const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        const content = user.includes("候选工作")
          ? JSON.stringify({ claims: [{ claimId: "c1", rating: "novel", nearestWorks: [], verdict: "查不到" }] })
          : claimsJson;
        return { ok: true as const, provider: "kimi" as const, model: model ?? "m", mock: false, content };
      },
    };
    const checker = new NoveltyChecker({
      llm: scripted,
      searcher: searcher as unknown as LiteratureSearcher,
      library: f.library,
      records,
      artifacts: f.project.artifacts(),
      workDir: f.project.paths.artifactsDir,
    });
    const result = await checker.check(idea);
    expect(result.aggregate.conclusive).toBe(false);
    expect(new IdeaStore(records, f.library).get(idea.recordId)!.noveltyStatus).toBe("unchecked");
    // 「查过但没查出来」与「没查过」要能区分：报告指针写回去了
    expect(new IdeaStore(records, f.library).get(idea.recordId)!.noveltyReportRecordId).toBe(result.recordId);
    f.library.close();
    f.project.close();
  });

  test("claim 提取两次都不合 schema → 抛错，不落任何 record", async () => {
    const { f, records, idea } = await seed("novelty-badclaims");
    const before = records.count();
    const checker = new NoveltyChecker({
      llm: new FakeLlm(['{"claims":[]}']),
      searcher: new StubSearcher({}) as unknown as LiteratureSearcher,
      library: f.library,
      records,
      artifacts: f.project.artifacts(),
      workDir: f.project.paths.artifactsDir,
    });
    await expect(checker.check(idea)).rejects.toThrow(/claim 提取失败/);
    expect(records.count()).toBe(before);
    f.library.close();
    f.project.close();
  });

  test("persist:false 时只出报告不落库", async () => {
    const { f, records, idea } = await seed("novelty-dry");
    const before = records.count();
    const searcher = new StubSearcher({ "self attention transduction": [paper({ title: "某工作" })] });
    const scripted = {
      call: async (messages: { role: string; content: string }[], model?: string) => {
        const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        if (!user.includes("候选工作")) {
          return { ok: true as const, provider: "kimi" as const, model: model ?? "m", mock: false, content: claimsJson };
        }
        const key = user.match(/- \[@([^\]]+)\]/)![1]!;
        return {
          ok: true as const,
          provider: "kimi" as const,
          model: model ?? "m",
          mock: false,
          content: JSON.stringify({
            claims: [{ claimId: "c1", rating: "novel", nearestWorks: [{ key, sameness: "同", difference: "异" }], verdict: "新" }],
          }),
        };
      },
    };
    const result = await new NoveltyChecker({
      llm: scripted,
      searcher: searcher as unknown as LiteratureSearcher,
      library: f.library,
      records,
      artifacts: f.project.artifacts(),
      workDir: f.project.paths.artifactsDir,
    }).check(idea, { persist: false });
    expect(result.recordId).toBeNull();
    expect(records.count()).toBe(before);
    expect(result.markdown).toContain("Novelty check 报告");
    f.library.close();
    f.project.close();
  });
});
