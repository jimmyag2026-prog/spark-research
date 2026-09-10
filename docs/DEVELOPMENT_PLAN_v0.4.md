# Spark Research v0.4.0 开发方案

> 制订时间：2026-09-10（PDT）· 起点：`main` v0.3.1（`3599b75`）
> 上游文档：`DEVELOPMENT_PLAN_v0.3.md`（主线 A/B/C 的架构设计仍然有效，本文承接并修订）
> **本文是 v0.4 的唯一施工真源**；v0.3 文档的 P11–P16 章节以本文为准

---

## 〇、一句话

**v0.3 还清了并发与超时的债，v0.4 把「Agent 平台」这句话变成真的：
子代理真的会用工具、任务完成由证据图判定、装一个扩展像装一个 npm 包、
而这一切都要能被一个对本仓库一无所知的外部 agent 独立走通。**

---

## 一、起点：v0.3 教了什么，哪些计划因此要改

### 1.1 v0.3 的三次事故，全部要变成 v0.4 的施工约束

| 事故 | 表现 | v0.4 的应对 |
|---|---|---|
| **v0.2.1 被 P10 静默绕过** | P10 分支从 v0.2.1 之前拉出，合并后 tag 声称的修复在 main 上不存在；不冲突不告警，靠偶然瞥见 `/api/health` 才发现 | 纪律 §5.3 新增「单一合并权」与「integration 必须先对齐 origin/main 并复验旧 tag」 |
| **PR #22 合并了空变更** | `git push -q …; echo pushed` 里的 echo 掩盖了推送失败，远端分支停在旧 commit，GitHub 照常「合并」 | 纪律新增「push 后必验远端 ref」；每个阶段门加一条 `git diff <分支> origin/main` 应为空 |
| **v0.3.0 带着 UI 回归发布** | 后端拆掉 `wet_run`，前端执行按钮仍按旧状态名判可用 → 批准后按钮永远是灰的。**e2e 用例本来就存在，只是没跑** | **`bun run test:e2e` 进入每一个阶段门**；跨层改动强制走「消费方清扫清单」 |

> 三次事故是同一个形状：**不报错、不冲突、只是静默什么都没发生**。
> v0.4 的验证设计围绕这一句展开——凡是「失败会长得像成功」的地方，都要有一条显式断言。

### 1.2 P10 并行实测：哪些成立，哪些要补

**成立的**（继续照做）：一 lane 一 worktree、文件所有权互斥表、高冲突文件禁碰、
lane → integration → 一个 PR。四条 lane 的纪律零违反。

**要补的**：

| 问题 | 实测 | v0.4 修正 |
|---|---|---|
| lane worktree 无 `.venv` | 17 个 OpenMM 契约用例**静默 skip**，lane 报绿但没跑 | lane 建好后必须 `uv sync`（或链接主仓 `.venv`）；lane 报告必须写明**哪些套件没跑成** |
| 跨 lane 语义冲突 | D-d 拆状态 → `routes/lab.ts` 硬编码旧状态名，四条 lane 各自绿、合起来红 | 已由纪律 11 覆盖；v0.4 再加**消费方清扫清单**（见 §5.4） |
| 真正的瓶颈是审查带宽 | 4 条 lane = 4 份 PR 等审，串行尾巴占了相当比例的时间 | lane 上限仍是 4；**串行尾巴的工作量要在排期里显式计入**，不再当成「收个尾」 |
| 破口在跨会话 | 另一个会话直接把 lane 分支合进 main | §5.3 单一合并权 |

**一个意外的正收益**：三条 lane 在没被强制要求的情况下都做了**阴性对照**
（回退自己的修复、确认测试真的会红）。这条已被证明极其有效，v0.4 **升级为强制要求**。

### 1.3 v0.3 遗留的、必须进 v0.4 的新发现

| # | 发现 | 来源 |
|---|---|---|
| V22 | **`capabilities` 对外广播了一个无法调用的技能**——`protein-analysis` 在 `capabilities --json` 里带完整描述、`triggers`、connector 清单与 `validation` 列表，而 CLI / HTTP / MCP **三个入口全无**。外部 agent 读了 triggers 会确信自己能调用它。**不是完整性缺口，是自描述面撒谎**（AD-12 的直接违反） | D-12 门禁首次运行 + v0.4 制订时的可达性矩阵实测 |
| V23 | 湿实验 `unconsumedWarnings` 只在 CLI 强制显示，**HTTP / Web 审批面没接** | lane D-d 交付说明 |
| V25 | `concentration_limit` / `biosafety` 在自然语言主管线上**仍然空转** | lane D-d，D-8 的授权范围 |
| V24 | `RecordIntegrityError` 没有「人工确认后修复」的恢复路径 | lane D-d |
| V20/V21 | `CONFIG_DIR` 不认 `SPARK_RESEARCH_DATA_DIR`；超时类环境变量前缀不统一 | lane D-c / 串行收口 |
| — | **`tests/integration/` 8 个用例是 `skipIf(!RECORDING)`**，connector 对真实上游的行为从未在本轮验过 | v0.3.1 验证复盘 |
| — | **`records.db` 迁移没拿真实的 v0.2.x 老库跑过**，只有单测覆盖迁移逻辑 | v0.3.1 验证复盘 |

---

## 二、范围

### 2.1 做什么（六件事）

1. **可达性收口**——每一个对外声称的能力必须有可达的生产入口（AD-5 收紧）
2. **LLM Runtime v2**——tool calling / usage 记账 / 流式 / JSON 模式 / 真正的模型中立
3. **ToolBus + 真子代理**——子代理会用工具、有预算、有审计、永不自批准
4. **研究循环**——contract 完成判据（问图不问模型）、replan、帧级记账、findings 状态机
5. **上手性**——npx / 单二进制 / 零参数起 UI / 向导 / 离线 demo / 本地模型 / SSE 流
6. **扩展面**——声明式 connector / TS 扩展 / 外部 MCP client / `ext verify` 契约化验收

外加**附线**：文献域补强（arXiv/PubMed 走声明式 manifest，兼作扩展机制验收）。

### 2.2 明确不做

| 不做 | 理由 |
|---|---|
| 对接物理 Opentrons（V6） | **硬前置未满足**：V25 的 `concentration_limit` / `biosafety` 仍空转。v0.4 会补 V23（UI 强制显示告警），但补完仍不够 |
| 多用户真实身份（V10） | 先把 agent 层做实；`actor` 仍是「谁自称就是谁」 |
| 删 deprecated 别名（V15） | v0.2.0/v0.3.x 已公开发布带着它们，删是 breaking change，走废弃周期到 v0.5 |
| 追 connector / skill 数量 | AD-5 不变。v0.4 解决的是**让用户 30 分钟自己加一个**，不是我们加 46 个 |
| 插件市场 / 远端扩展仓库 | 先有装载与验收机制，v0.4 只做本地目录装载 |

---

## 三、阶段总览

```
P11 ─┬─ 接口先行：llm/types.ts ──┬─ R-a OpenAI 兼容基座
     │                          ├─ R-b Anthropic 原生
     │                          └─ R-c 预算与能力位
     └─ R-d 可达性闸门（独立，不依赖接口）
                    │
                    ▼
P12 ─┬─ T-a ToolBus（授权/预算/审计）
     └─ T-b 真子代理 tool loop + 删 swarm          ──┐
                    │                                │
                    ▼                                │  P14 上手性
P13 ─┬─ C-a contract + replan + 帧级记账             │  （只依赖 P11 流式，
     └─ C-b findings 状态机（完全独立）              │    与 P12/P13 全程并行）
                    │                                │
                    ▼                                │
P15 ─┬─ X-a 扩展装载 + ext verify  ◀─ 依赖 P12 ToolBus
     └─ X-b 声明式 connector + MCP client
                    │
                    ▼
P16  文献域补强（arXiv/PubMed 走 manifest = 扩展机制的真实验收）+ 发布 v0.4.0
```

**关键路径**：P11 → P12 → P13 → P15 → P16。**P14 不占关键路径。**

---

## 四、各阶段设计

### 4.1 P11 · LLM Runtime v2 + 可达性闸门

#### R-a/b/c：LLM Runtime v2

现状复核（v0.3.1）：`llm/router.ts` 254 行，D-b 加了超时与 `fetchImpl` 注入，
但**仍然没有 tool calling、没有 usage、没有流式、没有 `response_format`**，
且 `SUPPORTED_PROVIDERS` 声明 6 个 provider 只实现 kimi / openrouter 两个。

架构与类型设计**沿用 v0.3 文档 §4.1**（`llm/types.ts` + `providers/` 三件套），
本文只记 P10 之后新增的两条约束：

1. **`ok=false ⇒ content=""`（AD-13）在本阶段落地**。P10 的 D-4 只做了战术版
   （orchestrator 四处检查 `res.ok`）；类型层根治在这里做完，并**删掉那四处 if**——
   否则会留下「两套防线，改一处不改另一处」的漂移面。
2. **provider 能力位必须进 `capabilities --json`**：`{ toolCalling, jsonMode, streaming, usageReported }`。
   外部 agent 在选模型**之前**就要知道能不能跑 tool loop，而不是跑到一半才发现。
   这条同时是 P12 的前提——ToolBus 遇到不支持 tool calling 的模型要能**显式降级**
   （降级为「JSON 计划 + 逐步执行」模式并如实告知），而不是静默失败。

**风险与对策**：国产 provider 的 tool calling 兼容性差异大。
对策是**能力位在运行时可探测**，且降级路径有独立 e2e——不能只在「模型配合」时才工作。

> **上游情报可用（2026-09-10 补）**：对 OpenScience v2.0.86 的 provider 层做过源码级调研，
> per-provider 怪癖表在本地规划目录 `spark-research-v0.5-plan/workstreams/provider/PROVIDER_QUIRKS.md`
> （刻意未入库，v0.5 评审时再定去留）。对 R-a/R-b 直接有用的三条：
> ① DeepSeek 是唯一需要**结构性改写工具 schema** 的 provider，且 thinking 模式下要剔除 `tool_choice`；
> ② OpenRouter 不显式请求会**静默丢弃推理轨迹**；
> ③ Qwen 在上游几乎零专属适配，兼容性未经验证——正好是我们「能力位运行时可探测」要兜住的那类。
> 实施 R-a/R-b 前先查这张表，别重新踩一遍坑。

#### R-d：可达性闸门（新增，独立 lane）

**问题**（v0.4 制订时实测了全部 10 个技能的可达性矩阵，结论比初判严重）：
`protein-analysis` 是 10 个里**唯一 CLI / HTTP / MCP 三个入口全无**的，也是唯一 SKILL.md 里没有 CLI 示例的。
而 `capabilities --json` **照常把它当可用能力广播**——带描述、`triggers`（「这个蛋白长什么样」
「有没有可用的结构」）、connector 清单、`validation` 文件列表。外部 agent 读了 triggers 会确信能调用它。

所以这不是「少个入口」，是**自描述面在对外撒谎**——AD-12 的直接违反，而现有门禁只查孤儿模块、
没查技能可达性。AD-5「每个技能必须有配套 e2e 验证才算完成」在这里也被**纸面满足**了：有 e2e，但没人能用。
（附带：它列的 `validation` 第二项属于 8 个 `skipIf(!RECORDING)` 用例之一，本轮从未跑过。）

**AD-5 收紧为**（写入 DESIGN）：

> 技能「完成」的判据是 **e2e 验证 + 至少一条可达的生产入口**（CLI / HTTP / MCP 三者之一），
> 且该入口出现在 `capabilities --json` 里。只有测试能调到的能力等于不存在。

**交付**：
1. `narrative_parity.test.ts` 新增断言：`skills/` 下每个 SKILL.md 对应的能力，
   必须在 CLI 命令表 / HTTP 路由表 / `MCP_TOOLS` 至少一处可达，且在 capabilities 输出里
2. 补 `protein-analysis` 的生产入口（CLI + MCP 工具各一条），或从技能目录撤下——**二选一，不许悬着**
3. **V23**：`unconsumedWarnings` 接进 HTTP 审批响应与 Web 审批弹窗，**并加 e2e 断言**
   （批准界面必须显示「你写了但安全门没看见」的内容）
4. **V20**：`index.ts` 的 `CONFIG_DIR` 改为走 `dataDir()`，与 `config/index.ts` 同一套解析

> R-d 与 R-a/b/c 零文件重叠，可全程并行；它也是 P11 里唯一**不依赖接口先行**的 lane。

### 4.2 P12 · ToolBus + 真子代理

架构沿用 v0.3 文档 §4.2（`AgentToolBus` 套在 P9 的 `McpToolRunner` 外面，加授权/预算/审计）。
P10 之后的修订：

1. **MCP 工具已增至 29 个**（v0.2.1 又加了几个），ToolBus 的 `specs()` 必须与
   `MCP_TOOLS` **同源**，不另写一份。
2. **`MCP_WITHHELD` 直接复用**（AD-9 已有的五个扣留工具），不重新实现一张危险动作表。
   AD-14「子代理永不自批准」= ToolBus 对 `MCP_WITHHELD` 同样拒绝 + 对抗测试。
3. **V19（审批要求可交互终端）与 AD-14 同批做**：AD-14 挡的是默认路径，
   V19 才是技术防线（CLI 审批要求 TTY 或非交互环境拿不到的确认令牌）。两者缺一不可。
4. **删 swarm**：`swarm.ts` / `swarm_types.ts` 及其测试。
   注意 D-12 门禁的 `ALLOWED_ORPHANS` 里有它的登记条目，**删代码后必须同步删登记**——
   门禁的「stale 条目」断言会强制这件事（这正是那条断言的用途）。
5. **V16**：子代理独立模型暴露成用户配置项（`SubAgentSpec.model` 终于有真消费方）。
6. **接口预留，不写实现（2026-09-10 补）**：v0.5 已拍板做远端算力（BACKLOG V4 启动条件触发），
   它将是 ToolBus 的下一类消费者——**计费型后果动作**（提交一个 Modal GPU 任务 = 花真钱）。
   P12 只需保证两点被测试锁死，不为 v0.5 写任何代码：
   ① `MCP_WITHHELD` 的拒绝对子代理无例外（AD-14 对抗测试天然覆盖，将来 `compute approve` 加入扣留清单即可）；
   ② 预算记账的接口不把计量单位硬编码为 token——留一个可扩展的计价维度，否则 v0.5 接算力成本时要拆了重做。

### 4.3 P13 · 研究循环

架构沿用 v0.3 文档 §4.3（contract stages / replan / `agent_run` record / findings 状态机）。
P10 之后的修订：

1. **`agent_run` 是第 9 类 record**，而 records 表在 D-9 之后有了 `rev`（CAS）与
   `integrityHash`。新 record 类型必须走同一套写入路径，**不得绕过完整性校验**。
2. **AD-10 的最大设计风险**：`check(q)` 写得太严会让 agent 永远判定「未完成」而空转。
   对策是**三条并行的停机条件**，缺一不可：
   - `contract.allDone()` — 正常完成
   - `noProgress(2 轮)` — 连续两轮证据图无新增节点 → 停并报告未完成的 stage
   - `budget` 耗尽 → `stopReason: "budget"`，**明确区别于 `done`**
3. **findings 状态机（C-b）与 contract/replan（C-a）零文件重叠**，全程并行。

### 4.4 P14 · 上手性

沿用 v0.3 文档 §4.4。P10 之后新增两条：

- **V11 长任务句柄落盘**升级为必做：v0.2.1 的零上下文外部验收已经撞上这个
  （任务句柄在 server 进程内存里，连接一断即失效）。这是外部 agent 体验的头号摩擦点。
- **V17 MCP 长任务进度回传** + **V18 `capabilities --probe` 缓存**一并做（同属「看得见在干活」）。
- **本地模型接入有现成情报（2026-09-10 补）**：OpenScience `local.ts` 的实现清单已整理在本地规划目录
  `spark-research-v0.5-plan/workstreams/provider/V05_PROVIDER_DESIGN.md` §c（未入库）。
  三个上游实测坑：本地端点**不能设超时**（大模型冷加载分钟级）；Ollama 的上下文窗口要走
  `/api/create` 别名机制而不是请求参数；Ollama/LM Studio 各有端口预设与响应形状差异。做 P14 本地模型时先读它。

### 4.5 P15 · 扩展面

沿用 v0.3 文档 §4.5（三种装载强度 + `ext verify` 契约化验收 + AD-11）。P10 之后的修订：

**声明式 connector 的 manifest 必须映射到 D-a 之后的新契约**：
「同名方法即 handler」已在 v0.3.0 废除，现在是构造期显式 `this.handle(toolName, fn)` 注册。
manifest 的每个 tool 声明编译成一条 handler 注册，**天然继承 D-1 的并发安全性质**——
这是 v0.3 的债务清算给 v0.4 带来的直接红利，manifest 设计要显式利用它。

`ext verify` 的 connector 契约测试**直接复用 `tests/concurrency/connector_race.test.ts` 的不变式**：
第三方 connector 也必须通过 100 并发参数映射一致性检查。

**manifest 表达力的三条实测约束（2026-09-10 补）**：v0.5 规划期间对 30 个候选数据源
做过 staged 实现调研（本地规划目录 `spark-research-v0.5-plan/workstreams/connectors/`，未入库），
manifest schema 设计时要把这三条当验收用例，而不是做完才发现表达不了：

1. **参数要支持 enum 校验**——bioRxiv 的 `server` 参数只认 `biorxiv|medrxiv`，声明不了枚举的 manifest 挡不住脏输入；
2. **声明式映射覆盖不了响应体分支**——BindingDB 无匹配时返回 HTTP 200 + 空 body（不是 404），
   这类源就该留在 TS 装载强度，manifest 不必追求全覆盖（三种装载强度并存正是为此）；
3. **「一次 fetch 查多实体」的形态要拆**——OpenTargets 一个接口横跨 target/disease/drug 三类实体，
   进 manifest 应拆成多个 tool 声明，而不是造一个万能参数。

### 4.6 P16 · 文献域 + 发布

沿用 v0.3 文档 §4.6（E-1…E-6）。新增两条**验证性任务**（都来自 v0.3.1 的验证复盘）：

- **跑一次真实网络的 `tests/integration/`**（`RECORDING=1`），重新录制 fixture 并核对
  上游 API 是否已漂移——这套用例从写下来之后**在本轮从未跑过**
- **拿一个真实的 v0.2.x 老 `records.db` 跑迁移演练**，确认 D-9 的 `rev` 列迁移在真实老库上成立

**限速预算注意（2026-09-10 补，登记为 BACKLOG V26，P16 不实现）**：connector 层目前只有
礼貌头（`politeness.ts`），**没有任何限速器**。P16 的 pubmed manifest 与 v0.5 计划新增的
ClinVar / GEO 都打 NCBI eutils 的**同一主机预算**——将来限速器若做，必须按 host 键控合池，
不能按 connector 各自为政，否则四个 connector 会集体被 429。

---

## 五、并行方案

### 5.1 lane 划分与文件所有权

> **铁律不变：一个文件同一时刻只属于一条 lane。** 越界先回报，不自行扩权。

**P11（4 lane）**

| lane | 模型 | 独占文件 |
|---|---|---|
| **接口先行**（必须先单独合入） | Opus 5 | `llm/types.ts` + `llm/router.ts` 门面 |
| `R-a` OpenAI 兼容基座（含 ollama / vLLM / 本地端点） | Opus 5 | `llm/providers/openai_compat.ts` |
| `R-b` Anthropic 原生 | Sonnet 5 | `llm/providers/anthropic.ts` |
| `R-c` 预算与能力位 | Sonnet 5 | `llm/budget.ts` `llm/providers/registry.ts` `capabilities/` 的 provider 段 |
| `R-d` **可达性闸门**（不依赖接口先行） | Sonnet 5 | `tests/unit/narrative_parity.test.ts` · `proteins/**` · `skills/protein-analysis/**` · `lab/` 的 unconsumedWarnings 出口 · `server/routes/lab.ts` · 前端审批弹窗 · `index.ts` 的 CONFIG_DIR 段 |

**P12（2 lane，Opus 5）**：`agents/toolbus.ts` ‖ `agents/subagent.ts` + `agents/prompt/*.txt` + 删 swarm（含删门禁登记）
**P13（2 lane，Opus 5）**：`agents/contract.ts` + replan + `agents/ledger.ts` ‖ `reviewer/findings_store.ts` + CLI（**完全独立**）
**P14（2 lane，Sonnet 5）**：分发打包（npx/单二进制/brew） ‖ 向导 + demo + SSE 流 + 任务句柄落盘
**P15（2 lane，Opus 5）**：扩展装载 + `ext verify` ‖ 声明式 connector + MCP client
**P16（3 lane，Sonnet 5）**：manifest 源（arXiv/PubMed） ‖ judge 降本 ‖ 元数据修复 + 真实网络录制 + 老库迁移演练

### 5.2 lane 启动清单（写进每份任务书）

```
① git worktree add ~/Desktop/AI4S/spark-research-<lane> -b feat/<phase>-<lane> feat/<phase>-integration
② bun install --frozen-lockfile
③ uv sync（或链接主仓 .venv）—— 不做这步，17 个 OpenMM 用例会静默 skip
④ export SPARK_E2E_PORT=<4400 + lane 序号>
⑤ 只改所有权表里属于本 lane 的文件；越界先回报
⑥ 不碰 CHANGELOG / BACKLOG / README / DEVELOPMENT_PLAN*；devlog 只写 docs/devlog/<phase>-<lane>.md
⑦ 提 PR 前跑**全量**：typecheck + bun test tests/unit/ + tests/concurrency/ + tests/timeout/
   + **bun run test:e2e** + test:py + test:lab
⑧ **阴性对照是强制项**：回退自己的修复，确认新测试真的会红，把结果写进 devlog
⑨ 报告里必须写明**哪些套件没能在本 lane 跑成**（不许把 skip 当通过）
⑩ 目标分支是 feat/<phase>-integration，不是 main；不 push main、不开 PR、不 merge
```

### 5.3 纪律（在仓库现有 11 条之上新增 3 条）

> 建议一并写进 `docs/DEVELOPMENT_PLAN.md` 的工程纪律小节。

**12. push 后必验远端 ref**（本次事故新增）
`git push -q …; echo ok` 会用无条件 echo 掩盖推送失败。开 PR 前执行
`git ls-remote --heads origin <branch>` 确认远端 ref 就是本地 HEAD；
合并后执行 `git diff --stat <本地分支> origin/main` 应为空。
**失败会长得像成功**——PR #22 就是这么合了一个空变更。

**13. 跨层改动必须跑 e2e + 消费方清扫**（v0.3.0 回归后新增）
后端改动只要触及**对外词汇表或响应形状**（状态名、枚举、端点字段、错误码），
就必须：① 跑 `bun run test:e2e`；② 走一遍消费方清扫清单——
`frontend/workspace/src`、`mcp/tools.ts` 的工具描述、`llms.txt`、`skills/*/SKILL.md`、
`capabilities` 输出、`docs/`。**typecheck 抓不到字符串比较。**

**14. 单一合并权**（跨会话事故后新增）
同一时刻只有一个会话拥有向 `main` 合并的权力。其他会话产出一律停在分支上。
integration 分支在开 PR 前必须 `git fetch` 并确认 `origin/main` 是自己的祖先，
且复验全部既有 tag 仍在 `origin/main` 历史里。

### 5.3·补 · 新建模块但无权接线时怎么办（P11 实战补充）

**P11 撞上的真实冲突**：lane R-b 交付 `llm/providers/anthropic.ts`，但 `router.ts` 的
`ADAPTERS` 注册被主会话**刻意扣下**（R-b 与 R-c 都可能要动 router，扣下是为了避免
P10 那种「四条 lane 各自绿、合起来红」）。结果是 R-b 的新模块**在自己分支上没有任何
生产调用方**——直接踩中 D-12 的孤儿模块门禁（那条断言当初就是用来抓 `swarm.ts` 的）。

**门禁是对的，扣接线也是对的，冲突在于两者没协调。** 这不是个例：任何
「lane 新建模块 + 接线权在别处」的组合都会踩到，而 v0.4 剩下的阶段里这种组合很多
（P12 的 ToolBus、P13 的 ledger、P15 的扩展装载器都是新模块）。

**处置（此后照做）**：

1. 创建模块的 lane **自己**往 `ALLOWED_ORPHANS` 加一条登记，理由写成
   「**等接线**：<谁> 在 <哪个阶段> 接线，接完必须删本条」
2. 主会话接线时**删掉那条登记**
3. 门禁的「多余登记必须删除」对称检查会强制这件事：
   - 接了线 → 条目变多余 → 不删就红
   - 忘了接线 → 模块还是孤儿 → 也红

   **两个方向都被钉住，忘不掉。**

> 顺带一提，这让门禁从「防止叙事漂移」多长出一个用途：**它同时是一张接线清单**。
> 这是 AD-12 没预料到的正收益——把「声称与实现必须对账」推到极致，
> 连「模块建好了但没接上」这种半成品状态也被自动追踪了。

**给 lane 任务书的模板句**：
> 你新建的模块如果暂时没有生产调用方（接线权不在你这里），
> 在 `ALLOWED_ORPHANS` 里登记一条并写清「等谁接线」——**只许加登记，不许改断言逻辑**。

---

### 5.3·补二 · spawn 前必须回到中立目录（W1/W2 各踩一次）

**现象**：子代理 spawn 时继承主会话当时的 cwd。W1 与 W2 两波我都停在某条 lane 的 worktree 里发任务，于是四个子代理的 pwd 全是那条 lane 的目录——**三条与自己的 brief 错配**。

**后果比想象的重**：任务书里「不要动其他 worktree」这条隔离规则，和错配的 cwd 组合起来会产生一个**看似合理的错误推论**——子代理会把沙盒绑定读成指派信号，进而认为「我被指派的是 pwd 这条 lane，brief 发错了」或「另一个 session 正在我 brief 指向的目录里跑，我进去会撞车」。
W1-c 与 W2-c 两次都是这么停下来的，而且**它们的推理在可观测信息范围内完全正确**。

**在 brief 第一行写 `cd <绝对路径>` 不足以解决**（W2 就是这么写的，照样触发）——因为矛盾不在「不知道去哪」，而在「环境和指令互相矛盾时该信哪个」。

**做法**：
1. **spawn 前 `cd` 回主仓**（`~/Desktop/AI4S/spark-research`），让所有子代理继承一个中立目录；
2. brief 里把隔离规则写准：「**不要动其他 lane 的 worktree 和主仓**；你自己 lane 的工作区就是你该待的地方，   不管初始 cwd 在哪」；
3. 如果子代理还是停下来问——**那是对的行为，别嫌它烦**。这个项目踩过三次「不冲突、不告警、   只是静默出错」的坑（v0.2.1 被绕过 / PR 合空变更 / UI 回归），子代理主动拦截同类风险是净收益。

---

### 5.4 消费方清扫清单（纪律 13 的可执行形式）

改了后端的对外词汇表 / 响应形状后，逐项确认：

| 消费方 | 怎么查 |
|---|---|
| Web 工作台 | `grep -rn "<旧词>" frontend/workspace/src`（**注意是字符串比较，tsc 不管**） |
| MCP 工具描述 | `grep -n "<旧词>" backend/src/mcp/tools.ts` — 这些字符串是给外部 agent 看的 |
| 自描述端点 | `capabilities --json`、`/api/lab/machine` 等**必须能从真源推导**，不许手写 |
| llms.txt | `bun run gen:llms` 后 `git diff` 应为空（否则就是忘了重新生成） |
| SKILL.md | `grep -rn "<旧词>" backend/src/skills/` |
| 文档 | README / DESIGN / EXTENDING |

**能自动化的都进 `narrative_parity.test.ts`**——清单是给人看的兜底，门禁才是防线。

---

## 五·补 · P12–P16 的波次调度（P11 后重排）

> **为什么要重排**：§三的依赖图是**阶段级**的（P12→P13→P15→P16 串行），
> 但真实依赖是**任务级**的，比阶段级松得多。按阶段排会让大量互不依赖的任务白等。
> 本节把 P12–P16 的任务拆开重新打包，阶段编号保留为**交付分组标签**（CHANGELOG /
> 里程碑仍按 P12–P16 讲），**执行按波次**。

### 5·补.1 任务级依赖图（重画）

```
R-c(budget.ts) ──► T-a ToolBus ──┬─► T-b 子代理 tool loop ──┐
                                 │                          ├─► C-b replan 循环
                                 └─► X-c 外部 MCP client    │
                                                            │
C-a contract stages（只依赖证据图，**不依赖 ToolBus**）──────┘

X-b 声明式 connector manifest（只依赖 v0.3.0 的 connector 契约）──► E-1 arXiv/PubMed
X-a 扩展装载 + ext verify（只依赖已有的契约测试套件）

以下**零跨依赖**，随时可开：
  C-c agent_run 帧级记账 · C-d findings 状态机 · B-a 打包分发 ·
  B-b 向导+demo · B-c SSE 流（依赖 P11 流式，已就绪）· B-d 长任务句柄落盘 ·
  E-2…E-6 文献域修复 · 真实网络录制 · 老库迁移演练 · 删 swarm · V17/V18/V19
```

**真正的关键路径只有一条**：`R-c → T-a → T-b → C-b`。其余全部可以绕开它并行。

### 5·补.2 四个波次（每波 4 条 lane，上限仍是审查带宽）

| 波次 | lane | 任务 | 依赖 | 模型 |
|---|---|---|---|---|
| **W1** | `W1-a` | **T-a ToolBus**（授权 / 预算 / 审计三层，套在 P9 的 `McpToolRunner` 外） | R-c 的 `BudgetLedger` | Opus |
| | `W1-b` | **C-d findings 状态机**（open→addressed→resolved→reflagged + CLI） | 无 | Sonnet |
| | `W1-c` | **X-b 声明式 connector manifest**（受限映射 DSL + SSRF 白名单） | 无 | Opus |
| | `W1-d` | **B-a 打包分发**（`bun build --compile` 单二进制 / npm meta 包 / brew） | 无 | Sonnet |
| **W2** | `W2-a` | **T-b 子代理 tool loop**（`SubAgentSpec` + 预算 + stopReason 回流） | W1-a | Opus |
| | `W2-b` | **C-a contract stages**（AD-10：完成判定问图不问模型） | 无 | Opus |
| | `W2-c` | **X-a 扩展装载 + `ext verify`**（三种强度 + 契约化验收） | 无（与 W1-c 配对） | Opus |
| | `W2-d` | **B-b/B-c 向导 + demo + SSE 流** | P11 流式 ✓ | Sonnet |
| **W3** | `W3-a` | **C-b replan 循环**（观察回流 + 三条停机条件） | W2-a + W2-b | Opus |
| | `W3-b` | **C-c agent_run 帧级记账**（第 9 类 record，走 rev + integrityHash） | R-c | Opus |
| | `W3-c` | **X-c 外部 MCP client**（外部工具进 ToolBus 与 capabilities，调用落执行记录） | W1-a | Opus |
| | `W3-d` | **E-1 arXiv/PubMed 走 manifest**（**兼作扩展机制的真实验收**） | W1-c | Sonnet |
| **W4** | `W4-a` | **删 swarm** + README 宣传语撤下 + V16 子代理模型配置 + V19 审批要 TTY | W2-a | Sonnet |
| | `W4-b` | **E-2…E-6 文献域修复** + 真实网络录制 + **真实 v0.2.x 老库迁移演练** | 无 | Sonnet |
| | `W4-c` | **B-d 长任务句柄落盘（V11）** + V17 MCP 进度回传 + V18 probe 缓存 | 无 | Sonnet |
| | `W4-d` | 机动位：吸收前三波溢出的未完成项 | — | — |

**波次间的串行尾巴**（主会话，不可省，P10/P11 实测占相当比例）：
合 integration → 跨 lane 语义冲突收口 → 接线（含删 `ALLOWED_ORPHANS` 的「等接线」登记）
→ 六套件全量 → devlog/CHANGELOG。

### 5·补.3 三次零上下文外部验收的插入点

| 时点 | 任务 | 看什么 |
|---|---|---|
| **W2 末** | 检索入库 → 建 idea → novelty check → 发起干实验并读回结论 | 子代理做实之后，外部 agent 的摩擦是否真的少了 |
| **W3 末** | 按 `EXTENDING.md` 用 manifest 加一个全新数据源并过 `ext verify`，**全程不改仓库源码** | 扩展机制是否真的可自助 |
| **W4 末** | 干净机器 `npx spark-research` 走通完整研究线索 | 发布判据 |

**第二次必须由未参与开发的人/会话执行**——自己验自己的扩展机制没有意义。

### 5·补.4 相对阶段串行的收益与代价

**收益**：关键路径从「P12→P13→P15→P16 四阶段」压缩成「W1→W2→W3 三波」，
P14 全部与 P15 的一半提前到 W1/W2，E-2…E-6 这类零依赖修复不再压在最后。

**代价（必须正视）**：一个波次会同时触及多个阶段的文件，**跨 lane 冲突面比阶段内更大**。
对策是文件所有权表按**波次**而非阶段维护，且沿用 P11 已验证的两条：
① 多方争用的文件（如 `router.ts`、`mcp/tools.ts`、`server/app.ts`）**一律从所有 lane 摘出，收口时统一接线**；
② 新建但无权接线的模块，lane 自己登记 `ALLOWED_ORPHANS` 并写清「等谁接线」（§5.3·补）。

**已知的争用热点**（提前登记，收口时统一接）：

| 文件 | 谁想动 | 处置 |
|---|---|---|
| `backend/src/llm/router.ts` | 无（P11 已收口） | — |
| `backend/src/mcp/tools.ts` | W1-a（ToolBus 读 MCP_TOOLS）· W3-c（外部工具注册）· W4-c（V17 进度） | 只读者不动它；需要写的收口统一接 |
| `backend/src/server/app.ts` | W2-c（扩展路由）· W2-d（SSE 端点） | 收口统一接 |
| `backend/src/capabilities/index.ts` | W1-c/W2-c（扩展）· W3-c（外部工具） | 收口统一接 |
| `tests/unit/narrative_parity.test.ts` | 多个 lane 要加/删登记 | **只许改 `ALLOWED_ORPHANS` / `SKILL_ENTRYPOINTS` 的条目，不许动断言逻辑** |
| `docs/BACKLOG.md` `CHANGELOG.md` `README.md` | — | **禁止 lane 触碰**，收口统一写 |

---

## 六、验证方案

### 6.1 阶段门（每个阶段都要过，无例外）

1. `bun run typecheck` 干净
2. `bun test tests/unit/` 零回归（基线随阶段推进，v0.4 起点是 **905**）
3. `tests/concurrency/` + `tests/timeout/` 全绿
4. **`bun run test:e2e` 全绿** ← v0.3.0 的教训，不可省
5. `bun run test:py` + `bun run test:lab` 全绿
6. **阴性对照**：本阶段新增的每一条关键测试，都要验证过「回退实现会红」
7. `git diff --stat <integration> origin/main` 在合并后为空

### 6.2 各阶段专属验证

| 阶段 | 专属对抗测试 |
|---|---|
| P11 | provider 矩阵契约（tool calling / JSON 模式 / 流式 / usage 各一条录制回放）；**不支持 tool calling 的模型必须走显式降级路径且有独立 e2e**；`ok=false ⇒ content=""` 的类型层断言 |
| P11 R-d | 每个技能的可达入口断言；`unconsumedWarnings` 在 Web 审批弹窗必须可见的 e2e |
| P12 | 越权工具被结构化拒绝；预算耗尽 `stopReason:"budget"` 而非 `done`；tool 结果真回灌（断言第二轮 prompt 含第一轮结果）；**子代理调 `lab_approve` 必被拒**（AD-14 红线）；swarm 删除后门禁登记同步消失 |
| P13 | **伪造完成**：FakeLLM 自称完成但图上无证据 → `allDone()` 为 false；**无进展停机**：两轮无新 record → 第 2 轮停止并报告未完成 stage；**记账诚实**：拿不到 usage 时 `costUsd: null` + `usageUnavailable`，不得填 0 |
| P14 | 干净机器（无 bun / 无 Python / 无 key）`npx spark-research` → `demo` 30 秒内看到证据图 |
| P15 | 恶意扩展矩阵：manifest 声明 A 却调 B；未 grant 却取凭据；声明式 connector 塞 `file://` / 内网地址（SSRF）；扩展抛异常主进程存活且 capabilities 标 `failed`；**第三方 connector 必须通过 100 并发参数映射一致性检查** |
| P16 | 真实网络录制一次并核对上游漂移；真实 v0.2.x 老 `records.db` 迁移演练 |

### 6.3 零上下文外部验收（v0.4 的主验收手段）

v0.2.1 就是这么来的：**一个对本仓库一无所知、被禁止读源码的 agent，只靠 MCP + llms.txt
跑完整链路，结果 8/10，暴露三个真实摩擦点。** 这是本项目信噪比最高的反馈来源。

v0.4 **跑三次**，而不是只在最后跑一次：

| 时点 | 任务 | 看什么 |
|---|---|---|
| P12 末 | 检索文献入库 → 建 idea → novelty check → **发起一次干实验并读回结论** | 子代理做实之后，外部 agent 是否真的少了摩擦 |
| P15 末 | 按 `EXTENDING.md` 用声明式 manifest 加一个全新数据源并 `ext verify` 通过，**全程不改仓库源码** | 扩展机制是否真的可自助 |
| P16 末 | 干净机器 `npx spark-research` → 完整研究线索走通 | 发布判据 |

**第二次由未参与开发的人/会话执行**——自己验自己的扩展机制没有意义。

---

## 七、排期与模型分配

单位是「会话」（一次完整的范围确认 → 委派 → 跑测试 → 审代码 → 对照设计验收 → PR）。
v0.3 实测：P10 四条 lane + 串行尾巴 ≈ 一个工作日量级，**其中串行尾巴占了相当比例**。

| 阶段 | 量级 | lane | 主用模型 | 依赖 |
|---|---|---|---|---|
| P11 | 2–3 会话 | 4（含接口先行） | Opus（接口/R-a）+ Sonnet（R-b/c/d） | v0.3.1 |
| P12 | 2 会话 | 2 | Opus 5 | P11 |
| P13 | 2 会话 | 2 | Opus 5 | P12 |
| P14 | 2 会话 | 2 | Sonnet 5 | P11（流式） |
| P15 | 2 会话 | 2 | Opus 5 | P12（ToolBus） |
| P16 | 2 会话 | 3 | Sonnet 5 | P15 |

**分配依据不变**（v0.3 文档 §6.2）：抽象设计 / 原创设计 / 安全边界用 Opus，
规格明确的机械活与并行 lane 多的阶段用 Sonnet。
P11 的接口先行与 OpenAI 兼容基座是全版本地基，错了三条主线一起返工，必须 Opus。

**可裁剪顺序**：P15 的 MCP client → P14 的 brew/curl → P13 的 findings 状态机。
**不可裁剪**：P11 全部、P12、AD-10 的确定性完成判据、P11 R-d 的可达性闸门。

---

## 八、里程碑

| 里程碑 | 完成即可对外说的话 |
|---|---|
| P11 末 | 「模型是真中立的，且能力可运行时查询」+「声称的能力都调得到」 |
| P12 末 | 「子代理是真的会用工具的 agent」——撤下全部虚标宣传 |
| P13 末 | **「完成与否由证据图判定，不由模型自报」**——最值得写文章的一条 |
| P14 末 | 「一条 `npx` 命令，零 key 30 秒看到全貌」 |
| P15 末 | 「你自己加的数据源，装完就跑契约测试」 |
| P16 / v0.4.0 | 五大功能域 + 真 agent runtime + 自助扩展，三者中唯一有干湿闭环 |

---

## 九、风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 国产 provider 的 tool calling 兼容性差 | P12 落空 | 能力位运行时可探测；降级路径（JSON 计划模式）有**独立 e2e**，不能只在模型配合时才工作 |
| AD-10 的 `check()` 写太严 → agent 永远判未完成、空转烧钱 | P13 不可用 | 三条并行停机条件（allDone / noProgress / budget），且 `stopReason` 必须回流 |
| 声明式 connector 的映射 DSL 越做越像编程语言 | P15 复杂度失控 | 硬约束：受限 JSONPath 子集 + 固定归一化字段；**表达不了就写 TS 扩展**，这是特性不是缺陷 |
| 外部扩展 = 同 UID 代码执行 | 安全面扩大 | 默认推声明式（不执行代码）；TS 扩展需 `--trust` + 指纹确认；**文档必须直说这不是沙箱**（不重蹈 S-3「沙箱一行逃逸」的过度声明） |
| 串行尾巴被低估 | 排期失真 | v0.3 实测串行尾巴占相当比例，已在 §七 显式计入 |
| 又一次跨会话事故 | 成果静默丢失 | 纪律 12/13/14 三条；每次合并后 `git diff` 复核 |

---

## 十、给维护者

v0.3 证明了两件事：**并行开发在这个仓库是可行的**（四条 lane 纪律零违反、
合起来只有一处语义冲突），以及**「失败长得像成功」是这个项目当前最大的敌人**
——三次事故全是这个形状，没有一次是「代码写错了」。

所以 v0.4 的验证设计不是「多写测试」，而是**在每一处可能静默失败的地方装一条显式断言**：
push 有没有真的推上去、e2e 有没有真的跑、技能有没有真的能被调到、
模型说完成了图上有没有证据、扩展装上了有没有过契约。

功能上 v0.4 只做一件事：**把 README 第一句话里的「agent」两个字变成真的。**
