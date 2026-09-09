import { expect, test, type Page } from "@playwright/test";

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
