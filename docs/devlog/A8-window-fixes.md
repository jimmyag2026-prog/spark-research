# A8 修复窗口 · BLOCKER-1（U28）· HIGH-1（U29）· HIGH-2（U30）· U32 复核不成立

**日期** 2026-09-15 深夜 · **分支** `release/v0.9.0` · 执行：主会话。A8 报告 `A8.md`（零上下文子代理，`a8/report` 已并入）。

## 先复现，再动手

| 条目 | 复现 | 结果 |
|---|---|---|
| **BLOCKER-1 / U28** 非 loopback 来源写凭据 | 读 `A8.md`：验收者的「非 loopback 来源」是**带远端 `Origin` 头、传输层仍是 127.0.0.1** 的请求（本机 LAN 地址连不上 server，`--interface` 路径走不通）；重启 server 读到新 allowlist 后 PUT/DELETE 均 200 | 按 AD-18 ② 的**字面**（只看传输层地址）不成立——R6 的 T5 第 20 步用 `--interface` 验过两次 403；按验收表**判据**成立：被加进 allowlist 的远端页面确实能在用户本机改写/删除凭据。裁定：**修**——凭据写路径对 `Origin` 单独卡回环，不看 allowlist。AD-18 ② 的措辞补一句 |
| **HIGH-1 / U29** 上游失败 SSE 只剩 ping、非流式挂到 255s | 读 `A8.md` 时间线 + 台账：plan 调用 14s 失败落了 `errorKind:upstream`，之后 106s 台账零行 | 成立。根因不是重试（最大退避 4s），是 plan 失败后退 `defaultPlan()` 去跑连接器任务，坏网络下逐个超时——与 U12 的 49.8s 同一个形状 |
| **HIGH-2 / U30** 令牌按全 UUID 绑定、UI/CLI 印短 id | 读 `lab/approval_token.ts consume()`：`t.experimentId === experimentId` 全等 | 成立 |
| **HIGH-3 / U32** 凭据「删除」按钮空操作 | Playwright 按真实用户路径：存假 key → 点行内「删除」→ `getByRole("dialog", {name: /删除 semanticscholar/})` 可见，`elementFromPoint` 落在弹窗自己的「删除」按钮上 → 点击 → 抓到 `DELETE /api/settings/credentials/semanticscholar`，行内删除按钮消失 | **不成立**。验收者的探针等的是浏览器原生 `confirm`（`page.on("dialog")`），产品用的是页内 `Modal`；它没有点弹窗里的第二个「删除」。前端未改 |
| HIGH-4 / U33 doctor 只探 4321 | = V160，已登记 | 不在本窗口 |

## 改动

| 条目 | 改动 | 门禁 | 阴性对照（实跑） |
|---|---|---|---|
| **U28** | `settings/shared.ts`：`loopbackGuard` 同时要求 `Origin` 缺省或回环（`isLoopbackOrigin`），`assumeLoopback` 注入下也卡 Origin；拒绝文案补「页面来源也必须是本机」 | `a8_window` U28 ×2 | `isLoopbackOrigin` 恒真 → **2 红** |
| **U29** | `orchestrator.ts`：`BudgetGateError` 泛化为 `PlanCallFailedError(kind)`，plan 调用**任何**失败即止（`failure.kind = budget \| llm`），只有「答了但不是合法计划」才退 `defaultPlan()` | `a8_window` U29 ×1（<5s 返回、零执行） | 恢复「失败退默认计划」→ **1 红** |
| **U30** | `lab/approval_token.ts` `compute/approval_token.ts`：`consume()` 接受 ≥8 位唯一前缀（`idMatches`） | `a8_window` U30 ×3 | 去掉前缀匹配 → **1 红** |

既有测试改口径：`orchestrator.test.ts` D-4/F-2 五条——原来靠「plan 失败退默认计划」再测 execute/summarize 的失败路径，现改为 plan 成功、后续失败；「plan 失败退 defaultPlan」那条改为钉住新语义。

## 未做（登记）
U31（TTY 门可被 pty 满足，待核实）→ V167 · U34 令牌计数 → V168 · U35 import 文案 → V169 · U37 T5 第 13 步端点漂移 → V170（T5 已冻结，下版修文档）· U36 = V157 · U33 = V160。
