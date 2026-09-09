# Backlog

> 唯一登记处：范围外/待定项都记这里，不散落在 devlog。
> 分级：**P8-gate** = v0.2 发布前必须消化；**v0.3** = 下版本候选；**待定** = 等外部输入/用户拍板。
> 最后更新：2026-09-09（用户决策：仿真平台 #3 与 S2/CNKI 渠道均待定入册；P7 UI 参考 OpenScience）

## P8-gate（发布前验证清单）

| # | 项 | 来源 |
|---|-----|------|
| G1 | E2 结论卡 review 门槛：pending/approved/vetoed，仅 approved 进报告结论区 | DESIGN E2，P5 只落了最小 conclusion record |
| G2 | E1 数据-结论一致性检查器（结论引用的 observation 必须真实存在于执行记录） | DESIGN E1 |
| G3 | E1 统计合理性 soft 提示检查器 | DESIGN E1 |
| G4 | 能力位消费端：`deterministic`（区间 vs 逐位对账）与 `simulated`（模拟读数 0.0 不得当真实数据进结论）在 E1 检查器与 P8 报告中的消化 | P5/P6 验收批注 |
| G5 | 「真 key 假内容」（模式 B）在真实模型下的判准率测量 | P3 devlog 批注 |
| G6 | 删除 deprecated 的 `compute/providers.ts` 及其 v0.1 测试 | P5 验收批注 |
| G7 | 证据图 → Markdown 报告导出 + research-report 技能（§5.3 第 10 个技能） | PLAN P8 |

## v0.3 候选

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

## 待定（等外部输入 / 用户拍板，2026-09-09 用户确认入册）

| # | 项 | 等什么 |
|---|-----|--------|
| D1 | 第三个仿真平台 adapter（材料计算 VASP/LAMMPS？EDA？） | 用户真实课题拉动；SimulationPlatform 契约已被两实现验证 |
| D2 | Semantic Scholar API key 接入 | 用户申请免费 key（connector 走凭据服务，id `semanticscholar`） |
| D3 | CNKI / 万方真实 API | 用户有无 API 渠道；AMiner 目前是中文文献主路径 |
