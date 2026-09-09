# Spark Research v0.3.0 开发方案

> 制订时间：2026-09-09（PDT）
> 输入：`spark-research_review报告.md`（外部评审，对象 main `b4aab02` + P8）、
> `ClaudeScience_vs_OpenScience_架构与功能对比.md`（参照系调研）、v0.2 全量代码复核
> 基线：main `4b0ebd5`（P8 已合）+ `feat/p9-extensibility`（config / capabilities / MCP server /
> SKILL frontmatter 已提交，scaffold 在途）——**本方案假定 P9 合入并打出 `v0.2.0` 之后开工**
> 目标口径（用户原话）：*做到和 OpenScience 一样的功能和易用性，并在此基础上有自己的特色，
> 扩展性尽量对比 OpenScience 并有更优的设计*

---

## 〇、一句话方案

**v0.2 把「数据与纪律」做扎实了，v0.3 补「运行时与生态」这条最短的板——
用 OpenScience 的形态（npx 秒装、默认 Web、模型中立、真委派、插件扩展）追平易用性，
再用 spark 自己的确定性纪律（图上判完成、契约化验收扩展、能力声称机器可核）在同样的形态上超车。**

评审给出的战略结论是「优势全在随年限增值的数据层，劣势全在随行业速度贬值的运行时层」。
v0.3 就是唯一一次把运行时债一次性还清的窗口——**再往后每加一个功能域，都要在坏地基上加一遍**。

---

## 一、从评审到版本主题

### 1.1 评审的三个核心判断，与 v0.3 的对应

| 评审判断 | v0.3 回应 |
|---|---|
| **裂缝一：叙事超前于实现**——Agent 层三大卖点（swarm / 子代理 / permit set）停留在数据结构 | 主线 A：把子代理做成真委派（ToolBus + tool loop），permit set 变成真消费方；swarm 删除；并新增 **CI 级的「叙事一致性门禁」**，让这类落差以后不可能再攒到评审才发现 |
| **裂缝二：并发与超时的工程基本功缺口**——单线程测试永远测不出 | 闸门 D：P0 竞态 / 全链路超时 / CAS / stderr 排空一次清完，并新增 `tests/concurrency/` 与「假上游挂起」测试层，把这个维度永久纳入 CI |
| **差异化方向判断正确，值得坚持** | 主线 C：把「确定性纪律」从域管线推广到**编排层**（图上判完成）与**扩展层**（契约化验收）——这两处两个参照系都没有 |

### 1.2 v0.3 明确不做（防止范围蔓延）

| 不做 | 理由 |
|---|---|
| 追 OpenScience 的 313 skills / 46 connector 数量 | AD-5「少而深」不变。v0.3 解决的是**让用户自己 30 分钟加一个**，不是我们加 46 个 |
| 多用户真实身份认证（BACKLOG V10） | 单用户本地场景下 `actorSource` 已诚实；上多用户前先把 agent 层做实，否则是给空架子加锁 |
| 物理 Opentrons 对接（V6） | **硬前置**：安全门声明必须先兑现（闸门 D-8）。评审原话「过度声明的安全门比没有安全门更危险」 |
| 插件市场 / 远端扩展仓库 | 先有装载与验收机制，再谈分发。v0.3 只做本地目录装载 |
| 远端算力真实实现（V4） | 按真实需求拉动，无课题拉动就不做 |

---

## 二、总体结构：一道闸门 + 三条主线 + 一条附线

```
                    ┌──────────────── 闸门 D：债务清算（不清完不开工）─────────────────┐
                    │ 并发竞态 · 全链路超时 · 静默失败 · 权限口径 · 安全门声明收敛        │
                    └────────────────────────────┬──────────────────────────────────┘
                                                 │
                              ┌──────────────────┴──────────────────┐
                              │  P11 LLM Runtime v2（A/B/C 共同地基）  │
                              │  provider 适配层 · tool calling ·      │
                              │  usage 记账 · 超时重试 · 流式 · JSON 模式│
                              └──────────────────┬──────────────────┘
                     ┌───────────────────────────┼───────────────────────────┐
                     │                           │                           │
        ┌────────────▼───────────┐  ┌────────────▼───────────┐  ┌────────────▼───────────┐
        │ 主线 A：Agent Runtime   │  │ 主线 B：上手性追平       │  │ 主线 C：扩展性超车       │
        │ P12 ToolBus + 真子代理  │  │ P14 npx/单二进制        │  │ P15 扩展装载 + 声明式    │
        │ P13 contract/replan/   │  │     零参数起 UI · 向导   │  │     connector · MCP     │
        │     记账 · findings     │  │     依赖分层 · demo     │  │     client · 契约化验收  │
        │     状态机              │  │     本地模型 · SSE 流    │  │                         │
        └────────────┬───────────┘  └────────────┬───────────┘  └────────────┬───────────┘
                     └───────────────────────────┼───────────────────────────┘
                                    ┌────────────▼───────────┐
                                    │ 附线 E：P16 文献域补强   │
                                    │ （同时是主线 C 的首个    │
                                    │   真实用户：arXiv/PubMed │
                                    │   用声明式 connector 加）│
                                    └────────────┬───────────┘
                                            v0.3.0 发布
```

**为什么这个顺序**：
1. 闸门 D 在最前，因为**编排就是并发**——不修 C-1 竞态，主线 A 每一次并发委派都在静默出错，而且测不出来。
2. P11 在三条主线之前，因为 tool calling（A）、流式输出（B）、外部工具注册（C）、结构化输出（BACKLOG V12）**共用同一个 LLM 抽象**。先分头做三遍适配层是本方案最容易犯的错。
3. 附线 E 放最后不是因为不重要，而是它要**当主线 C 的验收用例**：如果 arXiv/PubMed 不能用声明式 manifest 加进来，说明扩展机制设计失败——这是比任何单测都硬的验收。

---

## 三、闸门 D：债务清算（P10）

> **门禁语义**：D 全绿之前，P11 及之后的任何功能代码不合入 main。
> 全部是评审第一/第二优先项。量级：2–3 个会话，4 条 lane 并行（见 §6.3.2）。

| # | 项 | 位置 | 做法 | 验收 |
|---|---|---|---|---|
| D-1 | **P0 并发竞态**：`__handlingTool` 实例级状态在并发下静默绕过参数映射 | `connectors/base.ts:56,78-86` | 去掉「同名方法即 handler」魔法分发，改**显式 handler 注册表**（子类构造时 `this.handle("search", this.searchImpl)`）；`call()` 不再依赖任何实例可变状态 | `tests/concurrency/connector_race.test.ts`：单实例 100 并发混合工具调用，断言每个请求的最终 URL/参数与串行结果逐位一致 |
| D-2 | **全链路超时**：`http/client.ts` 裸 fetch、LLM 调用、`PythonKernel.execute`、TaskRegistry 全部无超时 | `http/client.ts` · `llm/` · `kernels/` · `server/tasks.ts` | 每层一个显式 `timeoutMs`（默认进 `config.json`，HTTP 30s / LLM 120s / kernel 由调用方给）；用 `AbortController`；超时是**可见错误**不是静默返回 | 「假上游挂起」测试层：注入永不响应的 HttpClient / LLM / kernel，断言四个入口都在 N 秒内返回 `timeout` 错误而非挂死 |
| D-3 | **kernel stderr 从不排空** → 长会话写满 64KB 管道缓冲后永久死锁 | `kernels/manager.ts:37-49` | 照抄 `lab/wet_backend.ts:206` 已有的正确写法 | 单测：向 kernel 打 1MB stderr 后仍能正常 execute |
| D-4 | **LLM 失败被静默当成功** | `agents/orchestrator.ts:290,318,412` | **类型层根治**（不止加 `if`）：`LlmResponse.ok=false` 时 `content` 恒为空串，错误只在 `error` 字段——让「把错误文本当产出」在编译期就不可能。见 §4.1 | 单测：FakeLLM 返回失败 → orchestrator 该任务 `ok:false`，summary 不含错误文本，review 不放行 |
| D-5 | `kernelManager.dispose()` 全局摧毁内核，并发会话互杀 | `agents/orchestrator.ts:325-335` | `dispose(kernelId)` 单内核 | `tests/concurrency/kernel_isolation.test.ts`：两 session 交错执行，各自 kernel 存活 |
| D-6 | **config.json 0644 存 LLM API key**（比 connector 凭据的 0600 还弱） | `index.ts:55-58,71` · `config/index.ts:177` | 照抄 `daemon/credentials.ts` 的 `mode: 0o600 + chmodSync`；启动时检测过宽权限并告警 | 单测断言写入后 `stat` 为 0600；已存在的宽权限文件被收紧 |
| D-7 | **无 Origin/Host 校验 + `jsonBody` 不查 Content-Type** → 恶意网页可 `text/plain` 跨站 POST `/approve` | `server/app.ts` · `http/` | 本地默认只信 `localhost`/`127.0.0.1` Origin 白名单（可配）；写端点强制 `application/json` | 对抗测试：伪造 Origin、缺 Content-Type、`text/plain` 三种跨站写请求全部 403 |
| D-8 | **安全门声明收敛**（接真机前的硬门槛） | `lab/` | 二选一并写死在文档与 CLI 输出：**(a)** 补 NL→浓度/BSL 解析 + 试剂词表扩到英文/分子式 + 续句试剂合并 + **未消费参数告警**；**(b)** 把口径降为「当前安全门仅对中文关键词命中试剂与体积生效」。**推荐 (a) 的最小版 + 强制 (b) 的告警**：解析器新增「本句有未被任何规则消费的量纲/试剂」→ 编译产物带 `unconsumed` 警告，审批界面必须显示 | 对抗矩阵扩到英文/分子式协议；「用户写了但安全门没看见」的用例必须产出可见告警而非静默绿灯 |
| D-9 | **状态机无乐观并发控制** → 一次批准并发执行两次 | `project/records.ts:181-192` | `UPDATE ... WHERE id=? AND rev=?` + rev 自增；experiment record 的 `state`/`approval` 写入加来源校验 | `tests/concurrency/approve_once.test.ts`：并发 N 次 `POST /simulate` 同一获批协议，断言恰好 1 次执行、其余 409 |
| D-10 | wet 状态机 `wet_run` 合并「已批待执行」与「执行中」；approval 跨崩溃存活 → 重启后免审批重跑 | `lab/` | 拆 `approved` / `executing` 两态；approval **一次性消费**（重跑需再批） | 崩溃恢复用例：批准 → SIGKILL → 重启 → 断言需要重新审批 |
| D-11 | 文档漂移一次清 | `docs/` `README` `SKILL.md` | connector 数 17（非 18）；SKILL.md 里已被代码证伪的 EuropePMC 死端点；版本号三处两值统一到 `version.ts` | §7 的叙事一致性测试（见 D-12）自动拦截 |
| D-12 | **新增：叙事一致性门禁** | `tests/unit/narrative_parity.test.ts` | README/DESIGN 中每条能力声称，必须在 `capabilities --json` 里有对应条目且 `status` 与实际注册表一致；孤儿模块（无生产调用方，仅自测试引用）在 CI 报错 | 用当前的 `swarm.ts` 当阴性对照：删除前该测试必须能把它抓出来 |

**闸门退出标准**：D-1…D-12 全绿 + `tests/concurrency/` 新增套件全绿 + 现有 655 用例不回归。

---

## 四、主线代码架构设计

### 4.1 P11 · LLM Runtime v2（A/B/C 共同地基）

**为什么它必须先做**：评审没点出、但复核实测发现的一条**新的名实落差**——
`SUPPORTED_PROVIDERS` 声明 6 个 provider（kimi/openai/anthropic/deepseek/qwen/openrouter），
`call()` 里**只有 `callOpenRouter` 与 `callKimi` 两个实现**，其余四个静默落到 OpenRouter 或失败。
DESIGN §5.4「保持模型无关」与 OpenScience 的「模型中立」在这里差距最大，而**模型中立恰是 OpenScience 最被引用的卖点**。

同时，tool calling（主线 A 的前提）、streaming（主线 B 的 SSE token 流）、
外部工具注册（主线 C）、`response_format` JSON 模式（BACKLOG V12）、
usage 记账（主线 A 的帧级账本）——**五件事共用同一个抽象**。

```
backend/src/llm/
  types.ts            # ChatMessage(+tool role) / ToolSpec / ToolCall / Usage / LlmResponse
  router.ts           # 门面：模型名 → provider adapter；保留现有 call() 签名向后兼容
  providers/
    registry.ts       # provider 声明表：baseUrl / envKey / 能力位（capabilities 自描述的数据源）
    openai_compat.ts  # 一套代码覆盖 openai / deepseek / qwen / kimi / openrouter /
                      # ollama / vLLM / 任意自建 baseUrl —— 「模型中立」的真正落点
    anthropic.ts      # 原生 messages API（tool_use / tool_result 形状与 OpenAI 不同，必须独立）
  budget.ts           # 预算句柄：token / 成本 / 调用数上限，跨子代理传递
```

```ts
// types.ts —— 关键设计在于「失败时没有内容可用」
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec { name: string; description: string; inputSchema: JsonSchema }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }

export interface CallOptions {
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | { name: string };
  responseFormat?: "text" | "json_object" | { jsonSchema: JsonSchema };  // BACKLOG V12 根治
  timeoutMs?: number;          // 无默认值不许调用（D-2 的强制点）
  maxRetries?: number;         // 仅对 retryable 错误
  signal?: AbortSignal;
  budget?: BudgetHandle;
  onDelta?: (chunk: string) => void;   // 流式；不传即非流式（主线 B 的 SSE 接这里）
}

export interface LlmResponse {
  ok: boolean;
  provider: string; model: string;
  /** ok=false 时**恒为空串**。错误只在 error 字段——F-2 的类型层根治 */
  content: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  finishReason?: string;
  error?: { kind: "auth"|"rate_limit"|"timeout"|"parse"|"upstream"; message: string; retryable: boolean };
}
```

**provider 能力位**随 `capabilities --json` 透出：
`{ toolCalling, jsonMode, streaming, usageReported }`——外部 agent 在选模型**之前**就知道
这个模型能不能跑 tool loop，而不是跑到一半发现不支持。这条与 P9 的 `caveat` 字段同哲学。

**本地模型兜底**（主线 B 的免 key 路径，学 OpenScience「本地端点永远 BYOK 不挡」）：
`config.json` 支持 `providers.local = { baseUrl, model, apiKey?: null }`；
`spark-research doctor` 主动探测 `localhost:11434`（Ollama）并在向导里提示。

**成本表**：`registry.ts` 内置各模型单价（可被 config 覆盖），拿不到 usage 时
`costUsd: null` 并标 `usageUnavailable` ——**不填 0 冒充免费**（诚实记录文化的延伸）。

---

### 4.2 P12 · AgentToolBus + 真子代理（主线 A 第一步）

#### 4.2.1 ToolBus：把 P9 已建好的管道接通

P9 的 `McpToolRunner`（`backend/src/mcp/server.ts`）已经是一条**进程内的统一工具总线**——
每个工具就是对 P7 HTTP app 的一次 `app.fetch()`，CLI/HTTP/UI/MCP 四入口共享同一套 service 层。
**主线 A 不造新轮子，只在它外面套三层：授权、预算、审计。**

```
backend/src/agents/toolbus.ts
```

```ts
export interface ToolBusOptions {
  runner: McpToolRunner;        // P9 已有
  grants: string[];             // 白名单工具名 —— permit set 的第一个真正消费方（AD-2 兑现）
  budget: BudgetLedger;         // 调用数 / 墙钟 / token 上限
  audit: (e: ToolAuditEntry) => void;   // 每次调用落一条执行记录
  timeoutMs: number;
  extraTools?: ExternalToolSpec[];      // 主线 C：外部 MCP server 注册进来的工具
}

export class AgentToolBus {
  /** 给 LLM 的 tools 定义。与 capabilities --json / MCP server **同源**（MCP_TOOLS），不另写一份 */
  specs(): ToolSpec[];
  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}
```

**三条硬规则**（都是可对抗测试的）：

1. **未授权工具 → 结构化拒绝，不抛异常**：
   返回 `{ ok:false, denied:"not_granted", granted:[...] }`——模型读得懂并能改道，
   而不是把一个异常堆栈塞回 context。
2. **`MCP_WITHHELD` 的危险动作（`lab_approve` / `conclusion_review` / `project_archive`）
   在 ToolBus 层同样拒绝**——**子代理永远不能自批准**。
   这是 AD-6「人工审批门」从 HTTP 层扩展到 agent 层，也是 v0.3 唯一不可协商的红线。
3. **每次调用落一条执行记录**（谁调的 / 参数摘要 / 耗时 / 结果规模 / 是否被拒）。
   Claude Science 的帧级记账在 spark 里天然是**图上的节点**——见 §4.4。

#### 4.2.2 子代理：从裸 `llm.call` 到真 tool loop

```ts
// backend/src/agents/subagent.ts（重写 sub_agent.ts）
export interface SubAgentSpec {
  name: string;
  type: "explore" | "execute" | "review" | "lab" | "literature";
  model: string;                 // 每类独立模型 —— DESIGN §5.4 的死字段终于有消费方
  promptFile: string;            // agents/prompt/<type>.txt，不再内联在 TS 里
  grants: string[];              // ToolBus 白名单
  budget: { maxToolCalls: number; maxTokens: number; maxWallMs: number };
  readOnly: boolean;             // review = true，硬约束（只读工具集 + 拒绝写工具）
}

export interface SubAgentResult {
  finalText: string;
  toolCalls: ToolAuditEntry[];
  usage: Usage;
  /** done | budget | timeout | denied | error —— **预算耗尽 ≠ 完成**，必须回流 */
  stopReason: StopReason;
}
```

循环：`llm.call(messages, {tools: bus.specs()})` → 有 `toolCalls` 则（受限并发）执行
→ 结果以 `role:"tool"` 消息回灌 → 再调 → 直到无 tool call 或触预算。

**默认 grants（安全默认值）**：

| 子代理 | grants | 刻意不给 |
|---|---|---|
| explore | `lit_search` `lit_list` `lit_read_cards` `records_timeline` `record_get` | 一切写入 |
| literature | explore 全套 + `lit_add` `lit_export` `lit_review_draft` | 实验与湿域 |
| execute | `exp_design` `exp_run` `exp_list` `task_status` `kernel_exec`(新增) | 湿域、审批 |
| lab | `lab_compile` `lab_status` | **`lab_approve` / `lab_simulate`——执行必须人批** |
| review | 只读：`record_get` `records_timeline` `conclusion_list` `conclusion_get` `report_export` | 一切写入与执行 |

#### 4.2.3 swarm 的处置：删除

`grep` 复核：`agents/swarm.ts` 在生产代码中**零调用方**，仅 `tests/unit/swarm.test.ts` 引用；
`dependsOn` 未实现；`decompose` 是三条正则。

**决定：删除 `swarm.ts` / `swarm_types.ts` 及其测试**，并发能力由 ToolBus 的受限并发池提供。
理由与 P8 删 `compute/providers.ts` 完全同构——「留着两套『提交任务』抽象只会让下一个人选错」。
README 中的「100 并发 swarm」宣传语在 D-12 的叙事门禁下也必须同步撤下。

---

### 4.3 P13 · Research Contract + Replan（主线 A 第二步，**超越点**）

#### 4.3.1 完成判定：学 OpenScience 的形，用 spark 的魂

OpenScience 的完成边界是 `contract.stages.every(status === 'completed')`——形态对，
但 stage 的 `completed` **由 agent 自报**。spark 有证据图，可以做得更硬：

```ts
// backend/src/agents/contract.ts
export interface ContractStage {
  id: string;
  description: string;
  /** 完成判据不问模型，问图：零 IO 之外只读证据图的纯查询 */
  check(q: EvidenceQuery): StageStatus;
}
export interface StageStatus { done: boolean; evidence: string[]; reason: string }
```

以 `literature-review` 契约为例：

| stage | 确定性判据（对证据图的查询） |
|---|---|
| `searched` | 本 session 新增 `paper` record ≥ 1 |
| `read_cards` | 进入综述的每篇 paper 都有对应 `reading` record（集合包含关系） |
| `citations_verified` | 存在 `citation-integrity` 的 review 记录，且零 hard finding |

> **写进 DESIGN 作 AD-10**：*任务完成判定必须由确定性代码对证据图查询得出，
> 不得由模型自报。* 这是 AD-8（模型给结论处必有确定性约束层）在**编排层**的直接推论——
> 两个参照系都没有等价物：Claude Science 是状态机驱动但判据在模型侧，
> OpenScience 是 stage 自报。

#### 4.3.2 观察反馈循环：从单发管线到真 agent

```
round = 0
while round < maxRounds:
    plan         = planner(goal, contract.progress(), lastObservations)
    outcomes     = execute(plan)              # 子代理 / ToolBus
    observations = distill(outcomes)          # 结构化对象，不是 200 字符截断
    if contract.allDone(): break
    if noProgress(2 rounds): break("no_progress")
    round += 1
```

两处关键设计：

- **`distill` 产出结构化 observation**（命中数 / 新增 record id / 错误类型 / stopReason），
  不再是 `output.slice(0,200)` 塞进 summary。**任务产出必须能回流决策**，
  这是评论「措辞过强的 research agent」的正面回应。
- **`noProgress` 是确定性判据**：连续两轮证据图无新增节点 → 停止并如实报告
  「N 轮无进展，契约未完成的 stage 是 X」。**宁可报未完成，不烧钱空转、不假装完成**。
  这条护栏两个参照系都没有明说。

#### 4.3.3 帧级记账：落进图，而不是另起一张表

Claude Science 的 `frames` 表带 `model`/`effort`/token/`total_cost`；
OpenScience 有 harness `fingerprint`。spark 已有证据图——**记账直接落图**：

新增第 9 类 record `agent_run`：

```
{ kind: "agent_run",
  agent, model, provider,
  systemHash, promptHash,              // ← 同时补上 OpenScience 的「harness 指纹」缺口
  usage: { inputTokens, outputTokens, costUsd | null, usageUnavailable? },
  toolCalls: n, stopReason, parentRunId }
```
边：`derives_from`（父 run → 子 run）；产物 record 挂 `agent_run` 的 id。

**一石三鸟**：
1. Claude Science 的帧级成本账 → 有了，且**可被 `report` / lineage / UI 时间线免费查询**（它们本就读图）；
2. OpenScience 的模型指纹可复现性 → 有了，novelty 报告与精读卡终于能回答「哪个模型、哪版 prompt 产的」；
3. 证据图第 15 个 record 类型的边际成本远低于第 5 个——架构复利在这里第一次兑现给 agent 层。

#### 4.3.4 findings 状态机：吸收 Claude Science 唯一明显领先的地方

```
backend/src/reviewer/findings_store.ts
findings(id, project, session, target, checker, severity, fingerprint,
         state: open|addressed|resolved|reflagged,
         evidence, note, reflagCount, firstSeenAt, lastSeenAt, resolvedBy)
```

- reviewer 每轮按 `(checker, target, fingerprint)` upsert 去重
- CLI：`spark-research review findings [--open]` / `mark-addressed <id> --note "..."`
- **复核闭环**：下一轮仍命中 → `reflagged` + `reflagCount++`；不再命中 → `resolved`
- soft finding 依旧不打断会话，但 `findings --open` 就是 Claude 的 `host.findings()` 等价物
  ——补上评审指出的「soft finding 缺主动查入口」

---

### 4.4 P14 · 上手性追平（主线 B）

| 项 | 现状 | v0.3 目标 | 对标 |
|---|---|---|---|
| 安装 | clone + `bun install` + uv + 手装 openmm/opentrons | `npx spark-research` / 单二进制（`bun build --compile` 脚本**已存在** package.json:12）/ Homebrew tap / curl 一键 | OpenScience `npx synsci` |
| 默认入口 | `bun run dev`（面向开发者） | `spark-research` 零参数 → 起 server + 开浏览器；CLI 降为高级入口 | OpenScience 默认行为 |
| Python 依赖 | 重且必装 | **三档分层**：`core`（零 Python）/ `science`（openmm）/ `lab`（opentrons）；首次用到才提示装哪条命令；`spark-research doctor` 报告缺哪层 | pyref 已是零依赖样板 |
| 首跑 | 没 key 时整条链路「成功」返回错误文本 | 闸门 D-4 已根治；`spark-research init` 向导：建项目 → 探测 provider（含本地 Ollama）→ 跑一次真实检索 → 展示证据图 → 打印下一步三条命令 | — |
| 零 key 体验 | 无 | `spark-research demo`：fixture 驱动的离线示例项目，**零网络零 key**，30 秒看到证据图 + 报告全貌 | — |
| 免 key 模型 | 无 | P11 的 `providers.local`（Ollama / OpenAI-compatible 端点），BYOK 永不挡 | OpenScience PR #135 口径 |
| Web 一等公民 | UI 是投影，novelty / dry-exp 要回 CLI | UI 内直接发起 novelty check / 干实验；长任务句柄落盘（V11）；**SSE token 流**（接 P11 的 `onDelta`） | OpenScience workspace |

---

### 4.5 P15 · 扩展面（主线 C，**换赛道的一步**）

OpenScience 的扩展优势是「46 connector + 插件运行时 + OpenAPI SDK + LSP + MCP client + 技能包目录」。
**正面拼数量必败**（评审 §10.3 已断言）。v0.3 换赛道：
**不比谁内置得多，比谁让用户自助加得快、且加完可信。**

#### 4.5.1 三种装载强度

```
~/.spark-research/extensions/<name>/
  extension.json     # manifest：kind / name / version / entry / requires / grants
  connector.json     # kind=connector 时的**声明式定义**（零 TS 代码）
  index.ts           # kind=skill|platform|backend|rule 时的实现
  SKILL.md           # P9 的 frontmatter 规范直接复用
  tests/             # 扩展自带验收用例（ext verify 会跑）
```

| 强度 | 形态 | 覆盖 | 安全性 |
|---|---|---|---|
| ① **声明式 connector（推荐默认）** | `connector.json`：baseUrl / tools / 参数映射 / 响应归一化映射（受限 JSONPath 子集） | 绝大多数 REST 文献与数据库源 | **不执行任意代码**，只跑受限映射；URL 走出站白名单校验（禁 `file://`、禁内网段，防 SSRF） |
| ② **TS 扩展** | skill / `SimulationPlatform` / `WetLabBackend` / 安全门规则 | 需要真逻辑的场景 | 同 UID 代码执行 → 装载需显式 `--trust`，首次打印 sha256 指纹并要求确认，manifest 记录指纹 |
| ③ **外部 MCP server 接入（反向 MCP client）** | `spark-research ext add-mcp <name> --cmd "..."` | 一次性接入整个 MCP 生态 | 外部工具注册进 ToolBus 与 `capabilities`，**每次调用同样落执行记录** |

> ③ 是相对 OpenScience 的**净增益**：它有 MCP client，但外部工具调用不进 provenance；
> spark 因为 ToolBus 统一审计，外部工具的每次调用天然落进证据图。

#### 4.5.2 契约化验收：spark 独有的设计

```
spark-research ext verify <path>
```

| 扩展类型 | 跑什么 |
|---|---|
| connector | Connector 契约测试：参数映射正确性、**并发不变式**（D-1 的回归套件直接复用）、凭据不落盘、错误消息不回显响应体 |
| platform | **直接复用 P5 已有的 `SimulationPlatform` 契约测试套件**（prepare/submit/poll/collect）——AD-4 当初「两个实现验证接口」的投资在这里第二次回本 |
| rule | 纯函数性检查：零 IO、确定性（同输入两次同输出）、无外部状态 |
| skill | P9 的 frontmatter schema 校验 + 声明的 e2e 存在且能跑（AD-5 的机器化） |

> **写进 DESIGN 作 AD-11**：*扩展「能装上」不算装好，「过得了对应契约测试」才算装好。*
> 这把 AD-5（技能必须有 e2e 才算完成）从**开发侧纪律**变成了**运行时门禁**，
> 也是对 OpenScience「313 技能质量参差」的结构性回答——
> 我们不限制数量，我们限制**未经验证的数量**。

#### 4.5.3 扩展的凭据与权限边界（AD-2 的延伸）

- 扩展**默认拿不到任何凭据**；需在 manifest 声明 `requires.credentials: ["<id>"]`，
  用户执行 `ext grant <name>` 后才由 CredentialStore 代访问——**值本体仍不出 daemon**。
- 扩展的 ToolBus grants 同样 manifest 声明 + 用户批准，与子代理走同一套授权代码。
- 扩展抛异常/崩溃**不得拖垮主进程**：装载与调用都在错误边界内，失败降级为
  「该扩展不可用 + 原因」，并在 `capabilities` 里如实标 `status: "failed"`。

---

### 4.6 P16 · 文献域补强（附线 E，兼作主线 C 的验收）

评审判定：**综述环节三者第一，检索广度第三**。两件工程即可补齐。

| # | 项 | 做法 | 备注 |
|---|---|---|---|
| E-1 | **arXiv / PubMed 接入**（BACKLOG V1） | **用 §4.5 的声明式 connector manifest 实现**，不写 TS | 这是主线 C 最硬的验收：*如果两个最基础的源不能用 manifest 加进来，扩展机制就是失败的* |
| E-2 | citation judge 降本 | 按 `(key, sentence hash)` 去重 + 并发限流 + 失败重试一次 | 30 引用综述从 30 次串行往返砍一个量级；配合 P11 的 `response_format` 根治 V12 |
| E-3 | `mergeAuthors` 按下标配对 affiliation（张冠李戴，已复现） | 改按归一化姓名配对；完全同名补年份闸 | 元数据可信是文献库立身之本 |
| E-4 | S2「无 key 自动降级」承诺未实现 | 补凭据路径（`apiKeyRequired` 改真值）；无 key 时不再每次白撞 429 | BACKLOG D2 |
| E-5 | CJK 元数据 | bibtex key 保 Unicode（`\p{Script=Han}`）；中文标题 bigram 去重 | AMiner 中文优势才兑现 |
| E-6 | 删除论文留孤儿 record | 级联清理或标 `retracted` | 证据图不撒谎（配合 lineage 幻 id 返 404） |

---

## 五、验证方案

> 项目已有的「对抗测试优先于 happy path」「真实跑一次→录制→CI 永远回放」两条原则不变。
> v0.3 **新增四个测试层**，都是「单线程 happy path 永远测不出」的维度。

### 5.1 新增测试层

| 层 | 目录 | 内容 | 钉死什么 |
|---|---|---|---|
| **并发对抗** | `tests/concurrency/` | ① 单 connector 实例 100 并发混合工具 → 参数映射与串行逐位一致（D-1）② 并发 N 次 `/simulate` 同一获批协议 → 恰好 1 次执行、其余 409（D-9）③ 两 session 交错执行 → kernel 互不摧毁（D-5） | 评审 P0 与「一次批准多次执行」 |
| **挂起/超时** | `tests/timeout/` | 注入永不响应的 HttpClient / LLM / kernel，断言 CLI / HTTP / MCP / 子代理四个入口都在 N 秒内返回可见 `timeout` 错误 | E-2「任一上游挂起 = 永久卡死」 |
| **Agent loop 对抗** | `tests/unit/agent_loop/` | FakeLLM 脚本化 tool call 序列：① 越权工具被结构化拒绝 ② 预算耗尽 → `stopReason:"budget"` 而非 `done` ③ tool 结果真回灌（断言第二轮 prompt 含第一轮结果）④ **子代理调 `lab_approve` 必被拒**（红线） ⑤ LLM 返回失败 → 任务 `ok:false` 且 summary 不含错误文本（D-4） | 主线 A 的全部承诺 |
| **扩展恶意矩阵** | `tests/unit/extensions/` | ① manifest 声明 A 却调 B 工具 → 拒 ② 未 grant 却取凭据 → 拒 ③ 声明式 connector 里塞 `file://` / 内网地址 → 拒（SSRF） ④ 扩展抛异常 → 主进程存活、`capabilities` 标 `failed` ⑤ 未过 `ext verify` 的扩展装载时显式警告 | 主线 C 的安全边界 |

### 5.2 确定性判据的对抗测试（AD-10 的自证）

- **伪造完成**：FakeLLM 自称「综述已完成」，但图上无 `reading` record → `contract.allDone()` 必须为 false。
- **无进展停机**：连续两轮工具调用不产生新 record → 循环在第 2 轮停止，报告写明未完成的 stage。
- **记账诚实**：provider 不回 usage 时，`costUsd` 为 `null` 且标 `usageUnavailable`，**不得填 0**。

### 5.3 名实一致门禁（D-12，本次评审最大发现的根治）

`tests/unit/narrative_parity.test.ts`：
1. README / DESIGN 中每条能力声称 → `capabilities --json` 有对应条目，且 `status` 与实际注册表一致；
2. **孤儿模块检测**：生产代码零调用方、仅被自身测试引用的模块 → CI 报错
   （用删除前的 `swarm.ts` 当阴性对照，证明该测试真的能抓到）；
3. 数字类声称（connector 数 / 技能数 / 端点数）由脚本生成，**不允许手写**。

> **写进 DESIGN 作 AD-12**：*对外声称的每一项能力必须机器可核。*
> 评审说「越靠近可信度核心的代码质量越高，越靠近宣传语的代码越虚」——
> 这条 AD 就是不让这句话在 v0.4 再成立一次。

### 5.4 外部验收（版本级退出标准）

沿用 P9 已确立的「外部验收」形式，v0.3 加码：

1. **全新 Claude Code 会话（无本仓库上下文）**，仅凭 `npx spark-research mcp` + `llms.txt`，
   完成：检索文献入库 → 建 idea → novelty check → **发起一次干实验并读回结论**。
2. **干净机器（无 bun / 无 Python / 无 API key）**：`npx spark-research` →
   `demo` 项目 30 秒内看到证据图与报告。
3. **第三方视角加一个 connector**：按 `docs/EXTENDING.md` 用声明式 manifest 加一个
   全新数据源并通过 `ext verify`，全程不改仓库源码——**由未参与开发的人执行**。
4. `tests/concurrency/` 与 `tests/timeout/` 全绿；现有用例零回归。

---

## 六、路线、排期与执行方式

### 6.0 排期单位说明（重要）

**本方案不用「周」作单位。** v0.2 的实测节奏是：P0 设计定稿到 P9 收尾
（18.6k 行后端 TS + 3.1k 前端 + 13.5k 行测试 + 655 用例）**在 2026-09-09 一天之内完成**，
含一夜睡眠，实际工作时间约 15 小时。逐阶段墙钟：

```
00:52 P0 设计  →  01:08 P1(16m)  →  01:40 P2(32m)  →  02:07 P3(27m)  →  02:43 P4(36m)
      ⋯ 过夜 ⋯
09:12 P5  →  10:01 P6(49m)  →  13:24 P7(3h23，56 端点 + SolidJS + Playwright)
20:22 P8  →  21:33–22:09 P9 五个 commit(36m)
```

在这个 tempo 下「周」是没有意义的刻度。**阶段量级一律用「会话」计**
（一个会话 ≈ 一次完整的「范围确认 → 委派实现 → 跑测试 → 审代码 → 对照设计验收 → PR」循环，
对应 P1–P9 的 30 分钟至 3 小时不等）。

v0.3 比 v0.2 单位工作量更重（并发、新抽象层、更多对抗测试），
但阶段数相当——**整体量级：2–4 个工作日**。

### 6.1 阶段表

| 阶段 | 内容 | 量级 | 并行 lane | 主用模型 | 依赖 | 阶段门 |
|---|---|---|---|---|---|---|
| **P10** | 闸门 D：D-1…D-12 | 2–3 会话 | **4** | **Sonnet 5** | P9 合入 + `v0.2.0` tag | 并发/超时新套件全绿；655 用例零回归 |
| **P11** | LLM Runtime v2 | 2 会话 | 3（接口先行后） | **Opus 5** | P10 | provider 矩阵契约测试；tool calling / JSON 模式 / 流式 / usage 各一条真实录制回放 |
| **P12** | ToolBus + 真子代理；删 swarm | 2 会话 | 2 | **Opus 5** | P11 | Agent loop 对抗五条全过；README 宣传语与实现对齐（D-12 门禁） |
| **P13** | contract + replan + 帧级记账 + findings 状态机 | 2 会话 | 2 | **Opus 5** | P12 | AD-10 对抗测试（伪造完成 / 无进展停机 / 记账诚实）全过 |
| **P14** | 上手性：npx/单二进制/零参数 UI/向导/依赖分层/demo/本地模型/SSE 流 | 2 会话 | 2 | **Sonnet 5** | P11（流式） | 干净机器外部验收 ②通过 |
| **P15** | 扩展装载 + 声明式 connector + MCP client + `ext verify` | 2 会话 | 2 | **Opus 5** | P12（ToolBus） | 恶意扩展矩阵全过；`EXTENDING.md` 三类示例 CI 全绿 |
| **P16** | 文献域补强（arXiv/PubMed 走 manifest）+ 收口 + `v0.3.0` | 1–2 会话 | 3 | **Sonnet 5** | P15 | 外部验收 ①③④ 全过 |

**关键路径**：P10 → P11 → P12 → P13 → P16。
**P14 与 P12/P13 并行**（只依赖 P11 的流式），**P15 与 P13 并行**（只依赖 P12 的 ToolBus）——
两者都不占关键路径。

**可裁剪顺序**（若要提前发布）：P15 的 ③ MCP client → P14 的 Homebrew/curl → P13 的 findings 状态机。
**不可裁剪**：P10 全部、P11、P12、AD-10 的确定性完成判据——这四项是 v0.3 主题本身。

### 6.2 模型分配依据

不做全局切换，按**任务形状**分。依据来自评审自己的发现：

> 「越靠近可信度核心的代码质量越高，越靠近『AI Agent 平台』宣传语的代码越虚」

翻译成模型选型：v0.2 里质量高的地方是**规格明确的机械活**（状态机、fixture 纪律、对抗测试），
出问题的地方全在**设计判断的边界**上——connector 的魔法分发被判定为「坏抽象」（P0 根因）、
全链路零超时、LLM 失败静默当成功、Agent 层抽象建好但没接线。
**这些不是「写不出代码」，是品味与盲区。**

| 形状 | 阶段 | 模型 | 理由 |
|---|---|---|---|
| 照方抓药（评审已写明改哪个文件第几行） | P10 · P16 | Sonnet 5 | 12 项里 10 项规格完备，Opus 在这里是浪费；且这两阶段并行 lane 最多 |
| 规格清楚的工程活（打包 / 向导 / 依赖分层） | P14 | Sonnet 5 | — |
| 抽象设计（错了要返工三条主线） | P11 | Opus 5 | 一个抽象同时承载 tool calling / 流式 / 记账 / JSON 模式 |
| 抽象设计（v0.2 唯一被判「坏抽象」的那一层的继任者） | P12 | Opus 5 | 同一个位置栽过一次 |
| 原创设计（AD-10「完成判定问图不问模型」） | P13 | Opus 5 | v0.3 最有原创性的一条 |
| 安全边界设计 | P15 | Opus 5 | 错了就是 S-3「沙箱一行逃逸」那种过度声明 |

**关于单轮等待**：v0.2 的总吞吐不慢，若痛点是「一次回复等太久」，
先试 Opus 的 `/fast`（同一个 Opus、输出更快，**不降级到小模型**），而不是换模型。

### 6.3 并行开发方案

#### 6.3.1 地基已经具备（实测）

| 检查项 | 结论 |
|---|---|
| 测试状态隔离 | 全部 `mkdtempSync` 建临时工作区，`SPARK_RESEARCH_DATA_DIR` 可注入，**没有一个测试碰 `~/.spark-research`** |
| 端口占用 | 单元 / MCP / server 测试走 `app.fetch()` **进程内调用，不监听端口** |
| 唯一共享资源 | Playwright 固定端口 4399，但已有 `SPARK_E2E_PORT` 环境变量兜底 |

**结论：N 个 agent 同时跑 `bun test` 是安全的**，只需给每条 lane 分配不同的 `SPARK_E2E_PORT`。

#### 6.3.2 lane 划分与文件所有权

> **铁律：一个文件同一时刻只属于一条 lane。** 下表就是所有权登记，越界即冲突。

**P10（4 lane，Sonnet 5）**

| lane | 负责 | 独占文件 |
|---|---|---|
| `D-a` 连接器 | D-1 | `connectors/base.ts` `connectors/registry.ts` `connectors/*.ts` `tests/concurrency/connector_race.test.ts` |
| `D-b` 运行时管道 | D-2 D-3 D-5 D-4(战术版) V3 | `http/client.ts` `kernels/manager.ts` `server/tasks.ts` `agents/orchestrator.ts` `tests/timeout/**` |
| `D-c` 安全面 | D-6 D-7 | `index.ts`(auth 写入段) `config/index.ts` `server/app.ts` `http/body.ts` |
| `D-d` 湿域与状态机 | D-8 D-9 D-10 | `lab/**` `project/records.ts` `tests/concurrency/approve_once.test.ts` |

> D-4 在 P10 只做战术版（orchestrator 三处检查 `res.ok`）；
> **AD-13 的类型层根治在 P11 完成**（`ok=false ⇒ content=""`）——分两步是因为类型改动属 P11 的抽象。

**P11（接口先行 → 3 lane，Opus 5）**

| lane | 独占文件 |
|---|---|
| **接口先行**（必须先单独合入） | `llm/types.ts` + `llm/router.ts` 门面 |
| `R-a` OpenAI 兼容基座（含 ollama / vLLM / 本地端点） | `llm/providers/openai_compat.ts` |
| `R-b` Anthropic 原生 | `llm/providers/anthropic.ts` |
| `R-c` 记账与能力位 | `llm/budget.ts` `llm/providers/registry.ts` |

**P12（2 lane，Opus 5）**：`agents/toolbus.ts` ‖ `agents/subagent.ts` + `agents/prompt/*.txt` + 删 swarm
**P13（2 lane，Opus 5）**：`agents/contract.ts` + replan + `agents/ledger.ts` ‖ `reviewer/findings_store.ts` + CLI（**完全独立**）
**P14（2 lane，Sonnet 5）**：分发与打包 ‖ 向导 + demo + SSE 流
**P15（2 lane，Opus 5）**：扩展装载 + `ext verify` ‖ 声明式 connector + MCP client
**P16（3 lane，Sonnet 5）**：E-1 manifest 源 ‖ E-2 judge 降本 ‖ E-3…E-6 元数据修复

#### 6.3.3 四条纪律（前三条是 P6 事故的直接延伸）

1. **一 lane 一 worktree**：`~/Desktop/AI4S/spark-research-<lane>`，与现有 `-p9` / `-v03` 同惯例。
   **绝不共享工作树**——P6 那次就是主会话在共享工作树切分支，把子代理半成品卷进了 docs PR 推上 main
   （已入 repo 工程纪律第 7 条）。
2. **接口先行**：两条 lane 触及同一类型时，先落一个**只改接口**的小 PR 到 main，再 fan out。
   本方案已知的两处：P10 的 `HttpClient.RequestOptions.timeoutMs`（D-a 依赖 D-b）、
   P11 的 `llm/types.ts`（三条 lane 全依赖）。
3. **高冲突文件禁止 lane 触碰**：`CHANGELOG.md` / `BACKLOG.md` / `README.md` 一律由**收口 commit 统一写**；
   devlog 每 lane 写自己的 `docs/devlog/P10-<lane>.md`（分文件 = 零冲突）。
4. **多 lane 阶段走 integration 分支**：`lane → feat/P10-integration`（在这里跑全量测试）→ **一个 PR 进 main**。
   否则会出现「每个 PR 单独绿、合进 main 红」——这正是评审说的那类**单线程测不出的语义冲突**。

#### 6.3.4 两个必须记住的例外

- **D-12 叙事一致性门禁必须放在串行尾巴**。它是全局测试，
  在任何 lane 分支上都会因为看不见其他 lane 的改动而误报红。D-11 文档漂移同理。
- **真正的瓶颈是审查带宽，不是 agent 数量**。现有工作流是「主会话审代码 + 对照设计验收 → PR」，
  4 条 lane 同时产出就是 4 份 PR 等审。**这是并行度的上限**——所以本方案最多开到 4 条，不开 6–8 条。

#### 6.3.5 lane 启动清单（写进每份子代理任务书）

```
① git worktree add ~/Desktop/AI4S/spark-research-<lane> -b feat/<phase>-<lane> origin/main
② export SPARK_E2E_PORT=<4400 + lane 序号>
③ 只改所有权表里属于本 lane 的文件；越界先回报，不自行扩权
④ 不碰 CHANGELOG / BACKLOG / README；devlog 只写 docs/devlog/<phase>-<lane>.md
⑤ 提 PR 前跑**全量** bun test（不只是本 lane 的测试）+ bun run typecheck
⑥ 目标分支是 feat/<phase>-integration，不是 main
```

### 6.4 里程碑与外部可见价值

| 里程碑 | 完成即可对外说的话 |
|---|---|
| P10 末 | 「并发与超时下不会静默出错」——安全声明与实现一致 |
| P12 末 | 「子代理是真的会用工具的 agent」——撤下所有虚标宣传 |
| P13 末 | 「完成与否由证据图判定，不由模型自报」——**最值得写文章的一条** |
| P14 末 | 「一条 `npx` 命令，零 key 30 秒看到全貌」——易用性追平 |
| P15 末 | 「你自己加的数据源，装完就跑契约测试」——扩展性超车 |
| P16 / v0.3.0 | 五大功能域 + 真 agent runtime + 自助扩展，三者中唯一有干湿闭环 |

---

## 七、与两参照系的收敛表（v0.3 目标态）

| 维度 | OpenScience | Claude Science | v0.2 现状 | **v0.3 目标** |
|---|---|---|---|---|
| 安装分发 | `npx synsci` 秒装 | macOS App | clone + bun install | npx / 单二进制 / brew　**✅ 追平** |
| 默认入口 | 起 Web 工作区 | App | `bun run dev` | 零参数起 UI　**✅ 追平** |
| 模型中立 | 全 provider | 锁 Anthropic | 声明 6 实测 2 | OpenAI-compat 基座 + Anthropic + 本地　**✅ 追平** |
| 子代理委派 | `task` 工具真委派 | `host.delegate()` 帧树 | 裸 `llm.call` 无工具 | ToolBus 真委派 + 预算 + 审计　**✅ 追平** |
| 完成判定 | `contract.stages`（agent 自报） | 状态机（模型侧判据） | 无 | **图上确定性判据（AD-10）　🚀 超越两者** |
| 帧级记账 | 会话级 | 每帧 model/token/cost | 无 | **落进证据图，报告/lineage/UI 免费可查　🚀 超越** |
| 模型指纹 | harness fingerprint | — | 无 | `agent_run` record 带 systemHash/promptHash　**✅ 追平** |
| 审查持久化 | provenance claim | `verification_checks` 状态机 | 一次性 pass | findings 状态机 + 复核闭环　**✅ 追平 Claude** |
| 连接器 | 46 免 key | 无 registry | 17 | **不比数量：声明式 manifest + 外部扩展 + MCP client　🚀 换赛道** |
| 扩展机制 | 插件运行时 / SDK / LSP | agents 表 + MCP | 无 | 装载 + **契约化验收（AD-11）　🚀 超越** |
| 能力自描述 | docs / llms.txt | — | P9 `capabilities --json` | + **叙事一致性 CI 门禁（AD-12）　🚀 超越两者** |
| 干湿闭环 | 无 | 无 | 有（安全门打折） | 安全门兑现声明　**🚀 独占赛道** |

---

## 八、新增架构决策（待写入 DESIGN §5.2）

> **编号起点 AD-10**：P9 已经占用了 AD-9（「MCP 暴露面按『谁承担后果』切」），
> 本方案初稿写成 AD-9…AD-13 是撞号，已整体后移一位。

| # | 决策 | 理由 |
|---|---|---|
| **AD-10** | 任务完成判定必须由确定性代码对证据图查询得出，不得由模型自报 | AD-8 在编排层的直接推论；OpenScience 的 stage 自报与 Claude 的模型侧判据都有同一个洞：*agent 可以宣布自己完成了* |
| **AD-11** | 扩展「能装上」不算装好，「过得了对应契约测试」才算装好 | AD-5 从开发侧纪律升级为运行时门禁；对 OpenScience「铺量导致质量参差」的结构性回答——不限数量，限**未经验证**的数量 |
| **AD-12** | 对外声称的每一项能力必须机器可核（`capabilities --json` 为准，CI 门禁） | 本次评审最大发现是「叙事超前于实现」。靠人自觉不可持续，必须是门禁 |
| **AD-13** | LLM 调用失败时**没有内容可用**（`ok=false ⇒ content=""`，错误只在 `error` 字段） | F-2 的类型层根治：把「错误文本被当成产出」变成编译期不可能，而不是靠三处 `if` 记得写 |
| **AD-14** | 子代理**永远不能执行需要人工审批的动作**（`lab_approve` / `conclusion_review` / `project_archive` 在 ToolBus 层硬拒） | AD-6 从 HTTP 层扩展到 agent 层。agent 能力越强，这条红线越重要 |

---

## 八·补 · 现有 BACKLOG 条目的归属

> 让 `docs/BACKLOG.md` 里的 v0.3 候选有明确去处，不再是一张只进不出的表。

| BACKLOG | 归属 | 说明 |
|---|---|---|
| V1 arXiv/PubMed 接入 | **P16 (E-1)** | 改为用 P15 的声明式 connector 实现，兼作扩展机制验收 |
| V2 novelty 相似度语义化（embedding） | v0.4 | 需要 embedding provider 决策；P11 的 provider 抽象为它铺路，但本版不做 |
| V3 poll 的进程 start-time 交叉核验 | **P10 (随 D-2 超时一起)** | 现状「只会多报 running」方向安全，加超时时顺手做 |
| V4 远端算力真实实现 | 不做 | §1.2：按真实课题拉动 |
| V5 R kernel | 不做 | permit set 有位置但无需求；P12 后加一个 kernel 的成本更低，等需求 |
| V6 物理 Opentrons | 不做（硬前置未满足） | §1.2：D-8 安全门声明兑现是硬门槛 |
| V7 Agent Swarm 接入 | **P12：删除** | §4.2.3 —— 与 P8 删 `compute/providers.ts` 同构 |
| V8 中文检索式召回优化 | **P16 (随 E-5)** | 与 CJK 元数据修复一起做 |
| V9 AMiner `getPaper` 真实 key 验证 | **P16** | 录一次 fixture 即可 |
| V10 HTTP 层真实身份 | 不做 | §1.2：先做实 agent 层 |
| V11 长任务句柄落盘 | **P14** | UI 跨重启看到运行中任务，属上手性 |
| V12 LLM 结构化输出 | **P11 根治** | `CallOptions.responseFormat`，不再靠「解析失败重试一次」治标 |
| V13 判定 prompt 对「凭空归因」的口径 | **P16 (随 E-2)** | 与 judge 降本一起改，改完重跑 G5 测量 |
| V14 位置加权豁免改白名单制 | **P13** | findings 状态机重构 reviewer 时一并做（阈值已到） |
| V15 移除 `MCPConnector` 等 deprecated 别名 | **P10 (lane D-a)** | D-1 重构 connector 分发时顺带确认无外部引用后删除；做不掉就留 v0.4 |
| V16 子代理独立模型暴露成用户配置项 | **P12** | 子代理做实时 `SubAgentSpec.model` 本就要有真消费方，顺势暴露成配置 |
| V17 MCP 长任务进度回传 | **P14** | 与 SSE 流式一起做（同属「看得见 agent 在干活」） |
| V18 `capabilities --probe` 结果缓存 | **P14** | 属上手性；缓存必须带失效条件（venv 变更），否则它会撒谎 |
| V19 审批动作要求可交互终端 | **P12（与 AD-14 同批）** | AD-14「子代理永不自批准」是默认路径防线，V19 是技术防线，两者配套才完整 |
| D1 第三个仿真平台 | 待定 | 契约已被两实现验证；P15 的 `ext verify` 让第三方自己加更划算 |
| D2 Semantic Scholar key | **P16 (E-4)** | 凭据路径落地 |
| D3 CNKI / 万方真实 API | 待定 | 无渠道；AMiner 仍是中文主路径 |

---

## 九、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 范围过大，跨度失控 | 拖到 v0.4 也发不出 | 三条主线**互相解耦**（除共用 P11）；§6.1 已给可裁剪顺序与关键路径；P14 单独可发 v0.2.1 |
| tool calling 在国产 provider 上兼容性差 | 主线 A 落空 | P11 的能力位 `toolCalling` 是**运行时可查**的：不支持就降级为「JSON 计划 + 代码执行」模式并如实告知，不假装 |
| 声明式 connector 的映射 DSL 越做越像编程语言 | 复杂度失控 | 硬约束：只支持受限 JSONPath 子集 + 固定归一化字段；**表达不了就写 TS 扩展**，这是特性不是缺陷 |
| 外部扩展 = 同 UID 代码执行 | 安全面扩大 | 默认推声明式（不执行代码）；TS 扩展需 `--trust` + 指纹确认；凭据与工具授权都要显式 grant；**文档必须直说这不是沙箱**（不重蹈 S-3「沙箱一行逃逸」的过度声明） |
| 记账落图导致 record 表膨胀 | 图查询变慢 | `agent_run` 默认只记 run 级不记每次 tool call（tool call 进执行记录表）；保留期与压缩策略进 config |
| P10 修 D-8 安全门时发现工作量远超预估 | 阻塞整条线 | D-8 允许走 (b) 降级口径 + 强制 `unconsumed` 告警先行；补全解析器可推到 P16 或 v0.4，**但接真机的门槛不松** |

---

## 十、给维护者的一段话

评审那句「越靠近可信度核心的代码质量越高，越靠近『AI Agent 平台』宣传语的代码越虚」，
是这个版本存在的全部理由。

v0.3 不加新功能域——**一个都不加**。它做三件事：
把 agent 层从数据结构变成会用工具的东西；把上手门槛降到一条 `npx`；
把扩展从「改仓库源码」变成「写一个 manifest 并过契约测试」。

同时它把项目已经证明有效的那套确定性纪律，往上推了两层：
**编排层**（完成与否问图不问模型）和**扩展层**（能装不算数，过契约才算数），
再加一条把这次评审发现变成永久门禁的 AD-12。

做完这三件，README 第一句话才是真的。

---

*本方案基于 2026-09-09 外部评审报告 + Claude Science / OpenScience 对比调研 + v0.2 全量代码复核制订。*
*复核中新发现且评审未列的一项：`LLMRouter` 声明 6 个 provider 但只实现 2 个（§4.1）——已纳入 P11。*
