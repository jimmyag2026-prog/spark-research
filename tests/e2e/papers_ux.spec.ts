import { expect, test, type Page } from "@playwright/test";

// v0.10 lane ε-4 的门禁：文献列表二期（关键词列优先用精读卡抽的一句话 + 行内下载 PDF）。
//
// 文献库与精读卡两个端点用 `page.route` 假掉：要钉的是**前端怎么把两份数据拼到同一行上**
// 以及**「下载」按钮是不是真的打到了 `POST /papers/:id/pdf`**，而不是后端能不能下到 PDF
// （那是 connectors/pdf 的活，在 tests/unit 与 workbench.spec.ts 的真回放里）。
//
// 任务栈按真实链路走一遍：POST 拿句柄 → 订阅 SSE 失败 → 退化轮询 → succeeded。
// 退化那一步是 `lib/api.ts:waitForTask` 的既有行为（「功能不能依赖流」），这里顺带钉住。

const PROJECT = "e2e-papers";

function paper(over: Partial<Record<string, unknown>> & { id: string; title: string }) {
  return {
    authors: [{ name: "某人" }],
    year: 2021,
    venue: null,
    doi: null,
    abstract: null,
    tags: [],
    readingStatus: "unread",
    pdfStatus: "absent",
    bibtexKey: over.id,
    recordId: null,
    ...over,
  };
}

async function openPapers(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".brand")).toHaveText("Spark Research");
  await page.evaluate(async (slug) => {
    const list = (await (await fetch("/api/projects?all=1")).json()) as { projects: Array<{ slug: string }> };
    if (!list.projects.some((p) => p.slug === slug)) {
      await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, name: "文献列表门禁", description: "lane ε e2e" }),
      });
    }
    await fetch("/api/projects/current", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
  }, PROJECT);
  await page.reload();
  await page.getByRole("button", { name: "文献库" }).click();
}

test("ε-4 ①：关键词列优先显示精读卡抽出的一句话，没有卡才退回 tags", async ({ page }) => {
  await page.route("**/api/lit/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/lit/cards")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cards: [
            {
              recordId: "r1",
              paperId: "p-card",
              bibtexKey: "p-card",
              researchQuestion: "端到端预测行不行",
              methods: "Evoformer + 结构模块",
              // 首句才上屏；第二句与后面的段落不许挤进这一格。
              keyFindings: ["端到端网络把 GDT_TS 推到 92.4。另外训练成本很高。", "第二条不该出现"],
              limitations: [],
              relationToProject: "",
            },
          ],
        }),
      });
    }
    if (url.includes("/api/lit/papers")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          citations: 0,
          papers: [
            paper({ id: "p-card", title: "有精读卡的一篇", tags: ["入库时打的标签"] }),
            paper({ id: "p-tags", title: "只有 tags 的一篇", tags: ["蛋白质", "结构预测"] }),
            paper({ id: "p-bare", title: "两样都没有的一篇" }),
          ],
        }),
      });
    }
    return route.continue();
  });

  await openPapers(page);

  // ① 有卡：显示卡里的首句，**不是** tags。
  const withCard = page.getByTestId("paper-keywords-p-card");
  await expect(withCard).toHaveAttribute("data-source", "card");
  await expect(withCard).toHaveText("端到端网络把 GDT_TS 推到 92.4。");
  await expect(withCard).not.toContainText("入库时打的标签");
  await expect(withCard).not.toContainText("第二条不该出现");

  // ② 没卡有 tags：退回 tags。
  const withTags = page.getByTestId("paper-keywords-p-tags");
  await expect(withTags).toHaveAttribute("data-source", "tags");
  await expect(withTags).toHaveText("蛋白质 · 结构预测");

  // ③ 两样都没有：一个破折号，不编。
  await expect(page.getByTestId("paper-keywords-p-bare")).toHaveText("—");
});

test("ε-4 ②：未下载的 PDF 行内「下载」真的打到 POST /papers/:id/pdf，落定后那一行变成「打开」", async ({
  page,
}) => {
  let pdfPosts = 0;
  let taskPolls = 0;

  await page.route("**/api/lit/**", (route) => {
    const req = route.request();
    const url = req.url();
    if (url.includes("/pdf") && req.method() === "POST") {
      pdfPosts += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          task: { id: "t-pdf", kind: "lit.pdf", state: "running", project: PROJECT, createdAt: new Date().toISOString() },
        }),
      });
    }
    if (url.includes("/api/lit/cards")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cards: [] }) });
    }
    if (url.includes("/api/lit/papers")) {
      // 下载任务落定之后再拉这个端点，拿到的就是 downloaded——前端不自己改本地副本。
      const downloaded = pdfPosts > 0 && taskPolls > 0;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          citations: 0,
          papers: [
            paper({
              id: "p-dl",
              title: "还没下载 PDF 的一篇",
              pdfStatus: downloaded ? "downloaded" : "absent",
            }),
          ],
        }),
      });
    }
    return route.continue();
  });

  // 任务流订阅打不通 → `waitForTask` 退化成轮询（既有行为：功能不能依赖流）。
  await page.route("**/api/tasks/t-pdf/stream", (route) => route.abort());
  await page.route("**/api/tasks/t-pdf", (route) => {
    taskPolls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        task: {
          id: "t-pdf",
          kind: "lit.pdf",
          state: "succeeded",
          project: PROJECT,
          createdAt: new Date().toISOString(),
          result: { project: PROJECT, paperId: "p-dl", result: { ok: true, path: "/tmp/x.pdf" } },
        },
      }),
    });
  });

  await openPapers(page);

  const button = page.getByTestId("paper-pdf-download-p-dl");
  await expect(button).toBeVisible();
  await button.click();

  await expect.poll(() => pdfPosts, { timeout: 10_000 }).toBe(1);
  // 落定之后重新取数：同一行从「下载」变成「打开」（状态来自 API，不是本地乐观更新）。
  await expect(page.getByTestId("paper-pdf-open-p-dl")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("paper-pdf-download-p-dl")).toHaveCount(0);
});
