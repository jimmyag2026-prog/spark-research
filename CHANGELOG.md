# Changelog

本文件记录面向用户可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## [未发布] — v0.4.0 开发中

### P11 · LLM Runtime v2 + 可达性闸门

**模型中立从声称变成事实。** v0.3.1 实测：`SUPPORTED_PROVIDERS` 声明 6 个 provider，
`call()` 里只有 kimi / openrouter 两个能真发请求，其余静默落到 OpenRouter 或失败。

#### 新增

- **provider 适配层**：`ProviderAdapter` 契约 + 两个实现——
  `openai_compat`（一套代码覆盖 openai / kimi / deepseek / qwen / openrouter /
  ollama / vLLM / 任意自建 baseUrl）与 `anthropic`（原生 Messages API，与 OpenAI 形状差七处）。
  **实装 provider 由 2 个增至 6 个 + 任意本地端点。**
- **tool calling**（P12 真子代理的前提）· **流式**（`onDelta`，P14 的 SSE 流接它）·
  **JSON 模式**（`response_format`，根治 BACKLOG V12）· **token 用量与成本核算**
- **`BudgetLedger`**：调用数 / token / 成本上限，供 P12 子代理与 P13 帧级账本使用
- **单价表**（`providers/registry.ts`）：各 provider/model 输入输出单价，**每条附来源与核实日期**，
  可用 `SPARK_LLM_PRICING_JSON` 覆盖。查不到单价时 `costUsd` 保持 `null`，**绝不填 0 冒充免费**
- **provider 能力位进 `capabilities --json`**：`{id, models, configured, capabilities:{toolCalling,
  jsonMode, streaming, usageReported}}` + 独立的 `localEndpoint` 段。
  外部 agent 与 ToolBus 在**选模型之前**就能知道能不能跑 tool loop
- **`protein-analysis` 补齐三个生产入口**：CLI `spark-research protein <query>` ·
  `POST /api/proteins/analyze` · MCP 工具 `protein_analyze`（MCP 工具 29 → 30）。
  此前它有 SKILL.md、12 个 e2e、被 DESIGN 列为 10 技能之一，**却没有任何调用路径**，
  而 `capabilities` 照常带 `triggers` 对外广播它
- **技能可达性断言进门禁**（`narrative_parity.test.ts` 第 7 条）：每个技能必须至少有一条
  可达入口，登记表的每条都去 `index.ts` 的 `switch(cmd)` case 字面量 / `MCP_TOOLS` /
  `capabilities` 三处对账（不靠散文正则）
- 湿实验 `unconsumedWarnings` **接进 Web 审批弹窗**（此前只有 CLI 强制显示），配套 e2e ⑨b
- 配置项：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `QWEN_API_KEY` /
  `SPARK_LOCAL_LLM_BASE_URL` / `SPARK_LOCAL_LLM_API_KEY` / `llmPricingOverridesJson`
- `CallOptions.maxTokens`：Anthropic 的 `max_tokens` 是必填参数，此前硬编码 4096
  会让综述草稿这类长文本**静默截断**（只能从 `finishReason:"length"` 看出来）

#### 变更

- **`LlmResponse` 改为可辨识联合（AD-13）**：`ok:false` 分支的 `content` 是**字面量 `""`**、
  `error` **必填**。于是「失败但带内容」（内容被误当产出）与「失败但没说为什么」
  在编译期都不可能。调用方读失败原因请用 `error.message`，不要读 `content`
- 失败类型改为**机器可读**（`error.kind`：`auth` / `rate_limit` / `timeout` / `parse` /
  `upstream` / `unsupported`），调用方区分失败不再需要读文案
- `SUPPORTED_PROVIDERS`（模型名字典）与 `ADAPTERS`（真能发请求的清单）**显式分开**——
  v0.3.1 那个缺口的根因就是两者被混为一谈
- `providers/registry.ts` 的 `PROVIDER_API_KEY_ENV` 改为**从 router 的 ADAPTERS 派生**。
  它原本是手工副本，接线 anthropic 时立刻失同步、当场把一致性断言打红
- `index.ts` 的 `CONFIG_DIR` 改走 `dataDir()`，与 `config/index.ts` 归一解析（V20）
- 移除 `LlmResponse.mock`（v0.1 移除 mock 模式后的残留，零消费方）

#### 修复

- 五个域消费方（citation_judge / novelty / review / reading / coexplore）此前把
  `content` 当错误信息读。AD-13 清空 content 后，若不迁移它们的排障信息会**变成一片空白**
  ——测试全绿但诊断没了。已全部迁到 `error?.message`

#### 测试

单元 905 → **1018**（0 fail / 0 skip）· e2e 12 → **13** · concurrency + timeout 12 ·
pytest 48 · `test:lab` 26。

---

## [0.3.1] — 2026-09-10

### 修复

- **Web 工作台里湿实验批准后无法执行（v0.3.0 引入的回归）**：v0.3.0 把 `wet_run` 拆成
  `approved` / `executing`，但工作台底部实验面板的「执行（模拟器）」按钮仍按
  `state === "wet_run"` 判断是否可用——该状态已不存在，于是**按钮永远是灰的**，
  用户可以在 UI 里批准却永远执行不了，湿实验闭环在 Web 上断掉（CLI / HTTP / MCP 不受影响）。
  状态徽章色表同样缺 `approved` / `executing` 两个键。
- 执行按钮在 `executing` 态下的提示改为「已在执行中（执行权已被原子声明，approval 已消费）」，
  与 D-10 的一次性 approval 语义对齐。

### 新增

- **叙事一致性门禁扩到前端消费方**（`tests/unit/narrative_parity.test.ts`）：
  ① 已退役的状态名不许出现在任何源码里（后端 + 前端）；
  ② 前端 badge 色表的键必须真实存在于后端两套状态机，非状态键走显式白名单。
  阴性对照已验证：把前端改回 `"wet_run"` 会红。

### 教训

v0.3.0 的这个回归**有现成的 e2e 用例能抓到**（`workbench.spec.ts` ⑧「批准后落 decision record
并可执行」），发布前没跑而已——不是测试缺失，是流程缺失。原因是 v0.3.0 的验证清单里
只有 `bun test` / pytest / typecheck，漏了 `bun run test:e2e`；而 typecheck 抓不到它，
因为那是字符串比较不是枚举。**跨层改动（后端词汇表变更）必须跑前端 e2e。**

---

## [0.3.0] — 2026-09-10

**闸门 D：把「单线程测试永远测不出」的那批债一次还清。**

外部评审（对象 `b4aab02`，全量源码精读 + 本机复现）给出两条裂缝：一条是叙事超前于实现，
一条是并发与超时等工程基本功缺口。本版消化后者的全部，并为前者装上 CI 门禁。
**本版不含任何新功能**——评审列出的 Agent 层重做（真子代理 / contract / 扩展机制）顺延 v0.4.0，
路线见 `docs/DEVELOPMENT_PLAN_v0.3.md`。

### ⚠️ 破坏性变更

- **湿实验状态 `wet_run` 已移除**，拆成 `approved`（已批准待执行）/ `executing`（执行中）。
  读取实验 `state` 字符串的外部集成需要同步。
- **`GET /api/lab/machine` 响应形状变化**：`approvalGate.to` 由 `"wet_run"` 改为 `"approved"`；
  新增 `executionGate`（`approved → executing`，`consumesApproval: true`）。
- **写请求（POST/PUT/PATCH/DELETE）现在强制 `Content-Type: application/json`**，否则 415。
- **带 Origin 头的跨站写请求被拒**（403）。本地回环任意端口恒放行；
  无 Origin 的调用方（CLI / MCP 进程内 / curl）不受影响。可用 `originAllowlist` 扩展白名单。
- **approval 一次性消费**：执行权一旦被声明即消费 approval，**重跑必须重新审批**，
  进程崩溃重启后也不例外（此前 approval 跨崩溃存活，可免审批整体重跑）。

### 修复

- **P0 并发竞态**：`HttpConnector.call()` 曾用跨请求共享的单值实例字段 `__handlingTool`
  判定 handler 重入，并发下会被彼此的状态污染，导致参数映射与 AMiner 凭据检查被**静默跳过**、
  退化成零参数通用直通。CLI / ServerContext 每次新建 registry 天然不共享该字段——
  这就是 824 个既有单测测不出它的原因。改为构造期一次性写入、运行期只读的 handlers 表，
  全程不写任何跨请求可变实例状态。**「同名方法即 handler」这个魔法分发契约同时废除**
  （脚手架模板与 `EXTENDING.md` 已同步改为显式 `this.handle(toolName, fn)` 注册）。
- **全链路超时**：`http/client.ts` 的裸 `fetch`、LLM 调用、`PythonKernel.execute`、
  server 长任务此前全部无超时——任一上游挂起即永久卡死。四层各加显式超时，
  默认值收进 config 注册表（`httpTimeoutMs` 30s / `llmTimeoutMs` 120s /
  `kernelTimeoutMs` 120s / `taskTimeoutMs` 600s），优先级 env > config.json > 默认。
- **Python kernel 死锁**：stderr 管道从不排空，长会话写满 64KB 缓冲后 kernel 永久卡死。
- **LLM 失败被静默当成功**：orchestrator 四处 `llm.call()` 都不检查 `res.ok`，
  没配 key 时整条链路「成功」地把错误文本当产出、review 照样放行。四处全部改为走失败路径，
  且错误文本不再进入用户可见的 summary。
- **`kernelManager.dispose()` 摧毁全部内核**：并发会话里先结束的会杀掉另一个正在执行的 kernel。
  改为按 id 销毁。
- **`config.json` 以 0644 存放 LLM API key**：系统里最值钱的密钥，保护弱于 connector 凭据（0600）。
  改为目录 0700 / 文件 0600 + 显式 `chmod`，并在每次 `loadConfig()` 时自愈收紧。
- **状态机无乐观并发控制**：并发执行同一份已获批协议会双双通过三道门 →
  **同一协议被执行两次**。records 加 `rev` 列做 CAS，执行权原子声明，冲突返回 409 语义。
- **`bun run test:py` 从未在干净环境跑通**（脚本写的是 `python` 而非 venv 解释器，
  直接 `command not found`）；**`bun run test:lab` 是空转**（`tests/lab/` 下只有 `.test.py`，
  `bun test` 一个都跑不到）。两条都已修——后者原本 0 个用例，现在 26 个。

### 变更

- **安全门声明收敛（口径诚实化）**：此前宣称「4 条独立规则」，实测只有 `volume_capacity`
  在自然语言主管线上全程可信；`chemical_compatibility` 词表已扩到中英文与常见分子式但仍有限；
  **`concentration_limit` / `biosafety` 在主管线上恒空转**（编译器从不产生它们所需的字段）。
  README 与 DESIGN 现在如实写明真实覆盖范围。新增 `unconsumedWarnings`：
  协议里出现却未被任何规则消费的量纲/试剂/条件会产出显式告警，CLI 编译与审批输出必须显示——
  **「用户写了但安全门没看见」的内容绝不静默绿灯**。对接物理设备的硬前置见 BACKLOG V6/V25。
- `record` 新增完整性哈希：绕过状态机直接改 `state` / `approval` 变得可检测。

### 新增

- **叙事一致性门禁（AD-12）** `tests/unit/narrative_parity.test.ts`：
  ① 孤儿模块检测（生产代码零引用者必须在册并写清理由，白名单只许缩短）；
  ② 文档数量声称与运行期真源对撞；
  ③ **自描述端点必须能从真源推导**——`/api/lab/machine` 的两道门由转移表算出来比对。
  第三条在本版就抓到一个真 bug：状态拆分后该端点仍自称 `to: "wet_run"`，
  AD-6 的机器可读表达对外撒谎而全部测试皆绿。
  门禁同时登记了两处**已知缺口**：`swarm.ts`（v0.1 遗留、零调用方，v0.4 P12 删除）与
  `proteins/analysis.ts`（protein-analysis 技能有 e2e 却无任何生产入口，BACKLOG V22）。
- **两个新测试维度**：`tests/concurrency/`（共享 connector 100 并发参数映射不变式、
  N=30 并发执行同一份已批协议恰好 1 次成功、两 session kernel 互不摧毁）与
  `tests/timeout/`（注入永不响应的上游，断言四个入口都在可控时间内返回可见超时错误）。
- 配置项：`originAllowlist`、`httpTimeoutMs`、`llmTimeoutMs`、`kernelTimeoutMs`、`taskTimeoutMs`。

### 测试

单元 824 → 904（`bun test tests/unit/`，0 fail / 0 skip，含 venv 环境下的 OpenMM 契约测试）；
新增 `tests/concurrency/` 8 例 + `tests/timeout/` 4 例；pytest 48；`test:lab` 由 0 → 26。

---

## [0.2.1] — 2026-09-09

零上下文外部验收（一个对本仓库一无所知、被禁止读源码的 agent 只靠 MCP + llms.txt
跑完整链路，结果 8/10）暴露的三个问题，逐条修复。详见 devlog/P9-extensibility.md。

### 修复

- **长任务句柄的跨连接语义**：`task_status` / `exp_run` 此前笼统承诺「任务仍在后台跑」，
  但任务句柄存在 server 进程内存里，连接一断即失效。现在讲清边界，并分别给出干实验
  （磁盘有状态，`exp_list` + `resume` 接回）与文献类长任务（无 checkpoint，需重跑）的
  处置方式；`task not found` 的 404 也带上原因与下一步，而不只是说「不存在」
- **批量精读的增量语义**：`lit_read_cards(all=true)` 默认跳过已有精读卡的论文，避免超时
  重跑时把已读的重烧一遍模型调用；新增 `redoRead` 强制重生成；全部已读时明确报错而非静默空跑
- **`ideaId` 命名一致性**：`idea_coexplore` 返回体新增顶层 `ideaId` 别名（`stored.recordId`
  保留不变），与 `idea_novelty_check` 的参数名对齐

### 测试

833 单元测试（824 → 833，新增 9 条钉住上述三处 + 一条护栏断言：修描述不得碰坏 AD-9 的
五个扣留工具）· pytest 48 · Playwright 12

---

## [0.2.0] — 2026-09-09

从「科学 Agent 平台」重新定位为**面向科研人群的开源科研工作台**：项目成为持久层的根，
五大功能域（文献 / 实验 / 记录 / 创新性 / 评审）围绕一张可审计的证据图组织。

### 新增

**P1 · Project 基座**
- `spark-research project new|list|open|archive`；数据布局 `~/.spark-research/projects/<slug>/`
- Research Record 存储 `records.db`：8 类 record（idea / decision / experiment / observation /
  reading / conclusion / paper / artifact）+ 5 类边（supports / contradicts / derives_from /
  cites / supersedes），与 artifact 表 id 互链（AD-3）
- 凭据服务 `CredentialStore`：`credentials.json` 0600，**只在 daemon 进程内**；
  kernel 走 permit set 代访问，值本体不出 daemon（AD-2）

**P2 · 文献检索与文献库**
- 文献源扩到 9 个：OpenAlex / CrossRef / EuropePMC / Semantic Scholar / PubMed / arXiv /
  AMiner（走凭据服务）/ CNKI / 万方（后两个是占位，无公开 API）
- 跨源并发检索 + DOI/标题去重 + 归一化；项目文献库 `library.db`（标签 / 笔记 / 阅读状态）
- OA PDF 下载管线（arXiv / EuropePMC）+ checksum；BibTeX / CSL-JSON 导出
- `spark-research lit search|add|list|pdf|export|sources`
- 技能：literature-search、paper-download、library-curation

**P3 · 综述与引用核验**
- 结构化精读卡 pipeline（schema 校验是硬门，不合格不落半成品 record）
- 综述草稿生成：引用白名单双保险（prompt 层 + 生成后校验）
- Reviewer 检查器 `citation-integrity`：库外 key = hard veto；与精读卡冲突 = soft；
  强断言无引用 = soft；判定器故障 = 可见的 soft（不静默当「通过」）
- `spark-research lit read|review`；技能：literature-review

**P4 · Co-explore 与 Novelty check**
- 批判性共探会话 → Idea 卡（观点必须带库内来源或显式标 inferred）
- Novelty pipeline：claim 提取 → 密集检索 → 对比报告 → **确定性评级校验层**
  （检索不到 ≠ 新颖；模型原判与校正后评级都留在产物里，AD-8）
- Idea 卡 novelty 状态：unchecked / checked-novel / checked-incremental / checked-overlap
- `spark-research idea new|list|check`；技能：idea-coexplore、novelty-check

**P5 · 干实验闭环**
- `SimulationPlatform` 契约（prepare / submit / poll / collect，AD-4）+ 两个参考实现：
  OpenMM 与 pyref（纯标准库，零依赖）；两者共用同一套契约测试
- 状态机 `design → dry_run → collect → analyze → concluded | iterated`，
  **状态真源在磁盘**：编排进程被 SIGKILL 后 `exp run --resume` 能接回来
- 能力位 `deterministic` 随 observation 落库，供报告与检查器区分对账口径
- `spark-research exp new|run|status|list|platforms`；技能：dry-experiment、protein-analysis

**P6 · 湿实验**
- Opentrons 官方模拟器（`opentrons_simulate`）成为默认湿实验后端，取代 mock
- 协议编译：自然语言 → Opentrons Flex Python Protocol API v2；
  平台上没有的硬件编译成 `[spark-note]` 人工步骤，**不假装执行过**
- 安全门 4 条独立纯函数规则（试剂兼容 / 浓度上限 / 生物安全等级 / 体积容量）
- **approve gate（AD-6）**：安全门通过只到 `awaiting_approval`；唯一进入执行的门是
  记名的 `approve()`，批的是协议 hash，协议一改批准立刻作废
- 能力位 `simulated` 随 observation 落库
- `spark-research lab compile|approve|reject|simulate|status|backends`；技能：wet-protocol

**P7 · 前端工作台**
- HTTP API 层补齐 P1-P6 全部能力（域端点 + 长任务句柄 + SSE 生命周期事件）
- Web 工作台从 vanilla JS 换成 SolidJS + Vite（AD-7）：项目导航 / 会话流 / record 时间线 /
  证据子图（确定性环形布局）/ 干湿实验面板 / 明暗主题
- HTTP 层的 approve **不接受环境变量兜底**：缺 actor 直接 400，`actorSource` 记 `http:explicit`

**P8 · 功能收口**
- **结论卡 review 门槛（域 E2）**：review 状态 pending / approved / vetoed。
  判定规则不可协商——任一 hard finding → vetoed，零 hard → approved；每次评审落一条
  记名的 decision record。`spark-research conclusion list|show|review`
- **新增 3 个 Reviewer 检查器**：
  - `data-consistency`：结论引用的 observation 必须真实存在于执行记录
    （断链 / 跨项目 / 类型不对 = hard；无执行锚点 / 图上没连边 = soft）
  - `capability-labeling`：模拟读数没标注 = hard；在非确定性平台上声称逐位复现 = hard
  - `stats-plausibility`：**只出 soft** 的启发式提示（样本量过小 / 多重比较未校正 /
    p 值边缘 0.04–0.05 / 结论强度超过数据支撑）
- **研究报告导出（域 C2）**：证据图 → Markdown（问题 / 思路 / 实验 / 结论 / 待验证 +
  证据索引 + 参考文献）。正文由代码渲染不经过模型；结论区只收 approved 的卡。
  `spark-research report export|stats`、`GET /api/report[?format=markdown]`、工作台导出按钮
- 技能 research-report（第 10 个，凑齐设计里的技能目录）
- `scripts/demo-research-thread.ts`：一条完整研究线索的可重放演练（CI 可跑，零网络）
- `scripts/measure-citation-judge.ts`：真实模型下的引用一致性判准率测量（分三档报告，不进 CI）

**P9 · 扩展面与 LLM 友好化**
- **[docs/EXTENDING.md](docs/EXTENDING.md)**：六个扩展点（Skill / Connector /
  SimulationPlatform / WetLabBackend / 安全门规则 / Prompt 与模型路由）各一节，
  每节 = 契约 + 最小可运行示例 + 怎么测 + 放哪里。示例全部在 CI 里真跑：
  skill/connector/platform 三类是脚手架产物（生成后 `bun test` 一遍），
  安全门规则是 `examples/extending/flammable_over_heat_rule.ts`（11 例，含阴性对照）
- **脚手架**：`spark-research new skill|connector|platform <name>`，
  生成带可执行测试桩的模板；connector 有免 key 与 `--with-key` 两版；
  platform 生成的测试**直接接 P5 契约测试套件**（新平台的验收标准）
- **能力自描述**：`spark-research capabilities [--json] [--probe]` 与 `GET /api/capabilities`。
  **全部从真实注册表生成**并有双向一致性测试；可用性分静态档（零 IO）与探测档（spawn 子进程）
- **MCP server**：`spark-research mcp`（stdio）。24 个工具覆盖检索 / 文献库 / 思路 /
  novelty / 实验 / 记录 / 结论 / 报告；长任务默认同步等待，超时才降级为任务句柄。
  **`lab approve` / `lab reject` / `lab simulate` / `conclusion review` / `project archive`
  刻意不暴露**（AD-9）：不暴露清单是显式数据，进 capabilities 与 server instructions，
  `lab_compile` 返回体里直接给出「需要人执行哪条命令」
- **用户配置面收口**：`~/.spark-research/config.json` + 一张设置表作单一真源，
  优先级 env > config.json > 默认值。`spark-research config list|get|set|unset|path`，
  每一项都写清「改了影响什么」；凭据同文件但只显示「已设置 / 未设置」
- **SKILL.md frontmatter 规范化**：新增 `triggers` / `connectors` / `validation` 三个必填字段，
  schema 校验进 CI。`validation` 让 AD-5 从口号变成一道门——校验器去磁盘核对测试文件真实存在
- **llms.txt / llms-full.txt**：`bun run gen:llms` 幂等生成，CI 守与文档同步
- connector 元数据新增 `caveat`：`status: available` 只说明「接口实现了」，
  不等于「无条件可用」（如 Semantic Scholar 匿名请求实测持续 429）

### 变更

- **connector 基类 `MCPConnector` 改名 `HttpConnector`**（连同 `MCPConnectorConfig` →
  `HttpConnectorConfig`、`MCPTool` → `HttpTool`）。这个类与 Model Context Protocol
  毫无关系，名字是 v0.1 的历史包袱；P9 落地了真正的 MCP 实现之后，同名会主动误导读者。
  **旧名保留为 deprecated 别名，外部代码不会断**；移除记在 BACKLOG V15
- 报告与检查器统一「可复现性口径」措辞：证据来自非确定性平台一律写**区间/趋势对账**，
  不再出现「逐位可复现」这类承诺
- 结论卡 `review` 字段从裸字符串升级为结构化评审记录（谁 / 何时 / 依据哪些 finding）。
  **向后兼容**：P5/P6 落的旧形态照常读得出来，解析不了的一律落回 `pending`，不会被当成 approved

### 移除

- 删除 v0.1 遗留的 `backend/src/compute/`（`providers.ts` / `manager.ts` / `job_manager.ts`）
  及其测试。这套内存态、阻塞 `wait()` 的任务抽象自 P5 起就标了 DEPRECATED，
  干实验已全部走 `SimulationPlatform`；留着两套「提交任务」抽象只会让下一个人选错

### 修复

- bibtex key 非确定性（`LibraryStore.list()` 用随机 uuid 参与排序，导致同姓同年论文的
  引用 key 可能在两次运行间互换）——次序键改为 rowid，`RecordStore` 同一问题一并修
- 句子切分把并列引用 `[@a; @b]` 劈成两半，导致后一个 key 逃过引用核验
- 综述草稿（无产生它的 cell）被 trace-don't-recompute 规则误判为 hard finding
- pytest 静默收集 0 个用例（测试文件名 `*.test.py` 不匹配默认模式）——
  P0-P4 期间 Python 侧其实没有测试门禁

---

## [0.1.0]

Daemon-Worker 架构 + permit set、有状态 Python kernel、Artifact 与 lineage、
Reviewer veto（trace-don't-recompute）、11 个科学 connector、协议编译器与安全门、
vanilla JS 三栏 Web 界面。
