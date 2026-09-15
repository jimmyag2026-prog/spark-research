import { describe, expect, test } from "bun:test";
import {
  dictionaryTranslate,
  llmQueryTranslator,
  prepareQuery,
  sanitizeEnglish,
  PREPARE_QUERY_MAX_TOKENS,
} from "../../backend/src/literature/prepare_query";
import { LiteratureSearcher, mergeStatusesBySource, searchLanguageParams } from "../../backend/src/literature/search";
import { applyRelevanceFloor, countTermHits, relevanceTerms } from "../../backend/src/literature/prepare_query";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";

// v0.10 lane γ-2（V161 + U58）门禁。
//
// 纪律（_COMMON §3）：**钉接线，不只钉内容**。U40/U47 的教训是判据存在但没被读到，
// 测试照样绿。所以下面每一组都有一条「这个东西真的被 LiteratureSearcher.search 用上了」
// 的断言，而不只是「prepareQuery 这个函数自己算得对」。

describe("γ-2 ① prepareQuery：纯英文 passthrough，中文才动", () => {
  test("纯英文查询一个字节都不碰", async () => {
    const p = await prepareQuery("repetitive strain injury prevention office workers");
    expect(p.hasCJK).toBe(false);
    expect(p.via).toBe("passthrough");
    expect(p.queries).toEqual(["repetitive strain injury prevention office workers"]);
    expect(p.note).toBeNull();
  });

  test("中文查询走 LLM 英译，原查询仍在 queries[0]（中英双查，不是英译替换）", async () => {
    const p = await prepareQuery("重复性劳损 预防 办公人群", {
      translate: async () => "repetitive strain injury prevention office workers",
    });
    expect(p.via).toBe("llm");
    expect(p.queries[0]).toBe("重复性劳损 预防 办公人群");
    expect(p.queries[1]).toBe("repetitive strain injury prevention office workers");
    expect(p.note).toContain("英译");
  });

  test("LLM 不可用时退词典兜底，不是静默 passthrough", async () => {
    const p = await prepareQuery("重复性劳损 预防 办公人群", { translate: async () => null });
    expect(p.via).toBe("dictionary");
    expect(p.english).toBe("repetitive strain injury prevention office workers");
  });

  test("词典也没覆盖时如实标 failed，并在 note 里说清后果——不许伪装成「不需要翻译」", async () => {
    const p = await prepareQuery("紫甘蓝腌渍工艺", { translate: async () => null });
    expect(p.via).toBe("failed");
    expect(p.english).toBeNull();
    expect(p.queries).toEqual(["紫甘蓝腌渍工艺"]);
    expect(p.note).toContain("查准率");
  });
});

describe("γ-2 ② 译文清洗：半译的串一律判失败", () => {
  test("模型带上解释、引号、编号都能清干净", () => {
    expect(sanitizeEnglish('Here are the keywords:\n"repetitive strain injury, prevention, office workers"')).toBe(
      "repetitive strain injury prevention office workers",
    );
  });

  test("译文里还留着中文 → null（半个中文串送去英文源就是 U58 的病灶本身）", () => {
    expect(sanitizeEnglish("repetitive strain injury 预防 office workers")).toBeNull();
  });

  test("词典半译时残渣不进英文串，且在 untranslated 里点名", () => {
    const r = dictionaryTranslate("预防 紫甘蓝");
    expect(r.english).toBe("prevention");
    expect(r.untranslated).toEqual(["紫甘蓝"]);
  });

  test("LLM 译者一次调用的 maxTokens 卡在 200（任务书口径）", async () => {
    const seen: Array<{ maxTokens?: number }> = [];
    const translate = llmQueryTranslator({
      call: async (_m, o) => {
        seen.push(o ?? {});
        return { ok: true, content: "prevention" };
      },
    });
    await translate("预防");
    expect(seen[0]?.maxTokens).toBe(PREPARE_QUERY_MAX_TOKENS);
    expect(PREPARE_QUERY_MAX_TOKENS).toBe(200);
  });

  test("LLM 抛异常不炸整条检索，返回 null 让上层退词典", async () => {
    const translate = llmQueryTranslator({
      call: async () => {
        throw new Error("upstream down");
      },
    });
    expect(await translate("预防")).toBeNull();
  });
});

// ── 接线断言：下面这组才是真正的门 ────────────────────────────────────────
//
// 上面全绿而下面全红，正是 V161 修之前的状态：处理层写好了，检索不读它。

function stubRegistry(seen: Array<{ source: string; params: Record<string, unknown> }>): ConnectorRegistry {
  const registry = new ConnectorRegistry({}).registerBuiltins();
  const original = registry.call.bind(registry);
  (registry as unknown as { call: typeof original }).call = (async (
    source: string,
    tool: string,
    params: Record<string, unknown>,
  ) => {
    seen.push({ source, params });
    // OpenAlex 形状的空结果：走得通归一化，不产生论文。
    return { results: [], meta: { count: 0 } };
  }) as typeof original;
  return registry;
}

describe("γ-2 ③ 接线：LiteratureSearcher 真的中英双查", () => {
  test("中文查询 → 同一个源被查了两次（中文串 + 英文串）", async () => {
    const seen: Array<{ source: string; params: Record<string, unknown> }> = [];
    const searcher = new LiteratureSearcher(stubRegistry(seen), {
      translate: async () => "repetitive strain injury prevention office workers",
    });
    const r = await searcher.search("重复性劳损 预防 办公人群", { sources: ["openalex"] });

    const queries = seen.filter((s) => s.source === "openalex").map((s) => s.params.query);
    expect(queries).toContain("重复性劳损 预防 办公人群");
    expect(queries).toContain("repetitive strain injury prevention office workers");
    // 面板口径是一行一个源：双查之后 sources 仍然只有一条 openalex。
    expect(r.sources.filter((s) => s.source === "openalex")).toHaveLength(1);
    expect(r.prepared?.via).toBe("llm");
  });

  test("纯英文查询 → 只查一次（passthrough 不改变既有行为）", async () => {
    const seen: Array<{ source: string; params: Record<string, unknown> }> = [];
    const searcher = new LiteratureSearcher(stubRegistry(seen), {
      translate: async () => "should never be called",
    });
    await searcher.search("protein structure prediction", { sources: ["openalex"] });
    expect(seen.filter((s) => s.source === "openalex")).toHaveLength(1);
  });
});

describe("γ-2 ④ searchLanguage：OpenAlex 语言过滤开关", () => {
  test("默认（未配置）不过滤", () => {
    expect(searchLanguageParams("openalex")).toEqual({});
  });

  test("配了 zh 时 OpenAlex 带上 filter=language:zh", () => {
    const prev = process.env.SPARK_RESEARCH_SEARCH_LANGUAGE;
    process.env.SPARK_RESEARCH_SEARCH_LANGUAGE = "zh";
    try {
      expect(searchLanguageParams("openalex")).toEqual({ filter: "language:zh" });
      // 只对 OpenAlex 生效——给别的源编一个等价物就是在说假话。
      expect(searchLanguageParams("europepmc")).toEqual({});
      expect(searchLanguageParams("aminer")).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.SPARK_RESEARCH_SEARCH_LANGUAGE;
      else process.env.SPARK_RESEARCH_SEARCH_LANGUAGE = prev;
    }
  });

  test("乱码语言码当没配（读侧校验：env 那条路不经 writeSetting）", () => {
    const prev = process.env.SPARK_RESEARCH_SEARCH_LANGUAGE;
    process.env.SPARK_RESEARCH_SEARCH_LANGUAGE = "zh-CN-garbage";
    try {
      expect(searchLanguageParams("openalex")).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.SPARK_RESEARCH_SEARCH_LANGUAGE;
      else process.env.SPARK_RESEARCH_SEARCH_LANGUAGE = prev;
    }
  });
});

describe("γ-2 ⑤ 同源多条状态合并", () => {
  test("一个源只有一条时**原样返回那个对象**（单查询路径逐字节不变）", () => {
    const entry = { status: { source: "openalex" as const, outcome: "ok" as const, count: 3, elapsedMs: 10 }, papers: [] };
    const merged = mergeStatusesBySource([entry]);
    expect(merged[0]).toBe(entry); // 同一性，不是等值
  });

  test("一条 ok 一条 failed → 算这个源参与了，条数相加、耗时取最长（不是求和）", () => {
    const merged = mergeStatusesBySource([
      { status: { source: "openalex", outcome: "ok", count: 30, elapsedMs: 900 }, papers: [] },
      { status: { source: "openalex", outcome: "failed", count: 0, error: "429", elapsedMs: 1200 }, papers: [] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status.outcome).toBe("ok");
    expect(merged[0]!.status.count).toBe(30);
    expect(merged[0]!.status.elapsedMs).toBe(1200);
    expect(merged[0]!.status.error).toBe("429");
  });

  test("两条都 skipped → 仍是 skipped（不许因为「查过两次」就升成 ok）", () => {
    const merged = mergeStatusesBySource([
      { status: { source: "aminer", outcome: "skipped", count: 0, note: "未配置凭据", elapsedMs: 0 }, papers: [] },
      { status: { source: "aminer", outcome: "skipped", count: 0, note: "未配置凭据", elapsedMs: 0 }, papers: [] },
    ]);
    expect(merged[0]!.status.outcome).toBe("skipped");
    expect(merged[0]!.status.note).toBe("未配置凭据");
  });
});

// ── γ-2 ⑦ 译后相关性地板（实测残余：译文对了，池子仍是噪声）───────────────

const FLOOR_PREPARED = {
  original: "重复性劳损 预防 办公人群",
  hasCJK: true,
  queries: ["重复性劳损 预防 办公人群", "repetitive strain injury prevention office workers"],
  english: "repetitive strain injury prevention office workers",
  via: "llm" as const,
  note: null,
};

describe("γ-2 ⑦ 相关性地板", () => {
  const relevant = { title: "Ergonomic interventions for preventing musculoskeletal disorders among office workers", abstract: null, venue: null };
  // U58 现场原样：被引 6550 的心血管指南，只被 "prevention" 一个通用词捞上来。
  const noise = { title: "2016 European Guidelines on cardiovascular disease prevention in clinical practice", abstract: null, venue: null };

  test("词干化：workers/worker、prevention/preventing 都算命中", () => {
    const terms = relevanceTerms("repetitive strain injury prevention office workers");
    expect(terms).toContain("worker");
    expect(countTermHits(relevant, terms)).toBeGreaterThanOrEqual(2);
  });

  test("只命中一个通用词的高被引噪声被滤掉（U58 现场原样）", () => {
    const terms = relevanceTerms("repetitive strain injury prevention office workers");
    expect(countTermHits(noise, terms)).toBe(1);
    const r = applyRelevanceFloor([noise, relevant], FLOOR_PREPARED);
    expect(r.applied).toBe(true);
    expect(r.papers).toEqual([relevant]);
    expect(r.note).toContain("滤掉 1 条");
  });

  test("词首匹配：injury 不该命中 perjury（substring 匹配会）", () => {
    expect(countTermHits({ title: "A study of perjury in court" }, ["injury"])).toBe(0);
  });

  test("passthrough（用户自己打的英文查询）不被二次判定相关性", () => {
    const r = applyRelevanceFloor([noise], { ...FLOOR_PREPARED, via: "passthrough", english: null, hasCJK: false });
    expect(r.applied).toBe(false);
    expect(r.papers).toEqual([noise]);
  });

  test("滤完一条不剩 → 整体作废并如实说明（宁可给噪声，不给空白）", () => {
    const r = applyRelevanceFloor([noise], FLOOR_PREPARED);
    expect(r.applied).toBe(false);
    expect(r.papers).toEqual([noise]);
    expect(r.note).toContain("整体作废");
  });

  test("接线：地板在 limit 截断**之前**生效（否则 6 条噪声会被滤成 2 条）", async () => {
    const registry = new ConnectorRegistry({}).registerBuiltins();
    const mk = (title: string, doi: string) => ({ id: `https://openalex.org/W${doi}`, doi: `https://doi.org/${doi}`, display_name: title, publication_year: 2020, cited_by_count: 1, authorships: [] });
    (registry as unknown as { call: unknown }).call = async (_s: string, _t: string, params: Record<string, unknown>) =>
      String(params.query).startsWith("repetitive")
        ? { results: [mk(noise.title, "10.1/a"), mk(relevant.title, "10.1/b")], meta: { count: 2 } }
        : { results: [], meta: { count: 0 } };
    const searcher = new LiteratureSearcher(registry, { translate: async () => FLOOR_PREPARED.english });
    const r = await searcher.search("重复性劳损 预防 办公人群", { sources: ["openalex"], limit: 2 });
    expect(r.papers.map((p) => p.title)).toEqual([relevant.title]);
    expect(r.prepared?.note).toContain("相关性地板");
  });
});

// ── γ-2 ⑥ 零摘要不精读（U58 ③）────────────────────────────────────────────
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { runLiteraturePipeline } from "../../backend/src/agents/literature_pipeline";
import { LibraryStore } from "../../backend/src/literature/library";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import type { LiteratureSearchResult } from "../../backend/src/literature/search";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

const CARD_JSON = JSON.stringify({
  researchQuestion: "q",
  methods: "m",
  keyFindings: ["f"],
  limitations: ["l"],
  relationToProject: "r",
});

class EchoLlm {
  readonly prompts: string[] = [];
  /** 综述那一次要给一个**库内**的 [@key]，否则 citation-integrity 会 veto、流程抛错。 */
  constructor(private readonly reviewKey: () => string) {}
  async call(messages: ChatMessage[]): Promise<LlmResponse> {
    const prompt = messages.map((m) => m.content).join("\n");
    this.prompts.push(prompt);
    const isReview = /综述|review draft/i.test(prompt) && !/researchQuestion/.test(prompt);
    const content = isReview ? `# 综述\n\n一句话[@${this.reviewKey()}]。` : CARD_JSON;
    return { ok: true, content, provider: "kimi", model: "t", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as LlmResponse;
  }
}

function firstLibraryKey(libraryDb: string): string {
  const lib = new LibraryStore(libraryDb);
  try { return libraryKeyIndex(lib.list()).keys[0] ?? "unknown"; } finally { lib.close(); }
}

const mkPaper = (i: number, abstract: string | null) => ({
  title: `Zero abstract probe ${i}`,
  authors: [{ name: "A" }],
  year: 2023,
  venue: "V",
  doi: `10.1000/za.${i}`,
  ids: { doi: `10.1000/za.${i}` },
  abstract,
  url: null,
  pdfUrl: null,
  citedByCount: 1,
  isOpenAccess: false,
  sources: ["aminer"],
  references: [],
});

describe("γ-2 ⑥ AMiner 零摘要：abstract=null 且没拿到 PDF → 精读跳过", () => {
  let root: string;
  let pm: ProjectManager;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "w10g-")); pm = new ProjectManager(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("零摘要论文不进 generateMany；有摘要的照读；跳过原因进 failures", async () => {
    const project = pm.create("g2-skip", { name: "x" });
    const searcher = {
      async search(query: string): Promise<LiteratureSearchResult> {
        return {
          query,
          sources: [{ source: "aminer", outcome: "ok", count: 2, elapsedMs: 1 }],
          papers: [mkPaper(1, "有摘要：这篇能读"), mkPaper(2, null)],
        } as unknown as LiteratureSearchResult;
      },
    };
    const llm = new EchoLlm(() => firstLibraryKey(project.paths.libraryDb));
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s", searcher, downloadPdf: async () => ({ ok: false, reason: "no OA" }) },
      { mode: "review", queries: ["零摘要探针"], maxRead: 2 },
    );
    const skipped = r.failures.filter((f) => f.includes("跳过精读"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("Zero abstract probe 2");
    // 接线断言：被跳过的那篇的标题**一次都没进过 prompt**。
    expect(llm.prompts.join("\n")).not.toContain("Zero abstract probe 2");
    expect(llm.prompts.join("\n")).toContain("Zero abstract probe 1");
    project.close();
  });

  test("零摘要但 PDF 下到了 → 照读（判据是「有没有材料」，不是「有没有摘要」）", async () => {
    const project = pm.create("g2-pdf", { name: "x" });
    const searcher = {
      async search(query: string): Promise<LiteratureSearchResult> {
        return {
          query,
          sources: [{ source: "aminer", outcome: "ok", count: 1, elapsedMs: 1 }],
          papers: [mkPaper(3, null)],
        } as unknown as LiteratureSearchResult;
      },
    };
    const llm = new EchoLlm(() => firstLibraryKey(project.paths.libraryDb));
    const r = await runLiteraturePipeline(
      { llm, project, sessionId: "s", searcher, downloadPdf: async () => ({ ok: true }) },
      { mode: "review", queries: ["零摘要但有 PDF"], maxRead: 1 },
    );
    expect(r.failures.filter((f) => f.includes("跳过精读"))).toHaveLength(0);
    expect(llm.prompts.join("\n")).toContain("Zero abstract probe 3");
    project.close();
  });
});
