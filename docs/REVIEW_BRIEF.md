# Spark Research · 外部评审简报

> 面向不了解本项目的评审者（人或 agent）。目标：15 分钟内进入状态，直接指出真问题。
> 快照时间：2026-09-09 · 对应 commit：`b4aab02`（main，P1–P7 已合入；P8 在 `feat/p8-wrapup` 分支进行中）
> 配套文档：[DESIGN.md](DESIGN.md)（设计真源）· [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)（阶段计划）· [BACKLOG.md](BACKLOG.md)（未决事项）· [devlog/](devlog/)（每阶段实施记录与验收批注）

---

## 0. 一分钟速览

**是什么**：面向科研人员的开源科研工作台。用自然语言驱动一个可审计的研究代理，完成「文献调研 → 思路共探 → 创新性验证 → 实验（干/湿）→ 全流程记录 → 结论评审 → 报告」的完整循环。本地优先，模型无关，Apache 2.0。

**当前状态**：v0.2 开发中。P1–P7 已合入 main（项目基座、文献域、综述与引用核验、思路库与 novelty、干实验闭环、湿实验闭环、API 层 + SolidJS 工作台）。P8（功能收口）进行中，P9（扩展面与 LLM 友好化）待启动。

**规模**：后端 TypeScript ~18k 行（14 个域模块）+ Python（kernel/仿真/实验室后端）· 前端 SolidJS ~3.1k 行 · 66 个 HTTP 端点 · 18 个 connector · 9 个技能（第 10 个在 P8）· 测试：655 bun unit + 48 pytest + 10 Playwright，全绿。

**最想被挑战的**：见 §7。简报刻意包含了全部已知缺陷与未决判断——**发现我们没写在 §7 里的问题，价值最大**。

---

## 1. 定位与三个差异化赌注

参照系是 Anthropic 的 Claude Science（闭源托管）与 OpenScience（`synthetic-sciences/openscience`，Apache 2.0，3.5k★，本项目的架构蓝本）。相对两者，我们押三件事：

1. **Project-centric，不是 session-centric**。两个参照系都以会话/workspace 为单位；科研的真实单位是**课题**——横跨数月、数百次会话。本项目的持久层以 Project 为根：文献库、思路库、实验记录、结论卡跨会话累积。
2. **全流程 Research Record**。不只记录代码产物，还记录思路（idea）、决策（decision）、精读（reading）、观察（observation）、结论（conclusion），全部进同一张证据图（8 种 record 类型 + 5 种边）。副产品是天然的电子实验记录本与可审计 research trail。
3. **干湿闭环**。协议编译器 + 安全门 + 人工审批 + 设备抽象，AI 设计 → 干实验仿真 → 湿实验执行 → 数据回传 → 迭代。两个参照系都没有。

**明确不做**（v0.x）：云端多租户 SaaS、通用 IDE、自研模型、文献全文托管。

---

## 2. 架构

```
界面层    CLI（能力真源） · SolidJS 工作台（API 投影）
             ↓
Agent 层  research agent（唯一用户可见）+ 任务型子代理（explore/execute/review）
          会话模式：chat / coexplore
          双层 prompt：provider-neutral 契约 + agent workflow
             ↓
Daemon    permit set · 凭据服务（唯一持凭据进程）· Project 管理
          Record/Artifact 存储 · 执行记录 · Reviewer
             ↓
能力层    Kernel(Python stateful) · Connector×18 · SimulationPlatform · WetLabBackend
             ↓
存储层    ~/.spark-research/projects/<slug>/{project.json, records.db, library.db,
          artifacts/, papers/, experiments/}  ·  credentials.json (0600, daemon-only)
```

### 架构决策（ADR，完整列表见 DESIGN §5.2）

| # | 决策 | 理由 |
|---|------|------|
| AD-1 | Project 为持久层根 | 科研单位是课题 |
| AD-2 | 凭据只在 daemon 进程，kernel 经 `mcp_call` 代访问 | 源于对 OpenScience 沙箱的实测：它的三层隔离使自定义付费数据源无法在 agent 内使用，只能 fork。我们把这个教训变成原生设计 |
| AD-3 | Record 与 Artifact 同图不同表，id 互链 | 复用已验证的 lineage 机制 |
| AD-4 | SimulationPlatform 独立于 Connector | connector 是幂等数据读取，仿真是长任务生命周期（prepare/submit/poll/collect） |
| AD-5 | 技能少而深：每个技能必须有 e2e 才算完成 | 对 OpenScience 313 技能「质量参差」的差异化回应 |
| AD-6 | 湿实验执行前强制人工 approve | 安全门通过是必要非充分条件 |
| AD-7 | 前端 vanilla → P7 迁 SolidJS，API 先行 | CLI/API 是能力真源，UI 是投影 |
| AD-8 | Novelty 评级由确定性代码校验，不由 LLM 独断 | 见 §4 |

---

## 3. 五大功能域与实现状态

| 域 | 能力 | 状态 |
|----|------|------|
| **A 文献调研与写作** | 多源统一检索（OpenAlex/CrossRef/EuropePMC/S2 + AMiner 带凭据）、DOI+标题模糊去重、项目文献库、PDF 下载管线、BibTeX/CSL 导出、精读卡、综述草稿 | ✅ P2/P3 |
| **B 实验验证** | 干：SimulationPlatform 契约 + OpenMM（真实 MD）+ pyref（确定性参考实现）+ 7 态状态机 + 断点续跑；湿：自然语言→Opentrons Protocol API v2 编译 + 4 条安全规则 + approve gate + 真模拟器执行 | ✅ P5/P6 |
| **C 全流程记录** | 8 类 record + 5 类边的证据图、时间线（类型/时间过滤）、证据子图展开 | ✅ P1/P7 |
| **D 创新性验证** | claim 提取 → 密集检索 → 对比报告 → 评级（novel/incremental/existing）+ 确定性评级校验层 | ✅ P4 |
| **E 结论与评审** | citation-integrity 检查器（引用真伪）✅ P3；结论卡 review 门槛、数据-结论一致性、统计合理性提示 🔄 P8 进行中 |

---

## 4. 工程方法（本项目的特色，也是评审时可攻击的面）

**对抗测试优先于 happy path**。每个涉及可信度的功能都配对抗用例：
- 引用核验：3 种伪造模式（编造 key / 真 key 假内容 / 库外真文献）× 3 变体 = **9/9 检出**，外加 4 个阴性对照防误杀
- 安全门：超浓度 / 不兼容试剂 / 超 BSL / 单次溢孔 / **累计溢孔**（单看每步都合法）+ 绕过状态机直改协议原文（被协议 hash 复核拦下）
- Novelty 评级：反向对抗——fake LLM 硬说已发表工作是 novel，被确定性校验层**按证据升级为 existing**；反之硬说杜撰组合是 existing 则**降级**。这就是 AD-8

**真实验证一次，fixture 回放到永远**。真实网络/仿真跑通后录制，CI 只回放。真实验证抓到的 bug 包括：EuropePMC 官方 PDF 端点已死、bibtex key 因随机排序在两次运行间**互换**（会让引用悄悄指错论文）、fixture 录制器把超大响应截断成坏 JSON。

**诚实记录不可复现性**。OpenMM 同一 spec 三次运行 E_min 各不相同（CPU 多线程浮点归约）→ 抽象成 `deterministic` 能力位写进 record，下游据此区分「逐位对账」与「区间对账」。同理 Opentrons 模拟读数全 0.0 → `simulated` 位。

---

## 5. 代码库导航

| 路径 | 职责 | 规模 |
|------|------|------|
| `backend/src/project/` | Project 管理、records 证据图 | 880 |
| `backend/src/literature/` | 统一检索、文献库、PDF、精读卡、综述、导出 | 2670 |
| `backend/src/ideation/` | Idea 卡、思路库、相似度、novelty pipeline | 1969 |
| `backend/src/experiment/` | 干实验闭环状态机 | 1110 |
| `backend/src/simulation/` | SimulationPlatform 契约 + OpenMM/pyref | 1357 |
| `backend/src/lab/` | 协议编译、安全门、湿实验状态机、Opentrons 后端 | 4060 |
| `backend/src/reviewer/` | veto 机制、citation-integrity、LLM 辅助判定 | 514 |
| `backend/src/connectors/` | 18 个数据源 + registry | 1026 |
| `backend/src/server/` | 66 端点 API、SSE、长任务句柄 | 2236 |
| `backend/src/daemon/` | permit set、凭据服务 | 465 |
| `frontend/workspace/src/` | SolidJS 工作台（零运行时第三方库） | 3127 |

**建议的阅读顺序**：`DESIGN.md` → `project/records.ts`（证据图是全局枢纽）→ `reviewer/rules.ts`（可信度机制）→ 任一域的 pipeline（`literature/review.ts` 或 `ideation/novelty.ts`）→ `experiment/loop.ts` + `lab/wet_loop.ts`（两个状态机）。

---

## 6. 未完成与已知缺陷（完整清单见 BACKLOG.md）

**P8 进行中**：结论卡 review 门槛、数据-结论一致性检查器、统计合理性提示、能力位消费端、真实模型判准率测量、报告导出。

**P9 待启动**：EXTENDING.md（六个扩展点的自助配置文档）、脚手架 CLI、`capabilities --json` 能力自描述、llms.txt、**MCP server 模式**。

**已知缺陷（我们自己发现并记录的）**：
- Semantic Scholar 匿名请求持续 429（7 次尝试全挂），实际需要 API key
- Novelty 相似度是**词面**而非语义（覆盖率 + 中文二元组），阈值 0.75，标定样本仅 2 个 claim，最近邻余量 0.08
- 「真 key 假内容」的检出此前只用确定性 FakeJudge 验证管线，**真实模型判准率尚未测量**（P8 G5 正在做）
- HTTP 层 approve 的 actor 是「谁自称就是谁」，单用户本地诚实，**多用户前必须换真实身份认证**
- 长任务句柄不落盘，进程重启后任务列表丢失（实验状态本身在磁盘上，可 resume）
- SSE 是生命周期事件而非 token 流（orchestrator 尚未流式化）
- WetLabBackend 的 `execute()` 入参是 `OpentronsProgram`——接**非 Opentrons 设备族**时需要把设备语言编译下沉进 backend（已知重构点，等第二个设备族选定再动）
- arXiv/PubMed 尚未接入统一检索（缺 XML parser）；CNKI/万方仍是占位（无公开 API）
- 中文检索式召回极差，novelty 的检索式限定英文

**流程事故（已记录在 devlog）**：P6 期间主会话在共享工作树切分支，把子代理半成品卷进 docs PR 推上 main，绕过审查门 → 新增工作树隔离纪律。P7 期间 worktree 目录中途变为不可访问导致未提交成果全丢 → 新增 worktree 路径与「阶段性成果及时推送」纪律。

---

## 7. 希望评审重点看的问题

按我们自己的不确定程度排序。**发现不在此列的问题，价值最大**。

1. **证据图的设计是否站得住**：8 类 record + 5 类边能否覆盖真实科研流程？边方向约定（`supports`/`contradicts` 是 paper→idea，`cites` 是新产物→旧文献）是否会在图遍历时造成歧义？`RecordStore.update()` 允许改 content（用于结论/状态的整卡重渲染）是否破坏了「可审计证据链」的承诺？
2. **可信度机制是否真的可信**：citation-integrity + 评级校验层 + 安全门，这套「用确定性代码约束 LLM 输出」的路子，边界在哪里？哪些地方我们其实还是在信任 LLM 而不自知？
3. **两个状态机的口径**：干实验 7 态、湿实验 11 态；湿实验 `approve` 直达 `wet_run`（无 approved 中间态）、「进入 compile 一律清空 approve」、唯一守卫回边 `wet_run→compile`（仅 runId 为空时）。这套口径有没有能绕过审批的路径？
4. **抽象是否过早或过晚**：SimulationPlatform 由两个实现验证过；WetLabBackend 只有 Opentrons 一族（已知重构点）；Connector 契约承载了 18 个源。哪个抽象是错的？
5. **相对参照系的判断**：我们不吸收 OpenScience 的 313 技能铺量路线而走「少而深 + 每技能 e2e」，这个赌注对吗？Project-centric 是真需求还是过度设计？
6. **安全边界**：凭据只在 daemon（AD-2）、Markdown 渲染是唯一 innerHTML 写入点（已审计+10 个 XSS 回归测试）、协议 hash 复核。还有哪些面没覆盖？

## 8. 如何跑起来

```bash
git clone https://github.com/jimmyag2026-prog/spark-research && cd spark-research
bun install && bun run typecheck
bun test tests/unit/                       # 655 pass
.venv/bin/python -m pytest tests/ -q       # 48 passed（需先建 .venv 装 openmm/opentrons）
bun run test:e2e                           # Playwright 10 pass（需 bunx playwright install chromium）
bun run dev                                # 工作台 http://127.0.0.1:4321
```

CLI 入口：`project` / `lit` / `idea` / `exp` / `lab`（P8 增 `conclusion` / `report`）。
