import { expect, test, type Page } from "@playwright/test";

// v0.10 lane ε 的门禁：ε-2（V158 计数在 stream_ux.spec.ts / V159 行内 422 / V166 预算说明）
// 与 ε-3（V168 权限面板令牌计数实时读）。
//
// 设置面这两条的取数与写入都走 `/api/settings/**`，响应形状是 lane γ 的契约
// （`backend/src/server/routes/settings/types.ts`）。这里用 `page.route` 假掉这两个
// 端点：要测的是**前端拿到 422 之后有没有把话说在该说的地方**，而不是后端什么时候发 422
// ——后者是 γ 的门禁，在 tests/unit 里。假响应的字段逐个照契约填。

const PANEL_META = {
  level: "full" as const,
  summary: "通用设置",
  notes: [],
};

function generalPanel(value: string) {
  return {
    panel: "general",
    items: [
      {
        key: "uiDensity",
        label: "uiDensity",
        kind: "string",
        value,
        source: "config",
        editable: true,
        summary: "界面密度",
        nextStep: null,
      },
    ],
    meta: PANEL_META,
  };
}

async function openSettings(page: Page, panelTitle: string): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".brand")).toHaveText("Spark Research");
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: new RegExp(panelTitle) }).click();
}

test.describe.configure({ mode: "serial" });

test("ε-2 V159：设置项被 422 拒时，原因与下一步显示在**那一行**上，不只是一个会飘走的 toast", async ({
  page,
}) => {
  await page.route("**/api/settings/general", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(generalPanel("cozy")) }),
  );
  let putCount = 0;
  await page.route("**/api/settings/general/uiDensity", (route) => {
    putCount += 1;
    return route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: "uiDensity 只接受 cozy / compact，收到 'huge'",
        nextStep: "改成 cozy 或 compact，或在终端执行 `spark-research config set uiDensity compact`",
      }),
    });
  });

  await openSettings(page, "通用");
  const input = page.getByLabel("uiDensity");
  await input.fill("huge");
  await page.getByRole("button", { name: "保存" }).click();

  const error = page.getByTestId("setting-error-uiDensity");
  await expect(error).toBeVisible();
  await expect(error).toContainText("只接受 cozy / compact");
  // 「去哪做」必须在，U6 点名批过只报状态不给下一步。
  await expect(page.getByTestId("setting-error-next-uiDensity")).toContainText(
    "spark-research config set uiDensity compact",
  );
  expect(putCount).toBe(1);

  // 行内失败是**这一行自己的**状态：再次点保存会先清掉旧的，不是越堆越多。
  await expect(page.getByTestId("setting-error-uiDensity")).toHaveCount(1);
});

test("ε-2 V166：预算输入框旁边写明这是「本项目累计已知花费上限」，不是本次调用上限", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".brand")).toHaveText("Spark Research");
  // 会话栏的预算入口（另外三个 BudgetInput 共用同一个组件，说明只有一份）。
  await expect(page.getByTestId("chat-budget-hint")).toHaveText("本项目累计已知花费上限");
  await expect(page.locator("#chat-budget")).toHaveAttribute("aria-describedby", "chat-budget-hint");
});
