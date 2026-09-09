# Changelog

本文件记录面向用户可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
