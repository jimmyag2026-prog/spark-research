import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliTaskRegistry } from "../../backend/src/cli/progress";
import {
  LIT_SUBCOMMAND_HELP,
  addNotFoundGuidance,
  classifyIdentifier,
  runLitCommand,
} from "../../backend/src/literature/cli";
import { DEFAULT_SEARCH_SOURCES, type LiteratureSource } from "../../backend/src/literature/models";
import type { LiteratureSearchResult } from "../../backend/src/literature/search";
import { FakeLlm, cardJson, makeProjectWithPapers } from "../helpers/review_scenario";

// v0.5 闸门 F 零上下文外部验收的三条可用性发现：
//   V35 长任务在 CLI 层完全不可见（头号卡点）
//   V36 失败消息不给下一步
//   V39 `lit review --help` 直接执行而不是显示帮助
//
// 所有 LLM 调用走 FakeLlm，所有检索走注入的假 searcher——本文件不打网络、不打模型。

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// 空的隔离根目录：帮助类用例绝不能回落到真实工作区的默认 ProjectManager。
function emptyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "spark-lit-help-"));
  roots.push(root);
  return root;
}

function fixture(n = 3, slug = "usability") {
  const fx = makeProjectWithPapers(n, slug);
  roots.push(fx.root);
  return fx;
}

// ── V35 ─────────────────────────────────────────────────────────────────────

describe("V35 · 长任务在 CLI 层可见", () => {
  test("lit read --all 打出任务句柄 + 逐篇进度 + 收尾行", async () => {
    const fx = fixture(3, "v35-read");
    const out: string[] = [];
    const code = await runLitCommand(["read", "--all"], {
      manager: fx.manager,
      llm: new FakeLlm([cardJson()]),
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const text = out.join("\n");

    // 1. 任务句柄：断开之后唯一能查回状态的东西
    expect(text).toMatch(/⏳ 任务 [0-9a-f]{8} 已启动/);
    expect(text).toContain("lit tasks");
    // 2. 逐篇进度：三篇 → 三条 [n/3]。这是「8 分钟零输出」的直接反面。
    expect(text).toContain("[1/3]");
    expect(text).toContain("[2/3]");
    expect(text).toContain("[3/3]");
    // 3. 每条进度带经过时间：卡住时最后一行的时间戳不动，是判「挂了还是在跑」的依据
    expect(text).toMatch(/\+\d+(\.\d+)?(ms|s)/);
    // 4. 收尾行
    expect(text).toMatch(/✅ 任务 [0-9a-f]{8} 完成/);
  });

  test("进度事件真的进了 TaskRegistry 的事件日志（不是只往 stdout 打了几行）", async () => {
    const fx = fixture(2, "v35-events");
    const registry = cliTaskRegistry();
    await runLitCommand(["read", "--all"], {
      manager: fx.manager,
      llm: new FakeLlm([cardJson()]),
      taskRegistry: registry,
      out: () => {},
      err: () => {},
    });
    const task = registry.list()[0]!;
    expect(task.kind).toBe("lit-read");
    expect(task.state).toBe("succeeded");
    // 起始的 progress(0,total) + 每篇一条 = 3 条 progress 事件
    const progressEvents = task.events.filter((e) => e.type === "progress");
    expect(progressEvents.length).toBe(3);
    expect(task.progress).toEqual({ done: 2, total: 2, message: expect.stringContaining("✅") });
    // 事件是只增日志：seq 从 0 起严格递增
    expect(task.events.map((e) => e.seq)).toEqual(task.events.map((_, i) => i));
  });

  test("失败的篇目同样发进度（一串失败不能看起来像卡住）", async () => {
    const fx = fixture(2, "v35-fail");
    const registry = cliTaskRegistry();
    const out: string[] = [];
    await runLitCommand(["read", "--all"], {
      manager: fx.manager,
      llm: new FakeLlm(["这不是 JSON"]),
      taskRegistry: registry,
      out: (l) => out.push(l),
      err: () => {},
    });
    const task = registry.list()[0]!;
    expect(task.events.filter((e) => e.type === "progress").length).toBe(3);
    expect(out.join("\n")).toContain("[2/2] ❌");
  });

  test("任务快照落盘到项目目录，新 registry（≈重启/重连）能查回来", async () => {
    const fx = fixture(2, "v35-persist");
    const out: string[] = [];
    await runLitCommand(["read", "--all"], {
      manager: fx.manager,
      llm: new FakeLlm([cardJson()]),
      out: (l) => out.push(l),
      err: () => {},
    });
    const tasksDir = join(fx.project.paths.root, "tasks");
    expect(existsSync(tasksDir)).toBe(true);
    expect(readdirSync(tasksDir).filter((n) => n.endsWith(".json")).length).toBe(1);

    // 全新 registry = 新进程：hydrate 之后仍看得到那条终态快照
    const revived = cliTaskRegistry(fx.project.paths.root);
    const task = revived.list()[0]!;
    expect(task.state).toBe("succeeded");
    expect(task.kind).toBe("lit-read");
  });

  test("lit tasks：列表 / 按 id 前缀展开 / 未知 id 给下一步", async () => {
    const fx = fixture(1, "v35-tasks");
    const out: string[] = [];
    const err: string[] = [];
    const deps = { manager: fx.manager, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    await runLitCommand(["read", "--all"], { ...deps, llm: new FakeLlm([cardJson()]) });
    const started = out.join("\n").match(/⏳ 任务 ([0-9a-f]{8})/)![1]!;

    out.length = 0;
    expect(await runLitCommand(["tasks"], deps)).toBe(0);
    expect(out.join("\n")).toContain(started);
    expect(out.join("\n")).toContain("succeeded");

    out.length = 0;
    expect(await runLitCommand(["tasks", started], deps)).toBe(0);
    const detail = out.join("\n");
    expect(detail).toContain("状态 succeeded");
    expect(detail).toContain("事件");

    out.length = 0;
    expect(await runLitCommand(["tasks", started, "--json"], deps)).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { id: string; state: string };
    expect(parsed.state).toBe("succeeded");
    expect(parsed.id.startsWith(started)).toBe(true);

    err.length = 0;
    expect(await runLitCommand(["tasks", "deadbeef"], deps)).toBe(1);
    // V36 的同一条纪律：找不到也要给下一步
    expect(err.join("\n")).toContain("下一步:");
    expect(err.join("\n")).toContain("lit tasks");
  });

  test("--json 模式不打进度行（stdout 必须仍是一段可解析 JSON）", async () => {
    const fx = fixture(2, "v35-json");
    const out: string[] = [];
    const code = await runLitCommand(["read", "--all", "--json"], {
      manager: fx.manager,
      llm: new FakeLlm([cardJson()]),
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("⏳");
    const parsed = JSON.parse(text) as { cards: unknown[]; failures: unknown[] };
    expect(parsed.cards.length).toBe(2);
  });

  test("单篇 lit read 不套任务（一步的活不值得两行噪音）", async () => {
    const fx = fixture(2, "v35-single");
    const out: string[] = [];
    await runLitCommand(["read", fx.paperIds[0]!.slice(0, 8)], {
      manager: fx.manager,
      llm: new FakeLlm([cardJson()]),
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(out.join("\n")).not.toContain("⏳ 任务");
  });

  test("lit review 是长任务：阶段进度进事件日志", async () => {
    const fx = fixture(2, "v35-review");
    const llm = new FakeLlm([cardJson()]);
    await runLitCommand(["read", "--all"], { manager: fx.manager, llm, out: () => {}, err: () => {} });

    const registry = cliTaskRegistry();
    const out: string[] = [];
    llm.queueNext(`# 综述\n\n蛋白结构预测方法进展 [@${fx.keys[0]}]。\n`);
    await runLitCommand(["review", "--no-judge"], {
      manager: fx.manager,
      llm,
      taskRegistry: registry,
      out: (l) => out.push(l),
      err: () => {},
    });
    const task = registry.list().find((t) => t.kind === "lit-review")!;
    expect(task.state).toBe("succeeded");
    const messages = task.events.filter((e) => e.type === "progress").map((e) => e.message ?? "");
    expect(messages.some((m) => m.includes("生成综述草稿"))).toBe(true);
    expect(messages.some((m) => m.includes("citation-integrity"))).toBe(true);
    expect(out.join("\n")).toMatch(/⏳ 任务 [0-9a-f]{8} 已启动/);
  });
});

// ── V36 ─────────────────────────────────────────────────────────────────────

function fakeSearcher(result: Partial<LiteratureSearchResult> = {}) {
  const empty: LiteratureSearchResult = {
    query: "",
    papers: [],
    sources: [],
    totalBeforeDedupe: 0,
    mergedCount: 0,
    ...result,
  };
  return { search: async () => empty, fetchById: async () => empty } as never;
}

describe("V36 · 失败消息给下一步", () => {
  test("标识符形态识别", () => {
    expect(classifyIdentifier("10.1038/s41586-021-03819-2")).toBe("doi");
    expect(classifyIdentifier("1706.03762")).toBe("arxiv");
    expect(classifyIdentifier("2101.00001v3")).toBe("arxiv");
    expect(classifyIdentifier("cs/0101001")).toBe("arxiv");
    expect(classifyIdentifier("W2741809807")).toBe("openalex");
    expect(classifyIdentifier("34265844")).toBe("pmid");
    expect(classifyIdentifier("alphafold protein folding")).toBe("unknown");
  });

  test("能解析该 id 的源不在本次检索集里 → 点名它，并给出可直接粘的命令", () => {
    // 这正是 V34 的复发面：arXiv id 配一组不含 arxiv 的源。
    const lines = addNotFoundGuidance("1706.03762", ["openalex", "crossref"], []);
    const text = lines.join("\n");
    expect(text).toContain("下一步:");
    expect(text).toContain("arXiv id");
    expect(text).toContain("spark-research lit add 1706.03762 --sources openalex,crossref,arxiv");
  });

  test("该查的源都查了 → 不甩锅给配置，直说多半是没被收录", () => {
    const text = addNotFoundGuidance("1706.03762", ["arxiv", "semanticscholar"], []).join("\n");
    expect(text).toContain("本次都查了");
    expect(text).not.toContain("--sources arxiv,semanticscholar,");
  });

  test("skipped 与 failed 分开说：缺凭据 ≠ 调用出错", () => {
    const text = addNotFoundGuidance(
      "10.1/x",
      ["openalex", "aminer", "crossref"],
      [
        { source: "aminer", outcome: "skipped", count: 0, note: "未配置凭据" },
        { source: "pubmed", outcome: "skipped", count: 0, note: "id '10.1/x' 不是该源可解析的标识符" },
        { source: "crossref", outcome: "failed", count: 0, error: "HTTP 503" },
        { source: "openalex", outcome: "ok", count: 0 },
      ],
    ).join("\n");
    expect(text).toContain("缺凭据被跳过的源: aminer");
    expect(text).toContain("lit sources");
    // 「缺凭据」与「不认这个 id 形态」是两种处理动作，不能合成一句话推回给用户
    expect(text).toContain("解析不了这个 id 形态、直接跳过的源: pubmed");
    expect(text).toContain("出错的源: crossref");
    expect(text).toContain("不是「没有这篇论文」");
  });

  test("不像任何标识符 → 指向 lit search，而不是让人继续猜 lit add", () => {
    const text = addNotFoundGuidance("alphafold folding", DEFAULT_SEARCH_SOURCES, []).join("\n");
    expect(text).toContain("用 lit search 而不是 lit add");
  });

  test("兜底那条永远在：不确定标识符就走检索入库", () => {
    for (const id of ["10.1/x", "1706.03762", "34265844", "什么东西"]) {
      const text = addNotFoundGuidance(id, DEFAULT_SEARCH_SOURCES, []).join("\n");
      expect(text).toContain('spark-research lit search "<标题或关键词>" --add');
    }
  });

  test("lit add 未找到时，指引真的打到 stderr（不只是函数会算）", async () => {
    const fx = fixture(1, "v36-add");
    const err: string[] = [];
    const code = await runLitCommand(["add", "1706.03762", "--sources", "openalex,crossref"], {
      manager: fx.manager,
      searcher: fakeSearcher({ sources: [{ source: "openalex", outcome: "ok", count: 0, elapsedMs: 1 }] }),
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("❌ 未能在");
    expect(text).toContain("下一步:");
    expect(text).toContain("--sources openalex,crossref,arxiv");
  });
});

// ── V39 ─────────────────────────────────────────────────────────────────────

describe("V39 · 子命令级 --help 显示帮助而不是执行", () => {
  test("lit review --help 只打帮助，不碰模型、不碰项目", async () => {
    const out: string[] = [];
    const llm = new FakeLlm([cardJson()]);
    // root 指向一个空的临时目录：里面没有任何项目，真执行必然报错退 1。
    // 只有「打完帮助就返回」这条路径才可能返回 0——也保证测试永远不会碰到真实工作区
    // （最初这条用例干脆不给 root，`lit export -h` 于是打到了真实数据目录里的文献库，
    //  正是 -h 没被当成帮助那个 bug 的现场）。
    const code = await runLitCommand(["review", "--help"], { root: emptyRoot(), llm, out: (l) => out.push(l), err: () => {} });
    expect(code).toBe(0);
    expect(llm.calls.length).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("用法: spark-research lit review");
    expect(text).toContain("--no-judge");
    expect(text).toContain("前置:");
  });

  test("每条子命令都有帮助，且帮助里的用法行与子命令名一致", async () => {
    const subs = ["search", "add", "list", "pdf", "read", "review", "export", "sources", "tasks"];
    for (const sub of subs) {
      const detail = LIT_SUBCOMMAND_HELP[sub];
      expect(detail).toBeTruthy();
      expect(detail!).toContain(`用法: spark-research lit ${sub}`);
      const out: string[] = [];
      expect(await runLitCommand([sub, "--help"], { root: emptyRoot(), out: (l) => out.push(l), err: () => {} })).toBe(0);
      expect(out.join("\n")).toBe(detail!);
    }
  });

  test("-h 与 --help 等价", async () => {
    const out: string[] = [];
    expect(await runLitCommand(["export", "-h"], { root: emptyRoot(), out: (l) => out.push(l), err: () => {} })).toBe(0);
    expect(out.join("\n")).toContain("用法: spark-research lit export");
  });

  test("总帮助里列了 tasks，且默认源随 DEFAULT_SEARCH_SOURCES 走（不是手写副本）", async () => {
    const out: string[] = [];
    expect(await runLitCommand(["help"], { root: emptyRoot(), out: (l) => out.push(l), err: () => {} })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("lit tasks");
    expect(text).toContain(DEFAULT_SEARCH_SOURCES.join("/"));
    for (const source of ["arxiv", "pubmed"] as LiteratureSource[]) {
      expect(LIT_SUBCOMMAND_HELP.search!).toContain(source);
    }
  });

  test("未知子命令 + --help 仍走原来的「未知子命令」路径，不假装有帮助", async () => {
    const err: string[] = [];
    expect(await runLitCommand(["bogus", "--help"], { root: emptyRoot(), out: () => {}, err: (l) => err.push(l) })).toBe(1);
    expect(err.join("\n")).toContain("未知的 lit 子命令");
  });
});
