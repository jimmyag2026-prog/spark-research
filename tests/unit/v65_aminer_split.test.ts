import { describe, expect, test } from "bun:test";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { LiteratureSearcher } from "../../backend/src/literature/search";

// V65（V8 中文召回极差的机制修复）：AMiner 的 title 检索是词序列匹配，多概念查询
// 整体扑空（主会话真 API 实测："脑机接口 信号解码"→0 而两个词各自→5）。
// 兜底：原查询 0 命中且多词 → 逐词查、按命中词数合并、note 如实标注。
// 三条边界：只对 aminer 生效 · 单词 0 命中只给提示不拆 · 失败词如实列出。

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

describe("V65 · AMiner 拆词兜底", () => {
  test("复合查询 0 命中 → 逐词查并按命中词数排序合并，note 如实标注", async () => {
    const registry = new ScriptedRegistry((source, _tool, params) => {
      if (source !== "aminer") return { data: [] };
      const q = String(params.query);
      if (q === "脑机接口 信号解码") return { data: [] };
      if (q === "脑机接口") return { data: [aminerPaper("a1", "脑机接口综述"), aminerPaper("a2", "脑机接口的信号解码方法")] };
      if (q === "信号解码") return { data: [aminerPaper("a2", "脑机接口的信号解码方法"), aminerPaper("a3", "语音信号解码")] };
      throw new Error(`意外查询: ${q}`);
    });
    const searcher = new LiteratureSearcher(registry);
    const result = await searcher.search("脑机接口 信号解码", { sources: ["aminer"], perSource: 5 });

    // alpha.6（R4 P1-6）：多词查询只取 ≥2 词同时命中——a1/a3 各只命中 1 词被排除，a2 独占。
    expect(result.papers.map((p) => p.ids.aminer)).toEqual(["a2"]);
    expect(result.sources.find((s) => s.source === "aminer")!.note).toContain("≥2 词同时命中");
    const status = result.sources.find((s) => s.source === "aminer")!;
    expect(status.outcome).toBe("ok");
    expect(status.note).toContain("拆分查询");
    expect(status.note).toContain("2 词");
    // 一次原查询 + 两次逐词
    expect(registry.calls.filter((c) => c.source === "aminer").length).toBe(3);
  });

  test("原查询有命中 → 不拆词（一次调用，note 为空）", async () => {
    const registry = new ScriptedRegistry(() => ({ data: [aminerPaper("a1", "命中")] }));
    const searcher = new LiteratureSearcher(registry);
    const result = await searcher.search("脑机接口 信号解码", { sources: ["aminer"], perSource: 5 });
    expect(result.papers.length).toBe(1);
    expect(registry.calls.length).toBe(1);
    expect(result.sources[0]!.note).toBeUndefined();
  });

  test("非 aminer 源 0 命中 → 不拆词（没有证据不泛化）", async () => {
    const registry = new ScriptedRegistry(() => ({ results: [] }));
    const searcher = new LiteratureSearcher(registry);
    const result = await searcher.search("brain computer interface neural decoding", {
      sources: ["openalex"],
      perSource: 5,
    });
    expect(registry.calls.length).toBe(1);
    expect(result.papers.length).toBe(0);
  });

  test("单词 0 命中 → 不拆，note 提示连写概念可用空格分开", async () => {
    const registry = new ScriptedRegistry(() => ({ data: [] }));
    // B-2b 之后连写中文会先试分词器；这条钉的是「没有分词器」时的既有行为，显式注入不可用的分词器。
    const searcher = new LiteratureSearcher(registry, { segmenter: async () => ({ terms: null, reason: "test: 无分词器" }) });
    const result = await searcher.search("脑机接口信号解码", { sources: ["aminer"], perSource: 5 });
    expect(registry.calls.length).toBe(1);
    expect(result.sources[0]!.note).toContain("空格");
  });

  test("部分词查询失败 → 其余词照常合并，失败词写进 note", async () => {
    const registry = new ScriptedRegistry((source, _tool, params) => {
      const q = String(params.query);
      if (q === "词A 词B") return { data: [] };
      if (q === "词A") return { data: [aminerPaper("x1", "词A 论文")] };
      if (q === "词B") throw new Error("boom");
      throw new Error(`意外查询: ${q}`);
    });
    const searcher = new LiteratureSearcher(registry);
    const result = await searcher.search("词A 词B", { sources: ["aminer"], perSource: 5 });
    expect(result.papers.length).toBe(1);
    const status = result.sources[0]!;
    expect(status.note).toContain("词B");
    expect(status.note).toContain("失败");
  });
});
