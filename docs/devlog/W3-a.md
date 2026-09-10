# W3-a · replan 循环 + orchestrator（把「单发管线」变成「真 agent 循环」）

> lane W3-a，波次 W3。方案真源 `docs/DEVELOPMENT_PLAN_v0.4.md` §4.3（P13 设计）与
> `docs/DEVELOPMENT_PLAN_v0.3.md` §4.3.2（观察反馈循环的原始伪代码）。
> 文件所有权：`backend/src/agents/orchestrator.ts`（核心改造）、
> `backend/src/agents/replan.ts`（新建）、`tests/unit/orchestrator.test.ts`、
> `tests/unit/replan.test.ts`（新建）、`tests/unit/narrative_parity.test.ts`
> （仅改 `ALLOWED_ORPHANS` 登记）、本文件。

## 1. replan 循环的最终形态

伪代码原样落地在 `backend/src/agents/replan.ts` 的 `runReplanLoop()`：

```
round = 0
while round < maxRounds:
    plan         = planner(goal, contract.progress(), lastObservations)
    outcomes     = execute(plan)
    observations = distill(outcomes)
    evaluation   = evaluateRound(contract, guard, query)   # W2-b 已提供，不重写
    if evaluation.stopReason: break
    round += 1
```

`replan.ts` 只钉死"这几个函数按什么顺序、用什么数据形状接起来"——`planner`/`execute`
本身不在这个文件里，它们需要 LLM + 真子代理依赖，实现落在 `orchestrator.ts` 的
`OrchestratorAgent.runResearchLoop()` 里：

- **`contract.progress()`** 的落地是每轮重新 `contract.evaluate(q)`（不缓存，图变了就
  重新查）。
- **`execute(plan)`** 对 plan 里每一项调 `runSubAgentOfType()`（W2-a 的真 tool loop：
  `buildSubAgentSpec()` + `AgentToolBus` 授权/预算/审计三层 + 受限并发工具执行），共享
  同一个 `BudgetLedger` 父账本（`sessionBudget`），子代理各自开子账本。
- **三条并行停机条件**全部复用既有机制，一条也没有重新发明：
  - `done` / `no_progress` —— 完全交给 W2-b 的 `evaluateRound(contract, guard, q)`；
    `runReplanLoop()` 只读它的 `stopReason` 字段，不自己再判一次。
  - `budget` —— 判据在调用方（`ReplanLoopDeps.budgetExceeded`），`runResearchLoop()`
    传进去的实现是 `() => sessionBudget.snapshot().exceeded.length > 0`；`done` 优先
    于 `budget`（`evaluateRound()` 先判，`budgetExceeded()` 只在它返回 `null` 时才问），
    与 `evaluateRound()` 内部"`allDone` 优先于 `noProgress`"同一条纪律。
  - 安全阀 `maxRounds`（默认 `DEFAULT_RESEARCH_MAX_ROUNDS = 25`）命中时也报 `"budget"`
    ——与 `sub_agent.ts` 的 `DEFAULT_MAX_ROUNDS` 同一类考量（宁可报没做完，不假装完成）。

`OrchestratorAgent.runResearchLoop(sessionId, goal, options)` 是新入口，与既有的
`processRequest()`（P1-P3 的规划/执行/reviewer 硬 finding 修正循环）是**两条并列的
机制**，不是互相替换：

- `processRequest()` 处理任意 task-kind 混合的一次性请求；`runResearchLoop()` 处理一个
  **契约化的研究目标**（目前只有 `literature-review` 一种契约，`options.contract` 可插
  拔自定义）。
- `runResearchLoop()` 需要 project（`RecordStore` 就是它的证据图）——AD-10「完成判定
  问图不问模型」在没有图的地方无法成立，没有绑定 project 时**直接抛错**，不悄悄退化成
  「问模型」（见 `tests/unit/orchestrator.test.ts` 的「没有绑定 project 时直接报错」测试）。
- 每轮结束都写一条 `research` actor 的执行日志（`round-N`：派出几个子代理、新增几条
  证据、`evaluation.stopReason`），收尾再写一条 `stop`（前缀显式带上最终 `stopReason`，
  因为 `describeStop()` 自己的文案不区分 `budget`，只认得 `done`/`no_progress` 两个分支
  ——这是 contract.ts 的既有实现，本 lane 只读复用没有改它，日志文案里手动补上了这个
  信息）。

**`OrchestratorDeps.llm` 的类型没有按 W2-b 交接说明里建议的那样收紧成
`Pick<LLMRouter,"call"|"capabilitiesFor">`**——这是一处刻意的偏离，原因见下面「与
W2-b 交接说明的一处偏离」一节。

## 2. `distill` 产出的 observation 结构

`backend/src/agents/replan.ts` 的 `Observation`：

```ts
export interface Observation {
  taskId: string;
  subagentType: SubAgentType;
  stopReason: SubAgentStopReason;           // done/budget/timeout/denied/error，如实回流
  toolCallCount: number;
  deniedCount: number;
  deniedReasons: ToolDenialReason[];        // not_granted/withheld/budget_exceeded
  failedToolCount: number;                  // 执行了但 ok:false（区别于「被拒绝」）
  newRecordIds: string[];                   // 相对本轮开始前快照的新增 record id
  newRecordCountByType: Partial<Record<RecordType, number>>; // 按类型分桶的命中数
  errorMessage?: string;                    // 仅 stopReason==="error" 时有值
  degraded: boolean;
  finalText: string;                        // 完整正文，不截断
}
```

`distillObservation(taskId, subagentType, result: SubAgentResult, before, q)` 的实现：
`newRecordIds`/`newRecordCountByType` 来自 `q.newSince(before)`（与 `NoProgressGuard`
同一套"按 id 集合差，不按时间戳"纪律）；`deniedCount`/`deniedReasons`/`failedToolCount`
来自遍历 `result.toolCalls: ToolAuditEntry[]`，按 `entry.denied` 是否存在区分"被拒绝"
与"执行了但失败"；`errorMessage` 只在 `stopReason==="error"` 时透传 `result.error`（不
是塞进一句拼接文本，是独立字段）；`finalText` 完整保留，`tests/unit/replan.test.ts`
里专门造了一条 500 字符的假输出验证它没有被截断成 200 字符。

这就是任务书要求的"命中数/新增 record id/错误类型/子代理的 stopReason"——**全部是
可以被下一轮 planner 直接消费的字段**，而不是 `output.slice(0, 200)` 拍扁的一句话。
`runResearchLoop()` 的 `planResearchRound()` 把这些字段格式化进给 LLM 的 prompt（见
`obsText` 的拼装），也把 `report.incomplete`（未完成 stage 及其 `reason`）一起喂进去
——decision-making 有实打实的抓手。

## 3. onDelta 怎么接

**根治的问题**：W2-d 做 SSE 流时，`processRequest`/`chat()` 没有 `onDelta` 的口子，
`server/routes/session.ts` 被迫在权威调用之前**额外发一次独立的裸模型调用**
（`llm.call([{role:"user",content:message}], {onDelta})`）做"预览流"——但那次调用发的
是裸消息（无 system prompt、无技能上下文、无 plan），跟走完整 orchestrator 管线的权威
答案是**两个不同的回答**。W2 收口已经把这条预览默认关闭（`preview:true` 才开），根治
留给本 lane。

**接法**：`processRequest(userMessage, sessionId, options?: { onDelta })` 与
`chat(req: {...; onDelta?})` 都新增了可选的 `onDelta` 参数（向后兼容——两个方法原有的
调用点全部只传 2/若干个位置参数，新增的可选参数不影响它们，`bun test tests/unit/` 的
1235 个用例证明了这一点）。`onDelta` 只接到 **`summarize()`** 这一个 LLM 调用点：

```ts
const options: CallOptions = { model: LLMRouter.DEFAULT_MODEL, ...(onDelta ? { onDelta } : {}) };
const res = await this.llm.call(messages, options);
```

**为什么只接 `summarize()`，不接 `plan()`**：`summarize()` 的返回值就是
`OrchestrationResult.summary`，也是 `chat()` 返回的 `response`——它是**唯一产出"用户
最终会看到的正文"**的调用点。`plan()` 产出的是 JSON 任务数组，把它的增量当"预览文本"
流给用户只会看到破碎的 JSON 片段，那不是根治 W2-d 的问题，是换一种方式重新制造同一个
问题。`runResearchLoop()`/`planResearchRound()` 同理不接 `onDelta`——它的 LLM 调用产出
的也是 JSON round plan，不是给人看的正文。

**已知的、如实记录的简化**：`processRequest()` 的 reviewer 硬 finding 修正循环里，
`summarize()` 可能被调用不止一次（每轮修正后重算一次摘要）。当前实现是每次调用都转发
同一个 `onDelta`——多轮场景下调用方会依次收到每一轮 summarize 的增量，不只是最终一轮。
根治需要一个"本轮 summary 作废，重新开始"的边界信号，这属于 SSE 传输层的事（`sseResponse`/
`sender.send` 在 `backend/src/server/sse.ts`），不在 `agents/**` 的文件所有权内，留给
下面「给主会话的接线说明」。

`coexplore()` 同样没有接 `onDelta`——`CoExploreSession`（`backend/src/ideation/coexplore.ts`）
不在本 lane 文件所有权内，本 lane 没有替它接线；`chat()` 的 JSDoc 已注明这一点。

### 给主会话的接线说明

`server/routes/session.ts` 的 `/stream` 端点现在可以**删掉那次独立的预览调用**，改为
直接把 `onDelta` 传给 `ctx.agent.chat()`：

```ts
// 删掉这一整块（wantsPreview / 那次裸 llm.call）：
if (wantsPreview) {
  try {
    await ctx.llm().call([{ role: "user", content: message }], { model, onDelta: ... });
  } catch { /* ... */ }
}
sender.send("progress", { message: ... });
// 改成：
const result = await ctx.agent.chat({
  sessionId, message, model, mode,
  onDelta: (chunk) => { if (!sender.closed) sender.send("delta", { chunk }); },
});
```

这样 `delta` 事件吐出的就是**权威调用本身**的流式增量（走完整 plan → execute → review
管线后 `summarize()` 产出的正文），不再是与最终答案无关的裸模型输出。`preview`/
`wantsPreview` 这两个变量、以及顶部那段解释"为什么默认关闭预览"的大注释都可以一并删掉
——它们描述的问题已经不存在了。`tests/e2e/workbench.spec.ts` 里"⑬ SSE 预览流"这条用例
（`preview:true` 显式开启）目前还在用旧的预览机制，接线后需要同步更新成断言新的
"délta 来自权威调用"语义（或者去掉 `preview` 这个请求字段，因为不再需要两次调用）——
这个改动本身落在 `server/routes/session.ts` + `tests/e2e/**`，都不在本 lane 所有权内，
本 lane 没有动它们，`bun run test:e2e` 的 14/14 是在**没有改 session.ts** 的前提下跑通的
（旧的预览机制原样保留，新的 `onDelta` 口子只是多开了一条没被消费的能力）。

如果要给 `runResearchLoop()` 加 CLI 命令（比如 `spark-research research <goal>`），
入口函数是 `OrchestratorAgent.runResearchLoop(sessionId, goal, options)`——它需要一个
已经绑定 project 的 session（`ProjectManager.bindSession()`），`options.maxRounds`/
`options.noProgressThreshold`/`options.budget`/`options.contract` 都是可选的，不传
就用 literature-review + 默认预算。`backend/src/index.ts` 不在本 lane 所有权内，本 lane
没有加这个命令。

## 4. F-2 那四处 `if (!res.ok)` 怎么判断的

任务书问的是："P10 的 D-4 在四处加了 `if (!res.ok)`，P11 把 `LlmResponse` 做成可辨识
联合之后，这四处 `if` 里有没有已经冗余的？"

**结论：`if (!res.ok)` 这个控制流分支本身，四处都不冗余——一处都不能删。** 原因不是
"业务上仍然需要"这种模糊说法，而是**类型系统层面的必然性**：`LlmResponse` 是
`{ok:true; content:string; error?:undefined} | {ok:false; content:""; error:LlmError}`
的可辨识联合，TypeScript 只有在窄化到 `res.ok === false` 分支之后才允许访问
`res.error.message`——`if (!res.ok)` 不是一道"多余的运行时二次校验"，它是**触达
`res.error` 的唯一合法入口**，删掉它代码就编译不过。这与 W2-a 阴性对照④验证过的
"降级路径的显式分支不能删"是同一类结论：可辨识联合让"分支判断"和"类型窄化"变成了
同一件事，不是两件事叠在一起的"两套防线"。

**但四处 `if` 的内部逻辑里，确实发现了一个真实的、此前没被注意到的 bug**——不是"冗余
防线"，是**已经失效但没人发现的防线**：

四处诊断日志原本都写的是 `res.content.slice(0, 200)`（P10 D-4 写下这行代码时，
`LlmResponse` 还不是可辨识联合，`res.content` 在失败时确实held着路由层拼出的错误文本，
比如 `"[error] No API key configured..."`）。P11 引入 AD-13 之后，`ok:false` 分支的
`content` 字段类型是**字面量 `""`**——`res.content` 在失败路径上**恒为空字符串**。也
就是说，从 AD-13 落地的那一刻起，这四行 `res.content.slice(0, 200)` 就一直在往执行日志
/ `ExecutionOutcome.output` 里记一个**永远是空串**的"诊断"，真正的原因
（`res.error.message`）从来没被读过——排查"为什么摘要生成失败"的人翻开执行日志，
只会看到空白。这是 AD-13 重构时留下的一处**类型收紧但没有同步更新读取端**的漂移，
恰好符合任务书点名的"两套防线、改一处不改另一处是漂移源"这句话的精神，只是漂移的
不是"两套防线"字面意义上的重复检查，而是"类型层面的契约变了，消费方没跟上"。

**处理方式**：四处全部改读 `res.error.message`（不是删除 `if`，是修复 `if` 块**内部**
的诊断来源）：
- `plan()`（`orchestrator.ts` ~397 行）：`plan-llm-failed` 日志。
- `executeTask()` 的 `"analysis"` 分支（~440 行）：`llm-failed` 日志 + `ExecutionOutcome.output`。
- `executeTask()` 的 `"subagent"` 分支旧路径（~530 行左右，见下节"没有真实工具面时的
  退回路径"）：同上，同一个模式的第四处调用点。
- `summarize()`（~570 行）：`summarize-llm-failed` 日志——四处里最要紧的一处，它曾经
  是排查"为什么摘要生成失败"的唯一线索。

`tests/unit/orchestrator.test.ts` 新增了一个专门的 describe 块
`"OrchestratorAgent F-2：诊断信息不再是恒为空串的 res.content"`（3 个测试），断言这
三个（`plan-llm-failed`/`llm-failed`/`summarize-llm-failed`）日志的 `message` 字段
真的包含 `failingLlm` 注入的错误文本（`"simulated upstream failure"`），不是空字符串
——这在改动前是**不会**通过的（旧代码里这三条日志的 message 恒为 `""`，只是此前没有
测试断言过"非空"这件事，所以没人发现）。

## 5. `subagent` 任务分支：顺带接上真 tool loop

任务书没有明确要求重写 `processRequest()` 里 `"subagent"` task-kind 的分支，但
replan 伪代码的 `execute(plan)` 那一行注释写的是"走 W2-a 的真子代理"，且 W2-b 的交接
说明第 1/3 点都在指向这处衔接——所以顺带把它接了：

- **有真实工具面时**（`getToolRunner()` 非 null）：走 `buildSubAgentSpec()` +
  `runSubAgent()`，真的能检索/跑工具，`ExecutionOutcome.ok` 现在等价于
  `result.stopReason === "done"`（`budget`/`timeout`/`denied` 都不冒充成功，输出前缀
  `[子代理未完成，stopReason=X]`）。
- **没有真实工具面时**（没注入 `toolRunner`，也没注入 `projects`）：退回旧路径，裸
  `llm.call`，零工具——不静默假装有工具，只是老老实实做它一直在做的事。这条退路的存在
  是为了不破坏 `narrative_parity.test.ts`（不在本 lane 所有权内）与
  `tests/unit/orchestrator.test.ts` 里大量不注入 project 的既有测试用例；这些测试全部
  维持原有行为不变（1218 条基线测试 0 回归）。

**`getToolRunner()` 的惰性构造**：`OrchestratorAgent` 新增 `OrchestratorDeps.toolRunner`
（测试注入用）与私有方法 `getToolRunner()`——注入的优先用；没注入但 `this.projects`
存在时，第一次真的需要工具面时惰性 `new McpToolRunner({ projects: this.projects, agent:
this })` 并缓存复用（不是每次子代理调用都重新构造一份，对应 W2-b 交接说明第 3 点）；
两者都没有时返回 `null`，调用方据此走旧路径或报错。`agent: this` 与
`mcp/server.ts → server/app.ts → agents/orchestrator.ts` 构成一个模块级循环依赖，但
双方都只在**函数体内**（不是模块顶层）用到对方的绑定，ESM 的循环 import 在这种模式下
没有问题——`server/app.ts` 的 `ServerContext` 构造函数本来就已经是这个模式。

**`subAgentLlm()` 适配器**：`SubAgentDeps.llm` 要求
`Pick<LLMRouter,"call"|"capabilitiesFor">`（`capabilitiesFor` 是必填，不支持 tool
calling 的模型必须走 `sub_agent.ts` 的显式降级）。见下一节。

## 6. 与 W2-b 交接说明的一处偏离：没有收紧 `OrchestratorDeps.llm` 的类型

W2-b 的交接说明建议把 `OrchestratorDeps.llm` 从 `Pick<LLMRouter,"call"|"listModels">`
收紧成 `Pick<LLMRouter,"call"|"capabilitiesFor">`（因为 `SubAgentDeps.llm` 需要后者）。
本 lane **没有这样做**，原因是这会破坏一个不在本 lane 文件所有权内的文件：
`tests/unit/narrative_parity.test.ts` 里构造 `OrchestratorAgent` 用的 `mockLlm`/
`failingLlm`/`subagentPlanLlm` 三个假 LLM 都只实现了 `call`/`listModels` 两个方法，
如果收紧 `OrchestratorDeps.llm` 的类型，这个文件的 `bun run typecheck` 会立刻红——而
这个文件不归本 lane 管，改不了。

**改用运行期适配**（`OrchestratorAgent.subAgentLlm()`）：有 `capabilitiesFor` 就直接
转发；没有就保守假设 `{toolCalling:true, jsonMode:true, streaming:true,
usageReported:true}`。这个假设的安全性建立在一个前提上：**没有 `capabilitiesFor` 的
假 LLM 只有在同时也没有 `toolRunner`/`projects` 时才会被测试用到**（`getToolRunner()`
的降级设计——没有真实工具面时走的是旧的裸 `llm.call` 路径，根本不会调用
`subAgentLlm()`）。凡是测试想真正触发真 tool loop（无论是 `executeTask` 的 subagent
分支还是 `runResearchLoop()`），都必须同时注入 `toolRunner` 并且给 `llm` 一个真正的
`capabilitiesFor`（本 lane 新增的全部相关测试都是这么做的）——两个条件叠在一起，"保守
假设 toolCalling:true" 这条兜底逻辑不会被没打算测真 tool loop 的用例踩到。

这是一处经过权衡的、有意的设计偏离，不是漏做——如果未来 `narrative_parity.test.ts`
的所有权转移或者那三个假 LLM 补上了 `capabilitiesFor`，可以把 `OrchestratorDeps.llm`
的类型收紧回 W2-b 建议的样子，`subAgentLlm()` 这层适配器就能删掉。

## 7. 四次阴性对照（实跑，终端输出）

全部通过"临时 mutate → 跑对应测试确认红 → revert → 重跑确认绿"的流程，改动已用
`git diff`/`grep "NEGATIVE CONTROL"` 确认全部撤回、工作树干净。

### ① observation 不回流（第二轮 planner 拿不到第一轮结果）→ 测试红

把 `replan.ts` 的 `lastObservations = observations;` 注释掉（让它永远保持上一次进入
循环前的值，第一轮是 `[]`，之后也不会变）：

```
bun test tests/unit/replan.test.ts -t "按伪代码顺序执行两轮"

tests/unit/replan.test.ts:
200 |     const secondRoundObs = plannerCalls[1]!.lastObservations;
201 |     expect(secondRoundObs.length).toBe(1);
                                        ^
error: expect(received).toBe(expected)
Expected: 1
Received: 0
(fail) runReplanLoop > 按伪代码顺序执行两轮后 contract.allDone() → stopReason:'done'，
第二轮 planner 收到第一轮的 observation [9.27ms]

 0 pass
 7 filtered out
 1 fail
```

revert 后重跑：`8 pass / 0 fail`。

### ② `stopReason` 为 `budget`/`no_progress` 却报成完成 → 测试红

把 `runReplanLoop()` 里两处 `return { rounds, stopReason: evaluation.stopReason, ... }`
/ `return { rounds, stopReason: "budget", ... }` 都改成硬编码 `stopReason: "done"`：

```
bun test tests/unit/replan.test.ts -t "no_progress|budgetExceeded"

tests/unit/replan.test.ts:
224 |     expect(result.stopReason).toBe("no_progress");
                                    ^
error: expect(received).toBe(expected)
Expected: "no_progress"
Received: "done"
(fail) runReplanLoop > 连续两轮无新增证据 → stopReason:'no_progress'，不是 'done' ...

252 |     expect(result.stopReason).toBe("budget");
                                    ^
error: expect(received).toBe(expected)
Expected: "budget"
Received: "done"
(fail) runReplanLoop > budgetExceeded() 触发 → stopReason:'budget' ...

 0 pass
 6 filtered out
 2 fail
```

revert 后重跑：`8 pass / 0 fail`。

### ③ 绕开 `evaluateRound()` 自己判完成 → 测试红

把 `runReplanLoop()` 里 `const evaluation = evaluateRound(contract, guard, q);` 替换成
一段手搓逻辑——只看 `contract.evaluate(q).allDone`，完全不看 `guard`（即不再消费
`NoProgressGuard` 的 `no_progress` 判据）：

```
bun test tests/unit/replan.test.ts -t "no_progress"

tests/unit/replan.test.ts:
224 |     expect(result.stopReason).toBe("no_progress");
                                    ^
error: expect(received).toBe(expected)
Expected: "no_progress"
Received: "budget"
(fail) runReplanLoop > 连续两轮无新增证据 → stopReason:'no_progress' ...

 0 pass
 7 filtered out
 1 fail
```

（循环因为再也不会触发 `no_progress`，一路跑到 `maxRounds:10` 命中安全阀，报成
`"budget"`——这本身就是"绕开 evaluateRound 会导致循环不再尊重 no_progress 停机条件"
最直接的证据。）revert 后重跑：`8 pass / 0 fail`。

### ④ `onDelta` 传了却没有增量吐出 → 测试红

把 `orchestrator.ts` 的 `summarize()` 里 `const options: CallOptions = { model:
LLMRouter.DEFAULT_MODEL, ...(onDelta ? { onDelta } : {}) };` 改成不转发 `onDelta`的
`const options: CallOptions = { model: LLMRouter.DEFAULT_MODEL };`：

```
bun test tests/unit/orchestrator.test.ts -t "onDelta 收到 summarize"

tests/unit/orchestrator.test.ts:
418 |     expect(deltas).toEqual(["第一段 ", "第二段"]);
                         ^
error: expect(received).toEqual(expected)
- [ "第一段 ", "第二段" ]
+ []
(fail) OrchestratorAgent · onDelta 接的是 summarize() 权威调用本身 > 正例：onDelta 收到
summarize() 调用吐出的真实增量，且顺序与最终 summary 一致 [4.23ms]

 0 pass
 20 filtered out
 1 fail
```

revert 后重跑：`21 pass / 0 fail`（本文件全量）。

## 8. 六套件数字（本 lane worktree，`SPARK_E2E_PORT=4431` 实跑，均为最终态）

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（`tsc --noEmit` 两遍，含 frontend/workspace） |
| `bun test tests/unit/` | **1235 pass / 0 fail / 0 skip**（基线 1218 + 本 lane 新增 17：`replan.test.ts` 8 条 + `orchestrator.test.ts` 新增 9 条） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e` | **14/14** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

没有套件跳过或没能跑成——七项要求（六套件 + typecheck）全部实跑并全绿。

## `ALLOWED_ORPHANS` 登记变化

删除了 `backend/src/agents/contract.ts` 的「等接线」登记：`orchestrator.ts` 现在
`import { createLiteratureReviewContract, RecordStoreEvidenceQuery, NoProgressGuard,
evaluateRound, describeStop, ... } from "./contract"` 并在 `runResearchLoop()` 里真实
消费（构造契约、`evaluate()`、`evaluateRound()` 判停机），contract.ts 有了真实生产
调用方，按门禁的对称检查删除了这一条。没有新增任何登记（`replan.ts` 是新文件，但它
从第一天起就有生产调用方——`orchestrator.ts` 的 `import { runReplanLoop, ... } from
"./replan"`——所以从未成为孤儿，不需要登记）。

## 诚实的已知缺口 / 未完成项

- **`server/routes/session.ts` 没有改**（不在本 lane 文件所有权内）：`onDelta` 的口子
  已经开在 `processRequest`/`chat()`，但主会话需要按第 3 节的「给主会话的接线说明」
  实际改 `/stream` 端点才能让它在生产路径上生效；`tests/e2e/**` 的"⑬ SSE 预览流"用例
  也需要跟着更新，同样不在本 lane 所有权内。
- **多轮 reviewer 修正场景下 `onDelta` 会重复吐出每一轮 `summarize()` 的增量**——已知
  简化，见第 3 节。
- **`runResearchLoop()` 没有 CLI/HTTP 入口**——只是 `OrchestratorAgent` 上的一个公开
  方法，`backend/src/index.ts`/`server/routes/**` 都不在本 lane 所有权内，接线说明见
  第 3 节。
- **`planResearchRound()` 的 LLM 调用失败时的确定性兜底（`defaultResearchPlan()`）只
  取"第一个未完成 stage"派一个子代理**，不是特别聪明——但循环不会因此卡死（这是它的
  唯一职责），真正的决策质量依赖 LLM 驱动的主路径。
- **`runResearchLoop()` 目前只在 `tests/unit/orchestrator.test.ts` 里用一个自定义单
  stage 契约做了端到端验证**，没有拿真实的 `literature-review` 三 stage 契约跑一次
  完整的多轮闭环（历经 searched → read_cards → citations_verified 三个 stage 依次
  完成）——那需要 fake tool runner 模拟更多真实工具语义（精读卡的 `cites` 边、citation
  review 的 metadata 形状），核心循环机制已经被 `replan.test.ts` 的多轮测试
  （用 literature-review 契约本身）与本文件的单 stage 集成测试分别覆盖过，判断这个
  差距不影响机制正确性，但如实记录为未做的额外验证。
