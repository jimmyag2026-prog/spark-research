# W3-b · agent_run 帧级记账（v0.4 方案 §4.3）

> lane W3-b，波次 W3。方案真源 `docs/DEVELOPMENT_PLAN_v0.4.md` §4.3（P13 设计）
> 与 §五·补.2（`C-c agent_run 帧级记账`，零跨依赖，随时可开）。
> 文件所有权：`backend/src/agents/ledger.ts`（新建）、`backend/src/project/records.ts`
> （只加 agent_run 这一类 record 的类型与校验）、`tests/unit/ledger.test.ts`（新建）、
> `tests/unit/narrative_parity.test.ts`（只加 `ALLOWED_ORPHANS` 一条登记）、本文件。

## 背景与定位

Claude Science 的 `frames` 表带 `model`/`effort`/token/`total_cost`，OpenScience 有
harness `fingerprint`。spark 已经有证据图（`project/records.ts` 的 `RecordStore`：
原本 8 类 record + 5 类边）——记账不新起一张表，**直接落图**：`agent_run` 是第 9 类
record，`report`/lineage/UI 时间线因为本来就读图，免费获得对这类 record 的支持。
这是「证据图是万能接口」这个架构赌注的第二次兑现（第一次是 P5/P6 干湿实验闭环共用
同一套 record/edge 语义）。

## 1. 第 9 类 record：`agent_run` —— 怎么走的 rev/integrityHash 路径

**没有碰 `models.ts` 的 `RECORD_TYPES`**：那是跨多条并行 lane 共享的文件，本 lane
（W3-b）文件所有权只到 `records.ts`。同一波次里其它 lane 也在改共享文件，抢着改
常量表只会造成合并冲突，所以决定让 "agent_run" 走一条**平行窄口**：

```ts
// backend/src/project/records.ts
export const AGENT_RUN_RECORD_TYPE = "agent_run" as const;

export interface AgentRunRecordInput {
  agent: string;
  model: string;
  provider: string;
  systemHash: string;
  promptHash: string;
  usage: Usage;          // 直接复用 llm/types.ts 的 Usage，不重新定义一遍
  toolCalls: number;
  stopReason: string;
  parentRunId?: string | null;
  extraMetadata?: Record<string, unknown>;
  title?: string; content?: string; evidence?: EvidenceLabel;
  origin?: RecordOrigin; createdAt?: string;
}

class RecordStore {
  createAgentRun(input: AgentRunRecordInput): ResearchRecord { ... }
  private insertRow(row: {...}): ResearchRecord { ... }   // 新抽出的共享写入点
}
```

**同一套写入路径怎么证明**：把 `create()` 原来内联的 `INSERT INTO records ...` 抽成
私有方法 `insertRow()`，`create()` 自己改造成先做 8 类 record 的校验（`RECORD_TYPES`
成员检查、`evidence`/`origin` 合法性、`artifact` 类型必须有 `artifactId`）再调
`insertRow()`；`createAgentRun()` 做 `agent_run` 专属校验（`validateAgentRunInput()`：
`agent`/`model`/`provider`/`systemHash`/`promptHash`/`stopReason` 非空，
`usage.inputTokens`/`outputTokens` 是 number，`usage.costUsd` 是 number 或 null，
`toolCalls` 是非负整数）后同样调 `insertRow()`。**两条窄口只在校验上分叉，落库路径
（同一张 `records` 表、同一段 SQL、同一个 `randomUUID()`/`created_at` 默认值、同一次
`get()` 回读）从头到尾是同一处代码**——不是复制一份 INSERT 语句分叉维护。

`rev`（D-9 乐观并发 CAS）完全没有单独处理：`insertRow()` 走的是原来 `CREATE TABLE`
+ `migrateRevColumn()` 建出来的同一张表，新行的 `rev` 默认值（`DEFAULT 1`）与其它
8 类 record 完全相同；`update(id, patch, {expectedRev})` 是通用方法，agent_run 记录
不需要任何改动就能被 CAS 保护——`tests/unit/ledger.test.ts` 的
「走与其它 8 类 record 相同的 rev/CAS 路径」一条测试直接验证：`getRev()===1`、
带正确 `expectedRev` 的 `update()` 生效、带过期 `expectedRev` 的 `update()` 抛
`RecordConflictError`。

（现有的表级 `integrityHash` 机制其实是 `lab/wet_models.ts` 给湿实验 metadata 单独
做的一层「防绕过状态机改写」保护，不是 `RecordStore` 本身的通用字段——`records` 表
没有 `integrity_hash` 列。W3-b 的 `agent_run` 完整性保护是照同一个模式在 `ledger.ts`
里另起一份，见下面第 3 节。）

## 2. `AgentRunLedger` —— 最终接口

```ts
// backend/src/agents/ledger.ts
export type AgentRunStopReason = SubAgentStopReason | "no_progress";

export interface AgentRunFrame {
  agent: string; model: string; provider: string;
  systemPrompt: unknown;   // 喂给 computeSystemHash
  prompt: unknown;         // 喂给 computePromptHash
  usage?: Usage;           // 缺省 → UNKNOWN_USAGE（costUsd:null, usageUnavailable:true）
  toolCalls: number;
  stopReason: AgentRunStopReason;
  parentRunId?: string | null;
  title?: string; content?: string; origin?: RecordOrigin; createdAt?: string;
}

export interface AgentRunView {
  id: string; agent: string; model: string; provider: string;
  systemHash: string; promptHash: string; usage: Usage;
  toolCalls: number; stopReason: string; parentRunId: string | null;
  integrityHash: string | null; record: ResearchRecord;
}

export class AgentRunLedger {
  constructor(options: { records: RecordStore });
  record(frame: AgentRunFrame): AgentRunView;
  linkProduced(agentRunRecordId: string, producedRecordId: string): void;
  get(id: string): AgentRunView;              // 核验完整性，对不上抛 AgentRunIntegrityError
  children(parentRunId: string): AgentRunView[];
}

export function computeSystemHash(systemPrompt: unknown): string;
export function computePromptHash(prompt: unknown): string;
export class AgentRunValidationError extends Error {}
export class AgentRunIntegrityError extends Error {}
```

## 3. 指纹算法（systemHash / promptHash）

`computeSystemHash`/`computePromptHash` 都是 `sha256(JSON.stringify(canonicalize(x)))`
——`canonicalize()` 递归排序 object key（数组顺序保留），与 `lab/wet_models.ts` 的
`canonicalize()` 同一手法（本文件本地一份，两个文件不共享私有函数，避免未来产生
跨 lane 的文件所有权纠纷）。纯函数：不掺 `Date.now()`/`randomUUID()`，输入可以是
字符串也可以是消息数组等可 JSON 化的结构。

**两条性质分别有测试**（`tests/unit/ledger.test.ts`「指纹算法」describe 块）：
- **性质①（变了就变）**：`computePromptHash("find papers about X")` 与
  `computePromptHash("find papers about Y")` 不相等；`computeSystemHash` 同理。
- **性质②（同一 prompt 任何时候/任何调用都同一指纹）**：对同一份数据**独立构造两次**
  （对象 key 插入顺序刻意打乱）得到的哈希相等；同一字符串连续三次调用得到的哈希两两
  相等。

## 4. 父子 run 的表达

**边**：子 run 建一条 `derives_from` 边指向父 run——`records.link(childRunId,
parentRunId, "derives_from")`。方向口径取自全仓库既有约定（`mcp/tools.ts` 的边方向
说明：「derives_from 是产物→来源」），子 run 是从父 run 派生出来的调用，故
产物=子 run、来源=父 run。`AgentRunLedger.record(frame)` 在 `frame.parentRunId` 给了
时自动建这条边；`children(parentRunId)` 反向查 `derives_from` 入边、过滤出
`type==="agent_run"` 的对端并逐个 `get()`（因此也会核验每个子 run 的完整性）。

**产物 record 挂 agent_run 的 id**：同一方向的另一条边，`linkProduced(agentRunId,
producedId)` 内部是 `records.link(producedId, agentRunId, "derives_from")`——一次
run 里产出的 idea/observation/artifact/... 都可以调这个方法挂到对应的 agent_run 下，
两条边规则（父子、产物）方向完全一致，接线方不需要记两套方向。

## 5. 诚实铁律怎么落地

`frame.usage` 是 **`Usage | undefined`**（直接复用 `llm/types.ts` 的 `Usage`，不重新
定义），不是必填字段——调用方真的拿不到 usage 时可以不传。缺省时落
`UNKNOWN_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable:
true }`：这是本文件里唯一一处「缺省值」，也是诚实铁律最容易被悄悄破坏的地方（把
`costUsd` 顺手写成 `0` 而不是 `null`），所以单独抽成具名常量，并有阴性对照①钉住它
（见下）。

`record()` 还有一条运行时兜底 `assertHonestUsage()`：如果调用方传了
`usageUnavailable: true` 却同时给了非 null 的 `costUsd`（自相矛盾——既然拿不到
usage，不可能算出真实成本），直接抛 `AgentRunValidationError`，账本不替调用方圆谎。
`usage` 拿到了但单价查不到（`costUsd: null`，`usageUnavailable` 不给/false）是合法
状态，照常透传，不报错——这与 `llm/budget.ts` 的 `BudgetLedger` 完全一致的语义（本
文件只读引用 `Usage` 类型，不重复实现定价逻辑；`priceFor`/`BudgetLedger.record()`
产出的 `Usage` 可以原样传进 `AgentRunFrame.usage`）。

## 6. 完整性（integrityHash）怎么落地

参考 `lab/wet_loop.ts`/`wet_models.ts` 已经验证过的模式（`computeMetaIntegrityHash`
+ `verifyMetaIntegrity`），本文件另起一份同构但独立的实现（不复用那边的
`RecordIntegrityError`——它的消息文案是湿实验专属的，且那个文件不在本 lane 所有权
内）：

- 参与哈希的字段（`ProtectedFields`）：`agent`/`model`/`provider`/`systemHash`/
  `promptHash`/`usage`/`toolCalls`/`stopReason`/`parentRunId`——即「这条 agent_run
  record 的核心事实」，不含 `integrityHash` 自己。
- `record()` 写入前算好 `integrityHash` 存进 `metadata.integrityHash`（通过
  `AgentRunRecordInput.extraMetadata` 传给 `RecordStore.createAgentRun()`，浅合并进
  metadata，不是二次写入）。
- `get()`/`children()` 内部的 `toView()` 读回来后重算一遍比对，对不上就抛
  `AgentRunIntegrityError`——**不静默放行**。触发场景：有人绕开 `AgentRunLedger`，
  直接用 `RecordStore.update(id, {metadata:{...}}, {expectedRev})` 改了
  `toolCalls`/`stopReason` 等受保护字段（这是 `RecordStore` 的合法通用窄口，本身没
  错；但完整性哈希会告诉下一个读者"这条记录的核心事实被动过手脚，不要信任"）。

## 7. 三次阴性对照（强制项，全部实跑）

### ① 拿不到 usage 时填 0 而非 null → 测试红

把 `UNKNOWN_USAGE` 临时改成 `{ inputTokens: 0, outputTokens: 0, costUsd: 0,
usageUnavailable: false }`（故意冒充"免费"），重跑：

```
$ bun test tests/unit/ledger.test.ts

tests/unit/ledger.test.ts:
176 |   test("frame.usage 缺省 → costUsd=null 且 usageUnavailable=true，绝不是 costUsd:0", () => {
...
181 |     expect(view.usage.costUsd).toBeNull();
                                     ^
error: expect(received).toBeNull()

Received: 0

(fail) AgentRunLedger.record() · 诚实铁律 > frame.usage 缺省 → costUsd=null 且 usageUnavailable=true，绝不是 costUsd:0 [2.08ms]

 17 pass
 1 fail
 50 expect() calls
Ran 18 tests across 1 file. [54.00ms]
```

改回原样后重跑：18 pass / 0 fail（见 §8）。

### ② prompt 改了但指纹不变 → 测试红

把 `computePromptHash()` 临时改成忽略入参、返回恒定哈希：

```ts
export function computePromptHash(prompt: unknown): string {
  return sha256Of("阴性对照②：故意忽略输入，恒定指纹");
}
```

重跑：

```
$ bun test tests/unit/ledger.test.ts

tests/unit/ledger.test.ts:
142 |   test("性质①：内容变了指纹必须变", () => {
143 |     const h1 = computePromptHash("find papers about X");
144 |     const h2 = computePromptHash("find papers about Y");
145 |     expect(h1).not.toBe(h2);
                         ^
error: expect(received).not.toBe(expected)

Expected: not "4577ddaa954f79e4178b602fc425a2d04cf4bc39284de99f9b047343e5e517a3"

(fail) 指纹算法：systemHash/promptHash > 性质①：内容变了指纹必须变 [3.91ms]

 17 pass
 1 fail
 52 expect() calls
Ran 18 tests across 1 file. [208.00ms]
```

改回原样后重跑：18 pass / 0 fail（见 §8）。

### ③ agent_run record 绕过 integrityHash 写入 → 测试红

把 `toView()` 里的核验短路掉（`if (false && ...)`，模拟"完整性校验被绕过、未拦截"）：

```ts
if (false && storedHash !== null && computeIntegrityHash(fields) !== storedHash) {
  throw new AgentRunIntegrityError(record.id);
}
```

重跑：

```
$ bun test tests/unit/ledger.test.ts

(fail) AgentRunLedger 完整性校验（integrityHash，不绕过 rev/CAS 机制） > 绕过 AgentRunLedger、直接用 RecordStore.update() 改受保护字段 → get() 拒绝信任
error: Expected function to throw

(fail) AgentRunLedger 完整性校验（integrityHash，不绕过 rev/CAS 机制） > 绕过写入还会污染 children()：父 run 的子列表读取同样拒绝信任被篡改的子 run
error: Received function did not throw
Received value: [ { id: "...", ..., stopReason: "done-but-fake", ... } ]

 16 pass
 2 fail
 53 expect() calls
Ran 18 tests across 1 file. [82.00ms]
```

两条完整性测试如期变红——证明它们不是空壳，真的在验证 `toView()` 的核验分支本身。
改回原样后重跑：18 pass / 0 fail（见 §8）。

## 8. 接线说明（给 W3-a / 收口）

W3-a 的 replan 循环 / orchestrator 是本文件设计时假定的消费方，但本 lane worktree
里没有它的实现，所以 `ledger.ts` 目前在生产代码里零调用方——已在
`tests/unit/narrative_parity.test.ts` 的 `ALLOWED_ORPHANS` 登记「等接线」，**接上后
必须删除那条登记**（门禁的『多余登记必须删除』对称检查会强制这件事）。

接线时需要做的事（按依赖顺序）：

1. **构造一次性的 `AgentRunLedger` 实例**，与 `RecordStore` 一一对应（同一个
   project 的 `RecordStore` 传进去即可，`AgentRunLedger` 本身无状态、不持有 DB
   连接，构造成本可以忽略，每次调用现造也可以）。
2. **每次 LLM 调用后**（子代理 tool loop 里，或 replan 循环里的每一轮 planner/
   execute/distill 调用）调 `ledger.record(frame)`：
   - `frame.usage` 直接传 `BudgetLedger.record()` 返回的 `snapshot` 里那次调用对应
     的 `Usage`（或者更简单：`SubAgentResult.usage`），**不要**自己再造一个 usage
     对象——`AgentRunLedger` 不重算 token/价格，只负责记账落图。
   - `frame.systemPrompt`/`frame.prompt` 传实际发给模型的内容（`SubAgentSpec` 目前
     只存 `promptFile` 路径，接线时要读文件内容或渲染后的最终 prompt 字符串传进来，
     不要传文件路径本身——指纹要回答"哪版 prompt"，传路径而非内容不能回答这个问题）。
   - `frame.stopReason` 直接透传 `SubAgentResult.stopReason`（`AgentRunStopReason`
     已经是 `SubAgentStopReason` 的父集，子代理这条子集不需要转换）；replan 循环用
     `"no_progress"` 时同样直传。
   - 子代理的 run 记得传 `frame.parentRunId`（顶层 orchestrator run 的 record id）。
3. **产物挂靠**：子代理循环 / replan 循环里任何时候 `RecordStore.create()` 产出了新
   record（idea/observation/artifact/...），紧接着调
   `ledger.linkProduced(agentRunView.id, newRecord.id)`。
4. **读侧**（`report`/lineage/UI 时间线）本来就读 `RecordStore.graph()`/`list()`，
   `agent_run` record 会自动出现，**不需要**为它们单独改代码——这正是"证据图是万能
   接口"这个设计要兑现的红利。唯独如果某处想展示"这条记录被 AgentRunLedger 保护、
   完整性状态如何"，应该调 `ledger.get(id)` 而不是 `RecordStore.get(id)`（后者不核验
   完整性）。

## 9. 六套件数字（本 lane worktree，`SPARK_E2E_PORT=4432`，均为最终态）

阴性对照①②③的临时 mutate 均已撤回，以下是撤回后的重跑结果：

| 套件 | 命令 | 结果 |
|---|---|---|
| typecheck | `bun run typecheck` | 干净（0 error） |
| unit | `bun test tests/unit/` | **1236 pass / 0 fail / 0 skip**（基线 1218 + 本 lane 新增 18） |
| concurrency + timeout | `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| e2e | `bun run test:e2e` | **14/14 passed** |
| py | `bun run test:py` | 48 passed |
| lab | `bun run test:lab` | 26 passed |

## 10. 诚实的未完成项

- **models.ts 的 `RECORD_TYPES` 仍然是 8 项**，不包含 "agent_run" 字面量——本 lane
  刻意不改这个跨 lane 共享文件（见 §1）。`agent_run` record 能正常创建/读取/走
  rev-CAS，但任何直接依赖 `RECORD_TYPES` 数组本身（而不是走
  `RecordStore.createAgentRun()`）做穷举/校验的代码（目前已知：
  `capabilities/index.ts`、`server/routes/records.ts`、`tests/unit/
  capabilities.test.ts`）**不会**把 "agent_run" 当作已知类型处理。收口时需要把
  "agent_run" 并入 `RECORD_TYPES`，并核对这三处是否需要跟着更新——本 lane 没有触碰
  它们（不在文件所有权内）。
- `ResearchRecord.type` 的静态类型仍然是 `RecordType`（8 种字面量的并集），但
  `createAgentRun()` 落库的真实运行时值是 `"agent_run"`——`ledger.ts` 里两处比较
  （`record.type as string`）已经处理了这个类型层面的不一致，并在代码里写清楚了
  原因；`mapRow()` 的 `row.type as RecordType` 转换本身对任何非法字符串都不会在
  编译期或运行期报错（这是 `records.ts` 既有的宽松点，不是本 lane 新引入的）。
- `AgentRunLedger` 没有自己的单元测试覆盖「跨真实进程边界」的指纹一致性（用子进程
  重新起一个 `bun` 进程调用 `computePromptHash`）——鉴于该函数不掺任何进程内状态
  （无闭包变量、无 `Date.now()`/`randomUUID()`），这层测试在数学上等价于"纯函数
  两次调用结果相同"，已有测试覆盖；如果收口时想要更强的实证，可以加一条
  `Bun.spawn` 子进程测试。

## 哪些套件没能在本 lane 跑成

没有。六项阶段门（typecheck / unit / concurrency+timeout / e2e / py / lab）全部实跑
并全绿，数字见 §9；三次阴性对照全部实跑，输出已完整贴在 §7，且确认临时改动已全部
撤回、工作树干净。
