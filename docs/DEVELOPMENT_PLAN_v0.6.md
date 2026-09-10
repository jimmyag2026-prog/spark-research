# Spark Research v0.6 开发与测试方案（定稿 v1）

> 定稿时间：2026-09-11 PDT · 基线：main @ v0.5.0
> **执行前提已满足（2026-09-11 验证）**：tag v0.5.0 = main HEAD（20a7232，PR #38）·
> `--version` 报 0.5.0 · 工作区干净 · 本地无残留分支。
> 附带发现：GitHub 上 v0.3.0 起只打 tag、未建 Release 对象（Releases 列表停在 v0.2.1）；
> 是否补建由用户定，不阻塞 v0.6。
> 位置纪律：本目录独立于仓库与 GitHub，不影响现有工作区；执行开始后第一个动作把本文
> 拷入仓库 `docs/DEVELOPMENT_PLAN_v0.6.md` 并走 PR。
> 执行方式：`/loop` 自适应节奏连续 10 小时自动推进（用户到时敲命令，见 §9）。

---

## 〇、一句话与已锁定决策

**v0.5 把链路建全并诚实标出所有断点；v0.6 让一个真实用户从浏览器进来能走完
「文献 → 写作」，并用多轮真实运行的记账数据把文献调研与写作质量磨到可信。**

| 决策项 | 内容 | 拍板时间 |
|---|---|---|
| B2 课题 | T1 蛋白结构预测（EN）· T2 单细胞聚类（EN）· T3 脑机接口信号解码（中）· T4 钙钛矿稳定性（中） | 2026-09-11 用户确认 |
| 每轮预算 | **$2**（LLM 实花，`maxCostUsd` 强制） | 同上 |
| 全程总预算 | **$6 硬顶**（10 小时内 LLM 实花；超顶停花钱路径，继续不花钱的开发） | 同上 |
| LLM 模型 | OpenRouter `z-ai/glm-5.3-flash`（实效价含 5.5% 平台费：输入 ~$0.0791/M · 输出 ~$0.2638/M） | 同上 |
| 检索主源 | AMiner（中文课题主路径；key 2026-10-07 到期，**本版不续期**，中文轮次一律排在到期前） | 同上 |
| PR 政策 | **授权自动 squash-merge**：测试全绿 + 自审通过即合；main 不直推不变；push 后必验远端 ref | 同上 |
| 版本纪律 | 全部改动在 **v0.6.x 线**迭代：W6-1 收口 → `v0.6.0-alpha.1`；B2 轮次修复 → alpha.2/3…；A5 验收过 → `v0.6.0`。每个 tag 必有 CHANGELOG 段 + devlog 记录 | 同上 |
| 进度汇报 | **不用 TG 推送**。① session 内每个唤醒点报一段进度；② GitHub 可审计：PR 按 `G-x:` / `W6-1 α:` / `B2-R1:` 前缀命名，用户随时二次核对 merged PR 列表与 CHANGELOG | 同上 |
| A3（3D 视图） | 条件触发：B2 轮次真产出结构数据才做（3Dmol.js 锁版本、产物不入 git），否则明确不做 | 同上 |

预算量级参考：单课题全链路（10 篇精读 + 综述 + 2 idea + novelty）估算 ~$0.3。
R1 两课题 ≈ $0.6，全量复跑 4 课题 ≈ $1.2，均在 $2 内。$2 闸的意义是**防失控循环**
（P12 `agent_run` 事故形状），不是省钱。

---

## 一、基线闸（第 0 步，不过不开工）

自动跑首个动作，只验不改：

1. `git fetch` 后确认 main 包含 tag `v0.5.0`，且 release/v0.5.0 的收尾提交已在 main 上
2. 源码起 server，`/api/health` 报 0.5.0（v0.2.1 事故的直接教训：tag 与 main 分家靠这条抓）
3. 工作区干净（无未提交改动残留）
4. `OPENROUTER_API_KEY` 在位 · `~/.spark-research/credentials.json` 在位 · `bun test` 全绿

**任一不满足 → 停止执行，在 session 里报告状态，等用户处置。不擅自收尾发布。**

通过后：本文拷入 `docs/DEVELOPMENT_PLAN_v0.6.md`，连同 4 份课题任务书（§5）走第一个 PR。

---

## 二、闸门 G（地基，串行完成后才开波次）

### G-1 · 模型配置化 + GLM 定价登记

开发：
1. `PROVIDER_MODELS.openrouter` 加 `z-ai/glm-5.3-flash`；`providers/registry` 的
   `priceFor` 登记**含 5.5% 平台费的实效价**，注释写明口径（否则账本永远低报）
2. `config set default-model` 落盘 + `LLMRouter.call()` 未显式传 model 时读它。
   **V40 现行犯教训**（`defaultProvider` 只写不读）：必须有真读者，并补门禁——
   **可写入的配置项必须有读者**（对配置 schema 逐项对账）
3. `lit read` / `lit review` / `idea` / `chat` 加 `--model` 覆盖项（V16 的用户可见一半；子代理分模型不做）

测试：
- 单测：set 后不传 model 走 openrouter 且 wire model 正确
- 阴性对照：拆掉读者 → 「配置项必须有读者」门禁立红
- 定价断言：`priceFor("z-ai/glm-5.3-flash")` 非 null（防将来改表静默丢价）

### G-2 · 发行面

开发：前端 dist 产物进二进制（V27 家族最后一块，V43①）；`package.json` 补
`files`/`engines`/`prepublishOnly`（V29）；`new skill|connector` 二进制内维持显式拒绝并写进 INSTALL.md（V43②）。

测试（V28 一并落）：CI 冒烟——构建二进制 → `--version` / `capabilities --json` / `doctor`
→ **`server` 起来 curl 首页 200 且为真 HTML** → 版本号三处一致。干净目录手工验一次 npx 路径。

### G-3 · 轮级预算闸（$2 强制执行）

开发：
1. **账本落盘**：`usage.jsonl`（`~/.spark-research/projects/<slug>/`），每次 LLM 调用追记
   `{ts, command, skill, model, calls, tokens, knownCostUsd, unknownCostCalls}`——
   一「轮」跨多条 CLI 命令，账必须跨进程累计
2. 批量命令（`lit read --all` / `lit review` / agent 循环）启动时读累计账，传
   `maxCostUsd` 进 `BudgetLedger`；超限**优雅停 + 可 resume，已完成的精读卡不丢**。
   判定沿用账本铁律：用 `knownCostUsd` 下界判超，未知成本示警不装死、绝不当 0
3. `usage` CLI：`spark-research usage [--json] [--since <ts>]`，分 skill 归因。
   **CLI 接线注意**：`usage` 命名空间的 dispatcher 独立成 `backend/src/cli/usage.ts`，
   `index.ts` 只加一个 case——给 W6-1 α 留挂载点，避免两条 lane 抢 `index.ts` 热点

测试：
- 跨进程持久性：两条命令先后跑，第二条读到累计
- 阴性对照：注入无单价模型 → `unknownCostCalls`+1、`costUsd` 报 null 不报 0
- 闸门实测：上限设 $0.001 跑 `lit read --all` → 优雅停 + resume 提示 + 已完成卡保留

### G-4 · AMiner 预检

真 key 跑一次 `getPaper` 详情接口（V9，search 已验通），结果码记入 devlog。
不续期（用户指令）；确立排期约束：**中文课题所有轮次压在 10-07 前**（本次 10 小时内天然满足）。

---

## 三、W6-1 · 三条并行 lane

文件所有权（v0.4 §5.1 铁律；`index.ts` 热点已在 G-3 拆解）：

| lane | 内容 | 独占文件/目录 | 不许碰 |
|---|---|---|---|
| α | connector 调用台账 | `connectors/base.ts` · `backend/src/usage/`（新）· `cli/usage.ts` 内追加 | `index.ts` · frontend |
| β | 工作台四面板 | `frontend/workspace/src/**` | backend 一切 |
| γ | CLI 上手性清扫 | `index.ts` · `literature/` 文案 · `report/export.ts` | `connectors/` · frontend |

### lane α · connector 调用台账（B1）

G-3 管钱，α 管 API 调用**次数与健康度**（AMiner 免费，但 429/401/延迟是 B2 每轮核心观测量）：
- `connectors/base.ts` 一处埋点、全体 connector 覆盖（不逐个改——V46「两份手写副本」教训）：
  `{ts, connector, host, status, latencyMs, rateLimitWaitMs}` 落 `api_calls.jsonl`
- `usage api` 子命令：分源/分 host 聚合，429/401 单列（V26 限速器实效由此可观测）
- 落账 URL **去查询参数**（凭据纪律）

测试：成功/429/超时三分支都落账；阴性对照：绕过 base 层直发 → 门禁红；
**台账文件内容过密钥正则门禁**。

### lane β · 工作台四面板（A2）

每面板三件套：实现 + `ui_cli_parity.test.ts` 断言 + Playwright 一条。

| 面板 | 对齐 CLI | Playwright 场景 |
|---|---|---|
| ① 长任务进度 | `lit tasks` | 起 read 任务 → UI 出进度 → 刷新后仍在 |
| ② record/证据图 | `report records` / `report show` | 点 record → 见入边出边 |
| ③ 算力只读 | `compute list/status` | job 可见；**断言派发按钮不存在**（V47 裁定） |
| ④ 用量 | `usage` / `usage api` | 跑命令后数字变化 |

纪律：④ 只消费 G-3/α 的 `--json` 出口，不自算（两处算同一数字 = V37 形状）。

### lane γ · CLI 上手性清扫（A4）

- V54：bioRxiv「不是真检索」caveat 进 `lit sources` / `lit search` + `&amp;` 解码
- V56 三条：未知命令回显打错的词 · 报告携带 unconsumedWarnings · observation 表格排版
- V50：rev 采「用户可见 rev 与内部写计数分离」方向，行为变更进 CHANGELOG
- V53：真实故障注入验证 `packagingLimitation` 机制真的能亮

每条带回归测试。

### W6-1 收口

三 lane 合入 → 全量测试绿 → 二进制冒烟 → **改动路径窄验收**（V58 教训制度化）
→ tag `v0.6.0-alpha.1` + CHANGELOG + devlog。

---

## 四、B2 · 多轮实证回环（版本核心）

### 每轮协议（固定脚本，逐轮可比）

```
0. 预检:  usage 归零快照 · doctor · AMiner 探活
1. 检索:  按任务书检索式 lit search（中文课题 --sources aminer 为主）
2. 入库:  lit add 前 10 篇 → paper-download 拉 PDF
3. 精读:  lit read --all（$2 闸在身，模型 z-ai/glm-5.3-flash）
4. 综述:  lit review（引用真伪核验开启）
5. 思路:  idea new ×2 → novelty check
6. 报告:  report export
7. 观察:  usage / usage api 快照 · report stats · 指标表（§6）填写
8. 登记:  发现清单 → BACKLOG（每条有去向：修 / 推迟 / 明确不做）
9. 修复:  本轮修复 + 回归 + 改动路径窄验收 → 才许开下一轮；修复合入后 tag alpha.N
```

### 轮次安排

| 轮 | 课题 | 执行者 | 定位 |
|---|---|---|---|
| R1（本次 10h 内） | T1 + T3 | **零上下文子代理**（主会话开发、验收者陌生——v0.5 三次验收验证过的最能挖问题的姿势） | 预期发现最多，修复窗口最长 |
| R2（后续 session） | T2 + T4 | 零上下文子代理 | 带 R1 修复跑；据 T1 是否产出结构数据裁定 A3 |
| R3（后续 session） | T1–T4 全量 | 主会话驱动 | 回归 + 定稿数据；原则上不混新修复，混了就加 R4 |

### 课题任务书（执行期第一个 PR 里各自成文；召回基准在开跑前独立预列并冻结）

| # | 课题 | 检索式要点 | 覆盖面 |
|---|---|---|---|
| T1 | 蛋白结构预测/设计近三年进展（AlphaFold 系） | EN：protein structure prediction / design, 2023-2026 | protein-analysis；产出结构 → 触发 A3 |
| T2 | 单细胞转录组聚类方法比较 | EN：single-cell RNA-seq clustering benchmark | scanpy 平台、干实验闭环 |
| T3 | 脑机接口信号解码 | 中：脑机接口 / 神经信号解码（AMiner 中文检索式） | V8 中文召回、AMiner 主路径 |
| T4 | 钙钛矿太阳能电池稳定性 | 中：钙钛矿 / 稳定性 / 封装 | AMiner + 中英混合去重 |

任务书固定格式：研究问题一句话 · 检索式 · **预列核心文献 5–8 篇（召回率判据基准，
用免费源独立编制、开跑前冻结，与轮次执行隔离）** · 预算 $2 · 成功判据。

---

## 五、指标表（每轮必填，趋势可比）

| 指标 | 测法 | 目标 |
|---|---|---|
| 每轮成本 | `usage` knownCostUsd + unknownCostCalls | ≤$2 且 unknown=0（>0 = 定价表有洞，当轮修） |
| 检索召回 | 命中任务书预列核心文献比例 | EN ≥80%；中文先拿基线数字（V8）再定修法 |
| API 健康 | `usage api` 429/401 率、限速等待 | 429 趋零（V26 实效验证） |
| 引用核验 | lit review hard/soft 数 + 人工抽验 5 条 | precision 维持 100%（P8-G5 基线） |
| 判定器 JSON 失败率 | `citation_judge_unavailable` 计数（V12） | GLM 上重测基线；>2% 则接 `response_format`（GLM 支持与否 R1 实测，不预设） |
| 精读卡质量 | 每轮抽 5 张，错误分型（漏读/幻觉/归因错） | 类型收敛；V13 口径用真实样本裁定 |
| novelty 判准 | 每轮新 claim 进标定集 | 三轮后 ≥20 claim（v0.5 规划欠账） |
| 报告可用性 | report export 人读一遍 | 无 S10/S12 类「读者以为坏了」断点 |

---

## 六、后续波次（本次 10h 之外，列出为完整版图）

- **W6-2**：R2 + A3 裁定与落地（若触发）
- **W6-3**：R3 全量复跑 + 指标汇总；附线债务：V41（MCP 描述能力声称门禁）·
  V48（local handle 落盘，SIGKILL→resume 成真）· V24/V21/V14/V3 逐条裁定吸收或明确不做
- **收口 A5**：零上下文外部验收，两点与前三次不同（V57 处置）——
  ① 入口以浏览器工作台为主（从 `npx spark-research server` 开始）；
  ② 花钱路径预授权 $2 按脚本执行不逐条请示。blocker 修完补窄验收才发 `v0.6.0`

### v0.6.0 DONE 定义（四条全满足）

- [ ] 干净机器 npx 起 server 即有可用工作台，四面板齐
- [ ] 三轮回环完成，指标表三轮可比、趋势向好或每条恶化有解释
- [ ] $2 闸被真实触发测试过，成本账 unknown=0
- [ ] 零上下文验收者经浏览器 + 花钱路径走通全链路（V57 清零）

### 明确不做（v0.6）

物理 Opentrons · 多用户身份 · SSH/Modal 真 gateway · skill/connector 铺量
（只集成 B2 点名的，每轮 ≤2–3 个）· compute Web 派发 · AMiner 续期（用户指令）·
子代理分模型配置 · 基因组浏览器。

---

## 七、10 小时自动运行操作规程

### 时间盒（预估，滚动调整；做不完按序砍尾，不全面减薄）

| 时段 | 内容 | 产出判据 |
|---|---|---|
| 0–0.5h | 基线闸（§1）+ 方案/任务书入库 PR | main 含 v0.5.0 且 health 对账 |
| 0.5–2.5h | 闸门 G-1/G-3/G-4/G-2 | 闸门测试全绿 + $0.001 触发实测 |
| 2.5–6h | W6-1 三 lane（各自 worktree：`~/Desktop/spark-research-<lane>`） | 各 lane 门禁 + 阴性对照绿 |
| 6–6.5h | W6-1 收口 → `v0.6.0-alpha.1` | 全量绿 + 冒烟 + 窄验收 |
| 6.5–9.5h | B2 R1（T1+T3，零上下文子代理，$2 闸）；余时修头部发现 | 两份轮次报告 + usage 快照 + BACKLOG 登记 |
| 9.5–10h | 收尾：wip 物化成分支推走（stash 不过夜）· 交接纪要 · session 内总结 | 干净可续跑状态 |

### 护栏（全程硬约束）

1. main 不直推；PR 全绿 + 自审后 squash-merge（用户 2026-09-11 授权）；**合并后立即删本地分支**
2. 每次 push 后验远端 ref（禁 `push -q; echo ok`）
3. LLM 实花**硬顶 $6**；超顶停花钱路径、继续不花钱的开发并在 session 里说明
4. 凭据不进日志/提交/prompt；α lane 密钥门禁兜底；commit 前新增文件过密钥 grep
5. 湿实验/compute 审批路径不碰（AD-9 TTY 要求自动跑天然守住）
6. 版本记录：每个 alpha tag 有 CHANGELOG 段；每波次 devlog；发现全部进 BACKLOG 有去向
7. 进度汇报：每个唤醒点 session 内报一段（做了什么 / 下一步 / 花费累计）；
   GitHub 侧 PR 前缀 `G-x:` / `W6-1 α:` / `B2-R1:` 供用户二次核对
8. 验收之后改动被验收的东西 → 必须补跑窄验收（V58）

### 子代理与模型分配（哪一步谁来干、用什么模型）

> 两层模型互不相干，别混：**产品侧 LLM**（spark-research 自己调的）全程
> `z-ai/glm-5.3-flash`，受 $2/$6 预算管；**agent 侧模型**（Claude 干活的）按下表分配，
> 消耗的是 Claude 额度。

| 步骤 | 执行者 | agent 模型 | 理由 |
|---|---|---|---|
| 基线闸 · 闸门 G | **主会话直接干**，不开子代理 | Fable（当前） | 串行地基活、碰热点文件（router/index.ts），拆给子代理反而要重建上下文 |
| W6-1 lane α/β/γ | 3 个并行子代理，各自 worktree | **sonnet** | v0.5 同类 lane 开发就是 sonnet 子代理，量级合适 |
| W6-1 合入评审 | **主会话**（单一合并权，纪律 14） | Fable | **别信 lane 自报数字**：合并前主会话独立复跑测试与阴性对照，不采信 lane 的「全绿」声明 |
| W6-1 收口（冒烟/窄验收/tag） | 主会话 | Fable | 跨 lane 判断 + 发版动作 |
| B2 R1 执行（T1+T3） | **零上下文子代理**（禁读源码，只给 MCP/CLI + llms.txt） | **sonnet** | 验收者必须陌生；产品侧照样走 glm，agent 模型不影响 $2 预算 |
| R1 指标汇总 / 发现分析 / BACKLOG 登记 | 主会话 | Fable | 判断密集，是这 10 小时真正的价值点 |
| 机械批量活（fixture 录制、日志扫描、任务书召回基准编制） | 单个子代理 | **haiku** | 纯执行，省额度 |

补充纪律：子代理产出一律**主会话验证后才算数**（复跑测试 / 抽查文件 / 核对远端 ref）；
子代理不授予 merge 权限，PR 合并只在主会话发生。

### Claude 额度不足的恢复协议

额度耗尽的表现通常是子代理 spawn 失败或调用报配额错误。处置固定为：

1. **先落地再等待**：把当前状态物化（未合并改动 → wip 分支推走、进度写进
   `~/Desktop/AI4S/spark-research-v0.6-plan/RUN_LOG.md`），确保任何中断点都可续跑
2. **降档重试**（按序）：并行 3 lane → 串行单 lane；sonnet 子代理 → 主会话自己干
   → 机械部分换 haiku。**产品侧 glm 调用不受 Claude 额度影响**，B2 轮次若已在跑就让它跑完
3. **定期重试**：额度全堵时不空转刷 token——用唤醒机制隔 **20–30 分钟**探一次
   （spawn 一个最小 haiku 任务作探针），恢复即从 RUN_LOG 断点继续；每次尝试在 session 里记一行
4. **时间口径**：额度阻塞时间计入 10 小时墙钟。若到点仍堵，在第一个恢复的唤醒点
   只做收尾（wip 物化 + 交接纪要）即停止，不续新活

### 启动命令（用户确认 v0.5 发布后，在 session 里敲）

```
/loop 按 ~/Desktop/AI4S/spark-research-v0.6-plan/PLAN_v0.6.md 自动推进 v0.6：先过基线闸（main=v0.5.0、health 对账、工作区干净，不满足即停并报告），然后闸门G → W6-1三lane → 收口打v0.6.0-alpha.1 → B2第1轮（T1+T3，零上下文子代理，每轮$2闸）。护栏照方案§7：PR全绿自审后squash-merge、LLM总花费硬顶$6、凭据不入日志、每个唤醒点session内报进度。子代理与模型按§7分配表（lane开发sonnet、机械活haiku、评审合并主会话），Claude额度不足按§7恢复协议：先物化状态到RUN_LOG.md，降档重试，20–30分钟探针唤醒，恢复即续跑。连续干10小时，到点或目标完成即物化wip分支、写交接纪要并停止。
```
