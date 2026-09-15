# 开发与验证计划 · v0.9

> 状态：**定稿 v1（2026-09-14）**，待用户在 session 里敲启动命令。
> 输入：`docs/USAGE_LOG.md`（U1–U10 + P1，真实使用现场）· `docs/BACKLOG.md` 未决项 ·
> OpenScience 上游源码对读（`backend/cli/src/session/`：`retry.ts` / `output-watchdog.ts` / `contract-progress.ts`）。
> 任务书：`docs/taskbooks/v0.9/`（`_COMMON.md` 共同纪律 · `GATE_I.md` · `LANE_{alpha,beta,gamma,delta,epsilon}.md` · `T5_config_ops.md` · `R6_A8.md`）。
> 前置：**V142（CI 自 v0.8.0 即红的测试环境假设）与闸门 H（PR #109，V134–V141）合入 main，且 CI 结论 success**——它不在本计划范围内，但 V137（零重试）是主线 α 的地基。

---

## 〇、一句话与已锁定决策

**v0.7 把数据留下了，v0.8 把钱和权限的硬伤补上，v0.9 修「人在用它的时候」那条路。**

主题不是新功能域，是**交互链路的速度、稳定性与可控性**。方向来自一次真实使用：
一轮 chat 发出 4–6 次串行模型调用，不稳定网络下一轮里两次失败、其中一次空等 75 秒，
界面上始终只有一句不动的「规划与执行中」；想换个模型试试，发现 `model` 参数声明了从没被读过。

### 已锁定

| # | 决策 | 理由 |
|---|---|---|
| 1 | **不加新功能域** | 同 v0.3 / v0.8 口径 |
| 2 | **不把四段管线改成 message loop** | OpenScience 是 session + message loop，我们是 plan → executeTask\* → summarize → review。改架构是大手术，收益在灵活性不在速度；当前的慢有更近的原因。**v0.9 明确不做。** |
| 3 | **凭据经 HTTP 写入（方案「乙」，用户 2026-09-14 拍板）**，并把 AD-2 修订为 **AD-18** | 参考对象查实：OpenScience 凭据经 `PUT` 写入（`routes/settings/credentials.ts`，805 行），模型是「值写入后永不返回、永不进 `process.env`、登记进输出脱敏、UI 只见字段名」+ loopback 硬限 + Origin 白名单。Spark 照此做：`PUT/DELETE /api/settings/credentials/:id`，六条硬约束见 `LANE_gamma.md`「凭据路由的硬约束」，**loopback 硬限不受 `originAllowlist` 影响**。前端设置面对标上游 12 面板，能做到「一样」的 8 个、减配 3 个、无底子 1 个（sandbox 不做），见 `LANE_epsilon.md` 面板清单。 |
| 4 | **闸门 I 先跑门禁再修 bug** | 已知至少三处「声明了、赋值了、没有读者」（V40 / V137 / U10）。先修单个实例等于承认还会有第四第五个；让门禁把这一类的全体人口找出来，名单决定 lane 分配。 |
| 5 | **δ-2 用「探端口」不用 pid 文件** | 零新状态；我们撞到的失败模式（默认端口上的孤儿）探端口就抓得到。pid 文件引入陈旧状态维护，收益不抵。 |
| 6 | **β-3 改抛错之前必须先盘点在用模型名** | 否则可能当场打断正在用的模型。盘点脚本在 `LANE_beta.md`，先跑盘点、补登记、再落抛错。 |
| 7 | **R6 基线必须在稳定网络下建立**，网络前提写进任务书 | 本次实测 OpenRouter 建连 0.14s / 15.15s / 15.15s——这种网络上的数字没有可比性。判据：`time_connect` 五次中位数 < 1s 且最大 < 3s，否则不建基线。 |
| 8 | **执行编排沿用 v0.8**：主会话（Fable 5.1）做闸门 I / 收口 / 验收；五条 lane 委派子代理（默认 Sonnet 5，启动时可改），各自 worktree | 纪律 5 + 纪律 7；lane 数 5 与 v0.8（6 条）同量级；**γ→ε 有契约依赖，其余互不依赖** |
| 9 | **规划真源只在仓库内**（本文 + `docs/taskbooks/v0.9/`），不另建仓库外规划目录 | v0.7 的仓库外目录是唯一副本、无版本控制（V76 同病）。注意：`~/Desktop/AI4S/spark-research-v0.9-plan` 是本文所在的 **git worktree**，不是以前那种非 git 草稿目录，别被名字误导。 |
| 10 | **发布 DONE 必须含「CI 结论 = success」**（V142） | 合 PR #109 时发现 CI 自 **v0.8.0 起就是红的**（main@644cccd 与 ddad14e 两次 run 均 failure）：`v118_openmm_probe.test.ts` 假设 `.venv/bin/python` 存在，runner 上 ENOENT 先于 skip 抛出。v0.8.0 是在 CI 红的状态下发布的，此前无人看 CI 结论。修复在独立 PR（`fix/V142-v118-probe-ci`），**先于闸门 H 合入**。 |

---

## 一、基线闸（第 0 步，不过不开工）

1. **V142 先合**（`fix/V142-v118-probe-ci` → main，CI 绿），再合闸门 H（PR #109 在 V142 之上重跑 CI 绿后 squash 合入）。**判据是 GitHub Actions 的结论 = success，不是本地六套件绿。**
2. `bun run typecheck` 与 `bun run check:llms` 干净。
3. `bash scripts/smoke-binary.sh > /tmp/smoke.log; test $? -eq 0`——**冒烟不进管道**（v0.7 alpha.3 教训）。
4. 登记任何新条目前先取远端所有分支的最大 V 号。**当前最大 V141，下一个 V142。**
5. 主会话 `cd` 回中立目录（主仓 `~/Desktop/AI4S/spark-research`）再 spawn 子代理（纪律：spawn 时 cwd 会被继承并被误读成指派信号）。

---

## 二、闸门 I · 「声明即须有读者」（地基，主会话串行；合完 → `v0.9.0-alpha.1`）

任务书 `taskbooks/v0.9/GATE_I.md`。要点：

- **I-1 门禁本体**：现有 `tests/unit/config_reader_parity.test.ts` 只覆盖**配置项**（V40 形状），且自己注明「key → helper 的绑定是否正确核不了」。闸门 I 补另外两个形状：
  ② **公开函数/方法的对象参数属性**在函数体内必须被引用（U10 形状：`chat(req)` 声明 `req.model` 但函数体从没读它）——用 TypeScript 编译器 API 解析函数体，不靠 grep。
  ③ **类型上的行为开关字段**必须有读取点（V137 形状：`retryable` / `maxRetries` 只在对象字面量里出现过）——文本级启发式 + 显式登记表，测试注释里写清能力边界（照 `config_reader_parity` 的做法）。
- **I-2 阴性对照**：各形状各一条「新增一个有声明无读者的成员 → 门禁必须红」，真跑，终端输出进 devlog。**没有阴性对照的门禁不算数。**
- **I-3 全量盘点**：门禁跑出的名单**逐条**进 BACKLOG（从 V142 起编号），每条定去向：修 / 删声明 / 保留并注明原因（进 allowlist 必须带原因字符串）。
- **I-4 AD-17**：把「声明即须有读者」写进 `docs/DESIGN.md` 作为 AD-12 的延伸：从「声称的能力存在吗」推进到「声称的能力接线了吗」。

**退出标准**：门禁绿 + 三条阴性对照红 + 名单入 BACKLOG 且每条有去向 + AD-17 入库。
**盘点名单决定 W9-1 各 lane 的最终清单**——若名单里冒出与 α/β/γ/δ/ε 足迹重叠的新条目，主会话在 spawn 前把它塞进对应任务书的「追加」段。

---

## 三、W9-1 · 五条并行 lane（子代理，各自 worktree；lane → `integration/v0.9-w1` → 一个 PR 进 main → `alpha.2`）

任务书各一份，共同纪律见 `_COMMON.md`。**枢纽文件从所有 lane 摘出，收口统一接线**（§六）。

| lane | 主题 | 关闭 | 一句话 |
|---|---|---|---|
| **α** | 交互链路的速度与稳定性 | U1 U4 · V77 | 输出看门狗（超时只计模型等待、真实输出续期）· 跨 provider 错误规范化与分类 · 三段结构化进度 · 失败落 `errorKind` |
| **β** | 模型控制面 | U5 U9 U10 · V16 | `chat()` 真的读 `model`（含「无 key provider 必失败」整类门禁）· `chat` 子命令补旗标且 `--help` 零调用 · 路由兜底改显式拒绝 + 两份模型清单合一 |
| **γ** | 设置面后端 API + 凭据写入（乙） | U6 U3 · V130 | `backend/src/server/routes/settings/` 一面板一文件（general / models / local / scientific-tools / credentials / extensions / compute / network / storage / permissions）· 凭据路由六条硬约束（write-only · loopback 硬限 · 不进 env · 脱敏登记 · 0600 · 删除确认）· `searchSources` 配置键 · `auth --connector <id>` CLI · `includeArchived` · V130。**先出契约骨架（48h 内），ε 按契约做** |
| **ε** | 前端设置面（对标上游 12 面板） | U6·A U3 U2(徽标) | 注册表驱动的壳（模式抄上游 `registry.ts` + `dialog-settings.tsx`，组件不抄，不引 Tailwind/Kobalte）· 11 个面板按「一样 / 减配 / 不做」如实分级（sandbox 不做且不放占位）· 凭据面板可直填（`type=password`，值永不回显）· 归档折叠 · 顶栏版本徽标 · 每面板一条 e2e |
| **δ** | 门禁与小项 | U2 U7 U8 · V120 V62 | 集成套件跳过不再像通过 · `doctor` 探运行实例 · 删重复启动日志 · `database is locked` · 补 `DEVELOPMENT_PLAN_v0.8.1.md` |

每条 lane 的交付 / 测试 / 阴性对照 / 真实核验 / 足迹 见各自任务书。

---

## 四、W9-2 · 验收方法本身（P1，主会话；与 W9-1 并行进行，不阻塞）

- **W9-2-1 第五份验收任务书「配置与运维」**：`taskbooks/v0.9/T5_config_ops.md`（本版已写好草案，R6 前冻结）。
  与四份研究课题并列。**实证依据**：本次十条里 U1 U2 U3 U5 U9 U10 六条会被它撞出来。
- **W9-2-0 AD-18 入 `docs/DESIGN.md`**（主会话，闸门 I 合入后立刻做，γ 开工前入库）：修订 AD-2。原文「凭据只在 daemon 进程」保留为默认；**新增例外**：凭据可经 **loopback-only** 的 HTTP 写路由进入 daemon，条件是 write-only（任何响应/日志/raw/record/usage 永不出现值）、永不进 `process.env`、写入即登记脱敏、文件 0600、loopback 检查不受 `originAllowlist` 影响。形状来源：OpenScience `routes/settings/credentials.ts`。
- **W9-2-2 R6 基线测量方法**：`taskbooks/v0.9/R6_A8.md` §基线——一轮 chat 的墙钟 P50/P90、每轮模型调用次数、失败占比与 errorKind 分布。**v0.9 前没有这些数，R6 就是基线。**

---

## 五、R6 + A8 · 实证回环与验收（→ `alpha.3` → 修复窗口 → `v0.9.0`）

- **R6**（零上下文子代理）：四课题复跑 + **T5 配置与运维**。先过网络前提（§〇 第 7 条），再建基线。
- **修复窗口**：R6 的每条 P0/P1 由主会话**独立复现后才动手**（v0.8 R5 的两条自报缺陷经复核不成立）。
- **A8**（第七次零上下文验收，未参与开发者执行）：浏览器 + 花钱 + 换模型 + 导出 + 审批令牌门。
  **花钱操作须在任务书里单列并预先约定预算**（V57 教训）。
- **发布**：`gh release create v0.9.0` **先于**打 tag（v0.7.0 事故：只推 tag 没建 Release，upload 报 not found）。CHANGELOG 发布段开头放「如实交代」，不放附录。

---

## 六、lane 足迹总表（一文件一主；枢纽文件收口专属）

| 文件 / 目录 | 主 | 说明 |
|---|---|---|
| `backend/src/llm/router.ts` | **收口** | α 的看门狗/规范化接入点 + β-3 的抛错，两条 lane 都要碰 → 各自交 ≤10 行 diff，收口合 |
| `backend/src/agents/orchestrator.ts` | **收口** | α-3 在 `plan`(683) / `executeTask`(749) / `summarize`(909) / `reviewSession`(959) 各加一个进度回调点；β-1 在 `sessionBudget`(460) 旁加 `sessionModel` 并让 `llmFor`(462) 读它 |
| `backend/src/index.ts` | **收口** | β-2 `case "chat"` 改走 `cli/chat_args.ts`；δ-4 删 686–687 两行 |
| `backend/src/server/app.ts` | **收口** | 挂载 `routes/settings/**`（γ 交一行 diff） |
| `backend/src/server/routes/session.ts` | **收口** | α-3 把结构化进度转发到 SSE（现 :95 那一行改成转发回调） |
| `backend/src/llm/watchdog.ts`（新） | α | α-1 |
| `backend/src/llm/provider_error.ts`（新） | α | α-2 |
| `backend/src/llm/types.ts` | α | `LlmError` 加规范化字段；`CallOptions` 加看门狗选项 |
| `backend/src/llm/providers/openai_compat.ts` · `anthropic.ts` | α | 错误体透传给规范化函数 |
| `backend/src/agents/progress.ts`（新） | α | α-3 进度事件类型 + 决策枚举 |
| `backend/src/usage/ledger.ts` | α | α-4 `errorKind` / `errorMessage`（脱敏） |
| `backend/src/cli/chat_args.ts`（新） | β | β-2 旗标解析（`--help` 先于消息） |
| `backend/src/llm/providers/registry.ts` | β | β-3 从单价表派生 provider 归属；导出 `MODELS_BY_PROVIDER` |
| `backend/src/agents/session_model.ts`（新，可选） | β | β-1 若 helper 不止 5 行，抽成文件 |
| `scripts/inventory-model-names.ts`（新） | β | β-3 前置盘点：扫 `~/.spark-research` 全部 `config.json` / `usage.jsonl` 里出现过的模型名 |
| `backend/src/server/routes/settings/**`（新目录） | γ | 一面板一文件；`config.ts` 并入 `settings/general.ts` |
| `backend/src/server/approval_token.ts`（新，可砍） | γ | 抽通用一次性令牌（scope: lab / compute / extension） |
| `backend/src/config/index.ts` | γ | γ-3 写入校验（模型名已登记 / 超时为正整数），**只加不改** |
| `frontend/workspace/src/**` | **ε** | 设置面板注册表（新 `components/settings/registry.ts`，模式抄上游）· `general` / `sources` / `credentials` 三面板 · `left.tsx` 归档折叠 + 「设置」导航 · `app.tsx` 顶栏版本 · 凭据指引文案 |
| `backend/src/cli/auth_connector.ts`（新） | γ | γ-5 `spark-research auth --connector <id>`：TTY 不回显读 key → `CredentialStore.set`；接线进 `index.ts:474 case "auth"` 走收口 diff |
| `backend/src/literature/search.ts` | γ | **只改一处**：`DEFAULT_SEARCH_SOURCES` 使用点改读 `configuredSearchSources()`；常量保留作默认值 |
| `backend/src/daemon/credentials.ts` | γ | 乙已拍板：γ 可加只读方法（`fieldsSet()`）与 0600 校验，**不改存储格式** |
| `NOTICE`（新） | **收口** | 首次从上游复制结构即建；Apache-2.0 归属段照上游 NOTICE 格式 |
| `tests/e2e/workbench.spec.ts` | **ε** | 新增用例只追加（㉑ 起），不改既有编号；⑰「算力面板无派发按钮」必须仍绿 |
| `backend/src/contract/**` | γ | 只跑生成器，不手改 |
| `sdk/python/**` | γ | 只跑 `bun run gen:sdk`，不手改 |
| `backend/src/doctor/*.ts` | δ | δ-2 运行实例探测 |
| `backend/src/records/**` | δ | δ-5 V120 |
| `tests/integration/*.test.ts` · `.github/workflows/ci.yml` | δ | δ-1 |
| `tests/e2e/tsconfig.json` | δ | V62 |
| `docs/DEVELOPMENT_PLAN_v0.8.1.md`（新） | δ | δ-6 |
| `tests/unit/gate_i_*.test.ts`（新） | **主会话** | 闸门 I |
| `docs/DESIGN.md` · `docs/BACKLOG.md` · `CHANGELOG.md` · `README.md` · `llms*.txt` · `docs/DEVELOPMENT_PLAN*.md` | **收口** | 一律不许 lane 改 |
| `docs/devlog/W9-<lane>.md` | 各 lane | 新文件，属于 lane |

**冲突预判**：γ 与 δ 都想碰 `left.tsx`（γ 导航项、原 δ-3 归档折叠）→ **归档折叠已整体划给 γ**（U3 在 γ）。α 与 β 都要 `router.ts` / `orchestrator.ts` → 全部走收口 diff。

---

## 七、执行编排

```
基线闸 ─→ 闸门 I（主会话串行，I-1→I-4）─→ alpha.1
        ─→ [盘点名单回填各 lane 任务书「追加」段]
        ─→ 五 lane 并行（α β γ δ ε；子代理，各自 worktree，各自 feat/W9-<lane> 分支；**γ 先出契约骨架，ε 从该 commit 起做面板**）
        ─→ 主会话收口：integration/v0.9-w1 ← 五 lane；接线枢纽文件；跑全量；独立复跑关键阴性对照
        ─→ 一个 PR 进 main ─→ alpha.2
        ─→ W9-2（主会话，与上并行）：T5 冻结、R6 方法冻结
        ─→ R6（零上下文子代理，含 T5）─→ 修复窗口（主会话复现后才修）─→ alpha.3
        ─→ A8（未参与者）─→ blocker 修 ─→ CHANGELOG/BACKLOG 归账 ─→ gh release create ─→ tag v0.9.0
```

- **砍尾顺序**（做不完时从后往前砍）：ε 面板 `local-models` → `permissions` → `storage` → `skills` → `connectors`(MCP) → `compute` → `network` · γ 的通用审批令牌（退回「extensions 只读 + 无 trust 的 add-mcp」）· δ-6 · δ-5 · V62 · α-2 的 `Retry-After` 解析（保留退避+抖动）· 最后才是 α-3 的决策枚举（保留三段计数）。**闸门 I、α-1、α-4、β-1、β-2、γ 的 general/models/credentials/sources 路由、ε 的壳 + general/credentials/models/sources/scientific-tools 面板、T5 不砍。**
- **别信 lane 自报数字**：收口对每条 lane 独立重跑其阴性对照与至少一条线格式探针（二进制是另一个运行时）。
- **中间成果全部落盘**：每个 alpha 打 tag；每条 lane 一份 devlog；额度中断先落 wip commit 并标「未经任何验证」。

### 启动命令（用户在 session 里敲）

```
/loop 按 docs/DEVELOPMENT_PLAN_v0.9.md 执行 v0.9：先确认 V142 与 PR #109 已合入且 CI 结论 success，从基线闸开始，闸门 I 四条串行做完打 alpha.1，
回填盘点名单到 taskbooks/v0.9 各 lane「追加」段，W9-2-0 AD-18 入库，然后五条 lane 并行（γ 先出契约骨架）（子代理，任务书在 docs/taskbooks/v0.9/）、
收口进 integration/v0.9-w1 → PR → alpha.2，W9-2 并行冻结 T5 与 R6 方法，R6（含 T5）、修复窗口、alpha.3、A8，
直到 v0.9.0 tag。每个唤醒点报一段进度；遇额度中断落 wip 并等待；中间成果全部落盘（tag/devlog/PR），
不需要我确认，做不完按 §七 砍尾顺序砍。子代理模型默认 Sonnet 5。
```

---

## 八、v0.9.0 DONE 定义（八条全满足）

> **2026-09-15 收口核对（v0.9.0 发布后补勾第 11 条，十二条全勾）**：第 2 条走「或」分支——P90 未下降，机制解释与实测见 `docs/devlog/R6-baseline.md` §机制解释（109.6s / 4 次调用 / 8590 输出 token，78% 是输出生成）与 `A8-baseline.md`（A8 侧复测）。第 3 条的「断网」为不等价替代探针（A8 探针 B：黑洞代理），台账 `errorKind:upstream` 可归因。第 11 条在 tag 推送后核。

- [x] 闸门 I 门禁绿 + 三条阴性对照红；盘点名单全部入 BACKLOG 且每条有去向；AD-17 入库
- [x]（走「或」分支）一轮 chat 墙钟 P90 相对 R6 基线下降，**或**给出机制解释并附实测数字（R6 与 A8 各测一次，网络前提达标）
- [x] 失败调用 100% 带 `errorKind`；`usage --json` 能按 errorKind 分布出报表；一次人为断网下的 chat 失败在台账里可归因
- [x] 传一个已登记但当前 provider 无 key 的模型 → 调用必失败（β-1 门禁实跑）；台账 `model` / `provider` 字段与实际调用一致
- [x] 每个会调 LLM 的子命令 `--help` 零模型调用（β-2 门禁实跑，含 `chat`）
- [x] 网页端改非密配置即时生效（A8 实测：换模型后台账 model 字段跟着变）；凭据「未配置」旁有可执行下一步
- [x] 数据源面板可勾选默认检索源，勾掉一个源后 `lit search`（无 `--sources`）真的不再查它（A8 实测）；需 key 的源显示的是 `auth --connector <id>`，且该命令在终端能把 key 写进 `credentials.json`（0600，不回显）
- [x] T5「配置与运维」跑通，其发现全部登记（含不成立的复核记录）
- [x] 凭据经设置面板写入后：`lit sources` / `capabilities` 显示已配置；**该值不出现在任何 HTTP 响应体、server 日志、raw、record、usage 里**（A8 用 Playwright 全量响应断言 + grep 数据目录）；伪造非 loopback 来源 → 403 且不受 `originAllowlist` 影响
- [x] 设置面板 8 个「一样」面板每个字段都对应后端真实值（`narrative_parity` 绿）；不存在 `sandbox` 面板
- [x]（2026-09-15 核：ci.yml main@6619730 = v0.9.0 tag → success；release.yml v0.9.0 → success，assets darwin-arm64 / linux-x64 / contract.json）**GitHub Actions 对 v0.9.0 tag 的 CI 结论 = success**（V142 教训；本地绿不算）
- [x] 集成套件在 CI 里**要么真跑要么显式报「本轮未验证」**，不再出现 `0 pass / 8 skip / 0 fail` 静默形态

---

## 九、明确不做（v0.9）

- 架构改 message loop（§〇 第 2 条）
- `sandbox` 设置面板（无底子，V42）· billing / wallet / updates / managed inference（上游托管商业面）· compute 派发与审批走 HTTP（V47 / AD-6）· storage 目录迁移 · Ollama 模型拉取
- 凭据走 HTTP 写入（§〇 第 3 条，推 v0.10 裁定）
- 物理设备 / 售卖通道 / 计费许可 / 3D 查看器 / 多用户身份 / R kernel
- skill / connector 铺量（AD-5 少而深，按课题拉动每轮 ≤2–3 个）
- **再做一轮上游对比**——P1 已论证病根不在信息不足，在检验方式与缺陷形态不匹配

---

## 十、BACKLOG 归口（本版）

| 去向 | 条目 |
|---|---|
| **闸门 I** | V40（形状登记 → 实做门禁）· U10 · 门禁盘点出的全部新条目（V142 起） |
| **lane α** | U1 · U4 · V77 |
| **lane β** | U5 · U9 · U10 · V16 |
| **lane γ** | U6（含 B 半边，乙）· U3 后端 · V130 · V142（先合）|
| **lane ε** | U6·A 前端 · U3 前端 · U2 顶栏徽标 |
| **lane δ** | U2 · U7 · U8 · V120 · V62 |
| **W9-2** | P1 |
| **等外部 / 明确不做** | V4 V5 V6 V10 V52 V76 · V42（sandbox 无底子，登记形状） |
| **裁定后关闭** | V42（local `network` 声明不强制，登记形状即可）· V49（`deterministic` 口径，用户已推迟两版，本版再问一次） |

---

## 十一、已决的开放问题（原§九，2026-09-14 定稿时拍板；用户可推翻）

| 原问题 | 决定 | 见 |
|---|---|---|
| δ-2 探端口还是 pid 文件 | 探端口 | §〇 第 5 条 |
| U6·B 凭据 | **乙：经 loopback HTTP 写入，AD-18**（用户 2026-09-14 拍板） | §〇 第 3 条 · `LANE_gamma.md` · `LANE_epsilon.md` |
| β-3 抛错前是否盘点 | 必须先盘点 | §〇 第 6 条 · `LANE_beta.md` |
| R6 网络前提是否进任务书 | 进，且是硬前置 | §〇 第 7 条 · `R6_A8.md` |
| 执行编排 | 沿用 v0.8：主会话 + 子代理 lane | §〇 第 8 条 |
