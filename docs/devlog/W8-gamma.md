# W8-1 γ · 体验（V88 · V89 · V90 · V79）

**日期** 2026-09-12 · **分支** `lane/W8-1-gamma` · **worktree** `~/Desktop/AI4S/spark-research-gamma`

## V88 · 精读任务进度不实时

**根因**：CLI 侧（`literature/cli.ts`，α 的地盘）早就把 `ReadingCardGenerator.generateMany()`
的逐篇 `onProgress` 回调接到了 `handle.progress()`（V35 已经做完）；但 HTTP 路由
`server/routes/literature.ts` 的 `POST /api/lit/read` 只在批量开始/结束各调了一次
`task.progress()`，从没把 `generateMany()` 早就支持的 `onProgress` 接上——是 HTTP 面自己
的漏接，不是 CLI 的问题，不需要动 `literature/cli.ts`（没有产生任何禁止文件 diff）。

**改动**：`backend/src/server/routes/literature.ts` `/read` 路由，`generateMany()` 调用加
```ts
onProgress: ({ done, total, ok, title, paperId }) =>
  task.progress(done, total, `${ok ? "✅" : "❌"} ${title ?? paperId}`),
```
与 CLI 同一条数据源（同一个 `generateMany`），同一套 `TaskRegistry` 事件。

**测试**：
- `tests/unit/w8_gamma_read_progress.test.ts`：`POST /api/lit/read {all:true}`（3 篇 fake 卡）
  → 结算后的任务事件日志（`task.events`，只增日志）里能看到 `done=1/2/3`，不是只有 0 与 3。
- e2e ⑰：新建项目、种 3 篇论文、点「全部生成精读卡」，任务面板（2s 轮询）累积采样到
  `1/3` 与 `2/3` 两个中间态。为了让 3 篇（ScriptedLlm 本身同步分派、原本 <10ms 跑完）
  跨过面板 2000ms 的轮询间隔，`tests/e2e/fixture_server.ts` 给带 `READING_PROGRESS_MARKER`
  项目描述的调用包了一层 2600ms 延迟（只影响这一条新用例，其余用例走原来的同步路径）。

**阴性对照**（真跑）：把 `generateMany()` 调用改回不传 `onProgress` → 单测断言 `done` 序列
从 `[0,1,2,3]` 变成 `[0,3]`，`toContain(1)` 红；恢复后绿。

## V89 · co-explore 单次消息偶尔存出两张雷同 Idea 卡

**判断**：读遍 `ideation/coexplore.ts` 后确认，当前代码**没有**任何「一次生成故意产两张卡
（主/备假设）」的机制——`turn()` 每次调用只产一张卡，`explore()`/HTTP `POST /api/ideas`
每次请求也只 `save()` 一次。所以这是**重复记录**，不是设计意图。没有加
`role: primary|alternate` 这类新 UI 语义——那需要改 `ideation/models.ts`/`store.ts`（两者
都不在本 lane 足迹内），而且没有证据支持这个语义真的存在过。

**改动**：`CoExploreSession.save()` 加一段范围收窄的去重——只在**同一个 `sessionId`
内**，把 `hypothesis` 归一化（大小写、全/半角空白、常见中英文标点抹掉）后与该会话已存的
idea 卡比对，完全相同就把已有那条还回去，不新建。**刻意不比对跨会话/无 sessionId 的情况**：
- 跨会话（两个不同 sessionId）撞到同一个假设，是两次真实发生过的交互，不该被合并；
- 不给 `sessionId`（CLI 非交互单次调用、多数既有单测）时完全不比对，维持老行为。

这条边界是被现有测试逼出来的：`tests/unit/ideation.test.ts`「按 id 前缀取卡；前缀歧义时
报错」那条测试故意用同一个 FakeLlm 响应（同一个 hypothesis）循环调用 `explore()` 最多 17
次，就是要制造很多条内容雷同的 idea 记录去触发 id 前缀碰撞——这些调用都不带 `sessionId`。
如果去重按"整个项目内 hypothesis 相同"来判，这条测试会从"17 次里必出一次前缀碰撞"直接
坏成"第 2 次调用起全部被去重成同一条"，17 次循环永远凑不出碰撞——**这不是我发明的场景，
是先跑了一遍既有套件才发现的真实冲突**，据此把去重范围收窄到"同会话"。

**测试**：`tests/unit/w8_gamma_coexplore_dedupe.test.ts` 5 条——① 同 sessionId 重复提交只落
一条；②不同 sessionId 各留一条；③同 sessionId 但 hypothesis 不同不误伤；④不给 sessionId
完全不去重（对齐既有单测的默认形态）；⑤ `normalizeHypothesis` 归一化本身的等价性。

**阴性对照**（真跑）：把 `save()` 里 `if (options.sessionId)` 改成 `if (false && options.sessionId)`
→ 5 条里唯一验证去重生效的那条从绿变红（`recordId` 不再相等），其余 4 条不受影响；恢复后
5/5 绿。另外把既有 `tests/unit/ideation.test.ts` 等 55 个既有 ideation 相关单测整套重跑，
确认这条改动没有让任何一条既有测试变色（55 pass，见下方六套件数字）。

## V90 · 项目下拉框只显示名称，不显示 slug

**改动**：`frontend/workspace/src/components/left.tsx` 项目 `<option>` 文案从
`{item.name}` 改成 `{item.name} ({item.slug})`。纯展示层改动，没有新增路由/API。

**测试**：e2e ⑱ 断言 `#project-select option[value="e2e-lab"]` 的文本包含 `(e2e-lab)`。

**阴性对照**（真跑）：改回只显示 `{item.name}` → e2e ⑱ 红（`toContain` 失败）；恢复后绿。

## V79①·②·③ 三条低危

### ① 综述引用 span 点击跳转证据图

`markdown.ts` 只给**库内可回链**的引用打 `data-key="<key>"`（库外引用没有 record 可跳，
不该假装可点）；`ui.tsx` 的 `Markdown` 组件用事件委托（`closest("[data-key]")`）把点击接到
新增的 `onCiteClick` prop（`innerHTML` 注入的节点不是 Solid 管的 JSX，没法逐个挂
`onClick`）；`state.tsx` 新增 `recordIdForKey(key)`（从已经在拉的 `papers()` 资源里查
`bibtexKey → recordId`，`recordId` 字段后端本来就在 `/api/lit/papers` 里透传，前端类型
`types.ts` 之前没声明——这一半严格说是"接线"不是"新增接口"）；`cards.tsx` 四处 Markdown
渲染点（精读卡关系段、综述草稿、novelty 报告、Idea 卡讨论正文）都接上
`onCiteClick={(key) => jumpToCite(ws, key)}`，`jumpToCite` 只是 `ws.selectRecord(id)`——
与 `bottom.tsx` 里"跳去看审批产出的 record"同一个既有模式，不是新发明的交互。

**测试**：`tests/unit/w8_gamma_markdown_cite_link.test.ts` 3 条（库内带 `data-key`／库外
不带且标红／没给白名单时的边界行为）。`onCiteClick` 那一半是 DOM 事件委托，不方便在
bun:test 的无浏览器环境里断言，如实记在这里、留给人工核对渲染结果——没有为了凑测试去装
一个 jsdom。

**阴性对照**（真跑）：`markdown.ts` 去掉 `data-key` 输出 → 单测 3 条里 2 条红（库内、
边界两条断言 `data-key` 存在的）；恢复后 3/3 绿。

### ② conclusion review 面板无实验时的前置提示

原有空态文案「还没有结论卡 / 干实验 conclude 或湿实验 conclude 后会生成」已经说了怎么办，
但没有直接点出「这是一个前置条件」这句话本身（外部验收 A5 记的原话是「没写在 UI 里」）。
改成标题直接说「先跑一个实验」，hint 里说明这是 review 面板本身的要求。纯文案改动。

**测试**：e2e ⑳，新建项目（没有任何实验/结论）→ 结论面板断言含「先跑一个实验」与
「conclude」。

**阴性对照**（真跑）：改回旧文案 → e2e ⑳ 红；恢复后绿。

### ③ 花钱操作 UI 预算入口

`context.ts` 的 `llmFor()` 加第四个可选参数 `{budgetUsd?, allowUnpriced?}`，原样递给
`usageTrackingLlm`（闸的判定逻辑在 `usage/ledger.ts`，不属于本 lane，没有改判定，只补了
调用方能不能把这两个字段递进去）。`routes/shared.ts` 加 `optionalBool`（镜像既有的
`optionalNumber`）。四个花钱端点——`lit/read`、`lit/review`、`ideas`（coexplore）、
`ideas/:id/check`（novelty）——从 body 解析 `budgetUsd`/`allowUnpriced` 传给
`ctx.llmFor(...)`，路由层只做了参数透传，没有加任何预算判断逻辑。

前端：`ui.tsx` 新增 `BudgetInput`/`parseBudgetInput` 共用件；`center.tsx` 的
`PapersView`（精读）、`CardsView`（综述）、`IdeasView`（novelty check）各挂一个「预算 $」
输入，接到对应的 `api.lit.read`/`api.lit.review`/`api.ideas.check` 调用；`api.ts` 三处
函数签名相应加 `budgetUsd?`/`allowUnpriced?`。

**偏差如实交代**：任务书写的是「精读/综述/idea/novelty」四类，`idea`（co-explore）在生产
UI 里实际走的是会话/chat 面板（`SessionStream` → `/api/session/stream` →
`OrchestratorAgent.chat()`/`coexplore()`），那条链路的 LLM 调用走 agent 自己的
`llmFor`（`agents/orchestrator.ts`），**不经过** `context.ts` 的 `llmFor`——`orchestrator.ts`
不在本 lane 允许改的文件里（足迹表明确写了"`agents/orchestrator.ts`（subAgentLlm）"归
β）。`ideation.ts` 的 `POST /api/ideas`（非聊天式 coexplore）路由本身已经接上
budgetUsd/allowUnpriced 透传（`api.ts` 里的 `ideas.coexplore` 客户端函数也同步加了这两个
字段），但目前没有生产 UI 会调用这个端点（`api.ideas.coexplore` 是已存在的、此前就没被
引用的客户端方法，不是我新增的死代码）——**没有**在聊天式 co-explore 的输入框上加预算
UI，因为那条路径的闸本身够不到（加了也是摆设，等于自称做到了没做到的能力，违反
AD-12）。实现的是「精读/综述/novelty」三处真实可达的 UI 入口 + `idea`（非聊天式）路由层
透传，收口如果要把预算做到聊天式 co-explore，需要先给 `agents/orchestrator.ts` 的
`llmFor` 补 budgetUsd 参数，那部分改动的 ≤10 行 diff 建议交给收口去做（本 lane 没有替
β/δ 改 `orchestrator.ts` 一行）。

**测试**：
- `tests/unit/w8_gamma_budget_passthrough.test.ts` 3 条：直接构造 `ServerContext`，
  `llmFor(project, cmd, null, {budgetUsd:0.0001})` → `kind:"budget"` 且消息含「下一步」；
  不传第四参（老调用形态）→ 照常放行；`allowUnpriced` 两种取值对无单价模型的放行/拒绝。
- e2e ⑲：新项目 + 1 篇论文，UI 填「预算 $」= `0.0001`，点「全部生成精读卡」，任务面板
  最终 `failed`，错误框文本含「预算闸」与「下一步」。

**阴性对照**（真跑）：
- `context.ts` 里 `budgetUsd: options.budgetUsd` 改成 `budgetUsd: undefined`（同时
  `allowUnpriced` 也改 undefined）→ 单测 3 条里 2 条红（gate 没触发/allowUnpriced 不生效）；
  恢复后 3/3 绿。
- e2e：还原同一处改动后单独跑 ⑲，红（面板显示 `succeeded` 不是 `failed`）；恢复后绿。

## 六套件数字（本 lane 独立复跑，本 worktree）

见最终报告正文——这里只记阴性对照涉及的局部重跑数字，全量六套件数字与 rc 以最终报告
为准，避免这里和报告对不上口径。

## 没做 / 交给收口的

- `idea`（聊天式 co-explore）预算入口：见上面 V79③ 的「偏差如实交代」，需要先动
  `agents/orchestrator.ts`（不在本 lane 足迹内）。
- V79①的 `onCiteClick` 事件委托那一半只有 e2e/人工验证覆盖，没有专门的 DOM 单测（bun:test
  没有浏览器环境，装 jsdom 超出本 lane 范围）。

## 收口补记（主会话，2026-09-12）
- 与 ζ（#94）在 `routes/ideation.ts` 的 `embedAccounting` 接线合并无冲突，已核对仍在。
- V79③ 残余：聊天式 co-explore 走 `agents/orchestrator.ts` 自己的 `llmFor`，UI 预算入口只覆盖精读/综述/novelty 三处；orchestrator 加 budgetUsd 参数登记 BACKLOG（W8-1 收口）。
- 主会话复跑：typecheck 0 · unit 2370/0 · concurrency+timeout 35/0 · e2e 24 passed rc=0。
