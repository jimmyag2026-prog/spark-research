# Backlog

> 唯一登记处：范围外/待定项都记这里，不散落在 devlog。
> **这不是一张只进不出的表**——每条都要有去向：吸收进某个阶段、明确推迟、或明确不做并给理由。
> 最后更新：2026-09-10（v0.5 规划启动：V4 启动条件触发、V2 有设计稿、新增 V26；
> v0.5 规划真源在本地目录 `~/Desktop/AI4S/spark-research-v0.5-plan/TODO_v0.5.md`，刻意未入库，v0.4 完成后评审）

## 去向总表（一眼看清每条在哪）

v0.3 方案（`DEVELOPMENT_PLAN_v0.3.md` §八·补）已对全部条目归口。这里是反向索引：

| 去向 | 条目 |
|------|------|
| **v0.3 会做** | V1 V3 V7(删除) V8 V9 V11 V12 V13 V14 V15 V16 V17 V18 V19 · D2 |
| **v0.3 之后**（下方 §post-v0.3） | V2 V4 V5 V6 V10 · D1 D3 |
| **已消化** | G1–G7（P8）· 三个 MCP 摩擦点（v0.2.1） |
| **v0.5 规划中**（本地规划目录，未入库） | V2 V4 V15 V25(字段兑现) V26 · 另有 connector/skill/内联视图扩展等新项，见规划目录 TODO_v0.5.md |

---

## post-v0.3 · v0.3 完成后再议

> 用户 2026-09-09 指定：这些等 v0.3 开发完再继续做。
> 三类：**等需求拉动**（做了也没人用）、**等前置条件**（现在做会返工）、**等外部输入**（不在我们手里）。

### 等需求拉动 —— 有真实使用场景再做，否则是空转

| # | 项 | 为什么等 | 何时该启动 |
|---|-----|---------|-----------|
| V4 | 远端算力真实实现（Docker / SSH / Modal / 火山引擎） | 抽象层已就位，但没有真实课题要求跑远端；凭空实现会照着想象中的用法做错 | 有一个课题的算力需求超出本机时<br>✅ **启动条件已触发（2026-09-10 用户拍板，定为 v0.5 主线）**：连接设计已完成（规划目录 `workstreams/compute/COMPUTE_DESIGN.md`，照 OpenScience JobBroker 架构：Plan 摘要审批 + 持久卷结果真源 + 符号化凭据 + 三轴生命周期；第一实现 Modal，SSH/火山引擎留 Target 槽位）。v0.4 侧仅 P12 §4.2 第 6 条的接口预留 |
| V5 | R kernel | permit set 里早有位置，但至今无人要 R；P12 做实子代理后再加一个 kernel 成本更低 | 有用户明确要 R |
| D1 | 第三个仿真平台（材料计算 VASP/LAMMPS？EDA？） | `SimulationPlatform` 契约已被 OpenMM + pyref 两个实现验证过通用性。P15 的 `ext verify` 落地后，第三方自己加比我们代做更划算 | 用户的真实课题指定了平台 |

### 等前置条件 —— 现在做会返工或立不住

| # | 项 | 卡在什么前置 |
|---|-----|-------------|
| V2 | novelty 相似度语义化（词面 → embedding） | 需要 embedding provider 决策（自托管？走 LLM provider?）。P11 的 provider 抽象为它铺路，铺好了再做才不会做两遍。**当前风险已知**：词面阈值 0.75，标定样本仅 2 个 claim，最近邻余量 0.08<br>**2026-09-10 补**：调研确认 OpenScience **没有** embedding 抽象（上游 `embeddingModel` 被显式注释停用），无作业可抄；v0.5 设计稿已备（规划目录 provider workstream：`llm/embeddings.ts` 与 chat 平级的抽象，后端优先 Ollama 本地零 key + OpenAI 复用现有 key，词面法保留为降级路径、双留痕符合 AD-8）。落地仍等 P11 |
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
| V20 | `backend/src/index.ts` 的 `CONFIG_DIR` 不认 `SPARK_RESEARCH_DATA_DIR` | P10 lane D-c 发现：`config/index.ts` 的 `dataDir()` 认这个环境变量，`index.ts` 里的 `CONFIG_DIR` 是硬编码 `~/.spark-research`。默认设置下无害，但意味着测试注入的临时工作区对 `auth` 命令无效，两条路径对同一份 config.json 有两种解析<br>✅ **v0.4 P11 lane R-d 已消化**：`index.ts` 的 `CONFIG_DIR` 改为调用 `config/index.ts` 的 `dataDir()`，两条路径对同一份 config.json 归一解析；顺带清掉已死的 `homedir` import 与 `auth` 成功提示里的硬编码路径。 |
| V21 | 超时类环境变量前缀不统一 | P10 收口时新登记的四个超时用了 `SPARK_HTTP/LLM/KERNEL/TASK_TIMEOUT_MS`，而仓库既有约定是 `SPARK_RESEARCH_*`（如 `SPARK_RESEARCH_MCP_TIMEOUT_MS`）。**没有在 P10 一并改齐是刻意的**：v0.2.1 的 MCP 工具描述里已经把 `SPARK_TASK_TIMEOUT_MS` 写给外部 agent 看了，改名是 breaking change，要走废弃周期 |
| V22 | **`capabilities` 对外广播了一个无法调用的技能（自描述面撒谎）** | P10 的 D-12 门禁发现 `backend/src/proteins/analysis.ts` 只被测试引用；v0.4 方案制订时进一步核实，**比「少个入口」严重**：`capabilities --json` 把 `protein-analysis` 当**可用能力**完整广播——带描述、`triggers`（「这个蛋白长什么样」「有没有可用的结构」）、connector 清单、`validation` 文件列表，而 CLI / HTTP / MCP **三个入口全无**（实测 10 个技能里唯一一个；它的 SKILL.md 里也是唯一没有 CLI 示例的）。外部 agent 读了 triggers 会确信自己能调用它。**这不是完整性缺口，是自描述面在对外撒谎**——AD-12「能力声称必须机器可核」的直接违反，而现有门禁只查孤儿模块、没查技能可达性。另注：它列的 `validation` 第二项 `tests/integration/protein_record.test.ts` 属于 8 个 `skipIf(!RECORDING)` 用例之一，本轮从未跑过。处置见 v0.4 的 P11 lane R-d：补入口或从技能目录撤下，二选一不许悬着<br>✅ **v0.4 P11 lane R-d 已消化**：`protein-analysis` 补齐三个真实入口——CLI `spark-research protein <query>`、HTTP `POST /api/proteins/analyze`、MCP 工具 `protein_analyze`（MCP 工具数 29 → 30），SKILL.md 补上此前唯一缺失的 CLI 示例。**并把判据做成门禁**：`narrative_parity.test.ts` 第 7 条断言每个技能至少有一条可达入口，登记表的每一条都去 `index.ts` 的 `switch(cmd)` case 字面量 / `MCP_TOOLS` 数组 / `capabilities` skills 列表三处对账（不靠散文正则）。阴性对照已由主会话独立复跑：拆掉 `case "protein":` → 门禁立刻红。 |
| V23 | 湿实验 `unconsumedWarnings` 尚未在 HTTP / Web 审批面强制展示 | P10 lane D-d 交付：CLI 的编译与审批输出已强制显示，HTTP/UI 侧还没接。**接物理设备前必须补**——否则经 Web 批准的人看不到「你写了但安全门没看见」的部分<br>✅ **v0.4 P11 lane R-d 已消化**：HTTP 层原本已结构性透传（`viewJson()` 整体 spread `WetExperimentView`）只是没测试；真实缺口在前端——`WetExperiment` 类型缺 `unconsumedWarnings` 字段、审批弹窗从不渲染它。已补类型 + 显眼的告警块（`data-testid="unconsumed-warnings"`）+ HTTP 断言 + e2e ⑨b。阴性对照：强制隐藏告警块 → e2e ⑨b 红。 |
| V24 | `RecordIntegrityError` 没有恢复路径 | P10 lane D-d 新增的 record 完整性哈希校验，检测到被篡改的记录只能拒绝信任，没有「人工确认后修复」的入口，只能用 `RecordStore` 原始接口手工处理 |
| V25 | **[已完成]** `concentration_limit` / `biosafety` 的自然语言解析 | P10 D-8 明确未做：两条规则在主管线上恒空转，靠 `unconsumedWarnings` 兜底告警。**这是 V6（对接物理 Opentrons）的硬前置**，见 README 的「安全门当前的真实覆盖范围」 <br><br>✅ **v0.5 W5-1 δ 已做（部分覆盖，边界如实写进 README）**：两条规则从恒空转变成真消费。但只吃「浓度/BSL 与目标试剂或步骤**同句**出现」这一类；跨句写法（先说试剂、后说浓度，最常见）编译器**拒绝猜归属**、仍落 unconsumedWarnings。**V6 硬件门槛不因此解除。** |
| V26 | connector 限速按 host 合池 | **2026-09-10 新登记**（来源：v0.5 connector 扩展调研）。现状：connector 层只有礼貌头（`politeness.ts`），**没有任何限速器**。pubmed 与 ncbi 已共享 NCBI eutils 的主机级预算，v0.5 计划新增的 ClinVar / GEO 也打同一主机——四个 connector 各自为政会集体被 429。限速器若做必须按 host 键控合池，不按 connector。去向：v0.5 集成 eutils 系新 connector 时同批做 |
| V27 | **[已完成]** **单二进制里 `import.meta.dir` 全线失效（阻塞 npx 分发）** | v0.4 W1 收口实测：`bun build --compile` 的产物里 `import.meta.dir` 指向虚拟的 `/$bunfs/root/`，**任何靠它拼路径的代码在二进制里都读不到文件**。现状 **23 处、17 个文件**（`kernels/manager.ts` 找 python 脚本、`lab/wet_backend.ts` 找 `opentrons_backend.py`、`agents/*` 找 prompt `.txt`、`simulation/*` 找适配器脚本、`skills/frontmatter.ts`、`scaffold/templates.ts`、`server/app.ts` 找前端产物…）。已修两处（`index.ts` 与 `version.ts` 改静态 import，并加了版本号一致性断言）；**其余未修，后果是二进制里干湿实验 / prompt 加载 / 脚手架 / 前端托管大概率全坏**。**W1 收口实测（比初判严重）**：`bun build --compile` **不嵌入非 JS 资产**（`.sql` / `.py` / prompt `.txt`），于是二进制里凡是要读资产的命令全部 ENOENT——
```
$ ./dist/spark-research project new x   → ENOENT: /$bunfs/root/schema.sql
$ ./dist/spark-research doctor          → /$bunfs/root/opentrons_backend.py: No such file
$ ./dist/spark-research lit sources     → 正常（纯 TS，不读资产）
```
也就是说**二进制能列连接器，却建不了项目**——干不了任何实事。<br>**这是 v0.4「一条 npx 命令」交付的硬阻塞**，发 v0.4.0 前必须解决，或明确降级承诺（只发 npm 包、不发单二进制）。修法方向：Bun 的 embedded files、资产改静态 import、或运行期解包到可写目录。 <br><br>✅ **v0.5 W5-1 ε + 收口已做**：10 处资产（3 `schema.sql` 静态 import · 4 `.py` 内嵌文本+运行期解包再 spawn · 3 prompt `.txt`）+ 3 处危险默认路径。真二进制干净目录冒烟全过（`project new` / `lit search --add` / `doctor` / `exp run --platform pyref`，pyref 误差 3.8e-9）。收口另补最后一块：`capabilities --json` 在二进制里曾报「技能 0 个」（目录枚举，静态 import 覆盖不到）→ 逐份内嵌 SKILL.md，**实测 0 → 10**。 |
| V28 | 二进制产物没有冒烟测试 | W1-d 的测试全部跑在 `bun backend/src/index.ts` 上，**二进制是另一个运行时**，于是 V27 那类问题测不出来（版本号不一致是主会话手工跑二进制才发现的）。构建只要约 300ms，值得加一条 CI 冒烟：构建 → `--version` / `capabilities --json` / `doctor` 三条路径 → 断言版本号三处一致且不为 `0.0.0`。 |
| V29 | npm 打包字段未完成 | W1-d 原计划做 `package.json` 的 `files` / `engines` / `prepublishOnly`，但主会话在额度中断后把它的剩余范围收窄成「只补文档」，于是这部分**既没做完也没被静默丢掉**——W1-d 如实记进了 `docs/INSTALL.md` 的 TODO。`npx spark-research` 这条路径要真跑通需要补上。 |
| V30 | **删除论文这条路今天不可达，孤儿对账扫描也只被测试调用** | W4-b 按 E-6 交付了 `retractOrphanRecords()`（把指向已删论文的 record 标 `retracted`），但收口核查发现两件事：① `LibraryStore.remove()` **零生产调用方**——用户today根本删不掉论文，所以「删论文留孤儿」这个场景不可达；② `retractOrphanRecords()` 也只被测试引用。叙事门禁看不见它，因为孤儿检测是**文件粒度**而 `reading.ts` 整体有生产调用方（W3-c 标过的表达力上限）。**处置：将来加删除入口时必须同时接上这个对账扫描**；或把它做成一条维护命令让它可达。发布前不加新入口——那属于没有 lane 测试纪律兜底的仓促改动。 |
| V31 | 外部 MCP 工具的执行记录未进证据图 | W4-d 让每次外部工具调用都落一条记录（成功/失败/超时/未知工具四个分支都落，阴性对照钉死），但记录写在 `extensions/<name>/.mcp_calls.jsonl`，**没有进项目的证据图**（`project/**` 不在那条 lane 的所有权内）。所以「相对 OpenScience 的差异化点——外部工具调用天然进 provenance」**只兑现了一半**：审计记录有了，证据图还没接。接上之前不要在对外材料里宣称完整兑现。 |
| V32 | ToolBus 尚未换成 external tool runner | W4-d 提供了 `createExternalToolRunner()`（返回可直接赋给 `AgentToolBus.options.runner` 的实例），收口未接——接上后子代理才能真的调用外部 MCP 工具并自动享受同一套授权/预算/审计。与 V31 是同一件事的两半。 |
| V33 | **[已完成]** **二进制里 `workspaceRoot` 默认值解析到文件系统根 `/workspaces`** | v0.5 闸门 F-c 调查时发现，主会话已核实：`agents/orchestrator.ts:223` 的 `join(import.meta.dir, "../../../workspaces")` 在编译产物里等于 `join("/$bunfs/root", ...)` → **`/workspaces`**，紧接着 `mkdirSync(workspaceRoot, { recursive: true })`。**这不是 ENOENT，是往文件系统根目录写**——macOS 被权限挡住，Linux 上以 root 跑会真建。属 V27 家族但性质更重（其余是读不到文件，这条是写错地方）。修 V27 时必须一并处理。 <br><br>✅ **v0.5 W5-1 ε 已做**：`workspaceRoot` 改挂 `join(dataDir(), "workspaces")`；另两处危险路径在编译产物里改成显式拒绝。实机验证：跑 `server` 后 `<dataDir>/workspaces` 建出来了，`/workspaces` 不存在。 |
| V34 | **[已完成]** **`DEFAULT_SEARCH_SOURCES` 没跟上 W3-d 的 arxiv/pubmed 接通** | **零上下文外部验收（v0.5 闸门 F-1）实测发现，主会话已核实**：`literature/models.ts:16-21` 的默认源仍是 P2 时代的 `[openalex, crossref, europepmc, semanticscholar]`，**不含 arxiv / pubmed**。于是 `lit search --sources arxiv` 能用、`capabilities` 也报 arxiv 可用，但 `lit add <arxiv-id>` 走默认值查四个不含 arxiv 的源 → 报「未找到」。**能力做好了、默认值没跟着改。** AD-12 门禁抓不到这一类——它核「arxiv 在不在注册表」，核不了「默认值有没有包含它」。修默认值的同时应考虑给门禁加一条：**已实装的源必须在默认集里，或有显式排除理由**。 <br><br>✅ **v0.5 W5-1 ζ 已做**：默认集补上 arxiv/pubmed（现 6 个）。**重点是另一半**——新增 `tests/unit/literature_source_parity.test.ts`，**以连接器注册表为真源**（拿 `LITERATURE_SOURCES` 手写副本当真源等于自证自明），合法排除只认 `apiKeyRequired` 或 `placeholder`。门禁当场抓出两个没人想到的源（cnki/wanfang 在注册表里但不在联合类型里）。实机核验：`lit add 1706.03762` 不带 `--sources` 从「未找到」变成功入库。 |
| V35 | **[已完成]** **长任务在 CLI 层完全不可见** | 外部验收的**头号卡点**：`lit read --all` 8 分钟零输出，无进度、无 job id、断开后无法查状态——验收者只能杀掉进程再用 `lit list` 反推它其实在工作。**而 MCP 层有 `task_status` 机制、W4-c 还做了长任务落盘与 MCP 进度回传（V17）**——CLI 是唯一没接的入口。这是 CLI/MCP 的能力不对等，不是缺功能。 <br><br>✅ **v0.5 W5-1 ζ 已做**：接线不新建——`server/tasks.ts` 的能力全都有，CLI 是唯一没接的入口。新增 `backend/src/cli/progress.ts`；`lit read --all` / `lit review` 走任务句柄，新增 `lit tasks [<id>] [--json]` 读落盘快照，断开/重启后查得回状态。两个刻意决定：**默认不设超时**（为可见性引入新失败路径方向是反的）、`--json` 静音进度。 |
| V36 | **[已完成]** 失败消息不给下一步 | 外部验收：`idea new` 的契约校验失败与 `lit add` 的未找到，**都只说哪里错了、不说该试什么**，验收者靠猜绕过去。对照：`lab approve` 的 V19 拒绝消息就给了完整的下一步指引，是好样板。 <br><br>✅ **v0.5 W5-1 ζ + η 已做**：照 V19 质量写。ζ 侧的指引由本次实际发生的事推出来（标识符形态 → 该由哪个源解析 → 那个源在不在本次检索集），并把 `skipped` 再分「缺凭据」与「不认这个 id 形态」——两者处理动作不同，合成一句等于把判断推回用户。η 侧给 `idea new` 的契约校验失败补了下一步。 |
| V37 | **[已完成]** `auth` 与 `config list` / `doctor` 对同一把 key 报不同状态 | 外部验收：`sr auth` 把 `OPENROUTER_API_KEY` 报成未配置，而 `config list` / `doctor` 正确显示已配置。**三处读同一份配置却给出矛盾答案**——与 P11 收口修过的 `PROVIDER_API_KEY_ENV` 手工副本是同一类问题（真源没统一）。 <br><br>✅ **v0.5 W5-1 η + 收口已做**。真因比报告更具体：`index.ts:103` 有一份**手写的 `KEY_NAMES` 副本只列 2 个 provider**（实装 6 个），且 `auth()` 显示时**只读 config 文件、不看环境变量**。已改为从 `PROVIDER_API_KEY_ENV` 派生并标明来源，加了正则断言禁止手写表复发。**收口另修一处更深的**：`defaultProvider` 是个**只写不读**的设置（见 V40）。 |
| V38 | **[已完成]** BibTeX 导出把「Last F」形态的作者名解析错 | 外部验收发现，导致引用 key 生成错误。 <br><br>✅ **v0.5 W5-1 ζ 已做**：判据「最后一段只由 1~3 个大写字母组成才判为名缩写」——只认大写是关键，`Jan van der Berg` / `Xu Li` 不会被误伤。**顺带修好一处更隐蔽的**：`dedupe.ts` 的跨源姓氏比对也错位（openalex 侧 `jumper` vs europepmc 侧 `j`），因为它走同一个 `firstAuthorSurname`。 |
| V39 | **[已完成]** `lit review --help` 直接执行而不是显示帮助 | 外部验收发现。帮助不可用是上手性问题。 <br><br>✅ **v0.5 W5-1 ζ 已做**：9 条子命令级帮助，在 switch **之前**统一拦截（放进各 case 会漏掉新加的子命令）。ζ 写这条门时自己踩了一次同样的形状：第一版按 `flags.h` 判，但 `-h` 是单横线被 `parseFlags` 当位置参数收走，`lit export -h` 照样执行。 |
| V40 | **`defaultProvider` 是个只写不读的设置** | **v0.5 W5-1 收口发现并当场修掉**（登记在此是为了记住形状，不是待办）。`auth()` 让用户挑默认 provider 并落盘、`config set` 能设、`auth` 还回显它——**但没有任何代码用它来选 provider**，`getApiKey()` 只按声明顺序取第一个有 key 的。用户明明选了 kimi，只要 `OPENROUTER_API_KEY` 也在就走 openrouter，不留痕迹。**这是本项目第 7 次「建好了但没有生产调用方」，但前六次是孤儿模块、门禁抓得到，这次藏在配置项里**——门禁核「模块有没有调用方」，核不了「配置项有没有读者」。值得将来补一条门禁：可写入的配置项必须有读者。 |
| V41 | **MCP 工具描述的能力声称没有任何门禁** | v0.5 W5-1 γ 的第三条阴性对照发现：把 `chem_depict` 的 MCP 描述改成谎称支持 3D docking，**没有任何测试变红**。MCP 工具描述是**给外部 agent 看的能力声明**，它说谎的后果和 `capabilities --json` 说谎是一样的，但 AD-12 的机器可核只覆盖了后者。γ 如实记录而没有偷偷补上（不在其足迹内）。 |
| V42 | **local 算力目标的 `network` 是声明不是强制** | v0.5 W5-1 α 如实记下：`adapters/local.ts` 的 `capabilities().network` 声明 `"none"` 时，本地进程事实上仍能联网（没有 sandbox / netns）。**名实不符**。α 选择记下而不是假装隔离。真远端 target（Modal）不受此影响。 |
| V43 | **二进制里前端目录与脚手架仍不可用** | V27 的剩余项，ε 如实列出：① `server/app.ts:27` 前端目录在产物里解析到 `/frontend/workspace/dist`（只读且有 `existsSync` 门控，不会崩，但 `server` 起来没有 UI）；② `new skill|connector|platform` 与 `ext verify --kind platform` 在产物里已改成**显式拒绝**（而不是静默做错）——**`docs/INSTALL.md` 应明说这两条只在源码 checkout 可用**，ε 未改（不在足迹内）。 |
| V44 | `semanticscholar` 标 `apiKeyRequired` 却留在默认集里（已裁定保留） | ζ 提出的口径问题，**主会话裁定：保留**。理由是它与 aminer 的差别有实质——`literature.ts:748` 记着「P2 实测：匿名请求持续 429」，即无 key 时它走 **`skipped`（带配置指引、可见）**，不是静默空结果；把它移出默认集，有 key 的用户反而少一个源。登记在此是**为了让下一个人知道这个不对称是有意的**，不是漏改。 |

## 待定（等外部输入 / 用户拍板）—— 已并入 §post-v0.3

> D1/D3 的展开理由见 §post-v0.3；D2（Semantic Scholar key）已归口 v0.3 P16。

| # | 项 | 等什么 |
|---|-----|--------|
| D1 | 第三个仿真平台 adapter（材料计算 VASP/LAMMPS？EDA？） | 用户真实课题拉动；SimulationPlatform 契约已被两实现验证 |
| D2 | Semantic Scholar API key 接入 | 用户申请免费 key（connector 走凭据服务，id `semanticscholar`） |
| D3 | CNKI / 万方真实 API | 用户有无 API 渠道；AMiner 目前是中文文献主路径 |
