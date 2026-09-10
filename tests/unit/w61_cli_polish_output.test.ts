import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { biorxivConfig } from "../../backend/src/connectors/biorxiv";
import { runLitCommand } from "../../backend/src/literature/cli";
import { decodeCommonHtmlEntities, fromBiorxiv } from "../../backend/src/literature/normalize";
import type { LiteratureSearchResult } from "../../backend/src/literature/search";

// W6-1 lane γ · CLI 上手性清扫（V54/V56）的输出断言。
//
// V54：bioRxiv「search 不是真检索」的 caveat 一直写在 capabilities 的 metadata.caveat
// 里，但 `lit sources` / `lit search` 两个人类入口只显示 ✅/免 key，caveat 看不见。
// 附带：bioRxiv 标题里的 HTML 实体（`&amp;` 等）未解码，会原样流进 BibTeX/报告。

const roots: string[] = [];

function tmpRootDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fakeSearchResult(overrides: Partial<LiteratureSearchResult> = {}): LiteratureSearchResult {
  return {
    query: "q",
    papers: [],
    sources: [],
    totalBeforeDedupe: 0,
    mergedCount: 0,
    ...overrides,
  };
}

const BIORXIV_CAVEAT = biorxivConfig.metadata?.caveat ?? "";

describe("V54 · bioRxiv caveat 在人类入口可见", () => {
  test("capabilities 的 caveat 真源本身非空（否则下面两个断言测的是空字符串，毫无意义）", () => {
    expect(BIORXIV_CAVEAT).toBeTruthy();
    expect(BIORXIV_CAVEAT).toContain("不是");
  });

  test("lit sources：biorxiv 那一行带上 capabilities 同一份 caveat 文案", async () => {
    const root = tmpRootDir("w61-lit-sources-");
    const out: string[] = [];
    const code = await runLitCommand(["sources"], { root, out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("biorxiv");
    // 真源转发，不是手抄第二份文案：断言的是 biorxivConfig.metadata.caveat 本身的内容。
    expect(text).toContain(BIORXIV_CAVEAT);
  });

  test("lit sources：没有 caveat 的源不会被硬塞一行 ⚠️（比如 openalex）", async () => {
    const root = tmpRootDir("w61-lit-sources-noop-");
    const out: string[] = [];
    await runLitCommand(["sources"], { root, out: (l) => out.push(l), err: () => {} });
    const text = out.join("\n");
    const openalexBlock = text.split("openalex")[1]?.split(/\n\s*\S+\s+(凭据|免 key)/)[0] ?? "";
    expect(openalexBlock).not.toContain("⚠️");
  });

  test("lit search：biorxiv 命中一条结果时，caveat 跟着这个源的状态行一起打印", async () => {
    const root = tmpRootDir("w61-lit-search-");
    const out: string[] = [];
    const searcher = {
      search: async () =>
        fakeSearchResult({
          query: "long covid",
          sources: [{ source: "biorxiv", outcome: "ok", count: 1, elapsedMs: 5 }],
        }),
      fetchById: async () => fakeSearchResult(),
    } as never;
    const code = await runLitCommand(["search", "long", "covid"], {
      root,
      searcher,
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(BIORXIV_CAVEAT);
  });

  test("lit search：skipped 的源不重复刷已有的 note（caveat 只对真的查了的源生效）", async () => {
    const root = tmpRootDir("w61-lit-search-skipped-");
    const out: string[] = [];
    const searcher = {
      search: async () =>
        fakeSearchResult({
          sources: [{ source: "biorxiv", outcome: "skipped", count: 0, note: "未配置凭据", elapsedMs: 0 }],
        }),
      fetchById: async () => fakeSearchResult(),
    } as never;
    await runLitCommand(["search", "x"], { root, searcher, out: (l) => out.push(l), err: () => {} });
    const text = out.join("\n");
    expect(text).not.toContain(BIORXIV_CAVEAT);
  });
});

describe("V54 附带 · bioRxiv HTML 实体解码", () => {
  test("decodeCommonHtmlEntities：常见命名实体 + 数字实体都能还原", () => {
    expect(decodeCommonHtmlEntities("COVID-19 &amp; Long Covid")).toBe("COVID-19 & Long Covid");
    expect(decodeCommonHtmlEntities("A &lt;B&gt; C")).toBe("A <B> C");
    expect(decodeCommonHtmlEntities("caf&#233;")).toBe("café");
    expect(decodeCommonHtmlEntities("caf&#xe9;")).toBe("café");
    // 没有实体的普通文本原样通过。
    expect(decodeCommonHtmlEntities("plain title")).toBe("plain title");
  });

  test("fromBiorxiv：标题与摘要里的 &amp; 解码后再落进 Paper（不会流进 BibTeX/报告）", () => {
    const paper = fromBiorxiv({
      title: "Long-term outcomes &amp; recovery after COVID-19",
      doi: "10.1101/2024.01.01.000001",
      authors: "Doe, J.",
      date: "2024-01-01",
      abstract: "This study covers safety &amp; efficacy.",
      server: "biorxiv",
    });
    expect(paper).not.toBeNull();
    expect(paper!.title).toBe("Long-term outcomes & recovery after COVID-19");
    expect(paper!.title).not.toContain("&amp;");
    expect(paper!.abstract).toBe("This study covers safety & efficacy.");
  });
});

afterAll(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 已清或从未建 */
    }
  }
});
