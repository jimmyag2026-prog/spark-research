# W1-a · AgentToolBus（授权 / 预算 / 审计）

> lane W1-a，波次 W1。方案真源 `docs/DEVELOPMENT_PLAN_v0.4.md` §4.2（P12 设计）
> 与 §五·补.2（波次调度、任务级依赖图 `R-c → T-a ToolBus → T-b 子代理 tool loop`）。
> 文件所有权：`backend/src/agents/toolbus.ts`（新建）、`tests/unit/toolbus.test.ts`（新建）、
> `tests/unit/narrative_parity.test.ts`（仅改 `ALLOWED_ORPHANS` 登记）、本文件。

## 交付

新建 `backend/src/agents/toolbus.ts`：`AgentToolBus` 套在 P9 的 `McpToolRunner` 外面，
不重实现任何业务逻辑——每次调用仍然是 `McpToolRunner.call()` 对 P7 HTTP app 的一次
进程内 `fetch()`；本层只加授权 / 预算 / 审计三层。

### 最终接口

```ts
export interface ToolBusOptions {
  runner: McpToolRunner;      // P9 已有，不重造
  grants: string[];           // 白名单工具名（AD-2 兑现）
  budget: BudgetLedger;       // R-c 交付，本层是它的第一个生产消费方
  audit: (e: ToolAuditEntry) => void;
  timeoutMs: number;
}

export class AgentToolBus {
  specs(): ToolSpec[];        // 过滤到 grants 子集的 MCP_TOOLS，同源不重写
  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}
```

`ToolOutcome` 是一个可辨识联合，`denied` 字段的有无就是「被拒绝」与「执行失败」的
唯一分界（`isDenied()` 辅助函数）：

```ts
export type ToolDenialReason = "not_granted" | "withheld" | "budget_exceeded";

export interface ToolDenial {
  ok: false;
  denied: ToolDenialReason;
  message: string;
  granted?: string[];          // not_granted 时：当前授权清单
  reason?: string;             // withheld 时：直接透传 MCP_WITHHELD 的理由
  humanAction?: string;        // withheld 时：人该怎么做
  exceeded?: BudgetLimitKind[]; // budget_exceeded 时：确定超限的维度
  snapshot?: BudgetSnapshot;    // budget_exceeded 时：完整快照
}

export interface ToolExecuted {
  ok: boolean;   // 真的执行了；ok:false 也可能发生（上游 4xx/5xx、超时）
  payload: unknown;
}

export type ToolOutcome = ToolDenial | ToolExecuted;
```

`specs()` 直接过滤 `MCP_TOOLS`（`backend/src/mcp/tools.ts`）到 `grants` 子集，
`name`/`description`/`inputSchema` 三个字段逐字段复制，不另写一份 schema——
`tests/unit/toolbus.test.ts` 的第一组测试断言了这个同源性（`toEqual` 原始 schema）。

## 三条硬规则与各自的测试

调用顺序（`call()` 内部）：**withheld → grants → budget → 执行 → 记账 → 审计**。
withheld 检查放最前面且无条件——即便 `grants` 里被误配了危险动作名，也照样拒绝，
这是 AD-14「无例外」在代码里的字面体现。

### 硬规则一：`MCP_WITHHELD` 无条件拒绝（AD-14）

直接 `MCP_WITHHELD.find((w) => w.name === name)`，不重新写一张危险动作表——
`reason`/`humanAction` 原样透传，与 `mcp/server.ts` 的现成实现同一个信息来源，
两张表不可能漂移（因为只有一张表）。

测试（`tests/unit/toolbus.test.ts`「硬规则一」describe 块）：
- 遍历全部 5 个 `MCP_WITHHELD` 条目，断言 `denied === "withheld"` 且
  `reason`/`humanAction` 与源表逐字相等。
- **红线测试**：把全部 5 个危险动作名故意塞进 `grants`（模拟授权配置错误），
  断言依旧被拒绝——证明这条防线不依赖「grants 没写错」这个前提。

### 硬规则二：未授权工具结构化拒绝，不抛异常（AD-2）

`grants.includes(name)` 为假时返回 `{ok:false, denied:"not_granted", granted:[...]}`，
`call()` 全程没有一条 `throw`（除非底层 runner 真的抛，那是「执行失败」范畴，
已经在 `try/catch` 里转成 `{ok:false, payload:{error}}`）。

测试：正常未授权、未知工具名（既不在 `MCP_TOOLS` 也不在 `grants`）两种情况；
并断言未授权的调用**不消耗预算**（`budget.snapshot().calls` 保持 0）。

### 硬规则三：预算超限结构化拒绝，与「执行失败」可区分

`call()` 执行前先读 `budget.snapshot()`，`exceeded.length > 0` 就拒绝
（`denied:"budget_exceeded"`，带 `exceeded` 维度数组与完整 `snapshot`）。

两条测试分别覆盖两种情况：
1. **纯前置检查**（用注入的可控时钟把 `maxWallMs` 提前推过上限，此刻还没有
   任何调用发生过）——证明「已经超限」这件事本身就能挡住第一次尝试，
   不需要先浪费一次调用才发现超了。
2. **`calls` 维度的边界语义**（如实记录，不是掩盖）：`BudgetLedger.exceeded`
   的判定是「严格大于」（`calls > maxCalls`），这是 R-c 既有实现的语义，本层
   没有加一层「预判下一次会不会超」的逻辑去堵这个边界——那需要 `BudgetLedger`
   支持"预览"接口，而它的设计文档明确说自己是"观测组件，是否硬停由调用方决定"。
   所以 `maxCalls:1` 时，恰好把计数推过上限的那一次调用会被放行，
   下一次才被拒绝。测试把这个边界**显式断言出来**，不让它变成一个没人知道的
   隐藏行为——代码里也在同一处加了注释指回这条测试。

`ToolExecuted` 与 `ToolDenial` 的可区分性单独测了一条：用假 `runner`
（`as unknown as McpToolRunner` 双重断言构造，只实现 `call()`，睡 50ms）
配 `timeoutMs:5`，触发超时。结果 `ok:false` 但 `isDenied()` 为假
（没有 `denied` 字段）——证明「预算够、也授权了，但执行本身失败」与
「被拒绝」在类型层面就分得开。同时确认超时也计入预算（`calls` +1）：
调用确实发生了，只是没等到结果，不能假装它没消耗资源。

## 计价维度的可扩展性（v0.4 方案 §4.2 第 6 条，接口预留）

`BudgetLedger.record()` 吃的是 `Usage`（`inputTokens`/`outputTokens`/`costUsd`），
这个形状是给 LLM 调用设计的。工具调用不是 LLM 请求，硬塞 token 字段既不诚实也不
可扩展——所以 `toolbus.ts` 没有直接把工具调用伪装成一次「0 token 的 LLM 调用」，
而是引入了一层自己的口子：

```ts
export interface ToolCallCost {
  unit: "call";        // 目前唯一取值；v0.5 可扩展为 "computeSeconds" | "gpuUnits" 等
  costUsd: number | null;
}

function costOf(_name: string, _args: Record<string, unknown>): ToolCallCost {
  return { unit: "call", costUsd: null }; // 所有工具现在都不计费，诚实记未知
}
```

`call()` 在真正执行完之后调 `costOf(name, args)` 拿到这个值，再喂给
`budget.record({inputTokens:0, outputTokens:0, costUsd: cost.costUsd, usageUnavailable:false})`。
关键是 `usageUnavailable` 显式传 `false`（而不是图省事传 `true` 把"未知成本"
悄悄吞掉）——这样账本会把每次工具调用都计入 `unknownCostCalls`，`costUsd`
保持 `null` 而不是被误读成"免费"，这正是 `budget.ts` 自己反复强调的
「绝不当 0 处理」纪律。

**v0.5 要接算力成本时**（提交一个 Modal GPU 任务 = 花真钱），只需要：
1. 给 `unit` 类型加一个新取值（如 `"computeSeconds"`）；
2. 让 `costOf()` 对特定工具名（例如未来的 `compute_submit`）返回真实 `costUsd`；

`AgentToolBus` 的构造函数签名、`call()` 的返回类型、审计记录的形状**都不需要改**。
这就是「接口预留」的字面意思——本 lane 只做到这一步，不写任何 v0.5 的
`costOf()` 分支实现。

测试锁死了这条不变式：成功调用一次工具后，`snapshot.inputTokens === 0`、
`snapshot.outputTokens === 0`（token 维度对工具调用天然不适用），但
`snapshot.unknownCostCalls === 1` 且 `snapshot.costUsd === null`（成本是
"说不出来"而不是"免费"）。

## 参数摘要脱敏

`argsSummary` 用 `JSON.stringify(args)` 后过 `backend/src/llm/types.ts` 导出的
`redactSecrets()`（只读复用，没有重写脱敏规则），超过 500 字符截断。测试用
一个 `sk-...` 形状的假密钥 + `authorization: "Bearer ..."` 验证审计记录里
既不包含原始密钥，也确实出现了 `[redacted]`。

## 三次阴性对照（强制项，实跑）

依次临时把每条硬规则的判断条件改成 `if (false && ...)`（保留原判断表达式，
只是短路掉），跑对应测试确认真的会红，再原样改回、重新确认绿，过程中没有
改动任何测试断言逻辑本身。

### ① 未授权工具被放行 → 测试红

```
bun test tests/unit/toolbus.test.ts
```
```
tests/unit/toolbus.test.ts:
112 |     const outcome = await bus.call("research_capabilities", { probe: false });
113 |     expect(outcome.ok).toBe(false);
                             ^
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) AgentToolBus · 硬规则二：未授权工具结构化拒绝（AD-2） > 不在 grants 里 → {ok:false, denied:'not_granted', granted:[...]}，不抛异常 [10.97ms]
131 |     const outcome = await bus.call("does_not_exist_at_all", {});
133 |     if (!isDenied(outcome)) throw new Error("unreachable");
                                            ^
error: unreachable
(fail) AgentToolBus · 硬规则二：未授权工具结构化拒绝（AD-2） > 未知工具名（既不在 MCP_TOOLS 也不在 grants）同样是结构化拒绝而不是异常 [4.75ms]
317 |     expect(entries[0]!.denied).toBe("not_granted");
                                     ^
error: expect(received).toBe(expected)
Expected: "not_granted"
Received: undefined
(fail) AgentToolBus · 审计：每次调用落一条记录，参数摘要脱敏 > 被拒绝的调用也落审计记录（resultSize 恒为 0），拒绝原因写进 denied [6.21ms]

 11 pass
 3 fail
```
禁用后放行是真的放行（`ok:true`），3 条测试如期变红。恢复判断条件后重跑，
14 pass / 0 fail。

### ② `lab_approve` 被子代理调通 → 测试红（AD-14 红线）

```
bun test tests/unit/toolbus.test.ts
```
```
tests/unit/toolbus.test.ts:
77 |       expect(outcome.denied).toBe("withheld");
                                  ^
error: expect(received).toBe(expected)
Expected: "withheld"
Received: "not_granted"
(fail) AgentToolBus · 硬规则一：AD-14 子代理永不自批准 > MCP_WITHHELD 的每个动作都被拒绝，且理由/人工动作与 MCP_WITHHELD 同源 [6.09ms]
99 |       if (!isDenied(outcome)) throw new Error("unreachable：危险动作必须走拒绝路径");
                                             ^
error: unreachable：危险动作必须走拒绝路径
(fail) AgentToolBus · 硬规则一：AD-14 子代理永不自批准 > **红线**：即便攻击者把危险动作塞进自己的 grants 列表，ToolBus 依旧拒绝——授权配置错误不能绕过 AD-14 [5.03ms]
319 |     expect(entries[1]!.denied).toBe("withheld");
                                     ^
error: expect(received).toBe(expected)
Expected: "withheld"
Received: "not_granted"
(fail) AgentToolBus · 审计：每次调用落一条记录，参数摘要脱敏 > 被拒绝的调用也落审计记录（resultSize 恒为 0），拒绝原因写进 denied [4.70ms]

 11 pass
 3 fail
```
值得记录的一个细节：「红线」那条测试禁用 ToolBus 自己的 withheld 检查后，
`outcome.ok` 依旧是 `false`（第一个 `expect` 没有报错），真正让测试失败的是
`isDenied(outcome)` 变成假——因为调用被放过了 ToolBus 这一层，落到了
`McpToolRunner.call()`，而 P9 的 runner **自己也**独立挡了 `MCP_WITHHELD`
（`backend/src/mcp/server.ts` 里同样查了一遍这张表）。这正好证明了两件事：
① P9 的运行时防线是真的、独立的（纵深防御），② 但这不能替代 ToolBus 自己的
检查——本 lane 要保证的是「ToolBus 这一层」的拒绝语义（`denied:"withheld"` +
理由 + 人工动作），子代理侧的调用方要能读到结构化拒绝，而不是拿到一个来自
更底层、形状不同的 `{ok:false, payload:{error}}`。恢复判断条件后重跑，
14 pass / 0 fail。

### ③ 超预算后仍能调用 → 测试红

```
bun test tests/unit/toolbus.test.ts
```
```
tests/unit/toolbus.test.ts:
158 |     const outcome = await bus.call("research_capabilities", {});
159 |     expect(outcome.ok).toBe(false);
                             ^
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) AgentToolBus · 硬规则三：预算超限结构化拒绝，且与「执行失败」可区分 > 已经超限（墙钟）时拒绝调用，且这次拒绝本身不再消耗预算 [13.72ms]
193 |     expect(third.ok).toBe(false);
                           ^
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) AgentToolBus · 硬规则三：预算超限结构化拒绝，且与「执行失败」可区分 > calls 维度的边界语义 [11.47ms]

 12 pass
 2 fail
```
禁用预算前置检查后，一个已经把墙钟推过 `maxWallMs` 上限、且一次调用都没
发生过的账本，第一次调用照样被放行执行；`maxCalls:1` 场景下第三次调用
（此时账本已经明确记录 `exceeded` 包含 `"calls"`）也照样放行。恢复判断条件
后重跑，14 pass / 0 fail。

## 六套件数字

全部在本 lane worktree（`SPARK_E2E_PORT=4411`）实跑，均为最终态（阴性对照
的临时改动已全部撤回后的重跑结果）：

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（`tsc --noEmit` 两遍，含 frontend/workspace） |
| `bun test tests/unit/` | **1032 pass / 0 fail / 0 skip**（基线 1018 + 本 lane 新增 14） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e` | **13/13** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

没有套件跳过或没能跑成——六项阶段门全部实跑并全绿。

## ALLOWED_ORPHANS 登记变化

- 删除了 `backend/src/llm/budget.ts` 的「等接线」登记：`toolbus.ts` 现在
  `import { BudgetLedger, ... } from "../llm/budget"` 并在每次工具调用后
  `record()`，`budget.ts` 有了真实生产调用方，门禁的「多余登记必须删除」
  对称检查会强制这件事，已经做了。
- 新增 `backend/src/agents/toolbus.ts` 自己的「等接线」登记：本 lane 交付的
  `AgentToolBus` 目前没有生产调用方——它的消费方是 W2-a 的子代理 tool loop
  （`agents/orchestrator.ts` / `agents/sub_agent.ts`），还没落地。**W2-a
  接上之后必须删除这条登记**，否则门禁的对称检查会红（这是预期行为，方案
  §5.3·补写得很清楚）。

只加了这一条登记，没有动 `narrative_parity.test.ts` 的任何断言逻辑。

## 给 W2-a 的交接说明

### 怎么构造一个 `AgentToolBus`

```ts
import { McpToolRunner } from "../mcp/server";
import { AgentToolBus } from "./toolbus";
import { BudgetLedger } from "../llm/budget";

const runner = new McpToolRunner({ /* 同 createApp 的 deps，或注入测试 app */ });
const budget = new BudgetLedger({ maxCalls: 50, maxWallMs: 5 * 60_000 });
const bus = new AgentToolBus({
  runner,
  grants: DEFAULT_PERMISSIONS[subAgentType], // sub_agent.ts 里已经有的 permission 表
  budget,
  audit: (entry) => auditLog.push(entry), // 或写进某种持久化审计通道
  timeoutMs: 30_000,
});
```

### `grants` 怎么给

`sub_agent.ts` 现有的 `DEFAULT_PERMISSIONS`（`explore`/`execute`/`review`/`lab`
四类）是字符串数组，但那是**旧的、v0.1 时代的权限名**（`"read_frames"`、
`"python"` 这类抽象能力名），跟 `MCP_TOOLS` 的工具名（`"lit_search"`、
`"exp_run"` 这类）不是一回事。**W2-a 需要做一次映射**：要么把
`DEFAULT_PERMISSIONS` 改写成直接列 MCP 工具名（更简单、更符合
`AgentToolBus.grants: string[]` 的字面语义），要么在 `sub_agent.ts`（W2-a
文件所有权）里加一层「权限类别 → 工具名集合」的转换函数。本 lane 没有替
W2-a 做这个决定——`sub_agent.ts` 不在 W1-a 的文件所有权范围内。

**记住 `grants` 里绝对不要出现 `MCP_WITHHELD` 里的名字**——虽然 ToolBus 会
拦（红线测试已经验证过），但把危险动作写进 grants 本身就是一个不该发生的
配置错误信号，`sub_agent.ts` 的权限映射函数最好在源头就排除掉它们。

### 预算怎么分给多个子代理

`BudgetLedger.child()` 是现成的（R-c 交付，`budget.ts` 里）：给每个子代理
一个 `parentLedger.child(subLimits)`，子代理自己的 `AgentToolBus` 拿这个
子账本。子账本超限只影响这个子代理自己的调用；父账本的 `snapshot()` 能看到
全部子代理汇总后的总花费，父账本的 `maxCostUsd`/`maxCalls` 能拦住「每个子
代理都没超，但加起来超了」的情况。`AgentToolBus` 本身不关心这层父子关系，
它只认自己拿到的那一个 `BudgetLedger` 实例。

### 审计条目的形状

```ts
interface ToolAuditEntry {
  tool: string;
  argsSummary: string;   // 已脱敏，最长 500 字符 + 截断标记
  ok: boolean;
  denied?: "not_granted" | "withheld" | "budget_exceeded"; // 只在被拒绝时存在
  durationMs: number;
  resultSize: number;    // 结果体 JSON 字符串长度；被拒绝时恒为 0
  timestamp: number;     // 调用开始时刻（Date.now()）
}
```

每次 `bus.call()` **恰好**触发一次 `audit()` 回调，覆盖全部路径（三种拒绝 +
执行成功 + 执行失败/超时）——不会漏记，也不会重复记。`stopReason` 相关的
判定（C-a/C-b 的 `budget` vs `done`）建议直接查 `BudgetLedger.isExceeded()`
或 `snapshot().exceeded`，不要试图从审计日志里反推预算状态——账本本身就是
权威来源，审计日志只是给人看的记录副产物。

### 已知的、故意不处理的边界

- `calls` 维度的「严格大于」语义：`maxCalls:N` 会放行恰好第 N+1 次调用，
  第 N+2 次才被拒绝。见本文件「硬规则三」一节与代码里对应的注释。子代理
  循环如果对这个边界敏感（比如想要精确的「最多 N 次」），可以在自己的
  `stopReason` 判定里额外查 `budget.snapshot().calls >= N`，不需要
  `AgentToolBus` 改行为。
- `costOf()` 现在对所有工具都返回 `costUsd: null`——没有任何工具是"计费的"。
  v0.5 之前，`unknownCostCalls` 会随每次工具调用递增，`budget.snapshot().costUsd`
  会一直是 `null`。这是诚实的表现（工具调用真的不知道值多少钱），不是 bug。

## 哪些套件没能在本 lane 跑成

没有。六项阶段门（typecheck / unit / concurrency+timeout / e2e / py / lab）
全部实跑并全绿，数字见上表。三次阴性对照全部实跑，输出已完整贴在本文件。
