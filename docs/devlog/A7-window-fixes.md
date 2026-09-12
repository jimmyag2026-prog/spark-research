# A7 验收窗口 · V125–V131

**日期** 2026-09-12 · **分支** `fix/A7-window-budget-model-help` · 执行：主会话
**基线** v0.8.0-alpha.3 · **来源** A7 第六次零上下文验收（52/100，2 Blocker / 3 High）

A7 的每条 Blocker/High **逐条独立复现后才动手**——四条证实、一条证伪。

## 证实并修复

### V125 · 并发预算闸可被跨请求绕过（Blocker-1）
A7 实测：`a7-concurrency` 项目，10 线程并发 `lit_post_lit_read`，每次 `budgetUsd=0.03`（单篇估价 ~$0.014）
→ 10 个全部放行，实花 **$0.0807**（2.7×）。

主会话复核机制：`ctx.llmFor()` **每次调用都新建** `usageTrackingLlm` → 新建 `BudgetLedger`。
V93 的在飞预留是**每 ledger** 的，只封住「一个 ledger 内 `Promise.all`」（CLI 形状）；HTTP 面 N 个请求
各有各的 ledger，彼此看不见在飞额，而闸的另一半（实时重读 usage.jsonl）只看得到**已结算**花费——
并发请求在任何一笔结算之前就全部过闸了。

修：在飞额按 `usage.jsonl` 路径聚合到**进程级**注册表 `SHARED_IN_FLIGHT`，闸取
`max(本 ledger 在飞, 同项目共享在飞)`；预留时加、结算/释放时减。
**残余（如实记）**：跨进程的在飞预留仍不共享（两个 CLI 进程同时起跑），那一段只能靠实时重读
已结算花费兜底，越界上界是「每进程一次调用的估价」。

### V126 · HTTP 请求体的 `model` 被静默忽略（Blocker-2）
`routes/literature.ts` / `ideation.ts` 一律 `ctx.model()`，从不读 `body.model`；且
`configuredDefaultModel()` 不带 root，读的不是本 server 的 `deps.root`。
修：`ctx.model(override?)`，优先级 **body > deps.model > 本 server root 的 config**。

### V127 · V21 的「启动即报错」承诺在 doctor 上不成立（High-3）
`resolveSetting` 只在设置被读到时才抛；`doctor` 不碰超时设置 → 旧名下静默 exit 0，
与我自己写进 `docs/INSTALL.md` 的承诺矛盾。**这是文档承诺没兑现，不是文档写错**，所以修行为不修文档。
修：`legacyEnvViolations()` 在 `main()` 启动期扫描全部已移除旧名，命中即 exit 1。
实测 `SPARK_HTTP_TIMEOUT_MS=1000 doctor` → rc=1 并打出新旧名对照；干净环境 → rc=0。

### V128 · 子命令级 `--help` 会真的执行有副作用的命令（Medium，但造成了真实副作用）
`data export --help` 直接跑真实导出（A7 因此对无关项目 r5-t2 产生一次真实导出，其已清理）；
`auth --help` 直接进交互录入。V39 当年给 lit 做了子命令级 help，`data`/`auth` 漏了。
修：两处在执行前先拦 `--help/-h`。实测 `data export --help` 产生 **0 个 manifest**。

## 证伪

### V129 · A7 High-1「`/api/tasks/:id` 返回非法 JSON」→ **不成立**
`JSON.stringify` 对换行/制表符正常转义（实测无未转义控制字符、可重新解析）；
再起真 server 建一条含换行与制表符正文的 record，`GET /api/records` 经 Python `json.load`
**严格解析通过**且正文往返完整。A7 的 jq 报错是其取样/管道方式所致。登记 V129 防止再次登记。

## 阴性对照（全部实跑）
| 门禁 | 改法 | 结果 |
|---|---|---|
| V125 | 闸只看本 ledger 的 inFlight（不看共享注册表） | 2 pass / 1 fail（10 并发全放行）；还原 3/3 绿 |
| V126 | `ctx.model()` 忽略 override 参数 | **0 pass / 2 fail**；还原 2/2 绿 |
| V127 | 去掉 `main()` 里的启动期扫描 | `doctor` 回到 rc=0 静默放过（正是 A7 报的症状）；还原 rc=1 |
| V128 | —（用产物核实：`data export --help` 后 manifest 数 = 0） | — |

## 复跑（退出码口径）
typecheck 0 · unit **2445/0** · concurrency+timeout 37/0 · e2e 25 · py 131 · lab 26。

## 未做（登记去向）
- **V130**：`/api/usage` 不带 project 返回当前项目而非全局汇总 · 无价模型拒绝时 CLI exit code 仍为 0 ·
  `config get` 把 config.json 来源标成 env。三条可复现但不阻塞发布 → v0.9。
- **V131**：其余模块的子命令级 `--help` 未逐个排查 → v0.9（更该做的是一条结构性门禁）。
- A7「跑不了」的三项：浏览器 UI 视觉交互（无浏览器工具，全部 curl 代跑）、令牌单次消费链条
  （`lab token` 强制真实 TTY，验收环境非 TTY 且未授权 CI 旁路）。

### V132 · A7 说得对：契约里确实没有 budgetUsd（我差点冤枉它）
A7 报「`/api/chat`、`/api/session/chat` 契约里根本没有 `budgetUsd` 字段」。我起初判定它取样有误——
V119 明明加了。核对 `contract --json` 后发现**它是对的**：路由**接受**这两个字段，但
`server/types.ts` 的 `ChatRequest` 没声明它们，而契约的 HTTP schema 正是从这些 TS 接口生成的，
于是 `contract --json` 与据其生成的 SDK 都看不见这个字段——**契约以遗漏的方式说了谎**，
这恰恰是 contract 该防的那类问题（AD-12）。
修：`ChatRequest` 补 `budgetUsd?` / `allowUnpriced?`，重新生成 `schemas.generated.json`。
教训：契约的真源是 TS 接口，加路由参数时必须同步接口，否则门禁也看不出来（它只对撞路由集合，
不对撞"路由实际读了哪些 body 字段"）。
