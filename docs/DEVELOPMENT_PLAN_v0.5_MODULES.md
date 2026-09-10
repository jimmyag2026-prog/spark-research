# Spark Research v0.5 · 模块设计与施工计划

> 制订时间：2026-09-10（PDT）· 起点：`main` v0.4.0（`feb3c8a`，含 v0.5 方案 #30）
> 上位文档：`docs/DEVELOPMENT_PLAN_v0.5.md`（施工真源，本文**服从**它的 §2 三条硬规则与 §5 波次形态）
> 素材库：`~/Desktop/AI4S/spark-research-v0.5-plan/`（未入库；本文引用时给相对该目录的路径）
> 基线实测（本文制订当日，主仓 `main`）：`bun test tests/unit` → **1396 pass / 0 fail / 0 skip**，82 个文件，49.8s
>
> 本文是**可直接派 lane 的设计**，不是方案复述。凡引用仓库现状一律给文件路径与行号（AD-12 口径），
> 行号以 `feb3c8a` 为准。

---

## 〇、先说结论

### 0.1 五个关键设计决策

| # | 决策 | 一句话理由 |
|---|---|---|
| **K-1** | `backend/src/compute/` 与 `SimulationPlatform` **并列，不包含**；两者之间只有一座桥 `compute/sim_bridge.ts` | 两者契约不同层：`SimulationPlatform`（`simulation/models.ts:95-105`）是学科域契约（归一化参数 / 预期产出 / `deterministic` 位），`ComputeAdapter` 是执行地契约（哪台机器 / 什么环境 / 怎么审批 / 怎么收割）。把 target 塞进 `SimulationPlatform.submit()` 会破坏契约 #2「submit 非阻塞立刻返回 runId」——审批门横在中间，submit 根本不可能立刻返回。详见 §1.1.9 |
| **K-2** | **审批语义（decision record + digest 一次性消费 + 执行前重验）从 CB-5 前移进 CB-1**，CB-5 只剩「接线」（CLI/HTTP/MCP_WITHHELD/TTY/ToolBus 计价） | `planned → awaiting_approval → approved → queued` 是 lifecycle 的主干，CB-1 的「穷举转移测试」不含审批消费就是半张表；而且 W5-1 若先造一个「无审批也能派发」的 broker，必然需要一个测试后门，后门会活到生产。这条是异议 X-1，见 §七 |
| **K-3** | 算力执行状态是**磁盘真源**（`<project>/compute/jobs/<jobId>/job.json`），**不是 record**；证据图只在两处落东西：人做决定（`decision`）与结果进图（`observation` + `artifact`） | v0.4 W3 收口真实踩过：记账类 record 一进图，`NoProgressGuard` 永远看到「有新增」，防烧钱的停机条件被静默废掉（`agents/contract.ts:137-152`）。算力 job 每次 poll 落一条 record 会重演同一件事 |
| **K-4** | embedding 放 `backend/src/llm/embeddings/`，与 `llm/providers/` **同层、不同契约**；novelty 双留痕（词面 + 语义）；**语义阈值按 embedding 模型逐个标定**，未标定的模型一律回退词面 | 规划目录 `workstreams/provider/V05_PROVIDER_DESIGN.md` §(b) 已论证 chat 契约套不上 embedding；余弦分布因模型而异，一个跨模型的常数阈值就是又一个「0.75 拍出来的」 |
| **K-5** | 枢纽文件**按波次**判定，而不是一张全版本固定清单：某文件在本波只有一条 lane 要动 → 分给那条 lane；≥2 条 lane 要动 → 摘出收口 | v0.4 的两条教训互相拉扯：不摘出 → `index.ts` 冲突三次；全摘出 → 「建好但没人喂」六次。按波次分配是两者的交集。见 §3.4 |

### 0.2 关键路径

```
闸门 F ──► W5-1 α（CB-1 契约+审批语义 · CB-2 local · CB-3 上传面）
              ──► W5-2 β（CB-5 接线：CLI/HTTP/withheld/TTY/ToolBus 计价） ┐
              ──► W5-2 α（CB-4 Modal adapter，需 token）                  ┤──► W5-3 α（CB-6 桥 + 真实 SIGKILL e2e）──► 收口
```

其余全部绕开它并行。**W5-2 α 与 β 互不依赖**（β 接线面对着 CB-1 的接口，不需要 Modal 存在；CI 用 local adapter 走完整审批链）。

### 0.3 异议清单（详见 §七）

- **X-1** CB-5 的审批语义应前移到 CB-1（方案 §3.1 把它排在 W5-2）——不是降低优先级，是把它做成状态机本体。
- **X-2** 方案 §5.1 的枢纽文件清单不能整版锁死；应按波次分配（K-5）。
- **X-3** `daemon/daemon.ts:72-91` 有一套 v0.1 遗留的 `ComputeService`/`DefaultCompute` 与 `compute_submit` permit（`daemon/permissions.ts:8`），方案与 COMPUTE_DESIGN 都没提到；v0.5 引入真的 compute 层后，仓库里会有两个「compute」——必须在收口时二选一。
- **X-4** 方案 §5 W5-3 δ「runtime contract + Python SDK」在方案全文与规划目录里**没有任何定义**（`grep -in "runtime contract\|python sdk"` 仅命中方案第 261 行自身）。本文不为它编设计，W5-3 δ 改为机动位 + BACKLOG 清扫。
- **X-5** C5-② 的「kernel 侧」应读作「Python 侧（同一 `.venv`）」而非「经 `PythonKernel`/daemon」——仿真层已有先例「对 daemon 零依赖」（`simulation/platform.ts:23-26`）。

---

## 一、模块设计

### 1.1 C1 · 远端算力 `backend/src/compute/`

#### 1.1.0 定位与三个前置事实

1. **目录名可以直接用 `compute/`**。v0.1 的 `compute/providers.ts` 已在 P8-G6 连同测试删除（`simulation/platform.ts:112-116` 的注释保留了删除记录），`backend/src/compute/` 今天不存在（`find backend/src -maxdepth 1` 实测）。COMPUTE_DESIGN §2.1 提议的 `compute2/` 没必要。
2. **但 daemon 里还有一套同名概念**：`daemon/daemon.ts:16` `interface ComputeService { submit / getFrames / libraries }`、`:72-91` `DefaultCompute`（内存 Map 假实现）、`:194` `case "compute_submit"`，以及 `daemon/permissions.ts:8` 把 `compute_submit` 放进 control_repl 的 permit set，`kernels/control_repl.ts:66` 调它。这是 v0.1 遗留的 mock。**处置见异议 X-3**；W5-1 α 不碰 daemon。
3. **与 `SimulationPlatform` 的关系是并列**（K-1）。`SubprocessSimulationPlatform.submit()`（`simulation/platform.ts:204-251`）今天直接 `Bun.spawn` 本地 python；它就是「target=local」的一个特例实现，但它**不改**——CB-2 的 local adapter 是 `ComputeAdapter` 的独立实现，两者共享的只有 `RunStore` 的磁盘布局思想，不共享代码（AD-4 的教训：契约不同就别硬塞）。

#### 1.1.1 文件划分

| 文件 | 切片 | 内容 | 依赖 |
|---|---|---|---|
| `compute/lifecycle.ts` | CB-1 | 三轴状态机：常量表 + `transition()` 纯函数 + 不变式。**零 IO、零 import 仓库其他模块** | — |
| `compute/plan.ts` | CB-1 | `ComputePlan` schema、`planDigest()`（canonical JSON，排除 `workspaceRoot`）、`validatePlan()`、成本估算字段的形状 | `simulation/platform.ts` 的 `canonicalJson`（今天是模块私有函数 `:34-42`，**需导出**，1 行改动，α 所有） |
| `compute/target.ts` | CB-1 | `TargetRef` union、`ComputeAdapter` 接口、`AdapterCapabilities`、`SshHost` schema（只校验、`available:false`） | — |
| `compute/approval.ts` | CB-1（前移，X-1） | `ComputeApproval`：落 `decision` record、写 `job.json.approval`、`consume()` 原子消费、`verifyDigest()` 执行前重验。**只做语义，不做入口** | `project/records.ts` `RecordStore`（只用既有 `create/link/update`） |
| `compute/job_store.ts` | CB-1 | 磁盘真源：`<experimentsDir>/compute/jobs/<jobId>/` 目录布局、`job.json` 原子写（临时文件 + rename）、`rev` CAS | — |
| `compute/uploads.ts` | CB-3 | deny-list / gitignore 感知 / 文件数与字节双限额 / sha256 / symlink 拒绝 / `preflight()` 重验。**纯函数 + 只读 fs** | — |
| `compute/broker.ts` | CB-1/2 | `ComputeBroker`：`plan → approve → dispatch → poll → collect → release` 编排；admission limit；`recover()`；把 adapter 的 handle 落进 job_store | 上面全部 + `llm/budget.ts` `BudgetLedger`（可选注入） |
| `compute/adapters/local.ts` | CB-2 | 第一个 `ComputeAdapter`：本地子进程 + `job` 目录作「持久卷」；`recover()` 三分支（还在跑 / 已完成 / 已丢失）照 `SubprocessSimulationPlatform.poll()` 的顺序（**先看 exit-code 文件再看 pid**，`platform.ts:258-300`） | `simulation/platform.ts` 的 `resolvePython()`、`isProcessAlive` |
| `compute/adapters/modal.ts` | CB-4 | `modal` npm SDK（pin 0.9.0）；client 按凭据摘要池化（上限 4）；Volume 名 `sha256(project\0jobId)[:32]`；ownership tags `spark_job=<jobId>` / `spark_project=<sha256(slug)[:20]>`；ready 哨兵；harvest/reconcile/recover/release；`recoveryFailure()` 分类 | `target.ts` + `connectors/base.ts` 的 `CredentialProvider` |
| `compute/sim_bridge.ts` | CB-6 | `planFromPrepared(prepared, target)`、`materializeHarvest(runDir, harvest)`：把 `PreparedRun` 翻译成 `ComputePlan`，把收割结果回填成 `RunStore` 认得的 `done.json` + 产出文件 | `simulation/models.ts` 类型 + `plan.ts` |
| `compute/cli.ts` | CB-5 接线 | `spark-research compute plan/approve/reject/run/status/list/collect/cancel/release/targets` | `approval/gate.ts`（见下） |
| `approval/gate.ts` | CB-5 接线 | **从 `lab/cli.ts:150-251` 搬出**的 V19 TTY 门 `requireApprovalGate()`，参数化 env 变量名；lab 与 compute 共用一份 | — |
| `server/routes/compute.ts` | CB-5 接线 | HTTP 投影：`/api/compute/machine`（从 lifecycle 转移表推导，照 `server/routes/lab.ts:52-68` 的 `/machine`）、`/jobs`、`/jobs/:id`、`/jobs/:id/approve`（actor 必填，照 `lab.ts:32-37`）、`/jobs/:id/reject`、`/jobs/:id/collect` | — |
| `tests/helpers/compute_contract.ts` | CB-1 | 参数化契约测试套件（照 `tests/helpers/simulation_contract.ts:17-37` 的 `SimulationContractCase` 形状）：同一组断言跑 local 与 modal（录制回放） | — |
| `tests/helpers/compute_driver.ts` | CB-6 | SIGKILL e2e 的被杀进程（照 `tests/helpers/experiment_driver.ts` / `wet_driver.ts`） | — |

**明确不建**：`compute/adapters/ssh.ts`。`target.ts` 里只有 `SshHost` schema 与 `{ kind: "ssh" }` 联合成员，注册表里标 `available:false, reason:"v0.5 只留槽位"`。火山引擎 / RunPod 连 schema 都不写，记 BACKLOG。

#### 1.1.2 三轴 lifecycle（相对 COMPUTE_DESIGN §1.5 的一处偏离）

```
execution: planned → awaiting_approval → approved → queued → starting → running
                  ↘ (approvalRequired=false) ↗
           running → succeeded | failed | timed_out | cancelled | interrupted
           awaiting_approval → rejected
           interrupted → running | succeeded | failed     （recover 后由 adapter 裁定）
delivery:  none → pending → complete | rejected | failed ；failed → pending（retry_delivery）
resource:  none → starting → active → closed | unknown
recoverable: boolean
```

**偏离**：上游是 `awaiting_approval → queued`，本文插入 `approved`。理由与湿实验 D-10 一致（`lab/wet_models.ts:30-35`）：「批了」与「动手了」必须是两个状态，approval 在 `approved → queued` 那一次转移里被**一次性消费**（`consumedApproval` 存档），崩溃重启后 approval 已经不在，无法凭空重派。

**不变式**（每条一个对抗测试，写在 `tests/unit/compute_lifecycle.test.ts`）：

| # | 不变式 | 违反时 |
|---|---|---|
| L-1 | 转移表之外的 (state, event) 一律 `throw ComputeStateError`，不顺手纠正 | — |
| L-2 | `dispatch` 只有两条入边：`approved`（必须携带未消费的 approval，且 `approval.planDigest === job.plan.digest`）或 `planned`（仅当 `plan.approvalRequired === false`） | 任何 `planned → queued` 的 billable plan 必须红 |
| L-3 | `plan.approvalRequired` 是**派生值**：`adapter.capabilities().billable || plan.network !== "none" || plan.secretRefs.length > 0`；调用方不能传 | 构造 `approvalRequired:false` 的 modal plan → `validatePlan` 红 |
| L-4 | `resource: active → closed` 在 `recoverable === true` 时 throw（「不许关掉持有唯一可恢复产物副本的资源」，上游 lifecycle.ts:200-205） | — |
| L-5 | `delivery` 只能在 `execution` 进入终态之后离开 `none` | — |
| L-6 | `execution` 终态后 `recoverable` 只能由 `delivery=complete` 或 `release` 置 false | — |
| L-7 | 全部三轴与 `recoverable` 的组合空间由测试**穷举**（笛卡尔积 × 事件表），断言「合法集合 = 显式表」 | 表外任何一条可达路径 → 红 |

#### 1.1.3 Plan 与 digest

抄 COMPUTE_DESIGN §1.2 的字段集，四处 Spark 化：

1. **`command` 是 `string[]`（argv），不是 shell 字符串**。上游用 `bash -lc '<cmd>'`；本文拒绝——被审批的东西不该再经过一次 shell 展开。远端侧由 adapter 生成 `exec` 形式的调用。
2. **`env` 只允许非密钥**：`validatePlan()` 对 key 名跑 `redactSecrets`（`llm/types.ts:78-83`）同源的模式，命中即拒。密钥只能走 `secretRefs`（符号名）。
3. **digest 排除 `workspaceRoot`（绝对路径）**，与上游 plan.ts:358-360、Spark `protocolHash` 不含时间戳同一思想。**其余全部进 digest，包括 `estimate`**——价格表变了就该重新批。
4. **`estimate` 用 PRICING 的纪律**（`llm/providers/registry.ts:19-37`）：`unitPriceUsd` 必须带 `source` + `verifiedDate`，查不到就是 `null`，`upperBoundUsd` 随之 `null`；**绝不填 0**。

#### 1.1.4 审批：与 `WetLabLoop` 逐条对照（这是 CB-5 的成败判据落点）

| 湿实验（已验证机制） | 算力（本设计） | 位置 |
|---|---|---|
| `approve()` 只在 `awaiting_approval`；缺 `protocolHash` 拒；`actor` 必填（`wet_loop.ts:371-386`） | 同；缺 `plan.digest` 拒；`actor` 必填 | `compute/approval.ts` |
| 落 `decision` record：`evidence:"inferred"`、`origin:{kind:"manual"}`、`metadata.kind:"approval"`、`protocolHash`（`wet_loop.ts:387-418`） | 同形；`metadata` 换 `planDigest` / `jobId` / `target` / `estimate` / `warningShown:true` / `uploadsCount` / `uploadBytes`；`derives_from` 边指向 experiment record（若有） | 同上 |
| `approval` 存进 experiment meta（`wet_models.ts:129`） | 存进 `job.json.approval`（磁盘真源，K-3） | `job_store.ts` |
| 重新 compile 作废旧 approve（`wet_loop.ts:262-304`） | 重新 `plan()` 得到新 digest → 旧 approval 作废（`job.json.approval=null`，留 `supersededApproval`） | `broker.ts` |
| `execute()`：状态必须 `approved`、hash 重验、CAS 声明执行权并消费 approval（`wet_loop.ts:508-560`） | `dispatch()`：同四步；CAS 用 `job.json.rev`；**再加第五步**：`uploads.preflight()` 逐文件重验 path/size/sha256（上游 adapter.ts:399-415，`input_changed`） | `broker.ts` + `uploads.ts` |
| `executing` 撞上并发 → `WetExecutionConflictError`（409） | `queued/starting/running` 撞上并发 → `ComputeDispatchConflictError`（409） | — |
| 拒绝落 `decision`，`approval=null`（`wet_loop.ts:438-487`） | 同 | — |
| MCP 不暴露 approve/reject/simulate（`mcp/tools.ts:704-732`） | `MCP_WITHHELD` 追加 `compute_approve` / `compute_run` / `compute_release`（理由见 §1.1.8） | 收口接线 |
| CLI 审批要 TTY（`lab/cli.ts:150-251`） | 同一份代码搬到 `approval/gate.ts`，compute 的旁路 env 名 `SPARK_RESEARCH_COMPUTE_CI_BYPASS_TOKEN` | W5-2 β |
| HTTP 审批 actor 必填、`actorSource:"http:explicit"`（`server/routes/lab.ts:32-37`） | 同 | W5-2 β |

**「批的是哪一版、批了几次、花了多少」怎么查**：`decision` record 的 `metadata.planDigest` + `jobId`；`spark-research compute status <jobId>` 打印 `approval`/`consumedApproval`/`supersededApproval` 三段；`records timeline --type decision` 直接可查。`observation` record 的 `metadata` 带 `planDigest`、`decisionRecordId`、`actualCostUsd | null`。

#### 1.1.5 磁盘真源布局

```
<project>/experiments/compute/jobs/<jobId>/
  plan.json        审批对象本体（含 digest；只在 plan() 时写，之后只读）
  job.json         三轴状态 + rev + approval/consumedApproval/supersededApproval + adapterHandle
  uploads.json     preflight 时刻的 {path,size,sha256} 快照（与 plan.uploads 逐条对账）
  run.log          远端 tee 回本地（local adapter 直接写这里）
  exit-code        终态标记（local adapter 由 runner 写；modal 由 harvest 拉回）
  harvest/         收割下来的 outputs
```

`jobId` 形如 `cj-<base36 时间>-<uuid8>`，与 `RunStore` 的 runId 风格一致（`platform.ts:211`）。

#### 1.1.6 adapters

- **local**（CB-2）：`run()` = `Bun.spawn(command, { cwd: <job>/workspace, stdout/stderr → fd 文件 })`，与 `platform.ts:218-233` 相同的「落文件不 pipe」理由。`recover()` 顺序：`exit-code` 存在 → 收割；否则 pid 活 → reattach（只轮询）；否则 → `interrupted → failed(recoverable=true)`。**它承担全部契约测试**（CI 零凭据）。`capabilities()` = `{ billable:false, persistentVolume:false, recovery:true, secretRefs:false }`。
- **modal**（CB-4）：照 COMPUTE_DESIGN §1.3-1.4 逐条实现；`check()` 用 `apps.list()` 之类的只读调用做连通性探测（供 `capabilities --probe`）。e2e 两档：`tests/fixtures/compute/modal/*.json` 录制回放（CI）；真实冒烟手动。**录制层**：SDK 是 gRPC 不走 `HttpClient`，`http/fixture.ts` 的机制套不上——adapter 内部所有 SDK 调用经一个 `ModalGateway` 接口（`createSandbox / getSandbox / readVolume / writeVolume / deleteVolume / listByTag`），测试注入 `RecordedModalGateway`。这是 CB-4 唯一的新机制，写进 lane 任务书。
- **ssh**：只有 `SshHost` schema（host key 指纹钉死、ProxyJump 逐跳、identity 路径禁 `%$`、user 禁 `@`、并发 1-100），`validateSshHost()` 有单测；`targets()` 列出它但 `available:false`。

#### 1.1.7 上传面（CB-3）

纯函数层，输入 `workspaceRoot + requested paths` → 输出 `UploadEntry[]` 或结构化拒绝：

- deny-list 目录（`.git .ssh .aws .kube node_modules .venv __pycache__ …`）、路径正则（`.config/(gcloud|gh)`）、密钥文件名正则（`.env* .netrc credentials.json *.pem|key|p12`）——**fail-closed**：显式请求命中即抛 `UploadDeniedError`，不静默跳过。
- gitignore 感知：优先 `git check-ignore --no-index` 批量；无 git 回退自解析 `.gitignore` + `.git/info/exclude`。
- 双限额：`COUNT_LIMIT=200` / `BYTES_LIMIT=256 MiB`（数字写成常量并进 capabilities，审批面显示）。
- symlink 一律不跟（穿过即拒）。
- `preflight(entries)`：dispatch 前逐文件重验 canonical 路径、size、sha256，任一不符 → `UploadChangedError`（`input_changed`）。

#### 1.1.8 接线面

| 入口 | 内容 | 谁做 |
|---|---|---|
| CLI `compute` | `plan`（从 `--command/--upload/--output/--gpu/--timeout` 或 `--from-experiment <id>`）· `approve <jobId>`（TTY 门；`--run` 顺带派发）· `reject` · `run <jobId>`（dispatch）· `status` · `list` · `collect` · `cancel` · `release` · `targets` | W5-2 β |
| HTTP | `server/routes/compute.ts`，`app.route("/api/compute", …)`（`server/app.ts:223-239` 那一段） | W5-2 β 写文件，`app.ts` 一行由收口接 |
| MCP 暴露 | `compute_plan`（无副作用，返回 digest + warning + 逐文件清单 + `humanAction`）· `compute_status` · `compute_list` · `compute_collect`（只在 `delivery=pending` 时有意义） | 收口接 `mcp/tools.ts` |
| **MCP 扣留** | `compute_approve`（花真钱的批准，AD-6 同构）· `compute_run`（派发 = 计费动作本身，与 `lab_simulate` 同构：「只允许从 approved 经人工进入」）· `compute_release`（删远端卷 = 破坏性，与 `project_archive` 同构） | 收口接 `MCP_WITHHELD`；`sub_agent.ts:137-147` 的 `assertNoWithheldGrants` 从同一张表派生，**自动覆盖 AD-14** |
| ToolBus 计价 | `ToolCallCost.unit: "call" \| "computeSeconds"`（`agents/toolbus.ts:72-93`）；`costOf()` 对 `compute_*` 仍返回 `null`——**agent 经 MCP 只能 plan/查状态，从不派发**，真实花费由 broker 在 harvest 后 `BudgetLedger.record({ costUsd })`（`llm/budget.ts:134`）。broker 的 ledger 由调用方注入（orchestrator 的 `sessionBudget`，`agents/orchestrator.ts:806`） | W5-2 β |
| capabilities | `CapabilityManifest.compute: { targets: ComputeTargetCapability[] }`，从 adapter 注册表推导；`narrative_parity` 加断言「文档声称 target 数 = 注册表」 | 收口接 `capabilities/index.ts` |
| 证据图 | 桥路径：沿用 `ExperimentLoop.ingestOutputs()`（`experiment/loop.ts:290-335`）与 observation（`:354-384`），`metadata` 增 `computeTarget / planDigest / computeJobId / decisionRecordId / actualCostUsd`；通用路径（`compute run` 非实验）：一条 `observation`（`kind:"compute_output"`, `evidence:"computed"`）+ harvest 文件各一条 artifact record | W5-3 α |

#### 1.1.9 CB-6 判断：并列 + 桥，不加实验状态

**结论：做，作为「桥」，且不动 `EXPERIMENT_STATES`。** 理由：

1. `SimulationPlatform.submit()` 契约 #2 非阻塞（`simulation/models.ts:90-94`）与审批门不相容（K-1）。
2. 给干实验状态机加 `awaiting_compute_approval` 会触发纪律 13 的全套消费方清扫（前端状态名字符串比较、MCP 描述、llms.txt、SKILL.md）——v0.3.0 就是这么回归的。**v0.5 不冒这个险。**

**桥的形状**（`compute/sim_bridge.ts` + `experiment/loop.ts` 一个分支 + `experiment/models.ts` 两个字段）：

- `ExperimentMeta`（`experiment/models.ts:48-70`）增 `computeTarget: "local" | "modal" | null` 与 `computeJobId: string | null`（可选字段，老 record 缺省 = local，不迁移）。
- `exp new --target modal` 写入 `computeTarget`。
- `ExperimentLoop.run()` 在 `dry_run` 分支：`computeTarget` 为 null → 原路径不变；否则 `platform.prepare()` 照旧（本地归一化、`stageDir/params.json`），然后 `planFromPrepared()`：`command = [python, "runner.py", "--params", "params.json", "--outdir", "."]`，`uploads = [runner.py, sim_runtime.py, params.json]`，`outputs = expectedOutputs + ["done.json","progress.json","stdout.log"]`，`resources.gpu` 从 `--gpu` 或 platform 默认（openmm 默认 `null`，用户显式要）。写 `computeJobId`，状态**停在 `dry_run`**，`lastError = null`，`exp status` 显示「算力 job <id> 等待审批：spark-research compute approve <id> --run」。
- 人批准并派发后，`exp run <id> --resume` → `broker.poll(jobId)` 而不是 `platform.poll(runId)`；`delivery=complete` 后 `materializeHarvest()` 把 harvest 目录回填成 `RunStore` 认得的 `<runs>/<runId>/` （`done.json` + 产出 + `run.json`，`run_store.ts:18-34`），随后 `platform.collect(runId)` **原样工作**，`ingestOutputs()` 原样工作。
- 因此 `SimulationPlatform` 接口、`SubprocessSimulationPlatform`、`openmm/index.ts`、`pyref` **零改动**；`simulation/registry.ts` 零改动（这也为 W5-3 β 的平台三件套让路）。

**验收**（方案 §3.3 原样）：真实 OpenMM 任务 plan → approve（digest 一次性消费）→ dispatch → 本地进程 SIGKILL → 重启 `exp run --resume` 收割 → observation 进图。CI 版用 local adapter 跑同一条路径（`tests/unit/compute_e2e.test.ts` + `compute_driver.ts`），Modal 版录制回放 + 手动冒烟。

#### 1.1.10 凭据（AD-2）

- Modal token 存 `credentials.json` 的 `connectors.modal = { token_id, token_secret }`——`CredentialStore` 本来就是按 id 键控的 KV（`daemon/credentials.ts:76-80`），不为 compute 另起存储。
- adapter 拿到的是 `CredentialProvider`（`connectors/base.ts:31-34`）——与 connector 同一接口，`get("modal")` 只在 broker 所在进程（CLI/server）内解析；kernel 侧 permit set 不变（`python_kernel` 只有 `credentials` 元数据方法）。
- `secretRefs` 在 dispatch 时刻 `provider.get(ref)` → `modal.secrets.fromObject(...)` → 用完即弃；`job.json`/`plan.json` 只有符号名。测试：把 `credentials.json` 内容当 needle，grep 整个 job 目录与所有 record content → 零命中。

### 1.2 C4 · embedding 抽象与 novelty 语义化

#### 1.2.1 位置与层次

```
backend/src/llm/embeddings/
  types.ts           EmbeddingAdapter / EmbedRequest / EmbedResponse（AD-13 同构：ok=false ⇒ vectors=null）
  openai_compat.ts   POST {baseUrl}/v1/embeddings —— 覆盖 openai / qwen(DashScope 兼容模式) / ollama / vLLM / 自建
  router.ts          EmbeddingRouter：读 config `embeddingModel`（形如 "openai/text-embedding-3-small" / "local/nomic-embed-text"），
                     解析 provider → apiKey（复用 PROVIDER_API_KEY_ENV，providers/registry.ts）→ baseUrl（复用 router.ts 的 ADAPTERS baseUrl 与 LOCAL_BASE_URL_ENV）
  calibration.ts     SEMANTIC_THRESHOLDS: { [modelId]: { high: number, calibratedOn: string, sampleSize: number, source: "tests/fixtures/novelty/calibration.json" } }
```

**与 `ProviderAdapter` 的关系：同层（都是 provider 适配器），不同契约。** 不让 `EmbeddingAdapter extends ProviderAdapter`——`ProviderRequest`（`llm/providers/types.ts:17-25`）有 `messages/options/tools`，embedding 一个都用不上；硬套只会造出一个「messages 恒空」的假请求。**复用的是基础设施**：`failure()`/`llmFailure` 的 AD-13 纪律、`redactSecrets`、`providerApiKeyEnv`、`configuredLlmTimeoutMs`、`fetchImpl` 注入、`HttpClient`（**embedding 走 `http/client.ts` 的 `HttpClient` 而不是裸 fetch**——这样 `http/fixture.ts` 的录制回放零改动可用，见 §1.2.4）。

Ollama：规划目录 §(b) 写「原生端点 `/api/embeddings`，是否兼容 `/v1/embeddings` 未核实」。本文的选择：**只实现 OpenAI 兼容形状**（`/v1/embeddings`），Ollama 通过其 OpenAI 兼容层接入；lane β 开工第一件事在本机 Ollama 上核一次这个端点，核不过就加 `ollama_native.ts`（`/api/embed`）——两种都在 β 的所有权内，不影响别人。

#### 1.2.2 novelty 怎么消费

现状：`ideation/affinity.ts:73-98` 的 `coverage()`/`claimAffinity()` 是词面覆盖率；`ideation/novelty.ts:49` `HIGH_AFFINITY = 0.75`；`constrainRating()`（`novelty.ts:391`）用 `candidate.affinity` 约束评级；`NoveltyDeps`（`novelty.ts:617-631`）有 `highAffinity?` 注入位。

改动（全部在 β 所有权内）：

1. `NoveltyCandidate`（`novelty.ts:159`）增 `semanticAffinity: number | null` 与 `affinityBasis: "semantic" | "lexical"`。
2. `NoveltyDeps` 增 `embedder?: Pick<EmbeddingRouter, "embed" | "modelId">`。检索完成后一次批量 `embed([...claimTexts, ...candidateTexts])`；`ok=false` → 全部 `semanticAffinity=null`、`affinityBasis="lexical"`，并在报告「口径说明」写明「embedding 不可用（<error.kind>），本次按词面」——**不静默降级**（`feedback_silent_fallback_logging` 同一纪律）。
3. `constrainRating()` 的门槛取 `basis === "semantic" ? SEMANTIC_THRESHOLDS[modelId].high : HIGH_AFFINITY`；**模型未标定 → 强制 lexical**（`affinityBasis="lexical"`，即便 embed 成功——向量算出来了也不拿来做约束，只在报告里作参考列）。
4. 报告（`renderNoveltyReport`，`novelty.ts:519`）每个候选两列：词面 / 语义；「口径说明」写清本次的 basis、模型、阈值与标定日期。AD-8「模型原判与校正后都留」不变，再加一层「两种相似度都留」。

#### 1.2.3 重标定：样本从哪来

这是 C4 真正的难点，规划目录没回答。本文的答案：

| 来源 | 数量 | 怎么构造 |
|---|---|---|
| **已发表（existing）** | ≥10 claim | 从**既有 fixture 磁带**里挑真实论文（`tests/fixtures/literature/*.json`，P2 起录制的 OpenAlex/EuropePMC/arXiv 真响应；`tests/fixtures/proteins/` 亦可）。每篇写一条**改述**的 claim（不抄标题，换措辞、换语序、允许中文），正样本 = 该论文，负样本 = 同磁带里同领域的 3 篇邻近工作 |
| **杜撰组合（novel）** | ≥10 claim | 把两个磁带里不相干的方法/对象拼成一条 claim（照 devlog P4 标定表 (b) 的做法），最近邻从全部磁带候选里取 |
| **P4 原有 2 条** | 2 | 原样保留，作为历史对照 |

落盘 `tests/fixtures/novelty/calibration.json`：`{ claim, lang, expected: "existing"|"novel", positives: [paperKey], negatives: [paperKey], cassette }`。

**向量从哪来、CI 怎么跑**：embedding adapter 走 `HttpClient` → `FixtureHttp` 录制 `/v1/embeddings` 的响应到 `tests/fixtures/embeddings/<modelId>.json`（`http/fixture.ts` 的 key 是 method + 规范化 URL + body hash，POST body 里的文本经 `bodyHash` 区分，**请求头永远不落盘**——凭据结构上进不了 fixture）。CI 回放，零网络。

**标定测试**（`tests/unit/novelty_calibration.test.ts`）：对每个已标定模型，算 20+ 条 claim 的正/负余弦分布，断言 `SEMANTIC_THRESHOLDS[model].high` 落在「最高负样本」与「最低正样本」之间且**两侧余量各 ≥ 0.05**；`sampleSize` 必须等于 calibration.json 条数（登记表对撞真源，narrative_parity 纪律）。阴性对照：把阈值改 ±0.1 → 红；删 5 条样本 → `sampleSize` 对不上 → 红。

**用哪个模型录**：由 lane β 按用户实际持有的 key 决定——首选 `openai/text-embedding-3-small`（用户若有 `OPENAI_API_KEY`），备选本机 Ollama `nomic-embed-text`（零 key）。**只对录过 fixture 的模型登记阈值**；表里没有的模型永远回退词面（K-4）。

#### 1.2.4 配置与 capabilities

- `CONFIG_SETTINGS` 增 `embeddingModel`（`config/index.ts:99` 那张表；`envVar: "SPARK_RESEARCH_EMBEDDING_MODEL"`，默认 `null` = 词面）。
- `CapabilityManifest` 增 `embedding: { configured: boolean; model: string | null; calibrated: boolean; threshold: number | null }`——外部 agent 在 novelty 之前就知道本机是词面还是语义（AD-12）。这一段改 `capabilities/index.ts`，收口接。

### 1.3 C5-② · SMILES → 2D 结构图

#### 1.3.1 形态

```
backend/src/chem/
  depict.py     stdin JSON {smiles, width?, height?} → stdout JSON {ok, svg, canonicalSmiles, formula, molWeight, rdkitVersion} | {ok:false, error}
  depict.ts     depictSmiles(input, deps): 起子进程（resolvePython()，simulation/platform.ts:26-31）→ 校验 SVG（以 "<svg" 开头、无 <script>）→ ArtifactStore.save() → artifact record
  cli.ts        spark-research chem depict "<SMILES>" [--name mol] [--json]
server/routes/chem.ts   POST /api/chem/depict {smiles, name?}
```

- **为什么是子进程不是 `PythonKernel`**（异议 X-5）：一次 depict 是 100ms 级的无状态调用，不需要常驻 kernel；走 daemon 会把 `ControlRepl`/permit 一并拖进来（`simulation/platform.ts:23-26` 已为仿真层做过同样判断）。`rdkit>=2023.9` 已在 `pyproject.toml` 依赖里，**零新依赖**。
- **artifact 通道**：`ArtifactStore.save()`（`artifacts/store.ts:172-232`）已把 `.svg` 映射为 `image/svg+xml`（`:65-82`）。`depict.ts` 先把 SVG 写到 `<project>/artifacts/tmp/<name>.svg` 再 `save()`，`lineageMessages` 记 `{kind:"write", file, content:"rdkit depict <canonicalSmiles>"}`；然后 `records.createFromArtifact(saved, { evidence:"computed", metadata:{ kind:"chem_depiction", smiles, canonicalSmiles, formula, molWeight, rdkitVersion } })`（同 `experiment/loop.ts:316-333` 的用法）。
- **前端**：`center.tsx:355-400` 的 `ArtifactsView` 只有 `.md` 与 `<pre>` 两个分支。加第三个：`contentType === "image/svg+xml"` → `<img src={"data:image/svg+xml;utf8," + encodeURIComponent(body)} />`。用 `<img>` 而不是 innerHTML：SVG 里即便混入 `<script>` 也不会执行——后端已校验，这是第二道。**不引入任何前端依赖**（AD-7）。
- **入口**：CLI `chem` 是 `index.ts` 新 `case`；MCP `chem_depict`（`request: POST /api/chem/depict`，`present` 里写「产物 id + 在工作台「产物」页可看」）。
- **不建 SKILL.md**：这是一个能力原语，不是技能；不占方案 §2.2 的技能配额。以后 chem 类技能集成时再写。

#### 1.3.2 验证

- 单测：合法 SMILES → SVG 合法 + record 形状；非法 SMILES → `ok:false` 且**不落任何 record/artifact**（阴性对照：让脚本对非法输入吐空 SVG → 断言必须红）；rdkit 缺失 → 可操作的错误信息（照 `PlatformAvailability.reason` 口径）。
- `ui_cli_parity.test.ts` 加第四组：CLI depict 与 HTTP depict 的 record 指纹一致。
- Playwright 新增一条「⑭ depict → 产物列表出现 .svg → `img.naturalWidth > 0`」。

### 1.4 C2 / C3 · 集成流水线（可重复 checklist）

#### 1.4.0 前置：V26 限速器（先于任何 NCBI 系 connector）

```
backend/src/http/ratelimit.ts
  HOST_RATE_POLICIES: Record<host, { rps: number; burst: number; source: string; verifiedDate: string }>
  class RateLimitedHttp implements HttpClient   // 装饰器：按 new URL(url).host 取令牌桶，同 host 的所有 connector 共池
  rateLimitedHttp(inner: HttpClient = defaultHttp): HttpClient
```

- 键控是 **host**，不是 connector（方案 §0.2·补 的结论）。首批策略：`eutils.ncbi.nlm.nih.gov` 3 rps（匿名，NCBI 官方文档 NBK25497 口径，lane 录入时附 URL 与核实日期）、`rest.kegg.jp` 3 rps、`api.crossref.org` / `api.openalex.org` 按其 polite pool 文档。**没写来源的数字不许进表**（PRICING 同一纪律）。
- 接线点：`ConnectorRegistry` 构造函数（`connectors/registry.ts:90-92`）`this.options.http ?? rateLimitedHttp()`；注入的 `http`（fixture/stub）**不包**，测试确定性不受影响。
- 测试：`tests/concurrency/host_ratelimit.test.ts`——`pubmed` + `ncbi` + 一个 staged eutils connector 各 40 并发打一个 `StubHttp` 计时器，断言任意 1s 窗口内落到 `eutils.ncbi.nlm.nih.gov` 的请求 ≤ `rps + burst`；阴性对照：去掉装饰器 → 红；把 key 改成 connector 名 → 三者各自 3 rps 合计 9 → 红。
- **门禁**：`narrative_parity` 加一条「`BUILTIN_CONNECTORS` 里 `metadata.domain` 属于 `eutils.ncbi.nlm.nih.gov` 的 connector 数 ≥ 2 时，`HOST_RATE_POLICIES` 必须有该 host」——把「先限速再集成」从纪律变成红绿。

#### 1.4.1 分流判据（做在集成第一步，不做在最后）

| 判据 | 走 P15 声明式 manifest（`connectors/manifest.ts`，`ext verify` 自动过并发不变式） | 走 TS connector（`HttpConnector` 子类） |
|---|---|---|
| 响应 | JSON | XML / text / 200+空 body 分支（BindingDB） |
| 请求 | 单次 | 多跳（esearch → esummary） |
| 参数 | 可枚举/可类型化 | 需要运行期改写（`query→term`、固定 `db=`） |
| 本批候选 | biorxiv（JSON 单跳，`server` 枚举）· string-db（JSON）· reactome（JSON） | clinvar（eutils 两步）· opentargets（GraphQL POST，多实体要拆 tool） |

规划目录的 staged 全部是 TS 形态（`workstreams/connectors/staged/clinvar.ts` 等）。**分流不是为了省事，是为了让能走 manifest 的源自动获得 `ext verify` 的 100 并发不变式**；走不了的照 TS 集成，并发不变式手写进 `tests/concurrency/connector_race.test.ts`。

#### 1.4.2 connector 集成 checklist（每个源一份，写进 lane devlog）

```
□ 0  拉动来源写清：F-1 缺口 / 用户课题 / 已集成能力短板（三选一，写不出来不集成）
□ 1  分流判据（§1.4.1）填表；决定 manifest 还是 TS
□ 2  若 host 属 NCBI/KEGG 等限速主机：确认 HOST_RATE_POLICIES 已有该 host（否则先做 §1.4.0）
□ 3  从 staged/<id>.ts 拷入 backend/src/connectors/<id>.ts；去掉文件头 STAGED/UNTESTED 段；
     metadata.caveat 只留对用户有用的限制（限速/字段版本差异），删「未测试」字样
□ 4  staged/<id>.test.ts → tests/unit/connector_<id>.test.ts（string-db → connector_string_db）
□ 5  FIXTURE_MODE=record bun test tests/unit/connector_<id>.test.ts → tests/fixtures/<domain>/<id>.json；
     检查 fixture 里无 api_key/mailto 等（http/fixture.ts VOLATILE_QUERY_KEYS 已剔除，但仍人工 grep 一次）
□ 6  把录制块从 skipIf(!RECORDING) 改成常规回放用例（不许留 skip：方案 §6.1「0 skip」）
□ 7  注册两处：BUILTIN_CONNECTORS（按域）+ CONNECTOR_CLASSES（connectors/registry.ts:36-88）；
     新域（pathways/omics）在 BUILTIN_CONNECTORS 加 key，domainOf() 自动认
□ 8  三道门：
     ① AD-5 收紧版——本 connector 至少被一条可达入口消费（lit search 的 sources / 某技能 / MCP 工具），
        且出现在 capabilities --json 的 connectors 里（自动）；只被测试调用 = 不集成
     ② 并发不变式——manifest 源由 ext verify 自动过；TS 源在 connector_race.test.ts 加一组
     ③ 存储层写入方——本批 connector 不带存储，标 N/A（若某源要落 paper 进 LibraryStore，
        登记进 narrative_parity 的 STORE_WRITE_BINDINGS）
□ 9  narrative_parity「connector 数」断言自动更新；docs/DESIGN.md / README 里若有写死的 connector 数，同 PR 改
□ 10 消费方清扫（纪律 13）：新增 tool 名进 mcp/tools.ts 描述？llms.txt 重生成 diff 为空？
□ 11 六套件全量 + 阴性对照（回退 fixture 里一条响应字段 → 归一化测试必须红）
□ 12 devlog 写：拉动来源、真实网络首测日期、429/403 遭遇与处置
```

#### 1.4.3 平台型技能集成 checklist（scanpy / pydeseq2 / cobrapy）

规划目录已把三者设计成 `dry-experiment` 的新 `SimulationPlatform`（`workstreams/skills/OVERVIEW.md:10,15`；`staged/scanpy/VALIDATION_PLAN.md` 的「生产入口」段）。**接线点 `simulation/registry.ts:7-9` 实测存在且 W5-3 无人争用**（CB-6 桥不动它，§1.1.9）。

```
□ 0  拉动来源（同上）；三件套的拉动 = 方案 §2.3 明示 + AD-4 第三次回本
□ 1  pyproject.toml 加依赖（scanpy/anndata/leidenalg/igraph…）；实测 uv pip install 耗时与 wheel 可用性，
     写进 devlog（VALIDATION_PLAN 已要求）
□ 2  backend/src/simulation/<id>/{index.ts, runner.py}：extends SubprocessSimulationPlatform；
     runner 用 sim_runtime.RunContext（simulation/sim_runtime.py），done.json 原子写
□ 3  registry.ts：SIMULATION_PLATFORM_IDS 加 id + switch 加 case
□ 4  契约测试：tests/unit/<id>_contract.test.ts 用 describeSimulationContract()（tests/helpers/simulation_contract.ts:17-37）；
     环境不可用整套 skip 并打印原因——但 CI 机器必须装（0 skip 基线），lane 报告必须写明本机跑没跑成
□ 5  e2e：离线小数据集进 tests/fixtures/<id>/（VALIDATION_PLAN 明确禁止测试期下载）；
     断言是**科学判据**（scanpy：已知 marker 基因落在某 cluster top 表；pydeseq2：已知差异基因方向；
     cobrapy：已知模型生长率），不是「跑完没报错」
□ 6  Python 侧 tests/sim/<id>_runner.test.py
□ 7  SKILL.md 从 staged 拷入 backend/src/skills/<id>/；frontmatter 的 validation 三个路径必须真实存在（frontmatter.ts 会核）；
     platforms: [<id>] 必须是已注册 id
□ 8  三道门：① 入口 = 复用 exp CLI + exp_design/exp_run MCP —— narrative_parity 的 SKILL_ENTRYPOINTS 加一行
     `"<id>": { cli: ["exp"], mcp: ["exp_design","exp_run"] }`（tests/unit/narrative_parity.test.ts:185）；
     ② ext verify 不适用（仓内平台）→ 契约测试即门；③ 存储层 N/A
□ 9  docs/EXTENDING.md 的「N 个技能」数字（narrative_parity.test.ts:476 会对撞）+ skills/README.md 表 + capabilities 自动
□ 10 六套件 + 阴性对照（把 marker 断言的基因名改错 → 红；删 registry 的 case → 契约测试整套失踪 → 「技能可达性」红）
```

#### 1.4.4 命令型技能：v0.5 明确不集成

规划目录 OVERVIEW 提到「其余 8 个新增 `chem/seq/data/flow/review/critique/scholar` 命令组」。每一个都要动 `index.ts` + `mcp/tools.ts` + `capabilities`，而 R-d 门禁要求 SKILL.md 一落仓就必须有入口——**它们只能成批在收口窗口接线**。方案 §2.2 上限 8 个技能，三件套占 3，剩 5 个配额留给 F-1 外部验收暴露的真实缺口；本文**不预排**任何命令型技能。

#### 1.4.5 写进 `EXTENDING.md` 的两条规范（收口时改文档，不是代码）

1. **湿实验类技能一律汇入 `wet-protocol` 现有审批门，禁止平行审批通道**（规划目录 BATCH_ROLLUP「集成候选」第 5 条；AD-6 在技能层的推论）。同理：**任何计费型动作一律汇入 `compute` 的审批门**——技能不得自己调 Modal SDK。
2. per-tool content-type 覆盖（SureChEMBL 的 form-urlencoded）记 BACKLOG，等真实拉动。

### 1.5 附线的模块设计（简）

| 项 | 设计 | 文件 |
|---|---|---|
| **V25 安全门字段兑现**（W5-1 δ） | 编译器主管线解析浓度（`CONCENTRATION_SIGNAL`，`lab/protocol.ts:275`）为 `ReagentSpec.concentration`（`protocol.ts:3-8` 已有字段）与 `biosafetyLevel` 进 `ProtocolStep.params`；两条规则（`lab/safety.ts:121-160`）从「恒空转」变成真消费；对应的 `unconsumedWarnings` 分支（`protocol.ts:296-307`）**改成只在解析失败时报**，解析成功即消费。阴性对照：把解析器拆掉 → `safety.test` 的「浓度超限必须 fail」红 + `lab_compile.test` 的「已消费不再告警」红 | `lab/protocol.ts` `lab/safety.ts` + 两测试 |
| **V31/V32**（W5-2 δ） | ① `extensions/mcp_client.ts` 的 `.mcp_calls.jsonl`（`:159-178`）之外，每次外部工具调用再落一条 `observation`（`kind:"external_tool_call"`, `evidence:"sourced"`），**并把 `external_tool_call` 加进 `NON_EVIDENCE_RECORD_TYPES`**（`agents/contract.ts:152`）——它是审计不是进展（K-3）；② `createExternalToolRunner()` 接进 `AgentToolBus.options.runner`。**接线点 `agents/orchestrator.ts` 与 `toolbus.ts` 在 W5-2 无人争用**（β 只加 `unit` 值，与 δ 的 runner 替换不在同一函数）——但两者同文件，见 §3.2 的处置 | `extensions/mcp_client.ts` `agents/contract.ts` `agents/orchestrator.ts`（δ 持有 W5-2） |
| **F-3 删别名** | `connectors/base.ts:180-186` 三个别名删除；CHANGELOG breaking 段 | 闸门 F，主会话 |
| **V21 超时前缀** | `SPARK_HTTP/LLM/KERNEL/TASK_TIMEOUT_MS` → `SPARK_RESEARCH_*`，旧名保留一版并打 deprecation warning；纪律 11 的一致性断言随改 | 闸门 F 或收口 |

---

## 二、关键接口签名

> 以下是能直接落进代码的签名，不是伪代码。注释只写「为什么」。

### 2.1 `backend/src/compute/lifecycle.ts`

```ts
export const EXECUTION_STATES = [
  "planned", "awaiting_approval", "approved", "rejected",
  "queued", "starting", "running",
  "succeeded", "failed", "timed_out", "cancelled", "interrupted",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const DELIVERY_STATES = ["none", "pending", "complete", "rejected", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const RESOURCE_STATES = ["none", "starting", "active", "closed", "unknown"] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const LIFECYCLE_EVENTS = [
  "review", "approve", "reject", "dispatch", "start", "run",
  "succeed", "fail", "timeout", "cancel", "interrupt", "recover",
  "deliver", "deliver_ok", "deliver_reject", "deliver_fail", "retry_delivery",
  "resource_start", "resource_active", "close", "lose",
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

export interface LifecycleState {
  execution: ExecutionState;
  delivery: DeliveryState;
  resource: ResourceState;
  /** 远端仍持有唯一可恢复产物副本；为 true 时 close 必须抛错（L-4）。 */
  recoverable: boolean;
}

export interface TransitionContext {
  /** plan.approvalRequired 的派生值（L-3）；dispatch 从 planned 直出只在 false 时合法（L-2）。 */
  approvalRequired: boolean;
  /** dispatch 时必须携带且 digest 相符（L-2）；其余事件忽略。 */
  approval?: { planDigest: string } | null;
  planDigest: string;
  /** recover 后 adapter 裁定的去向。 */
  recoverOutcome?: "running" | "succeeded" | "failed";
}

export const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionState, Partial<Record<LifecycleEvent, ExecutionState>>>>;
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryState, Partial<Record<LifecycleEvent, DeliveryState>>>>;
export const RESOURCE_TRANSITIONS: Readonly<Record<ResourceState, Partial<Record<LifecycleEvent, ResourceState>>>>;

export function initialLifecycle(): LifecycleState; // { planned, none, none, false }
/** 纯函数：非法转移一律 throw ComputeStateError；不做顺手纠正（P5 纪律）。 */
export function transition(state: LifecycleState, event: LifecycleEvent, ctx: TransitionContext): LifecycleState;
export function isExecutionTerminal(s: ExecutionState): boolean;
/** /api/compute/machine 由这两个函数推导，不许手写（AD-12 ③）。 */
export function approvalGate(): { from: "awaiting_approval"; to: "approved"; requires: ["actor"] };
export function dispatchGate(): { from: "approved"; to: "queued"; consumesApproval: true; verifies: ["planDigest", "uploads"] };

export class ComputeStateError extends Error {
  constructor(readonly from: LifecycleState, readonly event: LifecycleEvent, reason: string);
}
```

### 2.2 `backend/src/compute/plan.ts`

```ts
export interface UploadEntry { path: string; size: number; sha256: string }

export interface CostEstimate {
  unit: "computeSeconds";
  quantity: number;                 // timeoutMinutes * 60 —— 上界，不是预测
  unitPriceUsd: number | null;      // 查不到 = null，绝不 0
  upperBoundUsd: number | null;
  source: string | null;            // 定价页 URL
  verifiedDate: string | null;      // ISO date
}

export interface ComputePlan {
  schemaVersion: 1;
  digest: string;                    // sha256(canonicalJson(plan 去掉 digest 与 workspaceRoot))
  target: TargetRef;
  purpose: string;
  command: string[];                 // argv；拒绝 shell 字符串
  cwd: "/workspace";
  env: Record<string, string>;       // validatePlan 拒绝密钥样 key
  image: { base: string; pip: string[]; pipLock: { digest: string; requirements: string } | null } | null;
  secretRefs: string[];              // 符号名；值永不进 plan/job
  resources: { gpu: string | null; cpus: number; memoryGb: number; timeoutMinutes: number };
  network: "none" | "unrestricted";
  uploads: UploadEntry[];
  uploadBytes: number;
  outputs: string[];                 // glob
  approvalRequired: boolean;         // 派生（L-3）
  estimate: CostEstimate;
  warning: string;                   // 明文：「此运行使用你的 <target> 账户并可能计费；上界 $X」
  workspaceRoot: string;             // 绝对路径；排除在 digest 外
}

export type PlanInput = Omit<ComputePlan, "digest" | "approvalRequired" | "estimate" | "warning" | "uploadBytes" | "schemaVersion" | "cwd">;

export function planDigest(plan: Omit<ComputePlan, "digest">): string;
export function buildPlan(input: PlanInput, caps: AdapterCapabilities, pricing: PricingLookup): ComputePlan;
export function validatePlan(plan: ComputePlan, caps: AdapterCapabilities): void; // throw PlanValidationError
export type PricingLookup = (target: TargetRef, gpu: string | null) => Omit<CostEstimate, "unit" | "quantity" | "upperBoundUsd">;
```

### 2.3 `backend/src/compute/target.ts`

```ts
export type TargetRef =
  | { kind: "local" }
  | { kind: "modal"; environment?: string }
  | { kind: "ssh"; hostId: string };        // v0.5 仅占位，available:false

export const TARGET_KINDS = ["local", "modal", "ssh"] as const;

export interface AdapterCapabilities {
  billable: boolean;
  persistentVolume: boolean;
  recovery: boolean;
  secretRefs: boolean;
  network: readonly ("none" | "unrestricted")[];
  gpus: readonly string[];            // 可选 GPU 型号；local 为 []
  uploadLimits: { count: number; bytes: number };
}

export interface RunHooks {
  onLog?: (line: string) => void;
  onState?: (patch: Partial<LifecycleState>) => void;
  signal?: AbortSignal;
}

/** adapter 持有的远端句柄；整体落 job.json.adapterHandle，重启后原样交回 recover()。 */
export interface AdapterHandle {
  kind: TargetRef["kind"];
  /** local: { pid, startedAt }；modal: { sandboxId, volumeName, appName, tags } */
  data: Record<string, string | number | null>;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  handle: AdapterHandle;
}

export interface Harvest {
  files: Array<{ path: string; bytes: number; sha256: string }>;   // 已落到 <job>/harvest/
  logPath: string;
  exitCode: number | null;
  wallSeconds: number | null;
  /** 远端报的退出码与卷上标记不一致时非空（reconcile），调用方标 delivery=failed。 */
  reconcileError: string | null;
}

export interface DispatchSpec {
  jobId: string;
  plan: ComputePlan;
  jobDir: string;                                 // <project>/experiments/compute/jobs/<jobId>
  /** 只在 dispatch 时刻由 broker 解析；adapter 用完即弃，不得写入任何文件。 */
  resolveSecret: (ref: string) => Record<string, string>;
}

export interface ComputeAdapter {
  readonly kind: TargetRef["kind"];
  readonly description: string;
  capabilities(): AdapterCapabilities;
  /** 凭据连通性探测（capabilities --probe 档）；不产生任何远端资源。 */
  check(): Promise<{ ok: boolean; reason: string | null; detail: Record<string, string | number | boolean | null> }>;
  /** 派发并等到执行终态；日志经 hooks 流回。返回后 delivery 仍是 pending——收割是另一步。 */
  run(spec: DispatchSpec, hooks: RunHooks): Promise<RunResult>;
  /** 编排进程重启后：还在跑 → 重挂并等终态；已完成 → 直接返回；已丢失 → 抛 RecoverFailure（分类见下）。 */
  recover(spec: Omit<DispatchSpec, "resolveSecret">, handle: AdapterHandle, hooks: RunHooks): Promise<RunResult>;
  /** 从持久卷/工作目录收割 outputs；**不依赖沙箱还活着**。 */
  collect(spec: Omit<DispatchSpec, "resolveSecret">, handle: AdapterHandle): Promise<Harvest>;
  cancel(spec: Omit<DispatchSpec, "resolveSecret">, handle: AdapterHandle): Promise<void>;
  /** 删远端卷/工作目录；调用前 broker 已按 L-4 保证 recoverable=false。 */
  release(spec: Omit<DispatchSpec, "resolveSecret">, handle: AdapterHandle): Promise<void>;
}

export type RecoverFailureKind = "retryable" | "unauthorized" | "quota" | "ownership_mismatch" | "invalid_request" | "not_found";
export class RecoverFailure extends Error { constructor(readonly kind: RecoverFailureKind, message: string); }

export interface SshHost {
  id: string; host: string; port: number; user: string;
  hostKeyFingerprint: `SHA256:${string}`; hostKey: string;
  identityPath: string; proxyJump: string[]; concurrency: number; scheduler: "none" | "slurm" | "pbs";
}
export function validateSshHost(input: unknown): SshHost;   // 照上游 jobs.ts Host schema 的校验规则
```

### 2.4 `backend/src/compute/approval.ts`（CB-1 内，X-1）

```ts
export interface ComputeApprovalMeta {
  decisionRecordId: string;
  actor: string;
  actorSource: string;          // "explicit" | "http:explicit" | …，照 AD-6 P7 口径
  at: string;
  planDigest: string;
  note: string | null;
}

export interface ApproveInput { actor: string; actorSource?: string; note?: string }
export interface RejectInput  { actor: string; actorSource?: string; reason: string }

export class ComputeApproval {
  constructor(deps: { records: Pick<RecordStore, "create" | "link">; jobs: ComputeJobStore; now?: () => string });
  /** awaiting_approval → approved；落 decision record；写 job.json.approval。actor 空 → ApprovalRequiredError。 */
  approve(jobId: string, input: ApproveInput): { job: ComputeJobView; decisionId: string };
  reject(jobId: string, input: RejectInput): { job: ComputeJobView; decisionId: string };
  /**
   * 执行前重验 + 一次性消费：digest 相符 → 同一次 CAS 写入里 approval→consumedApproval；
   * 不符 → 标 failed 并抛 ApprovalRequiredError（照 wet_loop.ts:522-538）。
   * 由 broker.dispatch() 调用；不对外暴露成入口。
   */
  consume(jobId: string, currentDigest: string, expectedRev: number): ComputeJobView;
}
export class ApprovalRequiredError extends Error {}
```

### 2.5 `backend/src/compute/job_store.ts` 与 `broker.ts`

```ts
export interface ComputeJobRecord {
  jobId: string;
  projectSlug: string;
  experimentId: string | null;          // 桥路径才有
  target: TargetRef;
  lifecycle: LifecycleState;
  rev: number;                          // CAS；照 project/records.ts:340-370 的语义
  approval: ComputeApprovalMeta | null;
  consumedApproval: ComputeApprovalMeta | null;
  supersededApproval: ComputeApprovalMeta | null;
  rejection: (ComputeApprovalMeta & { reason: string }) | null;
  adapterHandle: AdapterHandle | null;
  createdAt: string; dispatchedAt: string | null; finishedAt: string | null;
  exitCode: number | null; message: string | null;
  actualCostUsd: number | null;         // harvest 后填；查不到单价 = null
}
export type ComputeJobView = ComputeJobRecord & { plan: ComputePlan; jobDir: string };

export class ComputeJobStore {
  constructor(root: string);                       // <project>/experiments/compute/jobs
  create(plan: ComputePlan, init: Pick<ComputeJobRecord, "projectSlug" | "experimentId" | "target">): ComputeJobView;
  read(jobId: string): ComputeJobView | null;
  /** 原子写（临时文件 + rename）+ CAS；rev 不符抛 ComputeJobConflictError。 */
  patch(jobId: string, patch: Partial<ComputeJobRecord>, opts?: { expectedRev?: number }): ComputeJobView;
  list(filter?: { experimentId?: string; execution?: ExecutionState[] }): ComputeJobView[];
  dirOf(jobId: string): string;
}

export interface ComputeBrokerDeps {
  jobs: ComputeJobStore;
  adapters: Partial<Record<TargetRef["kind"], ComputeAdapter>>;
  approval: ComputeApproval;
  credentials: CredentialProvider;                 // connectors/base.ts:31-34
  pricing: PricingLookup;
  budget?: Pick<BudgetLedger, "record">;           // 注入 = 花费进账本；不注入 = 只落 job.json
  admissionLimit?: number;                         // 默认 2；超出即显式失败，不排队
}

export class ComputeBroker {
  constructor(deps: ComputeBrokerDeps);
  targets(): Array<{ kind: TargetRef["kind"]; available: boolean; reason: string | null; capabilities: AdapterCapabilities | null }>;
  /** 归一化 + digest + 上传三重过滤；零副作用（不建远端资源、不写凭据）。 */
  plan(input: PlanInput, ctx: { projectSlug: string; experimentId?: string }): Promise<ComputeJobView>;
  /** approved → queued；五步：状态/approval 存在/digest 重验/uploads preflight/CAS 消费；然后 adapter.run()。 */
  dispatch(jobId: string, hooks?: RunHooks): Promise<ComputeJobView>;
  poll(jobId: string): ComputeJobView;             // 只读磁盘
  /** 重启后接回：按 adapterHandle 走 adapter.recover()；RecoverFailure 终态类直接标 failed。 */
  recover(jobId: string, hooks?: RunHooks): Promise<ComputeJobView>;
  collect(jobId: string): Promise<{ job: ComputeJobView; harvest: Harvest }>;
  cancel(jobId: string): Promise<ComputeJobView>;
  release(jobId: string): Promise<ComputeJobView>; // L-4 守在 lifecycle.transition 里
}
```

### 2.6 `backend/src/compute/sim_bridge.ts`（CB-6）

```ts
export function planFromPrepared(
  prepared: PreparedRun,                       // simulation/models.ts:27-44
  target: TargetRef,
  opts: { python: string; runtimePath: string; gpu?: string | null; timeoutMinutes?: number },
): PlanInput;
/** 把 <job>/harvest/ 回填成 RunStore 能读的 <runs>/<runId>/{done.json, outputs..., run.json}；返回 runId。 */
export function materializeHarvest(runStore: RunStore, prepared: PreparedRun, job: ComputeJobView, harvest: Harvest): string;
```

### 2.7 ToolBus 计价（`agents/toolbus.ts:72-93` 的扩展）

```ts
export type ToolCostUnit = "call" | "computeSeconds";
export interface ToolCallCost { unit: ToolCostUnit; costUsd: number | null }
// costOf() 对 compute_* 工具仍返回 { unit:"call", costUsd:null }：agent 经 MCP 不派发，不该在这里计价。
// 真实花费：ComputeBroker.collect() → deps.budget.record({ inputTokens:0, outputTokens:0, costUsd: actual|null, usageUnavailable:false })
```

### 2.8 `backend/src/llm/embeddings/types.ts` 与 `router.ts`

```ts
export interface EmbedRequest {
  model: string;
  input: string[];
  apiKey: string | null;            // 本地端点为 null
  baseUrl: string;
  timeoutMs: number;
  http: HttpClient;                 // http/client.ts —— 让 FixtureHttp 可注入
  signal?: AbortSignal;
}

export type EmbedResponse =
  | { ok: true;  provider: string; model: string; vectors: number[][]; dims: number; usage: { tokens: number; costUsd: number | null; usageUnavailable?: boolean }; error?: undefined }
  | { ok: false; provider: string; model: string; vectors: null;       dims: null;   usage: { tokens: 0; costUsd: null; usageUnavailable: true };  error: LlmError };

export interface EmbeddingAdapter {
  readonly id: string;
  /** 任何失败返回 ok:false，不抛异常（与 ProviderAdapter.call 同约定）。 */
  embed(request: EmbedRequest): Promise<EmbedResponse>;
  batchLimit(): number;
}

export class EmbeddingRouter {
  constructor(opts?: { env?: Record<string, string | undefined>; http?: HttpClient; fetchImpl?: typeof fetch });
  /** config embeddingModel 解析结果；null = 未配置（novelty 走词面）。 */
  modelId(): string | null;
  configured(): boolean;
  embed(texts: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<EmbedResponse>;
}

export function cosine(a: number[], b: number[]): number;   // 纯函数，单测钉住数值
```

`calibration.ts`：

```ts
export interface SemanticThreshold { high: number; calibratedOn: string; sampleSize: number; source: string }
export const SEMANTIC_THRESHOLDS: Readonly<Record<string, SemanticThreshold>>;   // 只登记录过 fixture 的模型
export function semanticHighAffinity(modelId: string | null): number | null;      // 未登记 = null → novelty 强制词面
```

### 2.9 `backend/src/chem/depict.ts`

```ts
export interface DepictInput { smiles: string; name?: string; width?: number; height?: number }
export interface DepictResult {
  ok: true; svg: string; canonicalSmiles: string; formula: string; molWeight: number; rdkitVersion: string;
  artifactId: string; recordId: string; path: string;
}
export interface DepictFailure { ok: false; error: { kind: "invalid_smiles" | "rdkit_unavailable" | "timeout" | "bad_output"; message: string } }
export interface DepictDeps { artifacts: ArtifactStore; records: RecordStore; python?: string; timeoutMs?: number; projectSlug: string; sessionId?: string | null }
export async function depictSmiles(input: DepictInput, deps: DepictDeps): Promise<DepictResult | DepictFailure>;
export function assertSafeSvg(svg: string): void;   // 以 <svg 开头、无 <script、无 on*= 属性、无 <foreignObject
```

### 2.10 `backend/src/http/ratelimit.ts`

```ts
export interface HostRatePolicy { rps: number; burst: number; source: string; verifiedDate: string; note?: string }
export const HOST_RATE_POLICIES: Readonly<Record<string, HostRatePolicy>>;
export class RateLimitedHttp implements HttpClient {
  constructor(inner: HttpClient, policies?: Readonly<Record<string, HostRatePolicy>>, now?: () => number);
  request(url: string, init?: HttpRequestInit): Promise<HttpResponse>;   // 无策略的 host 直通
  /** 测试用：某 host 当前桶状态。 */
  bucketOf(host: string): { tokens: number; lastRefill: number } | null;
}
export function rateLimitedHttp(inner?: HttpClient): HttpClient;
```

### 2.11 capabilities 增量（`capabilities/index.ts:154-181` 的 `CapabilityManifest`）

```ts
export interface ComputeTargetCapability {
  kind: "local" | "modal" | "ssh";
  description: string;
  availability: Availability;           // ssh 恒 "placeholder"
  reason: string | null;
  credentialConfigured: boolean | null; // modal: credentials.json 是否有 modal；local: null
  billable: boolean; persistentVolume: boolean; recovery: boolean;
  uploadLimits: { count: number; bytes: number };
  probeCache?: "hit" | "miss";
}
export interface EmbeddingCapability { configured: boolean; model: string | null; calibrated: boolean; threshold: number | null }
// CapabilityManifest 增：compute: { targets: ComputeTargetCapability[]; withheld: string[] }; embedding: EmbeddingCapability
```

---

## 三、并行波次与 lane 划分

### 3.0 足迹核验方法（重做）

规划目录 `TODO_v0.5.md` §「并行开发验证」写于 v0.4 在飞时，核的是「与 P11 四条 lane 的交集」。那些约束已全部解除。本文按**波次 × 文件**列争用矩阵：每个文件在一个波次里被几条 lane 想动。

| 文件 | W5-1 想动的 lane | W5-2 | W5-3 | 处置 |
|---|---|---|---|---|
| `backend/src/index.ts` | γ（`case "chem"`） | β（`case "compute"`） | — | **每波只有一条** → 分给该 lane |
| `backend/src/mcp/tools.ts` | γ（`chem_depict`） | β（`compute_*` + 3 条 withheld） | — | 同上 |
| `backend/src/capabilities/index.ts` | β（embedding 段）· γ（无） | β（compute targets 段） | — | W5-1 分给 β；W5-2 分给 β |
| `backend/src/server/app.ts` | γ（`/api/chem` 一行） | β（`/api/compute` 一行） | — | 每波一条 → 分给该 lane |
| `backend/src/config/index.ts` | β（`embeddingModel`） | β（`computeTarget`、`modalEnvironment`）· α（无） | — | 分给 β |
| `backend/src/agents/toolbus.ts` | — | β（`ToolCostUnit`）· δ（runner 替换在 orchestrator，不在 toolbus） | — | W5-2 分给 β |
| `backend/src/agents/orchestrator.ts` | — | δ（V32 runner）· β（broker 注入 sessionBudget？**不做**——v0.5 agent 不派发，orchestrator 不需要 broker） | — | W5-2 分给 δ |
| `backend/src/agents/contract.ts` | — | δ（`NON_EVIDENCE_RECORD_TYPES` 加一项） | — | 分给 δ |
| `backend/src/connectors/registry.ts` | — | γ（限速器接线 + 首批注册） | γ（第二批） | 分给 γ |
| `backend/src/literature/normalize.ts` | — | γ（biorxiv 若接进统一检索） | γ | 分给 γ |
| `backend/src/simulation/registry.ts` | — | — | β（三件套） | 分给 β；α 的桥不动它（§1.1.9） |
| `backend/src/simulation/platform.ts` | α（导出 `canonicalJson`，1 行） | — | — | 分给 α |
| `backend/src/experiment/{loop,models,cli}.ts` | — | — | α（桥） | 分给 α |
| `backend/src/lab/cli.ts` | — | β（搬 TTY 门到 `approval/gate.ts`） | — | 分给 β；δ（V25）在 W5-1 动的是 `lab/protocol.ts`/`safety.ts`，不同波 |
| `backend/src/project/models.ts`（`RECORD_TYPES`） | — | δ（若 `external_tool_call` 做成新 record type）——**不做**：用 `observation` + `metadata.kind`，不加第 10 类 | — | 无人动 |
| `tests/unit/narrative_parity.test.ts` | α（compute 模块「等接线」登记）· γ（无：chem 有入口）· β（无） | β（删 α 的登记）· γ（SKILL_ENTRYPOINTS 无）· δ（无） | β（SKILL_ENTRYPOINTS 三行 + EXTENDING 数字） | **只许改登记条目**；W5-1 只有 α 改 → 分给 α；W5-2 只有 β 改 → 分给 β；W5-3 只有 β 改 |
| `docs/EXTENDING.md`「N 个技能」 | — | — | β | 分给 β |
| `frontend/workspace/src/components/center.tsx` | γ（svg 分支） | — | — | 分给 γ |
| `pyproject.toml` | — | — | β | 分给 β |
| `package.json`（`modal` 依赖） | — | α | — | 分给 α |
| `llms.txt` | 每波收口 `bun run gen:llms` | | | 收口 |
| `CHANGELOG / BACKLOG / README / DEVELOPMENT_PLAN*` | 禁止 lane 触碰 | | | 收口 |

**结论**：v0.5 三波里，**没有一个文件在同一波被两条 lane 争用**（矩阵每行每列 ≤1）。所以方案 §5.1 那张「整版摘出」清单在 v0.5 实际上可以按波次下放（X-2）。**唯一需要收口统一做的是 `llms.txt` 重生成与四份禁碰文档。** 代价：每波开工前主会话必须重跑这张矩阵——lane 任务书里的所有权表就是矩阵的切片。

### 3.1 W5-1

| lane | 任务 | 模型建议 | 独占文件 |
|---|---|---|---|
| **α** C1 契约 + 审批语义 + local + 上传面（CB-1/2/3） | §1.1.1 表中 `compute/{lifecycle,plan,target,approval,job_store,uploads,broker}.ts` + `adapters/local.ts` + 契约测试 helper | Opus | `backend/src/compute/**`（除 `cli.ts`/`sim_bridge.ts`/`adapters/modal.ts`）· `backend/src/simulation/platform.ts`（**只许**导出 `canonicalJson`）· `package.json`（**只许**加 `modal` devDependency，pin 0.9.0；本波不 import）· `tests/unit/compute_*.test.ts` · `tests/helpers/compute_contract.ts` · `tests/unit/narrative_parity.test.ts`（**只许**在 `ALLOWED_ORPHANS` 加「等接线」条目）· `docs/devlog/W5-1-a.md` |
| **β** C4 embedding + novelty 重标定 | §1.2 全部 | Opus | `backend/src/llm/embeddings/**` · `backend/src/ideation/{novelty,affinity}.ts` · `backend/src/config/index.ts`（**只许**加 `embeddingModel`）· `backend/src/capabilities/index.ts`（**只许**加 `embedding` 段）· `tests/unit/{novelty,novelty_e2e,novelty_calibration,embeddings}.test.ts` · `tests/fixtures/{embeddings,novelty}/**` · `docs/devlog/W5-1-b.md` |
| **γ** C5-② SMILES→SVG | §1.3 全部 | Sonnet | `backend/src/chem/**` · `backend/src/server/routes/chem.ts` · `backend/src/server/app.ts`（**只许**加一行 `app.route("/api/chem", …)` 与 import）· `backend/src/index.ts`（**只许**加 `case "chem"`）· `backend/src/mcp/tools.ts`（**只许**追加 `chem_depict` 一条）· `frontend/workspace/src/components/center.tsx`（**只许** ArtifactsView 加 svg 分支）· `frontend/workspace/src/lib/types.ts`（若需 contentType 字段）· `tests/unit/{chem_depict,chem_cli,chem_http,chem_mcp}.test.ts` · `tests/unit/ui_cli_parity.test.ts`（**只许**加一组）· `tests/e2e/workbench.spec.ts`（**只许**追加 ⑭）· `docs/devlog/W5-1-c.md` |
| **δ** V25 安全门字段兑现 | §1.5 第一行 | Sonnet | `backend/src/lab/protocol.ts` · `backend/src/lab/safety.ts` · `backend/src/skills/wet-protocol/SKILL.md`（覆盖范围一节）· `README.md` 的「安全门当前的真实覆盖范围」一段（**唯一**允许 lane 动 README 的例外，因为那段是 V25 的叙事，收口再改会漂移）· `tests/unit/{lab_safety,lab_compile}.test.ts` · `tests/lab/protocol_agent.test.py`（若 python 侧解析）· `docs/devlog/W5-1-d.md` |

**α 的「等接线」登记**：`compute/broker.ts`、`compute/adapters/local.ts` 在 W5-1 没有生产调用方（CLI 在 W5-2 β）→ 按 v0.4 §5.3·补 登记 `ALLOWED_ORPHANS`：「等接线：W5-2 β 的 `compute/cli.ts` 接上后必须删本条」。`lifecycle/plan/target/approval/job_store/uploads` 被 `broker.ts` import，不是孤儿。

### 3.2 W5-2

| lane | 任务 | 模型 | 独占文件 |
|---|---|---|---|
| **α** CB-4 Modal adapter | §1.1.6 modal；`ModalGateway` 录制层；`check()`；录制回放 fixture；**需用户提供 token**——没有 token 时本 lane 只能交付「gateway 接口 + 录制层 + 用假 gateway 过契约测试」，真实录制留给收口后的手动冒烟（如实写进报告） | Opus | `backend/src/compute/adapters/modal.ts` · `backend/src/compute/adapters/modal_gateway.ts` · `tests/unit/compute_modal.test.ts` · `tests/fixtures/compute/modal/**` · `docs/devlog/W5-2-a.md` |
| **β** CB-5 接线 | `compute/cli.ts` · `approval/gate.ts`（从 `lab/cli.ts:150-251` 搬出并让 lab 改用）· `server/routes/compute.ts` + `app.ts` 一行 · `index.ts` `case "compute"` · `mcp/tools.ts` 四个暴露工具 + **三条 `MCP_WITHHELD`** · `toolbus.ts` `ToolCostUnit` · `config/index.ts` `computeTarget`/`modalEnvironment` · `capabilities/index.ts` `compute` 段 · 删 α 的 `ALLOWED_ORPHANS` 登记 · AD-14 对抗测试三条（子代理调 `compute_approve/run/release` 必拒）· TTY 门测试（piping 必拒） | Opus | 上列文件 + `backend/src/lab/cli.ts`（**只许**把 gate 换成 import）· `tests/unit/{compute_cli,compute_http,compute_mcp,approval_gate,toolbus}.test.ts`（toolbus 只加用例）· `tests/unit/sub_agent.test.ts`（只加对抗用例）· `tests/unit/narrative_parity.test.ts`（只删登记 + 加「target 数」断言）· `docs/devlog/W5-2-b.md` |
| **γ** V26 限速器 + C2 第一批（≤4，按 F-1 结果；默认 clinvar · biorxiv · reactome · string-db） | §1.4.0 + §1.4.2 checklist ×4 | Sonnet | `backend/src/http/ratelimit.ts` · `backend/src/connectors/{registry,clinvar,biorxiv,reactome,string-db}.ts`（或按 REGISTRY_PATCH 并入域文件——**二选一在任务书里定死**，本文定：独立文件）· `backend/src/literature/{normalize,search}.ts`（biorxiv 进统一检索时）· `tests/concurrency/{host_ratelimit,connector_race}.test.ts` · `tests/unit/connector_*.test.ts` · `tests/fixtures/{genomics,literature,pathways}/**` · `docs/devlog/W5-2-c.md` |
| **δ** V31/V32 | §1.5 第二行 | Sonnet | `backend/src/extensions/mcp_client.ts` · `backend/src/agents/{orchestrator,contract}.ts` · `tests/unit/{mcp_client,orchestrator,contract}.test.ts` · `docs/devlog/W5-2-d.md` |

**β 与 δ 同波都碰 `agents/`**：β 只动 `toolbus.ts`，δ 只动 `orchestrator.ts` + `contract.ts`——不同文件，矩阵无争用。任务书里各自写死「不得越到对方文件」。

### 3.3 W5-3

| lane | 任务 | 模型 | 独占文件 |
|---|---|---|---|
| **α** CB-6 桥 + 真实 e2e | `compute/sim_bridge.ts` · `experiment/{loop,models,cli}.ts` 分支 · `compute_driver.ts` · `compute_e2e.test.ts`（local，SIGKILL）· Modal 真实冒烟（有 token 时）· observation metadata 增量 | Opus | 上列 + `backend/src/server/routes/experiments.ts`（`target` 字段透传）· `backend/src/mcp/tools.ts`（**只许**给 `exp_design` 加 `target` 参数与描述）· `tests/unit/{experiment,experiment_cli,server_experiments}.test.ts` · `docs/devlog/W5-3-a.md` |
| **β** C3 平台三件套 | §1.4.3 checklist ×3 | Opus | `backend/src/simulation/{registry.ts,scanpy/**,pydeseq2/**,cobrapy/**}` · `backend/src/skills/{scanpy,pydeseq2,cobrapy}/**` · `backend/src/skills/README.md` · `docs/EXTENDING.md`（**只许**改「N 个技能」数字）· `pyproject.toml` · `tests/unit/{scanpy,pydeseq2,cobrapy}_{contract,e2e}.test.ts` · `tests/sim/*_runner.test.py` · `tests/fixtures/{scanpy,pydeseq2,cobrapy}/**` · `tests/unit/narrative_parity.test.ts`（**只许**加三行 `SKILL_ENTRYPOINTS`）· `docs/devlog/W5-3-b.md` |
| **γ** C2 第二批（≤4，**只在 F-1 或 W5-2 末外部验收给出拉动时才开**；否则本 lane 空置） | §1.4.2 | Sonnet | 同 W5-2 γ 的模式 |
| **δ** 机动位 + BACKLOG 清扫（X-4） | 吸收前两波溢出；V3/V8/V9/V13/V14/V24 逐条「吸收或明确不做」的**实施**（决定权在主会话评审） | Sonnet | 按溢出项临时指派 |

### 3.4 枢纽文件清单核实

方案 §5.1 列了 9 个。核实结果：

| 方案清单 | v0.5 实际争用 | 处置 |
|---|---|---|
| `index.ts` `mcp/tools.ts` `server/app.ts` `capabilities/**` | 每波仅一条 lane（§3.0 矩阵） | **按波次下放**（X-2） |
| `agents/orchestrator.ts` `agents/toolbus.ts` | W5-2 各一条 lane，不同文件 | 下放 |
| `connectors/registry.ts` `literature/normalize.ts` | 只有 γ | 下放给 γ |
| `narrative_parity.test.ts` | 每波一条 lane 改登记 | 下放，**规则不变：只许加/删登记条目** |
| **增补** `config/index.ts` | W5-1 β、W5-2 β | 下放给 β |
| **增补** `docs/EXTENDING.md`、`skills/README.md`、`pyproject.toml` | W5-3 β | 下放 |
| **增补** `llms.txt` | 每波 | **收口** `bun run gen:llms` |
| **增补** `CHANGELOG.md` `BACKLOG.md` `README.md`（V25 段除外）`DEVELOPMENT_PLAN*` | — | **收口** |

### 3.5 依赖边与关键路径

```
闸门 F ─┬─► W5-1 α ──► W5-2 β ──┬─► W5-3 α（桥 + e2e）──► 收口 ──► v0.5.0
        │            W5-2 α ────┘（真实 Modal 冒烟需要它；CI 路径不需要）
        ├─► W5-1 β（独立）
        ├─► W5-1 γ（独立）
        ├─► W5-1 δ（独立）
        ├─► W5-2 γ（V26 → 第一批 connector；不依赖 W5-1）
        ├─► W5-2 δ（独立）
        └─► W5-3 β（只依赖 simulation/registry 空窗，W5-3 无人争用）

关键路径：F → W5-1 α → W5-2 β → W5-3 α → 收口。三个收口尾巴（每波一次）各自串行。
```

**每波收口清单**（主会话，不可省）：合 integration → `bun run gen:llms` → 独立重跑各 lane 报告的阴性对照 → 六套件全量 → 检查 `ALLOWED_ORPHANS` 对称 → devlog/CHANGELOG。

### 3.6 零上下文外部验收插入点（方案 §6.3 原样）

闸门 F（基线）· **W5-2 末**（提交一个算力任务并读回结论，含审批；由未参与开发的人/会话执行——用 local target 即可验证审批链路，不必等 Modal）· 发布前（干净机器）。

---

## 四、每条 lane 的验证设计

| lane | 阴性对照 ①（回退实现必红） | 阴性对照 ② | 阶段门 |
|---|---|---|---|
| **W5-1 α** | 把 `dispatch` 的 `approved` 入边改成也接受 `awaiting_approval` → `compute_lifecycle.test` L-2 用例红 | 让 `consume()` 不清空 `approval` → `compute_approval.test`「重启后不能凭旧 approval 重派」红；`uploads.test`：篡改一个已 preflight 文件一字节 → `UploadChangedError` 必抛，注释掉 sha256 比对 → 红 | typecheck · unit · concurrency（新增 `compute_dispatch_once.test.ts`：N=30 并发 dispatch 同一 approved job → 恰好 1 次，照 `tests/concurrency/approve_once.test.ts`）· timeout · e2e · py · lab |
| **W5-1 β** | 阈值 ±0.1 → `novelty_calibration.test` 余量断言红 | 让 `EmbedResponse.ok=false` 时 `vectors` 变 `[]` 而不是 `null` → 类型层编译错 + 运行期「降级必须写进口径说明」用例红；把未标定模型也当语义用 → 「未标定强制词面」用例红 | 六套件；`novelty_e2e` 在 fixture 回放下必须 0 skip |
| **W5-1 γ** | 让 `depict.py` 对非法 SMILES 吐空 `<svg/>` → 「非法输入不落 record」红 | 前端 svg 分支改回 `<pre>` → Playwright ⑭ `naturalWidth>0` 红；`assertSafeSvg` 放行 `<script>` → 单测红 | 六套件 + `ui_cli_parity` 新组 |
| **W5-1 δ** | 拆掉浓度解析 → `lab_safety.test`「50% H2SO4 超限必 fail」红 | 解析成功仍报 unconsumed 告警 → `lab_compile.test`「已消费不告警」红 | 六套件（`test:lab` 必跑） |
| **W5-2 α** | `recover()` 不验 ownership tag 就 reattach → 「他人 sandbox 必拒」用例红（`RecordedModalGateway` 回放一条 tag 不符的 sandbox） | `harvest()` 不做 reconcile → 「卷上 exit-code 与 sandbox 报告不一致必报」红 | 六套件；契约测试 helper 在 modal 上跑录制回放 |
| **W5-2 β** | 从 `MCP_WITHHELD` 删掉 `compute_run` → `sub_agent.test` AD-14 对抗用例红 + `narrative_parity`「withheld 与暴露不重叠」仍绿但「/api/compute/machine 从转移表推导」的 `consumesApproval` 断言红 | `approval/gate.ts` 的 isTTY 判定改成只看 stdin → `approval_gate.test`「stdout 重定向必拒」红；`echo yes \| compute approve` 必拒 | 六套件；独立重跑 `bun backend/src/index.ts compute approve x </dev/null` 必拒（主会话手工，纪律 6） |
| **W5-2 γ** | 去掉 `RateLimitedHttp` 装饰 → `host_ratelimit.test` 红 | 把桶 key 改成 connector 名 → 合计 9 rps → 红；fixture 里改一个字段名 → 归一化用例红 | 六套件；每个 connector 真实网络首测记录（FIXTURE_MODE=record 的终端输出进 devlog） |
| **W5-2 δ** | 不把 `external_tool_call` 加进 `NON_EVIDENCE_RECORD_TYPES` → `contract.test`「外部工具审计不算进展」红（照 `contract.ts:137-152` 的用例形状） | runner 替换后不落 record → `mcp_client.test`「四个分支都落 observation」红 | 六套件 |
| **W5-3 α** | SIGKILL 后 `exp run --resume` 不经 `broker.recover()` 直接 `dispatch()` → 「重派必须要新审批」红 | `materializeHarvest` 漏写 `done.json` → `platform.collect()` 抛「标记 completed 但结果缺失」→ e2e 红 | 六套件 + 真实 Modal 冒烟（有 token）；SIGKILL e2e 在 local 必过 |
| **W5-3 β** | 改错 marker 基因名 → e2e 红 | 删 registry 的 `case "scanpy"` → 契约测试整套 skip → **0 skip 基线红** + 「技能可达性」红 | 六套件；`test:py` 含新 runner 测试；devlog 写明本机 uv install 耗时 |

所有 lane 通用：**报告里必须写明哪些套件没能在本 lane 跑成**（v0.4 §5.2 ⑨），主会话按纪律 6 独立重跑至少一条阴性对照。

---

## 五、风险与已知陷阱

### 5.1 v0.4 踩过的四个坑，本设计怎么避

| 坑 | v0.4 实况 | v0.5 的规避 |
|---|---|---|
| **建好但没人喂**（6 次） | ledger、findings_store、contract、anthropic adapter… | ① K-5：入口文件按波次下放，lane 自己接自己的线（γ 的 chem、β 的 compute 命令都在本 lane 内闭环）；② 唯一的跨波「等接线」只有 W5-1 α → W5-2 β，登记 `ALLOWED_ORPHANS` 且 W5-2 β 任务书第一条就是删登记；③ `STORE_WRITE_BINDINGS` 加 `compute/job_store.ts:create ← compute/broker.ts`、`CONTRACT_RECORD_PRODUCERS` 加 `kind:"compute_output" ← compute/broker.ts`（按能力而非按文件的门禁） |
| **枢纽文件锁给单条 lane 让别人只能留接线** | P11 R-b 的 router | 矩阵证明 v0.5 每波每文件 ≤1 lane（§3.0）；**开工前主会话重跑矩阵**，出现 ≥2 才摘出 |
| **二进制是另一个运行时** | W1-d 全绿、产物全坏（V27） | 闸门 F-4 定性；若定「修」，`compute/adapters/local.ts` 与 `chem/depict.py`、新 runner **不得**用 `import.meta.dir` 找脚本以外的资产，且发布前跑 V28 冒烟（构建 → `--version`/`capabilities --json`/`doctor`/`chem depict`）；若定「永久不发单二进制」，INSTALL.md §3 删除，本文所有 `import.meta.dir` 用法维持 |
| **记账 record 污染进展口径** | W3 收口 `agent_run` 让 noProgress 失效 | K-3：算力状态不进图；V31 的 `external_tool_call` 显式进 `NON_EVIDENCE_RECORD_TYPES`；**新规则写进 `agents/contract.ts` 注释**：「任何 lane 新增 record `kind`/type，必须回答它算不算进展」 |

### 5.2 新风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Modal token 迟迟不到 → W5-2 α 只能交假 gateway | 真实 e2e 推迟 | CI 路径不依赖它（local adapter 走完整审批链）；α 报告如实写「未真实录制」；发布判据里「真实 Modal 冒烟」单列，不许用回放冒充 |
| `modal` SDK 0.9.0 `close()` 不关 gRPC 通道等怪癖 | 长驻 server 积累连接 | client 池化照抄；升级走 fixture 先行 |
| embedding fixture 与模型绑定，用户换模型 → 阈值失效 | novelty 又回到「拍脑袋」 | K-4：未标定模型强制词面 + capabilities 明示 `calibrated:false` |
| scanpy 依赖链（numba/scikit-learn/leidenalg）在 CI 机器编译失败 | 契约测试整套 skip → 0 skip 基线红 | W5-3 β 第一步实测 wheel；失败即改用 `pydeseq2`/`cobrapy` 先行，scanpy 退到 W5-3 δ 或 v0.6 |
| `approval/gate.ts` 搬家动了 `lab/cli.ts` | 湿实验审批回归 | 只换 import；`lab_cli.test` 与 e2e ⑧ 必过；β 阴性对照包含 lab 路径 |
| 用户在 `compute approve --run` 一步做完 → 审批与派发同刻 | 与 wet 的「先 approve 再 simulate」两步不同 | 允许，但 `--run` 仍走同一 `dispatch()`（消费 + 重验），decision record 与 dispatch 时间戳分开记；MCP 侧两者都扣留 |
| C2 第二批被「staged 里看起来有用」诱惑 | 铺量 | W5-3 γ **默认空置**，只有 F-1 / W5-2 末验收给出书面拉动才开 |

---

## 六、开工顺序与第一波任务书草稿

**顺序**：闸门 F（F-1 基线验收 → F-2 AMiner → F-3 删别名 → F-4 V27 定性）→ 主会话 `cd` 回主仓 → 建 `feat/w5-1-integration` → spawn 四条 lane。

以下四份任务书按 v0.4 lane brief 格式。共同段落只写一次：

> **共同段落（每份任务书都包含）**
> - 工作区：`git worktree add ~/Desktop/AI4S/spark-research-w5-1-<lane> -b feat/w5-1-<lane> feat/w5-1-integration` → `bun install --frozen-lockfile` → `uv sync`（或链接主仓 `.venv`；不做这步 17 个 OpenMM 用例静默 skip）→ `export SPARK_E2E_PORT=<4400+序号>` → **立即 `git push -u`**（纪律 9）
> - 隔离：**不要动其他 lane 的 worktree 和主仓**；你自己 lane 的工作区就是你该待的地方，不管初始 cwd 在哪。如果环境与本任务书矛盾，停下来问，那是对的。
> - 基线：`main feb3c8a`；`bun test tests/unit` = 1396 pass / 0 fail / 0 skip
> - 只改所有权表里的文件；越界先回报。不碰 CHANGELOG / BACKLOG / README（δ 的 V25 段除外）/ DEVELOPMENT_PLAN*；devlog 只写 `docs/devlog/W5-1-<lane>.md`
> - 提 PR 前跑全量：`bun run typecheck` + `bun test tests/unit/` + `tests/concurrency/` + `tests/timeout/` + `bun run test:e2e` + `bun run test:py` + `bun run test:lab`
> - 阴性对照是强制项：回退自己的修复，确认新测试真的会红，终端输出贴进 devlog
> - 报告必须写明哪些套件没能在本 lane 跑成（不许把 skip 当通过）
> - 目标分支 `feat/w5-1-integration`；不 push main、不开 PR、不 merge
> - 新建模块暂无生产调用方时，在 `ALLOWED_ORPHANS` 登记并写清「等谁接线」——只许加登记，不许改断言逻辑
> - 凭据永不进代码/fixture/devlog；commit 前对新增文件 grep 一遍

### 6.1 W5-1-a · C1 契约先行 + 审批语义 + local adapter + 上传面

**你是 v0.5 关键路径的起点。** 读：`docs/DEVELOPMENT_PLAN_v0.5_MODULES.md` §1.1（全部）与 §2.1-2.5；`~/Desktop/AI4S/spark-research-v0.5-plan/workstreams/compute/COMPUTE_DESIGN.md`；`backend/src/lab/wet_loop.ts:371-560`（审批与消费的已验证写法）；`backend/src/simulation/{platform,run_store}.ts`（磁盘真源与 poll 顺序）；`tests/helpers/simulation_contract.ts`、`tests/concurrency/approve_once.test.ts`、`tests/unit/wet_crash_recovery.test.ts`。

**文件所有权**：`backend/src/compute/{lifecycle,plan,target,approval,job_store,uploads,broker}.ts` · `backend/src/compute/adapters/local.ts` · `backend/src/simulation/platform.ts`（只许 `export` `canonicalJson`）· `package.json`（只许加 `"modal": "0.9.0"` devDependency；本波不 import）· `tests/unit/compute_{lifecycle,plan,approval,job_store,uploads,broker,local}.test.ts` · `tests/concurrency/compute_dispatch_once.test.ts` · `tests/helpers/compute_contract.ts` · `tests/unit/narrative_parity.test.ts`（只许加 `ALLOWED_ORPHANS` 登记）· `docs/devlog/W5-1-a.md`

**任务**：
1. `lifecycle.ts`：§2.1 签名；转移表三张；`transition()` 纯函数；不变式 L-1…L-7；**穷举测试**（三轴 × 事件笛卡尔积 vs 显式合法表）。
2. `plan.ts`：§2.2；digest 排除 `workspaceRoot`；`approvalRequired` 派生；`estimate` 查不到价格 = null；`validatePlan` 拒 shell 字符串 command、拒密钥样 env key。
3. `target.ts`：§2.3；`validateSshHost()` 照上游 Host schema 校验规则（只校验，无实现）。
4. `uploads.ts`：deny-list / gitignore / 双限额 / sha256 / symlink 拒 / `preflight()`；全部纯函数 + 只读 fs。
5. `job_store.ts`：目录布局 §1.1.5；原子写 + `rev` CAS。
6. `approval.ts`：§2.4；decision record 形状与 `wet_loop.ts:387-418` 同构（`evidence:"inferred"`、`origin.kind:"manual"`、`metadata.kind:"approval"`、`planDigest`）；`consume()` 在同一次 CAS 里 `approval → consumedApproval`。
7. `broker.ts`：§2.5；`dispatch()` 五步；admission limit 超出显式失败；`recover()` 按 `adapterHandle` 分派。
8. `adapters/local.ts`：子进程 + 落文件不 pipe；`recover()` 顺序「先 exit-code 文件再 pid」；`capabilities().billable=false`。
9. `tests/helpers/compute_contract.ts`：参数化契约套件（照 `SimulationContractCase`），本波只跑 local。
10. `ALLOWED_ORPHANS` 登记 `broker.ts` 与 `adapters/local.ts`：「等接线：W5-2 β 的 `compute/cli.ts` 接上后必须删本条」。

**阶段门**：六套件全量；新增测试全绿；`tests/unit` 计数 ≥ 1396 且 0 skip。
**阴性对照**（至少）：L-2 入边放宽 → 红；`consume()` 不清空 approval → 「重启后不得凭旧 approval 重派」红；`preflight` 去掉 sha256 比对 → 红；`compute_dispatch_once` 去掉 CAS → 红。
**报告要求**：接口与 §2 签名的任何偏离逐条列出并给理由；`canonicalJson` 导出对 `specHashOf` 的影响（应为零，附 `simulation_contract` 通过证据）；上传 deny-list 的最终清单。

### 6.2 W5-1-b · C4 embedding 抽象 + novelty 重标定

读：本文 §1.2 与 §2.8；`workstreams/provider/V05_PROVIDER_DESIGN.md` §(b)；`backend/src/llm/{types,router}.ts`、`llm/providers/{types,registry,openai_compat}.ts`；`backend/src/ideation/{affinity,novelty}.ts`；`backend/src/http/{client,fixture}.ts`；`docs/devlog/P4-ideation.md` 的标定表。

**文件所有权**：`backend/src/llm/embeddings/**` · `backend/src/ideation/{novelty,affinity}.ts` · `backend/src/config/index.ts`（只许加 `embeddingModel`）· `backend/src/capabilities/index.ts`（只许加 `embedding` 段与其接口）· `tests/unit/{embeddings,novelty,novelty_e2e,novelty_calibration}.test.ts` · `tests/fixtures/embeddings/**` · `tests/fixtures/novelty/calibration.json` · `docs/devlog/W5-1-b.md`

**任务**：
1. 开工第一件事：本机 Ollama（若有）核 `/v1/embeddings` 是否可用；结果写 devlog（AD-12）。
2. `embeddings/types.ts` + `openai_compat.ts` + `router.ts` + `calibration.ts`（§2.8）；**必须走 `HttpClient`**。
3. novelty 双留痕：`NoveltyCandidate` 增 `semanticAffinity`/`affinityBasis`；`NoveltyDeps.embedder`；`constrainRating` 按 basis 取阈值；**未标定模型强制词面**；报告口径说明写清 basis/模型/阈值/标定日期；embedding 失败必须写进报告，不静默。
4. 标定集：按 §1.2.3 从既有磁带构造 ≥20 条（≥10 existing / ≥10 novel / P4 原 2 条），落 `calibration.json`；用你实际有 key 的模型 `FIXTURE_MODE=record` 录向量 fixture；`SEMANTIC_THRESHOLDS` 只登记该模型。
5. `novelty_calibration.test.ts`：余量各 ≥0.05；`sampleSize` 对撞 calibration.json 条数。
6. `CONFIG_SETTINGS.embeddingModel`；capabilities `embedding` 段。

**阶段门**：六套件；`novelty_e2e` 回放下 0 skip。
**阴性对照**：阈值 ±0.1 → 红；`ok=false` 时 `vectors` 改 `[]` → 编译错；未标定模型当语义用 → 红；删 5 条样本 → `sampleSize` 红。
**报告要求**：最终阈值、正/负分布的 min/max、余量；用的模型与 fixture 大小；标定集里每条 claim 的来源磁带；**embedding 与词面在 20 条上的判定差异表**（这是 C4「提升可信度」的直接证据）。

### 6.3 W5-1-c · C5-② SMILES → SVG

读：本文 §1.3 与 §2.9；`backend/src/artifacts/store.ts:65-82,172-232`；`backend/src/experiment/loop.ts:290-335`（`createFromArtifact` 用法）；`backend/src/proteins/{cli,analysis}.ts` + `server/routes/proteins.ts` + `mcp/tools.ts` 的 `protein_analyze`（R-d 补三入口的先例）；`frontend/workspace/src/components/center.tsx:355-400`；`tests/unit/ui_cli_parity.test.ts`；`tests/e2e/workbench.spec.ts`。

**文件所有权**：`backend/src/chem/{depict.py,depict.ts,cli.ts}` · `backend/src/server/routes/chem.ts` · `backend/src/server/app.ts`（只许加 import + 一行 `app.route`）· `backend/src/index.ts`（只许加 `case "chem"`）· `backend/src/mcp/tools.ts`（只许追加 `chem_depict`）· `frontend/workspace/src/components/center.tsx`（只许 ArtifactsView 加 svg 分支）· `frontend/workspace/src/lib/{types,api}.ts`（只许补 contentType 透传）· `tests/unit/{chem_depict,chem_cli,chem_http,chem_mcp}.test.ts` · `tests/unit/ui_cli_parity.test.ts`（只许加一组）· `tests/e2e/workbench.spec.ts`（只许追加 ⑭）· `docs/devlog/W5-1-c.md`

**任务**：
1. `depict.py`：stdin JSON → stdout JSON；rdkit 缺失时输出 `{ok:false, error:{kind:"rdkit_unavailable", message:"安装：uv pip install rdkit"}}`（可操作原因口径）。
2. `depict.ts`：子进程（`resolvePython()`）+ 超时 + `assertSafeSvg` + `ArtifactStore.save()` + `createFromArtifact({ evidence:"computed", metadata.kind:"chem_depiction" })`；非法输入**不落任何东西**。
3. 三入口：CLI `chem depict`、HTTP `POST /api/chem/depict`、MCP `chem_depict`（描述按 `mcp/tools.ts` 头部「判断二」四段写）。
4. 前端 svg 分支（`<img data:>`，不 innerHTML）。
5. `ui_cli_parity` 新组；Playwright ⑭。
6. **不建 SKILL.md**。

**阶段门**：六套件（含 `bun run test:e2e`）。
**阴性对照**：脚本对非法 SMILES 吐空 svg → 「不落 record」红；前端改回 `<pre>` → ⑭ 红；`assertSafeSvg` 放行 `<script>` → 红。
**报告要求**：rdkit 版本与耗时；SVG 尺寸；三入口的 record 指纹一致证据；capabilities 里 `chem_depict` 出现的截图/JSON 片段。

### 6.4 W5-1-d · V25 安全门字段兑现

读：本文 §1.5 第一行；`backend/src/lab/safety.ts:20-50,121-160`；`backend/src/lab/protocol.ts:3-8,255-310`；`docs/devlog/P10-d.md` 的 D-8 段；`README.md`「安全门当前的真实覆盖范围」；`backend/src/skills/wet-protocol/SKILL.md`。

**文件所有权**：`backend/src/lab/protocol.ts` · `backend/src/lab/safety.ts` · `backend/src/skills/wet-protocol/SKILL.md`（只许改覆盖范围一节）· `README.md`（**只许**改「安全门当前的真实覆盖范围」一段）· `tests/unit/{lab_safety,lab_compile}.test.ts` · `tests/lab/protocol_agent.test.py`（若动 python 侧）· `docs/devlog/W5-1-d.md`

**任务**：
1. 编译器解析浓度 → `ReagentSpec.concentration`（单位归一到 mol/L 或 %，写清口径）；解析 BSL → `ProtocolStep.params.biosafetyLevel`。
2. `concentration_limit` / `biosafety` 从「恒空转」变真消费；`MAX_CONCENTRATION` 表补来源注释。
3. `scanUnconsumedSignals` 的两条分支改成**只在解析失败时报**；解析成功即消费，不再告警。
4. 更新 README 覆盖范围段与 SKILL.md；**不许**宣称超过实际解析能力的覆盖（AD-12）。
5. 对抗用例：超限浓度必 fail；BSL-3 必 fail；模糊表达（「适量」「高浓度」）→ 仍告警未消费。

**阶段门**：六套件（`test:lab` 必跑）。
**阴性对照**：拆解析器 → 「超限必 fail」红；解析成功仍告警 → 「已消费不告警」红。
**报告要求**：解析覆盖的表达形式清单（正则）与明确不覆盖的清单；README 段落 before/after。

---

## 七、异议（明确写出，附理由）

### X-1 · CB-5 的审批**语义**应在 CB-1 做，CB-5 只做接线

方案 §3.1 把 CB-5 排在 W5-2，§3.2 说它是重心。本文同意重心判断，但认为切片边界画错了：`planned → awaiting_approval → approved → queued` 是 lifecycle 主干，「digest 一次性消费」「执行前重验」是 `dispatch` 转移的**前置条件**，不是外挂。CB-1 若不含它们，穷举转移测试必然给 `dispatch` 留一个「测试时不查审批」的口子——那个口子就是生产后门。前移后 W5-2 β 只剩接线（CLI/HTTP/withheld/TTY/ToolBus/capabilities），反而更容易在一波内闭环。**代价**：W5-1 α 变重（8 个文件），建议 Opus。

### X-2 · 枢纽文件清单不应整版锁死

§3.0 的矩阵证明 v0.5 三波里没有一个文件被同波两条 lane 争用。整版锁死会重演 v0.4 的「建好但没人喂」。按波次分配（K-5），主会话每波开工前重跑矩阵。

### X-3 · daemon 里的 v0.1 `ComputeService` 必须二选一

> **主会话核实后升级（2026-09-10）：这不是「v0.5 落地后会有两个 compute 造成混淆」，
> 是 v0.4.0 里一条活着的静默假成功路径。**
>
> 实测链路：`agents/orchestrator.ts:53` 的 `TASK_KINDS` 含 `"compute"` →
> `orchestrator.ts:490-494` 的 `case "compute"` 调 `this.daemon.compute.submit()` →
> `daemon/daemon.ts:72-91` 的 `DefaultCompute` 用**内存 Map** 造一个
> `{ id, status: "queued" }` 假 job → **`ok: true` 返回**。
>
> 也就是说：**LLM 计划出一个 compute 任务，会拿到一个永远不出结果的假 job，
> 而整条链路报成功。** 这正是外部评审当年的原话——
> 「delegate_task/compute 走内存 mock 永不出结果——LLM plan 出 compute 任务会静默产出假 job」。
> P8 删掉了 `backend/src/compute/`（providers/manager/job_manager 三件），
> **daemon 侧这一条活了下来**，v0.3.0 的 D-4「LLM 失败不再静默当成功」也没覆盖到它
> （它不是 LLM 失败，是执行层假成功）。
>
> **处置升格为闸门 F 的第五件（F-5）**，先于任何 v0.5 功能：
> 要么删掉 `ComputeService` / `DefaultCompute` / `permissions.ts:8` 的 `compute_submit` /
> `TASK_KINDS` 的 `"compute"` 与 orchestrator 的 case 分支，要么让它显式报「未实现」。
> **静默假成功是最差的那个选择**，而它已经在仓库里活了四个版本。

### X-4 · W5-3 δ「runtime contract + Python SDK」定义没跟着走（主会话已纠正措辞）

> **主会话核实：原文「全文与规划目录里没有任何定义」是过头了。**
> 规划目录 `TODO_v0.5.md:101` 与 `:132` **有定义**：
> 「对外 API 升格为有版本契约 + 零依赖 Python 客户端（对标上游 `tooling/sdk/python`）。
> 排 v0.5 后段，依赖 P14 的 SSE 流稳定」。
>
> **但这条异议的实质成立**：主会话把它抄进方案 §5 的波次表时，
> **定义没跟着走**——方案正文只剩一行标题，任何拿方案去派活的人都不知道它要做什么。
> 这与 v0.4 反复出现的「叙事与实现分家」是同一形状，只是发生在文档之间。
>
> **处置**：W5-3 δ 保留但**必须先把定义从规划目录搬进方案正文**，
> 或降为机动位。派活前定义不在方案里，就不派。

### X-5 · C5-② 的「kernel 侧」应解作「Python 侧」

经 `PythonKernel`/daemon 走 depict 会把 permit set、`ControlRepl`、kernel 生命周期都拖进一个 100ms 的无状态调用；`simulation/platform.ts:23-26` 已为仿真层做过同样取舍。本文用子进程 + `resolvePython()`（同一 `.venv`），零新依赖。

### X-6（提醒，非异议）· 方案 §5 把 CB-4 与 CB-5 排同波是对的，但要写明两者**互不依赖**

方案的依赖图把 CB-5 画在 CB-4 之后（`F → CB-1/2/3 → CB-4 → CB-5`）。实际上 CB-5 接线只面对 CB-1 的接口，CI 用 local adapter 走完整审批链；CB-4 缺 token 时不应阻塞 CB-5。本文关键路径已按此画（§0.2）。

---

## 八、给主会话的收口备忘

- W5-1 收口：`gen:llms`；核 α 的 `ALLOWED_ORPHANS` 登记两条；独立重跑 α 的 L-2 阴性对照与 γ 的 Playwright ⑭；把 §1.4.5 两条规范写进 `EXTENDING.md`；决定 X-3。
- W5-2 收口：删 α 登记（β 已做，核对称）；`narrative_parity` 新增「target 数」「NCBI host 限速」两断言在位；**W5-2 末外部验收**（local target 审批链）；核 `MCP_WITHHELD` 三条进了 `MCP_INSTRUCTIONS`（`mcp/server.ts:204-214` 自动）。
- W5-3 收口：`EXTENDING.md` 技能数；`skills/README.md`；真实 Modal 冒烟结果单列（回放不算）；BACKLOG 38 条逐条「吸收/不做」；CHANGELOG breaking 段（F-3、V21）。
- 发布前：干净机器完整链路；若 F-4 定「修」，V28 二进制冒烟含 `chem depict` 与 `compute targets`。

---

## 三·补：W5-1 按闸门 F 的产出重排（主会话，2026-09-10）

> 本节由主会话在闸门 F 收口后追加。§3.1 原表写于闸门 F **之前**，那时 F-1 的外部验收
> 还没跑。方案 §1 明文「**F-1 的产出直接影响 §2 的选择**」，产出回来了，这里兑现它。

### 补.1 F-4 裁定：修，不永久降级

方案给 F-4 的两条路是「修」或「把不发单二进制写成永久承诺」，并规定**不许再挂一版**。

选「修」的理由不是偏好，是**降级这条路走不通**：代码用 `bun:sqlite` 撑持久层，
node 跑不起来，所以 **npm 包也要求预装 Bun**。砍掉单二进制不会让安装变简单，
只会让三条安装路径**全都**要求预装 Bun——上手性反而更差。降级付出了能力却换不到简化。

F-c 已经把机制验证到底并给出最小可行集（`docs/devlog/F-c.md`）：
`.sql`/`.txt` 走静态 `import ... with { type: "text" }`；`.py` 因为要被**外部子进程**
按路径 spawn，必须「静态 import 文本 → 运行期解包到临时文件 → spawn 真实路径」，
**单靠 `type: "file"` 不行**（它给的是 `/$bunfs/` 虚拟路径，外部 python 打不开）。
`project/records.ts` 这一处 F-c 已实机打补丁 + 编译 + 跑通，是修法可行的实证。

### 补.2 新增三条 lane（ε / ζ / η），全部由 F-1 拉动

| lane | 内容 | 为什么值得占一条 lane |
|---|---|---|
| **ε** V27/V33 资产内嵌 | F-4 的执行面：3 处 `schema.sql` · 4 处 `.py` · 3 处 prompt `.txt` · 3 处危险默认路径（含 V33 的 `/workspaces`） | 闸门 F 唯一没做完的一件。它决定「单二进制」这条安装路径是真的还是假的 |
| **ζ** 文献域可用性 | V34 默认源 · V35 长任务 CLI 可见性 · V36 失败消息 · V38 BibTeX 作者名 · V39 `lit review --help` | 外部验收的头两号卡点都在这里。**按文件归属合并成一条**：五项全落在 `literature/` 下，拆开必抢 `literature/cli.ts` |
| **η** 能力口径收口 | V37 `auth` 与 `config list`/`doctor` 对同一把 key 报不同状态 + `idea new` 失败消息 | 真因已定位到行，比报告说的更具体（见下） |

**V37 的真因**（主会话核实）：`index.ts:103` 有一份**手写的 `KEY_NAMES` 副本，只列
kimi + openrouter**，而 `doctor` / `capabilities` / `onboarding` 三处都从
`providerApiKeyEnv()` 派生。更直接的是 `auth()` 显示配置时**只读 config 文件、不看环境变量**
（`index.ts:126`），所以 key 在 env 里时它报「未设置」。**这与 P11 收口过的
`PROVIDER_API_KEY_ENV` 手工副本是同一个 bug 的第二现场**——真源统一了，但漏了这个消费方。

### 补.3 `backend/src/index.ts` 归属重排

原表把 `index.ts` 的「只许加 `case "chem"`」给了 γ。现在 η 要重写该文件的
`KEY_NAMES` / `getApiKey()` / `auth()` 三处，**两条 lane 写同一个文件必冲突**。

处置沿用本文 §3.1 对 `app.ts` 已有的先例（「`app.ts` 一行由收口接」）：

- **`backend/src/index.ts` 整个归 η**
- **γ 的 `case "chem"` 一行与 import 由收口接**——γ 在报告里写明该写哪一行

### 补.4 W5-1 足迹增量核验（只列新增三条与原四条的交叉面）

| 文件 | 争用 | 处置 |
|---|---|---|
| `backend/src/index.ts` | γ（原）· η（新） | **归 η**；γ 那一行下放收口（补.3） |
| `backend/src/literature/library.ts` | ε（`schema.sql`） | ζ 只拿 `{models,cli,export}.ts`，不含 `library.ts` → 不冲突 |
| `backend/src/lab/wet_backend.ts` | ε（`.py` spawn） | δ 只拿 `{protocol,safety}.ts` → 不冲突 |
| `backend/src/simulation/{openmm,pyref}/index.ts` | ε（`runner.py`） | α 只拿 `platform.ts` 的 `canonicalJson` 导出；W5-3 β 拿的是 registry + 三个新平台 → 不冲突 |
| `backend/src/agents/orchestrator.ts` | ε（V33 的 `/workspaces`，`:223`） | W5-2 δ 才动它，**跨波不同时** → 不冲突 |
| `backend/src/ideation/cli.ts` | η（失败消息） | β 拿的是 `{novelty,affinity}.ts` → 不冲突 |
| `tests/unit/narrative_parity.test.ts` | α（登记「等接线」） | ζ 的新门禁断言**另开** `tests/unit/literature_source_parity.test.ts`，不碰枢纽文件 |

### 补.5 ζ 要顺带补的一条门禁（V34 的结构性教训）

V34 不是普通 bug：`lit search --sources arxiv` 能用、`capabilities --json` 报 arxiv 可用、
`lit add <arxiv-id>` 却查不到。**能力做好了，默认值没跟着改**，而 **AD-12 门禁抓不到**——
它核「arxiv 在不在注册表」，核不了「默认值有没有包含它」。

所以 ζ 除了改那一行，必须加一条断言：**已实装的源必须在 `DEFAULT_SEARCH_SOURCES` 里，
或在一张显式排除表里带理由**（CNKI/万方是占位实现，属于合法排除）。
阴性对照：把 arxiv 从默认集里拿掉 → 该断言必须变红。

### 补.6 剩余两次外部验收的落点不变

方案 §6.3 要求三次。闸门 F 已跑第一次（基线）。**W5-2 末**第二次（含审批链，用 local
target 即可，不必等 Modal），**发布前**第三次（干净机器）。两次都必须由未参与开发的会话执行。

---

## 三·补.7：W5-2 α 走「无 token 降级交付」，启用 Modal 必须是纯配置（用户 2026-09-10 决定）

### 决定

用户口径：**先按 A（降级交付），剩下的放到用户配置文件里。**

所以 W5-2 α 的交付边界是：**gateway 接口 + 录制层 + 用假 gateway 过契约测试**，
不做真实 Modal 录制。真实冒烟留到用户拿到 token 之后手动补一次。
**这不阻塞任何其它 lane**——α 已交付的 local adapter 承担全部契约测试，
第二次外部验收（W5-2 末）用 local target 就能走完整审批链。

### 这个决定带来的三条硬约束（都要可核，不许靠自觉）

**约束一：启用 Modal 必须零代码改动、零重新编译。**
用户后来做的全部动作只有两件——把 token 写进 `~/.spark-research/credentials.json`
的 `connectors.modal`（§1.1.7 已定，复用 `CredentialStore`，0600），
把 `computeTarget` / `modalEnvironment` 写进 `config.json`（W5-2 β 的所有权）。

> ⚠️ **W5-2 α 交付后的更正（主会话，2026-09-10）**：这条约束**只兑现了一半**，
> 而且是 lane α 主动指出来的。判定路径确实纯配置（有阴性对照钉着，没有任何编译期常量
> 参与「Modal 能不能用」），**但真实 `ModalGateway`（Modal SDK 客户端）压根还不存在**——
> 本波交付的是接口 + 录制层 + 假 gateway。所以**「填了 token 就能跑」现在不成立**。
>
> α 没有把接口做得像是能用，而是让 `status()` 在这种情况下报得难看但准确：
> 「真实 gateway 尚未实现——所以只填 token 还跑不起来」（`adapters/modal.ts:156`）。
> **这是对的取向**：一个还没连过真实服务的适配器，任何"看起来能用"的措辞都会误导发布材料。
>
> 约束一的准确表述应该是：**「将来实现真实 gateway 时，启用它不得需要任何编译期改动」**——
> 这一条本波已经做到并有门禁。而"填 token 即可用"要等真实 gateway 落地后才成立，
> 清单见 `docs/devlog/W5-2-a.md` §四。
**adapter 里不许有任何 build-time 常量参与「Modal 能不能用」的判定**——
判定只能来自运行期读配置。阴性对照：把判定改成读一个编译期常量 → 测试必须红。

**约束二：没配 token 时的口径必须是「未配置」，不是「不可用」也不是「可用」。**
`doctor` 与 `capabilities --json` 都要如实报 `credentialConfigured: false`（§2.11 已有字段），
并给出**配置指引**（V36 的质量要求）。

- 报「不可用」是错的：能力在，只是没凭据，和 `openmm` 没装是两回事；
- 报「可用」更错——那是 AD-12 明令禁止的形状，本波刚因为这个修了 V34 和二进制的「技能 0 个」。

**约束三：假 gateway 不许成为永久替身。**
录制层用假 gateway 过契约测试是**为了让契约先立起来**，不是 Modal 的实现。
所以 `modal.ts` 必须在 `ALLOWED_ORPHANS` 或等价位置留一条明确的
「**等真实录制**：拿到 token 后必须补一次真实 gateway 录制并删本条」——
与 W5-1 α 的「等接线」同一套纪律。**没有这条登记，假 gateway 会活到发布。**

### 对外材料的口径

v0.5.0 发布时**不许**宣称「支持 Modal 远端算力」。准确的说法是：
**算力抽象层与审批链已落地并有 local 实现；Modal adapter 的契约已立、真实链路未验证。**
（这与 v0.4.0 发布时如实说明三件未关闭事项是同一条纪律。）
