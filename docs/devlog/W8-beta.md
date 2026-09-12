# W8-1 β · 数据层补全（V85 · V78 · V63 · V97 · V99 · V98）

> worktree `~/Desktop/AI4S/spark-research-beta` · 分支 `lane/W8-1-beta`。方案 `docs/DEVELOPMENT_PLAN_v0.8.md` §三 W8-1 β 行；BACKLOG 条目见 `docs/BACKLOG.md` 第 199/179/165/213/214/215 行（V85 取「raw 层「四类」不含仿真平台执行」那一条——第 187 行另有一个同号但不相干的旧条目，已核对不是本 lane 要做的那条）。

## 交付

| 项 | 落点 |
|---|---|
| V85 · raw 新增 `kind=simulation`；`SubprocessSimulationPlatform` 的 prepare/submit/collect 各落一行、成链、串 runId/specHash、params 脱敏 | `backend/src/raw/models.ts`（新 kind + `SimulationPayload`）· `backend/src/simulation/platform.ts`（`deriveProjectRawSink()` + `appendRaw()` + 三处调用点）· `backend/src/data/import.ts`（verify 循环改走 `RAW_KINDS` 单一真源） |
| V78 · `subAgentLlm()` 经 `usageTrackingLlm`（command=`chat:subagent`） | `backend/src/agents/orchestrator.ts`（`subAgentLlm(sessionId)` 签名 + 两处调用点传参） |
| V63 · `rateLimitWaitMs` 真记 | `backend/src/http/ratelimit.ts`（`RateLimitedResponse`，`acquire()` 返回真实等待毫秒）· `backend/src/connectors/base.ts`（读回写进 `recordApiCall`）· `backend/src/usage/api_ledger.ts`（字段注释更新，不再声称恒 0） |
| V97 · usage `model` 字段校验 | `backend/src/usage/ledger.ts`（`UsageStore.append()` 前置类型守卫）· `tests/helpers/ideation_scenario.ts`（`ScriptedLlm.call()` 归一化 `string \| CallOptions`） |
| V99 · 三笔口径 | `backend/src/usage/ledger.ts`（① append() 写盘失败吞掉+`console.error`；② `error.kind ∈ {auth, rate_limit}` 记 `costUsd:0` + `zeroCostReason`；③ embedding 口径——**不改** `llm/embeddings.ts`，见下方「偏差」） |
| V98 · basis 回读 | `backend/src/literature/reading.ts`（`cardFromRecord()` 恢复 basis/basisReason；`cardBaselineText()` 按 basis 标注，供 `review.ts` 的 judge 输入使用） |

## 新增测试

- `tests/unit/w8_beta_simulation_raw.test.ts`（5 条，V85）
- `tests/unit/w8_beta_subagent_llm.test.ts`（2 条，V78）
- `tests/unit/w8_beta_ratelimit_wait.test.ts`（4 条，V63）
- `tests/unit/w8_beta_usage_ledger.test.ts`（7 条，V97+V99①②）
- `tests/unit/w8_beta_reading_basis.test.ts`（7 条，V98）

合计新增 25 条单测（门禁要求 ≥8）。既有测试未改一行——所有既有套件保持原样通过。

## 六套件数字（本 worktree 实跑，2026-09-12，均为改动落地之后的最终态）

| 套件 | 命令 | 结果 | rc |
|---|---|---|---|
| typecheck | `bun run typecheck` | 通过 | 0 |
| unit | `bun test tests/unit` | 2321 pass / 0 fail（基线 2296 + 本 lane 新增 25） | 0 |
| concurrency+timeout | `bun test tests/concurrency tests/timeout` | 35 pass / 0 fail（基线 35） | 0 |
| py | `bun run test:py` | 73 passed（基线 73） | 0 |
| lab | `bun run test:lab` | 26 passed（基线 26） | 0 |
| e2e | `bun run test:e2e` | 20 passed（基线 20）——**第一次跑撞了并行噪音**：`http://127.0.0.1:4399` 端口被另一条并行 lane 的残留进程占用（`Error: ...already used`，rc=1）；`lsof -i :4399` 核实那个进程几秒后自己退出（并行 lane 的 e2e 跑完收尾），端口转空后单独重跑一次，20/20 全绿，rc=0 | 0（重跑） |

`tests/concurrency/raw_append_race`、`tests/concurrency/budget_inflight` 都在 concurrency 套件里，随其一起跑绿，未见超时，无需单独重跑。

## 阴性对照（全部真跑，改法 → 红 → 复原 → 绿）

| # | 门禁/断言 | 拆法 | 红的结果 | 复原后 |
|---|---|---|---|---|
| 1 | V85：prepare/submit/collect 三处 `appendRaw()` 调用 | 逐个注释掉三处调用 | `tests/unit/w8_beta_simulation_raw.test.ts` 5 条全红（三阶段行数 0/1/2、导出计数、非项目根兜底全部对不上预期） | 5/5 绿 |
| 2 | V78：`subAgentLlm()` 内的 `usageTrackingLlm` 接线 | 注释掉整段接线，退回裸 `llm.call` | 「会话绑定了项目」用例红（usage.jsonl 里找不到 `chat:subagent` 行）；「没有 projects 注入」对照用例保持绿（符合预期——它测的就是无项目退回裸调用） | 2/2 绿 |
| 3 | V63：`acquire()` 计时 + `request()` 挂 `rateLimitWaitMs` | 把 `request()` 返回值里的 `rateLimitWaitMs` 强制写死成 0 | ratelimit 层「令牌耗尽后 waitMs>0」用例红；connectors/base.ts 集成用例（第二次调用 waitMs>0）红 | 4/4 绿 |
| 4 | V97：`UsageStore.append()` 的 model 类型守卫 + V99①写盘失败吞掉 + V99②zero-cost 覆盖 | 三处一起拆：append() 去掉类型守卫与 try/catch，`call()` 里去掉 zero-cost 覆盖逻辑 | 7 条里 5 条红（model 类型守卫、目录路径写入失败抛异常、usageTrackingLlm 集成写盘失败抛异常、auth/rate_limit 两条 zero-cost 用例）；「model 是字符串」「timeout 失败仍记未知」两条对照用例保持绿 | 7/7 绿 |
| 5 | V98：`cardFromRecord()` 回读 basis + `cardBaselineText()` 标注 | 两处一起拆：回读处只保留必填字段，标注处强制 `basisLine = null` | 7 条里 6 条红（端到端回读 3 条、标注文本 3 条）；「老卡片无 basis 字段」兼容性对照用例保持绿 | 7/7 绿 |

阴性对照 1/3/4/5 直接改源码文件、跑对应新测试文件、看红、`cp` 备份复原、再跑绿——全部保留了改动前后的实际终端输出（见上面各条的红/绿计数，均来自本次 session 的真实 `bun test` 输出，非转述）。对照 2 的「保持绿」分支本身就是它的判据：如果无项目分支也被这次拆动影响到，说明改法误伤了别的路径，不是真正针对性的对照。

## 与任务书的偏差 / 如实交代

1. **V85 的落点绕过了生产调用方**：`experiment/loop.ts`（`design()`/`dryRun()`/`collect()` 直接调用 `platform.prepare/submit/collect`）是唯一的生产调用路径，但它不在本 lane 足迹内（任务书允许列表没有 `experiment/*`）。改法是让 `SubprocessSimulationPlatform` 自己在 `prepare/submit/collect` 内部按 `root` 反推项目 raw sink（`deriveProjectRawSink()`：`root` 形如 `<projectRoot>/experiments/<platformId>`，核验 `project.json` 存在再落到 `<projectRoot>/raw/`，推不出就落全局兜底），不需要改任何调用方的参数。这比「显式传 raw 选项」更隐蔽，收口时如果要审这处改动，建议重点看 `deriveProjectRawSink()` 的路径反推逻辑是否与 `project/manager.ts` 的 `pathsFor()` 保持同构（我在注释里写了「逐字节同构」，但两处分别维护，未来 `pathsFor()` 改了这里不会自动跟上）。
2. **V98 的「综述 prompt 标注」落在 `cardBaselineText()` 而不是 `review.ts` 的 `buildReviewPrompt()`**：任务书允许列表把 `literature/reading.ts` 标注成「只有 `cardFromRecord` 与 review prompt 里按 basis 标注」，但 `buildReviewPrompt()`（生成综述草稿本身的 prompt）实际定义在 `review.ts`，不在允许列表里。`cardBaselineText()`（reading.ts 导出）是 `review.ts` 里唯一读到「卡片文本」的函数，被喂给 `CitationJudge`（引用一致性判定的 LLM 输入）——这条路径确实拿到了 basis 标注（"judge 能拿到" 这半句满足了）。但 `buildReviewPrompt()` 自己拼 bodies 的那段代码完全没有引用 `cardBaselineText()`，所以**综述草稿生成本身用的 prompt 没有 basis 标注**——如果任务书原意是要两处都加，这里只做到了一处，另一处需要改 `review.ts`（不在我的足迹内），交给收口处理。
3. **V99③（embedding 入账）按任务书原话只写声明，未接线**：`llm/embeddings.ts` 不在本 lane 允许列表内（β 的允许列表明确写「你**不改** embedding，只在 devlog 声明口径」）。据我读到的现状（未做代码改动，只是确认）：`totals()` 按 `command` 聚合是通用逻辑，只要 ζ 那边的 `UsageStore.append({command: "<cmd>:embedding", ...})` 调用点接上，`usage` 命令按 command 分组的输出会自动把 embedding 那一档显示出来，不需要 usage/ledger.ts 再改一次——这是我读代码后的判断，没有找到 ζ 的改动（本 worktree 里 `llm/embeddings.ts` 现状如何，我没有跨 lane 读别的 worktree，只读了本 lane 内能看到的这一份代码）。
4. **`docs/data/manifest.ts` 未改动**：任务书门禁写「`data export --for-sharing` 对 simulation raw 的出门规则……写进 `data/manifest.ts` 的计数」。核实后 `ManifestTableCounts` 本就是 `Record<string, number>` 索引签名，`export.ts` 按 `entry.kind` 通用分组——`simulation` 这个 kind 出现后自动计入 `manifest.schemas.raw.tables.simulation`，不需要改 `manifest.ts` 的类型或逻辑（`tests/unit/w8_beta_simulation_raw.test.ts` 的 export→import 往返用例已经验证了这一点：`result.manifest.schemas.raw.tables.simulation` 确实是 3）。如果收口预期是要在 `manifest.ts` 里显式列出 `simulation` 这个字面量（比如加一条文档性质的类型），我没有做——认为通用索引签名已经满足功能要求，多加一层可能反而制造维护负担，但这是我的判断，未与用户/收口核对。
5. **`backend/src/usage/api_ledger.ts` 的 `ApiCallEntry.rateLimitWaitMs` 注释更新**：这个文件严格说不在允许列表的字面路径里（允许列表写的是 `usage/*`，`api_ledger.ts` 就在 `usage/` 目录下，所以按字面是允许的），但它属于 V63 关联的既有代码注释（此前如实写着「恒为 0」），改动只是把过时的注释更正为反映真实行为，没有改变 `ApiCallEntry` 的字段形状或任何函数签名。如实报备，供收口判断是否需要额外审视。
6. **没有触碰的禁止文件**：`backend/src/index.ts`、`literature/cli.ts`、`project/*`、`llm/budget.ts`、前端——确认逐字未动。

## 测试隔离

- 所有新测试通过 `bunfig.toml` 的 `tests/preload.ts` 预置隔离（`SPARK_RESEARCH_DATA_DIR` 指到临时目录），未写 `~/.spark-research`。
- `tests/unit/w8_beta_ratelimit_wait.test.ts` 的第二个 describe 块里，为了让 `connectors/base.ts` 内部 `recordApiCall()`（不接受注入路径，只能走 env 变量）落到临时目录，测试内临时改写 `process.env.SPARK_RESEARCH_DATA_DIR` 并在 `finally` 里精确还原为改动前的值（`undefined` 时 `delete`，否则原样写回），不依赖测试执行顺序。
- `tests/unit/w8_beta_usage_ledger.test.ts` 的写盘失败用例用 `chmod 0o444`/`mkdirSync` 在临时目录内制造真实的文件系统错误（EACCES/EISDIR），全部路径都在 `mkdtempSync` 建出的临时目录下，不涉及用户真实数据。

## 并行噪音

六条 lane 并行期间，只有 `test:e2e` 第一次撞到端口占用（见上表），非超时类问题（是「端口被占」而不是「探测超时」），单独重跑一次即全绿，已如实记录。
