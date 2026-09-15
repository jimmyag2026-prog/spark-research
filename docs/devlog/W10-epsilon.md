# W10 · lane ε（前端）devlog

分支 `feat/W10-epsilon`（基于 `integration/v0.10-base` = `ff077ea`），worktree
`~/Desktop/AI4S/spark-research-epsilon`。任务书：`docs/taskbooks/v0.10/LANE_epsilon.md`；
方案 §三 ε。足迹：只动 `frontend/**`、`tests/e2e/**`、本文件。

| commit | 内容 |
|---|---|
| `404c779` | ε-1：三段式进度（阶段条 + 实时日志 + 按 target 分区的流式正文）+ 停止 |
| `d0af491` | ε-2：执行段计数（V158）、设置项 422 行内显示（V159）、预算说明（V166） |
| `4e86eb8` | ε-3：权限面板令牌计数实时重读（V168）+ 两个新 spec 去掉 serial |
| `46048f0` | ε-4：关键词列优先用精读卡首句 + 未下载 PDF 的行内「下载」 |

## 事件形状从哪来（只读 β，不合分支）

β 已完成但**没有合进本 lane 的基线**，所以三个文件是只读参考的：

```
$ git show feat/W10-beta:backend/src/server/types.ts
$ git show feat/W10-beta:backend/src/agents/progress.ts
$ git show feat/W10-beta:backend/src/server/sse.ts
$ git show feat/W10-beta:docs/devlog/W10-beta.md
```

前后端不共享编译单元，所以 `frontend/workspace/src/lib/types.ts` 末尾那一段是那份契约
在浏览器侧的**复述**（`StreamProgressEvent` / `PartialEvent` / `PartialPaper` /
`PartialSearchSourcePayload` / `PartialCardPayload` / `DeltaEventData`），字段名逐个对齐过，
没有自己发明的键——同 `settings_api.ts` 顶部那条既有口径。

按 β 的口径落进前端的三件事：

1. **`partial.card.relevance` 在 α 落地前恒为 `null`**。前端显示 `—`，**不显示 0**——
   0 会被读成「判定为不相关」，那是另一件事（门禁 ε-1 ③ 正面钉住，连 `not.toContainText("相关性 0")`
   一起钉）。
2. **`delta.target` / `revision` 是新增字段**，协议只增不改，所以前端声明成**可选**：
   收口之前后端发的老 `delta` 只有 `chunk`，`stream_model.ts` 退回 `summary` / `revision 1`。
3. **`etaMs` 拿不准就没有这个字段**。前端照此：没有字段就不画「约剩」（门禁 ε-1 ① 里
   `toHaveCount(0)` 那条）。

## ε-1 · 三段式进度

新增 `frontend/workspace/src/lib/stream_model.ts`（纯状态推导，一行 DOM 都没有）+
`center.tsx` 的三个小组件（`StageBar` / `StreamLog` / `StreamSections`）。

- **阶段条**六段：规划 → 检索 → 下载 → 精读 → 综述/复核 → 汇总。β 的 `ProgressEvent.stage`
  只有四个粗粒度值（plan / execute / summarize / review），文献流程的子阶段只在 execute 段的
  **人读文案**（`taskNote`）里出现，所以从文案认关键词，**认不出来就保持当前高亮不动**——
  进度条上的假动作比不动更伤信任（同 β 在 etaMs 上的口径）。认不出的那一刻，旁边的
  `stream-message` 仍然如实写着后端说的那句话。
- **每段耗时**用事件自带的 `ts` 算，不用浏览器收到的时刻（SSE 缓冲、页面卡顿、断线重连都会让
  后者偏，这正是 β-1 补 `ts` 的理由）。代价如实说：活动段的秒数**只在有新事件时才跳一下**，
  不是每秒自增。两条不变式钉在门禁里：走过的段耗时**只冻结一次**（不会随后续事件继续涨）、
  **没进过的段显示 `—` 而不是 0ms**。
- **实时日志**：`progress` / `partial` 逐行追加，`<details>` 可折叠；`partial.papers` 的每条
  候选是一个按钮，点开切到文献库。失败源（`outcome: failed`）**照样上屏并带原因**——
  「查了但失败」与「根本没查」在界面上必须分得开（β-2 的原话，U43 的病）。
- **正文区**：`delta` 按 `target` 分区；同一 target 的 `revision` 变了就**清空重画**，
  不许把两稿首尾相接。`summary` 那一路仍然照旧灌进聊天气泡（W3-a 的老行为不变），
  `review` / `card:*` 只进分区。
- **停止**：`AbortController` 传给 `streamChat` 的 `signal`，关的是**这条 fetch 本身**，
  不是把界面静音。abort 之后 reader 抛错，`catch` 里区分「按了停止」与「真出错」，
  只吞前者——两种都吞掉就又是一个「看不出发生了什么」。

## ε-2 · V158 / V159 / V166

- **V158 执行段计数**：`stream-counter` 直接画 β 事件里的 `complete` / `total`，前端不重算
  （V37 那条「同一件事两份手写副本」的纪律）。β 没有提供 `taskStarted`，所以沿用 U49 的
  `taskNote` 那条路——文案里的 `执行中 2/3` 与结构化的 `complete/total` 同源，不会打架。
- **V159 设置项 422 行内显示**：`ApiError` 多留一份 `nextStep`（`message` 里那份是给 toast 的，
  行内要分两行，从一段拼好的字符串里再切回来既脆又蠢）。`panel_kit.tsx` 的 `ItemControl`
  不再走 `withBusy`（它会把错误吞成一个 toast 就完事），改成自己 try/catch + 行内 `role="alert"`。
  **toast 照旧发**——行内是多一处，不是换一处。
- **V166 预算说明**：`BudgetInput` 加 `aria-describedby` + 可见说明「本项目累计已知花费上限」。
  闸本来就是按项目累计判的（`usage/ledger.ts`），CLI 帮助文案 alpha.3 已改，前端这半边一直没改
  （U20）。说明只写在组件里一份，四个调用点共用。

## ε-3 · V168 令牌计数

U34 说「权限面板『有效审批令牌』计数不随签发/消费变化」。查下来**后端那半边已经是实时的**：
`backend/src/server/routes/settings/permissions.ts` 的 `activeTokenCount()` 每次请求都
`readFileSync` 一遍 `approval_tokens.json`。偏差全在前端——`createResource` 只在挂载时取一次，
面板开着的这几分钟里那个数一动不动。**一个不会变的实时数比没有这个数更骗人。**

改法只动前端（没有新端点，γ 这一轮也没动这个面板——`git diff --stat integration/v0.10-base
feat/W10-gamma` 里没有 `settings/permissions.ts`）：4 秒轮询 + 手动「刷新」+ 把「上次重读时刻」
写在旁边，让人看得出这个数有多新。

## ε-4 · 文献列表二期

- **关键词列**：有精读卡就显示 `keyFindings` 首句（`data-source="card"`），没卡退回 `tags`
  （`data-source="tags"`），两样都没有给破折号。**与 γ 协调的结果**：γ 这一轮没有给精读卡加
  `keywords` 字段（`feat/W10-gamma` 的 diff 里没有它），所以**不写一段永远走不到的分支**，
  按任务书的退路走。首句切分绕开小数点（`推到 92.4。` 里那个 ASCII 点是小数点不是句末）——
  第一版就在这上面红了一次，见下面「实跑原文」。
- **PDF 行内下载**：`pdfStatus !== "downloaded"` 时给一个真能按的「下载」，打
  `POST /api/lit/papers/:id/pdf`（路由早就有，与 CLI `lit pdf` 同一个落地点，此前只有 CLI
  走得到——界面告诉你「没有 PDF」，却不给任何把它弄来的手段）。「不可得」是**已知结果不是异常**：
  任务照样 succeeded，照实 notify 原因，不弹错误（照 `routes/literature.ts` 里那条既有注释）。

---

## 门禁（10 条，三个新 e2e 文件）

| 文件 | 条数 | 钉的是 |
|---|---:|---|
| `tests/e2e/stream_ux.spec.ts` | 5 | 阶段条推进 + 每段耗时 + 计数/eta（ε-1 ① 含 V158）；`partial.papers` 10s 内上屏 + 可点开到文献库 + 失败源照实（②）；`relevance: null` → `—`（③）；delta 分区追加与 revision 清空重画（④）；停止真的 abort 了连接（⑤） |
| `tests/e2e/settings_ux.spec.ts` | 3 | 422 的 message + nextStep 落在**那一行**上（V159）；预算说明文案 + `aria-describedby`（V166）；权限面板不刷新页面也会变新 + 手动刷新真打端点（V168） |
| `tests/e2e/papers_ux.spec.ts` | 2 | 关键词三种来源（卡首句 / tags / 破折号）与 `data-source`；「下载」真的打到 `POST /papers/:id/pdf`，落定后那一行变成「打开」 |

**为什么是假 SSE 件**：基线后端根本不发 `partial`，`delta` 也还没有 `target`/`revision`
（那是 β 的活，尚未合入）。所以 `stream_ux.spec.ts` 用 `page.addInitScript` 只接管
`/api/session/stream` **这一个 URL** 的 `fetch`，返回一条由测试逐条推事件的**真
`ReadableStream`**——被测的仍然是真东西：`lib/api.ts` 的 SSE 解析、`stream_model.ts` 的推导、
`center.tsx` 的渲染。其余请求照常走真 fixture server。

**钉「接线」而不只是「内容」**（U40/U47 的教训）：⑤ 读的是**假件真收到的 abort**
（`__sparkFake.aborted`）与「关流之后再推被挡下的次数」，不是界面上那个「已停止」徽标；
ε-4 ② 读的是 `POST` **真的被打了一次**与落定后**重新取数**拿到的状态，不是本地乐观更新；
V168 那条读的是端点**真的被再次请求**（`calls` 计数），不是界面上的时间戳。

### 实跑原文

```
$ npm run typecheck
> tsc --noEmit && tsc --noEmit -p frontend/workspace/tsconfig.json && tsc --noEmit -p tests/e2e/tsconfig.json
（无输出）

$ SPARK_E2E_PORT=4398 npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/stream_ux.spec.ts
  ✓  1 ε-1 ①：阶段条按事件推进，每段显示自己的耗时，没进过的段不补假 0 (1.1s)
  ✓  2 ε-1 ②：partial.papers 到达 10s 内出现论文标题，且每条可点开到文献库 (369ms)
  ✓  3 ε-1 ③：partial.card 的 relevance 为 null 时显示「—」，不显示成 0 (254ms)
  ✓  4 ε-1 ④：delta 按 target 分区逐字追加，revision 变化时清空重画 (241ms)
  ✓  5 ε-1 ⑤：「停止」关掉 SSE 连接本身——之后再推事件，界面一行都不动 (280ms)
  5 passed (5.0s)

$ SPARK_E2E_PORT=4398 npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/settings_ux.spec.ts
  ✓  1 ε-2 V159：设置项被 422 拒时，原因与下一步显示在**那一行**上，不只是一个会飘走的 toast (350ms)
  ✓  2 ε-2 V166：预算输入框旁边写明这是「本项目累计已知花费上限」，不是本次调用上限 (96ms)
  ✓  3 ε-3 V168：权限面板的有效令牌数会自己变新（重读令牌文件），不是挂载时取一次就钉死 (4.6s)
  3 passed (7.4s)

$ SPARK_E2E_PORT=4398 npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/papers_ux.spec.ts
  ✓  1 ε-4 ①：关键词列优先显示精读卡抽出的一句话，没有卡才退回 tags (508ms)
  ✓  2 ε-4 ②：未下载的 PDF 行内「下载」真的打到 POST /papers/:id/pdf，落定后那一行变成「打开」 (358ms)
  2 passed (3.3s)

$ SPARK_E2E_PORT=4398 npx playwright test --config tests/e2e/playwright.config.ts   # 全量（含 workbench.spec.ts 50 条）
  60 passed (35.9s)

$ bun test tests/unit/settings_registry.test.ts
 5 pass / 0 fail / 84 expect() calls
```

**ε-4 ① 第一版红过一次**（不是先写绿再补测试，是测试先把 bug 抓出来）：

```
  ✘  1 ε-4 ①：关键词列优先显示精读卡抽出的一句话，没有卡才退回 tags (15.5s)
    Expected: "端到端网络把 GDT_TS 推到 92.4。"
    Received: "端到端网络把 GDT_TS 推到 92."
```

首句切分用 `(?<=[。．.!?！？;；])` 把 `92.4` 的小数点当成了句末。改成「全角终止符直接算，
ASCII 的 `.`/`!`/`?`/`;` 只在后面是空白或结尾时才算」。

## 阴性对照（7 条，每条实跑变红；**都在对应改动 commit 之后才做**）

| # | 怎么破坏 | 结果（原文节选） |
|---|---|---|
| ① | `stream_model.delta`：revision 变了也照样追加，不清空 | `✘ ε-1 ④` · `Error: expect(locator).not.toContainText(expected) failed` · 1 failed 3 passed |
| ② | `center.tsx`：不把 `controller.signal` 传给 `streamChat` | `✘ ε-1 ⑤` · `expect(locator).toBeVisible() failed / element(s) not found`（stream-stopped 没出现，因为 fetch 压根没被 abort，reader 不抛） · 1 failed 4 passed |
| ③ | `panel_kit.tsx`：文本控件不渲染行内失败条（退回只发 toast） | `✘ ε-2 V159` · `element(s) not found`（`setting-error-uiDensity`） |
| ④ | `ui.tsx`：`BUDGET_HINT` 退回含糊的「预算上限」 | `✘ ε-2 V166` · `Expected: "本项目累计已知花费上限" / Received: "预算上限"` |
| ⑤ | `Permissions.tsx`：去掉 4 秒轮询（退回挂载时取一次） | `✘ ε-3 V168` · `Expected substring: "湿实验 1" / Received: "…湿实验 22…"` |
| ⑥ | `center.tsx`：关键词列退回只看 tags | `✘ ε-4 ①` · `Expected: "端到端网络把 GDT_TS 推到 92.4。" / Received: "入库时打的标签"` |
| ⑦ | `center.tsx`：下载按钮换掉 testid（= 按钮不在那一行上） | `✘ ε-4 ②` · `expect(locator).toBeVisible() failed / element(s) not found` |

③④ 一开始是和别的破坏放在同一轮跑的，结果 ④ 那条被 **serial 模式 skip 掉了**（第一条红之后
后面全 skip），一度误以为它没红。所以把两个新 spec 文件的 `test.describe.configure({ mode: "serial" })`
去掉了——这两个文件里每条用例各自 route 自己的端点、各自开一条假流，本来就互不依赖，而
`workers=1` 保证不会并行跑。**这条如实记下来：阴性对照的可信度取决于「红的那一条之后还跑不跑」。**

---

## 收口 diff

**枢纽文件（`orchestrator.ts` / `server/app.ts` / `routes/session.ts` / `index.ts` /
`llm/router.ts`）本 lane 一行未碰**，也不需要碰：ε 的全部改动都在 `frontend/**`。

要请收口方留意的只有一件事，在 **β 的收口 diff 里已经写着**（`docs/devlog/W10-beta.md`
「收口 diff ①」）：`routes/session.ts` 里老 `delta` 出口补 `target: "summary", revision: 1`。
**前端不依赖它**（`DeltaEventData.target` 声明成可选，缺了就退回 `summary`/`1`），
所以这条不是阻塞项，但补上之后前端那一段兜底代码就永远走不到了，语义更干净。

## 对 β 类型的偏差 / 请求（**没有自己改后端**）

1. **`ProgressEvent` 没有子阶段字段**。文献流程的「检索 / 下载 / 精读 / 综述」目前只能从
   `taskNote` 的**中文文案**里认关键词（`stream_model.ts:stageFromProgress`）。文案一改，
   阶段条就认不出来（认不出 = 保持不动，不会画错，但会不动）。
   **请求**（v0.10 之后，不是这一轮）：`ProgressEvent` 加一个可选的结构化子阶段
   （如 `phase?: "search" | "download" | "read" | "review"`），产生端是 `literature_pipeline.ts`
   已有的那三个 `note` 调用点。在那之前，**改 `taskNote` 文案的人请知道前端在读它**。
2. **`partial.card` 没有 `recordId`**。日志里那张卡点开之后只能跳到文献库，跳不到这张卡本身
   （`ReadingCard.recordId` 在 `/api/lit/cards` 里有，但 partial 事件里没有）。
   不是这一轮的 DONE，登记为跟进项。
3. **`relevance: null` 的口径已按 β 的交代实现**，α 的预筛落地填了真分数之后，前端不用改
   （`toFixed(2)` 那条分支已经在）。

## 如实交代（没做完的 / 拿不准的）

1. **e2e 跑在假 SSE 件上，不是真后端**。基线后端不发这些事件（β 未合入），所以
   「检索完成 ≤ 10s 出现论文标题」这条 DONE，我钉的是**前端从收到 `partial.papers` 到标题上屏
   的时间**（实测 < 10s，且日志里 `Date.now()` 差值也断言了），**不是**浏览器里真的 10 秒——
   真实 10s 取决于检索耗时（lane α）与收口后的 SSE 出口，**R7 复测时才算数**。
   β 在自己的 devlog 里对同一条 DONE 做了同样的交代（它钉在管线层）。
2. **「综述逐字出现」钉的是「按 target 分区、逐块追加、revision 变了清空重画」**，
   不是「每个字之间有几毫秒」。逐字的观感取决于后端 chunk 的粒度，前端这边没有可钉的东西。
3. **阶段条的活动段耗时不是每秒自增**（见上，只在有新事件时跳）。如果收口后发现某一段
   长时间没有事件、界面上那个数看着像卡死了，正解是让产生端多发几条 `taskNote`，
   **不是**让前端拿本地时钟去插值——那会在断线/缓冲时给出一个编的数。
4. **权限面板 4 秒轮询是个朴素做法**。面板开着就一直打那个只读端点（本地 server，代价可忽略），
   但它**不是事件驱动**——终端刚签发的令牌最多 4 秒后才上屏。要做到即时得给这个面板一条 SSE，
   那超出 ε-3 的范围。
5. **`stream_model.ts` 没有单测**，全部覆盖来自 e2e。理由：这三段界面的价值在「事件真的被接到
   了并且画出来了」，纯函数单测钉不住接线（U40/U47 的教训）。代价如实说：一条 e2e 红的时候，
   要多花一步才能分清是推导错了还是渲染错了。
6. **没碰 `workbench.spec.ts` 一行**，但全量跑过一遍确认没打破既有 50 条
   （`BudgetInput` 加了可见说明，`getByLabel("预算 $")` 是子串匹配，⑲ 那条照常绿）。
