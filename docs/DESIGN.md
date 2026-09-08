# Spark Research v0.2 产品设计

> 状态：设计定稿待评审 · 2026-09-09
> 上游输入：OpenScience 架构分析、AMiner 集成调研（2026-09-07）、Claude Science 产品形态、现有 v0.1 代码资产
> 配套文档：[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)（开发与验证计划）

---

## 一、定位

**Spark Research 是面向科研人群的开源科研工作台**：科研人员用自然语言驱动一个可审计的研究代理，完成「文献调研 → 思路共探 → 实验验证 → 数据记录 → 创新性核验 → 结论评审 → 写作」的完整循环，全过程本地优先、证据可溯源。

一句话主张：**你的研究项目是一等公民，每一步思考和实验都留下可审计的证据链。**

### 1.1 目标用户

| 用户 | 核心痛点 | Spark Research 的回答 |
|------|---------|---------------------|
| 研究生 / 博士后 | 文献调研耗时、综述引用管理混乱 | 项目文献库 + 综述 pipeline + 引用真伪核验 |
| PI / 课题组长 | 学生结论可信度难核查 | Research Record 证据链 + Reviewer 否决机制 |
| 企业研发（药物/材料） | 干湿实验数据割裂 | 干湿闭环 + 全流程数据记录 |
| 独立研究者 | 缺少讨论伙伴、思路难验证新颖性 | Co-explore + Novelty check |

### 1.2 非目标（v0.x 明确不做）

- 不做云端多租户 SaaS（本地优先，单用户/单课题组）
- 不做通用 IDE / 代码助手（科研任务专用）
- 不自研模型（模型无关路由，BYOK）
- 不做文献全文托管服务（只存用户合法获取的 PDF 到本地库）

---

## 二、参照系：吸收什么、不吸收什么

### 2.1 来自 Claude Science（产品形态）

**吸收**：研究循环的产品化表达（literature / data / experiment / write-up 四类工作 + review pass）；「给一个目标就能完成整个循环」的交互心智。
**不吸收**：托管闭源环境。我们本地优先、数据不出用户机器。

### 2.2 来自 OpenScience（内核架构，已源码级分析）

**吸收**：
1. **单一 research agent + 隐藏任务型子代理**（explore/execute/review 按工作类型委派，不按学科分身）—— v0.1 已实现，保留
2. **双层 prompt**（provider-neutral system contract + agent workflow prompt）—— v0.1 已实现，保留
3. **Connector 统一契约**（id/domain/search/fetch，按学科域组织）—— v0.1 有雏形，v0.2 强化
4. **技能本地优先加载**（instruction bundle 按需加载，不预填 context）—— v0.1 目录为空，v0.2 落地
5. **Provenance 信封**（每个产物带 lineage）—— v0.1 已实现 SQLite 版

**不吸收**：
- 313 技能的铺量路线 —— 我们走「少而深、每个技能有 e2e 验证」路线
- Modal 单一云算力绑定 —— 保留 provider 抽象，落地顺序按需求定

### 2.3 来自 AMiner 集成调研（凭据架构教训，实测得出）

OpenScience 的三层沙箱隔离（env 白名单 / 文件沙箱 / 网络受限）导致自定义付费数据源无法在 agent 内使用，只能 fork 改源码。**Spark Research 把这个教训变成原生设计**：

> **凭据分层原则**：所有带凭据的外部访问（AMiner、CNKI、付费 API）只发生在 daemon 进程内的 connector 中；kernel/沙箱子进程永远拿不到凭据本体，只能通过 permit set 授权的 `mcp_call` 请求 daemon 代为访问。凭据存储在 `~/.spark-research/credentials.json`（0600）或系统 Keychain，不进 env、不进 prompt、不进日志。

这让付费/授权数据源成为一等 connector，而不是要开安全口子的例外。

### 2.4 现有 v0.1 资产盘点（直接复用的地基）

| 资产 | 位置 | v0.2 角色 |
|------|------|----------|
| Daemon + permit set | `backend/src/daemon/` | 控制核心，扩展凭据服务 |
| 有状态 Python kernel | `backend/src/kernels/` | 干实验执行引擎 |
| Artifact + lineage（SQLite） | `backend/src/artifacts/` | 扩展为 Research Record 存储 |
| Reviewer veto（trace-don't-recompute） | `backend/src/reviewer/` | 结论评审 + 引用核验的载体 |
| 11 个 connector + registry | `backend/src/connectors/` | 扩展凭据层 + 文献域增强 |
| Orchestrator + swarm | `backend/src/agents/` | 保留，接入新子代理配置 |
| Lab protocol compiler + safety gate | `backend/src/lab/` | 湿实验域，mock → 模拟器 |
| 84 个单元测试 | `tests/unit/` | 测试基线，只增不减 |

---

## 三、差异化主张（相对 OpenScience / Claude Science 的三个赌注）

1. **Project-centric，不是 session-centric**。OpenScience 和 Claude Science 以 workspace/会话为单位；科研的真实单位是**课题**——一个课题横跨数月、数百次会话。Spark Research 的持久层以 Project 为根：文献库、思路库、实验记录、结论卡都挂在项目下跨会话积累。
2. **全流程 Research Record**。不只记录代码产物（artifact），还记录**思路（idea）、决策（decision）、观察（observation）、结论（conclusion）**，全部进同一张证据图。副产品：天然的电子实验记录本（ELN）+ 可审计的 research trail，直接支撑创新性核验和论文写作。
3. **干湿闭环**。protocol compiler + safety gate + 设备抽象已有雏形；连同仿真平台 connector，形成「AI 设计 → 干实验仿真 → 湿实验执行 → 数据回传 → 迭代」闭环。这是两个参照系都没有的。

---

## 四、五大功能域设计

### 域 A：文献调研与写作

**A1 文献检索（多源聚合）**
- Connector 层扩展：现有 arXiv/PubMed + 新增 OpenAlex、CrossRef、EuropePMC、Semantic Scholar（全部免 key，参照 OpenScience 的 literature 域清单）
- **AMiner connector**（带凭据，走 §2.3 凭据分层）：29 个 API 已在调研中验证可用
- CNKI/万方从占位升级为真实实现（依赖可获得的 API 渠道，无渠道则保持占位并明示）
- 统一检索接口：跨源查询 → 去重（DOI/标题模糊匹配）→ 合并排序

**A2 个人科研项目文献库（Project Library）**
- 每个 Project 一个 `library.db`（SQLite）：论文元数据、作者、venue、标签、阅读状态、笔记
- PDF 下载管线（复用已验证的 paper-download 经验：arXiv/EuropePMC OA 直下、bioRxiv 403 自救）；PDF 落 `papers/` 目录，库中存路径 + checksum
- 引用关系：库内论文互引边（数据来自 OpenAlex/Semantic Scholar 引文 API）
- 导出：BibTeX / CSL-JSON

**A3 综述与写作 pipeline**
1. 背景调研：给定研究问题 → 多源检索 → 候选论文清单（人审 or 自动入库）
2. 逐篇精读卡：每篇生成结构化卡片（问题/方法/结论/局限/与本项目关系），卡片是 record，带来源锚点
3. 综述草稿：基于精读卡组织，**每条引用必须能回链到库内真实论文**
4. 引用核验：Reviewer 检查草稿中每个引用是否存在于库中且内容对得上（扩展现有 rules——这是现有「检测伪造引用」测试的自然延伸）

**A4 Co-explore（思路共探）**
- 对话模式：围绕研究问题的苏格拉底式探讨，agent 主动检索文献 grounding 自己的观点
- 产出物：**Idea 卡**（假设陈述 + 支持文献 + 反对文献 + 待验证点）入思路库
- 调研反馈：对用户已有的思路/草稿给出基于文献的批判性反馈（引用真实文献，标注证据类型）

### 域 B：实验验证

**B1 干实验（in silico）**
- 执行引擎：现有 stateful Python kernel（RDKit/pandas/numpy 已配）
- **Simulation adapter 接口**：统一的 `SimulationPlatform` 契约（prepare/submit/poll/collect），参照 connector 模式
- 首批参考实现（2 个，证明接口通用性）：
  - 本地进程型：OpenMM（分子动力学，pip 可装，纯本地）
  - 命令行型：GROMACS（若本机可装）或退一档用 Python 内置仿真脚本作第二实现
- 后续按需求接：材料计算（VASP/LAMMPS）、EDA 等——接口先行，实现按用户真实课题拉动

**B2 湿实验（wet lab）**
- 现有：protocol compiler（自然语言 → 设备指令）+ safety gate（试剂兼容/浓度上限/生物安全）+ mock 设备
- v0.2 目标：**用 Opentrons 官方模拟器（`opentrons_simulate`）替换 mock**，跑通一次真实协议编译 → 模拟执行 → 结果回传
- 物理设备对接留 v0.3+（需要真实硬件）

**B3 干湿闭环引擎**
- 状态机：`design → dry_run → (approve gate) → wet_run → collect → analyze → iterate | conclude`
- 每次迭代是一个 Experiment record，输入/输出/参数全进证据图
- 断点续跑：状态持久化到 Project 存储，进程重启可恢复
- 人在环：湿实验执行前强制 approve gate（安全门通过 ≠ 自动执行）

### 域 C：全流程数据记录（Research Record）

**C1 数据模型**（扩展现有 artifact/lineage 架构，同一张图）

```
Record 类型：
  idea         思路卡（来自 Co-explore 或手动）
  decision     决策点（为什么选方案 A 不选 B）
  experiment   实验（干/湿，含参数、状态机状态）
  observation  观察（实验产出的原始发现）
  conclusion   结论卡（claim + evidence + limitations + review 状态）
  paper        文献（库内论文的引用锚点）
  artifact     产物（现有：代码/图/数据文件，带 lineage）

边类型：
  supports / contradicts / derives_from / cites / supersedes
```

- 每条 record 带：类型、内容、时间戳、来源（会话/cell/connector 调用）、证据类型标签（observed/sourced/computed/inferred —— 现有 core.txt 已定义此分类）
- 存储：`records.db`（每 Project 一个），与 `artifacts` 表通过 id 互链

**C2 时间线与导出**
- 项目时间线视图（前端）：按时间/类型过滤的 record 流
- 导出：Markdown 研究报告（按证据图组织：问题 → 思路 → 实验 → 结论，每条带证据链接）；后续可加 PDF

### 域 D：创新性验证与梳理

**D1 Novelty check pipeline**
1. Claim 提取：从 idea 卡或结论卡提取可检验的创新点陈述
2. 密集检索：针对每个 claim 多源检索（含语义近邻检索，Semantic Scholar/OpenAlex 的相关论文 API）
3. 对比报告：逐 claim 列出最接近的已有工作 + 相同点 + 差异点 + 新颖性评级（novel / incremental / existing，附证据）
4. Reviewer 复核：报告里每条「已有工作」引用必须真实存在（走 A3-4 同一套引用核验）

**D2 与思路库联动**：每个 Idea 卡有 novelty 状态字段（unchecked / checked-novel / checked-overlap），检查结果作为 record 挂到证据图。

### 域 E：结论分析与 Review

**E1 Reviewer 强化**（在现有 veto 机制上叠加）
- 现有：lineage 版本冲突检测（stale_input/version_mix）、trace-don't-recompute、否决完成
- 新增检查器（每个都是独立 rule，可单测）：
  - 引用真实性（服务域 A/D）
  - 数据-结论一致性：结论卡引用的 observation 是否真实存在于执行记录
  - 统计合理性提示（soft finding）：样本量、多重比较、p-hacking 模式的启发式提示
- 按位置加权保留：figure/report 中的 claim 比 chat 中的严格

**E2 结论卡（Conclusion card）**
- 结构：claim + 证据列表（record 链接）+ limitations + confidence + review 状态（pending / approved / vetoed）
- 只有 review approved 的结论卡才能进入导出报告的「结论」区（vetoed/pending 的进「待验证」区）

---

## 五、系统架构

### 5.1 分层图

```
┌────────────────────────────────────────────────────────────┐
│  界面层                                                      │
│  CLI（完整功能）· Web 工作台（项目导航+会话+时间线+实验面板）    │
├────────────────────────────────────────────────────────────┤
│  Agent 层（TypeScript）                                      │
│  research agent（唯一用户可见）                               │
│   └ 任务型子代理：explore / execute / review（现有）           │
│     + literature / lab（新增配置，同一委派机制）               │
│  双层 prompt：core.txt（provider-neutral）+ workflow prompt   │
├────────────────────────────────────────────────────────────┤
│  Daemon 控制层（TypeScript，唯一持凭据进程）                   │
│  permit set · 凭据服务(新) · Project 管理(新) ·               │
│  Record/Artifact 存储 · 执行记录 · Reviewer                   │
├────────────┬──────────────┬──────────────┬─────────────────┤
│ Kernel 层   │ Connector 层  │ Simulation   │ Lab 层           │
│ Python      │ 文献×8 蛋白×3 │ adapter 接口  │ protocol compiler│
│ (stateful)  │ 基因×3 化学×2 │ +OpenMM 等   │ +safety gate     │
│ control_repl│ +AMiner(凭据) │              │ +Opentrons 模拟器 │
├────────────┴──────────────┴──────────────┴─────────────────┤
│  存储层（本地优先）                                            │
│  ~/.spark-research/projects/<slug>/                          │
│    project.json  · library.db · records.db ·                 │
│    papers/ · artifacts/ · experiments/                       │
│  ~/.spark-research/credentials.json (0600, daemon-only)      │
└────────────────────────────────────────────────────────────┘
```

### 5.2 关键架构决策（ADR 摘要）

| # | 决策 | 理由 |
|---|------|------|
| AD-1 | Project 为持久层根，session 挂在 project 下 | 科研单位是课题；差异化主张 §3.1 |
| AD-2 | 凭据只在 daemon，kernel 走 `mcp_call` 代访问 | AMiner 调研教训；凭据永不进沙箱/env/prompt |
| AD-3 | Record 与 Artifact 同图不同表，id 互链 | 复用已验证的 lineage 机制，避免双图不一致 |
| AD-4 | Simulation adapter 独立于 connector | connector 是数据读取（幂等），仿真是长任务生命周期（prepare/submit/poll/collect），契约不同 |
| AD-5 | 技能少而深：每个技能必须有配套 e2e 验证才算完成 | 对 OpenScience 313 技能「质量参差」的差异化回应 |
| AD-6 | 湿实验执行前强制人工 approve gate | 安全门是必要非充分条件；物理世界操作不自动化审批 |
| AD-7 | 前端保持轻量 vanilla JS 到 P7，API 先行 | CLI/API 是能力真源，UI 是投影；避免过早绑定框架 |

### 5.3 技能目录（v0.2 首批，共 10 个）

| 技能 | 域 | 验证方式 |
|------|-----|---------|
| literature-search | A | 真实多源检索 e2e（fixture 回放进 CI） |
| paper-download | A | arXiv+EuropePMC 真实下载（已有验证经验） |
| library-curation | A | 入库/去重/BibTeX 导出单测 |
| literature-review | A | 10 篇文献 → 综述 → 引用核验全过 |
| idea-coexplore | A | 对话产出 Idea 卡 + 文献 grounding 检查 |
| novelty-check | D | 已知领域 idea → 对比报告 → 引用真实性核验 |
| protein-analysis | B | UniProt/PDB/AlphaFold 链路（连接器已有） |
| dry-experiment | B | OpenMM 最小 MD 任务端到端 |
| wet-protocol | B | 协议编译 → Opentrons 模拟器执行 |
| research-report | C/E | 证据图 → Markdown 报告，结论卡 review 门槛生效 |

### 5.4 模型路由

- 保持模型无关（现有 LLMRouter：kimi/openai/anthropic/deepseek/qwen/openrouter）
- 子代理可配置独立模型（重任务用强模型，检索/摘要用快模型）
- 默认模型保持 OpenRouter 路由，用户 BYOK

---

## 六、风险与缓解

| 风险 | 缓解 |
|------|------|
| CNKI/万方无公开 API | 保持占位 + 文档明示；AMiner 覆盖中文文献检索需求的主路径 |
| 仿真平台差异大，adapter 过度抽象 | 先 2 个参考实现验证契约，不预设第 3 个 |
| 证据图复杂化拖慢日常使用 | record 写入全部走 daemon 异步落库；agent 端只感知「记录成功」 |
| Reviewer 误杀（false veto）拖慢研究 | hard/soft 分级已有；soft 只提示不否决；veto 必须给出可操作的修复指引 |
| 单人维护 + 上游参照系快速迭代 | 每阶段 devlog 记录与 OpenScience 的架构 diff，季度性对齐一次 |

---

## 七、成功标准（v0.2 发布判据）

1. 一条真实研究线索可以完整走通：提出问题 → 文献调研入库 → Co-explore 出 idea → novelty check → 干实验（OpenMM）→ 结论卡过 review → 导出带证据链的研究报告
2. 湿实验路径：一个自然语言协议 → 编译 → 安全门 → Opentrons 模拟器执行成功
3. 测试基线：单元测试从 84 只增不减；每个技能有 e2e 验证；CI 全绿
4. 文档：README 重写 + 每阶段 devlog + 本设计文档随实现更新
