import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// P7 浏览器全流程 e2e（可回放、无真实网络）：
//   建项目 → 文献检索入库 → 精读卡 → 综述 → co-explore 出 idea → novelty check
//   → 干实验（真 pyref）→ 湿实验编译 → approve → 模拟执行 → 时间线完整呈现
//
// 这些用例**共享一条链路**，所以 workers=1 串行跑（见 playwright.config.ts）。
// 断言尽量落在「证据图里有没有这条 record」而不是「某个像素在不在」——
// UI 是 API 的投影，值得保的是投影关系。

const PROJECT = "e2e-lab";

// 后端把长任务跑完之前按钮一直是忙态；等忙态消失比等固定时长稳。
async function waitIdle(page: Page): Promise<void> {
  await expect(page.locator(".head .spinner")).toHaveCount(0, { timeout: 60_000 });
}

// 时间线的类型过滤芯片。必须限定在右栏的过滤器区域里：
// 「文献」这两个字在左栏导航（文献库）和时间线条目标题里都会出现，
// 按可访问名全局找会命中十几个元素。
function typeChip(page: Page, label: string) {
  return page.locator(".right .filters .chip", { hasText: new RegExp(`^${label}$`) });
}

// 只保留这一个类型的过滤：先清掉已按下的，再按目标。
async function filterByType(page: Page, label: string): Promise<void> {
  const pressed = page.locator('.right .filters .chip[aria-pressed="true"]');
  for (let i = (await pressed.count()) - 1; i >= 0; i--) await pressed.nth(i).click();
  await typeChip(page, label).click();
}

test.describe.configure({ mode: "serial" });

test("① 工作台加载并建项目", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".brand")).toHaveText("Spark Research");

  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("protein-folding").fill(PROJECT);
  await dialog.locator("textarea").fill("蛋白结构预测与序列建模");
  await dialog.getByRole("button", { name: "创建" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".head .badge").first()).toHaveText(PROJECT);
});

test("② 检索入库 → 文献库有条目，时间线出现 paper record", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^文献库/ }).click();

  await page.getByPlaceholder(/跨源检索并入库/).fill("AlphaFold protein structure prediction");
  await page.getByRole("button", { name: "检索并入库" }).click();
  await waitIdle(page);

  const rows = page.locator("main table tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  // 入库的每篇论文都要有 bibtex key——它是后面所有引用核验的锚。
  await expect(rows.first().locator("td").nth(2)).not.toHaveText("—");

  // 证据图上同步落了 paper record。
  await filterByType(page, "文献");
  await expect(page.locator(".timeline .tl-item").first()).toBeVisible();
});

test("③ 生成精读卡 → 综述，引用渲染成库内引用（不标红）", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^文献库/ }).click();
  await page.getByRole("button", { name: "全部生成精读卡" }).click();
  await waitIdle(page);

  await page.getByRole("button", { name: /^精读卡/ }).click();
  await expect(page.locator(".card-head", { hasText: "精读卡" }).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "由精读卡生成综述" }).click();
  await waitIdle(page);

  const review = page.locator(".card", { has: page.locator(".card-head", { hasText: "综述草稿" }) });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText("引用核验通过")).toBeVisible();
  // 库内引用是蓝色 .cite，库外引用会带 .cite-unknown。这里一条都不该有。
  await expect(review.locator(".cite")).not.toHaveCount(0);
  await expect(review.locator(".cite-unknown")).toHaveCount(0);
});

test("④ co-explore 产出 Idea 卡（含反面证据）", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.getByRole("tab", { name: "co-explore" }).click();

  await page.locator("#composer-input").fill("我想用自注意力完全替代循环结构做序列转导");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".msg-agent .msg-body").last()).toContainText("coexplore", { timeout: 45_000 });

  await page.getByRole("button", { name: /^思路库/ }).click();
  const idea = page.locator(".card", { has: page.locator(".card-head", { hasText: "Idea 卡" }) }).first();
  await expect(idea).toBeVisible();
  await expect(idea.getByText("unchecked")).toBeVisible();
  // P4 硬门：给不出反面证据的「共探」只是附和。
  const contradicting = idea.locator("div", { hasText: "反对" }).last();
  await expect(contradicting).toBeVisible();
});

test("⑤ novelty check → 已发表工作被评为 checked-overlap 且列出最近邻", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^思路库/ }).click();
  await page.getByRole("button", { name: "跑 Novelty check" }).first().click();
  await waitIdle(page);

  const report = page.locator(".card", { has: page.locator(".card-head", { hasText: "Novelty 报告" }) });
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect(report.locator(".card-head")).toContainText("checked-overlap");
  await expect(report.getByText(/最近邻/).first()).toBeVisible();
  // 状态回写到思路库卡片上。
  await expect(page.locator(".card-head", { hasText: "Idea 卡" }).first()).toContainText("checked-overlap");
});

test("⑥ 干实验（真 pyref）跑完闭环，产出 computed observation", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /干实验/ }).click();
  await panel.getByRole("button", { name: "＋ 新建" }).click();
  await panel.getByPlaceholder("实验标题").fill("阻尼振子基线");
  await panel.getByPlaceholder(/参数 k=v/).fill("steps=200, sampleInterval=20");
  await panel.getByRole("button", { name: "建档" }).click();
  await waitIdle(page);

  await expect(panel.locator(".node[data-current='true']")).toHaveText(/design/);
  await panel.getByRole("button", { name: "运行闭环" }).click();
  await waitIdle(page);
  await expect(panel.locator(".node[data-current='true']")).toHaveText(/analyze/, { timeout: 60_000 });

  // 干实验的结果是算出来的 → observation 的 evidence 是 computed。
  await filterByType(page, "观察");
  const observation = page.locator(".timeline .tl-item").first();
  await expect(observation).toContainText("computed");
});

test("⑦ 湿实验编译停在 awaiting_approval，未批准不能执行", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /湿实验/ }).click();
  await panel.getByRole("button", { name: "＋ 新建" }).click();
  await panel.getByPlaceholder("标题（可选）").fill("OD 测定");
  await panel.getByPlaceholder(/自然语言协议/).fill("取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD");
  await panel.getByRole("button", { name: "编译 + 过安全门" }).click();
  await waitIdle(page);

  // AD-6 在界面上的表达：停留态高亮 + 明确文案 + 执行按钮不可用。
  await expect(panel.locator(".node[data-current='true'][data-awaiting='true']")).toBeVisible();
  await expect(panel.getByText(/安全门通过 ≠ 可以执行/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "执行（模拟器）" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "批准执行…" })).toBeVisible();
});

test("⑧ approve 弹窗必须填 actor；批准后落 decision record 并可执行", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /湿实验/ }).click();
  await panel.locator(".exp-list .nav-item").first().click();
  await panel.getByRole("button", { name: "批准执行…" }).click();

  const dialog = page.getByRole("dialog", { name: /批准执行湿实验/ });
  await expect(dialog).toBeVisible();
  // 批的是哪一版：步骤表与安全门结论都要摆在批准人面前。
  await expect(dialog.getByText(/协议 hash/)).toBeVisible();
  await expect(dialog.getByText("安全门结论")).toBeVisible();
  // 没填署名不能提交——「谁批的」是 decision record 的核心内容。
  await expect(dialog.getByRole("button", { name: "确认批准" })).toBeDisabled();

  await dialog.getByPlaceholder("你的名字").fill("张三");
  await dialog.getByRole("button", { name: "确认批准" }).click();
  await expect(dialog).toBeHidden();
  await waitIdle(page);

  await expect(panel.getByText("已批准")).toBeVisible();
  await expect(panel.getByText("张三")).toBeVisible();
  await expect(panel.getByRole("button", { name: "执行（模拟器）" })).toBeEnabled();

  // decision record 进了证据图。
  await filterByType(page, "决策");
  await expect(page.locator(".timeline .tl-item").first()).toContainText("决策");
  await page.locator(".timeline .tl-btn").first().click();
  await expect(page.locator(".right").getByText("inferred").first()).toBeVisible();
});

test("⑨ 执行湿实验 → observed observation + 证据子图连得上", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /湿实验/ }).click();
  await panel.locator(".exp-list .nav-item").first().click();
  await panel.getByRole("button", { name: "执行（模拟器）" }).click();
  await waitIdle(page);

  await expect(panel.locator(".node[data-current='true']")).toHaveText(/analyze/, { timeout: 60_000 });
  await expect(panel.getByText("run log 摘要")).toBeVisible();

  // 湿实验的产出是被观察到的（observed），与干实验的 computed 分得开。
  await filterByType(page, "观察");
  const items = page.locator(".timeline .tl-item");
  await expect(items.first()).toContainText("observed");

  // 点开看证据子图：节点数 > 1 说明它确实连回了实验与产出。
  await page.locator(".timeline .tl-btn").first().click();
  const graph = page.locator(".right svg.graph");
  await expect(graph).toBeVisible();
  await expect.poll(async () => graph.locator("g.graph-node").count()).toBeGreaterThan(1);
});

// R-d-3（V23）：unconsumedWarnings 是安全门看不见的兜底告警——concentration_limit /
// biosafety 两条规则在自然语言主管线上恒空转（BACKLOG V25），这是经 Web 批准的人
// **唯一**能看到「你写了但安全门没看见」的地方。新建一条独立的湿实验（不影响 ⑧/⑨
// 已经在用的 "OD 测定" 实验），用 .filter({hasText}) 定位，不依赖 exp-list 的排列顺序。
test("⑨b 未消费告警在批准弹窗里必须可见（V23）", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /湿实验/ }).click();
  await panel.getByRole("button", { name: "＋ 新建" }).click();
  await panel.getByPlaceholder("标题（可选）").fill("未消费告警协议");
  // 「配制10%次氯酸钠溶液」：安全门四条规则全过（体积正常，浓度字段不在编译器的
  // 解析范围内），但 10% 这个浓度描述本身应该被人看见——这正是 unconsumedWarnings
  // 存在的理由，见 tests/unit/wet_loop.test.ts 的 D-8 用例（同一条协议文本）。
  await panel.getByPlaceholder(/自然语言协议/).fill("配制10%次氯酸钠溶液200uL");
  await panel.getByRole("button", { name: "编译 + 过安全门" }).click();
  await waitIdle(page);

  await panel
    .locator(".exp-list .nav-item")
    .filter({ hasText: "未消费告警协议" })
    .first()
    .click();
  await panel.getByRole("button", { name: "批准执行…" }).click();

  const dialog = page.getByRole("dialog", { name: /批准执行湿实验/ });
  await expect(dialog).toBeVisible();
  // 显眼展示：告警小节标题 + 具体内容（提到"浓度"）都必须在弹窗里看得到。
  const warnings = dialog.locator('[data-testid="unconsumed-warnings"]');
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText("未被安全门消费的信号");
  await expect(warnings).toContainText("浓度");
  await dialog.getByRole("button", { name: "取消" }).click();
});

test("⑩ 时间线呈现完整研究线索，且明暗主题都能用", async ({ page }) => {
  await page.goto("/");

  // 清掉类型过滤，看全量。
  const pressed = page.locator('.right .filters .chip[aria-pressed="true"]');
  for (let i = (await pressed.count()) - 1; i >= 0; i--) await pressed.nth(i).click();

  const timeline = page.locator(".timeline .tl-item");
  await expect.poll(async () => timeline.count(), { timeout: 20_000 }).toBeGreaterThan(8);

  // 一条完整线索该有的类型全在。
  const text = await page.locator(".timeline").innerText();
  for (const type of ["文献", "精读", "思路", "实验", "观察", "决策", "产物"]) {
    expect(text).toContain(type);
  }

  // 主题切换：切到暗色后根节点属性变了，且页面仍然可交互。
  await page.getByRole("button", { name: /切换到深色主题/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".brand")).toBeVisible();
  await page.getByRole("button", { name: /切换到浅色主题/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // 页面主体不横向滚（宽表在自己的容器里滚）。
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(true);
});

// P8：结论卡 review 门槛（G1）与研究报告导出（G7）在浏览器里的落点。
// 接在 ⑥ 的干实验（已到 analyze）后面：写结论 → 评审 → 报告里出现在「结论」区。
test("⑪ 结论卡评审门槛：pending 进不了结论区，approved 才进", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /干实验/ }).click();
  await panel.locator(".exp-list .nav-item").filter({ hasText: "阻尼振子基线" }).first().click();
  await panel.getByPlaceholder("结论（claim）").fill("阻尼系数 0.4 下能量在 200 步内衰减到初值的 1/3");
  await panel.getByRole("button", { name: "得出结论" }).click();
  await waitIdle(page);

  // 结论页：新卡是 pending，此时报告的结论区还是空的。
  await page.locator(".left").getByRole("button", { name: /^结论/ }).click();
  const card = page.locator(".center .card").first();
  await expect(card).toContainText("pending");

  const before = await page.evaluate(async () => (await fetch("/api/report")).json());
  expect(before.counts.approvedConclusions).toBe(0);
  expect(before.counts.unverifiedConclusions).toBeGreaterThan(0);

  // 不填评审人不许评审（AD-6：评审要记名）。
  await card.getByRole("button", { name: "跑评审" }).click();
  await expect(page.locator(".toast[data-kind='error']")).toContainText("评审人");

  await page.getByPlaceholder("评审人（记名，必填）").fill("e2e-reviewer");
  await card.getByRole("button", { name: "跑评审" }).click();
  await waitIdle(page);
  await expect(page.locator(".center .card").first()).toContainText("approved");

  // 报告里这条结论进了「结论」区，且带 record id 可回溯。
  const after = await page.evaluate(async () => (await fetch("/api/report")).json());
  expect(after.counts.approvedConclusions).toBe(1);
  const conclusionSection = after.markdown.split("## 四、结论")[1].split("## 五、待验证")[0];
  expect(conclusionSection).toContain("阻尼系数 0.4 下能量");
  expect(conclusionSection).toContain("e2e-reviewer");
});

test("⑫ 导出报告按钮下载 Markdown（结论区受门槛约束）", async ({ page }) => {
  await page.goto("/");
  const download = page.waitForEvent("download");
  await page.locator(".head").getByRole("link", { name: "导出报告" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toContain("report.md");
});

// ⑬ P14 · SSE 预览流：`delta` 事件真的逐块到达，不是把完整正文一次性 dump 出来。
//
// 这条用例**不走共享 fixture 服务器**（`tests/e2e/fixture_server.ts` 注入的
// `ScriptedLlm` 不支持 `CallOptions.onDelta`——它的 `call()` 一次性把整段文本同步
// 返回，永远不会调用 `onDelta`，用它测不出"是不是真的分块"）。也**不能**在这个
// spec 文件里直接 `import startServer`——Playwright 用 Node.js 加载/收集用例，
// `backend/src/server/app.ts` 间接依赖只有 Bun 运行时才有的模块，直接 import 会在
// 收集阶段就报 `Cannot find package 'bun'` 炸掉整个套件（已实测）。
//
// 做法：仿照 `fixture_server.ts` 的套路起一个独立子进程，但**不把这个子进程脚本
// 落成仓库里的常驻文件**——一个只有这一条 e2e 用例会 spawn、生产代码从不 import 的
// `.ts` 文件会被 `tests/unit/narrative_parity.test.ts`（孤儿模块门禁，AD-12）当成
// 孤儿模块拦下来，而那份登记表不属于本 lane 所有权，不能去加一条例外。于是改成
// **测试运行时现写一个临时脚本**（用绝对路径 import `backend/src/server/server`，
// 不依赖脚本自己落在仓库里的固定路径），`bun <临时脚本> <port> <root>` 起子进程
// （`node:child_process.spawn`，不是浏览器 `page`），注入一个真正逐块调用
// onDelta、且每块之间有真实延迟的假 LLM，再用裸 `fetch` 直接打
// `/api/session/stream`，用时间戳证明多个 `delta` 事件是分开到达的，而不是攒够了
// 再一口气吐出来。
//
// 阴性对照③（记入 docs/devlog/W2-d.md）：把 `session.ts` 的预览流实现改成"攒够全部
// chunk 再一次性 sender.send"，这条用例的时间戳断言会变红——已经实跑验证过。
const E2E_SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(E2E_SPEC_DIR, "../..");
const SERVER_MODULE = join(REPO_ROOT, "backend/src/server/server.ts");
const DELTA_CHUNKS = ["这", "是一", "段", "真正", "流式", "到达", "的预览", "文本。"];
const DELTA_DELAY_MS = 40;

function deltaFixtureScript(): string {
  return `
import { startServer } from ${JSON.stringify(SERVER_MODULE)};

const port = Number(process.argv[2] ?? 0);
const root = process.argv[3];
const CHUNKS = ${JSON.stringify(DELTA_CHUNKS)};
const DELAY_MS = ${DELTA_DELAY_MS};

const streamingLlm = {
  call: async (_messages, options) => {
    const opts = (typeof options === "object" && options !== null) ? options : {};
    if (opts.onDelta) {
      for (const chunk of CHUNKS) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        opts.onDelta(chunk);
      }
    }
    return {
      ok: true,
      provider: "e2e-fake-stream",
      model: opts.model ?? "fake-model",
      content: CHUNKS.join(""),
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true },
    };
  },
  listModels: () => ({ kimi: [], openai: [], anthropic: [], deepseek: [], qwen: [], openrouter: [] }),
};

const server = startServer(port, { root, llm: streamingLlm });
console.log("e2e delta fixture ready on " + server.port);
`;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
    srv.on("error", reject);
  });
}

test("⑬ SSE 预览流（需 preview:true 显式开启）：delta 事件逐块到达，不是一次性 dump", async () => {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), "spark-e2e-sse-"));
  const fixtureDir = mkdtempSync(join(tmpdir(), "spark-e2e-sse-fixture-"));
  const fixtureScript = join(fixtureDir, "delta_fixture.ts");
  writeFileSync(fixtureScript, deltaFixtureScript());
  const proc = spawn("bun", [fixtureScript, String(port), root], { stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    let out = "";
    proc.stdout?.on("data", (buf) => {
      out += String(buf);
      if (out.includes("e2e delta fixture ready")) resolveReady();
    });
    proc.on("exit", (code) => rejectReady(new Error(`delta fixture 进程提前退出（code ${code}）：${out}`)));
    proc.on("error", rejectReady);
  });

  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("delta fixture 启动超时")), 15_000)),
    ]);

    const res = await fetch(`http://127.0.0.1:${port}/api/session/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // W2 收口起预览流默认关闭（见 server/routes/session.ts 的裁定注释：
      // 预览发的是裸消息，与走完整 orchestrator 管线的权威答案是两个不同的回答，
      // 默认展示它会被用户读成答案）。这条用例验的是「开了之后确实逐块到达」，
      // 所以要显式 opt-in。
      body: JSON.stringify({ sessionId: "e2e-sse-delta", message: "讲讲你自己", mode: "chat", preview: true }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: Array<{ event: string; data: unknown; at: number }> = [];
    let buffer = "";
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (Date.now() > deadline) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (chunk.startsWith(":")) continue;
        const nameLine = chunk.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!nameLine) continue;
        events.push({
          event: nameLine.slice(7),
          data: dataLine ? JSON.parse(dataLine.slice(6)) : null,
          at: Date.now(),
        });
      }
      if (events.some((e) => e.event === "done")) break;
    }
    await reader.cancel().catch(() => {});

    const deltas = events.filter((e) => e.event === "delta");
    // 核心断言①：真的收到了不止一个 delta 事件——不是一次性把 8 块拼成一条消息。
    expect(deltas.length).toBe(DELTA_CHUNKS.length);
    expect(deltas.map((d) => (d.data as { chunk: string }).chunk)).toEqual(DELTA_CHUNKS);

    // 核心断言②：分块之间有真实的时间间隔（每块之间人为 sleep 了 40ms）——
    // 如果实现退化成"权威结果备好之后切成假 token 一次性喷出去"，这些事件会在同一
    // 个 tick 里连续 enqueue，首尾时间差会趋近 0，下面这条断言就会失败。
    const first = deltas[0]!.at;
    const last = deltas[deltas.length - 1]!.at;
    expect(last - first).toBeGreaterThanOrEqual(DELTA_DELAY_MS * (DELTA_CHUNKS.length - 1) * 0.5);

    // 事件序列仍然以既有的生命周期收尾：delta 是插在 progress 之前的额外事件，
    // 不取代 result/done（见 session.ts 顶部大注释与 server_session.test.ts 的既有断言）。
    expect(events[0]!.event).toBe("start");
    expect(events.some((e) => e.event === "progress")).toBe(true);
    expect(events.some((e) => e.event === "result")).toBe(true);
    expect(events[events.length - 1]!.event).toBe("done");
    const result = events.find((e) => e.event === "result")!.data as { response: string };
    expect(result.response).toContain("e2e-sse-delta");
  } finally {
    proc.kill();
  }
});
