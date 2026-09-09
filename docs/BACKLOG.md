# Backlog

> 唯一登记处：范围外/待定项都记这里，不散落在 devlog。
> 分级：**P8-gate** = v0.2 发布前必须消化；**v0.3** = 下版本候选；**待定** = 等外部输入/用户拍板。
> 最后更新：2026-09-09（P8 收口：G1-G7 全部消化，见 devlog/P8-wrapup.md；新增 v0.3 候选 V12/V13）

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

## v0.3 候选

| # | 项 | 备注 |
|---|-----|------|
| V14 | 位置加权豁免改白名单制 | P3 D3 说「第二个例外再重构」；P8 三条新 rule 一起成了例外，阈值已到。当前靠调用路径隔离，能工作但不显式 |

| # | 项 | 备注 |
|---|-----|------|
| V1 | arXiv/PubMed 接入统一检索 | 缺 XML parser，目前统一检索只有 4 个 JSON 源 |
| V2 | novelty 相似度语义化（embedding provider 决策 + 集成） | 词面 0.75 阈值余量 0.08；与 G5 一起看 |
| V3 | poll 的进程 start-time 交叉核验 | 现状「done.json 优先」方向安全，只会多报 running |
| V4 | 远端算力真实实现（Docker/SSH/Modal/火山引擎） | DESIGN 明示按需求拉动 |
| V5 | R kernel | v0.1 遗留 permit set 已有位置 |
| V6 | 物理 Opentrons / 真实设备对接 | 需真实硬件。施工说明：同设备族=新 WetLabBackend 即插即用；**非 Opentrons 设备族**需把「结构化步骤→设备语言」编译下沉进 backend（P6 验收核对：当前 execute() 入参为 OpentronsProgram），等第二设备族选定再动（AD-4 教训：两个真实实现验证接口） |
| V7 | Agent Swarm（v0.1 遗留）接入新架构 | 与子代理独立模型配置一起评估 |
| V8 | 中文检索式召回优化 | P4 实测中文检索式召回极差 |
| V10 | HTTP 层真实身份（多用户场景） | P7 现状：approve 的 actor 是「谁自称就是谁」（actorSource=`http:explicit`）。单用户本地诚实；**做多用户前必须换成真实身份认证**，否则审批审计不成立 |
| V11 | 长任务句柄落盘 | P7 现状：`server/tasks.ts` 的任务列表在进程重启后丢失（磁盘上的实验状态仍在，`exp run --resume` 可接回）。若要 UI 跨重启看到「正在跑的任务」需落盘 |
| V9 | AMiner `getPaper` 详情接口带真实 key 验证 | search 已真实验通（HTTP 200） |
| V12 | LLM 结构化输出（`response_format` / JSON mode） | P8-G5 实测：kimi-k2.6 每轮有 2–6% 的判定只吐思维链、`content` 里没有 JSON（`finish_reason` 不是 `length`，不是截断）。已加「解析失败重试一次」但治标不治本。根治要么让 LLMRouter 支持 `response_format: json_object`，要么给判定器配一个支持结构化输出的模型。现状是安全的（降级为可见的 `citation_judge_unavailable` soft finding，不假装通过），代价是这部分引用本轮没被检查 |
| V13 | 判定 prompt 对「凭空归因」的口径 | P8-G5 实测：难档唯一稳定的漏报模式是「草稿给出卡片里没有的归因解释」。prompt 写的是「声称了卡片里明确没有的结果 = conflict」，模型读成「卡片没覆盖 → unclear」。两种读法都讲得通，是 prompt 的歧义而非模型的错。改口径前要先想清楚：收紧会不会把合法的概括也扫进来（那正是 P3 刻意避免的误报） |

## 待定（等外部输入 / 用户拍板，2026-09-09 用户确认入册）

| # | 项 | 等什么 |
|---|-----|--------|
| D1 | 第三个仿真平台 adapter（材料计算 VASP/LAMMPS？EDA？） | 用户真实课题拉动；SimulationPlatform 契约已被两实现验证 |
| D2 | Semantic Scholar API key 接入 | 用户申请免费 key（connector 走凭据服务，id `semanticscholar`） |
| D3 | CNKI / 万方真实 API | 用户有无 API 渠道；AMiner 目前是中文文献主路径 |
