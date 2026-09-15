import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, configuredSearchSources, settingSpec } from "../../backend/src/config";
import { DEFAULT_SEARCH_SOURCES } from "../../backend/src/literature/models";
import { LiteratureSearcher, configuredDefaultSources } from "../../backend/src/literature/search";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import type { HttpClient } from "../../backend/src/http/client";

// v0.9 lane γ · U6：`searchSources` 配置键。
//
// 此前「不给 --sources 时查哪些源」是 literature/models.ts 里一个写死的常量，
// 用户改不了——网页端想勾掉一个总在超时的源，只能每次检索都手打一遍 --sources。

const ORIGINAL_DATA_DIR = process.env.SPARK_RESEARCH_DATA_DIR;
const ORIGINAL_ENV = process.env.SPARK_RESEARCH_SEARCH_SOURCES;

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.SPARK_RESEARCH_DATA_DIR;
  else process.env.SPARK_RESEARCH_DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_ENV === undefined) delete process.env.SPARK_RESEARCH_SEARCH_SOURCES;
  else process.env.SPARK_RESEARCH_SEARCH_SOURCES = ORIGINAL_ENV;
});

/** 造一个只有 config.json 的临时工作区，并把进程的 dataDir 指过去。 */
function workspaceWith(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "spark-sources-"));
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  process.env.SPARK_RESEARCH_DATA_DIR = root;
  delete process.env.SPARK_RESEARCH_SEARCH_SOURCES;
  return root;
}

describe("searchSources · 默认值与常量同步", () => {
  // config 层不许 import literature/models.ts（零依赖纪律），所以默认值在两处各写了一份。
  // 这条断言就是那两份的胶水：常量改了 config 不改，这里立刻红。
  test("配置项的 defaultValue 逐个等于 DEFAULT_SEARCH_SOURCES", () => {
    const spec = settingSpec("searchSources");
    expect(spec).toBeDefined();
    expect(String(spec!.defaultValue).split(",")).toEqual(DEFAULT_SEARCH_SOURCES);
  });

  // 没配时走的是 SettingSpec 自己的 defaultValue（source="default"），所以这里拿到的
  // 就是内置默认集本身——不是 null。null 只留给「显式配成空」那一种。
  test("没配时读到的就是内置默认集", () => {
    workspaceWith({});
    expect(configuredSearchSources()).toEqual(DEFAULT_SEARCH_SOURCES);
    expect(configuredDefaultSources()).toEqual(DEFAULT_SEARCH_SOURCES);
  });

  // `resolveSetting()` 把空串归一成「未设」（既有口径，不是本 lane 引入的），
  // 所以配成 "" 与没配是同一件事：都退回内置默认集，而不是「一个源都不查」。
  // 这条钉住那个口径——`configuredSearchSources()` 的 null 分支只有在这项的
  // defaultValue 被改成 null 时才可达，留作防御（与 configuredDefaultModel 同款）。
  test("配成空字符串 = 没配，退回内置默认集而不是查零个源", () => {
    workspaceWith({ searchSources: "" });
    expect(configuredDefaultSources()).toEqual(DEFAULT_SEARCH_SOURCES);
  });
});

describe("searchSources · 读侧真的生效", () => {
  test("配了两个源之后，不给 sources 的检索只查这两个", async () => {
    workspaceWith({ searchSources: "openalex,arxiv" });
    expect(configuredDefaultSources()).toEqual(["openalex", "arxiv"]);

    // 每个源都打不通——但 `result.sources` 仍然如实列出**这次去查了谁**，
    // 那正是这条断言要看的东西（不需要真发请求，也不需要 fixture）。
    const http: HttpClient = {
      getJson: async () => {
        throw new Error("offline");
      },
      getText: async () => {
        throw new Error("offline");
      },
    } as unknown as HttpClient;
    const searcher = new LiteratureSearcher(new ConnectorRegistry({ http }).registerBuiltins());
    const result = await searcher.search("anything");
    expect(result.sources.map((s) => s.source).sort()).toEqual(["arxiv", "openalex"]);
  });

  test("配置里混进未知 id 时只丢掉那一个，不整体作废", () => {
    workspaceWith({ searchSources: "openalex,not-a-real-source,arxiv" });
    expect(configuredDefaultSources()).toEqual(["openalex", "arxiv"]);
  });

  test("配置里全是未知 id 时退回内置默认集（不会变成一次都不查）", () => {
    workspaceWith({ searchSources: "nope,also-nope" });
    expect(configuredDefaultSources()).toEqual(DEFAULT_SEARCH_SOURCES);
  });
});
