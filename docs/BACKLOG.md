# Backlog

> 唯一登记处：范围外/待定项都记这里，不散落在 devlog。
> **这不是一张只进不出的表**——每条都要有去向：吸收进某个阶段、明确推迟、或明确不做并给理由。
> 最后更新：2026-09-09（v0.2.1 外部验收收口；全部 19 条 V 项已由 v0.3 方案归口，见 §「去向总表」）

## 去向总表（一眼看清每条在哪）

v0.3 方案（`DEVELOPMENT_PLAN_v0.3.md` §八·补）已对全部条目归口。这里是反向索引：

| 去向 | 条目 |
|------|------|
| **v0.3 会做** | V1 V3 V7(删除) V8 V9 V11 V12 V13 V14 V15 V16 V17 V18 V19 · D2 |
| **v0.3 之后**（下方 §post-v0.3） | V2 V4 V5 V6 V10 · D1 D3 |
| **已消化** | G1–G7（P8）· 三个 MCP 摩擦点（v0.2.1） |

---

## post-v0.3 · v0.3 完成后再议

> 用户 2026-09-09 指定：这些等 v0.3 开发完再继续做。
> 三类：**等需求拉动**（做了也没人用）、**等前置条件**（现在做会返工）、**等外部输入**（不在我们手里）。

### 等需求拉动 —— 有真实使用场景再做，否则是空转

| # | 项 | 为什么等 | 何时该启动 |
|---|-----|---------|-----------|
| V4 | 远端算力真实实现（Docker / SSH / Modal / 火山引擎） | 抽象层已就位，但没有真实课题要求跑远端；凭空实现会照着想象中的用法做错 | 有一个课题的算力需求超出本机时 |
| V5 | R kernel | permit set 里早有位置，但至今无人要 R；P12 做实子代理后再加一个 kernel 成本更低 | 有用户明确要 R |
| D1 | 第三个仿真平台（材料计算 VASP/LAMMPS？EDA？） | `SimulationPlatform` 契约已被 OpenMM + pyref 两个实现验证过通用性。P15 的 `ext verify` 落地后，第三方自己加比我们代做更划算 | 用户的真实课题指定了平台 |

### 等前置条件 —— 现在做会返工或立不住

| # | 项 | 卡在什么前置 |
|---|-----|-------------|
| V2 | novelty 相似度语义化（词面 → embedding） | 需要 embedding provider 决策（自托管？走 LLM provider？）。P11 的 provider 抽象为它铺路，铺好了再做才不会做两遍。**当前风险已知**：词面阈值 0.75，标定样本仅 2 个 claim，最近邻余量 0.08 |
| V6 | 物理 Opentrons / 真实设备对接 | 硬前置是 v0.3 的 D-8「安全门声明兑现」。在安全门真的守得住之前碰物理设备是不负责任的。同设备族接入靠新 `WetLabBackend` 即插即用；**非 Opentrons 设备族**需把设备语言编译下沉进 backend（施工说明见 `EXTENDING.md` 第 4 节） |
| V10 | HTTP 层真实身份（多用户场景） | v0.3 先把 agent 层做实。当前 approve 的 actor 是「谁自称就是谁」——单用户本地诚实，**做多用户前必须先解决**，否则审批审计不成立。与 V19（审批要求可交互终端，v0.3 P12 做）配套才完整 |
| V15 | 移除 `MCPConnector` 等 deprecated 别名 | v0.3 P10 会尝试；确认无外部引用才能删。做不掉就留这里 |

### 等外部输入 —— 不在我们手里

| # | 项 | 等什么 |
|---|-----|--------|
| D3 | CNKI / 万方真实 API | 用户是否有 API 渠道。无公开 API，AMiner 仍是中文文献主路径 |

---


## P8-gate（发布前验证清单）—— **已全部消化（P8，2026-09-09）**

| # | 项 | 来源 | 结果 |
|---|-----|------|------|
| G1 | E2 结论卡 review 门槛：pending/approved/vetoed，仅 approved 进报告结论区 | DESIGN E2，P5 只落了最小 conclusion record | ✅ `conclusion/` 模块 + CLI/API/UI 三入口；判定不可协商（任一 hard → vetoed） |
| G2 | E1 数据-结论一致性检查器（结论引用的 observation 必须真实存在于执行记录） | DESIGN E1 | ✅ `data-consistency`；四种对抗（伪造 / 已删除 / 跨项目 / 类型不对）全部 hard |
| G3 | E1 统计合理性 soft 提示检查器 | DESIGN E1 | ✅ `stats-plausibility`；只出 soft，带 `heuristic:true`，含阴性对照 |
| G4 | 能力位消费端：`deterministic`（区间 vs 逐位对账）与 `simulated`（模拟读数 0.0 不得当真实数据进结论）在 E1 检查器与 P8 报告中的消化 | P5/P6 验收批注 | ✅ `capability-labeling`；模拟未标注与非确定性平台上声称逐位复现均为 hard；报告措辞随能力位变 |
| G5 | 「真 key 假内容」（模式 B）在真实模型下的判准率测量 | P3 devlog 批注 | ✅ 已测量（三档分级，5 次运行）：precision 全档全轮 100%；easy/medium recall 100%；hard recall 71–100%。详见 devlog |
| G6 | 删除 deprecated 的 `compute/providers.ts` 及其 v0.1 测试 | P5 验收批注 | ✅ `backend/src/compute/` 三个文件 + 测试删除，无引用残留 |
| G7 | 证据图 → Markdown 报告导出 + research-report 技能（§5.3 第 10 个技能） | PLAN P8 | ✅ `report/export.ts` + `report` CLI + `/api/report` + 工作台导出按钮 + research-report 技能 |

## 全部条目明细（按登记顺序）

> 每条的**去向**见 §去向总表；被推迟的在 §post-v0.3 有展开理由。
> 这一节保留原始登记内容与来源，是可追溯的历史，不删。

| # | 项 | 备注 |
|---|-----|------|
| V19 | 审批动作要求可交互终端 | AD-9 裁定的推论：MCP 层挡的是默认路径与责任归属，**不是**技术上的绕道。要真堵住「agent 用 Bash 调 `lab approve --actor 自己编的名字`」，得在 CLI 层要求审批来自 TTY，或要求一个非交互环境拿不到的确认令牌。这才是技术防线；在此之前不要声称审批「无法被自动化」 |

| # | 项 | 备注 |
|---|-----|------|
| V14 | 位置加权豁免改白名单制 | P3 D3 说「第二个例外再重构」；P8 三条新 rule 一起成了例外，阈值已到。当前靠调用路径隔离，能工作但不显式 |
| V1 | arXiv/PubMed 接入统一检索 | 缺 XML parser，目前统一检索只有 4 个 JSON 源 |
| V2 | novelty 相似度语义化（embedding provider 决策 + 集成） | 词面 0.75 阈值余量 0.08；与 G5 一起看 |
| V3 | poll 的进程 start-time 交叉核验 | 现状「done.json 优先」方向安全，只会多报 running |
| V4 | 远端算力真实实现（Docker/SSH/Modal/火山引擎） | DESIGN 明示按需求拉动 |
| V5 | R kernel | v0.1 遗留 permit set 已有位置 |
| V6 | 物理 Opentrons / 真实设备对接 | 需真实硬件。同设备族=新 WetLabBackend 即插即用；**非 Opentrons 设备族**需把「结构化步骤→设备语言」编译下沉进 backend（当前 execute() 入参为 OpentronsProgram）。**P9 已把五步施工说明写进 [EXTENDING.md 第 4 节](EXTENDING.md)**（含 protocolHash 语义搬迁与 volume_capacity 规则的降级口径）；等第二设备族选定再动（AD-4 教训：两个真实实现才验证得了接口） |
| V7 | Agent Swarm（v0.1 遗留）接入新架构 | 与子代理独立模型配置一起评估 |
| V8 | 中文检索式召回优化 | P4 实测中文检索式召回极差 |
| V10 | HTTP 层真实身份（多用户场景） | P7 现状：approve 的 actor 是「谁自称就是谁」（actorSource=`http:explicit`）。单用户本地诚实；**做多用户前必须换成真实身份认证**，否则审批审计不成立 |
| V11 | 长任务句柄落盘 | P7 现状：`server/tasks.ts` 的任务列表在进程重启后丢失（磁盘上的实验状态仍在，`exp run --resume` 可接回）。若要 UI 跨重启看到「正在跑的任务」需落盘 |
| V9 | AMiner `getPaper` 详情接口带真实 key 验证 | search 已真实验通（HTTP 200） |
| V12 | LLM 结构化输出（`response_format` / JSON mode） | P8-G5 实测：kimi-k2.6 每轮有 2–6% 的判定只吐思维链、`content` 里没有 JSON（`finish_reason` 不是 `length`，不是截断）。已加「解析失败重试一次」但治标不治本。根治要么让 LLMRouter 支持 `response_format: json_object`，要么给判定器配一个支持结构化输出的模型。现状是安全的（降级为可见的 `citation_judge_unavailable` soft finding，不假装通过），代价是这部分引用本轮没被检查 |
| V13 | 判定 prompt 对「凭空归因」的口径 | P8-G5 实测：难档唯一稳定的漏报模式是「草稿给出卡片里没有的归因解释」。prompt 写的是「声称了卡片里明确没有的结果 = conflict」，模型读成「卡片没覆盖 → unclear」。两种读法都讲得通，是 prompt 的歧义而非模型的错。改口径前要先想清楚：收紧会不会把合法的概括也扫进来（那正是 P3 刻意避免的误报） |

| V15 | 移除 `MCPConnector` 等 deprecated 别名 | P9 已改名 `HttpConnector`（连同 `HttpConnectorConfig` / `HttpTool`）并保留三个别名兼容外部引用。v0.3 可删——但要先确认没有外部集成在用旧名 |
| V16 | 子代理独立模型暴露成用户配置项 | 现状：`SubAgentConfig.model` 是代码内配置，全部落到 `LLMRouter.DEFAULT_MODEL`。「重任务用强模型、检索摘要用快模型」的收益要与 V7 一起评估 |
| V17 | MCP 长任务的进度回传 | 现状：超时前 MCP 侧只轮询任务句柄，进度不回传客户端。MCP 协议有 progress notification，接上后外部 agent 能看到「精读第 7/20 篇」而不是干等 |
| V18 | `capabilities --probe` 结果缓存 | 现状：每次 probe 都 spawn 子进程（openmm/opentrons 各一次，秒级）。外部 agent 反复调 `research_capabilities(probe=true)` 会白等。缓存必须带失效条件（venv 变更），否则它会撒谎 |
| V20 | `backend/src/index.ts` 的 `CONFIG_DIR` 不认 `SPARK_RESEARCH_DATA_DIR` | P10 lane D-c 发现：`config/index.ts` 的 `dataDir()` 认这个环境变量，`index.ts` 里的 `CONFIG_DIR` 是硬编码 `~/.spark-research`。默认设置下无害，但意味着测试注入的临时工作区对 `auth` 命令无效，两条路径对同一份 config.json 有两种解析 |
| V21 | 超时类环境变量前缀不统一 | P10 收口时新登记的四个超时用了 `SPARK_HTTP/LLM/KERNEL/TASK_TIMEOUT_MS`，而仓库既有约定是 `SPARK_RESEARCH_*`（如 `SPARK_RESEARCH_MCP_TIMEOUT_MS`）。**没有在 P10 一并改齐是刻意的**：v0.2.1 的 MCP 工具描述里已经把 `SPARK_TASK_TIMEOUT_MS` 写给外部 agent 看了，改名是 breaking change，要走废弃周期 |
| V22 | **protein-analysis 技能没有任何生产入口** | P10 的 D-12 门禁（孤儿模块检测）发现：`backend/src/proteins/analysis.ts` 只被测试引用——无 CLI 命令、无 HTTP 路由、无 MCP 工具、不在 capabilities 里。但 DESIGN §5.3 把它列为 10 个技能之一，SKILL.md 还写着「代码入口：`ProteinAnalysis.analyze(query)`」。**e2e 有、AD-5 纸面满足，可用户与外部 agent 都调不到它**。要么补入口，要么从技能目录撤下 |
| V23 | 湿实验 `unconsumedWarnings` 尚未在 HTTP / Web 审批面强制展示 | P10 lane D-d 交付：CLI 的编译与审批输出已强制显示，HTTP/UI 侧还没接。**接物理设备前必须补**——否则经 Web 批准的人看不到「你写了但安全门没看见」的部分 |
| V24 | `RecordIntegrityError` 没有恢复路径 | P10 lane D-d 新增的 record 完整性哈希校验，检测到被篡改的记录只能拒绝信任，没有「人工确认后修复」的入口，只能用 `RecordStore` 原始接口手工处理 |
| V25 | `concentration_limit` / `biosafety` 的自然语言解析 | P10 D-8 明确未做：两条规则在主管线上恒空转，靠 `unconsumedWarnings` 兜底告警。**这是 V6（对接物理 Opentrons）的硬前置**，见 README 的「安全门当前的真实覆盖范围」

## 待定（等外部输入 / 用户拍板）—— 已并入 §post-v0.3

> D1/D3 的展开理由见 §post-v0.3；D2（Semantic Scholar key）已归口 v0.3 P16。

| # | 项 | 等什么 |
|---|-----|--------|
| D1 | 第三个仿真平台 adapter（材料计算 VASP/LAMMPS？EDA？） | 用户真实课题拉动；SimulationPlatform 契约已被两实现验证 |
| D2 | Semantic Scholar API key 接入 | 用户申请免费 key（connector 走凭据服务，id `semanticscholar`） |
| D3 | CNKI / 万方真实 API | 用户有无 API 渠道；AMiner 目前是中文文献主路径 |
