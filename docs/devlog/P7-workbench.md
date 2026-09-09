# P7 前端工作台 · devlog

> 分支 `feat/p7-workbench` · 2026-09-09
> 范围真源：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) 「P7 前端工作台」（2026-09-09 用户修订版）

---

## 〇、一句话

P1-P6 的全部能力补齐了 HTTP API（56 个端点 + SSE + 长任务句柄），v0.1 的 vanilla 三栏换成
SolidJS 工作台（左项目/中会话/右时间线/底实验面板），并用 Playwright 把「建项目 → 文献 →
idea → 干实验 → 湿实验 approve → 时间线」这条线在浏览器里走通。

测试：**bun unit 558 → 645（+87，0 fail）· pytest 48（不变）· Playwright 10/10 · typecheck 干净**。

---

## 一、事故与纪律（先说这个）

### 1.1 工作树在会话中途变得不可读

按任务书在 `~/Desktop/spark-research-p7` 建了 worktree，工作了很久（bun install / bun test /
写了整个 server 层都正常），中途该目录**突然全部 EPERM**：`ls`、`cat`、`git status` 全部
`Operation not permitted`，而 `stat` 正常、权限位正常（`drwxr-xr-x jimmyclaw`）、无 ACL 无
chflags。同时 `~/Desktop/AI4S/**` 一切正常。判断是沙箱策略只放行 `AI4S/` 子树，
`~/Desktop/<其他>` 不在放行列表里。`cp`/`mv`/`osascript do shell script` 都救不出来。

**处理**：worktree 迁到 `~/Desktop/AI4S/spark-research-p7`，按上下文里的内容重写了已完成的
server 层与测试（当时零 commit，git 里没有任何东西可丢，但工作树里的成果全没了）。

**教训（已按主会话新纪律执行）**：

- 阶段性成果**每完成一个逻辑块就 commit + push feature 分支**。这次重做了大约两小时的量，
  纯粹因为「等一个大 commit」。
- worktree 路径要落在**已知可访问的子树**里。`~/Desktop/<repo>-<topic>` 这条约定在本机
  沙箱下不成立，建议改成 `~/Desktop/AI4S/<repo>-<topic>`（与项目同父目录）。

**遗留物**：`~/Desktop/spark-research-p7` 目录还在磁盘上（我删不掉），git 里的 worktree 登记
已经清掉了。请主会话在能访问该路径的环境里 `rm -rf` 一下。

### 1.2 Python 环境

worktree 里 `.venv` 是指向主仓 `.venv` 的**符号链接**（`ln -sfn ~/Desktop/AI4S/spark-research/.venv .venv`）。
`.gitignore` 原来写的是 `.venv/`，只匹配目录，符号链接匹配不上会被当成待提交文件——
已改成 `.venv`（commit `28f7030`）。pytest 用绝对路径调主仓的解释器跑。

---

## 二、第一步：API 层

### 2.1 端点清单

项目作用域：所有域端点默认作用在**当前项目**（与 CLI `manager.defaultProject()` 同口径），
可用 `?project=<slug>` 覆盖。长任务默认返回 `202 + 任务句柄`，body 里带 `"await": true`
（或 `?await=1`）时同步等落定——后者是给 CLI 对照测试与 e2e 的确定性入口，UI 走异步。

| 域 | 方法 端点 | 对应 CLI |
|----|----------|---------|
| 健康/元 | `GET /api/health`、`GET /api/connectors` | — |
| 项目 | `GET /api/projects`（`?all=1`） | `project list` |
| | `POST /api/projects` | `project new` |
| | `GET /api/projects/current` | — |
| | `POST /api/projects/current` | `project open` |
| | `GET /api/projects/:slug` | — |
| | `POST /api/projects/:slug/archive` | `project archive` |
| 文献 | `GET /api/lit/sources` | `lit sources` |
| | `POST /api/lit/search` ⏳ | `lit search [--add]` |
| | `POST /api/lit/papers` ⏳ | `lit add` |
| | `GET /api/lit/papers`（`?tag/status/q`） | `lit list` |
| | `GET /api/lit/papers/:id` | — |
| | `PATCH /api/lit/papers/:id` | — |
| | `POST /api/lit/papers/:id/pdf` ⏳ | `lit pdf` |
| | `GET /api/lit/export?format=bibtex\|csl` | `lit export` |
| | `GET /api/lit/cards` | — |
| | `POST /api/lit/read` ⏳ | `lit read` |
| | `POST /api/lit/review` ⏳ | `lit review` |
| 思路 | `GET /api/ideas`（`?status`） | `idea list` |
| | `POST /api/ideas` ⏳ | `idea new` |
| | `GET /api/ideas/:id` | — |
| | `POST /api/ideas/:id/check` ⏳ | `idea check` |
| 干实验 | `GET /api/experiments/machine` | — |
| | `GET /api/experiments/platforms` | `exp platforms` |
| | `GET /api/experiments`（`?state/platform`） | `exp list` |
| | `POST /api/experiments` | `exp new` |
| | `GET /api/experiments/:id` | `exp status` |
| | `POST /api/experiments/:id/run` ⏳ | `exp run` |
| | `POST /api/experiments/:id/conclude` | `exp run --conclude` |
| 湿实验 | `GET /api/lab/machine` | — |
| | `GET /api/lab/backends` | `lab backends` |
| | `GET /api/lab/devices` | — |
| | `POST /api/lab/protocol`（编译预览，不落库） | — |
| | `GET /api/lab/experiments`（`?state`） | `lab status` |
| | `POST /api/lab/experiments` | `lab compile` |
| | `GET /api/lab/experiments/:id` | `lab status <id>` |
| | `POST /api/lab/experiments/:id/compile` | `lab compile --experiment` |
| | `POST /api/lab/experiments/:id/approve` | `lab approve` |
| | `POST /api/lab/experiments/:id/reject` | `lab reject` |
| | `POST /api/lab/experiments/:id/simulate` ⏳ | `lab simulate` |
| 记录 | `GET /api/records/meta` | — |
| | `GET /api/records`（`?type/evidence/session/since/until/limit/offset`） | — |
| | `GET /api/records/:id` | — |
| | `GET /api/records/:id/graph?depth` | — |
| 产物 | `GET /api/artifacts`（`?session`） | — |
| | `GET /api/artifacts/version/:id` | — |
| | `GET /api/artifacts/version/:id/lineage` | — |
| 会话 | `GET /api/session/modes` | — |
| | `POST /api/session/chat`（`mode: chat\|coexplore`） | `chat` / `idea new` |
| | `POST /api/session/stream` 📡 | — |
| | `GET /api/session/:sessionId` | — |
| 任务 | `GET /api/tasks`、`GET /api/tasks/:id` | — |
| | `GET /api/tasks/:id/stream` 📡 | — |
| 兜底 | `ALL /api/*` → JSON 404 · `GET *` → 静态/SPA | — |

⏳ = 长任务（任务句柄）· 📡 = SSE

v0.1 既有端点（`/api/health`、`/api/chat`、`/api/connectors`、`/api/lab/devices`、
`/api/lab/protocol`、`/api/artifacts/:sessionId`、`/api/lineage/:versionId`）**行为未变**，
`tests/unit/server.test.ts` 原样通过。

### 2.2 几处刻意的口径

**D1 · approve/reject 的 actor 在 HTTP 层必填，且不从环境变量兜底。**
CLI 的 `resolveActor` 在没给 `--actor` 时落到 `$USER`——那是诚实的，**就是**这个人在这台
机器上敲的命令。HTTP 不能这么干：服务进程的 OS 用户与点「批准」的那个人没有任何关系。
所以缺 `actor` 直接 400，且 `actorSource` 记 `http:explicit`，审计时分得出「网页批的」与
「命令行批的」。这条在 `tests/unit/ui_cli_parity.test.ts` 里被写成断言，免得以后被当 bug 改掉。

**D2 · veto 是结果不是异常。** 综述的引用核验与 novelty 的评级校验不通过时，任务仍然
`succeeded`，结果里带 `vetoed` / `conclusive` 标记，草稿/报告照常返回。理由：用户要看见
草稿才改得动它。反过来，**精读卡全失败**是任务 `failed`——「成功 0 张」不该是绿色的。

**D3 · 伪造引用有两道防线，API 不提供任何绕过开关。** 库外 key 在 `ReviewDraftGenerator`
的白名单那层就被拒（重试一次仍越界则拒稿，任务 failed 并点名越界 key），根本产不出草稿；
`citation-integrity` 是第二道，抓的是「key 真实但结论与精读卡冲突」（soft，不否决）。
`allowUnknownKeys` 这类参数刻意不暴露到 HTTP——「让我引一条库外文献」不该是一个 API 参数。

**D4 · 错误状态码不糊弄。** 安全门拦截 → 422 + 拦截清单（不是 500，被拦的实验留在列表里
标 `failed`，审计留痕）；非法状态转移 → 409；未 approve 就执行 → 403；模型两次都产不出
合契约的 Idea 卡 → 422（服务端没坏，是这次生成不可用）；非法 JSON body → 400。

**D5 · SSE 上跑的是生命周期事件，不是 token 流。** orchestrator 目前不是流式的（模型调用
一次性返回），所以 `/api/session/stream` 发的是 `start → progress → result → done`。
把已经拿到的完整正文切成假 token 往外吐是自欺，不做。传输层已经就位，将来 agent 支持
增量输出时往 `delta` 事件里塞即可，前端连接方式不变。

**D6 · 未命中的 `/api/*` 一律 JSON 404**，不掉进 SPA 兜底——否则前端会把一页 HTML 当 JSON 解析。
对称地，静态层带扩展名却找不到的资源也返回 404（兜底成 HTML 会让 `<script src>` 静默拿到 HTML）。

**D7 · 分页谓词单一真源。** `RecordStore` 把过滤条件抽成 `whereClause()`，`list()` 与
`count()` 共用。否则「这一页」与「总数」用两套口径，表现出来就是翻页时总数变来变去。
新增 `since/until/offset`（SQLite 的 `OFFSET` 必须跟 `LIMIT`，只给 offset 时用 `LIMIT -1`）。

### 2.3 改动文件概览（后端）

```
backend/src/server/
  app.ts              重写：挂载域路由 + 统一错误出口 + 静态/SPA 兜底（v0.1 端点原样保留）
  context.ts   新增   依赖容器 + ProjectScope（必须 dispose，否则 sqlite 句柄泄漏）
  tasks.ts     新增   长任务注册表（句柄/进度/只增事件日志/失败是一等结果）
  sse.ts       新增   零依赖 SSE（ReadableStream + text/event-stream）
  types.ts            扩展 API 形状
  routes/      新增   projects / literature / ideation / experiments / lab / records / session / shared
backend/src/project/
  models.ts           RecordFilter += since / until / offset
  records.ts          whereClause() 抽取；count(filter)
backend/src/index.ts  server 命令在 dist 缺失时给出构建指引
```

---

## 三、第二步：SolidJS 工作台

### 3.1 结构

```
frontend/workspace/
  index.html            首屏内联脚本先定主题（避免刷新闪白）
  vite.config.ts        root=此目录，产物 → dist，dev 时 /api 代到 4321
  tsconfig.json         前端独立一份（DOM lib + solid jsx）
  src/
    main.tsx            挂载
    app.tsx             外壳：header + 四栏 + toast + 1-5 快捷键
    state.tsx           WorkspaceProvider：域资源（createResource）、消息流、toast、忙态
    styles.css          明暗 token + grid 布局 + 全部组件样式（约 700 行）
    lib/
      types.ts          手写 API 形状（不从后端 import，见 D8）
      api.ts            类型化客户端 + runTask（SSE 订阅，断流退化轮询）+ streamChat
      markdown.ts       自写 Markdown 子集 + 引用两色高亮
    components/
      ui.tsx            Spinner / EmptyState / ErrorBox / Async 三态 / Badge / Modal / Markdown / LineChart / KeyValues
      left.tsx          项目切换器 + 导航树 + 新建项目弹窗
      center.tsx        会话流（chat/coexplore，SSE）+ 文献库 / 精读卡 / 思路库 / 产物视图
      cards.tsx         精读卡 / 综述 / novelty 报告 / Idea 卡 的富渲染
      right.tsx         record 时间线（类型 × 时间窗过滤）+ record 详情 + 证据子图
      bottom.tsx        干湿实验面板：状态机可视化 + approve/reject 弹窗 + run log
```

产物 **83 KB JS / 12 KB CSS**（gzip 27 KB / 3 KB），零运行时第三方库。

### 3.2 几处刻意的取舍

**D8 · 前端不 import 后端类型。** 两边 tsconfig 不同（一个有 DOM 一个有 bun types），
跨目录 import 会把 bun 类型拖进浏览器构建。字段对不上会在 e2e 里立刻暴露，这个代价可以接受。

**D9 · 状态机节点全部来自 API**（`/api/experiments/machine`、`/api/lab/machine`），
前端不抄一份状态表。P6 改过一次转移表；硬编码的话改完 UI 会悄悄不对。主干路径由转移表
推导（从无入边的状态出发），`failed/rejected/iterated` 作为「旁支」单列。

**D10 · 停留态要一眼认出来。** `awaiting_approval` 在图上是**橙色 + ⏸ + 缓慢脉动**，
与「进行中」（蓝）明确区分——它不是在跑，是**在等人**。同时：面板标题上有「N 个待审批」
徽章，未 approve 时「执行」按钮 disabled 并给出 title 说明。真正的门在 API 层（403），
UI 这层只负责不误导。

**D11 · approve 弹窗把「批的是哪一版」摆在批准人面前**：协议 hash、这一版的步骤表
（含 `[spark-note]` 手工步骤标记）、安全门四条结论，全部列出来再让人签名。署名存
localStorage 只是省打字，每次仍要确认——审批不能变成一路回车。焦点陷阱 + Esc 关闭，
键盘可以走完全流程。

**D12 · Markdown 自己写。** 正文来自 LLM，必须**先整体转义再套白名单标记**。引一个通用
Markdown 库就得连带处理它默认开启的 HTML 透传，那才是真正的风险面。链接刻意不解析成
`<a>`——不给「点开一个模型编出来的地址」这条路。行内代码占位符用 `<<N>>`（转义后正文里
不可能有 `<`），不用「空格+数字+空格」，否则「第 3 段」会被误当占位符。

**D13 · 引用两色渲染。** 能回链到库内 bibtex key 的是蓝色 `.cite`，库外的是红底波浪线
`.cite-unknown`。这是把 P3/P4 的引用核验结论直接画进正文。白名单缺失时**不下判断**
（不知道就不说，不把中性情况染红）。

**D14 · novelty 报告同时显示模型原判与校正后评级**（AD-8），不能只留好看的那个。

**D15 · 状态只有一份。** 所有列表都是 `createResource(slug, …)`，动作跑完 `refetch`，
不做乐观更新。「界面显示的和 record 里存的不一样」正是这个产品最不能出的错。
切项目时以 slug 为 source 自动级联重取。

**D16 · 科学渲染以轻量为限**：SVG 折线图（从摘要里形如 `energy_0/energy_1` 的序列画能量
曲线）、run log 步骤列表、**确定性环形布局**的证据子图。力导向布局每次打开长得不一样、
截图对不上，不用。分子/结构 3D 按计划排 v0.3。

**D17 · 可达性**：`:focus-visible` 焦点态、弹窗焦点陷阱、`aria-current/aria-pressed/aria-selected`、
`role="alert"` 的错误框、`aria-live` 的会话流、SVG 带 `role="img"` + 描述性 `aria-label`、
`prefers-reduced-motion` 关掉脉动、1-5 快捷键切视图（输入框内不拦截）。

---

## 四、与 OpenScience workspace 的对照

只读源码研究（Apache 2.0），**没有复制任何一行**。

### 学到并采用的

| 点 | 他们的做法 | 我们的做法 |
|----|-----------|-----------|
| 技术栈 | SolidJS + Vite + `vite-plugin-solid` | 同 |
| 主题 | CSS 自定义属性 token 层 + ThemeProvider | 同思路，token 直接写在 `styles.css` 的 `:root` / `[data-theme=dark]` |
| 首屏主题 | 提前定 theme 避免闪白 | 同（index.html 内联脚本） |
| 面板化布局 | 多面板 + 可调分栏（`PaneResizer`） | grid 四区，窄屏重排；**没做**可拖拽分栏 |
| 组件组织 | 按领域分目录（atlas/components/context） | 按**面板位置**分（left/center/right/bottom）+ 一个 ui.tsx |
| 会话流 | 消息部件化渲染 | 同思路，但消息类型少得多（user/agent/error） |

### 刻意不跟的

| 点 | 他们 | 我们 · 理由 |
|----|------|-----------|
| 依赖规模 | Tailwind + Kobalte + molstar + codemirror + pdfjs + igv + katex + shiki + zod… | 只有 solid-js + vite + vite-plugin-solid。组件数量还撑不起一套工具类体系与组件库；分子/结构渲染排 v0.3 |
| 路由 | `@solidjs/router` 多页 | 单页 + 面板内视图切换。工作台的心智是「一个项目的一块工作台」，不是多页应用 |
| i18n | `@solid-primitives/i18n` | 暂无（界面中文）。v0.2 用户是自己 |
| 3D/富媒体 | molstar / igv / pdfjs | 排 v0.3（P7 范围写明「科学渲染以轻量为限」） |
| 状态 | 多 Provider 分层（sync/permission/layout/settings/…） | 一个 WorkspaceProvider。分层收益要等状态真的复杂起来 |

### 我们有而他们没有的

- **证据成色贯穿 UI**：每条 record 都显示 `evidence`（observed/sourced/computed/inferred），
  引用分库内/库外两色，novelty 报告并列模型原判与校正后评级。这是 §3.2「全流程 Research
  Record」差异化主张在界面上的落点。
- **approve gate 的可视化**：停留态、待审批计数、具名审批弹窗、decision record 一键跳转。
  两个参照系都没有干湿闭环，自然也没有这个。

---

## 五、验证

### 5.1 测试数字

| 层 | 基线 | 现在 | 说明 |
|----|-----|------|------|
| `bun test tests/unit/` | 558 pass | **645 pass / 0 fail**（2908 expects，41 文件） | +87 |
| `pytest tests/` | 48 | **48 passed** | 不变 |
| `bun run typecheck` | 干净 | **干净**（backend + frontend 两份 tsconfig） | — |
| Playwright | — | **10 passed（4.9s）** | 新增 |

新增测试文件：

```
tests/unit/server_projects.test.ts      8   项目端点
tests/unit/server_records.test.ts       9   时间线 / 证据子图 / 产物
tests/unit/server_literature.test.ts   18   文献域（fixture 回放 + fake LLM）
tests/unit/server_ideation.test.ts      8   co-explore / novelty
tests/unit/server_experiments.test.ts  10   干实验（真 pyref）
tests/unit/server_lab.test.ts          15   湿实验 + approve gate
tests/unit/server_session.test.ts      13   chat / SSE / 任务
tests/unit/ui_cli_parity.test.ts        3   UI ↔ CLI 行为对照
tests/unit/frontend.test.ts             6   静态托管（重写）
tests/unit/project.test.ts             +3   RecordStore 时间线过滤
tests/e2e/workbench.spec.ts            10   浏览器全流程
```

### 5.2 Playwright e2e

`bun run test:e2e`（`tests/e2e/playwright.config.ts`）。webServer 先 `bun run build:web`
再起 `tests/e2e/fixture_server.ts`——**被测的就是生产那个 app**，只把三处外部依赖换掉：

- 文献检索 → P2/P4 真实录制的 cassette 回放
- LLM → 按 prompt 分派的 `ScriptedLlm`（不打任何模型 API）
- 湿实验后端 → `MockDeviceBackend`（不需要装 opentrons）
- 干实验 → **真的 pyref**（零依赖、秒级），这段是真跑不是打桩

每次跑用一个全新的 `mkdtemp` 工作区，绝不碰 `~/.spark-research`。`workers=1`、`retries=0`：
十条用例共享一条链路，重试只会掩盖真实的时序问题。

```
✓ ① 工作台加载并建项目                                    385ms
✓ ② 检索入库 → 文献库有条目，时间线出现 paper record        327ms
✓ ③ 生成精读卡 → 综述，引用渲染成库内引用（不标红）          319ms
✓ ④ co-explore 产出 Idea 卡（含反面证据）                  275ms
✓ ⑤ novelty check → checked-overlap 且列出最近邻           221ms
✓ ⑥ 干实验（真 pyref）跑完闭环，产出 computed observation   619ms
✓ ⑦ 湿实验编译停在 awaiting_approval，未批准不能执行        288ms
✓ ⑧ approve 弹窗必须填 actor；批准后落 decision record      403ms
✓ ⑨ 执行湿实验 → observed observation + 证据子图连得上       368ms
✓ ⑩ 时间线呈现完整研究线索，且明暗主题都能用                235ms
10 passed (4.9s)
```

**跑之前需要一次** `bunx playwright install chromium`（本机 cache 里原有 chromium-1208/1217，
Playwright 1.63 要 1243，已下载）。

### 5.3 UI ↔ CLI 行为对照

`tests/unit/ui_cli_parity.test.ts`，三个各域最有状态的操作：湿实验
`compile → approve → simulate`、干实验 `new → run`、文献 `search --add`。

比对的是证据图的**形状**（record 类型 / evidence / origin kind / kind / state / 边的类型与
两端类型），不比文案——两边文案本来就该不同（一个打给终端一个回 JSON），拿文案对照只会
得到一堆假警报。

两处「**应该**不同」的地方也写成了断言，免得以后被当 bug 改掉：

1. `actorSource`：CLI = `explicit`，HTTP = `http:explicit`（D1）
2. `protocolHash`：P6 把 `protocolId` 固定成 `wet-<record id>`，record id 是随机 UUID，
   所以两条不同实验的 hash 必然不同。能对照的是「批的 hash 就是它自己实验当前的 hash」
   ——这才是 approve gate 的实质。

---

## 六、与设计的偏差

| # | 偏差 | 理由 |
|---|------|------|
| 1 | SSE 是**生命周期事件**而非 token 流 | agent 层还不是流式的（见 D5）。P7 范围写的是「SSE 流式返回」，传输层做到了，增量内容等 agent 支持 |
| 2 | 时间线过滤在**前端**做（端点已支持服务端过滤） | 一次取本项目最近 200 条，交互零延迟。数据量再大就把 `type/since` 透给端点，端点已经支持且有单测 |
| 3 | 未做可拖拽分栏 | 四栏尺寸固定 + 窄屏重排已经够用；拖拽要引入布局持久化，收益不足 |
| 4 | `/api/artifacts/:sessionId`（v0.1）与新的 `/api/artifacts/version/:id` 并存 | 保留旧端点是为了不动 `server.test.ts` 的既有断言；注册顺序上 `version/` 段先匹配 |
| 5 | 前端类型手写而非从后端导出 | 见 D8 |
| 6 | 无「新建项目」以外的项目编辑（改名/改描述） | CLI 也没有，不在 UI 里发明 CLI 没有的能力（AD-7：CLI/API 是能力真源） |

**不算偏差但值得记**：`RecordStore.count()` 从无参改成可选 filter，无参语义与 P1 完全一致，
既有调用点全部不受影响。

---

## 七、对 P9 的顺手准备（未实现 P9 范围）

主会话提示 P9 已定档「capabilities --json + MCP server + llms.txt」。P7 里有两处天然对它友好：

- **路由按域分模块**（`routes/*.ts` 各导出一个 `Hono` 子应用），要枚举能力清单时可以在
  `createApp` 里集中登记，不需要翻散落的 `app.get`。
- **状态机已经是机器可读的端点**（`/api/experiments/machine`、`/api/lab/machine`，含
  `awaiting` 与 `approvalGate`），MCP 侧要描述「这个工具什么时候能调」直接引用即可。

刻意**没有**提前实现任何 P9 的东西。

---

## 八、给主会话的审查重点

1. **`actorSource = "http:explicit"` 这个口径**（`routes/lab.ts` 的 `requireActor`）。
   HTTP 层拒绝 env 兜底是我的判断——服务进程的 OS 用户不是审批人。如果将来要做多用户，
   这里应该换成真实身份而不是请求体里的自称字符串。现在的写法在单用户本地场景是诚实的，
   但**它确实是「谁自称就是谁」**，值得过目确认这个边界可接受。
2. **长任务的生命周期与进程边界**（`server/tasks.ts` + 各路由的 `run` 闭包）。任务在
   HTTP 响应返回之后继续跑，自己持有 project handle 并在 finally 里 dispose。进程重启后
   任务句柄丢失（磁盘上的实验状态还在，`exp run --resume` 能接回来，但**任务列表**是内存的）。
   这个取舍对不对，以及要不要把任务也落盘，值得定个调。
3. **Markdown 自写渲染器**（`frontend/.../lib/markdown.ts`）。它是唯一往 `innerHTML` 写东西
   的地方，输入是 LLM 正文。转义 → 白名单的顺序我认为是对的，但这是安全边界，值得第二双眼。

---

## 九、提交

```
28f7030 chore: .gitignore 匹配 .venv 符号链接
e9e173e feat(records): RecordStore 时间线过滤 — since/until/offset + count(filter)
8511fc1 feat(server): P7 API 层 — P1-P6 全部能力上 HTTP + 长任务句柄 + SSE
13a109e test(server): P7 API 端点单测（7 个文件，覆盖全部新端点）
8a1be7a feat(frontend): 移除 v0.1 vanilla 工作台，建 SolidJS + Vite 工程骨架
d1893a3 feat(frontend): SolidJS 工作台 — 四栏布局 + 干湿状态机面板 + 证据时间线
a0adda4 test(e2e): Playwright 浏览器全流程 + UI↔CLI 行为对照
```

分支已推到 `origin/feat/p7-workbench`，未建 PR（按纪律等主会话审查）。
