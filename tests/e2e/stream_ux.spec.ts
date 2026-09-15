import { expect, test, type Page } from "@playwright/test";

// v0.10 lane ε 的门禁：三段式进度（阶段条 / 实时日志 / 流式正文）+ 停止。
//
// **为什么是假 SSE 件而不是真管线**：本 lane 的基线（`integration/v0.10-base`）里后端
// 根本不发 `partial`，`delta` 也还没有 `target` / `revision`——那些是 lane β 的活
// （分支 `feat/W10-beta`，尚未合入）。所以这里把**网络那一层**换成假件：
// `window.fetch` 只对 `/api/session/stream` 这一个 URL 被接管，返回一条由测试逐条
// 推事件的真 `ReadableStream`。
//
// 被测的仍然是真东西：`lib/api.ts` 的 SSE 解析、`lib/stream_model.ts` 的推导、
// 以及 `center.tsx` 的渲染。**事件形状逐字段抄自 β 的类型**
// （`git show feat/W10-beta:backend/src/agents/progress.ts`），β 合进来之后这些事件
// 就是后端真发的那些。
//
// 一处如实交代：「检索完成 ≤ 10s 出现论文标题」这条 DONE，这里钉的是**前端从收到
// `partial.papers` 到标题上屏的时间**，不是后端检索真的要几秒（那取决于 lane α）。

/** 假 SSE：接管 `/api/session/stream` 这一个 URL，其余请求原样走真后端。 */
function installFakeStream(): void {
  const w = window as unknown as Record<string, unknown>;
  const state = {
    aborted: false,
    cancelled: false,
    /** 关流之后还试图推事件的次数——「停止后不再有新事件」那条门禁读它。 */
    blocked: 0,
    sent: 0,
    controller: null as ReadableStreamDefaultController<Uint8Array> | null,
  };
  w.__sparkFake = state;
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/api/session/stream")) return realFetch(input as RequestInfo, init);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        state.controller = controller;
      },
      cancel() {
        state.cancelled = true;
      },
    });
    const signal = init.signal;
    if (signal) {
      const onAbort = () => {
        state.aborted = true;
        try {
          state.controller?.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* 已经关了 */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
  }) as typeof window.fetch;

  w.__sparkPush = (event: string, data: unknown): boolean => {
    if (state.aborted || state.cancelled || !state.controller) {
      state.blocked += 1;
      return false;
    }
    try {
      state.controller.enqueue(
        new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
      state.sent += 1;
      return true;
    } catch {
      state.blocked += 1;
      return false;
    }
  };
}

async function push(page: Page, event: string, data: unknown): Promise<boolean> {
  return page.evaluate(
    ([e, d]) => (window as unknown as { __sparkPush: (e: string, d: unknown) => boolean }).__sparkPush(e as string, d),
    [event, data] as [string, unknown],
  );
}

async function fakeState(page: Page): Promise<{ aborted: boolean; blocked: number; sent: number }> {
  return page.evaluate(
    () => (window as unknown as { __sparkFake: { aborted: boolean; blocked: number; sent: number } }).__sparkFake,
  );
}

const PROJECT = "e2e-stream";
const T0 = 1_760_000_000_000;

/** β 的 `ProgressEvent`（`agents/progress.ts`）。字段一个不少。 */
function progress(over: {
  stage: "plan" | "execute" | "summarize" | "review";
  complete: number;
  total: number;
  message: string;
  offset: number;
  etaMs?: number;
}) {
  return {
    stage: over.stage,
    complete: over.complete,
    total: over.total,
    decision: "continue",
    message: over.message,
    ts: T0 + over.offset,
    elapsedMs: over.offset,
    ...(over.etaMs === undefined ? {} : { etaMs: over.etaMs }),
  };
}

async function openWorkbench(page: Page): Promise<void> {
  await page.addInitScript(installFakeStream);
  await page.goto("/");
  // 会话流要在一个项目里跑。建项目走真 API（不是本 lane 要测的东西，不值得点 UI）。
  await page.evaluate(async (slug) => {
    const list = (await (await fetch("/api/projects?all=1")).json()) as { projects: Array<{ slug: string }> };
    if (!list.projects.some((p) => p.slug === slug)) {
      await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, name: "流式门禁", description: "lane ε e2e" }),
      });
    }
    await fetch("/api/projects/current", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
  }, PROJECT);
  await page.reload();
  await expect(page.locator(".brand")).toHaveText("Spark Research");
}

// **不配 serial**：每条用例各自建/选项目、各自开一条假流，互不依赖。serial 会在第一条红之后把后面的全部 skip，
// 阴性对照时就看不出「破坏 A 到底钉红了哪几条」——那正是这些门禁存在的意义。
// （playwright.config.ts 里 workers=1，本来就不会并行跑。）

test("ε-1 ①：阶段条按事件推进，每段显示自己的耗时，没进过的段不补假 0", async ({ page }) => {
  await openWorkbench(page);
  await page.locator("#composer-input").fill("综述一下蛋白结构预测");
  await page.getByRole("button", { name: "发送" }).click();

  await push(page, "start", { sessionId: "web_test", mode: "chat" });
  await push(page, "progress", { ...progress({ stage: "plan", complete: 0, total: 0, message: "规划中：正在拆解任务", offset: 0 }) });
  await expect(page.getByTestId("stage-bar")).toBeVisible();
  await expect(page.getByTestId("stage-plan")).toHaveAttribute("data-state", "active");

  // plan 段跑了 1.5s 之后进检索段：plan 冻结在 1.5s，search 变 active。
  await push(page, "progress", { ...progress({ stage: "execute", complete: 0, total: 3, message: "执行中 1/3：检索 protein structure prediction", offset: 1500 }) });
  await expect(page.getByTestId("stage-plan")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("stage-plan-ms")).toHaveText("1.5s");
  await expect(page.getByTestId("stage-search")).toHaveAttribute("data-state", "active");

  await push(page, "progress", { ...progress({ stage: "execute", complete: 1, total: 3, message: "执行中 2/3：精读 3 篇", offset: 4200, etaMs: 8400 }) });
  await expect(page.getByTestId("stage-read")).toHaveAttribute("data-state", "active");
  // V158（ε-2）：执行段计数直接用 β 事件里的 complete/total，前端不重算。
  await expect(page.getByTestId("stream-counter")).toHaveText("执行 1/3");
  // eta 只在 β 给了 etaMs 时出现（拿不准就不给字段，前端也就不画）。
  await expect(page.getByTestId("stream-eta")).toHaveText("约剩 8.4s");
  await expect(page.getByTestId("stage-search-ms")).toHaveText("2.7s");

  // **没进过的段不显示 0ms**：这一轮压根没发过下载相关的事件。
  await expect(page.getByTestId("stage-download")).toHaveAttribute("data-state", "pending");
  await expect(page.getByTestId("stage-download-ms")).toHaveText("—");

  // 走过的段耗时**只冻结一次**：后面再来事件，plan 那一格不许再涨。
  await push(page, "progress", { ...progress({ stage: "summarize", complete: 3, total: 3, message: "汇总中：正在生成结果摘要", offset: 9000 }) });
  await expect(page.getByTestId("stage-summarize")).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("stage-plan-ms")).toHaveText("1.5s");
  await expect(page.getByTestId("stream-counter")).toHaveText("执行 3/3");
  // 这一条没有 etaMs → 界面上也不许凭空出现一个「约剩」。
  await expect(page.getByTestId("stream-eta")).toHaveCount(0);
});

test("ε-1 ②：partial.papers 到达 10s 内出现论文标题，且每条可点开到文献库", async ({ page }) => {
  await openWorkbench(page);
  await page.locator("#composer-input").fill("检索一下");
  await page.getByRole("button", { name: "发送" }).click();
  await push(page, "start", { sessionId: "web_test", mode: "chat" });

  // 失败源同样上屏：「查了但失败」与「根本没查」必须分得开。
  await push(page, "partial", {
    kind: "search_source",
    ts: T0 + 800,
    payload: { query: "protein", source: "arxiv", outcome: "failed", count: null, elapsedMs: 730, error: "HTTP 403" },
  });
  await push(page, "partial", {
    kind: "search_source",
    ts: T0 + 900,
    payload: { query: "protein", source: "openalex", outcome: "ok", count: 12, elapsedMs: 880 },
  });

  const startedAt = Date.now();
  await push(page, "partial", {
    kind: "papers",
    ts: T0 + 1000,
    payload: {
      query: "protein",
      found: 12,
      papers: [
        { id: "p-aaa", title: "Highly accurate protein structure prediction", year: 2021, doi: "10.1/x", sources: ["openalex"] },
        { id: "p-bbb", title: "Attention Is All You Need", year: 2017, doi: null, sources: ["openalex", "crossref"] },
      ],
    },
  });

  const title = page.getByTestId("stream-log-paper-p-aaa");
  await expect(title).toContainText("Highly accurate protein structure prediction", { timeout: 10_000 });
  expect(Date.now() - startedAt).toBeLessThan(10_000);

  // 失败源那一行照实写着 failed + 原因，不是消失。
  await expect(page.getByTestId("stream-log")).toContainText("源 arxiv：failed");
  await expect(page.getByTestId("stream-log")).toContainText("HTTP 403");

  // 点开 → 切到文献库视图。
  await title.click();
  await expect(page.getByRole("button", { name: "检索并入库" })).toBeVisible();
});

test("ε-1 ③：partial.card 的 relevance 为 null 时显示「—」，不显示成 0", async ({ page }) => {
  await openWorkbench(page);
  await page.locator("#composer-input").fill("精读");
  await page.getByRole("button", { name: "发送" }).click();
  await push(page, "start", { sessionId: "web_test", mode: "chat" });

  // β 明说：α 的批量预筛落地前 relevance 恒为 null。0 会被读成「判定为不相关」。
  await push(page, "partial", {
    kind: "card",
    ts: T0 + 3000,
    payload: {
      paperId: "p-aaa",
      title: "Highly accurate protein structure prediction",
      year: 2021,
      keyFinding: "端到端网络把 GDT_TS 推到 92.4",
      relevance: null,
      basis: "abstract",
    },
  });
  const line = page.locator('[data-testid="stream-log-line"][data-kind="card"]');
  await expect(line).toContainText("相关性 —");
  await expect(line).not.toContainText("相关性 0");
  await expect(line).toContainText("端到端网络把 GDT_TS 推到 92.4");
  await expect(page.getByTestId("stage-read")).toHaveAttribute("data-state", "active");
});

test("ε-1 ④：delta 按 target 分区逐字追加，revision 变化时清空重画", async ({ page }) => {
  await openWorkbench(page);
  await page.locator("#composer-input").fill("写综述");
  await page.getByRole("button", { name: "发送" }).click();
  await push(page, "start", { sessionId: "web_test", mode: "chat" });

  await push(page, "delta", { chunk: "# 综述\n\n第一版第一句。", target: "review", revision: 1 });
  const review = page.getByTestId("stream-section-review");
  await expect(review).toContainText("第一版第一句。");
  await push(page, "delta", { chunk: "第一版第二句。", target: "review", revision: 1 });
  await expect(review).toContainText("第一版第一句。第一版第二句。");

  // 另一个 target 各占一块，互不串行。
  await push(page, "delta", { chunk: "卡片正文", target: "card:p-aaa", revision: 1 });
  await expect(page.getByTestId("stream-section-card:p-aaa")).toContainText("卡片正文");
  await expect(review).toContainText("第一版第二句。");

  // revision +1 = 另一稿：**清空重画**，不许把两稿首尾相接。
  await push(page, "delta", { chunk: "# 综述\n\n第二版只有这一句。", target: "review", revision: 2 });
  await expect(review).toHaveAttribute("data-revision", "2");
  await expect(review).toContainText("第二版只有这一句。");
  await expect(review).not.toContainText("第一版第一句。");
});

test("ε-1 ⑤：「停止」关掉 SSE 连接本身——之后再推事件，界面一行都不动", async ({ page }) => {
  await openWorkbench(page);
  await page.locator("#composer-input").fill("跑一个长的");
  await page.getByRole("button", { name: "发送" }).click();
  await push(page, "start", { sessionId: "web_test", mode: "chat" });
  await push(page, "progress", { ...progress({ stage: "execute", complete: 1, total: 3, message: "执行中 2/3：检索中", offset: 1200 }) });
  await expect(page.getByTestId("stream-log-line")).toHaveCount(1);

  await page.getByTestId("stream-stop").click();
  await expect(page.getByTestId("stream-stopped")).toBeVisible();

  // ① 连接真的被 abort 了（不是只把界面静音）。
  const after = await fakeState(page);
  expect(after.aborted).toBe(true);

  // ② 继续推：被假件挡下（流已 error），日志行数不增。
  const accepted = await push(page, "progress", { ...progress({ stage: "summarize", complete: 3, total: 3, message: "汇总中：这条不该上屏", offset: 5000 }) });
  expect(accepted).toBe(false);
  await push(page, "delta", { chunk: "这段也不该上屏", target: "review", revision: 1 });
  await expect(page.getByTestId("stream-log-line")).toHaveCount(1);
  await expect(page.getByTestId("stream-log")).not.toContainText("这条不该上屏");
  await expect(page.getByTestId("stream-section-review")).toHaveCount(0);
  const end = await fakeState(page);
  expect(end.blocked).toBeGreaterThanOrEqual(2);
});
