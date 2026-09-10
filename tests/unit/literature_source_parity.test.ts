import { describe, expect, test } from "bun:test";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import {
  DEFAULT_SEARCH_SOURCES,
  DEFAULT_SOURCE_EXCLUSIONS,
  LITERATURE_SOURCES,
  type LiteratureSource,
} from "../../backend/src/literature/models";

// V34 门禁：**已实装的文献源必须在 `DEFAULT_SEARCH_SOURCES` 里，或在显式排除表里带理由。**
//
// 为什么要另开一条断言，而不是靠 AD-12：
// AD-12 核的是「arxiv 在不在连接器注册表」——W3-d 把 arxiv / pubmed 接通之后它一直是绿的。
// 它核不了「默认值有没有跟着改」。于是 v0.5 闸门 F 的零上下文外部验收撞上了这个组合：
//   `lit search --sources arxiv` ✅ · `capabilities --json` 报 arxiv 可用 ✅
//   · `lit add 1706.03762`（走默认值）❌ 未找到
// 能力做好了、默认值没跟着改，而整条门禁链条上没有任何一条断言看着这件事。
//
// 真源的选择是这条门禁的关键：**以 ConnectorRegistry 的 literature 域清单为准**，
// 不以 `LITERATURE_SOURCES` 常量为准。后者本身就是一份手写副本，拿它当真源等于自证自明
// ——「注册表里加了新源，两张手写表都没跟上」这一类恰恰就抓不到（V34 就是这个形状）。

interface RegistryLiteratureSource {
  name: string;
  apiKeyRequired: boolean;
  placeholder: boolean;
}

function registryLiteratureSources(): RegistryLiteratureSource[] {
  const registry = new ConnectorRegistry().registerBuiltins();
  return registry
    .listAll()
    .filter((entry) => entry.domain === "literature")
    .map((entry) => ({
      name: entry.name,
      apiKeyRequired: entry.metadata?.apiKeyRequired === true,
      placeholder: entry.metadata?.status === "placeholder",
    }));
}

const exclusionByName = new Map(DEFAULT_SOURCE_EXCLUSIONS.map((e) => [e.source as string, e]));

describe("文献源与默认检索集的对等（V34 门禁）", () => {
  test("注册表的 literature 域非空，且这条门禁真的读到了源（门禁本身不能空转）", () => {
    const sources = registryLiteratureSources();
    expect(sources.length).toBeGreaterThanOrEqual(6);
    // 这条门禁存在的直接原因：W3-d 接通的两个源。它们必须真的在注册表里，
    // 否则下面所有断言都会因为「集合是空的」而虚假通过。
    expect(sources.map((s) => s.name)).toContain("arxiv");
    expect(sources.map((s) => s.name)).toContain("pubmed");
  });

  test("每个已实装的源：要么在默认集里，要么在排除表里带理由", () => {
    const missing: string[] = [];
    for (const source of registryLiteratureSources()) {
      const inDefaults = (DEFAULT_SEARCH_SOURCES as string[]).includes(source.name);
      const excluded = exclusionByName.has(source.name);
      if (!inDefaults && !excluded) missing.push(source.name);
    }
    expect(missing).toEqual([]);
  });

  test("排除必须有合法理由：只有 apiKeyRequired 或 placeholder 的源可以不在默认集里", () => {
    const sources = new Map(registryLiteratureSources().map((s) => [s.name, s]));
    const illegitimate: string[] = [];
    for (const exclusion of DEFAULT_SOURCE_EXCLUSIONS) {
      const source = sources.get(exclusion.source);
      // 排除一个注册表里根本不存在的源 = 表过期了，同样要红。
      if (!source) {
        illegitimate.push(`${exclusion.source}（不在连接器注册表里）`);
        continue;
      }
      // 免 key 且 status=available 的源**没有**合法排除理由——只能进默认集。
      // 这一条是防「把排除表放宽成一张万能豁免表」的那道闩：
      // 少了它，V34 的修法可以退化成「把 arxiv 写进排除表」，门禁照样绿。
      if (!source.apiKeyRequired && !source.placeholder) {
        illegitimate.push(`${exclusion.source}（免 key 且 available，不构成合法排除）`);
      }
    }
    expect(illegitimate).toEqual([]);
  });

  test("排除理由必须是实质文本，不能是空串/占位符", () => {
    for (const exclusion of DEFAULT_SOURCE_EXCLUSIONS) {
      expect(exclusion.reason.trim().length).toBeGreaterThanOrEqual(10);
      expect(exclusion.reason).not.toMatch(/^(TODO|TBD|待补|N\/A)/i);
    }
  });

  test("排除表与默认集互斥：同一个源不能既在默认集又声称被排除", () => {
    const both = DEFAULT_SOURCE_EXCLUSIONS.filter((e) =>
      (DEFAULT_SEARCH_SOURCES as string[]).includes(e.source),
    ).map((e) => e.source);
    expect(both).toEqual([]);
  });

  test("默认集里的每一项都必须是注册表里真实存在的连接器", () => {
    const known = new Set(registryLiteratureSources().map((s) => s.name));
    const unknown = DEFAULT_SEARCH_SOURCES.filter((s) => !known.has(s));
    expect(unknown).toEqual([]);
  });

  test("LITERATURE_SOURCES 手写副本与注册表不得漂移（副本一旦落后，默认集也会跟着落后）", () => {
    const registryNames = registryLiteratureSources().map((s) => s.name);
    const declared = new Set<string>(LITERATURE_SOURCES as readonly string[]);
    // 注册表里 available 的源必须在类型层面可被 --sources 选中；
    // placeholder（cnki / wanfang：无公开 API，调用必然失败）不要求进这份联合类型。
    const availableOnly = registryLiteratureSources()
      .filter((s) => !s.placeholder)
      .map((s) => s.name);
    expect(availableOnly.filter((n) => !declared.has(n))).toEqual([]);
    // 反向：联合类型里不能有注册表根本没有的幽灵源。
    expect((LITERATURE_SOURCES as readonly string[]).filter((n) => !registryNames.includes(n))).toEqual([]);
  });

  test("V34 的具体回归：arxiv 与 pubmed 必须在默认集里", () => {
    // 这条是「点名」断言，和上面的结构性断言互补：结构性断言解释了规则，
    // 这条锁住外部验收实测到的那两个源，读代码的人一眼看到复发点。
    expect(DEFAULT_SEARCH_SOURCES).toContain("arxiv" as LiteratureSource);
    expect(DEFAULT_SEARCH_SOURCES).toContain("pubmed" as LiteratureSource);
  });
});
