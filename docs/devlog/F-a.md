# F-a · 闸门 F lane F-a · 清 v0.1 遗留（F-5 假 ComputeService + F-3 deprecated 别名）

> 分支 `feat/F-a`（worktree `spark-research-Fa`）· 2026-09-10
> 范围：F-5（先做，更重要）删掉 daemon 里活了四个版本的静默假成功路径 `ComputeService`；
> F-3 删 `connectors/base.ts` 里走完废弃周期的三个 deprecated 别名（V15）

---

## 0. 一句话结论

两件都删完了，而且都比任务书给的清单大——F-5 顺手带走了两个同样是假实现、只是任务书
没点名的方法（`query_frames` / `analytic_libraries`），F-3 确认仓库内零引用后直接删，
无需过渡层。`normalizeTask()` 里一个更根本的静默丢弃（未知 kind 的任务在计划阶段就被
过滤掉，不进执行日志）顺手一并修掉——这才是任务书要求「确认 default 分支是显式失败」
时真正该查的地方，光看 `executeTask()` 的 `default` 分支本身其实早就是显式失败，问题在
它上游几乎永远走不到。

六套件：`bun run typecheck` 干净；`bun test tests/unit/` **1396 → 1399 pass**（净 +3，
0 fail，0 skip）；`tests/concurrency/` + `tests/timeout/` 12/12 不变；`test:e2e` 14/14
不变；`test:py` 48/48、`test:lab` 26/26 不变。四条阴性对照全部实跑，全部按预期变红后
复原（见 §4，终端输出原样贴出）。

---

## 1. F-5：假 `ComputeService` 清单（实际比任务书给的大）

grep 完整确认后的清单：

| 文件 | 清掉的东西 |
|---|---|
| `backend/src/daemon/daemon.ts` | `ComputeService` 接口、`DefaultCompute` 类、`DaemonDeps.compute` 字段、`SparkResearchDaemon.compute` 只读字段、构造函数里的 `this.compute = ...` |
| `backend/src/daemon/daemon.ts` | `dispatch()` 里 `"query_frames"` / `"compute_submit"` / `"analytic_libraries"` 三个 case（**后两个任务书原文只点了 `compute_submit`**） |
| `backend/src/daemon/permissions.ts` | `control_repl` permit set 里的 `"query_frames"` / `"compute_submit"`；`python_kernel` / `r_kernel` permit set 里的 `"analytic_libraries"` |
| `backend/src/kernels/control_repl.ts` | REPL 沙箱里暴露的 `queryFrames` / `computeSubmit` 两个函数（对应上面被删掉的 daemon 方法） |
| `backend/src/agents/orchestrator.ts` | `TASK_KINDS` 里的 `"compute"`；`SKILL_CATALOG` 里的 `compute` 技能描述条目；`plan()` 里 `"compute"=submit compute job, ` 说明文字；`executeTask()` 的 `case "compute"` 整块 |
| `backend/src/agents/prompt/core.txt` | 一句系统 prompt：`Prefer the daemon's kernels, connectors, artifact store, and compute service over external side effects.` → 去掉 `and compute service` |

### 1.1 为什么把 `query_frames` / `analytic_libraries` 也带走了

`ComputeService` 接口有三个方法：`submit`（任务书点名的假 job）、`getFrames`、
`libraries`。后两个是同一个 `DefaultCompute` 类里的另外两个假实现——`getFrames()`
永远返回 `{ frames: [], filter: args }`，`libraries()` 永远返回一个硬编码列表
`["numpy","pandas","matplotlib","scipy","rdkit"]`，跟参数完全无关。删 `ComputeService`
接口和 `DefaultCompute` 类本身就必然带走它们（它们是同一个类的方法，不是独立类型）。

grep 确认过调用链：
- `query_frames` 只有 `control_repl.ts` 的 `queryFrames` 沙箱函数一个调用点，没有测试
  覆盖，删除安全。
- `analytic_libraries` 更彻底——它在 `permissions.ts` 里给 `python_kernel` / `r_kernel`
  两个 permit set 都挂了这个权限，但仓库里**没有任何代码**（`python_kernel.py`、
  `kernels/manager.ts` 都查过）会以 `"analytic_libraries"` 为 method 调
  `handleKernelCall()`——它是一条声明了权限、但永远不会被调用的死路径，比
  `compute_submit` 更彻底地是「摆设」。

两者都属于「daemon 上有一个 compute，一部分诚实（会抛错），一部分连诚实都做不到（永远
返回空/硬编码）」——留着任何一部分都违反任务书里那句「一个真的一个撒谎的」不能共存的
原则，所以一并清。

### 1.2 没动的东西（有意保留，写在这里防止收口时被误判为漏项）

- `backend/src/daemon/daemon.ts` 的 `handleDelegateTask()`（`delegate_task` 方法）同样是
  内存里造一个 `{status:"queued"}` 假 task、永远不推进——跟已删的 `DefaultCompute.submit`
  是同一种模式。**没有清它**，因为任务书的范围明确是 "compute"（`ComputeService` /
  `compute_submit` / `TASK_KINDS` 的 `"compute"`），`delegate_task` 是另一个独立的
  daemon 方法，清它不在本 lane 授权范围内，也没有验收标准覆盖它的行为契约（比如
  `orchestrator.ts` 的 `"subagent"` 分支是否依赖它）。**记在这里交给收口判断是否要开一个
  新的 backlog 项**——它符合「静默假成功」的同一类特征，但不属于 F-5 明确圈定的范围。
- `backend/src/agents/toolbus.ts:80` 附近提到 `"computeSeconds"` 的注释：这是 v0.5
  远端算力**将来**要用的计价维度预留口子，跟被清掉的假 `ComputeService` 无关，没动。
- `backend/src/simulation/platform.ts:112` 提到「刻意不复用 v0.1 的
  `compute/providers.ts`」的注释：纯历史记录（那个文件 P8 已经删了），没动。
- `backend/src/agents/sub_agent.ts:24,33` 提到 v0.1 时代 `"compute_submit"` 抽象能力名的
  注释：说的是 `SubAgentConfig.permission` 字段的历史命名决策（P9 已经解决），跟
  `daemon/permissions.ts` 的 `PERMIT_SETS` 是两回事，没动。
- `backend/src/index.ts:257` 的 CLI 启动横幅 `"可用技能: literature, protein, genomics,
  chemistry, compute, lab"` 现在有一处过时（`compute` 技能已删，`lab` 之后其实还有
  `ideation`）——**`index.ts` 是本 lane 文件所有权之外的枢纽文件，没有改**，记在这里
  交给收口。

---

## 2. 未知 task kind 现在怎么处理的（顺手修的部分，比任务书要求的更深）

### 2.1 修之前的真实情况

任务书问的是：「`default` 分支现在怎么处理未知 task kind？确认它是显式失败而不是静默
通过。」——单看 `executeTask()` 的 switch，`default` 分支早就是：

```ts
default: {
  const kind = String(task.kind);
  return { taskId: task.id, kind: task.kind, ok: false, output: `unknown task kind: ${kind}` };
}
```

`ok: false`，看起来已经是显式失败。**但这个分支在修之前几乎永远到不了**——真正的问题在
更上游的 `normalizeTask()`：

```ts
// 修之前
const kind = obj.kind as TaskKind;
if (!TASK_KINDS.includes(kind)) return null;   // ← 未知 kind 在这里直接被吃掉
```

`parsePlan()` 对每个任务调用 `normalizeTask()`，返回 `null` 的任务会被
`.filter((t): t is PlannedTask => t !== null)` 直接从计划里去掉——**不进执行日志、不进
`result.plan`、不进 `result.execution`**。如果 LLM 计划里全部任务的 kind 都不认识（比如
删掉 `compute` 之后 planner prompt 没同步，LLM 还在计划 `"compute"` 任务），
`parsePlan()` 返回空数组会被判定为 `null`，整个计划退化成 `defaultPlan()`（一个泛泛的
`analysis` 任务）——调用方看到的是「计划变了、正常执行完了」，看不出「有一个任务被拒收」
的任何痕迹。这跟被清掉的假 `compute` 是**同一类问题**：LLM 计划出的东西被悄悄变成
「什么都没发生」，只是发生的位置从「执行阶段假成功」挪到了「规划阶段静默丢弃」。

`executeTask()` 的 `default` 分支因此基本是**死代码**——`PlannedTask.kind` 在类型层面被
声明成 `TaskKind`（`TASK_KINDS` 的字面量并集），`normalizeTask()` 是唯一的构造点且已经
把非法值过滤掉，正常路径下 switch 不可能落到 `default`。

### 2.2 修之后

`normalizeTask()` 现在只做「这是不是个像样的任务描述」的形状校验（`kind` 是非空字符串），
不再按 `TASK_KINDS` 白名单过滤：

```ts
const kind = typeof obj.kind === "string" && obj.kind.length > 0 ? obj.kind : null;
if (!kind) return null;
```

`PlannedTask.kind` / `ExecutionOutcome.kind` 的类型相应从 `TaskKind` 放宽成 `string`（
grep 确认 `TaskKind` 类型仅在 `orchestrator.ts` 内部使用，没有第三方消费者依赖它是窄
字面量类型，放宽是安全的原地改动）。「这个 kind 认不认」完全交给 `executeTask()` 的
switch——命中已知 kind 走对应分支，命中不了就落到 `default`，现在这个分支**真的会被
触发**，而且额外补了一条执行日志（之前 `default` 分支只把失败塞进返回值，没有调用
`this.record()`，跟其他分支不一致）：

```ts
default: {
  const kind = String(task.kind);
  this.record(sessionId, "orchestrator", "unknown-kind", `task ${task.id} kind='${kind}' not in TASK_KINDS`);
  return { taskId: task.id, kind: task.kind, ok: false, output: `unknown task kind: ${kind}` };
}
```

结果：未知 kind 的任务现在**留在计划里可见**（`result.plan` 能看到它）、**执行结果显式
`ok:false`**（不是被吃掉、也不是伪装成功）、**执行日志里也有一条**（调用方不读
`execution` 数组细节也能查到）。

---

## 3. planner prompt 与 TASK_KINDS 怎么同源的

`plan()` 方法里给 LLM 的说明文字有两处跟 `TASK_KINDS`相关，语义耦合方式不一样：

1. **白名单那句**——`"kind" MUST be one of: ${TASK_KINDS.join(",")}.`——这句本来就是
   直接拿 `TASK_KINDS` 数组拼出来的，删 `"compute"` 之后自动同步，**这句从代码结构上
   就是同源的，不会漂移**。
2. **逐项说明文字**——`"analysis"=reasoning, "code"=run python (...), "connector"=...,
   "compute"=submit compute job, "subagent"=..., "skill"=...`——这句是**手写的字符串
   拼接**，不是从 `TASK_KINDS` 派生的。删掉 `TASK_KINDS` 里的 `"compute"` **不会**自动
   让这句里的 `"compute"=submit compute job, ` 消失，必须手动删。**这正是 v0.4 里假
   compute 能活四个版本的同一种漂移风险，只是换了个位置**——不是「代码删了、prompt 没
   跟上」，是「TASK_KINDS 删了、逐项说明文字没跟上」。

我手动删了第 2 处的 `"compute"=submit compute job, `（见 `orchestrator.ts` 的
`plan()`），然后把 `TASK_KINDS` 改成 `export`（原来不导出，只导出 `TaskKind` 类型），
在 `tests/unit/orchestrator.test.ts` 新增一条测试，从捕获到的真实 prompt 文本里用正则
分别抠出「白名单列表」和「逐项说明文字提到的 kind 集合」，跟导入的 `TASK_KINDS` 做**双向**
比对：

- 白名单列表：`expect(listedKinds).toEqual([...TASK_KINDS])`——锁定第 1 处的同源性质，
  防止以后有人把 `join(",")` 改成手写列表。
- 逐项说明文字：`describedKinds` 里每个 kind 必须在 `TASK_KINDS` 里（防止「表里删了，
  说明文字忘了删」——compute 当年活下来的方式）；`TASK_KINDS` 里每个 kind 也必须在
  `describedKinds` 里出现（防止反过来「加了新 kind 忘了写用法」）。

这条测试不需要每次改 `TASK_KINDS` 都手动同步测试断言——它读的是导出的 `TASK_KINDS`
本身，不是一份写死在测试里的副本。

---

## 4. 阴性对照（四条，全部实跑，终端输出如下）

全部通过「备份文件 → 临时改回旧行为 → 跑测试确认变红 → 用备份还原 → diff 确认字节级一致
→ 重新跑 typecheck/测试确认恢复干净」的流程；每次恢复后都用 `diff` 核对与备份文件完全
一致，不是凭记忆手改回去。

### ① 恢复 `case "compute"` 与假 `DefaultCompute` → 新增的「未知 task kind 显式失败」测试变红

临时把 `daemon.ts` 的 `ComputeService`/`DefaultCompute`/`compute` 字段和
`orchestrator.ts` 的 `case "compute"` 分支原样加回去（`TASK_KINDS` 不变，仍然不含
`"compute"`——模拟「daemon 侧的假实现又长回来了，但没人把它注册回白名单」这个最容易
发生的半吊子恢复场景）：

```
=== TEST RUN (阴性对照①: 恢复 case compute + DefaultCompute) ===
bun test v1.3.14 (0d9b296a)

tests/unit/orchestrator.test.ts:
558 |
559 |     // 执行结果是显式失败，不是假成功（这正是被清掉的 DefaultCompute 曾经做的事：
560 |     // `case "compute"` 会在这里返回 `ok:true`）。
561 |     const outcome = result.execution.find((e) => e.taskId === "t1");
562 |     expect(outcome).toBeDefined();
563 |     expect(outcome?.ok).toBe(false);
                              ^
error: expect(received).toBe(expected)

Expected: false
Received: true

      at <anonymous> (/Users/jimmyclaw/Desktop/AI4S/spark-research-Fa/tests/unit/orchestrator.test.ts:563:25)
(fail) OrchestratorAgent F-5：未知 task kind 显式失败，planner prompt 与 TASK_KINDS 同源 > 规划出一个已废弃的 'compute' kind：计划里不被静默丢弃，执行结果显式 ok:false，执行日志可见 [1.66ms]

 22 pass
 1 fail
 103 expect() calls
Ran 23 tests across 1 file. [110.00ms]
```

符合预期：`normalizeTask()` 已经放行 `"compute"` 这个 kind（不再按白名单过滤），
`executeTask()` 的 switch 一旦重新出现 `case "compute"`，就会拦截在 `default` 分支
之前，把 `ok:false` 变回 `ok:true`（假成功）——正是测试要守住的那条不变式。

还原：`cp` 备份文件覆盖回去，`diff` 确认与修复后版本字节级一致，`bun run typecheck`
干净，`bun test tests/unit/orchestrator.test.ts` 回到 23 pass / 0 fail。

### ② 让 planner prompt 仍然把 compute 列为可用 kind → 测试红（证明 prompt 与 TASK_KINDS 同源）

临时把 `plan()` 里的逐项说明文字改回带 `"compute"=submit compute job, `，`TASK_KINDS`
**不变**（模拟「有人手写往 prompt 里加回一句，但没有同步改 TASK_KINDS」）：

```
=== TEST RUN (阴性对照②: planner prompt 仍列 compute 为可用 kind，TASK_KINDS 未改) ===
bun test v1.3.14 (0d9b296a)

tests/unit/orchestrator.test.ts:
611 |     // 提到的每个 kind 必须在白名单里（防止"表里删了，说明文字忘了删"，即 compute
612 |     // 当年活下来的方式）；白名单里的每个 kind 也必须有说明文字（防止反过来只加
613 |     // 白名单不写用法）。
614 |     const describedKinds = [...capturedPrompt.matchAll(/"(\w+)"=/g)].map((m) => m[1]!);
615 |     for (const k of describedKinds) {
616 |       expect(TASK_KINDS as readonly string[]).toContain(k);
                                                    ^
error: expect(received).toContain(expected)

Expected to contain: "compute"
Received: [ "analysis", "code", "connector", "subagent", "skill" ]

      at <anonymous> (/Users/jimmyclaw/Desktop/AI4S/spark-research-Fa/tests/unit/orchestrator.test.ts:616:47)
(fail) OrchestratorAgent F-5：未知 task kind 显式失败，planner prompt 与 TASK_KINDS 同源 > planner prompt 的 kind 白名单 + 逐项说明文字与 TASK_KINDS 同源（双向） [0.97ms]

 22 pass
 1 fail
 100 expect() calls
Ran 23 tests across 1 file. [112.00ms]
```

还原：同上流程，`diff` 确认字节级一致，typecheck 干净，测试回到全绿。

### ③/④ F-3：恢复三个 deprecated 别名并在某处引用它 → 「不许再出现 deprecated 别名」断言变红

新增的 `tests/unit/connectors_deprecated_aliases.test.ts` 用 grep 扫描
`backend/src` + `tests` 下所有 `.ts`/`.tsx`，检查两种「别名又活了」的形态：①
`base.ts` 里重新出现 `export const/type MCPConnector` 等声明；② 别处出现
`import { MCP... } from "..."`。刻意不用最粗暴的全文 grep「MCPConnector」这个词
——`base.ts` 保留了一段说明这段命名历史的注释（提到旧名字面文本，是文档不是代码），
全文匹配会被自己的历史说明打红，不是真正想测的东西。

把 `base.ts` 的三个别名原样加回文件末尾，**并且**在 `backend/src/connectors/` 下新建
一个临时文件真的 `import type { MCPConnectorConfig } from "./base"` 引用它（对应任务书
「恢复别名并在某处引用它」的两个条件都满足）：

```
=== TEST RUN (阴性对照③: F-3 恢复别名 + 无引用；④: 恢复别名 + 有引用) ===
bun test v1.3.14 (0d9b296a)

tests/unit/connectors_deprecated_aliases.test.ts:
37 |
38 | describe("F-a / F-3：deprecated 别名（MCPConnector/MCPConnectorConfig/MCPTool）不许再出现", () => {
39 |   test("backend/src 与 tests 里没有任何声明或导入这三个旧别名", () => {
40 |     const declared = grepRepoFor(ALIAS_DECLARATION, ["backend/src", "tests"]);
41 |     const imported = grepRepoFor(ALIAS_IMPORT, ["backend/src", "tests"]);
42 |     expect(declared).toEqual([]);
                          ^
error: expect(received).toEqual(expected)

- []
+ [
+   "/Users/jimmyclaw/Desktop/AI4S/spark-research-Fa/backend/src/connectors/base.ts:179:export const MCPConnector = HttpConnector;",
+   "/Users/jimmyclaw/Desktop/AI4S/spark-research-Fa/backend/src/connectors/base.ts:181:export type MCPConnector = HttpConnector;",
+   "/Users/jimmyclaw/Desktop/AI4S/spark-research-Fa/backend/src/connectors/base.ts:183:export type MCPConnectorConfig = HttpConnectorConfig;",
+   "/Users/jimmyclaw/Desktop/AI4S/spark-research-Fa/backend/src/connectors/base.ts:185:export type MCPTool = HttpTool;",
+ ]

- Expected  - 1
+ Received  + 6

      at <anonymous> (/Users/jimmyclaw/Desktop/AI4S/spark-research-Fa/tests/unit/connectors_deprecated_aliases.test.ts:42:22)
(fail) F-a / F-3：deprecated 别名（MCPConnector/MCPConnectorConfig/MCPTool）不许再出现 > backend/src 与 tests 里没有任何声明或导入这三个旧别名 [82.76ms]

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [100.00ms]
```

（声明检查先于导入检查命中，两个条件——恢复声明、以及新增一个引用它的临时文件——
在这一次跑里同时具备；`declared` 数组本身就足以让断言变红，说明测试对「别名重新
出现」这件事本身是敏感的，不依赖有没有人恰好引用它。）

还原：删掉临时引用文件，`cp` 备份覆盖 `base.ts`，`diff` 确认字节级一致，typecheck
干净，`bun test tests/unit/connectors_deprecated_aliases.test.ts` 回到 1 pass / 0 fail。

---

## 5. F-3：删别名前的引用核查结果

`grep -rn "MCPConnector\|MCPConnectorConfig\|MCPTool\b"` 扫全仓库（含 `.md`）：**仓库内
代码零引用**——`backend/src/connectors/base.ts` 之外没有任何 `.ts`/`.tsx`/`.py` 文件
声明、导入或使用这三个名字（含测试文件、`backend/src/scaffold/templates.ts` 第三方
connector 脚手架模板——模板早就用的是新名 `HttpConnector`/`HttpConnectorConfig`）。

唯一的命中全部在文档/历史记录类文件（`CHANGELOG.md`、`docs/BACKLOG.md`、
`docs/DEVELOPMENT_PLAN_v0.3.md`、`docs/DESIGN.md`、`docs/EXTENDING.md`、
`docs/REVIEW_BRIEF.md`、`docs/devlog/P9-extensibility.md`、`docs/devlog/P10-a.md`、
`docs/devlog/P2-literature.md`、`llms-full.txt`）——这些都是在**记录**这次改名/废弃的
历史决策，不是活引用，而且全部不在本 lane 文件所有权范围内（`CHANGELOG.md` /
`docs/BACKLOG.md` / `README.md` / `docs/DEVELOPMENT_PLAN*.md` 明确排除；其余 devlog/
设计文档也不在「只改这些」清单里），**没有动它们**。

**breaking change 需要进 CHANGELOG**——按文件所有权要求，本 lane 不碰 `CHANGELOG.md`，
这一条留给收口：`connectors/base.ts` 删除了 `MCPConnector`（值+类型）、
`MCPConnectorConfig`、`MCPTool` 三个 deprecated 别名（v0.4 §2.2 废弃周期已走完，
BACKLOG V15），外部若还在用旧名会直接编译失败，需要改用 `HttpConnector` /
`HttpConnectorConfig` / `HttpTool`。

---

## 6. 六套件数字

| 套件 | 修复前基线 | 修复后 |
|---|---|---|
| `bun run typecheck` | 干净 | 干净 |
| `bun test tests/unit/` | 1396 pass / 0 fail / 0 skip | **1399 pass / 0 fail / 0 skip**（净 +3：F-5 两条新测试 + F-3 一条新测试；无既有测试被删除，仅 1 处既有断言因技能被删而调整，见 §7） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail | 12 pass / 0 fail（不变） |
| `bun run test:e2e` | 14/14 | 14/14（不变） |
| `bun run test:py` | 48 passed | 48 passed（不变） |
| `bun run test:lab` | 26 passed | 26 passed（不变） |

---

## 7. 顺带调整的既有测试

`tests/unit/orchestrator.test.ts`「识别请求需要的技能」用例：请求文本原来含「并做计算
分析」用来触发 `compute` 技能关键词匹配，并断言 `result.skills` 包含 `"compute"`。
`SKILL_CATALOG` 里的 `compute` 条目已删，这个关键词现在不会匹配任何技能（`"计算"` 关键词
只有 `compute` 条目在用），去掉了这句断言和触发它的短语，保留 `protein` / `literature`
两个仍然有效的断言。这是**调整**不是**删除**——测试数量不变，只是这一条用例的内容跟着
被删掉的技能一起收窄。

---

## 8. 文件清单

改动：
- `backend/src/daemon/daemon.ts`
- `backend/src/daemon/permissions.ts`
- `backend/src/kernels/control_repl.ts`
- `backend/src/agents/orchestrator.ts`
- `backend/src/agents/prompt/core.txt`
- `backend/src/connectors/base.ts`
- `tests/unit/orchestrator.test.ts`

新增：
- `tests/unit/connectors_deprecated_aliases.test.ts`
- `docs/devlog/F-a.md`（本文件）

## 9. 留给收口的三件事

1. `CHANGELOG.md` 补 F-3 的 breaking change 条目（见 §5）。
2. `backend/src/index.ts:257` 的 CLI 启动横幅仍列着已删的 `compute` 技能（且本来就缺
   `ideation`）——枢纽文件，本 lane 未改，需要收口时顺手修。
3. `backend/src/daemon/daemon.ts` 的 `handleDelegateTask()`（`delegate_task` 方法）
   跟被清掉的假 compute 是同一种「内存造一个 queued 状态、永远不推进」模式（见 §1.2）
   ——不在本 lane 授权范围内，值得收口时判断要不要单独开一个 backlog 项。
