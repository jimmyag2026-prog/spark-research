import { describe, expect, test } from "bun:test";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { LiteratureSearcher, type Segmenter } from "../../backend/src/literature/search";
import type { SegmentResult } from "../../backend/src/literature/segment";

// V65 残余：`search.ts` 的 AMiner 拆词兜底（v65_aminer_split.test.ts 钉住的既有行为）
// 只认空格——连写复合词（如「运动意图解码」，中文本就没有空格）terms.length===1，
// 走不进多词合并，只给一句「用空格分开可触发拆词兜底」的提示，但中文查询本来就不会
// 有人手动加空格。本文件钉住新加的分词器入口：0 命中 + 无空格 + 含 CJK 时先试
// 分词器，成功则用分出的词走**既有**的按命中词数合并逻辑；失败/不可用/纯英文/
// 已有空格时行为不变。
//
// 分词器在这里全部**注入假实现**（`Segmenter` 类型），不依赖真装了 jieba——真实
// jieba 端到端的核验（真实 segmentQuery + search.ts 生产路径，AMiner 网络层用 stub
// 因为无凭据结构性不可达）记在 docs/devlog/W7-B2.md。
//
// 阴性对照：`search.ts` 拆词入口的 `containsCJK(query)` 判据去掉 → 下面「④ 纯英文
// 不调」这条断言必须红（纯英文查询也会被送去分词器）。

type Script = (source: string, tool: string, params: Record<string, unknown>) => unknown;

class ScriptedRegistry extends ConnectorRegistry {
  readonly calls: Array<{ source: string; tool: string; query: unknown }> = [];
  constructor(private script: Script) {
    super({});
  }
  override async call(source: string, tool: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ source, tool, query: params.query });
    return this.script(source, tool, params);
  }
}

function aminerPaper(id: string, title: string) {
  return { id, title, year: 2024, first_author: "作者" };
}

function fixedSegmenter(terms: string[] | null, reason?: string): Segmenter {
  const calls: string[] = [];
  const fn = (async (text: string): Promise<SegmentResult> => {
    calls.push(text);
    return terms ? { terms } : { terms: null, reason };
  }) as Segmenter & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("V65 残余 · 中文分词器拆词入口", () => {
  test("① 注入假分词器（固定切分）→ 拆词合并触发，note 标注 jieba 分词合并", async () => {
    const registry = new ScriptedRegistry((source, _tool, params) => {
      if (source !== "aminer") return { data: [] };
      const q = String(params.query);
      if (q === "运动意图解码") return { data: [] }; // 连写整体 0 命中
      if (q === "运动") return { data: [aminerPaper("p1", "运动康复训练")] };
      if (q === "意图") return { data: [aminerPaper("p1", "运动康复训练"), aminerPaper("p2", "意图识别")] };
      if (q === "解码") return { data: [aminerPaper("p1", "运动康复训练")] };
      throw new Error(`意外查询: ${q}`);
    });
    const segmenter = fixedSegmenter(["运动", "意图", "解码"]);
    const searcher = new LiteratureSearcher(registry, { segmenter });
    const result = await searcher.search("运动意图解码", { sources: ["aminer"], perSource: 5 });

    expect((segmenter as unknown as { calls: string[] }).calls).toEqual(["运动意图解码"]);
    // 最终跨论文顺序由 dedupePapers/applyRank（V67，另一层，本文件不测它）决定——
    // 这里只断言「分词合并本身确实把两篇论文都捞回来了」，不断言它们之间谁先谁后。
    expect(result.papers.map((p) => p.ids.aminer).sort()).toEqual(["p1", "p2"]);
    const status = result.sources.find((s) => s.source === "aminer")!;
    expect(status.outcome).toBe("ok");
    expect(status.note).toContain("jieba 分词合并");
    expect(status.note).toContain("运动、意图、解码");
  });

  test("② 分词器返回 null（不可用）→ 行为（结果/outcome/count）与 v0.6 完全一致，note 如实加注失败原因", async () => {
    const registry = new ScriptedRegistry(() => ({ data: [] }));
    const segmenter = fixedSegmenter(null, "jieba 不可用: ModuleNotFoundError");
    const searcher = new LiteratureSearcher(registry, { segmenter });
    const result = await searcher.search("运动意图解码", { sources: ["aminer"], perSource: 5 });

    // v0.6 行为：0 命中、不拆词、只打一次原查询。
    expect(result.papers.length).toBe(0);
    expect(registry.calls.length).toBe(1);
    const status = result.sources.find((s) => s.source === "aminer")!;
    expect(status.outcome).toBe("ok");
    expect(status.count).toBe(0);
    // v0.6 原始提示文案仍然完整保留（前缀不变），额外标注分词器失败原因。
    expect(status.note).toContain("0 命中。AMiner 按词序列匹配标题；若查询是多个概念连写，用空格分开可触发拆词兜底");
    expect(status.note).toContain("分词器不可用");
    expect(status.note).toContain("ModuleNotFoundError");
  });

  test("③ 查询本身有空格时不调分词器（已有 terms 可用，走既有空格拆词逻辑）", async () => {
    const registry = new ScriptedRegistry((source, _tool, params) => {
      const q = String(params.query);
      if (q === "脑机接口 信号解码") return { data: [] };
      if (q === "脑机接口") return { data: [aminerPaper("a1", "脑机接口综述")] };
      if (q === "信号解码") return { data: [aminerPaper("a1", "脑机接口综述")] };
      throw new Error(`意外查询: ${q}`);
    });
    const segmenter = fixedSegmenter(["不应该被用到"]);
    const searcher = new LiteratureSearcher(registry, { segmenter });
    await searcher.search("脑机接口 信号解码", { sources: ["aminer"], perSource: 5 });

    expect((segmenter as unknown as { calls: string[] }).calls).toEqual([]);
  });

  test("④ 纯英文查询不调分词器（无 CJK）", async () => {
    const registry = new ScriptedRegistry(() => ({ data: [] }));
    const segmenter = fixedSegmenter(["不应该被用到"]);
    const searcher = new LiteratureSearcher(registry, { segmenter });
    const result = await searcher.search("motionintentiondecoding", { sources: ["aminer"], perSource: 5 });

    expect((segmenter as unknown as { calls: string[] }).calls).toEqual([]);
    expect(result.papers.length).toBe(0);
    // v0.6 原始提示文案，没有分词器相关的任何标注。
    expect(result.sources[0]!.note).toContain("用空格分开可触发拆词兜底");
    expect(result.sources[0]!.note).not.toContain("分词器");
  });

  test("⑤（边界）分词器返回单个词（<2 词，等同没帮上忙）→ 视同不可用，退回 v0.6 行为", async () => {
    const registry = new ScriptedRegistry(() => ({ data: [] }));
    const segmenter = fixedSegmenter(["整段当一个词"]);
    const searcher = new LiteratureSearcher(registry, { segmenter });
    const result = await searcher.search("运动意图解码", { sources: ["aminer"], perSource: 5 });

    expect(registry.calls.length).toBe(1); // 没有触发多词合并的逐词查询
    expect(result.sources[0]!.note).toContain("分词器不可用");
  });
});
