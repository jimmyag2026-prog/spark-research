# W4-a devlog · 删 swarm + 叙事收敛 + V16/V19

波次 W4，lane W4-a。分支 `feat/W4-a`。文件所有权见任务书；未碰任何枢纽文件
（orchestrator.ts / index.ts / capabilities/\*\* / mcp/\*\* / server/\*\* / literature/normalize.ts）
与 CHANGELOG.md / docs/BACKLOG.md / README.md / docs/DEVELOPMENT_PLAN\*.md。

## 1. 删 swarm（BACKLOG V7）

删除三个文件，共 330 行：

| 文件 | 行数 |
|---|---|
| `backend/src/agents/swarm.ts` | 177 |
| `backend/src/agents/swarm_types.ts` | 34 |
| `tests/unit/swarm.test.ts` | 119 |

`grep -rn "swarm"` 复核过一遍：剩下的命中全是注释性质的历史提及（`connectors/base.ts`、
`tests/concurrency/connector_race.test.ts`、`tests/unit/literature_xml.test.ts`、
`tests/unit/narrative_parity.test.ts` 自己的门禁说明文字），没有任何生产代码 import。

同步删了 `tests/unit/narrative_parity.test.ts` 里 `ALLOWED_ORPHANS` 关于 `swarm.ts` 的登记
（这条从 v0.3.0 挂到现在，是表上最老的一条），换成一段解释性注释说明它为什么被移除
（文件已不存在，不再是「孤儿」——孤儿检测的前提是文件存在但无调用方）。

## 2. V16：子代理独立模型暴露成配置项

**改前**：`backend/src/agents/sub_agent.ts` 的 `SUB_AGENT_DEFAULTS` 里，explore/literature/
execute/lab/review 五类子代理的 `model` 字段全部硬编码 `LLMRouter.DEFAULT_MODEL`，没有任何
旋钮可以让「重任务用强模型、检索/摘要用快模型」这个收益兑现。

**改后**：`backend/src/config/index.ts` 新增 5 项 `CONFIG_SETTINGS`（用一份类型清单
`SUB_AGENT_MODEL_CONFIG_TYPES = ["explore","literature","execute","lab","review"]` 派生，
不是手抄 5 段近似的 `SettingSpec` ——新增一类子代理只需要在这份清单里加一个名字）：

| key | env | 默认值 |
|---|---|---|
| `subAgentModel_explore` | `SPARK_SUBAGENT_MODEL_EXPLORE` | — |
| `subAgentModel_literature` | `SPARK_SUBAGENT_MODEL_LITERATURE` | — |
| `subAgentModel_execute` | `SPARK_SUBAGENT_MODEL_EXECUTE` | — |
| `subAgentModel_lab` | `SPARK_SUBAGENT_MODEL_LAB` | — |
| `subAgentModel_review` | `SPARK_SUBAGENT_MODEL_REVIEW` | — |

每一项都按表的硬要求写了 `summary` + `effect`（改了影响什么）。新增 `configuredSubAgentModel(type,
fallback, options)` 访问函数，与既有 `configuredModel()` 同一套 `stringOr()` 机制。

`sub_agent.ts` 新增 `resolveSubAgentModel(type, overrideModel, configOptions)`，解析顺序：

```
显式 overrides.model  >  subAgentModel_<type>（per-type）  >  defaultModel（全局）  >  代码常量
```

`buildSubAgentSpec()` 与 legacy 的 `SubAgentFactory.create()`（新增第三个可选参数
`configOptions?: ConfigOptions`）都走这同一条解析函数，不各自写一份。

**P11 踩过的坑（"加一个 provider 要改 N 个地方"）在这里的翻版与应对**：config 层不能反向
`import` `agents/sub_agent.ts`（config 要保持零依赖，这是文件顶部写明的既有纪律），所以
`SubAgentType` 的名字集合没法像 provider 那样"从单一真源派生"——只能退而求其次，在
`sub_agent.ts` 里导出一份运行时清单 `SUB_AGENT_TYPE_NAMES`（从 `SUB_AGENT_DEFAULTS` 的 key
派生），再用测试钉住它与 config 层 `SUB_AGENT_MODEL_CONFIG_TYPES` 集合相等
（`tests/unit/sub_agent.test.ts` 新增的第一条 V16 测试）。如实记录：这不是真正的"派生"，
是"两份手写清单 + 测试钉死一致性"，比 provider 那次更弱一档，但这是 config 不能依赖 agents
这条既有边界下能做到的最好方案。

**测试**：`tests/unit/sub_agent.test.ts` 新增 `describe("V16 · 子代理独立模型配置项")`，6 条：
类型集合一致性、零配置基线（=`LLMRouter.DEFAULT_MODEL`）、per-type 覆盖只影响对应类型、
解析优先级三层、env 覆盖 config.json、legacy `SubAgentFactory.create()` 走同一条链。全部用
`{root, env}` 隔离配置，不碰这台机器真实的 `~/.spark-research`。

**副作用**：`scripts/gen-llms-txt.ts` 从 `CONFIG_SETTINGS` 生成 `llms.txt`/`llms-full.txt`，
新增的 5 项配置需要重新生成才能通过 `tests/unit/llms_txt.test.ts` 的幂等检查——已跑
`bun scripts/gen-llms-txt.ts` 并提交两个文件的 diff（各 +5 行，纯新增 5 条配置项说明）。

## 3. V19：审批动作要求可交互终端

**威胁模型**（任务书原文）：AD-9 裁定 MCP 层（`MCP_WITHHELD` 里的 `lab_approve`/`lab_simulate`，
`sub_agent.ts` 的 `assertNoWithheldGrants`）挡的是子代理走 MCP 工具面这条**默认路径**，不是
技术上的绕道——任何能跑 Bash 的 agent 都能直接 `spark-research lab approve <id> --actor
"随便编的名字"`。

**技术防线**（全部实现在 `backend/src/lab/cli.ts`，新增 `requireApprovalGate()`；未碰
`wet_loop.ts`/`wet_models.ts`，不在本 lane 文件所有权内）：

1. **判据**：`process.stdin.isTTY && process.stdout.isTTY`（Node/Bun 对"这个文件描述符连着
   真终端"的标准探测）。管道 / 重定向 / 子进程 / Bash 工具调用全部是 `false`——
   `echo yes | lab approve ...` 这种伪造交互的手法在这一步判定就先失败，不需要额外去防
   "stdin 被脚本控制"这件事本身。
2. **交互终端分支**：必须真的在这次调用里读到一行确认（`node:readline` 从真实
   stdin/stdout 问一句「输入 'yes' 确认」，测试可注入 `deps.approvalConfirm`）。没读到
   `'yes'`（大小写不敏感、去空白）直接拒绝，`stopReason` 式的诚实：不静默通过。
3. **非交互分支（CI/自动化）——默认拒绝**，需要三样同时显式给出才放行：
   - `--ci-bypass-token` 等于环境变量 `SPARK_LAB_CI_BYPASS_TOKEN`（必须由运维/CI 流水线
     所有者显式配置，代码里不给它任何默认值/兜底）；
   - `--ci-bypass-reason "<理由>"`（人工写清楚为什么这次可以不经真人终端）；
   - 两者都满足才放行，且**留痕**：旁路事实与理由被拼进一段
     `[V19 CI 旁路：非交互终端，SPARK_LAB_CI_BYPASS_TOKEN 校验通过] <reason>` 文本，随
     `note`（approve）/`reason`（reject）一起传给 `WetLabLoop.approve()`/`.reject()`——这两个
     字段本来就会被写进 decision record 的 `content` 与 `metadata.note`（`wet_loop.ts` 既有
     行为，未改动），也就是说旁路是一条持久化、可审计的记录，不是打印一行就丢的日志。
   - 如实记录局限：`SPARK_LAB_CI_BYPASS_TOKEN` 不是牢不可破的安全边界——拿到 shell 就能
     读 env，一个真正恶意的 agent 理论上还是可能从环境里读到这个 token（如果它恰好被配置
     在同一个可读的环境里）。它满足的是"显式、留痕、不是默认路径"三条最低要求，不构成
     强隔离。**在此之前不要声称审批"无法被自动化"**——这条旁路本身仍然是技术上可以被
     自动化的部分，只是不再是默认行为，且每一次都可追溯到 decision record。
4. `reject` 命令受同一道门约束（AD-6 把 approve/reject 视为同一类"人的决策"，两者都会
   落 decision record）。

**测试**：`tests/unit/lab_cli.test.ts` 新增 `describe("lab CLI · V19 审批终端门")`，7 条：
非交互+无 token→拒绝；非交互+token 缺失/不匹配→拒绝；非交互+token 匹配但缺 reason→拒绝；
非交互+token+reason 齐全→放行且 note 含旁路痕迹；交互确认非 yes→拒绝；交互确认为 null→
拒绝；reject 同受约束。既有 19 条测试的默认路径通过给 `cli()` 测试脚手架加默认
`approvalIsInteractiveTty: () => true, approvalConfirm: async () => "yes"`（模拟"真人在场"）
保持不变。

**CI/测试环境怎么办**：见上面第 3 点——显式的 `--ci-bypass-token` + `--ci-bypass-reason`
双旗标 + 环境变量校验，任何一个缺失都硬失败并给出可操作的错误信息；三者齐全时留痕进
decision record。不是静默放行。

### 意料之外的连带修复（本 lane 文件所有权外，但是这次改动直接导致的回归，随手修了）

- `tests/unit/ui_cli_parity.test.ts`：CLI 侧调用 `runLabCommand(["approve", ...])` 之前没有
  任何 TTY 模拟，被 V19 挡住。加了 `approvalIsInteractiveTty: () => true` +
  `approvalConfirm: async () => "yes"` 两行到它的 deps 里（HTTP 侧走 `/api/lab/.../approve`
  路由，不经过 `cli.ts`，完全不受这次改动影响——这也验证了 V19 的改动范围确实只在 CLI 层，
  没有意外影响 API 层）。
- `llms.txt` / `llms-full.txt`：V16 新增的 5 项配置需要重新生成（见上）。

## 4. README 该删的宣传语

**结果：当前 README.md 里没有找到「100 并发 swarm」这句或任何同义表述**（`grep -n -i
"swarm\|100\|并发\|编排\|orchestrat"` 全部扑空，唯一命中是无关的"编排进程死了任务还在"
一句）。看起来这句宣传语在更早的某一轮迭代里已经被撤下，README 现在是干净的——这次
"删 swarm"不需要再动 README。

**但顺带核实了其它文档里的同类陈述，发现两处现在确实变成了叙事漂移，列在这里供收口处理**
（这两个文件不在本 lane 文件所有权内，没有动它们）：

1. `docs/EXTENDING.md:528`：
   > 每个子代理可以配独立模型（`SubAgentConfig.model`，默认全部落到
   > `LLMRouter.DEFAULT_MODEL`）：重任务用强模型、检索摘要用快模型。**这一层目前是代码内
   > 配置**，暴露成用户配置项已登记为 BACKLOG（与 V7 Agent Swarm 一起评估）。

   加粗那句现在是假的——V16 已经把它做成配置项了（本 devlog 第 2 节）。这句需要改写成
   "已支持通过 `subAgentModel_<type>` 配置项覆盖"，并删掉"已登记为 BACKLOG"的部分。

2. `docs/DESIGN.md:70`（架构总览表）：
   > Orchestrator + swarm | `backend/src/agents/` | 保留，接入新子代理配置

   "swarm"与"保留"两个词都过时了：swarm.ts 已删除，"接入新子代理配置"应该改成描述
   V16 交付的 `subAgentModel_<type>` 配置项，而不是"待接入"的措辞。

（`docs/BACKLOG.md` 里 V7/V16/V19 三行本身就是"已完成，等收口勾掉"的状态，不属于"宣传语"，
按任务书要求也没有碰它。）

## 5. 阴性对照（实跑，终端输出如下）

### ① 删了 swarm 却不删 `ALLOWED_ORPHANS` 登记 → 门禁必须变红

临时把 `tests/unit/narrative_parity.test.ts` 里已删除的 `swarm.ts` 登记项加回去（文件本身
保持已删除状态），单独跑该测试文件：

```
$ bun test tests/unit/narrative_parity.test.ts
...
error: 这些条目已不再是孤儿，请从 ALLOWED_ORPHANS 移除：
  backend/src/agents/swarm.ts

- []
+ [
+   "backend/src/agents/swarm.ts",
+ ]

- Expected  - 1
+ Received  + 3

      at .../tests/unit/narrative_parity.test.ts:461:80
(fail) 叙事一致性门禁（AD-12） > 孤儿模块：生产代码零引用者的文件必须在册，且在册理由不许为空 [17.66ms]

 8 pass
 1 fail
 213 expect() calls
Ran 9 tests across 1 file. [122.00ms]
```

红了，符合预期。随即撤回这次临时改动，重跑确认恢复绿：

```
$ bun test tests/unit/narrative_parity.test.ts
bun test v1.3.14 (0d9b296a)

 9 pass
 0 fail
 213 expect() calls
Ran 9 tests across 1 file. [129.00ms]
```

### ② V19：在非交互环境下审批被放行 → 测试必须变红

临时在 `backend/src/lab/cli.ts` 的 `requireApprovalGate()` 里插入一行，模拟"非交互分支被
静默放行"这个回归（`if (!isTty) return { bypassNote: null };`，插在真正的门禁逻辑之前），
单独跑 `lab_cli.test.ts`：

```
$ bun test tests/unit/lab_cli.test.ts
...
(fail) lab CLI · V19 审批终端门 > 非交互环境、未配置 SPARK_LAB_CI_BYPASS_TOKEN：approve 默认拒绝（不是静默放行） [14.23ms]
(fail) lab CLI · V19 审批终端门 > 非交互环境、配置了 token 但 --ci-bypass-token 不给/不匹配：拒绝 [11.25ms]
(fail) lab CLI · V19 审批终端门 > 非交互环境、token 匹配但缺 --ci-bypass-reason：拒绝（旁路必须写明理由） [8.41ms]
(fail) lab CLI · V19 审批终端门 > 非交互环境、token + reason 齐全：放行，且旁路事实写进 decision record（留痕，不是静默通过） [7.75ms]
(fail) lab CLI · V19 审批终端门 > reject 同样受终端门约束（非交互默认拒绝） [7.76ms]

 21 pass
 5 fail
 105 expect() calls
Ran 26 tests across 1 file. [698.00ms]
```

5 条红（4 条"非交互默认拒绝"类断言从 1 变 0，加上"旁路 note 应该存在"那条断言在"从来没
拒绝过"的世界里连 JSON 结构都对不上），符合预期。随即撤回这次临时改动，`bun run typecheck`
干净，重跑确认恢复绿：

```
$ bun run typecheck
$ tsc --noEmit && tsc --noEmit -p frontend/workspace/tsconfig.json

$ bun test tests/unit/lab_cli.test.ts
bun test v1.3.14 (0d9b296a)

 26 pass
 0 fail
 113 expect() calls
Ran 26 tests across 1 file. [609.00ms]
```

## 6. 六套件最终数字

| 套件 | 命令 | 结果 |
|---|---|---|
| typecheck | `bun run typecheck` | 干净（无输出无报错） |
| unit | `bun test tests/unit/` | **1304 pass / 0 fail / 0 skip**（80 files；较基线 1298 净 +6：删 swarm.test.ts 的 7 条 − 13 条新增（V16 6 条 + V19 7 条）） |
| concurrency + timeout | `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail（7 files） |
| e2e | `SPARK_E2E_PORT=4441 bun run test:e2e` | **14/14 passed** |
| py | `bun run test:py` | 48 passed |
| lab | `bun run test:lab` | 26 passed |

## 7. 诚实的未完成/局限项

- V19 的 CI 旁路令牌本身不是强安全边界（见第 3 节第 3 点的局限说明），只满足"默认拒绝 +
  显式旁路 + 留痕"三条最低要求。
- V16 的两张类型清单（`sub_agent.ts` 的 `SUB_AGENT_TYPE_NAMES` 与 `config/index.ts` 的
  `SUB_AGENT_MODEL_CONFIG_TYPES`）没能做成真正的单一派生（config 不能反向依赖 agents），
  靠测试钉住一致性，比 provider 那次的解法弱一档——如实记录在第 2 节。
- README.md 本身这次没有可删的句子（已经是干净的）；docs/EXTENDING.md:528 与
  docs/DESIGN.md:70 两处现在是叙事漂移，列在第 4 节，留给收口处理（不在本 lane 文件所有权
  内，没有动）。
