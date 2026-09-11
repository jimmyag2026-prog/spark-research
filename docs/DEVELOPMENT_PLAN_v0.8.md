# Spark Research v0.8 开发与测试方案（定稿 v1）

> 定稿时间：2026-09-11 PDT · 基线：main @ v0.7.0（`f23c19b`，PR #80；Release 双平台二进制已挂）
> **执行方式：用户以 `/loop` 自适应节奏连续自动推进**（v0.6 同款），每个唤醒点报一段进度；主会话拥有单一合并权。
> 用户 2026-09-11 拍板：**v0.8 = 下一个大版本；当前发现的、能动手的 backlog 全部放进来；不碰物理设备、不碰售卖。**
> 上游文档：`docs/DEVELOPMENT_PLAN_v0.7.md`（§七·补 执行编排沿用）· `docs/DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md` · `docs/reviews/v0.6.0_external_review.md` · `docs/BACKLOG.md`

---

## 〇、一句话与已锁定决策

**v0.7 把数据留下了；v0.8 把钱和权限的硬伤补上、把三轮验收和外部 review 挖出来的 27 条待办清完、把 v0.5 起顺延两次的 runtime contract + Python SDK 做出来——发出去的是一个没有已知安全/预算漏洞、外部 agent 能直接集成的版本。**

| 决策项 | 内容 | 拍板 |
|---|---|---|
| 版本定位 | 大版本；范围 = 全部可动手的 BACKLOG 真待办（27 条）+ SDK/contract（路线图顺延项）+ V2 embedding 语义化 | 2026-09-11 用户 |
| 明确不做 | **物理 Opentrons 与任何真实设备路径**（V6 / V52 领域判断 / V59 残余的硬件半边）· **售卖通道、计费、许可文本**（接口形状已在 v0.7 留好）· 3D 查看器 · 多用户身份（V10）· Modal 真网关（V4，除非 token 到）· skill/connector 铺量（V76 只按 R5 点名 ≤2–3 个）· R kernel（V5）· CNKI/万方（D3）· 材料平台（D1） | 同上 |
| V95（HTTP 审批旁路） | **做软件半边**：HTTP `lab approve/simulate` 与 CLI 同一套署名 + 确认令牌门，不再是旁路；**不接设备** | 本方案裁定 |
| V2（embedding） | 用**已配置 provider 的 embedding 端点**（OpenAI 兼容 `/embeddings`，OpenRouter/OpenAI/DeepSeek 任一有 key 即可）；没有 key 保留词面法为降级路径、双留痕（AD-8）；不引入 Ollama 依赖 | 本方案裁定（v0.5 设计稿的收窄版） |
| 实证回环 | **R5**：四课题（有礼貌池的 OpenAlex）全量复跑一次，出 T1–T4 召回数；**A7** 第六次零上下文验收（浏览器 + 花钱 + 导出 + SDK 一把） | 本方案提议 |
| 每轮预算 | $2/课题；产品侧模型沿用 glm-5.3-flash；R5 至少一课题用第二 provider 跑判定器（V12 关闭前提） | 沿用 |
| PR / 版本纪律 | 授权自动 squash-merge（六套件全绿 + 自审）；main 不直推；push 后验远端 ref；**冒烟不进管道**（`> log; test $? -eq 0`）；每波一个 alpha tag，每个 tag 必有 CHANGELOG 段；**打正式 tag 前先 `gh release create`**（v0.7.0 事故） | 沿用 + 两条新纪律 |
| 编号纪律 | 登记新 BACKLOG 条目前 `git grep -h "^| V" $(git branch -r) docs/BACKLOG.md` 取远端所有分支最大号（v0.7 撞号事故） | 新 |

---

## 一、基线闸（第 0 步，不过不开工）

| # | 检查 | 判据 |
|---|---|---|
| 0-1 | 六套件在 v0.7.0 上全绿并记数 | unit ≥ 2271 · e2e 20 · concurrency+timeout 31 · py 73 · lab 26；写进首个 PR 描述作为「只增不减」基线 |
| 0-2 | 二进制冒烟 exit 0；Release v0.7.0 双 assets 在 | — |
| 0-3 | 每个新 worktree：链 `.venv` + `bun install` + 实跑 `test:py` 看 skip 数 | 0 skip |
| 0-4 | `tests/preload.ts` 隔离生效：`test_isolation` 绿；跑完一轮 unit 后 `~/.spark-research/raw` 不存在或零新增 | V83 不复发 |
| 0-5 | `contactEmail` 已配置（`config list`）；AMiner key 有效期 ≥ R5 中文轮次计划日（10-07 到期） | 否则先排中文轮次 |
| 0-6 | BACKLOG 归账：R1/R3/S12/V57 补 ✅（实际早已处置）；V83 标归档已做；去向总表加 v0.8 行 | 本方案 PR 已做 |

---

## 二、闸门 G（地基，主会话串行；每条独立 PR，合完 → `v0.8.0-alpha.1`）

安全与钱的硬伤先清——它们改的是所有 lane 都会碰的公共层，串行做完再开波次。

| # | 条目 | 交付 | 门禁 / 阴性对照 |
|---|---|---|---|
| G-1 | **V100** compute uploads 的 `workspaceRoot` 接受任意绝对路径 | 只接受 `dataDir()`/项目目录下的相对路径；绝对路径与 `..` 一律拒绝并给可读错误；限额检查移到读盘之前 | 单测：`/etc` / `../../` 被拒；阴性对照去掉校验 → 红 |
| G-2 | **V101** extensions `--trust` 指纹只覆盖入口单文件 | 指纹 = 扩展目录清单哈希（文件相对路径 + 内容 sha256，排序后再 hash）；旧单文件指纹视为过期要求重新 trust | 单测：改 helper 文件 → 指纹变；阴性对照回单文件 → 红 |
| G-3 | **V93** 预算闸 TOCTOU | `BudgetLedger` 引入**在飞预留**：调用前按模型上限价预留（`reserve`），返回后按实际结算（`settle`）；`Promise.all` 下 N 个在飞合计不越闸 | `tests/concurrency/budget_inflight.test.ts`：10 并发、闸 $0.1、每次 $0.03 → 最多 3 个放行；阴性对照去掉预留 → 红 |
| G-4 | **V94** 无价模型让预算闸静默失效 | 单价表缺条目 → 调用**不放行**（不是 unknown 放行）；`--allow-unpriced` 显式放行并在 usage 标 `unpriced`；anthropic 单价表补齐（查官方价，写出处与日期） | 单测：无价模型默认拒 + 显式放行两条；阴性对照 → 红 |
| G-5 | **V96** state.json 非原子写 | `writeState` 改 temp + rename（同目录、同 fs）；与 C-1 的锁同一临界区 | 单测：kill 模拟（写一半的 tmp 不影响主文件）；阴性对照回裸 writeFileSync → 检测 |
| G-6 | **V21** 删旧超时 env 名（v0.7 承诺） | 旧名读到即报错并指新名；docs/INSTALL 同步 | 单测 |

---

## 三、W8-1 · 六条并行 lane（sonnet 子代理，各自 worktree；合完 → `alpha.2`）

| lane | 条目 | 交付要点 | 足迹（所有者） | 禁止 |
|---|---|---|---|---|
| **α 检索收口** | V67 · V86 · V87 · V73 | 有礼貌池后 T1–T4 真实召回@10（冻结基准）写进 devlog；`--rank` 默认档按数据定；`lit review` 输出「解析 N / 判定 M / 差额去向（去重 x · 自引 y · 解析失败 z）」；AMiner 401 台账观察一次性写结论 | `literature/search.ts` · `literature/cli.ts`（review 输出段）· `reviewer/citation_judge.ts` · `connectors/aminer.ts` | `index.ts` · `reviewer/rules.ts` |
| **β 数据层补全** | V85 · V78 · V63 · V97 · V99 · V98 | 仿真 prepare/submit/collect 落 raw `kind=simulation`（raw 契约加一类，导出/导入/验证同步）；`subAgentLlm()` 经 `usageTrackingLlm`（sessionId 透传）；`ratelimit.ts` 返回等待毫秒、api_calls 真记；usage `model` 字段校验（对象拒写）；LLM 台账写盘失败不抛掉产出（与 api_ledger 同口径）+ auth/rate_limit 计费口径统一；精读卡 `basis/basisReason` 回读进 `cardFromRecord`，综述 prompt 与 judge 能拿到材料级别 | `raw/*` · `simulation/*` · `agents/orchestrator.ts`（subAgentLlm）· `http/ratelimit.ts` · `usage/*` · `literature/reading.ts`（cardFromRecord）· `data/*`（simulation 类导出） | `index.ts` · `literature/cli.ts` · `project/*` |
| **γ 体验** | V88 · V89 · V90 · V79 | 精读任务 progress 每篇回传（查 runCliTask 批处理）；co-explore 一次两张卡：要么去重要么 UI 说明「主/备假设」；项目下拉框显示 slug；A5 三条低危（综述引用 span 跳证据图 · conclusion review 前置提示 · UI 预算参数入口） | 前端组件 · `server/routes/*`（只透传）· `cli/progress.ts` · `ideation/coexplore.ts`（去重逻辑） | `index.ts` · `literature/*` · `project/*` |
| **δ 文献核验** | V92 · V13 · V14 · V51 | `CITATION_TOKEN` 字符集含汉字 + 两道核验门对中文 key 生效（阴性对照：中文 key 伪造引用必被抓）；V13 用 R1–R4 真实样本裁定口径并改 prompt 或明确关闭；位置加权豁免改白名单制；`probeCodeFor` 等 helper 挪到 `simulation/` 顶层，三处内联探测收成一处 | `reviewer/rules.ts` · `reviewer/citation_judge.ts` · `reviewer/agent.ts` · `agents/prompt/*` · `simulation/probe.ts`（新）· `doctor/*`（探测复用） | `index.ts` · `literature/cli.ts` · `raw/*` |
| **ε 湿实验软件半边** | V95 · V55 · V59 残余 | HTTP `lab approve/simulate` 与 CLI 同一门：显式 `actor` + 一次性确认令牌（服务端签发、单次、短时），无令牌拒绝——**不接设备**；英文协议解析（步骤解析器双语化，词表本就双语）；V59 五条里的四条软件项：限值表覆盖声明打印在 `lab compile` 那一屏、`biosafety` 认 `P3 实验室`、`chemical_compatibility` 消息说明不看孔位、`over-limit` 消息给限值/单位/下一步 | `lab/protocol.ts` · `lab/safety.ts`（消息与词表，不改规则语义）· `lab/cli.ts` · `server/routes/lab.ts` · `lab/approval_token.ts`（新）· 前端审批弹窗（令牌） | `lab/wet_loop.ts` 状态机语义 · `index.ts` |
| **ζ V2 embedding 语义化** | V2 | `llm/embeddings.ts`：OpenAI 兼容 `/embeddings` 适配（用已配置 provider key；OpenRouter/OpenAI/DeepSeek 择一），`novelty` 的 `claimAffinity()` 改成「embedding 余弦 → 词面法降级」双留痕（结果 metadata 记 `affinityBasis: embedding\|lexical`），阈值用 68 样本 fixture 重标（`novelty_threshold.test.ts` 同款方法）；无 key 行为与 v0.7 逐字节一致 | `llm/embeddings.ts`（新）· `llm/providers/*`（embedding 能力位）· `ideation/novelty.ts`（affinity 一处）· `tests/fixtures/novelty/*` | `index.ts` · `usage/*`（embedding 花费经既有 usageTrackingLlm 包装，不另起台账） |

共同纪律沿用 v0.7 `_COMMON.md`（一 lane 一 worktree · 足迹互斥 · 六套件 + 阴性对照真跑 · 并行超时用例单独重跑 · 不合 main）。

**W8-1 收口**（主会话）：合入评审不采信自报数字；CHANGELOG/BACKLOG 归账；V102 外部 review 杂项**逐条拆分**成独立编号或明确不做；`alpha.2`。

---

## 四、W8-2 · runtime contract + Python SDK（主会话 + 1 lane；合完 → `alpha.3`）

v0.5 起顺延两次的对外集成面。**口径：SDK 是 HTTP/MCP 的薄投影（AD-7），不新增能力；contract 是 `capabilities --json` 的可版本化子集。**

| 项 | 交付 | 门禁 |
|---|---|---|
| runtime contract | `spark-research contract --json`：版本号、CLI 命令与旗标（从 `index.ts` switch 与各 HELP 结构化提取，不手写）、HTTP 路由与请求/响应 schema（从 Hono 路由与 `server/types.ts` 生成）、MCP 工具、数据导出 manifest schema、配置项；`contract.json` 随 Release 挂 assets | **门禁**：contract 与真源对撞——CLI case 集合、MCP_TOOLS、CONFIG_SETTINGS、manifest 类型逐项相等（AD-12 第 10 条）；阴性对照：删一条 case → 红 |
| Python SDK（`sdk/python/spark_research/`） | 薄客户端：`Client(base_url)`，方法一一映射 HTTP 路由（从 contract 生成，不手写）；长任务句柄轮询；`data export/verify/import` 封装；类型提示；`pytest` 契约测试对着 fixture server 跑 | `tests/sdk/`：每个 HTTP 路由至少一条往返；contract 变 → SDK 生成物变（幂等门禁，同 llms.txt 形状） |
| 文档 | `docs/SDK.md` + `readme_for_agent.md` 补「用 SDK 而不是拼 curl」；`llms.txt` 同步 | G8 叙事一致 |

---

## 五、B3 · 实证回环与验收（→ `alpha.4` → `v0.8.0`）

- **R5**（零上下文子代理）：四课题按 v0.6 每轮协议 + v0.7 数据层两步 + **SDK 走一遍全链路**（用 Python 客户端而不是 CLI 跑 T2）；至少一课题判定器用第二 provider（V12 关闭前提）。指标表与 R1–R4 同列。
- **R5 修复窗口**（主会话）：P0/P1 修，窄验收；`alpha.5`（如有）。
- **A7**（零上下文，另一个 agent）：浏览器入口 + 花钱 $2 + 导出两步 + **SDK 安装即用** + HTTP 审批令牌门（无令牌必拒）+ 并发预算闸（并发 10 个花钱调用不越闸）。
- 收口：CHANGELOG 发布段（亮点 / 如实交代 / 数字 / 安装）· BACKLOG 全表归账 · **先 `gh release create` 再打 tag** · 冒烟 exit 0。

---

## 六、lane 足迹总表（一文件一主）

| 文件/目录 | 所有者 |
|---|---|
| `backend/src/index.ts` · `docs/` · `README*` · `llms*.txt` · `CHANGELOG.md` · `BACKLOG.md` | 收口（主会话） |
| `compute/uploads*` · `extensions/fingerprint.ts`/`verify.ts` · `llm/budget.ts` · `usage/ledger.ts`（G-3/G-4 部分）· `project/manager.ts`（G-5）· `config/index.ts`（G-6） | 闸门 G（主会话，串行，先于 lane） |
| `literature/search.ts` · `literature/cli.ts`（review 输出段）· `reviewer/citation_judge.ts` · `connectors/aminer.ts` | α |
| `raw/*` · `simulation/*`（除 probe）· `agents/orchestrator.ts`（subAgentLlm）· `http/ratelimit.ts` · `usage/*`（G 合并后）· `literature/reading.ts`（cardFromRecord）· `data/*` | β |
| 前端组件 · `server/routes/*`（透传）· `cli/progress.ts` · `ideation/coexplore.ts` | γ |
| `reviewer/rules.ts` · `reviewer/agent.ts` · `agents/prompt/*` · `simulation/probe.ts`（新）· `doctor/*` | δ |
| `lab/protocol.ts` · `lab/safety.ts` · `lab/cli.ts` · `server/routes/lab.ts` · `lab/approval_token.ts`（新）· 前端审批弹窗 | ε |
| `llm/embeddings.ts`（新）· `llm/providers/*` · `ideation/novelty.ts` · `tests/fixtures/novelty/*` | ζ |
| `sdk/python/*` · `backend/src/contract/*`（新）· `tests/sdk/*` | W8-2 |

冲突点与处置：`usage/ledger.ts` 先由 G-3/G-4 改完并合入，β 再基于 alpha.1 开；`literature/reading.ts` 只有 β 碰；前端审批弹窗只有 ε 碰（γ 不碰审批相关组件）；`server/routes/lab.ts` 归 ε，其余 routes 归 γ 且只透传。

---

## 七、执行编排（沿用 v0.7 §七·补，只列差异）

| 步骤 | 执行者 | 模型 |
|---|---|---|
| 基线闸 · 闸门 G 六条 · 各波收口 · W8-2 contract 生成器 | 主会话 | Fable |
| W8-1 六条 lane · W8-2 SDK lane | 并行 sonnet 子代理，各自 worktree | sonnet |
| R5 · A7 | 零上下文子代理（各一个，不同） | sonnet |
| 机械活（fixture 录制、召回基准核对） | 单个子代理 | haiku |

硬纪律新增三条：冒烟不进管道（`> log; test $? -eq 0`）· 登记新条目前取远端所有分支最大 V 号 · 正式 tag 前先 `gh release create`。其余（worktree / `.venv` 实跑看 skip / 足迹 / 阴性对照 / 不采信自报数字 / wip 落盘）不变。

### 时间盒（/loop 自适应，做不完按序砍尾，不全面减薄）

| 段 | 内容 | 预估 |
|---|---|---|
| 一 | 基线闸 → 闸门 G（6 条独立 PR）→ alpha.1 → 六 lane 并行 → 合入 → alpha.2 | ~7h |
| 二 | W8-2 contract + SDK → alpha.3 → R5 → 修复窗口 → A7 → v0.8.0 | ~6h |

砍尾顺序：ζ（embedding）→ γ 的 V79 → δ 的 V14/V51 → W8-2 的 SDK 文档层。**闸门 G 与 α/β/ε 不砍**——安全、钱、数据一致性、审批旁路是这一版的底线。

### 护栏（全程硬约束）

- 每个 PR 六套件全绿 + 二进制冒烟 exit 0；数字只增不减
- 每条门禁至少一条阴性对照实跑并记 devlog
- 花钱路径：R5/A7 每课题 `--budget-usd 2`，全程 ≤ $12；unknown/unpriced 计数必须为 0（G-4 之后 unpriced 只在显式放行时出现）
- 凭据不进 repo/日志/报告；commit 前密钥 grep
- 额度/网络中断：lane 先落 wip（标「未经任何验证」）推远端；恢复后 SendMessage 复活同一 agent；主会话唤醒点先 `git status` 全部 worktree
- 任何「验收之后改动被验收的东西」→ 窄验收补跑（V58）

### 启动命令（用户在 session 里敲）

```
/loop 按 docs/DEVELOPMENT_PLAN_v0.8.md 执行 v0.8：从基线闸开始，闸门 G 六条串行做完打 alpha.1，
然后六条 lane 并行、W8-2、R5、A7，直到 v0.8.0 tag。每个唤醒点报一段进度；遇额度中断落 wip 并等待；
中间成果全部落盘（tag/devlog/PR），不需要我确认，做不完按方案砍尾顺序砍。
```

---

## 八、v0.8.0 DONE 定义（六条全满足）

- [ ] 闸门 G 六条全部合入，各带阴性对照；并发 10 个花钱调用不越闸；无价模型默认拒
- [ ] 四课题冻结基线召回（有礼貌池）每个 ≥ 基线 +2 或有机制解释；数字进 CHANGELOG
- [ ] HTTP `lab approve/simulate` 无令牌必拒（A7 实测）；英文协议能编译
- [ ] `spark-research contract --json` 与真源对撞门禁绿；Python SDK 跑通 T2 全链路（R5）
- [ ] BACKLOG 真待办从 27 条降到 ≤ 5 条，剩余每条有去向（等外部 / 明确不做 / v0.9）
- [ ] A7 走通（浏览器 + 花钱 + 导出 + SDK + 审批令牌门），Blocker/High 清零

## 九、明确不做（v0.8）

物理 Opentrons 与真实设备 · 售卖通道/计费/许可文本 · 3D 查看器 · 多用户身份 · Modal 真网关（token 到再说）· skill/connector 铺量 · R kernel · CNKI/万方 · 材料平台。

## 十、BACKLOG 归口（本版）

| 去向 | 条目 |
|---|---|
| **闸门 G** | V100 V101 V93 V94 V96 V21 |
| **W8-1 α** | V67 V86 V87 V73 |
| **W8-1 β** | V85 V78 V63 V97 V99 V98 |
| **W8-1 γ** | V88 V89 V90 V79 |
| **W8-1 δ** | V92 V13 V14 V51 |
| **W8-1 ε** | V95（软件半边）V55 V59（软件四条） |
| **W8-1 ζ** | V2 |
| **收口裁定** | V12（R5 第二 provider 后）· V102（拆分）· V42（登记不做，保持） |
| **等外部（不排期）** | V4 V5 V6 V10 V52 · D1 D2 D3 · V76（按 R5 点名） |
