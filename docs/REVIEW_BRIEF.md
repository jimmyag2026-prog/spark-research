# Spark Research · 外部评审简报

> 面向不了解本项目的评审者（人或 agent）。目标：15 分钟内进入状态，直接指出真问题。
> 快照时间：2026-09-09 · 对应版本：**v0.2.0**（P1–P9 全部合入 main）
> 配套文档：[DESIGN.md](DESIGN.md)（设计真源）· [EXTENDING.md](EXTENDING.md)（六个扩展点）· [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)（阶段计划）· [BACKLOG.md](BACKLOG.md)（未决事项）· [devlog/](devlog/)（每阶段实施记录与验收批注）
>
> 如果你是一个 LLM：直接读 [`llms.txt`](../llms.txt)（索引）或 [`llms-full.txt`](../llms-full.txt)（全量），
> 或者把工作台当工具箱接进来：`spark-research mcp`。

---

## 0. 一分钟速览

**是什么**：面向科研人员的开源科研工作台。用自然语言驱动一个可审计的研究代理，完成「文献调研 → 思路共探 → 创新性验证 → 实验（干/湿）→ 全流程记录 → 结论评审 → 报告」的完整循环。本地优先，模型无关，Apache 2.0。

**当前状态**：v0.2.0。P1–P9 全部合入（项目基座、文献域、综述与引用核验、思路库与 novelty、干实验闭环、湿实验闭环、API 层 + SolidJS 工作台、功能收口、扩展面与 LLM 友好化）。

**规模**：后端 TypeScript ~23k 行（18 个域模块）+ Python ~1.2k（kernel / 仿真 / 实验室后端）· 前端 SolidJS ~3.4k 行 · 66 个 HTTP 路由 · 24 个 MCP 工具 · 17 个 connector · 10 个技能 · 测试 ~15.8k 行：**824 bun unit + 48 pytest + 12 Playwright，全绿**。

**最想被挑战的**：见 §8。简报刻意包含全部已知缺陷与未决判断——**发现我们没写在 §8 里的问题，价值最大**。

---

## 1. 定位与三个差异化赌注

参照系是 Anthropic 的 Claude Science（闭源托管）与 OpenScience（`synthetic-sciences/openscience`，Apache 2.0，本项目的架构蓝本）。相对两者，我们押三件事：

1. **Project-centric，不是 session-centric**。两个参照系都以会话/workspace 为单位；科研的真实单位是**课题**——横跨数月、数百次会话。本项目的持久层以 Project 为根：文献库、思路库、实验记录、结论卡跨会话累积。
2. **全流程 Research Record**。不只记录代码产物，还记录思路（idea）、决策（decision）、精读（reading）、观察（observation）、结论（conclusion），全部进同一张证据图（8 种 record 类型 + 5 种边）。副产品是天然的电子实验记录本与可审计 research trail。
3. **干湿闭环**。协议编译器 + 安全门 + 人工审批 + 设备抽象，AI 设计 → 干实验仿真 → 湿实验执行 → 数据回传 → 迭代。两个参照系都没有。

**明确不做**（v0.x）：云端多租户 SaaS、通用 IDE、自研模型、文献全文托管。

---

## 2. 架构

```
界面层    CLI（能力真源） · SolidJS 工作台 · MCP server（外部 agent 接入）
             ↓  三者都是 HTTP API 的投影，共享同一套 service 层
Agent 层  research agent（唯一用户可见）+ 任务型子代理（explore/execute/review）
          会话模式：chat / coexplore
          双层 prompt：provider-neutral 契约 + agent workflow
             ↓
Daemon    permit set · 凭据服务（唯一持凭据进程）· Project 管理
          Record/Artifact 存储 · 执行记录 · Reviewer
             ↓
能力层    Kernel(Python stateful) · Connector×17 · SimulationPlatform×2 · WetLabBackend×2
             ↓
存储层    ~/.spark-research/projects/<slug>/{project.json, records.db, library.db,
          artifacts/, papers/, experiments/}  ·  credentials.json (0600, daemon-only)
          ·  config.json（配置真源，env > file > 默认）
```

### 架构决策（ADR，完整列表见 DESIGN §5.2）

| # | 决策 | 理由 |
|---|------|------|
| AD-1 | Project 为持久层根 | 科研单位是课题 |
| AD-2 | 凭据只在 daemon 进程，kernel 经 `mcp_call` 代访问 | 源于对 OpenScience 沙箱的实测：它的三层隔离使自定义付费数据源无法在 agent 内使用，只能 fork。我们把这个教训变成原生设计 |
| AD-3 | Record 与 Artifact 同图不同表，id 互链 | 复用已验证的 lineage 机制 |
| AD-4 | SimulationPlatform 独立于 Connector | connector 是幂等数据读取，仿真是长任务生命周期 |
| AD-5 | 技能少而深：每个技能必须有配套验证才算完成 | 对 OpenScience 313 技能「质量参差」的差异化回应。P9 起 `SKILL.md` 的 `validation` 字段由 CI 去磁盘核对 |
| AD-6 | 湿实验执行前强制人工 approve | 安全门通过是必要非充分条件 |
| AD-7 | 前端 vanilla → P7 迁 SolidJS，API 先行 | CLI/API 是能力真源，UI 是投影 |
| AD-8 | 模型结论要被确定性代码约束 | 不能既当运动员又当裁判 |
| AD-9 | **MCP 暴露面按「谁承担后果」切**（P9 新增） | 审批类动作不做成工具，否则 approve gate 退化成注释。见 §5 |

---

## 3. 五大功能域与实现状态

| 域 | 能力 | 状态 |
|----|------|------|
| **A 文献调研与写作** | 多源统一检索（OpenAlex/CrossRef/EuropePMC/S2 + AMiner 带凭据）、DOI+标题模糊去重、项目文献库、PDF 下载管线、BibTeX/CSL 导出、精读卡、综述草稿 | ✅ P2/P3 |
| **B 实验验证** | 干：SimulationPlatform 契约 + OpenMM（真实 MD）+ pyref（确定性参考实现）+ 7 态状态机 + 断点续跑；湿：自然语言→Opentrons Protocol API v2 编译 + 4 条安全规则 + approve gate + 真模拟器执行 | ✅ P5/P6 |
| **C 全流程记录** | 8 类 record + 5 类边的证据图、时间线、证据子图、Markdown 报告导出 | ✅ P1/P7/P8 |
| **D 创新性验证** | claim 提取 → 密集检索 → 对比报告 → 评级 + 确定性评级校验层 | ✅ P4 |
| **E 结论与评审** | citation-integrity + 结论卡 review 门槛 + data-consistency + capability-labeling + stats-plausibility | ✅ P3/P8 |
| **扩展面** | 六个扩展点文档 + 脚手架 + 能力自描述 + MCP + 配置收口 + llms.txt | ✅ P9 |

---

## 4. 工程方法（本项目的特色，也是评审时可攻击的面）

**对抗测试优先于 happy path**。每个涉及可信度的功能都配对抗用例：
- 引用核验：3 种伪造模式（编造 key / 真 key 假内容 / 库外真文献）× 3 变体 = **9/9 检出**，外加 4 个阴性对照防误杀
- 安全门：超浓度 / 不兼容试剂 / 超 BSL / 单次溢孔 / **累计溢孔**（单看每步都合法）+ 绕过状态机直改协议原文（被协议 hash 复核拦下）
- Novelty 评级：反向对抗——fake LLM 硬说已发表工作是 novel，被确定性校验层**按证据升级为 existing**；反之硬说杜撰组合是 existing 则降级。这就是 AD-8
- MCP 暴露面（P9 新增）：**结构性防线**——遍历全部已暴露工具的请求构造函数，断言没有一个能打到审批类端点。比「工具名里没有 approve」强得多

**真实验证一次，fixture 回放到永远**。真实网络/仿真跑通后录制，CI 只回放。真实验证抓到的 bug 包括：EuropePMC 官方 PDF 端点已死、bibtex key 因随机排序在两次运行间**互换**（会让引用悄悄指错论文）、fixture 录制器把超大响应截断成坏 JSON。

**诚实记录不可复现性**。OpenMM 同一 spec 三次运行 E_min 各不相同（CPU 多线程浮点归约）→ 抽象成 `deterministic` 能力位写进 record，下游据此区分「逐位对账」与「区间对账」。同理 Opentrons 模拟读数全 0.0 → `simulated` 位。

**让模板承载纪律**（P9 新增）。脚手架生成的模板里注释比代码多：connector 的凭据降级要回「未配置」而不是抛错、platform 的 runner 必须写完结果再写 `done.json`、skill 必须有配套验证。这些是 P2–P6 实测踩出来的，靠读文档记不住。同一轮里，让 CI 真跑生成物这条测试立刻抓到了三个模板缺陷。

---

## 5. P9 新增面：扩展性与外部 agent 接入

评审这一部分时最值得看的是**边界怎么划**。

**能力自描述必须从注册表生成**。`spark-research capabilities [--json]` 的每一项都来自真实注册表，并由双向一致性测试守着：正向「清单里的每一项可实例化」，反向「注册表里的每一项都在清单里」。反向那条防的是更隐蔽的漂移——静默漏项。可用性刻意分两档：静态档零 IO 永远可算，探测档才 spawn 子进程；不探测时如实写 `unknown`，不假装 `available`。

**MCP 暴露面按「谁承担后果」切（AD-9）**。`lab approve` / `lab reject` / `lab simulate` / `conclusion review` / `project archive` 不做成工具。理由不是「怕出错」，是 AD-6 的字面含义：若外部 agent 能自己批准，它就能自己编译协议、自己批准、自己执行。三条落地要求：

1. 不暴露清单是**显式数据**（`MCP_WITHHELD`），进 capabilities 输出与 server instructions——外部 agent 一眼看到边界，而不是调用失败后自己猜；
2. 相邻的**只读**能力照常开放（`lab_status`、`conclusion_get` 的预评估）——拒绝要精确，不要一刀切；
3. `lab_compile` 停在 `awaiting_approval` 并在返回体里写清「需要人执行哪条命令」——把人拉回环里，而不是甩一句「无权限」。

**长任务在 MCP 层默认同步**。P7 的 HTTP 层是 202 + 句柄语义（给浏览器的）；外部 agent 的心智应当是「调用 → 拿结果」。所以 MCP 层自己轮询到落定，只有超时才降级成句柄 + `task_status` 提示，并说明任务仍在后台跑。

**工具描述有写法标准且进测试**：每条必须含「何时调 / 参数示例 / 何时不该用 / 典型链路」四段。反面教材是 `"Search literature. Args: query (string)"`。

---

## 6. 代码库导航

| 路径 | 职责 | 规模（行） |
|------|------|-----------|
| `backend/src/project/` | Project 管理、records 证据图 | 880 |
| `backend/src/literature/` | 统一检索、文献库、PDF、精读卡、综述、导出 | 2670 |
| `backend/src/ideation/` | Idea 卡、思路库、相似度、novelty pipeline | 1969 |
| `backend/src/experiment/` | 干实验闭环状态机 | 1112 |
| `backend/src/simulation/` | SimulationPlatform 契约 + OpenMM/pyref | 869 (+py) |
| `backend/src/lab/` | 协议编译、安全门、湿实验状态机、Opentrons 后端 | 3479 |
| `backend/src/reviewer/` | veto 机制、citation-integrity、结论卡检查器 | 1058 |
| `backend/src/connectors/` | 17 个数据源 + registry | 1070 |
| `backend/src/server/` | 66 路由、SSE、长任务句柄 | 2400 |
| `backend/src/mcp/` | MCP server + 24 个工具定义 | 896 |
| `backend/src/capabilities/` | 能力自描述（从注册表生成） | 478 |
| `backend/src/scaffold/` | 三种扩展点的脚手架模板 | 732 |
| `backend/src/config/` | 用户配置面（设置表是单一真源） | 474 |
| `backend/src/daemon/` | permit set、凭据服务 | 465 |
| `frontend/workspace/src/` | SolidJS 工作台（零运行时第三方库） | 3417 |

**建议的阅读顺序**：`DESIGN.md` → `project/records.ts`（证据图是全局枢纽）→ `reviewer/rules.ts`（可信度机制）→ 任一域的 pipeline（`literature/review.ts` 或 `ideation/novelty.ts`）→ `experiment/loop.ts` + `lab/wet_loop.ts`（两个状态机）→ `mcp/tools.ts`（对外暴露面与边界）。

---

## 7. 未完成与已知缺陷（完整清单见 BACKLOG.md）

**已知缺陷（我们自己发现并记录的）**：
- Semantic Scholar 匿名请求持续 429（7 次尝试全挂），实际需要 API key。已作为 `caveat` 写进 connector 元数据并透出到 capabilities
- Novelty 相似度是**词面**而非语义（覆盖率 + 中文二元组），阈值 0.75，标定样本仅 2 个 claim，最近邻余量 0.08
- 真实模型下「真 key 假内容」的判准率：precision 全档 100%，easy/medium recall 100%，**hard 档 recall 71–100%**（P8-G5 实测，5 次运行）
- kimi-k2.6 每轮有 2–6% 的判定只吐思维链、`content` 里没有 JSON。已加重试，根治要 `response_format` 支持（V12）
- HTTP 层 approve 的 actor 是「谁自称就是谁」，单用户本地诚实，**多用户前必须换真实身份认证**（V10）
- 长任务句柄不落盘，进程重启后任务列表丢失（实验状态本身在磁盘上，可 resume）（V11）
- SSE 是生命周期事件而非 token 流；MCP 长任务的进度同样不回传（V17）
- **WetLabBackend 的 `execute()` 入参是 `OpentronsProgram`**——接非 Opentrons 设备族时需要把设备语言编译下沉进 backend。P9 已把五步施工说明写进 EXTENDING 第 4 节，但**代码尚未重构**（V6，等第二设备族选定）
- arXiv/PubMed 尚未接入统一检索（缺 XML parser）；CNKI/万方仍是占位（无公开 API）
- 中文检索式召回极差，novelty 的检索式限定英文
- 位置加权豁免靠调用路径隔离而非显式白名单（V14）
- `capabilities --probe` 每次都 spawn 子进程，无缓存（V18）
- P9 引入的 deprecated 别名（`MCPConnector` 等）待 v0.3 移除（V15）

**流程事故（已记录在 devlog）**：P6 期间主会话在共享工作树切分支，把子代理半成品卷进 docs PR 推上 main，绕过审查门 → 新增工作树隔离纪律。P7 期间 worktree 目录中途变为不可访问导致未提交成果全丢 → 新增 worktree 路径与「阶段性成果及时推送」纪律。P9 期间子代理再次因额度中断在零 commit 状态下暂停，成果险些全失 → 「每个逻辑块 commit + push」从建议升级为执行前置动作。

---

## 8. 希望评审重点看的问题

按我们自己的不确定程度排序。**发现不在此列的问题，价值最大**。

1. **证据图的设计是否站得住**：8 类 record + 5 类边能否覆盖真实科研流程？边方向约定（`supports`/`contradicts` 是 paper→idea，`cites` 是新产物→旧文献）是否会在图遍历时造成歧义？`RecordStore.update()` 允许改 content 是否破坏了「可审计证据链」的承诺？
2. **可信度机制是否真的可信**：citation-integrity + 评级校验层 + 安全门 + 结论卡三检查器，这套「用确定性代码约束 LLM 输出」的路子，边界在哪里？哪些地方我们其实还是在信任 LLM 而不自知？
3. **两个状态机的口径**：干实验 7 态、湿实验 11 态；湿实验 `approve` 直达 `wet_run`（无 approved 中间态）、「进入 compile 一律清空 approve」、唯一守卫回边 `wet_run→compile`。这套口径有没有能绕过审批的路径？
4. **MCP 边界的划法（P9 新增，最想被挑战）**：把审批类动作挡在 MCP 之外，是真安全还是安全剧场？一个外部 agent 完全可以直接 `Bash` 调 `spark-research lab approve --actor 它自己编的名字`——我们挡住的到底是什么？我们的回答是「挡住的是**默认路径**与**责任归属**：MCP 工具是 agent 的第一反应，而绕道 shell 是一个显式的、留痕的、用户能在 permission 层看见的动作；`actorSource` 也会如实记录来源」。这个回答够不够？
5. **抽象是否过早或过晚**：SimulationPlatform 由两个实现验证过；WetLabBackend 只有 Opentrons 一族（已知重构点）；Connector 契约承载 17 个源。哪个抽象是错的？
6. **扩展面的赌注（P9 新增）**：我们赌「模板承载纪律」比「文档陈述纪律」有效，所以脚手架的注释比代码多、CI 真跑生成物。这个赌注对吗？还是说没人会用脚手架，真正的扩展者都会直接抄现成实现？
7. **相对参照系的判断**：不吸收 OpenScience 的 313 技能铺量路线而走「少而深 + 每技能 e2e」，这个赌注对吗？Project-centric 是真需求还是过度设计？
8. **安全边界**：凭据只在 daemon（AD-2）、Markdown 渲染是唯一 innerHTML 写入点（已审计 + 10 个 XSS 回归测试）、协议 hash 复核、MCP 结构性防线。还有哪些面没覆盖？

---

## 9. 如何跑起来

```bash
git clone https://github.com/jimmyag2026-prog/spark-research && cd spark-research
bun install && bun run typecheck
bun test tests/unit/                       # 824 pass（17 skip：环境相关）
.venv/bin/python -m pytest tests/ -q       # 48 passed（需先建 .venv 装 openmm/opentrons）
bun run test:e2e                           # Playwright 12 pass（需 bunx playwright install chromium）
bun run check:llms                         # llms.txt 是否与文档同步

bun run dev                                # 工作台 http://127.0.0.1:4321
spark-research capabilities                # 这台机器上有什么
spark-research mcp                         # 作为 MCP 工具箱接入外部 agent
```

CLI 入口：`project` / `lit` / `idea` / `exp` / `lab` / `conclusion` / `report` / `capabilities` / `config` / `new` / `mcp`。
