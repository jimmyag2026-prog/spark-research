# R5 修复窗口（并行于 R5 复跑）· V104 V115 V116 V119

**日期** 2026-09-12 · **分支** `fix/R5-window-V104-V115-V116-V119` · 执行：主会话（R5 子代理在 detached@alpha.2 的独立 worktree 跑，本分支改动不影响它）

| 条目 | 改动 | 门禁 | 阴性对照（实跑） |
|---|---|---|---|
| **V104** HTTP 综述不落 citation-integrity record | `routes/literature.ts` `POST /review`：与 CLI 同一 `records.create({kind: CITATION_INTEGRITY_REVIEW_KIND…})`（内联，narrative_parity 结构核实友好）；响应加 `citationReviewRecordId`、`citationGap` | `server_literature`「综述…不 veto」加断言：record 存在且 metadata.kind 对 | 响应里 id 置空 → 17/1 红 |
| **V115** auth 录入回显 | `cli/hidden_input.ts` `readHidden()`：TTY 切 raw 逐字读不回显（退格/Ctrl+C），非 TTY 按行；`index.ts auth()` 换用 | `v115_hidden_input` 3 条 | 让 readHidden 回显 → 2/1 红 |
| **V116** CI bypass token | `approval/gate.ts` `constantTimeEqual`（sha256 + timingSafeEqual）；`--ci-bypass-token-env <VAR>` 从环境变量取 token；lab/compute HELP 同步 | `v116_bypass_token` 5 条；既有 `approval_gate` 全绿 | 去掉 env 分支 → 3/2 红 |
| **V119** 聊天式 co-explore 无预算入口 | `orchestrator.chat({budgetUsd, allowUnpriced})` 按会话记预算 → `llmFor` 传给 usageTrackingLlm；`/api/session/chat` 与 `/stream` 透传；`api.ts streamChat` + 聊天框 `BudgetInput`；闸拒绝时 orchestrator 把闸消息（含下一步）原样回给用户，不再说"检查 API key" | `v119_chat_budget` 2 条（budget 极小 → fake llm 0 次调用 + 回复含"预算闸"；不带 → 照常调用） | `/chat` 路由去掉透传 → 1/1 红 |

## 复跑（退出码口径）
typecheck 0 · unit 2430/0（2420+10）· concurrency+timeout 37/0 · e2e 见 PR。

## 追加 · V118 openmm 探测同源
- `openmm/runner.py` 加 `probe()`（import openmm + 列 Platform）；`openmm/index.ts` `probeCode()` 改走 `probeCodeFor(this.entryPointFor(), "openmm", …)`，三平台 + openmm 探测与真提交同源。
- `tests/unit/v118_openmm_probe.test.ts` 2 条（源码形状 + 真实探测；.venv 无 openmm 时 skip 并说明）。阴性对照：runner 去掉 probe() → 1/1 红。
- unit 2432/0 无 skip（P5 契约 OpenMM 侧不再整套 skip）· py 129。

## 第二批 · R5 发现的复核与修复（V121–V124）

R5 报告的 3 条 P0/P1 **逐条独立复现**后才动手——一条证伪、两条证实、并挖出真因。

### V124 · R5 P0-3「导出往返 diff 非空」→ **不成立**
R5 称 4/4 项目 `data export → import → report export` diff 非空（93–198 行），共同点是「Idea 卡与实验卡整节丢失」。
主会话用最小项目（1 张 idea 卡 + 1 条实验记录）复现：
- 两侧都带 `--verbose`：diff **0 行**（除生成时间戳）——往返是等价的。
- 原始带 `--verbose`、副本不带：**精确复现** R5 描述的形状（`# Idea 卡：…` 正文块、实验正文块整块消失）。

被删掉的正是 `--verbose` 才渲染的 `record.content`。R5 自己也记录了「`report records --type idea --json` 底层数据完整」——两件事一致。
**结论：方法学偏差（两次 export 的旗标不对称），不是产品缺陷。** 不改代码，登记 V124 防止再被登记一次。

### V121 · raw 链在单行 >64KB 时静默断开（R5 P1-4 的真因）
R5 只看到「`data import` 报 verified:false」。直接验源项目的链，发现**断链发生在写入时**，import 的报告是诚实的：

| 项目 | 断链位置 | 前一行字节数 |
|---|---|---|
| r5-t1 | pubmed 第 3 行 | 68444 |
| r5-t2 | crossref 第 23 行 | 68775 |
| r5-t2 | pubmed 第 3 行 | 70330 |
| r5-t3 | pubmed 第 4 行 | 68398 |

全部 4 处断链的前一行都 >64KB，无一例外；r5-t4（无超大行）链完整。真因：`readTail` 固定 64KB 窗口，
窗口整个落在那一行内部时 `text.indexOf("\n") === -1`，`slice(0)` 把**残行**当完整行返回 → `JSON.parse` 抛错
→ 被 `catch` 吞成 `last = null` → 下一条 append 写出 `prevHash: null`。llm 链从没踩到，是因为 `body()` 把
>64KB 正文移进 blobs，行始终很小——connector 的响应体是整段 inline 的。

修：窗口按需放大（64KB → 1MB → 16MB → 整文件），残行不拿去解析；非空文件的最后一行解析不了**直接抛**，
不再吞成 null 伪造链头。历史断点**不回填**（回填等于伪造）。

### V122 · body.project 被静默忽略（R5 P0-2）
复现：current 指针 = alpha，`POST /api/chem/depict` 带 `{"project":"beta"}` → 记录落在 **alpha**，响应还回报
`"project":"alpha"`；同样的调用改用 `?project=beta` 则正确。SDK 生成的正是 body 风格。
修：`jsonBody()` 把解析好的 body 挂到 context，`projectSlug()` 取值顺序 **query > body > 当前指针**——
所有写路由都是先 `jsonBody(c)` 再取 slug，所以一处改动覆盖全部 47 个调用点，GET 路由不受影响。

### V123 · SDK 无 body 的 POST 一律 415（R5 P1-6）+ 文档断言过宽（P1-5）
写方法在 `body=None` 时按 `{}` 发送并带 `Content-Type: application/json`；`docs/SDK.md` 删去
`tasks_get_tasks_by_id → TaskResponse` 这条与实测不符的断言（实际是 `{"task":{...}}`）。

### 阴性对照（全部实跑）
| 门禁 | 改法 | 结果 |
|---|---|---|
| V121 | `sink.ts` 整体回退到修复前（固定 64KB + 吞解析错误） | **3/3 全红**，且复现 R5 现场形状；还原 3/3 绿 |
| V122 | `projectSlug` 改回只读 query | 2 pass / 1 fail；还原 3/3 绿 |
| V123 | `client.py` 去掉写方法补 `{}` 的分支 | 2/2 红；还原 2/2 绿 |

### 复跑（退出码口径）
typecheck 0 · unit 2438/0 · concurrency+timeout 37/0 · test:sdk 58 passed · e2e/py/lab 见 PR。

### 收口更正（alpha.3 打包时发现）
`tests/unit/v121_raw_large_line.test.ts` 第一版的 connector payload 是随手编的形状，`tsc --noEmit` 不过。
**PR #104 描述里的「typecheck 0」取自写这个测试之前的那次运行，是一个过期数字**——如实更正。
alpha.3 收口时改成真实的 `ConnectorPayload`（`response: { inline: … }`，正是超大单行的来源），
typecheck 0 且阴性对照重跑仍 3/3 全红 → 还原 3/3 绿。
教训：新增测试文件后必须重跑 typecheck 再报数，不能复用改代码时的那次结果。
