# W2-b · Research Contract（AD-10：完成判定问图不问模型）

> lane W2-b，波次 W2。方案真源 `docs/DEVELOPMENT_PLAN_v0.4.md` §4.3（P13 设计）与
> `docs/DEVELOPMENT_PLAN_v0.3.md` §4.3.1（AD-10 的原始提出处）。
> 文件所有权：`backend/src/agents/contract.ts`（新建）、`tests/unit/contract.test.ts`
> （新建）、`tests/unit/narrative_parity.test.ts`（仅改 `ALLOWED_ORPHANS` 登记）、本文件。

## 为什么这条是 v0.4 最有原创性的一条

OpenScience 的完成边界是 `contract.stages.every(status === 'completed')`——形态对，
但 stage 的 `completed` 由 agent **自报**。Claude Science 是状态机驱动，但判据仍然在
模型侧。两个参照系共享同一个洞：agent 可以宣布自己完成了。

spark 有证据图（`project/records.ts` 的 `RecordStore`：8 类 record + 5 类边），所以可以
做得更硬：**完成判定是对证据图的一次确定性查询，不问模型**。这条不只是注释里的一句话，
而是落实在类型签名上——`ContractStage.check(q: EvidenceQuery)` 的参数列表里根本没有
装「模型怎么说」的位置。想让 check() 误判「完成」，唯一的办法是在证据图里真的造出对应
的 record；伪造完成的成本被抬高到了「伪造证据」的水平，而不是「说一句谎话」的水平。

## `EvidenceQuery` 的接口设计

```ts
export interface EvidenceSnapshot {
  readonly recordIds: ReadonlySet<string>;
}

export interface EvidenceQuery {
  snapshot(): EvidenceSnapshot;
  newSince(baseline: EvidenceSnapshot, type?: RecordType | RecordType[]): ResearchRecord[];
  listByType(type: RecordType | RecordType[], predicate?: (r: ResearchRecord) => boolean): ResearchRecord[];
  get(id: string): ResearchRecord | null;
  incoming(id: string, type?: EdgeType): ResearchRecord[];
  outgoing(id: string, type?: EdgeType): ResearchRecord[];
}
```

设计取舍：

- **只暴露只读方法**，不暴露 `RecordStore` 的 `create`/`update`/`link`。这不是约定，是
  类型层面的硬约束——`RecordStoreEvidenceQuery` 的构造参数类型是
  `Pick<RecordStore, "list" | "get" | "edgesOf">`，连写方法的类型签名都不在场。check()
  想顺手写图，这层接口没给它开口子。
- **`snapshot()` 返回 record id 的集合，不是时间戳**。这是给 `noProgress` 判据用的唯一
  输入，理由见下面 NoProgressGuard 一节。
- **`newSince()` 按集合差，不按时间戳**——同一毫秒内批量入库的多条 record（比如批量
  生成的精读卡）`created_at` 完全相同，用时间戳判断「新增」会不确定；集合差没有这个问题。
- **`incoming`/`outgoing` 直接映射回对端 `ResearchRecord`**，不是裸的边——`read_cards`
  stage 需要判断"指向某篇 paper 的 `cites` 边，源端是不是一条 `reading` record"，
  只拿到边（`sourceId`/`targetId` 字符串）还得再查一次，接口直接把这一步做掉。
- 基于现有 `RecordStore`（`project/records.ts`，只读参考，一个字没改），不新增表，
  不碰 `rev`/`integrityHash`（那是写入路径的并发控制，本文件从头到尾没有一次写操作）。

## `literature-review` 契约：三个 stage 的具体判据

```
searched            本 session（=契约创建那一刻之后）新增 paper record ≥ 1
                     判据：query.newSince(baseline, "paper").length >= 1
                     evidence = 新增的 paper record id

read_cards           项目里现存的每一篇 paper record 都有 ≥1 条 reading record
                     通过 `cites` 边指向它（集合包含关系）
                     判据：对每个 paper，query.incoming(paper.id, "cites")
                           里有没有 type === "reading" 的记录
                     evidence = 覆盖到的 reading record id（不是 paper id——
                           指向"凭什么说完成了"应该指向真正产生这条证据的记录）

citations_verified   存在 metadata.kind === CITATION_INTEGRITY_REVIEW_KIND 的
                     observation record，且**最近一次**（按 createdAt 排序取最后一条）
                     的 hardFindingCount === 0
                     evidence = 那条 review record 的 id（未完成时为空）
```

`read_cards` 的判据刻意基于**项目里现存的全部 paper**，而不是限定在 `searched` 新增的
那批——一个综述项目可能跨多轮：第 1 轮搜到的论文，精读卡是在第 2 轮补的，`read_cards`
不该因为论文不是"这一轮新增"就不认它。`searched` 才需要"本 session 新增"这个限定
（否则它会在第 1 轮完成后就永远卡在 done=true，无法反映"这一轮到底有没有再搜"）。

### `citations_verified` 的已知缺口：目前没有生产者

`literature/cli.ts` 的 `lit review` 命令会跑 citation-integrity 核验
（`reviewer/rules.ts` 的 `CITATION_RULE`），但目前只把 `hard`/`soft` finding 打印到
stdout、拿去决定退出码，**不落证据图**。也就是说，`metadata.kind ===
"citation-integrity-review"` 这个 record 约定，本 lane 只钉死了「长什么样、
check() 怎么判」，还没有任何代码真的去创建它。

这不是本 lane 能就地补的坑——`literature/**` 不在 W2-b 的文件所有权范围内（任务书
只给了 `agents/contract.ts` + 两个测试文件 + 本 devlog）。`tests/unit/contract.test.ts`
里验证 `citations_verified` 判据本身的正确性时，是直接用 `RecordStore.create()` 手工
构造这条 record（模拟未来生产者应该写出的形状），不依赖真实的 `lit review` 命令。

**给后续 lane 的交接**：`literature/cli.ts` 的 `case "review"` 分支（约 325-378 行）
算出 `check.findings` 之后，需要补一次
```ts
records.create({
  type: "observation",
  evidence: "computed",
  metadata: {
    kind: CITATION_INTEGRITY_REVIEW_KIND,   // 从 agents/contract.ts 导出，直接 import
    checker: CITATION_RULE,                 // reviewer/rules.ts
    targetRecordId: draft.recordId,
    hardFindingCount: hard.length,
    softFindingCount: soft.length,
  },
});
```
这不是 W3-a 的分内活（W3-a 管 replan 循环本身），大概率需要单独登记进 BACKLOG——
但本 lane 没有 BACKLOG.md 的写权限，所以只能记在这里，请主会话收口时转登。

## `noProgress` 怎么保证确定性

```ts
export class NoProgressGuard {
  constructor(initial: EvidenceSnapshot, private readonly threshold: number) { ... }
  tick(snapshot: EvidenceSnapshot): NoProgressState;
}
```

判据是**纯粹的集合运算**：`tick()` 把这一轮结束时的快照与**上一次** `tick()`（或构造
时的 `initial`）的快照做集合差，`recordIds` 的差集为空则 streak+1，非空则 streak 归零。
不看 `createdAt`（同毫秒批量写入会让时间戳判断不稳定）、不看数量（数量可能因为某条
record 被后续逻辑标记/覆盖而"看似没变"但其实换了内容——这里用的是 id 集合，只要 id
变了就算新增，不存在"更新算不算进展"这种要模型拿主意的灰区）、更不问模型"你觉得
还有进展吗"。两次 `Set<string>` 的差集是不是空，是一个确定性、可重放、任何人拿同样
两个快照算出来结果都一样的运算。

`threshold` 语义是"连续 n 轮"，用滚动比较实现（每次都和上一次比，不是都和最初的起点
比）——这与"累计 n 轮下来一个新节点都没有"在数学上等价，但滚动比较对"中途有一轮
有进展、之后又停滞"这种情况能正确把 streak 归零重算，累计比较做不到。

`evaluateRound()` 把 `contract.allDone()` 与 `guard.tick()` 汇总成一个 `StopReason`，
**`done` 优先于 `no_progress`**：哪怕最后一轮契约刚好在没有新增证据的情况下完成
（比如契约齐了之后又空转了一轮才被观察到），也应该报"正常完成"，不该把一次成功的
收官误报成"被迫停下"。`budget` 耗尽不在本文件判定——预算状态由调用方
（W3-a 的 replan 循环）持有，本文件只保证 `StopReason` 类型里有这个值可用，接口
留了口子。

## 报告未完成时要说人话

`ContractReport.summary` 与 `describeStop()` 不会只说"未完成"，而是逐条列出哪个
stage、什么描述、缺什么证据，例如（真实的测试输出，来自"连续两轮无新增"那个用例）：

```
契约 'literature-review' 因连续 2 轮证据图无新增节点而停止（未完成，不是假装完成——
宁可如实报告，不烧钱空转）。
契约 'literature-review' 未完成，2/3 个 stage 缺证据：
  - searched（本 session 新增 paper record ≥ 1（完成了检索））未完成：本 session 尚未
    新增任何 paper record（检索还没做，或做了但没有入库）
  - citations_verified（存在 citation-integrity 的 review 记录，且最近一次核验零
    hard finding）未完成：还没有 citation-integrity 的 review 记录（引用核验没跑过）
```

这段文案本身就是 `evaluateRound()` 真实产出，不是手写示例。

## 三次阴性对照（强制项，实跑）

### ① 伪造完成（AD-10 的核心）

`check(q: EvidenceQuery)` 的签名结构性地杜绝了"模型自报"这条输入通道。测试直接
验证这条防线：往证据图里塞一条"自我报告"（`type: "idea"`，
`content: "我已经完成了检索、精读卡和引用核验，全部 stage 都 done 了"`，
`metadata: { status: "completed", stage: "all", selfReported: true }`），确认
`contract.allDone()` 依旧为 `false`，且这条伪造的 record 不会出现在任何 stage 的
`evidence` 里。第二条测试更进一步：伪造成"看起来像证据"的形状（`type: "observation"`、
`metadata.kind` 也对了），但缺关键字段 `hardFindingCount`——依旧判未完成，不会因为
"形状像"就放行。

实跑输出：
```
bun test tests/unit/contract.test.ts -t "阴性对照"

bun test v1.3.14 (0d9b296a)

 2 pass
 19 filtered out
 0 fail
 7 expect() calls
Ran 2 tests across 1 file. [38.00ms]
```

### ② 无进展停机

场景：空图上创建 `literature-review` 契约（三个 stage 全部未完成），`NoProgressGuard`
阈值设为 2，连续两轮都不往图里加任何 record，调用 `evaluateRound()`。

实跑输出（节选自 `tests/unit/contract.test.ts` 里
`"连续两轮无新增 → 第 2 轮停止，stopReason=no_progress，报告未完成的 stage 与缺口"`
这条测试的断言，测试本身通过——以下是断言核对的关键事实）：
- 第 1 轮：`streak=1`，`stopReason===null`（还没到阈值，循环应当继续）
- 第 2 轮：`streak=2`，`stopReason==="no_progress"`，`describeStop()` 的文案里
  同时点名了 `searched`/`read_cards`/`citations_verified` 三个未完成的 stage
  （citations_verified 恰好在第 2 轮之前被判定为 done 会怎样？测试场景里空图上
  它本来就是未完成，此处不涉及）。

```
bun test tests/unit/contract.test.ts -t "连续两轮无新增" --verbose

bun test v1.3.14 (0d9b296a)

 1 pass
 20 filtered out
 0 fail
 9 expect() calls
Ran 1 test across 1 file. [29.00ms]
```

### ③ 把某个 stage 的 `check()` 改成恒 true → 对应测试红（实际执行了 mutate → 跑红 → revert）

把 `read_cards` stage 的 `check()` 顶部插入一行 `return { done: true, evidence: [],
reason: "阴性对照③：故意恒 true" };`（短路掉后面的真实判据，判断表达式本身没删，
只是永远不会被执行到），重新跑 `tests/unit/contract.test.ts`：

```
bun test tests/unit/contract.test.ts

tests/unit/contract.test.ts:
204 |     expect(report.stages.find((st) => st.id === "read_cards")!.done).toBe(false);
                                                                           ^
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) literature-review 契约 > read_cards：没有 paper 时未完成；...

353 |     expect(text).toContain("read_cards");
                       ^
error: expect(received).toContain(expected)
Expected to contain: "read_cards"
Received: "契约 'literature-review' 因连续 2 轮证据图无新增节点而停止 ..."
(fail) evaluateRound / describeStop > 连续两轮无新增 → 第 2 轮停止 ...

379 |     expect(report.incomplete.map((st) => st.id)).toEqual([...]);
    ^
error: expect(received).toEqual(expected)
@@ -2,3 +2,3 @@
    "searched",
-   "read_cards",
    "citations_verified",
(fail) 阴性对照 ① 伪造完成 > 模型自称『已完成』...

 18 pass
 3 fail
```

3 条测试如期变红——证明这些测试不是空壳，真的在验证 `check()` 的判据本身，而不是
恒等式。改回原样后重跑：

```
bun test tests/unit/contract.test.ts

bun test v1.3.14 (0d9b296a)

 21 pass
 0 fail
 73 expect() calls
Ran 21 tests across 1 file. [77.00ms]
```

## 六套件数字

全部在本 lane worktree（`SPARK_E2E_PORT=4422`）实跑，均为最终态（阴性对照③的临时
mutate 已撤回后的重跑结果）：

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（`tsc --noEmit` 两遍，含 frontend/workspace） |
| `bun test tests/unit/` | **1141 pass / 0 fail / 0 skip**（基线 1120 + 本 lane 新增 21） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e` | **13/13** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

没有套件跳过或没能跑成——六项阶段门全部实跑并全绿。

## `ALLOWED_ORPHANS` 登记变化

只新增一条，没有动任何断言逻辑：

```
"backend/src/agents/contract.ts": "**等接线**：v0.4 P13 波次 W2-b 交付的 Research
Contract ... 它的消费方是 W3-a 的 replan 循环 ... W3-a 接上 replan 循环后必须删除本条"
```

## 给 W3-a 的交接说明

### replan 循环怎么消费 `StageStatus` / `ResearchContract` / `NoProgressGuard`

方案 §4.3.2 的观察反馈循环伪代码：

```
round = 0
while round < maxRounds:
    plan         = planner(goal, contract.progress(), lastObservations)
    outcomes     = execute(plan)
    observations = distill(outcomes)
    if contract.allDone(): break
    if noProgress(2 rounds): break("no_progress")
    round += 1
```

本 lane 交付的是这段伪代码里 `contract.allDone()` 与 `noProgress(2 rounds)` 两行
背后的全部机制，`planner`/`execute`/`distill` 三个函数本身、`maxRounds`/预算判据
完全是 W3-a 的活。建议的接线方式：

```ts
import {
  createLiteratureReviewContract,
  RecordStoreEvidenceQuery,
  NoProgressGuard,
  evaluateRound,
  describeStop,
} from "../agents/contract";

const q = new RecordStoreEvidenceQuery(recordStore);
const contract = createLiteratureReviewContract(q);   // baseline 在此刻拍下
const guard = new NoProgressGuard(q.snapshot(), 2);    // 阈值 2，同方案 §4.3

while (round < maxRounds) {
  const plan = await planner(goal, contract.evaluate(q), lastObservations);
  const outcomes = await execute(plan);                 // 子代理 / ToolBus，写证据图
  lastObservations = distill(outcomes);

  const evaluation = evaluateRound(contract, guard, q); // 三条并行停机条件之二
  // evaluation.stopReason 是 "done" | "no_progress" | null
  if (evaluation.stopReason) {
    logHumanReadable(describeStop(contract.id, evaluation));
    break;
  }
  if (budgetExceeded()) {                                // 第三条：budget，调用方自己判
    logHumanReadable(`契约 '${contract.id}' 因预算耗尽停止（stopReason: "budget"）。\n${evaluation.report.summary}`);
    break;
  }
  round += 1;
}
```

`contract.progress()`（伪代码里 planner 的输入之一）建议直接用
`contract.evaluate(q).stages`——每个 stage 的 `done`/`evidence`/`reason` 就是 planner
决定"下一步该干什么"最直接的输入，不需要再包一层。

### 关于 `agent_run` 第 9 类 record 与 `ledger.ts`

方案 §4.3 提到 `agent_run` 是第 9 类 record（帧级记账）、`agents/ledger.ts` 落这套
记账。**本 lane 完全没有碰这部分**——`contract.ts` 不产生、不消费 `agent_run`
record，`EvidenceQuery` 的设计也没有假设它的存在（`newSince`/`listByType` 对任何
`RecordType` 都成立，`agent_run` 加入 `RECORD_TYPES` 之后不需要改 `contract.ts`
一行代码）。这部分连同 replan 循环一起是 W3-a 的职责。

### 关于 `citations_verified` 缺生产者

见上面"已知缺口"一节——`literature/cli.ts` 需要补几行 `records.create()`，不在
本 lane 文件所有权范围内，请转登 BACKLOG 或分给合适的 lane。

## 哪些套件没能在本 lane 跑成

全部实跑并全绿，数字见上表。三次阴性对照全部实跑，输出已完整贴在本文件（③是真实
mutate → 跑红 → revert 的操作记录，不是转述）。诚实补充一点：`citations_verified`
判据在真实的 `lit review` 命令产出上**从未被端到端验证过**（因为生产者不存在），
只验证过判据本身对手工构造的证据图是正确的——这是本 lane 交付时明确的已知缺口，
不是被掩盖的失败。
