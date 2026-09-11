# W7-E · 债务清算三条（V41 · V48 · V21）

> worktree `~/Desktop/AI4S/spark-research-E`，分支 `feat/W7-E-debt`。三条互不相关，分三个 commit，各自可单独回退。

## E-1 · V41：MCP 工具描述的能力声称门禁

现状：`backend/src/mcp/tools.ts` 的 `chem_depict` 描述如果被改成谎称支持 3D docking，没有任何既有测试变红——MCP 描述是给外部 agent 看的能力声明，`tests/unit/narrative_parity.test.ts` 已有的七条 AD-12 断言全部只查 `capabilities`/skills/数字/状态机这些结构化端点，没有一条查 `MCP_TOOLS` 的自然语言 `description` 本身。

### 交付

- `tests/unit/narrative_parity.test.ts` 新增「第 9 条（W7-E1 · V41）：MCP 工具描述里的能力声称必须对得上真源，不许空口白牙」。
- 小而显式的能力词表 `CAPABILITY_WORDS`（5 类：`3D/docking/对接`、`全文/fulltext`、`真检索/实时`、`GPU`、`远端/Modal`），每类配一个 `verify()`，去读真实源码文件做结构性核实（导出函数是否存在、写入方是否真 import+调用、注册表里是否有非空条目），不是关键词全仓库模糊搜索：
  - `3D/docking/对接` → `backend/src/chem`、`backend/src/proteins`（唯一可能承载这类计算的目录）里核实不到任何 `dock`/对接 字样 → 本仓库不提供该能力。
  - `全文/fulltext` → `literature/pdf_text.ts` 定义 `extractPdfText`，`literature/cli.ts` 真 import 并调用它（`extractPdfText(p.pdfPath)`，第 628 行）。
  - `真检索/实时` → `http/client.ts` 的 `defaultHttp = new NativeHttp()`，`connectors/registry.ts` 默认 `options.http ?? rateLimitedHttp()` 且不 import `FixtureHttp`，`connectors/base.ts` 兜底 `options.http ?? defaultHttp`——生产路径真打网络，不是回放层。
  - `GPU` → `defaultComputeAdapters()` 里至少一个 adapter 的 `capabilities().gpus` 非空（modal）。
  - `远端/Modal` → `TARGET_KINDS` 含 `modal` 且 `defaultComputeAdapters()` 真注册了它；显式声明不核实"真实 gateway 是否已录制"，那是 `compute_modal.test.ts`「等真实录制」阴性对照的职责，两条断言分工不同。
- 提取判据：把每个工具的 `description` 按硬标点（`。！？` 与换行）切句，一句里出现能力词、且**同一句**里没有否定标记（`不算/不做/不能/不可/不支持/并非/并不/无法/没有(排除"有没有")/非+字母数字`）才算"声称"——用句子而不是逗号/顿号/破折号切分，因为本仓库大量描述用"要 X——其实不做 X"这种跨读一整句才成立的免责声明句式。
- 顺带发现并修正一处不实措辞（非 chem_depict）：`protein_analyze` 原文把"对接"列为 `exp_design` 之后可能要跑的干实验类型之一（"准备跑干实验（MD / 对接）之前……"），但 `exp_design` 的两个平台 `pyref`/`openmm` 的 `kinds` 分别只有 `damped-oscillator` 与 `water-box-md`，全仓库都没有任何对接/docking 的 kind 或实现——这句话把"用户可能想做对接"（合理）悄悄读成"这条链路支持对接"（不合理）。已改成只提 MD，并加一句现状说明。

### 阴性对照（真跑，2026-09-11）

| 改法 | 结果 |
|---|---|
| 给 `chem_depict` 描述追加一句无否定标记的独立句子「本工具还支持 3D docking。」 | **红**：`工具 'chem_depict' 的描述声称了能力词 '3D'/'docking'，但真源核实不通过……本仓库目前不提供 3D 对接能力` |
| 撤回上面那句 | 绿，`tests/unit/narrative_parity.test.ts` 11/11 |

第一版判据踩过一个真实边界：ASCII 能力词（`3D`/`GPU`/`Modal`/`docking`/`fulltext`）不加词边界时，`lit_read_cards` 描述里的示例 id `"a1b2c3d4"` 会被当成命中 `3D`（子串 `c3d4` 里的 `3d`）——改成纯 ASCII 词要求 `\b...\b` 词边界后消失；中文能力词不能加同样的边界（`\b` 只认 ASCII `\w`，两个中文字之间永远没有边界，加了反而永远匹配不到），两类词分开处理。

### 数字

`bun run typecheck`：0 错误。`tests/unit/narrative_parity.test.ts`：11 pass / 0 fail（新增 1 条，原 10 条不变）。

## E-2 · V48：local 算力 handle 执行期间落盘（SIGKILL→resume→收割成真）

现状（BACKLOG V48 原文）：`adapterHandle` 只在 `adapter.run()` **返回时**才写 `job.json`，编排进程中途被杀 → handle 为 null → 既不能接回也不能收割，`release` 还会删掉唯一产物。

### 交付

- `backend/src/compute/target.ts`：`RunHooks` 新增 `onHandle?: (handle: AdapterHandle) => void`——adapter 拿到执行期 handle（spawn 成功、pid 到手）立刻回调，不必等 `run()`/`recover()` 整体返回。
- `backend/src/compute/adapters/local.ts`：`run()` 里 spawn 成功、构造出 `handle` 之后立刻 `hooks.onHandle?.(handle)`，早于进入 `awaitTerminal()`（可能跑几分钟才返回）。
- `backend/src/compute/broker.ts`：
  - 新增私有方法 `hooksWithHandlePersist(jobId, hooks)`：包一层 hooks，`onHandle` 触发时立刻 `this.jobs.patch(jobId, { adapterHandle: handle })`（`job_store.patch()` 是对磁盘上**当前**记录做字段合并，不需要 `expectedRev`——不会覆盖并发写的其它字段，这次写也只加一个字段），再转发给调用方自己的 `onHandle`（如果有）。
  - `runOn()`（`dispatch`/`recover` 共用的真正调用 `adapter.run()` 的地方）与 `recover()` 里调用 `adapter.recover()` 的地方，都改成传 `this.hooksWithHandlePersist(jobId, hooks)`。
  - `recover()` 里"没有 adapterHandle"那条 fallback 分支的注释与 message 更新：V48 之前这个窗口覆盖派发到终态的整段时间，V48 之后窗口缩到了"声明派发权 → adapter 真正 spawn 出 handle"之间那一小段（仍然存在，没删掉这条 fallback）。
  - `recover()` 里 `RecoverFailure` 的 catch 分支补上"产物与日志请到 `<jobDir>/workspace` 与 `<jobDir>/run.log` 自行核对"——V48 之后，"进程和标记都没了"这类失败会更多地走这条路径（而不是"没有 handle"那条 fallback），原来那条 fallback 独有的"东西在哪儿"信息量不能跟着路径切换一起丢。

### 测试

- `tests/unit/compute_local.test.ts` 新增「V48：handle 在 spawn 成功那一刻就落盘，不等 run() 返回（同进程可验的那一半）」：真起一个 `sleep 2` 的 local 任务，`dispatch()` 还没 resolve 时轮询 `job.json`，断言 `adapterHandle` 在任务仍 `running` 时就已非空（旧代码要等 2 秒 dispatch 整体 resolve 才写得进去，等不到会超时）。
  - 踩过的坑：一开始想在**同一个 JS 进程**里"起一个 broker、不 await 它的 dispatch()、再用一个全新 broker 实例 recover()"来模拟"编排进程重启"——实测这不成立：不 await 并不会让那个 promise 停止运行，它仍在同一个事件循环里跑，会跟"新" broker 对同一份 `job.json` 产生真实的并发写竞争（旧 promise 的 `settle()` 在新 broker 已经把 lifecycle 推进到 `interrupted` 之后尝试 `succeed` 转换，转换表拒绝，被 `runOn()` 的 catch 兜成 `failed`，把新 broker 刚接回的结果覆盖掉）。已改成只验"同进程能验的那一半"（handle 落盘时机），完整的"编排进程死了→任务活下来→新进程接回"路径挪到下面的真实 e2e 用例。
- `tests/unit/compute_e2e.test.ts` 新增 describe「真实 SIGKILL · 只杀编排进程，任务本体活下来（V48）」：与既有「真实 SIGKILL · 编排进程与任务一起被 kill -9」用例同源（同一个 `harness`/`runOnce`/`TASK_PY`），真 `Bun.spawn` 一个独立的编排子进程执行 `compute run <jobId>`（任务跑 2 秒），确认 `started.pid` 落地后轮询 `job.json` 断言 `adapterHandle` 在 `execution=running` 时已非空且此刻还没有 `result.json`（证明落盘早于任务终态，不是巧合追上）；只 `SIGKILL` 编排进程本身（不碰 shim 与任务——两者是编排进程的子孙，杀父进程不会自动带走它们），确认任务不受影响地写下 `result.json` 与 `exit-code` 标记；全新进程视角 `compute recover` 返回 0 且 `execution=succeeded`；`compute collect` 收割到真实产物 `{answer: 42, seconds: 2}`。
- **顺带发现并修的一处回归**：既有「真实 SIGKILL · 编排进程与任务一起被 kill -9」用例（三个进程全杀）在 V48 修复后从**绿变红**——不是我引入的 bug，是这条测试原来断言的措辞（`message.toContain("派发过")` / `toContain(jobDir)`）绑死在"没有 adapterHandle"那条 fallback 的旧文案上。V48 之后 adapterHandle 早就落盘了，`recover()` 会真的去调用 `adapter.recover()`，发现进程和标记都没了，抛 `RecoverFailure(not_found)`，走的是**另一条**早就存在、早就被 `compute_local.test.ts`「exit-code 丢了 + 进程也没了」单独覆盖过的路径——这是更准确的诊断（真尝试过 recover，不是靠 `dispatchedAt` 猜），不是退步。把断言改成核对 `not_found`/`exit-code`/`jobDir` 这几个新文案里仍然携带的信息点，并在 `broker.ts` 的 catch 分支里把"东西在哪儿"重新缝回去（见上面「交付」最后一条），让这条测试继续覆盖它原本要覆盖的东西（不许静默当成功、recoverable 有牙齿、release 拦得住）。

### 阴性对照（真跑，2026-09-11）

把 `local.ts` 的 `hooks.onHandle?.(handle)` 那一行临时删掉（改回"只在 run() 返回时才有机会写"）：

| 用例 | 结果 |
|---|---|
| `compute_local.test.ts` V48 用例 | **红**：`spawn 成功后 handle 应该在任务仍处于 running 时就已经落盘` Expected: true, Received: false |
| `compute_e2e.test.ts` V48 用例 | **红**：`expect(view.lifecycle.execution).toBe("running")` Expected: "running", Received: "succeeded"（意味着一直等到任务跑完 `dispatch()`/`run` 整体落定才看到 handle，与预期的"跑到一半就该有"矛盾） |

撤回改动后两条都回到绿。

### 与设计 §1.1.9 验收路径的对照 / CHANGELOG 建议（本 lane 不改 CHANGELOG）

设计 §1.1.9 的验收路径「SIGKILL → resume → 收割」在 local 上现在成立了（`compute_e2e.test.ts` 新用例是真实进程级验证，不是打桩）。之前 CHANGELOG 里如果有「local 的 SIGKILL 恢复路径走不通」一类条目，建议改写为：「local adapter 的 SIGKILL 恢复路径已打通（V48）：执行期 handle 在 spawn 成功时立刻落盘，不再等 `run()` 返回；编排进程中途被杀、任务本体存活或已完成的场景下，重启后 `compute recover` 能正确接回并收割——`tests/unit/compute_e2e.test.ts` 有真实 kill -9 验证」。若该条目原本还提到"handle 为 null 导致 release 误删产物"，可以一并说明这条窗口已从"派发到终态"缩窄到"声明派发权到 adapter 真正 spawn 出 handle"之间的一小段（`broker.ts:recover()` 的 fallback 分支注释里有具体说明），没有完全消失。

### 数字

`bun run typecheck`：0 错误。
`tests/unit/compute_local.test.ts`：24 pass / 0 fail。
`tests/unit/compute_e2e.test.ts`：8 pass / 0 fail（含改写后的「三刀齐下」用例 + 新增 V48 用例）。
`tests/unit/compute_broker.test.ts` + 上两个文件合计：55 pass / 0 fail。
`tests/unit/compute_{broker,dispatch_once,http,mcp,modal,target,plan,lifecycle,approval,job_store,uploads,cli}.test.ts`（12 个 compute_*.test.ts，不含 local/e2e）：227 pass / 0 fail。

## E-3 · V21：超时 env 前缀统一，启动废弃周期

现状：`SPARK_HTTP/LLM/KERNEL/TASK_TIMEOUT_MS` 与仓库约定 `SPARK_RESEARCH_*` 不一致；v0.2.1 起 MCP 工具描述已把 `SPARK_TASK_TIMEOUT_MS` 写给外部 agent 看，改名是 breaking change。

### 交付

- `backend/src/config/index.ts`：
  - `SettingSpec` 新增 `legacyEnvVars?: readonly string[]`（已废弃但仍生效的旧 env 名，按优先级排列）。
  - 四个超时项的 `envVar` 改成 `SPARK_RESEARCH_{HTTP,LLM,KERNEL,TASK}_TIMEOUT_MS`；旧名 `SPARK_{HTTP,LLM,KERNEL,TASK}_TIMEOUT_MS` 登记进各自的 `legacyEnvVars`（`mcpTimeoutMs` 本来就是 `SPARK_RESEARCH_MCP_TIMEOUT_MS`，不在改名范围内，未动）。
  - `resolveSetting()`：新名没读到值时才回落旧名；命中旧名走 `options.warn`（既有出口，默认 `console.warn`，测试可注入）告警一次，文案点名旧名与新名；新旧同设时走新名分支，不告警。
- `backend/src/mcp/tools.ts`（仅文案）：`exp_run` 与 `task_status` 两处提到 `SPARK_TASK_TIMEOUT_MS` 的地方改成 `SPARK_RESEARCH_TASK_TIMEOUT_MS`，并加一句「旧名 `SPARK_TASK_TIMEOUT_MS` 仍生效但已废弃，计划 v0.8 起移除」——旧名字面量仍然出现在文本里（只是带了废弃说明），不是整段替换掉，`tests/unit/mcp_friction_fixes.test.ts`（不在本 lane 足迹内，未改）里断言这两个工具描述必须同时提到 `SPARK_TASK_TIMEOUT_MS` 与 `600000` 的用例因此仍然绿。
- `tests/unit/config.test.ts` 新增 describe「V21：超时 env 改名为 SPARK_RESEARCH_* 前缀，旧名进入废弃周期」：对四个 key 逐一验证「新名生效不告警」「旧名生效且告警一次（文案含旧名与新名）」「新旧同设新名赢不告警」，外加「都不设落回默认不告警」与「下游窄口 `configuredTaskTimeoutMs` 同样吃得到旧名」。

### 阴性对照（真跑，2026-09-11）

把 `resolveSetting()` 里判断旧名的 `if (envRaw === undefined || envRaw === "")` 临时改成 `if (false && (...))`（相当于「去掉旧名兼容」）：

| 结果 |
|---|
| **红**：5 个用例失败——4 个 key 的「旧名仍生效」用例（`source` 变回 `"default"`、`value` 变回默认值而不是旧名传入的值）+ 「下游窄口读旧名」用例（`configuredTaskTimeoutMs` 收到 `900000` 却返回 `600000`） |

撤回改动后 `tests/unit/config.test.ts` 100/100（含新增 14 条）、`config_reader_parity.test.ts`、`mcp_friction_fixes.test.ts`、`narrative_parity.test.ts` 合计 100 pass / 0 fail。

### 数字

`bun run typecheck`：0 错误。
`tests/unit/config.test.ts`：100 pass / 0 fail（新增 14 条：4 key × 3 条 + 2 条通用）。
`tests/unit/config.test.ts` + `config_reader_parity.test.ts` + `mcp_friction_fixes.test.ts` + `narrative_parity.test.ts` 合计：100 pass / 0 fail。
`tests/concurrency` + `tests/timeout`（8 个文件）：25 pass / 0 fail。
`bun run test:py`：73 passed，0 skipped。
`bun run test:lab`：26 passed，0 skipped。
`bun run test:e2e`：19 passed（`E-3` 碰了 `mcp/tools.ts` 文案且 `resolveSetting` 是 HTTP/CLI 公共读路径，按纪律 13 算跨层改动，补跑）。

### 已知残留红（不在本 lane 足迹内，未改，diff 附在报告里交收口）

`bun test tests/unit` 全量跑一遍后除了 E-1/E-2/E-3 自己的部分，还剩两条红：
- `tests/unit/llms_txt.test.ts`「生成物与仓库里已提交的文件一致」——worktree 建好之前就已经红（与 E-1/E-2/E-3 均无关），`llms*.txt` 归收口，本 lane 未碰。
- `tests/unit/w61_cli_polish_rev.test.ts`「dispatch 一次只让 rev 跳 2 格...而不是 3 格」——**这条是 E-2 的连带影响**：V48 的 `hooksWithHandlePersist` 让 dispatch 内部多了一次 `jobs.patch()`（handle 落盘），rev 从「claim+merged-transition+settle 共 3 次」变成「+handle 落盘 共 4 次」，`expect(ran.rev).toBe(planned.rev + 3)` 因此从 4 变成收到 5。这个文件不在本 lane 任何一条的足迹（`tests/unit/compute_*.test.ts` / `tests/unit/config*.test.ts`）内，按纪律不碰，diff 交收口：
  ```diff
  -  test("不需要审批的 plan：dispatch 一次只让 rev 跳 2 格（claim 1 + start-run-merged 1），而不是 3 格", async () => {
  +  test("不需要审批的 plan：dispatch 一次让 rev 跳 3 格（claim 1 + start-run-merged 1 + V48 handle 落盘 1），而不是 4 格", async () => {
  @@
  -    // 三次 patch()：① 无审批分支的 dispatch 声明（claim）② 合并后的
  -    // resource_start/resource_active/start/run ③ settle()。合并前是 4 次（②拆成
  -    // started/running 两次），rev 会从 1 跳到 5；合并后是 3 次，1 跳到 4。
  -    expect(ran.rev).toBe(planned.rev + 3);
  +    // 四次 patch()：① 无审批分支的 dispatch 声明（claim）② 合并后的
  +    // resource_start/resource_active/start/run ③ W7-E V48：adapter 一拿到执行期
  +    // handle 就立刻回调 hooks.onHandle 把它落盘（不必等 run() 返回，是 SIGKILL 能
  +    // 恢复的前提）④ settle()。V48 之前 3 次，1 跳到 4；V48 之后 4 次，1 跳到 5。
  +    expect(ran.rev).toBe(planned.rev + 4);
  ```
  这是 V48 与 V50（「减少 dispatch 内部 patch() 次数」）两条 BACKLOG 条目的真实目标冲突：V48 要的是「crash 后能接回」，代价是必须多一次独立落盘；V50 要的是「rev 跳变格数更贴近直觉」。本 lane 判断 V48 的正确性（数据不丢）优先于 V50 的展示层整洁度，但收口方可能有不同权衡（比如把 handle 落盘也想办法合并进同一次 patch），所以只给 diff、不擅自在足迹外落子。

### 需要同步但本 lane 不改的文档

`grep -rn "SPARK_HTTP_TIMEOUT_MS\|SPARK_LLM_TIMEOUT_MS\|SPARK_KERNEL_TIMEOUT_MS\|SPARK_TASK_TIMEOUT_MS" docs/INSTALL.md README.md` 零命中——两份文档目前都不提这四个变量，**不需要同步**。`docs/BACKLOG.md`（V21 条目原文）与 `docs/devlog/P10-b.md`（历史 devlog）里各有一处提到旧名，均属于记录历史决策的文本，本 lane 不改（归收口，且改了就篡改了历史记录本身的意思）。
