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
| V26 | connector 限速按 host 合池 | **2026-09-10 新登记**（来源：v0.5 connector 扩展调研）。现状：connector 层只有礼貌头（`politeness.ts`），**没有任何限速器**。pubmed 与 ncbi 已共享 NCBI eutils 的主机级预算，v0.5 计划新增的 ClinVar / GEO 也打同一主机——四个 connector 各自为政会集体被 429。限速器若做必须按 host 键控合池，不按 connector。去向：v0.5 集成 eutils 系新 connector 时同批做 <br><br>✅ **v0.5 W5-2 γ 已做**：`backend/src/http/ratelimit.ts` 令牌桶，**键控严格是 `new URL(url).host`**。`HOST_RATE_POLICIES` 只登记了 `eutils.ncbi.nlm.nih.gov`（3 rps / burst 3，查的 NCBI 官方文档）——因为本波只有它被多个 connector 共享（pubmed/ncbi/clinvar）；reactome / string-db 查不到有出处的 rps 数字，**没有编造**。阴性对照实跑：改成按 connector 键控 → 40 个并发落进一个窗口（上限 32），主会话独立复跑确认 3 条红。 |
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
| V31 | 外部 MCP 工具的执行记录未进证据图 | W4-d 让每次外部工具调用都落一条记录（成功/失败/超时/未知工具四个分支都落，阴性对照钉死），但记录写在 `extensions/<name>/.mcp_calls.jsonl`，**没有进项目的证据图**（`project/**` 不在那条 lane 的所有权内）。所以「相对 OpenScience 的差异化点——外部工具调用天然进 provenance」**只兑现了一半**：审计记录有了，证据图还没接。接上之前不要在对外材料里宣称完整兑现。 <br><br>⚠️ **v0.5 W5-2 δ 做了机制，但没有生产接线**（δ 主动交代）：`mcp_client.ts` 的 `recordSink` 可选字段落 `observation`（`kind:"external_tool_call"`, `evidence:"sourced"`），四个分支（成功/失败/超时/未知工具）都落；`contract.ts` 把它排除出证据图（**AD-10 的硬要求**——外部调用是审计不是进展，算进证据会让 `noProgress` 停止条件失效，P12 的 `agent_run` 事故就是这个形状，δ 为它建了具名回归用例）。**但生产里没有任何调用方传 `recordSink`**。主会话追查发现比这更彻底：`connectExternalMcp()` **整条生产路径零调用方**，只有 `ext verify` 在用——「agent 运行时连接外部 MCP 扩展」这条流程**在生产里根本不存在**。见 V45。 <br><br>✅ **v0.5 W5-3 γ 已关闭**（一条不对称要交代：留痕只覆盖「调用发生了」；「连接失败了」没有工具调用可留痕，只进执行日志不进证据图）。 |
| V32 | ToolBus 尚未换成 external tool runner | W4-d 提供了 `createExternalToolRunner()`（返回可直接赋给 `AgentToolBus.options.runner` 的实例），收口未接——接上后子代理才能真的调用外部 MCP 工具并自动享受同一套授权/预算/审计。与 V31 是同一件事的两半。 <br><br>⚠️ **同 V31，机制完成、生产未接线**：`orchestrator.ts` 的 `OrchestratorDeps.externalTools` 注入位已开，注入了就走 `createExternalToolRunner()`。但 `index.ts:339,388` 与 `server/context.ts:124` 三个构造点都没有传它。见 V45。 <br><br>✅ **v0.5 W5-3 γ + 收口已关闭**。γ 接通执行链路后**自己戳破**：`AgentToolBus.specs()` 是 `MCP_TOOLS.filter(...)`，`mcp:` 前缀名永远进不了模型可见的 tools 列表——**真实模型不会自己想到调一个它从没被告知存在的工具**。收口补上 `externalSpecs` 传递链（`ExternalToolRegistry.specs()` 从 W4-d 起带着「供收口拼进」的注释**等了两个波次**）。外部工具同样过 grants 白名单；不给 = 与接线前逐字节同行为。 |
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
| V45 | **「agent 运行时连接外部 MCP 扩展」这条流程在生产里不存在**（V31/V32 的真正缺口） | **v0.5 W5-2 收口追查发现，比 δ 报告的更彻底**：`connectExternalMcp()` 与 `discoverExternalMcpTools()` 的调用方只有 `ext verify` / `ext` CLI，**agent 运行路径上一个都没有**。所以 V31/V32 补的两个可选参数（`recordSink` / `externalTools`）没有生产调用方，不是「忘了传」，而是**没有那条流程可传**。<br>要建的是完整生命周期：发现已装的 `mcp_client` 扩展 → agent 开跑时连接（**子进程**）→ 注册进 `ExternalToolRegistry` → 绑定项目的 `recordSink` → 结束时收掉 → **坏扩展不许拖垮整轮**。接线点：`extensions/loader.ts` · `daemon/daemon.ts` · `server/context.ts:124` · `index.ts:339,388`。<br>**主会话判断：这不是收口活，是一条 lane**——在收口里手搓子进程生命周期正是工程纪律第 13 条警告的那类跨层改动。**排进 W5-3**。在它做完之前，对外**不许**宣称「外部工具调用天然进 provenance」。 <br><br>✅ **v0.5 W5-3 γ 已做**：六段生命周期（发现 → 连接 → 注册 → 绑定 recordSink → finally 收尾 → 逐扩展失败隔离），实现放 `loader.ts` 避免 `loader ⇄ mcp_client` 双向环（W4-d 被 TDZ 咬过一次）。惰性三层：没装 mcp_client 扩展的用户全部代价 = 敲 `chat` 时多一次 readdir。**追查中发现第二个「没人走的流程」**：`runResearchLoop()` 自己也零生产调用方，两条都接了。 |
| V46 | **Modal 凭据字段名曾在两条 lane 间对不上**（已修，登记形状） | v0.5 W5-2 收口实测发现：β 照设计文档 §1.1.7 在配置指引里写 `token_id`/`token_secret`，α 照 Modal SDK 的 `ModalClientParams`（核过 `.d.ts`）读 `tokenId`/`tokenSecret`。**后果是用户照提示填完，adapter 永远报「未配置」，还会去反复检查自己的 token。**已改成从 adapter 的 `MODAL_REQUIRED_CREDENTIAL_KEYS` 派生并加门禁。<br>**登记是为了记住形状**：这是 V34（默认源）/ V37（auth 口径）之后**第三次**「同一件事两份手写副本」，而且这次是**两条并行 lane 各写一份**——单条 lane 的门禁看不见对方。并行开发要额外防这一类。 |
| V47 | HTTP 面刻意没有 compute 的 dispatch / release 端点 | W5-2 β 的设计决定并写进 `/machine` 的 `httpWithheld`：MCP 是 HTTP 的投影，**没有 HTTP 路由 = 无论扣留表怎么写都没有路可走**，是 AD-14 的纵深防御。代价是 **Web 工作台点不了派发**——用户得回到 CLI。**主会话裁定 v0.5 保持现状**（算力刚落地、只有 local，保守方向是对的），但这是一处真实的 UI 断点，将来要加得重新论证（会同时给 MCP 开路）。 |
| S1 | **`lit add` 把一种 id 形态降级成另一种去撞库**（✅ 已修） | **W5-2 末零上下文外部验收的头号发现，主会话实机复现**：`lit add 9999.99999`（不存在的 arXiv id）导入了一篇 1978 年的《Intravenous nitroglycerin》，**报 ✅、退出码 0**。pubmed 的 eutils 把它宽容解析成 PMID 9999。**不是「没查到」被报成「查了没有」，而是「没查到」被报成「查到了，给你另一篇」**——垃圾论文落进证据图、`lit read` 花真钱生成精读卡、并列进 `report export` 的参考文献，而 `citation-integrity` 全部放行（它们确实在库内）。<br>真因是**第四次「同一件事两份手写副本」**：`search.ts` 写死三源白名单，而 `cli.ts` 早有正确的 `SHAPE_SOURCES` 能力表只用于文案。已改为单一真源 + 门禁 + 阴性对照。<br>**阴性对照暴露的更要紧的事**：拆掉修复后这次导入的是 bioRxiv 的论文——**每加一个源，杀伤面就扩大一圈**。所以门禁必须钉在通用判定上，不能逐源打补丁。 |
| S2 | **算力产出不进证据图** | 外部验收撞到主线最后一步走不通：`compute run` / `collect` 成功了，但 `report stats` 全零、`execution_records` 表空、收割的 `result.json` 只躺在 `jobs/<id>/harvest/` 没注册成 artifact。连锁后果：`conclusion` 的「结论引用的观察必须真实存在于执行记录」**对算力结果永远无法通过**——**现在无法基于一次算力运行写出任何一条能通过评审的结论**。<br>**这不是计划漏了**：设计 §1.1 本来就把它排给 **W5-3 α**（「一条 observation（`kind:"compute_output"`）+ harvest 文件各一条 artifact record」），验收撞到它是因为 W5-3 还没跑。README 已如实写明该限制。 <br><br>✅ **v0.5 W5-3 α 已做，主会话独立实证三件**：`observation|computed|compute_output`、`artifact|computed|compute_output_file`、两者间的 `derives_from` 边。写入点放 `broker` 不放 CLI——collect 有 CLI 与 HTTP 两个入口，写在任一入口另一条就会静默不落证据（V46 形状）。`runId=jobId` 作执行锚点是关键的另一半（`conclusion_rules` 的 `evidence_without_execution` 读它）。**验收者那句「无法基于一次算力运行写出任何一条能通过评审的结论」现在走通到 `✅ approved（0 hard / 0 soft）`。** |
| S10 | `report export` 的「附录 A · 证据索引」是空表 | 同一份报告下面就写着「论文 5 · 精读卡 5」，而证据索引表是空的——读者只会认为报告坏了。要么填，要么在空的时候说明「本表只索引结论引用的证据」。归 W5-3 δ。 <br><br>✅ **v0.5 W5-3 δ 已做**，而且**没有盲目填表**：先诊断出附录 A 的语义本来就是「只索引正文引用过的 record」——表空不是坏了，是标签没说清（改语义会破坏既有测试对「recordIds == 正文引用集合」的断言）。保住语义 + 补上范围说明 + 指向 `report records`。 |
| S11 | **没有任何 CLI 能看原始 record** | 验收者为回答「它到底进没进证据图」，试了 `report stats`（只有 9 个分类计数、不含 artifact）、`report export`（索引空，见 S10）、猜了 `records`/`record`/`graph` 三个命令名（都不是），**最后只能自己开 sqlite**。对一个把 `records.db` 当核心卖点的产品，这是个明显的洞。归 W5-3 δ。 <br><br>✅ **v0.5 W5-3 δ 已做**：`report records [--type] [--limit] [--json]` 与 `report show <id>`（含入边出边）。**刻意扩 `report` 而不是新建 `records` 命名空间**——一次消掉三处枢纽争用。主会话实证：输出与 `sqlite3` 直查逐条一致。 |
| S12 | 若干小的不一致 | `delivery` 状态与 `llms.txt` 描述不符（说只在 pending 时 collect，实际 none 也能且被提示这么做）· `rev` 编号跳变无解释 · local 任务收割完 `resource=active` 悬挂且从不提示 `release` · `chem depict` 人类输出不给文件路径（`--json` 里有 `path`）· `--gpu` 在 local 上的报错「（可选：无）」措辞怪且不给下一步。归 W5-3 δ。 <br><br>⚠️ **v0.5 W5-3 收口做了 4/5**：文档说谎（`mcp/tools.ts` 说 collect 只在 delivery=pending，实际 none/pending/failed 三种）· collect 不提示下一步导致 `resource=active` 悬挂 · `chem depict` 人类输出缺 path · `--gpu` 在 local 上的报错不给下一步。**第 5 条 `rev` 跳变没修**——δ 诊断到 CAS 每次写自增的机制，但明说「没有把握的修法」，只给了两个候选方向。见 V50。 |
| V48 | **local 算力的 handle 执行期间不落盘 → 设计里的 SIGKILL 验收路径今天走不通** | **v0.5 W5-3 α 如实交代（它修不了，不在足迹内）**：编排进程中途被杀 → `job.json.adapterHandle` 为 null → **既无法接回也无法收割**。原来那句「这个任务从未真正派发出去」**是假话**，且 `recoverable` 留 false 会让 `release` 删掉唯一一份产物——α 已把消息改诚实，但根治要动 `target.ts` / `adapters/local.ts`。**设计 §1.1.9 写的验收路径「SIGKILL → resume → 收割」在 local 上今天不成立**，对外不许宣称。 |
| V49 | **`deterministic=true` 的口径待裁定**（用户 2026-09-11 决定推迟） | W5-3 β 实测：scanpy / pydeseq2 / cobrapy 三个平台**同机重跑逐字节一致**（runner 把 n_jobs/n_cpus 钉成 1、固定种子、cobrapy 默认 pFBA），但**不保证跨机器 / 跨 BLAS / 换求解器**。staged 设计稿原写 `false`，β 按实测改成 `true` 并配了每次重测的门禁。<br>**问题是口径而非事实**：如果「跨机器可复现」才配叫 deterministic，这三个标签要一起翻，而 `pyref`（唯一既有的 `deterministic=true`）也要重新审。这个标签是**确定性层的输入**，标错等于让模型的结论绕过约束。<br>**β 的第 4 条阴性对照还挖出一件更深的**：「deterministic 标错」在加 `embedding.csv` 之前**根本红不起来**——拿掉 PCA 种子后 clusters/markers 一个字节都不变。**产出里没有对随机性敏感的数据时，这个标签在测试层面不可观测。** |
| V50 | `rev` 编号跳变无解释 | 外部验收 S12 的第 5 条。δ 诊断到根因是 CAS 每次写自增（`job_store.ts:170` + `broker.ts` 多个调用点），新 plan 出来就是 rev 2、run 完跳 5、collect 完跳 7。**δ 明说没有把握的修法**，只给了两个候选方向（对外只暴露单调计数 / 把内部写次数与用户可见 rev 分开）。属产品判断，留给下一版。 |
| V51 | 共享 helper 位置别扭 + 三处探测仍是内联形状 | W5-3 β 交代：`probeCodeFor`/`datasetParam` 放在 `simulation/scanpy/probe.ts`，另两个平台 `import ../scanpy/probe`——**本该在 `simulation/` 顶层，是文件所有权逼出来的形状**，搬走是纯移动。另：`doctor.ts` / `pyref` / `openmm` 的探测仍是内联字符串形状（**「探测说可用、真提交任务却坏」的老形状**，V27 时期咬过一次），β 已把修法验证可复用，但不在其授权内。 |
| R1 | **湿实验编译器改写试剂身份**（🔴 已修） | **发布前零上下文外部验收（干净机器、只有二进制）的头号 blocker，主会话实机复现**：写「硫酸」，编译产物是「**盐酸**」；写「硝酸」「甲醇」则被抹成 `reagent`。真因：`extractReagents()` 用 `name: r.keywords[0]`——**组内第一个关键词替换掉用户实际写的试剂名**。<br>**危害不是显示瑕疵，是落在物理世界路径上的身份改写**：人在 `lab approve` 读的是协议原文（硫酸）、批准的是编译产物的 hash（盐酸）——**他批的不是他读的那个东西**，AD-6 的署名审批失去意义；审计记录里会出现方案中根本不存在的化学品；拦截报告也跟着错。<br>已修：`name` 用**真正匹配上的那个关键词**，`reagentId` 仍是分类 id（规则匹配不受影响）。 |
| R2 | **`concentration_limit` 把「查不到规则」渲染成「✅ 通过」**（🔴 已修） | 同一次验收的第二个 blocker。`MAX_CONCENTRATION[id] ?? Infinity`——**表里没有条目的试剂阈值当无穷大，一律放行**。验收者一句话点破性质：**「『我查了，没有针对这个试剂的规则』和『我查了，通过了』在输出里是同一个符号」**——本项目红线「没查到 ≠ 查了没有」的镜像违反，且落在湿实验安全门上。<br>已修且**一个阈值都没有编造**：查不到限值 → 不放行，理由写「没有规则可查」而不是「超标」（两者该做的事不同）。另加一条与限值表无关的判断：**百分比 > 100 物理上不存在，一律拦**。<br>**顺带挖出更深的一层**：`extractConcentration()` 原来**把单位丢了**，`%` 与 `mol/L` 都只返回裸数字——**规则在比较自己不知道单位的数**。现已把单位带下来（见 V52）。<br>这条推翻了一条**有意为之**的旧断言（「表外试剂不设上限 → 放行，不凭空造标准」）：「不造标准」是对的、现在也没造，被推翻的是「所以放行」。 |
| R3 | **`chem depict` 在二进制里不可用，却四处声称可用**（🟠 已修） | 验收实测 `can't open file '/$bunfs/root/depict.py'`。**这是 V27 家族的遗漏**——W5-1 ε 修了 10 处资产，但 chem 是同一波 γ 并行交付的新文件，两条 lane 谁也没覆盖到对方；**收口（我）接了 `case "chem"` 却没给它的 `.py` 走内嵌机制**。后果比一般 ENOENT 更糟：`--help` / `capabilities` / MCP `tools/list` / `llms.txt` 四处都说它可用。已改用 `materializeAssetTree`，二进制实测出图。 |
| V52 | 浓度单位口径未统一（`MAX_CONCENTRATION` 的数到底是什么单位） | R2 挖出：解析器现已把单位带下来（`percent` / `molar` / `unknown`），但 `MAX_CONCENTRATION` 的三个数（hypochlorite 100 · ethanol 95 · strong_acid 200）**没有声明单位**——strong_acid 的 200 在百分比语境下无意义。当前只做了无歧义的一半（百分比 > 100 必拦）。**要真正修好，得先定义这张表的单位，可能还要按单位分表。**验收者另指出：次氯酸钠阈值 100% 意味着这条规则只拦物理上不可能的浓度——商用漂白水是 5–15%。**这属于要请领域判断的事，不该由实现者拍。** |
| V53 | `doctor` 的 `packagingLimitation` 机制对真实故障零覆盖 | 验收实测：`doctor --json` 三个档位 `packagingLimitation` **全是 false**，而唯一真实产生 `/$bunfs/` 报错的 `chem depict` **根本不在 doctor 的探测范围内**。INSTALL.md 描述过这个检测机制（识别 `/$bunfs/` 子串 → 打 ⚠️ 而非 ❌）——**字段存在，机制未生效**。R3 修完后这个具体故障消失了，但**机制本身仍未被任何真实故障验证过**。 |
| V54 | bioRxiv 的「不是真检索」免责声明人类看不到 | `capabilities --json` 的 `caveat` 里写得清清楚楚「search 是最近 N 篇 + 客户端打分模拟的，查不到 ≠ 不存在」，但 `lit sources` 与 `lit search` 两个**人类实际使用的入口**都只显示 ✅ / 「免 key」。验收者的对照很刺眼：缺凭据的源老老实实标 `⏭️ skipped` 并说明原因（本项目做得最好的地方之一），**而 bioRxiv 用一个 ✅ 掩盖了「这不是检索」**——同一个输出里诚实与不诚实并存。README 已补说明（v0.5 收口），但**两个 CLI 入口仍未显示 caveat**。附带：标题里的 `&amp;amp;` 未解码，会流进 BibTeX 与报告。 |
| V55 | 湿实验自然语言解析只吃中文 | 验收实测：英文协议编译不出任何步骤（直接报错，不静默产出空协议）。**试剂词表是双语的，但上游步骤解析器不是**，所以词表永远拿不到英文输入。README 已如实补上这条（原文只说词表覆盖中英文，读起来像整条链路都支持）。 |
| V56 | 未知命令不回显打错的那个词 · 报告不带 unconsumedWarnings · observation 表格压成一行 | 验收的三条低危：`spark-research frobnicate` 打印一屏帮助但**从不提及 `frobnicate`**（退出码正确）；`report export` 的湿实验条目**不携带 unconsumedWarnings**——README 说 CLI 编译与审批输出必须显示它，**报告是第三个面，目前是缺口**；`report export` 把 observation 的 markdown 表格压成一行。 |
| V57 | **一大片路径三次外部验收都没验过**（不是缺陷，是覆盖缺口） | **三次零上下文验收共同的空白**，如实记下来免得被误当成「验过了」：<br>· **所有 LLM 路径**：`idea new` / `idea check` / `lit read` / `lit review` / `chat` / `auth`——验收者按「花钱操作不自动批准」的纪律**主动不跑**（环境里有真实 key）。README 快速开始的第 ②③⑥ 步因此整段未验证。<br>· **`lab simulate` 与真 Opentrons 后端**：本机无 opentrons，湿实验链条只验到 `awaiting_approval`。<br>· **5 个仿真平台里的 4 个**（openmm / scanpy / pydeseq2 / cobrapy）：本机未装依赖，只验了 pyref。<br>· **Web 工作台**：前端产物未构建，未启动。<br>· **Modal 算力**：产品自述 gateway 未实现，未尝试。<br>· **`conclusion review` / `lab approve` 的署名审批实际写入**：未产生可评审的结论卡，未走到。<br>**处置建议**：下一版的验收任务书里，把「花钱路径」单独列出来并预先约定预算，否则它会**永远**停在未验证——三次都是同一个原因跳过的。 |
| V58 | **安全门语义刚改，而第三次验收跑在改之前** | v0.5 发布前收口把 `concentration_limit` 从「表外试剂放行」改成「不放行」，这是**行为变更**，可能误杀正常协议。改动只经过单测与几条手工命令，**没有人以用户视角重走一遍**。已补跑一次窄范围验收（只打安全门，误杀与漏放两个方向都看）。<br>**记下来的是教训不是待办**：**在验收之后改动被验收的东西，等于那次验收作废了一部分。**要么改动前置、要么补跑——不能默认「测试绿了就等于验过了」。 |
| V59 | 安全门的剩余缺口（窄范围验收，发布前**未修**，如实列出） | 发布前最后一次窄范围验收（只打安全门）在两条 blocker 修好之后又挖出这些，**v0.5 没修**：<br>· **限值表只覆盖 4 类试剂**（盐酸/硫酸 · 次氯酸钠 · 乙醇），且其中三类阈值就是 100 ——与「物理上不可能」那条完全重合，**所以 `100% 硫酸 → ✅` 只表示「没超物理极限」，不表示「在安全限值内」**。审批人看到这一行会被误导。<br>· **`biosafety` 只认字面 `BSL-n` / `生物安全N级`**：`P3 实验室`（最常见的中文口语写法）静默通过且零告警。<br>· **`chemical_compatibility` 不看孔位**：A1 的次氯酸钠 + B1 的盐酸也拦，消息没说「本规则不看孔位」。<br>· **旧的 `over-limit` 消息不合格**：英文残句、不说限值是多少、不说单位、不给下一步——同一条规则里新分支的消息质量比它高一个数量级。`volume capacity` / `chemical compatibility` 同样没有下一步。<br>· **`lab compile` 那一屏不打印覆盖范围声明**（`lab status` 有，写得很好）——**而绝大多数人是在 compile 那一屏看到四行 ✅ 的**。 |
| V60 | 词表外试剂的身份仍然丢失（只止住了塌缩） | v0.5 收口把占位符按步骤唯一化（`未识别试剂#step-1`），**止住了「两种不同试剂共用同一个 reservoir 孔」**这个真实的物理别名，并补了未消费告警。**但用户写的原文没有保留进编译产物**——人在审批时仍然看不到自己写的是「硝酸」。要真正修好得让编译产物携带原文片段，属解析器工作。 |

## 待定（等外部输入 / 用户拍板）—— 已并入 §post-v0.3

> D1/D3 的展开理由见 §post-v0.3；D2（Semantic Scholar key）已归口 v0.3 P16。

| # | 项 | 等什么 |
|---|-----|--------|
| D1 | 第三个仿真平台 adapter（材料计算 VASP/LAMMPS？EDA？） | 用户真实课题拉动；SimulationPlatform 契约已被两实现验证 |
| D2 | Semantic Scholar API key 接入 | 用户申请免费 key（connector 走凭据服务，id `semanticscholar`） |
| D3 | CNKI / 万方真实 API | 用户有无 API 渠道；AMiner 目前是中文文献主路径 |
