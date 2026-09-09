# P9 · 扩展面梳理与 LLM 友好化

> 分支 `feat/p9-extensibility` · 2026-09-09 · v0.2 最后一个阶段
> 范围真源：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) 「P9」节
> 用户原话口径：梳理 skill / tool / connector 这些方便科研人员自己配置和修改的地方，并进行 LLM 友好的封装和适配。

---

## 0. 一句话结论

P1–P8 把能力做出来了，P9 做的是**让别人能用、能改、能接**：六个扩展点各一节可运行文档、三种脚手架、从注册表生成的能力清单、24 个 MCP 工具、配置面收口、SKILL.md schema 化、llms.txt。

测试从 716 → **824**（+108，本机 824 pass / 0 fail），typecheck 干净，pytest 48、Playwright 12 一个没挂。

---

## 1. 交付物与状态

| # | 交付物 | 状态 | 落点 |
|---|--------|------|------|
| 1 | `docs/EXTENDING.md` 六节 | ✅ | 每节 = 契约 + 最小可运行示例 + 怎么测 + 放哪里 |
| 2 | 脚手架 `new skill\|connector\|platform` | ✅ | `backend/src/scaffold/`；生成物 CI 真跑一遍 |
| 3 | `capabilities [--json] [--probe]` | ✅ | `backend/src/capabilities/` + `GET /api/capabilities` |
| 4 | `llms.txt` + `llms-full.txt` | ✅ | `scripts/gen-llms-txt.ts`，幂等 + CI 门 |
| 5 | MCP server `spark-research mcp` | ✅ | `backend/src/mcp/`，24 工具 / 5 个刻意不暴露 |
| 6 | 用户配置面收口 | ✅ | `backend/src/config/`，设置表是单一真源 |
| 7 | SKILL.md frontmatter 规范化 + CI 校验 | ✅ | `backend/src/skills/frontmatter.ts` |
| 8 | 刷新 `REVIEW_BRIEF.md` | ✅ | 从 pin 在 b4aab02 的快照刷新到 v0.2.0 |
| 9 | 发布 v0.2.0 内容准备 | ✅（tag/Release 由主会话执行） | CHANGELOG 0.2.0 补 P9 条目，日期落定 |

额外做的一件（任务书要求「评估」的）：**`MCPConnector` → `HttpConnector` 改名**，见 §4。

---

## 2. 关键决策

### D1 · MCP 层完整复用 P7 的 service 层，不重实现

每个 MCP 工具的 `request()` 只返回「方法 + 路径 + body」，由 `McpToolRunner` 用同一个 Hono app 在**进程内** `fetch()`。不起网络监听、不重写业务逻辑。

理由很直接：CLI / HTTP / UI / MCP 是四个入口，业务规则只该有一份。若 MCP 层自己实现一遍「检索并入库」，那么 P2 的去重口径、P4 的两条硬门、P8 的 review 门槛都会有第二套实现，迟早对不上，而且不会有任何东西报警。

代价：MCP 工具受限于 HTTP 端点已有的能力。这一轮没撞到限制（66 个路由覆盖了全部域能力）。

### D2 · 用低阶 `Server` 而不是 `McpServer`

SDK 1.30 的 `McpServer.registerTool` 的 `inputSchema` 只吃 zod schema（`AnySchema = z3.ZodTypeAny | z4.$ZodType`）。而我们的工具 schema 要与 `capabilities` 输出同源——那是手写 JSON Schema。再引一层 zod 等于多一份可能漂移的定义，而且 zod 目前只是 SDK 的传递依赖，直接用它会让依赖关系变得不诚实。

低阶 `Server` + `setRequestHandler(ListToolsRequestSchema / CallToolRequestSchema)` 完全够用，代价只有几十行样板。

### D3 · 长任务在 MCP 层默认同步（判断三的落地细节）

实现上没有用 HTTP 层已有的 `await: true`，而是**显式提交 `await: false` 拿句柄，再自己轮询到落定**。

原因：`await: true` 会让 HTTP 层无限等，超时就只能靠掐连接——那样任务 id 在 MCP 侧就丢了，超时降级根本给不出可用的句柄。先拿句柄再轮询，超时时才能诚实地说「任务仍在后台跑，用 `task_status` 查 taskId=…」。

### D4 · 可用性分静态档与探测档，不混

`capabilities` 默认零 IO：connector 的可用性由注册表元数据推出（占位 / 需凭据未配 / 可用），仿真平台与湿实验后端标 `unknown`。`--probe` 才真去 spawn 子进程问「openmm 装了没」。

混在一起的话，一个没装 openmm 的环境会让 `capabilities` 变慢且结果因机器而异；而外部 agent 想要的多数时候只是「有哪些源、schema 长什么样」。不探测时如实写 `unknown` 而不是假装 `available`——这一条有测试钉着。

### D5 · `caveat` 进 connector 元数据

`status: "available"` 说的是「接口实现了」，不等于「无条件可用」。Semantic Scholar 的 `apiKeyRequired` 是 `false`，但 P2 实测匿名请求持续 429（7 次尝试全挂）。这个事实此前只活在 devlog 与技能文档里，外部 agent 看不到。

现在它是 `ConnectorMetadata.caveat`，原样透出到 `capabilities`——让使用者在选源之前就知道会撞什么墙，而不是撞完再猜。

### D6 · SKILL.md 的 `validation` 字段由 CI 去磁盘核对

AD-5「技能必须有配套 e2e 验证才算完成」此前只是文档里的一句话，没有任何机制守着。P9 把它变成 frontmatter 的必填字段，且校验器会 `existsSync` 每一条路径。写一个还不存在的测试文件路径，CI 立刻红。

同时 `triggers`（用户会怎么开口）与 `connectors`（依赖哪些数据源，id 必须真实存在）也成为必填——前者是 agent 选技能的第一判据，后者让「这个技能缺凭据时其实跑不通」变成可查的事实。

### D7 · 配置面用「设置表」而不是散落的常量

`CONFIG_SETTINGS` 是一张表，每项带 `summary`（是什么）与 **`effect`（改了影响什么）**。`config list` 的表格、`capabilities` 的 config 段、EXTENDING 第六节的对照表全部从它来。

强制 `effect` 存在是有意的：文档里最常缺的就是这一段，用户改一个默认值之后不知道会波及什么。把它放进类型里，写新配置项时想不写都不行。

下游只在**本来就要落到 `DEFAULT_*` 常量**的位置替换成配置值（lab CLI 后端、exp CLI 平台、`ServerContext.wetBackend()/model()`），显式注入的路径行为完全不变——这样 716 条既有测试一条都不受影响。

### D8 · 礼貌头走「启动时把 config 补进 env」

`politeness.ts` 从 v0.2 起只读 env，而 connector 层在很多路径上拿不到 config 句柄。改所有调用点风险大、收益小。做法是在 `main()` 里调一次 `applyConfigEnvDefaults()`：把 config.json 里的非凭据设置补进 env（**已有 env 则不动**，优先级不变）。

**凭据不走这条路**——secret 永远不进 env（AD-2）。这条有测试钉着。

---

## 3. 判断一（危险动作不暴露为 MCP tool）：同意，并且加了一层

主会话的判断我完全同意，没有异议。实现上比要求多做了两件事：

**① 不暴露清单是显式数据，不是「没实现」。**
`MCP_WITHHELD` 里每一项带 `reason`（为什么不给）与 `humanAction`（人该执行哪条命令）。它进三个地方：`capabilities` 输出、MCP server 的 `instructions`、以及被猜到名字时的错误返回体。外部 agent 读到的是边界与替代路径，而不是一个 404。

`lab_compile` 的返回体里直接给出 `humanAction.nextStepForHuman`（含实验 id 与 `--actor` 占位），把人拉回环里。

**② 结构性防线，而不只是「清单里没有」。**
`tests/unit/mcp_server.test.ts` 有一条测试遍历**全部已暴露工具**，用三组探针参数调用它们的 `request()`，断言产生的路径没有一条命中 `/(approve|reject|simulate|archive)` 或 `/conclusions/<id>/review`。

这比「工具名里没有 approve」强得多：将来有人加一个叫 `lab_finish` 的工具、内部却 POST 到 `/approve`，这条会立刻红。

写这条时踩到一个细节：最初的正则是宽泛的 `/review/`，把 `/api/lit/review`（综述草稿，与审批无关）一起误伤了。**误伤合法路径的守卫迟早会被人删掉**，所以改成逐条点名危险端点，并把这个理由写在测试注释里。

**一处主动扩大**：把 `project_archive` 也列入不暴露。它不在主会话的清单里，但归档是破坏性的组织动作（把项目移出默认视图），不该由外部 agent 代劳。这是收紧不是放开，按「不可 MCP 化为默认」的口径处理。

**一个我认为值得主会话看的反问**（已写进 REVIEW_BRIEF §8.4）：外部 agent 完全可以绕开 MCP，直接用 Bash 调 `spark-research lab approve --actor 它自己编的名字`。那我们挡住的到底是什么？我的回答是「挡住的是**默认路径**与**责任归属**」——MCP 工具是 agent 的第一反应，绕道 shell 是一个显式的、留痕的、用户在 permission 层看得见的动作，且 `actorSource` 会如实记录来源。这个回答我认为成立但不完美，留给评审挑战。

---

## 4. `MCPConnector` → `HttpConnector`：评估结论是「现在改」

任务书让评估是否改名。结论：**改，并保留 deprecated 别名**。

理由：
- 这个类与 Model Context Protocol 毫无关系，是个普通 HTTP 客户端基类，名字来自 v0.1「让每个数据源都是一个 MCP server」的早期设想。
- P9 之前歧义只是「历史遗留」；P9 落地了真正的 `backend/src/mcp/` 之后，同名变成**主动误导**——读者会以为 connector 层在说 MCP 协议。
- v0.2.0 是把公开 API 定下来的那一刻。此刻改成本最低（10 个文件 69 处，机械替换，824 条测试兜底），发布之后只会更贵。

保留 `MCPConnector` / `MCPConnectorConfig` / `MCPTool` 三个 `@deprecated` 别名，外部引用不会断；移除记在 BACKLOG V15。

---

## 5. 测试与验证

### 数字

| 项 | P8 基线 | P9 | 说明 |
|----|--------|-----|------|
| bun 单元/契约/e2e | 716 | **824** | +108。装了 openmm 时 824 全 pass；没装时 OpenMM 契约那 17 条整套 skip（并把原因打出来，不静默跳过） |
| pytest | 48 | **48** | 未新增 python 侧模块 |
| Playwright | 12 | **12** | UI 未改 |
| typecheck | 干净 | **干净** | 后端 + 前端各一次 |

新增测试文件（7 个）：

| 文件 | 例数 | 验什么 |
|------|------|--------|
| `tests/unit/config.test.ts` | 15 | 优先级三档、坏 JSON 不致命、凭据三路输出全不泄漏、设置表与 `DEFAULT_*` 常量一致 |
| `tests/unit/skill_frontmatter.test.ts` | 23 | 解析器、schema 约束、仓库内 10 个技能逐个过门 |
| `tests/unit/capabilities.test.ts` | 19 | 双向一致（正向可实例化 / 反向不漏项）、可用性分档、凭据不泄漏、CLI 两种输出同源 |
| `tests/unit/mcp_server.test.ts` | 18 | 描述写法标准、对抗组（含结构性防线）、真实客户端协议层、长任务同步/超时/失败 |
| `tests/unit/mcp_e2e.test.ts` | 1（22 断言） | 真实 MCP 客户端跑通 capabilities → 检索入库 → idea → novelty → 时间线 → 报告 |
| `tests/unit/scaffold.test.ts` | 9 | 参数与安全、**生成物 CI 真跑一遍**（skill / connector×2 / platform） |
| `tests/unit/extending_examples.test.ts` | 13 | 安全门规则示例（对抗 + 阴性对照 + 纯函数形态）+ 文档路径不许脱节 |
| `tests/unit/llms_txt.test.ts` | 10 | 幂等、与仓库文件一致（改文档忘生成即红）、索引内容完整 |

### 测试抓到的真缺陷

写测试的过程本身抓到 4 个：

1. **脚手架的带 key connector 模板**：通用用例（查询参数进 URL）没注入凭据，于是 `search()` 走降级路径直接返回、根本没发 HTTP 请求，断言 `captured` 长度失败。模板里加了 `withKey()` 辅助。
2. **platform 模板的 runner 不写 stdout**：契约测试要求 `collect().log` 非空（编排进程被杀后 `stdout.log` 是唯一能回答「任务当时跑到哪」的东西）。补了三处 `print(..., flush=True)`。
3. **platform 模板的 `failingSpec` 没有 prepare 期警告**：契约要求「参数合法但大概率跑不通」的组合在 prepare 阶段就给出 warning。补了 `scale > 10` 的发散警告。
4. **`wallSeconds` 四舍五入到 0.0**（flake）：demo runner 太快，3 位小数下秒级以下算例变成 `0.0`，契约的 `wallSeconds > 0` 间歇失败。改为 6 位精度 + 1 µs 下限——「跑过」与「没跑」在下游不能长得一样。连跑三次确认稳定。

第 1–3 条正是「让 CI 真跑生成物」这条测试的价值：如果只断言「文件生成了」，这三个缺陷会原样交付给每一个用脚手架的人。

### 退出标准核对

| 标准 | 状态 |
|------|------|
| EXTENDING 六节示例真实可跑 | ✅ skill/connector/platform 是脚手架产物（CI 生成后 `bun test`）；安全门规则 11 例；WetLabBackend 一节给的是施工说明（第二设备族尚无真实实现，给跑不通的示例比不给更糟） |
| capabilities 一致性测试 | ✅ 双向 19 例 |
| MCP 真实客户端跑通链路 e2e | ✅ `mcp_e2e.test.ts`（SDK `Client` + `InMemoryTransport`，零网络零真实模型） |
| 对抗测试：approve 类不可经 MCP 调用 | ✅ 三层（不在清单 / 名字模式 / **结构性路径防线**）+ 猜名调用返回 humanAction |
| llms.txt 生成幂等 | ✅ 连续生成逐字节相同 + 与仓库文件一致的 CI 门 |
| 基线不许挂 | ✅ 824 / 48 / 12 / typecheck 干净 |
| 外部验收（全新 Claude Code 会话接 MCP 完成一次操作） | ⏸ **机器版已覆盖**（mcp_e2e）；**人版留给主会话** |

---

## 6. 与设计的偏差

1. **MCP 工具 24 个而非「核心能力」的模糊表述**。计划里写的是「lit search/library/idea/novelty/exp/lab/records」，实际按域补全到 24 个（多出项目管理、导出、报告、结论、task_status）。理由：外部 agent 需要能自己确认当前项目、能查任务、能取报告，缺一环就得让用户手动补，反而更不友好。
2. **子代理独立模型没有暴露成用户配置项**。计划的第六个扩展点写「每子代理独立模型配置」，现状是 `SubAgentConfig.model` 代码内可配、但全部落到 `LLMRouter.DEFAULT_MODEL`，没有用户面入口。EXTENDING 第六节如实写明了这一点，登记为 BACKLOG V16——与 V7（Agent Swarm 接入）一起评估更合理，单独做会做出一个没人用的配置项。
3. **WetLabBackend 一节没有「最小可运行示例」**。第二设备族尚无真实实现，给一个跑不通的示例比不给更糟；这一节给的是五步施工说明（含 `protocolHash` 语义搬迁与 `volume_capacity` 规则的降级口径）。这条偏差写在了 `extending_examples.test.ts` 的断言注释里（要求 ≥4 节有示例，而不是 6 节）。
4. **改名 `MCPConnector` → `HttpConnector`** 超出计划范围，见 §4。

---

## 7. 建议主会话重点审查的三处

1. **AD-9 的措辞与边界（`backend/src/mcp/tools.ts` 的 `MCP_WITHHELD` + DESIGN §5.2）**。我把 `project_archive` 也列进了不暴露清单（主会话原清单没有它）。以及 §3 末尾那个反问——「绕道 Bash 就能 approve，我们到底挡住了什么」——的回答是否站得住，值得主会话直接表态，因为它会成为将来所有「要不要暴露 X」的判例。

2. **配置面对既有默认值的替换点（`ServerContext.model()`、`lab/cli.ts`、`experiment/cli.ts`）**。我只替换了「本来就要落到 `DEFAULT_*`」的位置，显式注入路径不变。但 `ServerContext.model()` 有一个行为变化：此前 `ctx.deps.model` 为 undefined 时下游用各自的内部默认，现在会拿到一个显式的模型名。默认值相同所以行为等价，但这是一条**只有在用户真的配了 `defaultModel` 时才会显现**的路径，值得过目。

3. **脚手架模板作为「事实上的最佳实践」的分量**。模板里的注释会被复制进每一个新扩展点（这正是目的），所以那些注释的内容等同于团队规范。尤其是带 key connector 模板里的降级写法与 platform runner 的 `done.json` 原子写口径——如果主会话对这两处的写法有不同意见，现在改的成本最低。

---

## 8. 遗留与后续

- **人版外部验收**：用一个全新的 Claude Code 会话（无本仓库上下文）仅凭 MCP + llms.txt 完成一次「检索入库 → idea → novelty」。机器版已覆盖，人版留给主会话。
- **tag `v0.2.0` + GitHub Release**：内容已备（CHANGELOG 0.2.0 完整、REVIEW_BRIEF 刷新到位），执行留给主会话。
- 新增 BACKLOG：V15（移除 deprecated 别名）、V16（子代理模型配置化）、V17（MCP 进度回传）、V18（`--probe` 结果缓存）。

## 9. 流程记录

本阶段在第一个逻辑块完成、**尚未 commit** 时遭遇额度中断，主会话介入时 `origin` 上还没有 `feat/p9-extensibility` 分支，全部成果悬在工作树里。恢复后第一件事是提交并推送，此后每个逻辑块一个 commit + push（本阶段共 8 个）。

这是连续第三个阶段因中断/环境问题险些丢成果（P6 分支污染、P7 目录 EPERM、P9 额度中断）。工程纪律第 9 条「阶段性成果及时保存」应当从**建议**升格为**执行前置动作**：新分支创建后立即空推一次，让远端先有这个分支，后续每块只是追加。

---

## 主会话验收批注

（待填）

## 主会话验收批注（2026-09-09）

- **R1 AD-9 边界裁定（会成为判例，故写进 DESIGN 而非只答在 devlog）**：MCP 工具清单是**能力声明，不是访问控制**。真正的访问控制在 daemon permit set、文件权限、物理设备。有 Bash 权限的 agent 确实能绕道——**承认这一点，不假装挡得住**。这条边界起作用的是三件事：默认路径（自动批准不在 agent 的默认可达集合里）、意图显性化（绕道要主动构造命令，留痕且用户在 permission 层可见）、责任归属（经 MCP 是我们授权的能力，经 Bash 是用户授予 Bash 权限的后果）。结论：纵深防御的一层，不是唯一一层。声称它挡得住有意绕过者是安全剧场；但「反正能绕过所以不该做」同样错——默认值决定 99% 的行为。**推论已登记 BACKLOG V19**：要真堵住绕道，得在 CLI 层要求审批来自可交互终端，而不是加固 MCP 层。在 V19 落地前，文档不得声称审批「无法被自动化」。
- **`project_archive` 主动扩大：同意**。归档是破坏性组织动作，符合 AD-9 的「按谁承担后果切」。
- **R2 `ServerContext.model()` 行为变化：接受**。仅在用户真配了 `defaultModel` 时显现，且那正是配置项该有的效果。
- **R3 脚手架模板即团队规范：认可现有口径**（带 key connector 的降级写法、platform runner 的 `done.json` 原子写）。这两条都来自前期阶段用真实故障换来的教训，写进模板正是让后来者不必重踩。
- **超范围的 `MCPConnector → HttpConnector` 改名：认可时机判断**。P9 落地真 MCP 后同名从历史遗留变成主动误导，而 v0.2.0 是公开 API 定型时刻，此刻改成本最低（824 测试兜底，保留 deprecated 别名）。
- **流程建议采纳**：纪律第 9 条升格为「新分支创建后立即空推（`git push -u` 建立远端跟踪），再开始写代码」——本阶段在零 commit 状态遭遇中断，差点全丢。
