# Spark Research v0.2 产品设计

> 状态：随实现更新 · 终稿核对于 P8 收口（2026-09-09）
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
| 84 个单元测试 | `tests/unit/` | 测试基线，只增不减（P8 收口时 706） |
| v0.1 的 `compute/` 任务抽象 | `backend/src/compute/` | **P8 删除**（内存态阻塞契约，被 `SimulationPlatform` 取代） |

---

## 三、差异化主张（相对 OpenScience / Claude Science 的三个赌注）

1. **Project-centric，不是 session-centric**。OpenScience 和 Claude Science 以 workspace/会话为单位；科研的真实单位是**课题**——一个课题横跨数月、数百次会话。Spark Research 的持久层以 Project 为根：文献库、思路库、实验记录、结论卡都挂在项目下跨会话积累。
2. **全流程 Research Record**。不只记录代码产物（artifact），还记录**思路（idea）、决策（decision）、观察（observation）、结论（conclusion）**，全部进同一张证据图。副产品：天然的电子实验记录本（ELN）+ 可审计的 research trail，直接支撑创新性核验和论文写作。
3. **干湿闭环**。protocol compiler + safety gate + 设备抽象已有雏形；连同仿真平台 connector，形成「AI 设计 → 干实验仿真 → 湿实验执行 → 数据回传 → 迭代」闭环。这是两个参照系都没有的。

---

## 四、五大功能域设计

### 域 A：文献调研与写作

**A1 文献检索（多源聚合）**
- Connector 层扩展：现有 arXiv/PubMed + 新增 OpenAlex、CrossRef、EuropePMC、Semantic Scholar（参照 OpenScience 的 literature 域清单。P2 实测：S2 匿名请求持续 429，实际使用建议配置免费 API key——走凭据服务，connector id `semanticscholar`；无 key 时统一检索自动降级为其余源）
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

P3 落地口径（record 类型映射，不新增 record 类型）：
- 精读卡 = `reading` record（P3 起独立类型，与实验 `observation` 分离），`evidence=sourced`，`metadata.kind="reading_card"`，`cites` 边指向该论文的 `paper` record；卡片里唯一的推断字段 `relationToProject` 在 `metadata.inferredFields` 中标出，**不参与**引用核验的对照基准
- 综述草稿 = artifact + `artifact` record，`evidence=inferred`，`derives_from` 边连每张精读卡、`cites` 边连每篇被引论文
- 引用标记形式为 `[@bibtexKey]`，key 与 `lit export --format bibtex` 完全一致（读者可直接对照 .bib）

**A4 Co-explore（思路共探）**
- 对话模式：围绕研究问题的苏格拉底式探讨，agent 主动检索文献 grounding 自己的观点
- 产出物：**Idea 卡**（假设陈述 + 支持文献 + 反对文献 + 待验证点）入思路库
- 调研反馈：对用户已有的思路/草稿给出基于文献的批判性反馈（引用真实文献，标注证据类型）

P4 落地口径：
- Idea 卡 = `idea` record，`evidence=inferred`，`metadata.kind="idea_card"`；不新增 record 类型
- 证据边方向按**语义**读（「A 支持 B」）：`paper --supports--> idea` / `paper --contradicts--> idea`。
  与 P3 的 `cites`（新产物 → 被引论文）方向相反是有意的——查一条 idea 的支撑文献看它的 incoming 边
- 两条硬门（schema 校验层，违反即重试一次、仍违反则拒绝落卡）：
  ① 每条证据要么给库内 bibtex key，要么显式 `inferred:true`；库外 key 视同伪造引用（与 A3-4 同口径）
  ② `contradicting` 至少 1 条——给不出反面证据的「共探」只是附和；库里没有反证就明说并标 inferred
- 会话模式挂在 orchestrator 上（`chat({mode:"coexplore"})`），与默认 chat 并列，不走规划/执行/review 循环

### 域 B：实验验证

**B1 干实验（in silico）**
- 执行引擎：现有 stateful Python kernel（RDKit/pandas/numpy 已配）
- **Simulation adapter 接口**：统一的 `SimulationPlatform` 契约（prepare/submit/poll/collect），参照 connector 模式
- 能力位 `deterministic`：同一 spec 是否逐位可复现（pyref=true；OpenMM CPU=false，多线程浮点归约所致，P5 实测）。observation record 携带该位，E1 检查器与 P8 报告据此选「重算对账」或「区间对账」
- 首批参考实现（2 个，证明接口通用性）：
  - 本地进程型：OpenMM（分子动力学，pip 可装，纯本地）
  - 命令行型：GROMACS（若本机可装）或退一档用 Python 内置仿真脚本作第二实现
- 后续按需求接：材料计算（VASP/LAMMPS）、EDA 等——接口先行，实现按用户真实课题拉动

P5 落地口径：
- 两个实现分别是 `openmm`（水盒子能量最小化 + 短时 NVT 平衡，实测 OpenMM 8.6 有 PyPI wheel，
  纯 CPU 秒级）与 `pyref`（阻尼谐振子 RK4，**零外部依赖 + 有解析解可对照**）。
  第二实现选 pyref 而不是 GROMACS：契约测试需要一个在任何环境都跑得通的实现，
  否则 CI 里 openmm 一缺就整套 skip，等于没有契约测试
- 两个 adapter 都是**子进程型**而非 kernel 内执行：MD 任务动辄数分钟起，占着 stateful kernel
  会把会话堵死；更关键的是「编排进程被 kill 后任务还在跑」要求任务是独立进程
- 状态真源在磁盘：`experiments/<platform>/runs/<runId>/{run.json,params.json,done.json,stdout.log}`，
  `prepared/<specHash>/params.json` 存归一化输入。`poll` **先看 done.json 再看 pid**——
  任务写完结果才退出，所以结果在就以结果为准，PID 复用最坏只让已死任务多「运行中」一会儿，
  不会把失败报成成功
- 不复用 v0.1 的 `compute/providers.ts`（`ComputeProvider`）：那套 `wait()` 是阻塞语义、状态全在
  内存，跨进程接不上，与 AD-4 要的生命周期契约不是一回事。该模块已在 P8（BACKLOG G6）连同其
  v0.1 测试一并删除——留着两套「提交任务」抽象只会让下一个人选错

**B2 湿实验（wet lab）**
- 现有：protocol compiler（自然语言 → 设备指令）+ safety gate（试剂兼容/浓度上限/生物安全）+ mock 设备
- v0.2 目标：**用 Opentrons 官方模拟器（`opentrons_simulate`）替换 mock**，跑通一次真实协议编译 → 模拟执行 → 结果回传
- 物理设备对接留 v0.3+（需要真实硬件）

P6 落地口径：
- 编译目标是 **Opentrons Flex** / Python Protocol API v2（`apiLevel 2.21`），不是 OT-2。
  两条理由：① opentrons 9.x 已移除 OT-2 支持，`simulate()` 对 OT-2 协议直接 `RuntimeError`；
  ② OT-2 没有吸光度读板模块，「600 nm 读 OD」在 Flex 上才有真模块，不必退化成注释
- 执行后端两个：`opentrons_simulate`（**默认**，官方模拟器）与 `mock_devices`（单测后端，
  零依赖）。mock 验管线、不验协议合法性——一个 opentrons 拒绝解析的脚本在 mock 上一样「跑成功」，
  所以默认必须是真模拟器
- **Opentrons 上没有的硬件不假装有**：离心、非四档波长读数、<37 °C 孵育、离机配液一律编译成
  `[spark-note]` 注释并标 `execution: "manual"`，run log 里是 note 不是执行记录
- run log 锚定：编译器在每步前注入 `protocol.comment("[spark-step] <id> <action>")`，
  结构化解析靠这个锚点把每条命令绑回编译产物里的某一步，不依赖 opentrons 的文案措辞
- `protocolHash` = sha256(生成的脚本源码)，源码里刻意不含编译时间戳——approve gate 批的是这个
  hash，带时间戳则每次编译都换 hash，approve 永远失效
- 安全门从三段 if 拆成**四条彼此独立的纯函数规则**（`chemical_compatibility` /
  `concentration_limit` / `biosafety` / **新增 `volume_capacity`**）。`volume_capacity` 吃编译产物：
  「单孔累计溢孔」在自然语言层面看不出来，只有排完 deck 累加才知道

**B3 干湿闭环引擎**
- 状态机：`design → dry_run → (approve gate) → wet_run → collect → analyze → iterate | conclude`
- 每次迭代是一个 Experiment record，输入/输出/参数全进证据图
- 断点续跑：状态持久化到 Project 存储，进程重启可恢复
- 人在环：湿实验执行前强制 approve gate（安全门通过 ≠ 自动执行）

P5 落地口径（干实验部分；`wet_run` 与 approve gate 留 P6）：
- 状态集 7 个：`design / dry_run / collect / analyze / concluded / iterated / failed`。
  `iterate` 与 `conclude` 实现为**终态**而不是动作名——iterate 的语义是「这条实验到此为止，
  另起一条」，新实验是新的 experiment record，用 `supersedes` 边连回旧的
- 合法转移只有 7 条（`design→dry_run`、`dry_run→collect|failed`、`collect→analyze`、
  `analyze→concluded|iterated`、`failed→dry_run`）；表外一律拒绝，**不做「顺手纠正」**
- 状态回写全部走 `RecordStore.update()` 窄口（P4 定的口径：生命周期字段可变，
  `type/evidence/origin/artifactId/createdAt` 不可变）；每次转移在
  `metadata.history` 与 `metadata.timestamps` 留时间戳
- 断点续跑的三种情形由 `resume()` 区分：**任务仍在跑**（无 done.json 且 pid 活着）→ 保持 dry_run；
  **任务已完成**（有 done.json）→ 直接 collect；**任务已丢失**（无 done.json 且 pid 没了）→
  标 `failed` 且 `recoverable=true`，可 `retry` 换新 run。
  「随进程一起被杀」与「算例本身跑挂」必须能分开——前者重跑就好，后者要改参数
- 证据图：`artifact record --derives_from--> experiment`（每个产出一条）、
  `observation --derives_from--> experiment` 与各 artifact record、
  `conclusion --derives_from--> observation/experiment`。
  experiment 的 evidence 是 `inferred`（设计是推的），observation 是 `computed`（结果是算的）
- 结论卡在 P5 只落最小结构且 `review` 一律 `pending`（完整 review 门槛见域 E2/P8）

P6 落地口径（湿实验半边 + approve gate）：
- 湿实验用**另一张状态机**，11 个状态：`design / compile / safety_check / awaiting_approval /
  wet_run / collect / analyze / concluded / iterated / rejected / failed`，18 条合法转移。
  与 P5 干实验状态机**刻意分表**：两条链的状态集不同，而且 P5 的转移表被一组穷举测试锁死，
  往里加状态会把那组测试的语义悄悄改掉。两者共用的是 record 存储、边语义与
  `RecordStore.update()` 窄口——那些才是该复用的
- **AD-6 的落点在转移表**：`wet_run` 的唯一入边是 `awaiting_approval → wet_run`，
  而这条边只有 `approve()` 会走。安全门通过后 `safetyCheck()` 连做两条转移
  （`compile → safety_check` 与 `safety_check → awaiting_approval`），
  「门过了」与「停下来等人」在证据图上分得开
- approve / reject 各落一条 `decision` record（`evidence=inferred`，`derives_from` 边连实验），
  metadata 记 **谁 / 何时 / 批的是哪个 protocolHash**；正文里列出批的那一版步骤表与当时的安全门结论
- **重新编译一律清掉已有的 approve/reject 与安全门结论**：协议在改，旧批准不能跨版本存活。
  另有第二道防线——`execute()` 在执行前把审批的 hash 与当前编译产物的 hash 再对一次，
  防的是状态机之外的路径（有人直接改了 record、并发编译）
- 干湿闭环接通两条路径：干实验在 `analyze` → 干线转 `iterated`、湿线 `supersedes` 接棒；
  干实验已 `concluded` → 只连 `derives_from`（结论成立、拿去湿实验验证）
- 湿实验的执行产出与 observation 的 `evidence` 是 **`observed`**（run log 记的是设备做了什么），
  与干实验的 `computed` 区分。模拟器执行同样算 observed，但正文与 metadata 里明写
  「硬件为模拟」——数据来源必须能被读图的人分辨
- 湿实验模拟是秒级同步任务（实测单协议 30–60 ms），所以 `execute()` await 子进程结束，
  不做 P5 那套 detach + poll。磁盘仍是真源（`protocol.py` / `runlog.json` / `done.json`
  由 python 侧原子写），换进程照样能接回来

### 域 C：全流程数据记录（Research Record）

**C1 数据模型**（扩展现有 artifact/lineage 架构，同一张图）

```
Record 类型：
  idea         思路卡（来自 Co-explore 或手动）
  decision     决策点（为什么选方案 A 不选 B）
  experiment   实验（干/湿，含参数、状态机状态）
  observation  观察（实验产出的原始发现）
  reading      精读卡（文献的结构化阅读笔记）
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

P7 落地口径：
- 时间线端点 `GET /api/records`，过滤维度 `type`（多选）/ `evidence` / `session` / `since` / `until`，
  分页 `limit` + `offset`。过滤谓词在 `RecordStore` 里抽成单一真源，`list()` 与 `count()` 共用——
  否则「这一页」与「总数」两套口径，翻页时总数会自相矛盾
- 证据子图 `GET /api/records/:id/graph?depth`（1-5），前端用**确定性环形布局**渲染：
  力导向每次打开长得不一样、截图对不上，不适合做审计用的图
- record 详情附带 artifact 内容（AD-3 的 id 互链在 API 层一次取到）

P8 落地口径（报告导出，`backend/src/report/export.ts`）：
- 分区：一、问题（项目描述 + idea 卡的 openQuestions + 文献基础统计）／二、思路（每张 idea 卡的
  假设、novelty 状态、支持与反对文献，走 supports/contradicts 边）／三、实验（干湿实验的状态、
  平台或后端、假设、摘要、观察）／四、结论（**只有 review approved 的卡**）／五、待验证
  （pending 与 vetoed，逐条列出阻塞它的 hard finding）／附录 A 证据索引／附录 B 参考文献
- **正文全部由代码渲染，不经过模型**。让模型写报告等于给它一次改数据的机会；
  同一条纪律已经用在 experiment record 与 novelty 报告上
- 每条陈述带 record id，读者可用 `conclusion show <id>` 或 `GET /api/records/<id>` 回原始记录核对；
  附录 A 的每个 id 都必须在 records.db 里解析得到（有测试守着，不许有幽灵条目）
- 能力位进措辞：`deterministic=false` → 「区间/趋势对账」；`simulated=true` → 结论标题挂
  `[模拟数据]` 并附「模拟器不验证生物学」。混合证据取最保守的一条
- 出口：`spark-research report export|stats`、`GET /api/report[?format=markdown]`、工作台导出按钮

### 域 D：创新性验证与梳理

**D1 Novelty check pipeline**
1. Claim 提取：从 idea 卡或结论卡提取可检验的创新点陈述（P4：1-5 条，每条配 2-3 个英文检索式）
2. 密集检索：针对每个 claim 多源检索（含语义近邻检索，Semantic Scholar/OpenAlex 的相关论文 API）
3. 对比报告：逐 claim 列出最接近的已有工作 + 相同点 + 差异点 + 新颖性评级（novel / incremental / existing，附证据）
4. **评级校验层（P4 新增，确定性代码）**：模型给的评级要被检索结果的可计算特征约束，否则「新颖性」等于让模型给自己的想法打分。规则见下表
5. Reviewer 复核：报告里每条「已有工作」引用必须真实存在（走 A3-4 同一套引用核验；knownKeys = 库内 key ∪ 本次检索候选）

评级校验规则（每条都是纯函数，可单测）：

| 规则 | 触发 | 后果 |
|------|------|------|
| `no_candidates` | 检索一条候选都没返回 | 结论不可用（**检索不到 ≠ 新颖**） |
| `rating_without_nearest` | 有候选却不列最近邻 | 结论不可用 |
| `unknown_work` | 引用了候选清单外的 key | 结论不可用 |
| `existing_without_high_affinity` | 评 existing 却没引到高相似候选 | 降级为 incremental |
| `novel_despite_high_affinity` | 存在高相似候选却评 novel | 升级为 existing |

「相似度」是确定性计算（claim/检索式与候选标题+摘要的内容词覆盖率），不是模型给的分；报告里模型评级与校正后评级都列出。

**D2 与思路库联动**：每个 Idea 卡有 novelty 状态字段（unchecked / checked-novel / checked-incremental / checked-overlap），检查结果作为 record 挂到证据图。

P4 落地口径：
- 报告 = artifact + `artifact` record（`metadata.kind="novelty_report"`，`evidence=inferred`），`derives_from` 边连 idea，`cites` 边连命中库内的候选论文
- 状态取最保守的一条：任一 claim `existing` → checked-overlap；否则任一 `incremental` → checked-incremental；全 `novel` → checked-novel
- 任一 claim 结论不可用 → 状态**维持 unchecked**，但报告指针仍写回 idea（「查过但没查出来」与「没查过」必须能区分）

### 域 E：结论分析与 Review

**E1 Reviewer 强化**（在现有 veto 机制上叠加）
- 现有：lineage 版本冲突检测（stale_input/version_mix）、trace-don't-recompute、否决完成
- 新增检查器（每个都是独立 rule，可单测）：
  - 引用真实性（服务域 A/D）—— P3 已落地为 `citation-integrity`：库外 key（含编造 key 与库外真文献）= hard veto；与精读卡冲突 = soft（LLM 辅助，标 inferred）；强断言无引用 = soft
  - 数据-结论一致性：结论卡引用的 observation 是否真实存在于执行记录
  - 统计合理性提示（soft finding）：样本量、多重比较、p-hacking 模式的启发式提示
- 按位置加权保留：figure/report 中的 claim 比 chat 中的严格。
  **例外**：`citation-integrity` 的 finding 严重度由规则自身定义，不参与位置加权——否则综述草稿（text/markdown）里所有 soft 提示都会被升成 veto，与「soft 只提示不否决」直接冲突（P3 决策 D3）

**E2 结论卡（Conclusion card）**
- 结构：claim + 证据列表（record 链接）+ limitations + confidence + review 状态（pending / approved / vetoed）
- 只有 review approved 的结论卡才能进入导出报告的「结论」区（vetoed/pending 的进「待验证」区）

P8 落地口径（`backend/src/conclusion/` + `backend/src/reviewer/conclusion_rules.ts`）：

三个新检查器（与 `citation-integrity` 同形态：零 IO、可单测、**豁免位置加权**——
结论卡正文是 markdown，位置加权会把所有 soft 升成 veto，直接毁掉「启发式只提示不否决」）：

| rule | 严重度 | 判据 |
|------|--------|------|
| `data-consistency` | hard / soft | 证据必须是本项目里真实存在的 observation：断链 / 跨项目 / 类型不对 / 零证据 = hard；无 runId 与 experimentId 锚点（手工登记）、证据图上没连 derives_from 边 = soft |
| `capability-labeling` | hard | 引用 `simulated=true` 的 observation 却没在 claim/limitations 标注 = hard；证据来自 `deterministic=false` 的平台却声称逐位/完全一致 = hard |
| `stats-plausibility` | **只有 soft** | 启发式：样本量 < 6 / 多重比较未校正 / p ∈ [0.04, 0.05] / 强因果断言 + 弱证据基础。每条 finding 带 `heuristic: true`，误报漏报都在预期内 |

- **判定规则不可协商**：任一 hard → `vetoed`，零 hard → `approved`。不提供「人工推翻 hard」
  的路径——三条 hard 全部是可核对的事实判断，不是审美问题；反方向提供 `--veto`
  （人挡下一条本来会自动通过的结论，理由必填）
- 每次评审落一条 `decision` record（`kind=conclusion_review`，derives_from → 结论卡），
  记谁、何时、判了什么、依据哪些 finding。CLI 落 `$USER` 时 `actorSource` 记 `env:USER`；
  HTTP 缺 actor 直接 400 并记 `http:explicit`（AD-6 的 P7 补充）
- **报告看的是卡上已落的 review 状态，不是「现在跑一遍会通过」**。没评审就是没评审，
  报告不替评审人按通过键
- `review` 字段兼容 P5/P6 的裸字符串形态；解析不出来一律落回 `pending`——
  一个读不懂的 review 字段绝不能被当成 approved

---

## 五、系统架构

### 5.1 分层图

```
┌────────────────────────────────────────────────────────────┐
│  界面层                                                      │
│  CLI（完整功能）· Web 工作台（项目导航+会话+时间线+实验面板）    │
│  MCP server（P9：24 工具，外部 agent 接入；审批类刻意不暴露）    │
│  ↕ HTTP API（P7：域端点 + 长任务句柄 + SSE，UI 与 MCP 都是投影） │
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
│    papers/ · artifacts/(含 artifacts.db) ·                   │
│    experiments/<platform>/{prepared,runs}/  (P5 仿真状态真源)  │
│  ~/.spark-research/state.json (当前项目 + session→project)    │
│  ~/.spark-research/credentials.json (0600, daemon-only)      │
│  ~/.spark-research/config.json (P9：配置真源，env > file > 默认)│
└────────────────────────────────────────────────────────────┘
```

### 5.2 关键架构决策（ADR 摘要）

| # | 决策 | 理由 |
|---|------|------|
| AD-1 | Project 为持久层根，session 挂在 project 下 | 科研单位是课题；差异化主张 §3.1 |
| AD-2 | 凭据只在 daemon，kernel 走 `mcp_call` 代访问 | AMiner 调研教训；凭据永不进沙箱/env/prompt。P1 落地口径：daemon 的 `credentials` 方法只回「是否已配置 + 字段名」，值本体不出 daemon；无该 permit 的 kernel 连元数据都拿不到 |
| AD-3 | Record 与 Artifact 同图不同表，id 互链 | 复用已验证的 lineage 机制，避免双图不一致。P1 落地：`records.artifact_id` → `artifacts.id`，且 `artifacts.project_slug` 指向真实 project |
| AD-4 | Simulation adapter 独立于 connector | connector 是数据读取（幂等），仿真是长任务生命周期（prepare/submit/poll/collect），契约不同 |
| AD-5 | 技能少而深：每个技能必须有配套 e2e 验证才算完成 | 对 OpenScience 313 技能「质量参差」的差异化回应 |
| AD-6 | 湿实验执行前强制人工 approve gate | 安全门是必要非充分条件；物理世界操作不自动化审批。**P7 补充（HTTP 层比 CLI 更严）**：CLI 缺 `--actor` 时落到 `$USER` 是诚实的（就是这个人在这台机器上敲的命令）；HTTP **不许**有 env 兜底——服务进程的 OS 用户与点「批准」的人无关，缺 `actor` 直接 400，`actorSource` 记 `http:explicit` 以便审计分辨来源。注意当前是单用户本地场景下的「谁自称就是谁」，做多用户时这里要换成真实身份 |
| AD-7 | 前端 vanilla JS 保持到 P7；P7 起迁 SolidJS，对标 OpenScience workspace 体验（2026-09-09 用户定档），API 先行 | CLI/API 是能力真源，UI 是投影。**P7 已落地**：SolidJS + Vite（依赖只有 solid-js/vite/vite-plugin-solid，Markdown/图表/证据图全自写），构建产物由 server 静态托管，产物不入 git、缺失时 UI 路径回 503 + 构建指引而 API 照常。UI 与 CLI 的行为对照见 `tests/unit/ui_cli_parity.test.ts` |
| AD-8 | 凡是「模型给结论、结论会影响下游动作」的地方，都要有一层确定性代码按可计算特征约束它（P4 的评级校验层是第一例） | LLM 判断可以作为输入，但不能既当运动员又当裁判。约束层必须零 IO、纯函数、可单测，并把「模型原判」与「校正后」都留在产物里 |
| AD-9 | **MCP 暴露面按「谁承担后果」切，而不是按「能不能实现」切**（P9 新增） | `lab approve/reject/simulate` 与 `conclusion review` 不做成 MCP 工具：若外部 agent 能自己批准，它就能自己编译协议、自己批准、自己执行，AD-6 的 approve gate 退化成注释；结论评审同理，那是可信度的最后一道闸。落地要求三条：① 不暴露清单是**显式数据**（`MCP_WITHHELD`），进 capabilities 输出与 server instructions，让外部 agent 一眼看到边界；② 相邻的只读能力照常开放（`lab_status` / `conclusion_get` 的预评估），拒绝要精确不要一刀切；③ **结构性防线**——测试遍历全部已暴露工具的请求构造，断言没有一个能打到审批类端点，防的是「换个名字绕过去」。<br>**主会话裁定（v0.2.0）**：MCP 工具清单是**能力声明，不是访问控制**。真正的访问控制在别处（daemon 的 permit set、文件权限、物理设备要人去按）。一个有 Bash 权限的 agent 确实能绕道调 CLI——承认这一点，不假装挡得住。这条边界起的作用是另外三件事：**默认路径**（agent 的第一反应是「我有哪些工具」，自动批准不在默认可达集合里）、**意图显性化**（绕道要主动构造命令，是一个「我知道我在绕过设计」的留痕动作，用户在 permission 层看得见）、**责任归属**（经 MCP 调用是我们授权的能力；经 Bash 绕过是用户授予 Bash 权限的后果）。所以它是纵深防御的一层，不是唯一一层——说它能挡住有意绕过者是安全剧场，但说「反正能绕过所以不该做」同样错：默认值决定 99% 的行为。若要真正堵住绕道，正确做法不是加固 MCP 层，而是在 CLI 层要求审批必须来自可交互终端（见 BACKLOG V19） |

### 5.3 技能目录（v0.2 首批，共 10 个）

| 技能 | 域 | 验证方式 |
|------|-----|---------|
| literature-search | A | 真实多源检索 e2e（fixture 回放进 CI） |
| paper-download | A | arXiv+EuropePMC 真实下载（已有验证经验） |
| library-curation | A | 入库/去重/BibTeX 导出单测 |
| literature-review | A | 10 篇文献 → 综述 → 引用核验全过 |
| idea-coexplore | A | 对话产出 Idea 卡 + 文献 grounding 检查 |
| novelty-check | D | 已知领域 idea → 对比报告 → 引用真实性核验 |
| protein-analysis | B | UniProt/PDB/AlphaFold 链路（P5：真实录制 fixture 回放 e2e，12 用例） |
| dry-experiment | B | OpenMM 最小 MD 任务端到端（P5：契约测试 ×2 实现 + 真实 SIGKILL 恢复 e2e） |
| wet-protocol | B | 协议编译 → Opentrons 模拟器执行（P6：2 类协议真模拟器 e2e + 安全门 4 条规则对抗矩阵 + approve gate 单测） |
| research-report | C/E | 证据图 → Markdown 报告，结论卡 review 门槛生效（P8：三检查器单测 + 报告分区归属 + 全链路演练脚本） |

### 5.4 模型路由

- 保持模型无关（现有 LLMRouter：kimi/openai/anthropic/deepseek/qwen/openrouter）
- 子代理可配置独立模型（重任务用强模型，检索/摘要用快模型）。P9 核对：这一层目前是**代码内配置**，暴露成用户配置项记在 BACKLOG V16
- 默认模型保持 OpenRouter 路由，用户 BYOK

## 5.5 扩展面与自描述（P9）

- **六个扩展点**（Skill / Connector / SimulationPlatform / WetLabBackend / 安全门规则 / Prompt 与模型路由）的契约、最小可运行示例、测试方法与文件位置见 [EXTENDING.md](EXTENDING.md)
- **脚手架**：`spark-research new skill|connector|platform`，生成的测试桩当场可跑（CI 真跑一遍）
- **能力自描述**：`spark-research capabilities [--json] [--probe]`，**全部从真实注册表生成**并有双向一致性测试（清单里的每一项可实例化；注册表里的每一项都在清单里）。可用性分静态档（零 IO）与探测档（spawn 子进程）两层，不混
- **配置面收口**：`~/.spark-research/config.json` + 一张设置表（`backend/src/config/index.ts`）作单一真源，优先级 env > config.json > 默认值；凭据与设置同文件但标 `secret`，值永不打印、永不进 env
- **SKILL.md frontmatter 规范化**：新增 `triggers` / `connectors` / `validation` 三个必填字段，schema 校验进 CI；`validation` 让 AD-5 从口号变成一道门（校验器去磁盘核对测试文件存在）
- **llms.txt / llms-full.txt**：由 `bun run gen:llms` 幂等生成，CI 守与文档同步
- **命名修正**：connector 基类 `MCPConnector` → `HttpConnector`（与 MCP 协议无关，是 v0.1 的历史包袱）。旧名保留 deprecated 别名，移除记在 BACKLOG V15

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

P8 核验结论（逐条证据见 [devlog/P8-wrapup.md](devlog/P8-wrapup.md)）：

| 判据 | 结论 | 证据 |
|------|------|------|
| 1 完整研究线索 | ✅ | `scripts/demo-research-thread.ts`（可重放、零网络、CI 入口 `tests/unit/demo_thread.test.ts`）+ 浏览器版 Playwright ①–⑫。**一处偏差**：干实验用 pyref 而非 OpenMM——CI 里不能依赖 openmm 装没装，OpenMM 走的是同一套契约测试 |
| 2 湿实验路径 | ✅ | `tests/unit/wet_e2e.test.ts` 两类协议在**真** `opentrons.simulate` 下执行；安全门 4 条规则对抗矩阵；Playwright ⑦⑧⑨ 走浏览器版 |
| 3 测试基线 | ✅ | 单元 706（基线 84 → 655 → 706；P8 删除 v0.1 compute 模块的 12 条属 G6 授权清理）· pytest 48 · Playwright 12 · typecheck 干净 |
| 4 文档 | ✅ | README 重写、CHANGELOG v0.2.0、9 篇 devlog、本文档随实现更新 |

P9 追加核验（扩展面与 LLM 友好化，逐条证据见 [devlog/P9-extensibility.md](devlog/P9-extensibility.md)）：

| 项 | 结论 | 证据 |
|----|------|------|
| 六个扩展点有文档且示例可跑 | ✅ | [EXTENDING.md](EXTENDING.md) 六节；skill/connector/platform 示例=脚手架产物，CI 生成后真跑；安全门规则示例 `examples/extending/flammable_over_heat_rule.ts` 带 11 例（含阴性对照） |
| 能力清单从注册表生成 | ✅ | `tests/unit/capabilities.test.ts` 双向一致（19 例） |
| MCP 可被真实客户端跑通 | ✅ | `tests/unit/mcp_e2e.test.ts` 用 SDK Client + InMemoryTransport 走完 capabilities → 检索入库 → idea → novelty → 时间线 → 报告 |
| 审批类动作在 MCP 层不可达 | ✅ | `tests/unit/mcp_server.test.ts` 对抗组，含遍历全部工具请求构造的结构性防线 |
| llms.txt 幂等 | ✅ | `tests/unit/llms_txt.test.ts`（含「改了文档忘了重新生成 → 红」这道门） |
| 测试基线 | ✅ | 单元 716 → 824（+108）· pytest 48 · Playwright 12 · typecheck 干净 |
