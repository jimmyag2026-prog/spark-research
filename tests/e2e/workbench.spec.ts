import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// V95：approve/simulate 不再是 HTTP 审批旁路——两个端点现在都要求一次性审批令牌。
// `issue()` 是纯函数（只依赖 node:fs/crypto/path，见文件顶部大段注释），可以在这个
// Playwright 测试进程（Node，不是 Bun）里直接 import 调用，不需要像 server/* 那样
// 顾虑 Bun-only 依赖链（本文件下方 ⑬ 的大段注释记录过那个坑：直接 import
// `backend/src/server/*` 在收集阶段就会报 `Cannot find package 'bun'`）。
import { issue as issueApprovalToken } from "../../backend/src/lab/approval_token";

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

// V95：approve/simulate 弹窗现在要求一次性审批令牌，真实用户会在终端跑
// `spark-research lab token <id>` 拿到它。浏览器里没有终端，这里用等价的方式
// 拿到同一份东西——`GET /api/projects/current` 本来就会把 `paths.root` 吐出来
// （`server/routes/projects.ts` 的既有能力，不是本 lane 新开的口子），用它定位到
// 当前项目在磁盘上的目录，再直接调用 `issue()`（与 CLI `lab token` 内部调用的
// 是同一个函数）铸一枚真正合法、绑定到这个 experimentId 的令牌。**没有绕过任何
// 门**——CLI 的 TTY 门本身在 tests/unit/lab_cli.test.ts / w8_epsilon_cli_token.test.ts
// 已经单独打过；这里只是把「人在终端敲完命令、把令牌粘贴进浏览器」这个手工步骤
// 换成程序做同一件事，为的是让 e2e 能确定性地跑，而不是引入新的旁路。
async function mintApprovalToken(page: Page, experimentId: string): Promise<string> {
  const projectSummary = await page.evaluate(async () => {
    const res = await fetch("/api/projects/current");
    return (await res.json()) as { project: { paths: { root: string } } };
  });
  return issueApprovalToken(projectSummary.project.paths.root, experimentId).token;
}

// 找到「实验面板」当前唯一一条处于 awaiting_approval 的湿实验 id——与 CLI/HTTP
// 单测里 `compile()` 助手拿 id 的方式同源（都是读同一个 API），不额外造一套。
async function awaitingApprovalExperimentId(page: Page, titleContains: string): Promise<string> {
  const list = await page.evaluate(async () => {
    const res = await fetch("/api/lab/experiments?state=awaiting_approval");
    return (await res.json()) as { experiments: Array<{ id: string; title: string }> };
  });
  const match = list.experiments.find((e) => e.title.includes(titleContains));
  if (!match) throw new Error(`没找到标题含「${titleContains}」且处于 awaiting_approval 的湿实验`);
  return match.id;
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

test("⑧ approve 弹窗必须填 actor + 一次性令牌；批准后落 decision record 并可执行", async ({ page }) => {
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
  // V95：填了署名但还没填一次性令牌——提交按钮依旧必须是禁用的（前端也守这道门，
  // 不只是等 HTTP 层 403 才发现）。
  await expect(dialog.getByRole("button", { name: "确认批准" })).toBeDisabled();
  await expect(dialog.getByText(/一次性审批令牌/)).toBeVisible();

  // 真实用户此刻会去终端跑 `spark-research lab token <id>`；这里用同一个函数
  // （见文件顶部 mintApprovalToken）铸一枚等价的令牌，贴进输入框。
  const experimentId = await awaitingApprovalExperimentId(page, "OD 测定");
  const token = await mintApprovalToken(page, experimentId);
  await dialog.locator("input.mono").fill(token);
  await expect(dialog.getByRole("button", { name: "确认批准" })).toBeEnabled();
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

test("⑧b approve 用掉的令牌不能拿来执行：同一枚令牌重复使用 → 403，消息原样显示（V95）", async ({ page }) => {
  // 独立起一条新的湿实验，避免和 ⑧/⑨ 共用的那条状态互相干扰——这条测的是
  // 「同一枚令牌只能兑现一次，approve 用掉之后不能拿去 simulate」，需要一条
  // 全新的、还没被 approve 过的实验。
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /湿实验/ }).click();
  await panel.getByRole("button", { name: "＋ 新建" }).click();
  await panel.getByPlaceholder("标题（可选）").fill("令牌单次消费协议");
  await panel.getByPlaceholder(/自然语言协议/).fill("取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD");
  await panel.getByRole("button", { name: "编译 + 过安全门" }).click();
  await waitIdle(page);
  await panel.locator(".exp-list .nav-item").filter({ hasText: "令牌单次消费协议" }).first().click();

  const experimentId = await awaitingApprovalExperimentId(page, "令牌单次消费协议");
  const token = await mintApprovalToken(page, experimentId);

  await panel.getByRole("button", { name: "批准执行…" }).click();
  const approveDialog = page.getByRole("dialog", { name: /批准执行湿实验/ });
  await approveDialog.getByPlaceholder("你的名字").fill("张三");
  await approveDialog.locator("input.mono").fill(token);
  await approveDialog.getByRole("button", { name: "确认批准" }).click();
  await expect(approveDialog).toBeHidden();
  await waitIdle(page);
  await expect(panel.getByRole("button", { name: "执行（模拟器）" })).toBeEnabled();

  // 同一枚（已经被 approve 消费过的）令牌拿去「执行」——必须 403，且弹窗里显示的
  // 就是后端原样返回的那句错误消息（不是前端自己编的通用文案）。
  await panel.getByRole("button", { name: "执行（模拟器）" }).click();
  const executeDialog = page.getByRole("dialog", { name: /执行湿实验/ });
  await executeDialog.getByPlaceholder("你的名字").fill("张三");
  await executeDialog.locator("input.mono").fill(token);
  await executeDialog.getByRole("button", { name: "确认执行" }).click();

  const toast = page.locator(".toast[data-kind='error']");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("已被使用过");
  await expect(toast).toContainText("spark-research lab token");
  // 状态没有被这次被拒的调用推进——实验依旧停在 approved，没有变成 executing/collect。
  await expect(panel.locator(".node[data-current='true']")).toHaveText(/approved/);
});

test("⑨ 执行湿实验 → observed observation + 证据子图连得上", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /湿实验/ }).click();
  await panel.locator(".exp-list .nav-item").filter({ hasText: "OD 测定" }).first().click();

  // V95：「执行」现在也走弹窗，要求 actor + 一枚未被消费过的一次性令牌
  // （⑧b 已经用掉了「OD 测定」approve 时铸的那枚——这里必须重新铸一枚）。
  const odExperimentId = await page.evaluate(async () => {
    const res = await fetch("/api/lab/experiments?state=approved");
    const body = (await res.json()) as { experiments: Array<{ id: string; title: string }> };
    return body.experiments.find((e) => e.title.includes("OD 测定"))!.id;
  });
  const executeToken = await mintApprovalToken(page, odExperimentId);

  await panel.getByRole("button", { name: "执行（模拟器）" }).click();
  const executeDialog = page.getByRole("dialog", { name: /执行湿实验/ });
  await executeDialog.getByPlaceholder("你的名字").fill("张三");
  await executeDialog.locator("input.mono").fill(executeToken);
  await executeDialog.getByRole("button", { name: "确认执行" }).click();
  await expect(executeDialog).toBeHidden();
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
  // V25（W5-1 δ）：「配制10%次氯酸钠溶液」这种「浓度 + 同句唯一试剂」的写法**现在会被
  // 编译器消费**（挂到 ReagentSpec.concentration），不再产生未消费告警——这条 e2e 原先
  // 用它当"永远看不见"的例子，V25 之后那个前提不成立了。
  //
  // 换成同句出现两种试剂的归属歧义场景：10% 到底是谁的浓度无法从句法上确定，编译器
  // **拒绝瞎猜**（安全门上唯一正确的取向），所以仍然落 unconsumedWarnings。
  // 与 tests/unit/wet_loop.test.ts 的 D-8 用例保持同一条协议文本。
  await panel.getByPlaceholder(/自然语言协议/).fill("配制10%次氯酸钠和乙醇的混合液200uL");
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

// V60（BACKLOG）：词表外试剂的用户原文必须真正进到编译产物、并在批准弹窗里被人看见——
// v0.5 只止住了「两种未知试剂塌缩到同一 reservoir 孔」，用户写的「硝酸」两个字
// 本身没有保留下来，人在 lab approve 时看不到自己批的是什么（AD-6 署名审批失去对象）。
// 与 ⑨b 同一条纪律：新建独立湿实验，不影响 ⑧/⑨ 共用的 "OD 测定" 实验。
test("⑨c 词表外试剂的原文与「词表外」提示必须在批准弹窗里可见（V60）", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator(".bottom");
  await panel.getByRole("tab", { name: /湿实验/ }).click();
  await panel.getByRole("button", { name: "＋ 新建" }).click();
  await panel.getByPlaceholder("标题（可选）").fill("词表外试剂协议");
  // 「硝酸」不在 REAGENT_PATTERNS 词表内（词表只有强酸/次氯酸盐/氢氧化物/乙醇/过氧化氢
  // 五类常见项），100uL 在移液器量程与孔板容量内，能顺利过安全门停在 awaiting_approval。
  await panel.getByPlaceholder(/自然语言协议/).fill("加入100uL硝酸");
  await panel.getByRole("button", { name: "编译 + 过安全门" }).click();
  await waitIdle(page);

  await panel
    .locator(".exp-list .nav-item")
    .filter({ hasText: "词表外试剂协议" })
    .first()
    .click();
  await panel.getByRole("button", { name: "批准执行…" }).click();

  const dialog = page.getByRole("dialog", { name: /批准执行湿实验/ });
  await expect(dialog).toBeVisible();
  // 原文与「词表外」提示都必须在批的人眼前——不是只进了 JSON、CLI 才看得到。
  await expect(dialog.getByText("词表外，安全规则未覆盖")).toBeVisible();
  await expect(dialog.getByText(/原文：硝酸/)).toBeVisible();
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

test("⑬ SSE 权威流：delta 事件逐块到达（是答案本身的增量，不是一次性 dump）", async () => {
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
      // W3 收口起 delta 就是**权威答案本身**的流式增量（orchestrator 的 onDelta 接到
      // summarize()），不再需要 preview 开关——那次「另发一次裸模型调用」的绕道已删除。
      body: JSON.stringify({ sessionId: "e2e-sse-delta", message: "讲讲你自己", mode: "chat" }),
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

test("⑭ C5-② depict → 产物列表出现 .svg → img.naturalWidth > 0", async ({ page }) => {
  await page.goto("/");

  // 种子数据直接打 HTTP（/api/chem/depict 是 chem.ts 自己的路由 + app.ts 一行接线），
  // 不经过 CLI/`backend/src/index.ts` 的 `case "chem"`——那一行按 §三·补.3 归了 lane η，
  // 由收口接（见 docs/devlog/W5-1-c.md「收口接线清单」）。这条用例只验 HTTP → artifact
  // → 前端渲染这条链路，所以能在收口前就真的跑绿；CLI 入口本身的验证在
  // tests/unit/chem_cli.test.ts。
  const seeded = await page.evaluate(async () => {
    const res = await fetch("/api/chem/depict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ smiles: "CCO", name: "e2e-ethanol" }),
    });
    return { status: res.status, body: await res.json() };
  });
  expect(seeded.status).toBe(200);

  // 产物列表用 Solid createResource(slug, ...) 拉取，不会因为别的入口写了新数据自动重拉；
  // reload 触发一次新的 mount 取到最新列表（与真实用户刷新页面看到新产物是同一路径）。
  await page.reload();
  await page.locator(".left").getByRole("button", { name: /^产物/ }).click();
  await page.locator(".center .nav-item").filter({ hasText: "e2e-ethanol.svg" }).first().click();

  const img = page.locator(".center article.card img");
  await expect(img).toBeVisible();
  const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);
});

// ── W6-1 β：工作台四面板（CLI 已有、UI 补齐） ────────────────────────────────
//
// 这四条接在既有链路后面，复用同一个 "e2e-lab" 项目与同一个 fixture 服务器——
// 面板②③需要的「record 有入边出边」「有一个算力 job」这类前提，靠上面 ①-⑭ 已经
// 走过的真实业务动作（湿实验 approve、干实验 conclude）与本文件内直接 seed 的最小
// HTTP 调用满足，不重新搭一个项目。

test("⑮ 长任务面板：起一个检索任务能看到进度，刷新整个页面后任务仍在（面板①）", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^文献库/ }).click();

  // 复用 fixture 支持的检索式（DualCassetteSearcher 只认这一条），再检索一次是
  // 幂等的（add:true 只会合并，不会重复入库两份）——这里只是要一个真实的长任务。
  await page.getByPlaceholder(/跨源检索并入库/).fill("AlphaFold protein structure prediction");
  await page.getByRole("button", { name: "检索并入库" }).click();

  await page.getByRole("button", { name: "任务", exact: true }).click();
  const taskRow = page.locator('[data-testid="task-row"]').first();
  await expect(taskRow).toBeVisible({ timeout: 30_000 });
  await expect(taskRow).toContainText("文献检索");
  // 进度信息：done/total 或阶段文案至少要有一个渲染出来——不是空徽章。
  await expect(taskRow.locator(".card-body")).not.toBeEmpty();
  await waitIdle(page);
  await expect(taskRow).toContainText(/succeeded|running/);
  const taskId = (await taskRow.locator(".mono.faint").first().innerText()).trim();
  expect(taskId).toHaveLength(8);

  // 刷新**整个浏览器页面**（不是 SPA 内部导航）：数据要还在，因为它来自后端落盘
  // 的任务快照（server/tasks.ts），不是这次 session 里攒出来的前端状态。
  await page.reload();
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await expect(page.locator('[data-testid="task-row"]', { hasText: taskId })).toBeVisible({ timeout: 15_000 });
});

test("⑯ record 详情：点开一条 record 能同时看到入边与出边（面板②）", async ({ page }) => {
  await page.goto("/");
  // 干实验的 computed 观察（来自 ⑥）在 ⑪ 里被一条结论 record 反向引用
  // （conclusion --derives_from--> observation），同时它自己也 derives_from 那条
  // 干实验——是这条链路里唯一同时有入边又有出边的 record，专门用来验证面板②
  // 「入边出边都要看得到」，不是只有一边。
  await filterByType(page, "观察");
  const computedObservation = page.locator(".timeline .tl-item", { hasText: "computed" }).first();
  await expect(computedObservation).toBeVisible();
  await computedObservation.locator(".tl-btn").click();

  await expect(page.locator(".right svg.graph")).toBeVisible();
  const edgeButtons = page.locator(".right .col > button.nav-item");
  await expect.poll(async () => edgeButtons.count()).toBeGreaterThan(1);
  const labels = await edgeButtons.allInnerTexts();
  expect(labels.some((t) => t.includes("→"))).toBe(true);
  expect(labels.some((t) => t.includes("←"))).toBe(true);
});

test("⑰ 算力面板：只读展示 job，断言没有任何派发/审批按钮（面板③，V47 裁定）", async ({ page }) => {
  await page.goto("/");

  // compute plan 是零副作用的"建计划"——不建远端资源、不解析凭据，正好用来种一条
  // 可展示的 job，不必真的跑一次算力。
  const seeded = await page.evaluate(async () => {
    const res = await fetch("/api/compute/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "e2e-算力面板只读断言", command: ["echo", "hi"] }),
    });
    return { status: res.status, body: await res.json() };
  });
  expect(seeded.status).toBe(201);

  await page.reload();
  await page.getByRole("button", { name: "算力", exact: true }).click();

  const note = page.locator('[data-testid="compute-cli-only-note"]');
  await expect(note).toBeVisible();
  await expect(note).toContainText("派发与审批仅 CLI");

  const jobRow = page.locator(".center .nav-item").filter({ hasText: "e2e-算力面板只读断言" });
  await expect(jobRow).toBeVisible();
  await jobRow.click();
  await expect(page.locator(".center article.card")).toBeVisible();

  // 硬断言：整个算力面板（空态 + 列表 + 详情）里不存在任何派发/批准/拒绝类按钮——
  // 不是"暂时没做"，是 HTTP 面刻意没开这个口子（server/routes/compute.ts 顶部注释）。
  const forbidden = /派发|批准|拒绝|approve|reject|dispatch|^运行$|^执行$/i;
  const buttons = page.locator(".center button");
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const text = (await buttons.nth(i).innerText()).trim();
    expect(text).not.toMatch(forbidden);
  }
});

test("⑱ 用量面板：往 usage.jsonl 写一行后刷新，面板数字随之变化（面板④）", async ({ page }) => {
  // v0.7 基线闸（V81）：alpha.7 起 HTTP 的 read/review/co-explore/novelty 路由经 llmFor
  // 计量——前面 ③④⑤ 已经往本项目的 usage.jsonl 写过行。原先「面板必为空态」的假设
  // 只在单跑时成立，全套按序跑必红。改成**增量断言**：只断言「追加两行后，后端数字
  // 与面板同步变化」，空态只在确实没有记录时核（保留「不白屏」这层意图）。
  await page.goto("/");
  const before = await page.evaluate(
    async () =>
      (await (await fetch("/api/usage")).json()) as {
        calls: number;
        knownCostUsd: number;
        unknownCostCalls: number;
      },
  );
  await page.getByRole("button", { name: "用量", exact: true }).click();
  if (before.calls === 0) {
    await expect(page.locator('[data-testid="llm-usage-card"]')).toHaveCount(0);
    await expect(page.getByText("还没有 LLM 用量记录")).toBeVisible();
  } else {
    await expect(page.locator('[data-testid="llm-usage-card"]')).toBeVisible();
  }

  const projectInfo = await page.evaluate(async () => {
    const res = await fetch("/api/projects/current");
    return (await res.json()) as { project: { paths: { root: string } } };
  });
  const usageFile = join(projectInfo.project.paths.root, "usage.jsonl");

  // 不必真花钱：直接往台账文件追加两行——验的是"面板如实反映后端已经算好的数字"，
  // 不是"这次调用真的花了钱"。其中一行 costUsd=null，专门验证 unknownCostCalls
  // 的示警文案会出现（口径照抄 CLI：「总花费无法确定报出」，不能被当成 0）。
  appendFileSync(
    usageFile,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      command: "lit-read",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      ok: true,
      inputTokens: 800,
      outputTokens: 150,
      costUsd: 0.0123,
    })}\n${JSON.stringify({
      ts: new Date().toISOString(),
      command: "lit-review",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      ok: true,
      inputTokens: 400,
      outputTokens: 90,
      costUsd: null,
    })}\n`,
  );

  await page.reload();
  await page.getByRole("button", { name: "用量", exact: true }).click();

  const after = await page.evaluate(
    async () =>
      (await (await fetch("/api/usage")).json()) as {
        calls: number;
        knownCostUsd: number;
        unknownCostCalls: number;
      },
  );
  expect(after.calls).toBe(before.calls + 2);
  expect(after.unknownCostCalls).toBe(before.unknownCostCalls + 1);
  expect(after.knownCostUsd).toBeCloseTo(before.knownCostUsd + 0.0123, 6);

  const card = page.locator('[data-testid="llm-usage-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText(`调用 ${after.calls} 次`);
  // 面板显示的已知花费必须是后端算好的那个数（fmtUsd = `$${v.toFixed(4)}`）。
  await expect(card.locator('[data-testid="known-cost-usd"]')).toContainText(`$${after.knownCostUsd.toFixed(4)}`);
  const warning = page.locator('[data-testid="unknown-cost-warning"]');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("总花费无法确定报出");
});

// ── W8-1 γ · V88/V90/V79③（工作台体验三条）───────────────────────────────────
//
// 各自新建一个专用项目，不复用 "e2e-lab"——那条链路上的论文早就全部生成过精读卡了
// （见 ③），复用会撞到 V88/V79③ 都需要的「有未读论文」这个前提，还得先 redoRead。
// 新建项目走 fixture 已经录制好的同一条 AlphaFold 检索式（DualCassetteSearcher 按
// query 分派，不区分项目），直接打 HTTP 种入库，跳过重复测一遍 UI 检索。

test("⑰ V88：批量精读任务面板出现 1/3 与 2/3 两个中间态（不再是 0 → 直接跳满）", async ({ page }) => {
  const PROJECT_V88 = "e2e-gamma-progress";
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByPlaceholder("protein-folding").fill(PROJECT_V88);
  // 这条描述里的 marker 是 fixture_server.ts 认得的信号：只有它才会给精读调用加延迟
  // （见 fixture_server.ts 的 READING_PROGRESS_MARKER 大注释），目的是让 3 篇精读的
  // done/total 跨过任务面板 2 秒一次的轮询间隔，不靠运气露出中间态。
  await dialog.locator("textarea").fill("w88-reading-progress-marker：精读进度面板专用项目，不代表真实研究课题");
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".head .badge").first()).toHaveText(PROJECT_V88);

  const seeded = await page.evaluate(async (project) => {
    const res = await fetch(`/api/lit/search?project=${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "AlphaFold protein structure prediction",
        add: true,
        limit: 3,
        await: true,
      }),
    });
    return { status: res.status, body: await res.json() };
  }, PROJECT_V88);
  expect(seeded.status).toBe(200);

  await page.getByRole("button", { name: /^文献库/ }).click();
  await page.getByRole("button", { name: "全部生成精读卡" }).click();

  await page.getByRole("button", { name: "任务", exact: true }).click();
  const taskRow = page.locator('[data-testid="task-row"]', { hasText: "精读卡生成" }).first();
  await expect(taskRow).toBeVisible({ timeout: 15_000 });

  // 面板每 2 秒轮询一次；累积看到过的 done/total 组合，直到任务落定为止。
  const seenFractions = new Set<string>();
  await expect
    .poll(
      async () => {
        const text = await taskRow.innerText().catch(() => "");
        const match = text.match(/(\d+) \/ (\d+)/);
        if (match) seenFractions.add(`${match[1]}/${match[2]}`);
        return (await taskRow.innerText().catch(() => "")).match(/(succeeded|failed)/)?.[0] ?? "";
      },
      { timeout: 45_000, intervals: [250] },
    )
    .toMatch(/succeeded|failed/);

  expect(Array.from(seenFractions)).toEqual(expect.arrayContaining(["1/3", "2/3"]));
});

test("⑱ V90：项目下拉框文本含 slug（导入产物与原项目重名可区分）", async ({ page }) => {
  await page.goto("/");
  const option = page.locator('#project-select option[value="e2e-lab"]');
  await expect(option).toHaveCount(1);
  const text = await option.innerText();
  expect(text).toContain("(e2e-lab)");
});

test("⑲ V79③：预算 $0.0001 触发闸，任务面板显示闸消息（含下一步）", async ({ page }) => {
  const PROJECT_BUDGET = "e2e-gamma-budget";
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  const dialog = page.getByRole("dialog", { name: "新建项目" });
  await dialog.getByPlaceholder("protein-folding").fill(PROJECT_BUDGET);
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".head .badge").first()).toHaveText(PROJECT_BUDGET);

  const seeded = await page.evaluate(async (project) => {
    const res = await fetch(`/api/lit/search?project=${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "AlphaFold protein structure prediction",
        add: true,
        limit: 1,
        await: true,
      }),
    });
    return { status: res.status };
  }, PROJECT_BUDGET);
  expect(seeded.status).toBe(200);

  await page.getByRole("button", { name: /^文献库/ }).click();
  // V79③ 的 UI 入口：精读按钮旁边的「预算 $」输入。
  await page.getByLabel("预算 $").fill("0.0001");
  await page.getByRole("button", { name: "全部生成精读卡" }).click();

  await page.getByRole("button", { name: "任务", exact: true }).click();
  const taskRow = page.locator('[data-testid="task-row"]', { hasText: "精读卡生成" }).first();
  await expect(taskRow).toBeVisible({ timeout: 15_000 });
  await expect(taskRow).toContainText("failed", { timeout: 15_000 });
  const errorBox = taskRow.locator(".error-box");
  await expect(errorBox).toContainText("预算闸");
  await expect(errorBox).toContainText("下一步");
});

test("⑳ V79②：结论 review 面板在没有实验时显示前置提示，不是空白", async ({ page }) => {
  await page.goto("/");
  // e2e-gamma-budget（⑲刚建的）还没跑过任何实验，也没有任何结论卡——正是 V79② 要求
  // 「先跑一个实验」这条前置条件该出现的地方。
  await page.locator("#project-select").selectOption("e2e-gamma-budget");
  // 左栏导航的「结论」按钮与右栏时间线的过滤 chip 都叫「结论」——限定在左栏导航区域，
  // 与 ⑭ 里 "产物" 导航同一个消歧写法。
  await page.locator(".left").getByRole("button", { name: /^结论/ }).click();
  // 页面上其它面板（湿实验列表、右栏未选中提示）也各自有一个 `.empty`——限定在中栏。
  const empty = page.locator(".center .empty").first();
  await expect(empty).toContainText("先跑一个实验");
  await expect(empty).toContainText("conclude");
});

// ────────────────────────────────────────────────────────────────────────────
// W9-ε · 设置面（U6·A / U3 / U2 徽标）。编号接 ㉑ 起，上面的用例一条没动。
//
// **这批用例跑在哪个后端上**，如实说清楚：
//
// 设置面的后端是 lane γ 的 `backend/src/server/routes/settings/**`，挂载进
// `server/app.ts` 的那一行是枢纽文件，归收口。所以在 ε 的分支上 `/api/settings/**`
// 还是 404。下面的 `installSettingsBackend()` 装一个**回退**拦截器：每个请求先真的发给
// server（`route.fetch()`），**只有在 404 时**才由本文件里的内存假件应答。
//
// 三个后果，都不藏：
//   ① 今天这批用例验的是**前端**（发对请求、渲染对响应、写完刷新、值不回显），
//      后端那一半由 γ 自己的 `tests/unit/settings_*.test.ts` 验。
//   ② 收口把 `app.route("/api/settings", settingsRoutes(ctx))` 那一行合进去之后，
//      同一批断言**自动**改为打真路由，假件变成死代码——它是会自己退役的脚手架，
//      不是一个需要记得回来删的 TODO。
//   ③ 凭据那条「任何 XHR 响应体都不含填入的值」在假件下只证明了假件不回显；
//      它的牙齿在收口后才完整。**但同一条用例里的「页面任何位置不出现该值」是真的**
//      ——那一半盯的正是前端有没有把值画回界面，也正是本 lane 的阴性对照要拆的地方。

/** 假件的可变状态：PUT 真的改它，所以「改了刷新仍在」这件事在前端侧是真的被验的。 */
function makeSettingsFixture() {
  const general = new Map<string, { value: string | number | null; source: string }>([
    ["defaultModel", { value: "moonshotai/kimi-k2.6", source: "default" }],
    ["llmTimeoutMs", { value: 120000, source: "default" }],
    ["contactEmail", { value: "spark-research@example.invalid", source: "default" }],
    ["KIMI_API_KEY", { value: null, source: "unset" }],
  ]);
  const credentials = new Map<string, string[]>([
    ["aminer", []],
    ["kimi", []],
  ]);
  let sources = ["openalex", "crossref"];
  const allSources = ["openalex", "crossref", "arxiv", "pubmed"];
  // **形状对齐 γ 的实装**（不是它的骨架 fixture）：已装扩展一律 `category: "extension"`
  // 且 key 带 `ext:` 前缀，技能是 `category: "skill"` 且 key 带 `skill:` 前缀，
  // 发现到的工具叫 `mcpTools`。前端对两代名字都兼容，但假件按**新的**来，
  // 这样 e2e 验的是收口后真正会发生的那条路径。
  const extensions: Array<{ name: string; category: string }> = [
    { name: "literature-triage", category: "skill" },
    { name: "novelty-check", category: "skill" },
    { name: "example-mcp", category: "extension" },
  ];
  let computeTarget = "local";
  let probed = false;

  const item = (fields: Record<string, unknown>) => ({
    allowed: null,
    editable: true,
    nextStep: null,
    ...fields,
  });

  const meta = (level: string, summary: string, notes: string[]) => ({ level, summary, notes });

  return {
    get sources() {
      return sources;
    },
    get extensions() {
      return extensions;
    },
    handle(method: string, path: string, body: Record<string, unknown>): unknown | null {
      const seg = path.replace(/^\/api\/settings/, "").split("?")[0]!;

      if (seg === "/general" && method === "GET") {
        return {
          panel: "general",
          items: [...general.entries()].map(([key, state]) =>
            item({
              key,
              label: key,
              kind: key.endsWith("_API_KEY") ? "secret" : typeof state.value === "number" ? "number" : "string",
              value: key.endsWith("_API_KEY") ? null : state.value,
              source: state.source,
              configured: state.value !== null,
              editable: !key.endsWith("_API_KEY"),
              summary: `假件：${key} 的说明来自后端，不在前端写第二份`,
              nextStep: key.endsWith("_API_KEY") ? "凭据请在「凭据」面板填" : null,
            }),
          ),
          meta: meta("full", "假件 general 面板", ["这是 e2e 回退假件，收口后由真路由接管"]),
        };
      }
      if (seg.startsWith("/general/") && (method === "PUT" || method === "DELETE")) {
        const key = decodeURIComponent(seg.slice("/general/".length));
        const state = general.get(key);
        if (!state) return { error: `未知配置项 ${key}`, nextStep: "用 config list 看有哪些键" };
        if (method === "DELETE") {
          state.value = null;
          state.source = "default";
        } else {
          state.value = body.value as string | number | null;
          state.source = "config";
        }
        return {
          panel: "general",
          item: item({ key, label: key, kind: "string", value: state.value, source: state.source, summary: "假件" }),
          meta: meta("full", "假件 general 面板", []),
        };
      }

      if (seg === "/credentials" && method === "GET") {
        return {
          panel: "credentials",
          items: [...credentials.entries()].map(([id, fieldsSet]) =>
            item({
              key: id,
              label: id,
              kind: "secret",
              value: null,
              configured: fieldsSet.length > 0,
              summary: `假件：${id} 的凭据`,
              nextStep: `在本面板直填，或在终端执行 spark-research auth --connector ${id}`,
              fields: ["api_key"],
              fieldsSet,
            }),
          ),
          meta: meta("full", "假件凭据面板", ["值写进来之后永不回显"]),
        };
      }
      if (seg.startsWith("/credentials/")) {
        const id = decodeURIComponent(seg.slice("/credentials/".length));
        if (method === "PUT") {
          const fields = (body.fields ?? {}) as Record<string, string>;
          // **假件也绝不把值存进响应**：只记住字段名。这是契约本身的形状。
          credentials.set(id, Object.keys(fields));
          return {
            panel: "credentials",
            item: item({
              key: id,
              label: id,
              kind: "secret",
              value: null,
              configured: true,
              summary: `假件：${id} 的凭据`,
              fields: ["api_key"],
              fieldsSet: Object.keys(fields),
            }),
            meta: meta("full", "假件凭据面板", []),
          };
        }
        if (method === "DELETE") {
          credentials.set(id, []);
          return {
            panel: "credentials",
            removed: true,
            id,
            note: "只删本机保存的值，不影响外部账户",
            item: item({ key: id, label: id, kind: "secret", value: null, configured: false, summary: "假件", fields: ["api_key"], fieldsSet: [] }),
          };
        }
      }

      if (seg === "/scientific-tools" && method === "GET") {
        probed = path.includes("probe=1") || probed;
        return {
          panel: "scientific-tools",
          items: [
            item({
              key: "searchSources",
              label: "默认检索源",
              kind: "enum",
              value: sources.join(","),
              source: "config",
              allowed: allSources,
              summary: "假件：不给 --sources 时查哪些源",
              extra: { selected: sources },
            }),
            item({
              key: "opentrons",
              label: "Opentrons",
              kind: "info",
              value: null,
              editable: false,
              summary: "假件：湿实验后端",
              nextStep: "pip install opentrons",
              extra: { category: "wetBackend", probe: probed ? { ok: false, note: "假件：没装" } : null },
            }),
          ],
          meta: meta("full", "假件科学工具面板", ["?probe=1 才会真探"]),
        };
      }
      if (seg === "/sources" && method === "PUT") {
        sources = (body.ids as string[]) ?? [];
        return {
          panel: "scientific-tools",
          item: item({ key: "searchSources", label: "默认检索源", kind: "enum", value: sources.join(","), allowed: allSources, summary: "假件", extra: { selected: sources } }),
          meta: meta("full", "假件科学工具面板", []),
        };
      }

      if (seg === "/models" && method === "GET") {
        return {
          panel: "models",
          items: [
            item({ key: "defaultModel", label: "默认模型", kind: "enum", value: "moonshotai/kimi-k2.6", source: "default", allowed: ["moonshotai/kimi-k2.6", "openai/gpt-5"], summary: "假件：默认模型" }),
            item({ key: "subAgentModel_review", label: "子代理 review 的模型覆盖", kind: "enum", value: null, source: "unset", allowed: ["moonshotai/kimi-k2.6"], summary: "假件：review 子代理", extra: { subAgentType: "review" } }),
          ],
          meta: meta("full", "假件模型面板", []),
        };
      }
      if (seg.startsWith("/models/") && method === "PUT") {
        return { panel: "models", item: item({ key: "defaultModel", label: "默认模型", kind: "enum", value: body.model ?? null, allowed: ["moonshotai/kimi-k2.6"], summary: "假件" }), meta: meta("full", "假件模型面板", []) };
      }

      if (seg === "/local" && method === "GET") {
        return {
          panel: "local",
          items: [item({ key: "SPARK_LOCAL_LLM_BASE_URL", label: "本地端点 baseUrl", kind: "string", value: null, source: "unset", summary: "假件：本地端点", extra: { probe: { ok: false, reason: "没配端点", models: [] } } })],
          meta: meta("reduced", "假件本地模型面板", ["不做模型拉取"]),
        };
      }
      if (seg === "/local" && method === "PUT") {
        return { panel: "local", item: item({ key: "SPARK_LOCAL_LLM_BASE_URL", label: "本地端点 baseUrl", kind: "string", value: body.baseUrl ?? null, summary: "假件" }), meta: meta("reduced", "假件本地模型面板", []) };
      }

      if (seg === "/extensions" && method === "GET") {
        return {
          panel: "extensions",
          items: extensions.map((ext) =>
            item({
              key: `${ext.category === "skill" ? "skill" : "ext"}:${ext.name}`,
              label: ext.name,
              kind: "info",
              value: ext.category === "skill" ? null : "available",
              editable: false,
              summary: `假件：${ext.category} ${ext.name}`,
              extra: {
                category: ext.category,
                status: ext.category === "skill" ? undefined : "available",
                triggers: ext.category === "skill" ? ["分诊", "triage"] : [],
                mcpTools: ext.category === "skill" ? [] : ["echo"],
              },
            }),
          ),
          meta: meta("reduced", "假件扩展面板", ["装载一律不带 --trust"]),
        };
      }
      if (seg === "/extensions/mcp" && method === "POST") {
        extensions.push({ name: String(body.name), category: "extension" });
        return { panel: "extensions", item: item({ key: `ext:${String(body.name)}`, label: String(body.name), kind: "info", value: "available", editable: false, summary: "假件", extra: { category: "extension" } }), meta: meta("reduced", "假件扩展面板", []) };
      }
      if (seg.startsWith("/extensions/") && (method === "POST" || method === "DELETE")) {
        // 路径参数是**裸名字**（不带 `ext:` 前缀）——前端把前缀剥掉之后才调过来。
        // 假件在这里认真核一遍：前端要是直接把 `ext:foo` 当名字发过来，这里就找不到，
        // DELETE 会变成空操作，㉘ 的断言会红。
        const name = decodeURIComponent(seg.split("/")[2]!);
        if (name.includes(":")) {
          return { error: `扩展名不该带前缀：${name}`, nextStep: "前端应传裸名字" };
        }
        if (method === "DELETE") {
          const index = extensions.findIndex((e) => e.name === name);
          if (index >= 0) extensions.splice(index, 1);
        }
        return { panel: "extensions", item: item({ key: `ext:${name}`, label: name, kind: "info", value: "available", editable: false, summary: "假件", extra: { category: "extension" } }), meta: meta("reduced", "假件扩展面板", []) };
      }

      if (seg === "/compute" && method === "GET") {
        return {
          panel: "compute",
          items: [
            item({ key: "computeTarget", label: "默认执行地", kind: "enum", value: computeTarget, source: "default", allowed: ["local", "modal"], summary: "假件：默认执行地" }),
            item({ key: "modal", label: "modal", kind: "info", value: null, editable: false, summary: "假件：Modal 可用性", nextStep: "在「凭据」面板配 modal token" }),
          ],
          meta: meta("reduced", "假件算力面板", ["派发与审批刻意不走 HTTP（V47 / AD-6）"]),
        };
      }
      if (seg === "/compute/target" && method === "PUT") {
        computeTarget = String(body.target);
        return { panel: "compute", item: item({ key: "computeTarget", label: "默认执行地", kind: "enum", value: computeTarget, allowed: ["local", "modal"], summary: "假件" }), meta: meta("reduced", "假件算力面板", []) };
      }

      if (seg === "/network" && method === "GET") {
        return {
          panel: "network",
          items: [item({ key: "httpTimeoutMs", label: "httpTimeoutMs", kind: "number", value: 30000, source: "default", summary: "假件：HTTP 超时" })],
          meta: meta("full", "假件网络面板", []),
        };
      }
      if (seg.startsWith("/network/") && method === "PUT") {
        return { panel: "network", item: item({ key: "httpTimeoutMs", label: "httpTimeoutMs", kind: "number", value: body.value ?? null, summary: "假件" }), meta: meta("full", "假件网络面板", []) };
      }

      if (seg === "/storage" && method === "GET") {
        return {
          panel: "storage",
          items: [item({ key: "rawLlm", label: "保留 LLM 原文", kind: "enum", value: "on", source: "default", allowed: ["on", "off"], summary: "假件：raw 开关", extra: { bytes: 2048, records: 7 } })],
          meta: meta("reduced", "假件存储面板", ["不做目录迁移"]),
        };
      }
      if (seg.startsWith("/storage/export") && method === "POST") {
        return { panel: "storage", task: { id: "fixture-export", kind: "data-export", state: "running", project: String(body.project ?? "") } };
      }
      if (seg.startsWith("/storage/") && method === "PUT") {
        return { panel: "storage", item: item({ key: "rawLlm", label: "保留 LLM 原文", kind: "enum", value: body.value ?? null, allowed: ["on", "off"], summary: "假件" }), meta: meta("reduced", "假件存储面板", []) };
      }

      if (seg === "/permissions" && method === "GET") {
        return {
          panel: "permissions",
          items: [item({ key: "withheld:lab_approve", label: "lab_approve", kind: "info", value: null, editable: false, summary: "假件：刻意不暴露的动作", nextStep: "在终端执行 spark-research lab approve <id>" })],
          meta: meta("readonly", "假件权限面板", ["只读面板"]),
        };
      }

      return null;
    },
  };
}

/**
 * 装上「先打真 server，404 才回退假件」的拦截器。收口把 γ 的路由挂进 app.ts 之后，
 * 真 server 不再 404，这个假件就再也不会被调用——脚手架自己退役。
 */
async function installSettingsBackend(page: Page): Promise<{ stubbed: () => number }> {
  const fixture = makeSettingsFixture();
  let stubHits = 0;

  await page.route("**/api/settings/**", async (route) => {
    const request = route.request();
    const live = await route.fetch().catch(() => null);
    if (live && live.status() !== 404) {
      await route.fulfill({ response: live });
      return;
    }
    stubHits += 1;
    let body: Record<string, unknown> = {};
    try {
      body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const url = new URL(request.url());
    const payload = fixture.handle(request.method(), url.pathname + url.search, body);
    if (payload === null) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "假件没有这条路由", nextStep: "在 workbench.spec.ts 的假件里补上" }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });

  return { stubbed: () => stubHits };
}

/** 打开设置面并切到某个面板。 */
async function openSettings(page: Page, panelId?: string): Promise<void> {
  await page.locator('[data-testid="nav-settings"]').click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  if (panelId) {
    await page.locator(`.settings-nav__item[data-panel="${panelId}"]`).click();
    await expect(page.locator(`.settings-main__body[data-panel="${panelId}"]`)).toBeVisible();
  }
}

/** 直接问 API 要某个面板的条目（与 UI 走同一个拦截器，所以两边看到的是同一份数据）。 */
async function panelItems(page: Page, path: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async (p) => {
    const res = await fetch(p);
    const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
    return body.items ?? [];
  }, path);
}

test("㉑ 设置面：左栏「设置」打开壳，四组导航齐，且没有 sandbox 面板", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await openSettings(page);

  // 四组 section 的标签。
  for (const label of ["推理", "能力", "运行时", "应用"]) {
    await expect(page.locator(".settings-nav__label", { hasText: new RegExp(`^${label}$`) })).toBeVisible();
  }

  // 12 个面板，一个不多一个不少。
  await expect(page.locator(".settings-nav__item")).toHaveCount(12);

  // **sandbox 不是 disabled，是根本不存在**：没有底子的能力不放占位（AD-12）。
  await expect(page.locator('.settings-nav__item[data-panel="sandbox"]')).toHaveCount(0);
  const navText = await page.locator(".settings-nav").innerText();
  expect(navText.toLowerCase()).not.toContain("sandbox");
  expect(navText).not.toContain("沙箱");
});

test("㉒ 设置面：数字键 6 打开，Esc 关闭，回到原来在看的视图", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");

  await page.getByRole("button", { name: "文献库", exact: false }).first().click();
  await page.locator("body").press("6");
  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();

  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  // 关掉之后中栏还是刚才那个视图（设置面是覆盖层，不是第六个视图）。
  await expect(page.locator(".left .nav-item[aria-current='true']")).toContainText("文献库");
});

test("㉓ general 面板：行数 == GET 的 items 数；改一个值刷新后仍在", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await openSettings(page, "general");

  const items = await panelItems(page, "/api/settings/general");
  const rows = page.locator('.settings-main__body[data-panel="general"] .settings-row');
  await expect(rows).toHaveCount(items.length);

  // 凭据类 key 在这条路由上不给输入框——渲染一个注定 403 的控件就是死按钮。
  // 按 data-key 精确取行：真后端里 OPENAI_API_KEY 的说明文字也提到 KIMI_API_KEY，hasText 会多筛一行。
  const secretRow = page.locator('.settings-main__body[data-panel="general"] .settings-row[data-key="KIMI_API_KEY"]');
  await expect(secretRow).toHaveCount(1);
  await expect(secretRow.locator("input")).toHaveCount(0);

  // 改 llmTimeoutMs → 保存 → 整页刷新 → 重新打开设置面，新值还在。
  const timeoutInput = page.locator('input[aria-label="llmTimeoutMs"]');
  await timeoutInput.fill("45678");
  await page.locator('.settings-main__body[data-panel="general"] .settings-row')
    .filter({ hasText: "llmTimeoutMs" })
    .getByRole("button", { name: "保存" })
    .click();
  await expect(page.locator(".toast")).toContainText("llmTimeoutMs 已保存");

  await page.reload();
  await openSettings(page, "general");
  await expect(page.locator('input[aria-label="llmTimeoutMs"]')).toHaveValue("45678");
});

test("㉔ 凭据面板：填入的假 key 不出现在页面任何位置，也不出现在任何响应体里", async ({ page }) => {
  await installSettingsBackend(page);

  // 一个不可能被别的东西撞上的假值。**这个字符串是本条用例的全部判据**。
  const FAKE_KEY = "sk-e2e-epsilon-NEVER-ECHO-3f9a71c2d4b6";

  // 盯住这一页发出的**每一个**响应体。凭据写入之后，它不许出现在任何一个里面。
  const leaks: string[] = [];
  page.on("response", async (response) => {
    try {
      const body = await response.text();
      if (body.includes(FAKE_KEY)) leaks.push(`${response.request().method()} ${response.url()}`);
    } catch {
      // 二进制 / 已关闭的响应读不出来，跳过——它们本来也不可能是设置面的 JSON。
    }
  });

  await page.goto("/");
  await openSettings(page, "credentials");

  const items = await panelItems(page, "/api/settings/credentials");
  const rows = page.locator('.settings-main__body[data-panel="credentials"] .settings-row');
  await expect(rows).toHaveCount(items.length);

  await page.locator('[data-testid="cred-aminer-api_key"]').fill(FAKE_KEY);
  await page.locator('[data-testid="cred-save-aminer"]').click();
  await expect(page.locator(".toast")).toContainText("已保存");

  // ① 保存成功后这一行只显示**字段名**已设，没有值。
  const aminerRow = rows.filter({ hasText: "aminer" });
  // 「已设」（字段级）与「已配置」（行级）都是 .badge-ok，按文本区分，别用 first()
  // 这种会随渲染顺序漂移的写法。
  await expect(aminerRow.locator(".badge-ok").filter({ hasText: /^已设$/ })).toHaveCount(1);
  await expect(aminerRow).toContainText("已配置");

  // ② 输入框被清空——刚填的值不留在 DOM 里等着被截图。
  await expect(page.locator('[data-testid="cred-aminer-api_key"]')).toHaveValue("");

  // ③ 整页文本（含已渲染的属性值）里不出现那个值。**阴性对照要拆的就是这一条**：
  //    让面板把保存的值回显到行里，这里立刻红。
  const pageHtml = await page.content();
  expect(pageHtml).not.toContain(FAKE_KEY);

  // ④ 刷新后重新打开，仍然只见字段名。
  await page.reload();
  await openSettings(page, "credentials");
  await expect(page.locator('.settings-main__body[data-panel="credentials"] .settings-row').filter({ hasText: "aminer" })).toContainText("已配置");
  expect(await page.content()).not.toContain(FAKE_KEY);

  // ⑤ 所有响应体里一次都没出现过。
  expect(leaks).toEqual([]);
});

test("㉕ 检索源面板：勾掉一个源 → 保存 → 回读 searchSources 真的变了", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await openSettings(page, "sources");

  const before = await panelItems(page, "/api/settings/scientific-tools");
  const sourcesItem = before.find((i) => i.key === "searchSources")!;
  const selectedBefore = ((sourcesItem.extra as Record<string, unknown>).selected ?? []) as string[];
  expect(selectedBefore.length).toBeGreaterThan(0);

  const dropped = selectedBefore[0]!;
  await page.locator(`[data-testid="source-${dropped}"]`).uncheck();
  await page.locator('[data-testid="sources-save"]').click();
  await expect(page.locator(".toast")).toContainText("默认检索源已保存");

  const after = await panelItems(page, "/api/settings/scientific-tools");
  const selectedAfter = ((after.find((i) => i.key === "searchSources")!.extra as Record<string, unknown>)
    .selected ?? []) as string[];
  expect(selectedAfter).not.toContain(dropped);
  expect(selectedAfter.length).toBe(selectedBefore.length - 1);
});

test("㉖ 科学工具面板：「真探一次」之后条目上出现探测结论", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await openSettings(page, "scientific-tools");

  const body = page.locator('.settings-main__body[data-panel="scientific-tools"]');
  await expect(body).toContainText("没有探测过");

  await page.locator('[data-testid="probe-tools"]').click();
  await expect(body).toContainText("来自刚才那次真实探测");
  await expect(body.locator(".badge").filter({ hasText: /探通了|没探通/ }).first()).toBeVisible();
});

test("㉗ 算力设置面板：只有改默认执行地，没有任何派发/审批按钮（V47 / AD-6）", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await openSettings(page, "compute");

  const body = page.locator('.settings-main__body[data-panel="compute"]');
  await expect(body.locator('select[aria-label="computeTarget"]')).toBeVisible();

  // 与既有 ⑰ 同一条硬断言，换个面板再钉一遍：HTTP 面刻意没开派发/审批这个口子。
  const forbidden = /派发|批准|拒绝|approve|reject|dispatch|^运行$|^执行$/i;
  const buttons = body.locator("button");
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    expect((await buttons.nth(i).innerText()).trim()).not.toMatch(forbidden);
  }
});

test("㉘ 连接器面板：添加一个 MCP → 列表里出现它", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await openSettings(page, "connectors");

  const body = page.locator('.settings-main__body[data-panel="connectors"]');
  await page.locator('[data-testid="mcp-name"]').fill("e2e-mcp");
  await page.locator('[data-testid="mcp-cmd"]').fill("bun run e2e-mcp");
  await page.locator('[data-testid="mcp-add"]').click();

  await expect(page.locator(".toast")).toContainText("已添加");
  await expect(body.locator(".settings-row").filter({ hasText: "e2e-mcp" })).toBeVisible();
});

test("㉙ 技能面板：每条技能列出它的触发词", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await openSettings(page, "skills");

  const items = await panelItems(page, "/api/settings/extensions");
  const skills = items.filter((i) => (i.extra as Record<string, unknown> | undefined)?.category === "skill");
  const body = page.locator('.settings-main__body[data-panel="skills"]');
  await expect(body.locator(".settings-row")).toHaveCount(skills.length);
  await expect(body.locator(".chip").first()).toBeVisible();
});

test("㉚ 存储面板：导出当前项目拿到任务句柄", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await waitIdle(page);
  await openSettings(page, "storage");

  await page.locator('[data-testid="storage-export"]').click();
  await expect(page.locator(".toast")).toContainText("导出任务已提交");
});

// 每个面板一条：打开它，断言它可见、且行数 == 对应 GET 的 items 数（按面板自己的
// 过滤规则）。sources 的控件是勾选框不是设置行，单独按勾选框数算。
const PANEL_ROW_EXPECTATIONS: Array<{
  id: string;
  endpoint: string;
  rows: (items: Array<Record<string, unknown>>) => number;
  selector?: string;
}> = [
  { id: "general", endpoint: "/api/settings/general", rows: (i) => i.length },
  { id: "models", endpoint: "/api/settings/models", rows: (i) => i.length },
  { id: "local-models", endpoint: "/api/settings/local", rows: (i) => i.length },
  { id: "credentials", endpoint: "/api/settings/credentials", rows: (i) => i.length },
  {
    id: "sources",
    endpoint: "/api/settings/scientific-tools",
    rows: (i) => ((i.find((x) => x.key === "searchSources")?.allowed ?? []) as string[]).length,
    selector: 'input[type="checkbox"]',
  },
  {
    id: "scientific-tools",
    endpoint: "/api/settings/scientific-tools",
    rows: (i) => i.filter((x) => x.key !== "searchSources").length,
  },
  {
    id: "connectors",
    endpoint: "/api/settings/extensions",
    rows: (i) =>
      i.filter((x) => {
        const category = (x.extra as Record<string, unknown> | undefined)?.category;
        return category === "extension" || category === "mcp" || category === "connector";
      }).length,
  },
  {
    id: "skills",
    endpoint: "/api/settings/extensions",
    rows: (i) => i.filter((x) => (x.extra as Record<string, unknown> | undefined)?.category === "skill").length,
  },
  { id: "compute", endpoint: "/api/settings/compute", rows: (i) => i.length },
  { id: "network", endpoint: "/api/settings/network", rows: (i) => i.length },
  { id: "storage", endpoint: "/api/settings/storage", rows: (i) => i.length },
  { id: "permissions", endpoint: "/api/settings/permissions", rows: (i) => i.length },
];

for (const expectation of PANEL_ROW_EXPECTATIONS) {
  test(`㉛ 面板 ${expectation.id}：可见，且行数 == 对应 GET 的 items 数`, async ({ page }) => {
    await installSettingsBackend(page);
    await page.goto("/");
    await openSettings(page, expectation.id);

    const items = await panelItems(page, expectation.endpoint);
    const body = page.locator(`.settings-main__body[data-panel="${expectation.id}"]`);
    await expect(body).toBeVisible();
    // 面板抬头的能力分级来自 API 的 meta.level，前端不存第二份——它在就说明 meta 渲染了。
    await expect(body.locator(".settings-meta .badge").first()).toBeVisible();
    await expect(body.locator(expectation.selector ?? ".settings-row")).toHaveCount(expectation.rows(items));
  });
}

test("㉜ 顶栏版本徽标：server 报一个不同的版本 → 出现黄色「server vX ≠ UI vY」", async ({ page }) => {
  // 先看真实情况：同一个构建，徽标不该报不一致。
  await page.goto("/");
  const badge = page.locator('[data-testid="version-badge"]');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-mismatch", "false");

  // 再伪造一个「端口上蹲着个旧 server」的场景——U2 那次困惑持续两天，直接原因就是
  // 界面上看不到这两个版本号。
  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok", service: "spark-research", version: "0.0.1-orphan" }),
    });
  });
  await page.reload();
  await expect(badge).toHaveAttribute("data-mismatch", "true");
  await expect(badge).toContainText("server v0.0.1-orphan");
  await expect(badge).toContainText("≠ UI v");
});

test("㉝ U3：项目下拉默认不列已归档，点「显示已归档」之后才出现", async ({ page }) => {
  await page.goto("/");
  await waitIdle(page);

  // 造一个会被归档的项目，再把指针切回主线项目——不影响上面那些串行用例的现场。
  const slug = "e2e-epsilon-archived";
  // `page.evaluate` 的回调在浏览器里跑，拿不到本文件的模块作用域——两个 slug 都得
  // 显式传进去（上一版只传了一个，`PROJECT is not defined` 就是这么来的）。
  await page.evaluate(
    async ([archiveSlug, mainSlug]) => {
      await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: archiveSlug, name: archiveSlug }),
      });
      // 写请求一律要 `Content-Type: application/json`（server/app.ts 的既有闸），
      // 哪怕没有请求体。少了这个头会拿到 400 而不是归档成功，且下拉框里看不出差别。
      await fetch(`/api/projects/${archiveSlug}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await fetch("/api/projects/current", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: mainSlug }),
      });
    },
    [slug, PROJECT] as const,
  );

  await page.reload();
  await waitIdle(page);

  const options = page.locator("#project-select option");
  await expect(options.filter({ hasText: slug })).toHaveCount(0);

  await page.locator('[data-testid="toggle-archived"]').click();
  await expect(options.filter({ hasText: slug })).toHaveCount(1);
  await expect(page.locator('[data-testid="toggle-archived"]')).toContainText("隐藏已归档");
});

test("㉞ 设置面搜索框：既过滤面板名，也过滤面板内设置项；没建索引的面板不隐藏", async ({ page }) => {
  await installSettingsBackend(page);
  await page.goto("/");
  await openSettings(page, "general");

  const nav = page.locator(".settings-nav__item");
  await expect(nav).toHaveCount(12);

  // ① 按面板名过滤。
  await page.locator("#settings-search").fill("凭据");
  await expect(nav.filter({ hasText: "凭据" })).toHaveCount(1);

  // ② 按**面板内设置项**过滤：`llmTimeoutMs` 只存在于 general 的 items 里，
  //    面板名里没有这四个字。搜得到它，说明索引用的是 API 给的条目而不是面板名。
  await page.locator("#settings-search").fill("llmtimeoutms");
  const general = nav.filter({ has: page.locator('text="通用"') });
  await expect(general).toHaveCount(1);
  // 命中数以角标显示（general 里恰好一条命中）。
  await expect(general.locator(".nav-count").first()).toHaveText("1");
  // 右侧面板本身也跟着只剩命中的那一行。
  await expect(page.locator('.settings-main__body[data-panel="general"] .settings-row')).toHaveCount(1);

  // ③ 本次没打开过的面板**不隐藏**，而是标成 unindexed——搜不到不等于里面没有，
  //    藏掉就是做一个兑现不了的承诺（壳里那段注释说的就是这件事）。
  const unindexed = page.locator('.settings-nav__item[data-state="unindexed"]');
  expect(await unindexed.count()).toBeGreaterThan(0);
  await expect(page.locator(".settings-nav__foot")).toContainText("还没打开过");

  // ④ 打开其中一个之后它就建了索引，同一个搜索词下变成「不命中」而被过滤掉。
  await page.locator('.settings-nav__item[data-panel="network"]').click();
  await expect(page.locator('.settings-main__body[data-panel="network"]')).toBeVisible();
  await page.locator("#settings-search").fill("llmtimeoutms");
  await expect(page.locator('.settings-nav__item[data-panel="network"][data-state="unindexed"]')).toHaveCount(0);

  // ⑤ 清空搜索框 → 12 个面板全回来。
  await page.locator("#settings-search").fill("");
  await expect(nav).toHaveCount(12);
});
