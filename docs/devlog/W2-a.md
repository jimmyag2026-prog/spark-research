# W2-a · 子代理 tool loop（v0.4 方案 §4.2）

## 起点：上一版有多虚

`backend/src/agents/sub_agent.ts` 改动前 88 行，`llm.call` 里零工具——所谓「任务型
子代理」就是一次裸的模型调用：explore 不能检索、execute 不能跑代码，`SubAgentSpec.model`
字段存在但从没真的传进过一次真实的 tool-calling 请求。这是外部评审判定「名实落差
最大」的地方。

地基在这之前已经齐了：P11 给了 tool calling（6 个 provider + `capabilitiesFor(model)`
能力位可运行时查询），W1-a 给了 `AgentToolBus`（授权 / 预算 / 审计，与 `MCP_TOOLS`
同源，`MCP_WITHHELD` 无条件拒绝）。本 lane 把两者接起来，写出真的 tool loop。

## `SubAgentSpec` 最终形状

```ts
export interface SubAgentBudget {
  maxToolCalls: number;
  maxTokens: number;
  maxWallMs: number;
}

export interface SubAgentSpec {
  name: string;
  type: SubAgentType; // "explore" | "execute" | "review" | "lab" | "literature"
  model: string;       // 真消费方：CallOptions.model
  promptFile: string;  // agents/prompt/<type>.txt
  grants: string[];    // ToolBus 白名单，MCP 工具名
  budget: SubAgentBudget;
  readOnly: boolean;   // review = true，硬约束
}

export interface SubAgentResult {
  finalText: string;
  toolCalls: ToolAuditEntry[]; // AgentToolBus 的 audit 回调收集的全部记录
  usage: Usage;
  stopReason: "done" | "budget" | "timeout" | "denied" | "error";
  // 任务书骨架之外，本 lane 额外加了三个可选字段（不破坏原有四字段契约）：
  degraded?: boolean;       // 模型不支持 tool calling 时的显式降级标记
  degradedReason?: string;  // 降级说明原文
  error?: string;           // stopReason:"error" 时的原始错误信息
}
```

`stopReason` 的五个值各自的触发条件：

- `"done"` — 一轮 `llm.call` 返回且没有 `toolCalls`。
- `"budget"` — `BudgetLedger.snapshot().exceeded` 里出现除 `wallMs` 之外的维度（工具
  调用数、token 数），或命中 `DEFAULT_MAX_ROUNDS`（64 轮）安全阀。安全阀命中同样报
  `"budget"`，不报 `"done"`——预算配置得再宽松，也不该无限循环下去，但没做完就是
  没做完。
- `"timeout"` — `exceeded` 里出现 `wallMs`。与其他预算维度分开报，让调用方能区分
  「钱花完了」和「时间到了」。
- `"denied"` — 连续两轮「这一轮请求的全部工具调用都被 ToolBus 拒绝」（`not_granted`
  或 `withheld`）。模型显然卡在一个它结构性拿不到的动作上，继续烧预算陪它重试没有
  意义，提前止损比等预算耗尽更诚实。
- `"error"` — `llm.call()` 本身返回 `ok:false`（AD-13 的失败分支）。`error` 字段带
  原始 `LlmError.message`。

## W1-a 留的待决问题：DEFAULT_PERMISSIONS 怎么办

**选择①：直接重写成 MCP 工具名，不加翻译层。** 理由：

1. `AgentToolBus.grants: string[]` 字面上就是 MCP 工具名——加一层「抽象能力 → 工具名
   集合」的翻译表，只是在中间插一张会漂移的表。`toolbus.ts` 自己的注释已经把这条
   纪律讲得很清楚：它选择直接复用 `MCP_WITHHELD` 而不重写一份危险动作表，理由就是
   「两张表迟早漂移比没有更危险」。同样的纪律用在这里。
2. v0.1 的抽象名（`read_frames` / `python` / `compute_submit` / `write_artifact` /
   `lab_control` / `scoped_query` 等）在 P9 的 MCP 工具面之后已经没有任何真实边界
   对应——继续留着只是维持一具僵尸词汇，全仓库 grep 确认零消费方。
3. 这正是 W1-a 自己的 devlog 指出的「更简单、更符合字面语义」的那条路。

代价（如实记录）：legacy `SubAgentConfig.permission` 字段的语义从「抽象能力标签」
静默变成「MCP 工具名」。这是安全的：grep 全仓库确认 `orchestrator.ts`（唯一的生产
消费方）从未读过 `.permission`，只读 `.prompt` / `.model` / `.type`。

落地方式：`SUB_AGENT_DEFAULTS`（`sub_agent.ts` 内部一张 `Record<SubAgentType, ...>`
表）是唯一真源，legacy 的 `SubAgentFactory.create()` 与新的 `buildSubAgentSpec()`
都从它派生 grants/prompt/model/budget/readOnly——不可能两条路径各自漂移一份。

## 五类子代理的 grants（与任务书推荐表格逐字段一致）

| 子代理 | grants | readOnly |
|---|---|---|
| explore | `lit_search` `lit_list` `lit_read_cards` `records_timeline` `record_get` | false |
| literature | explore 全套 + `lit_add` `lit_export` `lit_review_draft` | false |
| execute | `exp_design` `exp_run` `exp_list` `task_status` | false |
| lab | `lab_compile` `lab_status` | false |
| review | `record_get` `records_timeline` `conclusion_list` `conclusion_get` `report_export` | **true** |

预算默认值（`SubAgentBudget`，如实记录：这是工程判断不是精确调优过的常量，overrides
可覆盖）：

| 子代理 | maxToolCalls | maxTokens | maxWallMs |
|---|---|---|---|
| explore | 12 | 60,000 | 180,000（3 分钟） |
| literature | 15 | 80,000 | 240,000（4 分钟） |
| execute | 10 | 60,000 | 300,000（5 分钟，`exp_run` 可能较慢） |
| lab | 6 | 30,000 | 120,000（2 分钟，只有 compile+status 两个工具） |
| review | 8 | 40,000 | 120,000 |

`model` 全部默认 `LLMRouter.DEFAULT_MODEL`，通过 `overrides.model` 或
`SubAgentSpecOverrides` 可各自独立配置——`SubAgentSpec.model` 现在真的被传进
`CallOptions.model`（DESIGN §5.4 的死字段第一次有真消费方），只是本 lane 没有理由
让五类默认值互相不同（没有拿到「哪类子代理该配哪个模型」的产品决策），把选型开关
留给调用方。

## readOnly 硬约束怎么做的

`readOnly` **只由 `type` 决定，`SubAgentSpecOverrides` 接口里根本没有 `readOnly`
字段**——不接受调用方覆盖，否则 `{readOnly: false}` 就能绕开硬约束，"硬约束"就名不
副实了。

只读工具的分类判据：`backend/src/mcp/tools.ts` 里每个工具的 `request()` 固定用
`GET` 或 `POST` 之一（同一个工具不会按参数在 GET/POST 之间切换，只会在多个 GET 路径
之间切换——已对全部 29 个工具定义逐条核对过）。`GET` = 只读，`POST`/`PATCH` 一律当
「可能有副作用」处理——即使 `lit_search` 语义上是只读查询，它用 POST 只是因为查询体
复杂，也照样被排除在只读集合之外：保守优先于精确，误伤好过误放。这张 `READ_ONLY_
TOOL_NAMES` 表是手工维护的（与 `ALLOWED_ORPHANS`/`SKILL_ENTRYPOINTS` 同一套纪律），
`tests/unit/sub_agent.test.ts` 里有一组交叉检查：对 review 的默认 grants 逐个调用
`MCP_TOOLS` 里真实的 `request({})` 断言方法确实是 `GET`，并对几个已知写工具
（`lit_add`/`lab_compile`/`exp_run`/`project_create`/`idea_coexplore`）断言方法是
`POST`——不是纯手写断言，是跟 `mcp/tools.ts` 的真实实现对账。

校验发生两次，缺一不可：

1. **构造期**（`buildSubAgentSpec()`）：`grants` override 混入非只读工具 →
   `SubAgentGrantViolationError`，直接拒绝构造，不静默剔除（剔除会掩盖调用方的
   配置错误）。
2. **运行期**（`runSubAgent()` 开头）：同样的校验再跑一遍——防的是调用方手工构造
   一个 `SubAgentSpec` 对象、绕过 `buildSubAgentSpec()` 直接塞给 `runSubAgent()`
   的情况。两次校验都在**任何 `llm.call()` 之前**完成，违规时零 LLM 调用、零工具
   调用。

另外一条独立防线：任意类型（不只 review）的 `grants` 里出现 `MCP_WITHHELD` 的名字，
同样在构造期 + 运行期被拒绝——`AgentToolBus` 本来就会拦（红线测试见 W1-a），但把
危险动作写进 grants 本身就是不该发生的配置错误信号，`sub_agent.ts` 在源头就不给它
跑到运行期。

## 不支持 tool calling 的模型：显式降级路径

`runSubAgent()` 在真正进入 tool loop 之前先查一次
`deps.llm.capabilitiesFor(spec.model)`。命中 `caps.toolCalling === false`
（比如本地端点，P11 的 `localCapabilities()` 保守上报 `toolCalling:false`）时，
走 `runDegraded()`：

- 不把 `tools` 传给 `llm.call()`（不会因为 provider 不支持 tools 参数而报错，但那
  不是重点——重点是下一条）。
- 在 system prompt 后追加一段人类可读的降级说明，并把它**前置**拼进 `finalText`——
  即使调用方只看 `finalText` 也能看到「这次运行工具被禁用了」，不是只有查
  `degraded` 字段的调用方才知道。
- `SubAgentResult.degraded = true` + `degradedReason` 结构化标记，给程序化调用方
  一个不用解析文本就能判断的信号。
- 只做**单轮**文本生成——不重试、不假装能继续用工具。
- 降级路径下 `llm.call()` 本身失败时，`stopReason` 依旧如实报 `"error"`
  （`degraded` 标记不会掩盖真实失败）。

独立测试：`tests/unit/sub_agent.test.ts`「降级路径」describe 块两条用例，分别覆盖
「降级 + 成功」与「降级 + llm 失败」两条分支——阴性对照④（见下）验证了这条路径不是
装饰性的：真去掉这个分支，测试立刻红。

## 五类 prompt 文件

`agents/prompt/explore.txt` / `literature.txt` / `execute.txt` / `lab.txt` 新建；
`reviewer.txt`（W1-a 时代已有）复用给 review 类型，未改动其内容。`core.txt` /
`research.txt` / `coexplore.txt` 是 orchestrator.ts 自己的 prompt（不是「子代理
类型」prompt），本 lane 没有碰。

每份新 prompt 都显式列出「有哪些工具、什么时候该用、什么时候不该用」，`lab.txt`
额外强调了一条：`lab_approve`/`lab_simulate`/`lab_reject` 永远不会被授予，且这是
安全门在正常工作，不是需要绕过的 bug。

Legacy 路径（`SubAgentFactory.create()`）现在也从同一份 prompt 文件加载文本，不再
维护一份单独的 `INLINE_PROMPTS`——旧路径与新路径的 prompt 内容不可能漂移。

## Tool loop 的执行细节

- **受限并发**：同一轮内多个 tool call 用一个简单的 worker-pool（`runToolCallsLimited`）
  执行，并发度 `SUB_AGENT_TOOL_CONCURRENCY = 3`（导出，供测试断言）。结果按原始
  `calls` 数组顺序对齐写回（每个结果都带 `toolCallId`，顺序其实不影响正确性，但
  保持顺序方便读）。
- **两本账**：`runSubAgent()` 从 `deps.parentBudget`（或新开一本）派生两个子账本——
  `toolBudget`（`maxCalls: spec.budget.maxToolCalls`，喂给 `AgentToolBus`，只有真
  执行的工具调用才会让它的 `calls` 计数增长）与 `tokenBudget`
  （`maxTotalTokens: spec.budget.maxTokens`，每次 `llm.call()` 后 `record()`）。
  两本账共享同一个 `wallMs` 上限与同一个时钟（`now` 从 `parentBudget`/`deps.now`
  一路透传），所以「工具调用预算」和「token 预算」不会互相污染彼此的计数——之前
  考虑过用一本账同时记两类调用，会导致 LLM 往返也计进 `maxToolCalls`，过早触发
  工具预算耗尽，放弃了。
- **继承 W1-a 的边界语义**：`toolBudget` 复用 `AgentToolBus`/`BudgetLedger` 现成的
  「严格大于」判定（`maxCalls:N` 放行恰好第 N+1 次调用），本 lane 没有改这条行为，
  只是如实继承并在 devlog 里点名，避免看起来像是本 lane 引入的新缺陷。
- **安全阀独立于预算**：`DEFAULT_MAX_ROUNDS = 64`。防的是极端场景——比如
  `usage.usageUnavailable` 一直为 true 导致 token 维度永远不超、`maxWallMs` 配置
  得很宽松——轮数本身也是一种耗尽信号，命中时同样报 `"budget"`。

## 阴性对照（四条，全部实跑，终端输出如下）

### ①「预算耗尽却报 stopReason:'done'」→ 测试红

把 `preCheck`/`postCheck`/安全阀兜底三处 `stopReason` 硬编码成 `"done"` 后：

```
bun test tests/unit/sub_agent.test.ts
```
```
tests/unit/sub_agent.test.ts:
196 |     expect(result.stopReason).toBe("budget");
                                    ^
error: expect(received).toBe(expected)
Expected: "budget"
Received: "done"
(fail) runSubAgent · 真 tool loop > 预算（工具调用数）耗尽 → stopReason:'budget'，不是 'done' [4.65ms]
215 |     expect(result.stopReason).toBe("timeout");
                                    ^
error: expect(received).toBe(expected)
Expected: "timeout"
Received: "done"
(fail) runSubAgent · 真 tool loop > 墙钟（maxWallMs）耗尽 → stopReason:'timeout'，与其他预算维度的 'budget' 区分开 [0.23ms]

 18 pass
 2 fail
```
恢复后重跑，20 pass / 0 fail。

### ②「tool 结果不回灌（第二轮 prompt 不含第一轮结果）」→ 测试红

注释掉 `messages.push({role:"tool", ...})` 那段后：

```
bun test tests/unit/sub_agent.test.ts
```
```
tests/unit/sub_agent.test.ts:
145 |     expect(toolMsg).toBeDefined();
                          ^
error: expect(received).toBeDefined()
Received: undefined
(fail) runSubAgent · 真 tool loop > 完整循环：请求工具 → 受限并发执行 → 结果回灌进下一轮 messages → 无 tool call 后 stopReason:'done' [2.64ms]

 19 pass
 1 fail
```
恢复后重跑，20 pass / 0 fail。

### ③「review 子代理拿到写工具」→ 测试红（readOnly 硬约束）

注释掉 `buildSubAgentSpec()` 与 `runSubAgent()` 里的 `assertReadOnlyGrants(...)`
调用后：

```
bun test tests/unit/sub_agent.test.ts
```
```
tests/unit/sub_agent.test.ts:
251 |     expect(() => buildSubAgentSpec("review", { grants: ["lit_add"] })).toThrow(SubAgentGrantViolationError);
                                                                             ^
error: expect(received).toThrow(expected)
Expected constructor: SubAgentGrantViolationError
Received function did not throw
Received value: {
  name: "review", type: "review", model: "moonshotai/kimi-k2.6",
  promptFile: "reviewer.txt", grants: [ "lit_add" ],
  budget: { maxToolCalls: 8, maxTokens: 40000, maxWallMs: 120000 },
  readOnly: true,
}
(fail) buildSubAgentSpec / runSubAgent · readOnly 硬约束（review） > review + grants override 混入写工具 → 构造期直接拒绝 [1.71ms]
281 |     await expect(runSubAgent(illegalSpec, "task", { llm, runner })).rejects.toThrow(SubAgentGrantViolationError);
                                                                                  ^
error:
Expected promise that rejects
Received promise that resolved: Promise { <resolved> }
(fail) buildSubAgentSpec / runSubAgent · readOnly 硬约束（review） > runSubAgent 对手工构造、绕过 buildSubAgentSpec 的非法 spec 同样拒绝（防御性二次校验，先于任何 llm 调用） [0.42ms]

 18 pass
 2 fail
```
值得记录：拒绝检查关掉之后，`readOnly:true` 的 spec **确实能带着一个写工具
（`lit_add`）构造成功**——这正好证明了这条硬约束不是 `AgentToolBus` 的职责范围：
`lit_add` 不在 `MCP_WITHHELD` 里，ToolBus 本身完全不会拦一个「被正常授权」的写
工具，`readOnly` 是 `sub_agent.ts` 自己叠加的一层、`AgentToolBus` 完全不知道的
语义。恢复后重跑，20 pass / 0 fail。

### ④「不支持 tool calling 时静默失败而非显式降级」→ 测试红

注释掉 `if (caps && caps.toolCalling === false) { return runDegraded(...) }`
分支后：

```
bun test tests/unit/sub_agent.test.ts
```
```
tests/unit/sub_agent.test.ts:
360 |     expect(result.degraded).toBe(true);
                                  ^
error: expect(received).toBe(expected)
Expected: true
Received: undefined
(fail) 降级路径：capabilitiesFor(model).toolCalling === false > 显式降级，不静默失败：finalText 含降级说明，工具全程未被调用，tools 未传给 provider [0.45ms]
380 |     expect(result.degraded).toBe(true);
                                  ^
error: expect(received).toBe(expected)
Expected: true
Received: undefined
(fail) 降级路径：capabilitiesFor(model).toolCalling === false > 降级路径下 llm.call 仍失败 → stopReason:'error'，degraded 依旧如实标记（不因为降级就掩盖真实失败） [0.27ms]

 18 pass
 2 fail
```
恢复后重跑，20 pass / 0 fail。`git diff`/`grep "NEGATIVE CONTROL"` 确认四次阴性
对照的临时改动全部已撤回、干净。

## 六套件数字（全部在本 lane worktree，`SPARK_E2E_PORT=4421` 实跑，均为最终态）

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（`tsc --noEmit` 两遍，含 frontend/workspace） |
| `bun test tests/unit/` | **1140 pass / 0 fail / 0 skip**（基线 1120 + 本 lane 新增 20） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e` | **13/13** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

没有套件跳过或没能跑成——六项阶段门全部实跑并全绿。

## `ALLOWED_ORPHANS` 登记变化

删除了 `backend/src/agents/toolbus.ts` 的「等接线」登记：`sub_agent.ts` 现在
`import { AgentToolBus, isDenied, ... } from "./toolbus"` 并在 `runSubAgent()`
里为每个子代理构造一个 `AgentToolBus` 实例，`toolbus.ts` 有了真实生产调用方——按
门禁的「多余登记必须删除」对称检查删除了这一条。没有新增任何登记，也没有动
`narrative_parity.test.ts` 的任何断言逻辑，只改了 `ALLOWED_ORPHANS` 这一张表里的
一条注释。

## 给 W3-a（replan 循环）的交接说明

### 现状：`orchestrator.ts` 还没接上真 tool loop

`orchestrator.ts` 里的 `"subagent"` 任务分支（约第 388-406 行）目前还是本 lane 改动
前的旧路径：

```ts
const type = (task.params?.subagent ?? "execute") as SubAgentType;
const agent = this.subAgents.create(type);
const res = await this.llm.call(
  [{ role: "system", content: agent.prompt }, { role: "user", content: task.description }],
  agent.model,
);
```

这条路径**继续可编译、继续能跑**——本 lane 没有碰 `orchestrator.ts`（它是 W3-a 的
文件所有权），只保证 `SubAgentFactory`/`SubAgentType`/`SubAgent` 这层旧接口的数据
源头换成了跟新 API 同一张 `SUB_AGENT_DEFAULTS` 表（详见上面「待决问题」一节）。
换句话说：**旧接口的行为没变，只是它现在用的 grants 表是对的**——等 W3-a 把
`"subagent"` 分支接到 `runSubAgent()`/`runSubAgentOfType()` 时，不需要再做一次
「发现旧表是错的」的返工。

### 怎么接：一步到位的入口

```ts
import { runSubAgentOfType, type SubAgentDeps } from "./sub_agent";
import { McpToolRunner } from "../mcp/server";
import { BudgetLedger } from "../llm/budget";

// orchestrator 级别可以开一个父账本，给「一次会话里派生的全部子代理」一个总预算：
const sessionBudget = new BudgetLedger({ maxCostUsd: /* 会话级上限 */ 5 });

const deps: SubAgentDeps = {
  llm: this.llm,                 // 已经是 Pick<LLMRouter,"call"|"listModels">，
                                  // 需要加上 "capabilitiesFor"（LLMRouter 本身有这个方法，
                                  // 只是 OrchestratorDeps.llm 的类型窄了——扩一下 Pick 的字段集）
  runner: new McpToolRunner({ app /* 同 createApp 的 deps */ }),
  parentBudget: sessionBudget,   // 可选；不给就每个子代理各自开一本新账
};

const result = await runSubAgentOfType(type, task.description, deps);
// result.stopReason !== "done" 时，orchestrator 不该把 result.finalText 当成
// 「任务完成」处理——这正是 P13 的 C-a/C-b 停机条件要读的信号。
```

### 三个 W3-a 要处理的衔接点

1. **`OrchestratorDeps.llm` 的类型要扩一位**：现在是
   `Pick<LLMRouter, "call" | "listModels">`，`SubAgentDeps.llm` 需要
   `Pick<LLMRouter, "call" | "capabilitiesFor">`。真正的 `LLMRouter` 实例两者都有，
   只是窄类型签名需要改（这行改动落在 `orchestrator.ts`，不在本 lane 所有权内，
   留给 W3-a）。
2. **`stopReason` 是 P13 停机条件的输入之一**：方案 §4.3 提到 P13 的三条并行停机
   条件（`contract.allDone()` / `noProgress(2 轮)` / `budget` 耗尽）。本 lane 交付
   的 `SubAgentResult.stopReason` 已经把「子代理层面」的 budget/timeout/denied/error
   都如实分开报出——`noProgress` 的判断可以直接读它，不需要重新发明一套「这个子
   代理是不是卡住了」的探测逻辑。
3. **`McpToolRunner` 的构造**：`runSubAgent()` 要求调用方传一个已经构造好的
   `McpToolRunner`（不在内部自己创建）——orchestrator 通常已经持有一个跟当前会话
   绑定的 Hono app / daemon 实例，`McpToolRunner` 应该复用那一个，而不是每次子代理
   调用都重新构造一份（构造本身没有副作用，但复用更符合「同一进程内统一工具总线」
   的定位）。

### 已知的、故意不处理的边界

- **并发批次内的预算竞态**：`runToolCallsLimited()` 用并发度 3 执行同一轮的多个
  tool call，而 `AgentToolBus.call()` 的预算前置检查是同步的、发生在真正执行（异步）
  之前——并发批次里最多可能有 `SUB_AGENT_TOOL_CONCURRENCY - 1`（即 2）次调用在
  预算刚好卡在边界时"抢跑"通过检查。这是 `AgentToolBus` 本身「先检查、后记账」
  设计的自然推论（W1-a 已经记录过 `calls` 维度的类似「严格大于」边界语义），本
  lane 把并发度控制在 3（而不是更高）就是为了把这个竞态窗口压小，没有去改
  `toolbus.ts`（不在文件所有权内，也不该改——那是"观测组件，是否硬停由调用方
  决定"的既定设计）。
- **`maxTokens` 预算不含工具调用本身的开销**：`tokenBudget` 只统计 `llm.call()`
  的 `usage`，不统计 `AgentToolBus` 记的那笔（工具调用记 `costUsd:null` 到
  `toolBudget`，不影响 `tokenBudget` 的 token 计数）。这是刻意的——工具调用不消耗
  模型 token，把两者混进一个计数器会让 `maxTokens` 的语义变得不清晰。
- **`DEFAULT_MAX_ROUNDS = 64` 是硬编码常量**，不是 `SubAgentBudget` 的字段，但
  `SubAgentDeps.maxRounds` 可以覆盖（测试用小值触发它）。如果 W3-a 需要把它暴露成
  用户配置项，加一个字段不难，但本 lane 没有产品侧的信号说明该给它什么默认值以外
  的东西，没有加。

## 哪些套件没能在本 lane 跑成

没有。六项阶段门（typecheck / unit / concurrency+timeout / e2e / py / lab）全部
实跑并全绿，数字见上表；四次阴性对照全部实跑，输出已完整贴在本文件，且确认临时
改动已全部撤回、工作树干净。
