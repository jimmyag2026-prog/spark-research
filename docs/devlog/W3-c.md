# W3-c · 接线专项：让建好的存储层真的被喂数据（v0.4 波次 W3）

> 这条 lane 不交付新功能，交付的是「把已经建好、已经测过、但没人调用的两处存储层接上」，
> 外加一条能防止这类问题再发生的门禁。方案真源：本 lane 的任务书 + `docs/devlog/W1-b.md`
> §7「未接线说明」+ `docs/devlog/W2-b.md`「citations_verified 的已知缺口」。

## 1. 问题的形状

孤儿模块门禁（`tests/unit/narrative_parity.test.ts` 的 `ALLOWED_ORPHANS` 检查）抓的是
「文件有没有被 import」；两个真实缺口都不是这种形状：

1. **W1-b 的 findings 状态机**：`backend/src/reviewer/findings_store.ts` 被
   `reviewer/cli.ts` import，`cli.ts` 被 `index.ts` import——import 链是真的，模块可达。
   但 `ReviewerAgent.review()`（`backend/src/reviewer/agent.ts`）从不调用
   `FindingsStore.reviewTarget()`，表永远是空的，`review findings` / `mark-addressed` 的
   复核闭环无从谈起。
2. **W2-b 的 contract stages**：`citations_verified` 这个 stage 依赖一条
   `metadata.kind === CITATION_INTEGRITY_REVIEW_KIND` 的 observation record（约定写在
   `backend/src/agents/contract.ts`），但 `lit review` 命令
   （`backend/src/literature/cli.ts`）此前只把核验结果打印到 stdout、拿去决定退出码，
   从不落证据图。这个 stage 在生产里因此永远过不了。

共同点：模块可达（甚至代码本身完全正确、测过），但**没有生产写入方**。这是孤儿模块检测
和技能可达性检测都测不出来的第三个维度。

## 2. `ReviewerAgent` → `findings_store`：fingerprint 设计

### 2.1 接口形状：caller 显式配好才生效

`ReviewerAgent` 的构造函数拿到的只有 `(store: ArtifactStore, executionLog, graph,
options)`——不带 project 身份，也不知道自己该往哪个 `findings.db` 写。`agents/orchestrator.ts`
本波次被 W3-a 大改、本 lane 明确不能碰，它现在构造 `ReviewerAgent` 的唯一生产调用点仍然是
`new ReviewerAgent(store, execs, this.graph)`——不带第四个参数。

于是接线做成跟已有的 `CitationCheckConfig` 完全同一套口径：`ReviewerOptions` 新增一个
可选的 `findings?: FindingsWiringConfig`（`{ store: FindingsStore; project: string; session?
}`），**caller 显式配好才生效**，不配置时 `review()` 行为与接线之前逐字节一致（不落库）。
这不是回避接线——`review()` 内部现在无条件地把每一轮实际跑过的检查映射成
`FindingHit[]` 并尝试写库，只是「写库这一步要不要真的落地」由调用方决定要不要给一个
`FindingsStore` 实例。`recordFindings()` 因此是本仓库里 `FindingsStore.reviewTarget()` 唯一
的生产调用点——`tests/unit/reviewer_findings_wiring.test.ts` 的 8 条用例直接构造好
`findings` 配置去驱动它，证明这条路径是真实、被测试覆盖、会被执行的代码，不是摆着不用的
可选参数。

**诚实说明**：`orchestrator.ts` 现在默认构造 `ReviewerAgent` 时仍然不传 `options.findings`，
所以走 `chat()` 循环的真实会话眼下依然不落 findings 表——这条依赖没有消失，只是从「接口
不存在」变成了「接口存在、orchestrator 还没接上」。orchestrator.ts 本波次被 W3-a 独占，
接上这最后一段需要 W3-a 或后续收口 lane 补一个 `findings: { store: <project 的
FindingsStore>, project: <slug> }`。下面新增的门禁断言核实的是「`agent.ts` 有没有真实调用
`reviewTarget()`」（这本身已经是此前完全不存在的东西），不覆盖「orchestrator 有没有把它
接进默认构造路径」——这是两件事，见 §4 门禁设计里的说明。

### 2.2 「跑了没有」vs「命中了没有」

`review()` 对每个 artifact 跑三个检查：traceability、lineage、citation-integrity。前两个
无条件跑；citation-integrity 只在 `options.citations` 配置了、且 artifact 是
`text/markdown` 时才跑（`checkCitations` 的既有逻辑，本 lane 未改）。

`reviewTarget()` 的语义是「这一轮针对 `(checker, target)` **重新查了一遍**，`hits` 是这一轮
的完整命中列表」——传 `hits: []` 会把上一轮报过的所有 finding 判定为 resolved。如果拿
「跳过检查」（没配置 citations、或不是 markdown）也当成「查了、零命中」去调用
`reviewTarget()`，会把从未真正复核过的历史 citation finding 误判成已解决——这是接线时
最容易踩的一个坑，`checkCitations` 因此被改成返回 `{ ran: boolean; findings: Finding[] }`，
`review()` 只在 `ran === true` 时才把这个 `(checker, target)` 记进 `attempts` 列表参与
`recordFindings()`。`tests/unit/reviewer_findings_wiring.test.ts` 里
「citation-integrity 检查被跳过时，不会把历史 finding 误判成 resolved」与「检查真的跑了、
零命中才会 resolved」这两条用例直接对着这个区分写的。

### 2.3 fingerprint：identity 要排除 LLM 的措辞，但不能排除结构

`Finding` 类型（`rules.ts`，本 lane 只读）没有 fingerprint 字段——W1-b 的 devlog 早就点明
这是接线时要设计的一部分。设计目标：识别「同一个问题跨轮复现」，但不能因为无关的措辞
变化就认成新问题。

**唯一真正会有「无关措辞变化」的地方是 citation-integrity 的 LLM judge**：
`citation_conflict` 这类 finding 的 `detail.reason` / `message` 都嵌了 judge 给的自然语言
理由，同一个冲突换一轮跑，judge 的措辞几乎不可能字字相同；`judge_unavailable` 的
`detail` 还带着 `judgeErrors`/`judgedCount` 计数，这两个数字会因为「这一轮哪几条引用抢到
判定窗口」而抖动，不代表问题本身变了。这两类如果直接拿 `message` 整段做 fingerprint，
每一轮都会被判成「新问题」，去重与复核闭环全部失效——这正是阴性对照③要验证的那件事
（见 §5）。

其余两类 citation finding（`unknown_citation` / `unsupported_claim`）和
traceability/lineage 两个检查器完全没有 LLM 参与，`message` 是纯程序拼接、结构化 `detail`
里也没有自由文本，直接用 `message` 做身份是安全的。

于是分两条路径（`agent.ts` 的 `citationFindingIdentity()` / `computeFingerprint()`）：

- **citation-integrity**：按 `detail` 的字段组合识别 finding 的「kind」（不解析 `message`
  文案，因为 `message` 本身就嵌了要排除的 `reason`），身份取「结构化、不随 judge 措辞变化」
  的那部分字段：
  - `unknown_citation` → 身份 = `key`（同一个库外 key 不管在文中出现几次、句子怎么改写，
    都是同一个「这个 key 不在库里」的问题；不含 `sentenceIndex`，避免文档其他地方的无关
    编辑顶动序号导致误判成新问题）
  - `citation_conflict` → 身份 = `key + 陈述所在的句子`（**显式排除 `detail.reason`**）
  - `unsupported_claim` → 身份 = `句子原文`（不含 `sentenceIndex`，理由同上）
  - `judge_unavailable` → 身份 = 固定字面量（**显式排除 `judgeErrors`/`judgedCount`**——
    「判定器这轮挂了」本身才是要跟踪的问题，挂了几条是随机的）
  - 未识别的 detail 形状（保底）→ 退到 `message` 冒号前的 kind 标签，不用整条 message
- **其余 checker**（traceability / lineage）：`message` 全文本身就是确定性程序输出，
  直接用作身份，没有 LLM 参与，不存在这个问题。

最终 fingerprint 是 `sha256(checker + " " + identity)` 取前 16 位十六进制。

## 3. `lit review` → citation-integrity observation record

落库点选在 `backend/src/literature/cli.ts` 的 `case "review"` 分支（W2-b 的 devlog 明确
建议了这个位置：`check.findings` 算出来之后，`draft.recordId` / `hard` / `soft` 都已经在
作用域里，不需要挪动任何既有逻辑）。

metadata 直接内联在 `records.create({...})` 调用里，**没有拆一个中间变量**：

```ts
const citationReviewRecord = records.create({
  type: "observation",
  title: `citation-integrity 核验：${draft.recordId ?? draft.artifactId ?? "草稿未入库"}`,
  content: `解析引用 ${check.citations.length} 处，判定 ${check.judgedCount} 处，` +
    `${hard.length} 条 hard finding，${soft.length} 条 soft finding`,
  evidence: "computed",
  origin: { kind: "session", sessionId: flagString(flags.session) ?? null, ref: draft.artifactId ?? null },
  metadata: ({
    kind: CITATION_INTEGRITY_REVIEW_KIND,
    checker: CITATION_RULE,
    targetRecordId: draft.recordId ?? "",
    hardFindingCount: hard.length,
    softFindingCount: soft.length,
  } satisfies CitationIntegrityReviewMetadata) as unknown as Record<string, unknown>,
});
```

不拆中间变量不只是风格选择：§4 的门禁核实的是「`.create({ ... kind:
CITATION_INTEGRITY_REVIEW_KIND ... })` 是不是同一次调用」，拆成 `const meta = {...}` 再传
`metadata: meta` 会让这条核实变得没法只靠源码结构判断（正则分不清「变量造出来了」和
「变量真的被传给了 create()」，除非做变量流追踪）——直接内联让「构造」与「落库」在源码里
是同一个不可分割的表达式，本 lane 在阴性对照②的第一次尝试里实测过拆开会让判据失效
（见 §5）。

`metadata` 字段先用 `satisfies CitationIntegrityReviewMetadata` 过一遍结构校验（少个字段/
类型错了在这里编译不过），再 `as unknown as Record<string, unknown>` 降级成
`RecordInput.metadata` 要的宽类型——不丢字段也不绕开类型检查。

`records.create()` 是 append-only 调用，每次 `lit review` 都新增一条 record，不覆盖旧的——
`citations_verified` 的判据本身就是「取最近一次」（按 `createdAt` 排序取最后一条），
append-only 是这条判据成立的前提，`tests/unit/lit_review_record.test.ts` 里专门有一条
「同一个项目跑两次」的用例验证这一点。

## 4. 新门禁：存储层必须有生产写入方

加在 `tests/unit/narrative_parity.test.ts` 里，跟孤儿模块检测、技能可达性同一个
`describe` 块下的第 8 条断言，同一套纪律：**显式登记表 + 去真实结构化数据源对账 + 对称
「登记错了/接线被拆了必须报红」检查**（不是「多余登记必须删除」——这条门禁的两张登记表
不是靠扫描全仓库产生的，见下面「为什么不做成全量扫描」）。

### 4.1 两张登记表

- **`STORE_WRITE_BINDINGS`**：「存储层文件的写方法 → 生产调用方文件」。目前一条：
  `findings_store.ts` 的 `reviewTarget` → `reviewer/agent.ts`。
- **`CONTRACT_RECORD_PRODUCERS`**：目标不是「调用某个类的写方法」，而是「某个约定记录
  形状（`metadata.kind` 常量）有没有被真的构造出来」——`citations_verified` 依赖的不是
  某个 store 类的方法（`RecordStore.create()` 到处都在用，不是新建的存储层，早就有无数
  真实写入方，不适合套第一张表的模板），而是「有没有人真的拿这个 kind 常量去创建一条
  record」。目前一条：`agents/contract.ts` 的 `CITATION_INTEGRITY_REVIEW_KIND` →
  `literature/cli.ts`。

### 4.2 核实三步（不靠脆弱正则）

每条登记核实三件事，缺一不可：

1. **存储层/来源文件真的定义了这个符号**——`findings_store.ts` 里真的有 `reviewTarget(`
   方法定义、`contract.ts` 里真的有 `export const CITATION_INTEGRITY_REVIEW_KIND`——防
   登记表本身把名字拼错也能白过。
2. **写入方真的 import 了它**——复用孤儿模块检测同一套「解析 import 语句里的相对路径、
   normalize 后按文件系统真实对账」的办法（`namedRelativeImports()`），不是猜文件名
   像不像，也不是搜整个仓库有没有出现过这个字符串。
3. **写入方源码里真的出现调用/构造语法**——`STORE_WRITE_BINDINGS` 要求出现
   `.reviewTarget(`；`CONTRACT_RECORD_PRODUCERS` 要求 `.create(` 与 `kind: <常量>` 落在
   同一段字符窗口内（同一次调用表达式），不是「整篇文本搜有没有出现过这两个 token」。

这三步跟 `SKILL_ENTRYPOINTS` 用 switch-case 字面量提取、`MCP_TOOLS` 用结构化数组核实是
同一个等级的确定性——都是对真实语法结构做规则化提取，不是对自然语言 triggers/文案做
模糊匹配。

### 4.3 为什么不做成「扫描全部 `*Store` 类」

本仓库已有的 `RecordStore` / `ArtifactStore` / `LibraryStore` / `CredentialStore` 等等都是
早就有大量真实调用方的通用存储层，强行要求它们也逐一登记「谁写了它」只是把孤儿模块检测
重新发明一遍（那些类不孤儿，import 链本来就是真的）。这条新断言要抓的是更窄、更具体的
一类问题：**新建的、专门为某个特定状态机/契约服务的存储层，写方从设计到交付之间有没有
真的接上**，不是「这张表有没有人碰过」。全量扫描/自动发现留给后续（可参考 R-d-1 的思路：
把登记表搬进模块自己的元数据里，而不是维护在测试文件里）——本 lane 只登记这两条本 lane
亲手接上的线，按需增长。

### 4.4 门禁本身踩过的两个坑（都在阴性对照里实测到）

写这条门禁的过程本身两次被自己的判据骗过，都记在这里，避免以后重犯：

1. **弱化版的 `kind:` 检查只搜整篇文件，不管它是不是真的在 `.create()` 调用里**——
   把 metadata 拆成一个不会被使用的中间变量，正则仍然能在文件里找到 `kind: 常量名`
   这几个字符，判据误判为「接了线」。改成要求 `.create(` 与 `kind:` 落在同一段窗口内
   才修复（§4.2 第③步）。
2. **两趟独立的全局正则（先删 `/* */`，再删 `//`）分不清注释嵌套**——本文件自己写文档
   解释判据设计时，在一段 `//` 注释里提到了 `backend/src/agents/contract.ts` 的一处
   `literature/**`（口语化的「literature 目录下所有文件」，不是代码，是描述文件所有权范围
   的英文目录 glob 写法）。先跑的 block-comment 正则把这段 `//` 注释文本里的 `/**` 认成
   一个真正的块注释起点，一路找到几行之后另一个真正 JSDoc 注释的 `*/` 才收手，把中间的
   `export const CITATION_INTEGRITY_REVIEW_KIND = ...` 一并吃掉——导致 `verifyContractRecordProducer()`
   在**正确接线的真实代码**上误报「`contract.ts` 里核实不到这个常量」。改成单趟从左到右
   扫描（谁先出现在文本里、`//` 还是 `/*`，就按谁处理），`//` 注释内部出现的 `/*` 永远
   不会被单独解释，因为扫描在遇到 `//` 的那一刻就已经跳过了整行。`stripComments()` 的
   注释里记录了这两次教训。

## 5. 三次阴性对照（强制项，全部实跑）

流程统一：用 `Edit` 工具临时改代码 → 跑对应测试记录红 → 用 `Edit` 还原 → 重跑确认恢复绿 →
`git status --short` 确认工作区只剩预期改动。

### ① 拆掉 `ReviewerAgent` 的 findings 写入 → 新门禁断言变红

把 `agent.ts` 里 `recordFindings()` 内的

```ts
wiring.store.reviewTarget({ project: wiring.project, session: wiring.session ?? sessionId, target: attempt.target, checker: attempt.checker, hits });
```

替换成 `void hits;`（不调用），重跑 `tests/unit/narrative_parity.test.ts`：

```
error: 以下登记的存储层写入方核实不通过（要么真的没接线，要么登记表本身写错了）：
  写入方 backend/src/reviewer/agent.ts 源码里核实不到对 '.reviewTarget(' 的调用语法

(fail) 叙事一致性门禁（AD-12） > 存储层的写方法 / 约定记录的 metadata.kind 必须有可核实的生产写入方

 8 pass
 1 fail
 212 expect() calls
```

证明门禁真能抓到这类问题——不是摆设。还原后重跑 `narrative_parity.test.ts` +
`reviewer_findings_wiring.test.ts`：`17 pass / 0 fail / 240 expect() calls`。

### ② 拆掉 `lit review` 的 record 落库 → `citations_verified` 相关测试红

第一次尝试（暴露了 §4.4 第①个坑）：只删掉 `records.create({...})` 这次调用，保留上方
构造 `citationReviewMetadata` 中间变量的代码——`tests/unit/lit_review_record.test.ts`
如期两条用例全红（`err`/`code`/`observations.length` 全部对不上），但
`narrative_parity.test.ts` 的新门禁**没有**变红——因为弱化版判据只搜「文件里有没有
`kind: 常量名` 这几个字符」，中间变量虽然没被使用，字符串仍然物理存在。据此把判据加严成
「`.create(` 与 `kind:` 必须落在同一段窗口内」（§4.4 第①点），并把生产代码改成不留中间
变量、直接内联（§3）。

第二次（整段拆掉，包括 metadata 构造）：

```
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) `lit review` → citation-integrity observation record（W3-c） > 命令跑完之后证据图里有一条 ... [out 不含 "citation-integrity record:"]

error: expect(received).toHaveLength(expected)
Expected length: 2
Received length: 0
(fail) `lit review` → citation-integrity observation record（W3-c） > 同一个项目跑两次 ...

 9 pass
 2 fail
 223 expect() calls
```

同时 `narrative_parity.test.ts` 的门禁（补丁修好之后）：

```
error: 写入方 backend/src/literature/cli.ts 源码里核实不到 '.create({ ... kind: CITATION_INTEGRITY_REVIEW_KIND ... })'——同一次调用里构造并落库这条 record 的语法

 8 pass
 1 fail
```

两条门禁都如期变红。还原后重跑 `narrative_parity.test.ts` + `lit_review_record.test.ts` +
`review_e2e.test.ts` + `literature/`：`97 pass / 0 fail / 677 expect() calls`。

### ③ fingerprint 设计缺陷：同一问题跨轮复现被认成两条（去重失效）

把 `citationFindingIdentity()` 里 `citation_conflict` 分支的身份改成包含
`detail.reason`（judge 的自然语言理由），重跑
`tests/unit/reviewer_findings_wiring.test.ts`：

```
error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 2
(fail) ReviewerAgent → findings_store 接线 > fingerprint 不受 judge 措辞变化影响：同一个 citation_conflict 跑两轮仍是同一条 finding [5.39ms]

 7 pass
 1 fail
 24 expect() calls
```

用的是一个每次调用都返回不同 `reason` 文案、但 verdict 恒为 `conflict` 的
`VaryingReasonJudge`——同一个冲突（同一个 `key` + 同一句陈述）跑两轮，第一轮的 `reason`
是「理由措辞第 1 版」，第二轮是「理由措辞第 2 版」，fingerprint 一旦把 `reason` 纳入身份，
两轮就被判成两个不同的 finding（`Received length: 2`），去重与复核闭环双双失效——精确
命中设计文档里点名要防的那个问题。还原后重跑：`8 pass / 0 fail / 27 expect() calls`。

三次阴性对照结束后 `git status --short` 只剩预期改动：
`backend/src/literature/cli.ts`（M）、`backend/src/reviewer/agent.ts`（M）、
`tests/unit/narrative_parity.test.ts`（M）、`tests/unit/lit_review_record.test.ts`（新增）、
`tests/unit/reviewer_findings_wiring.test.ts`（新增）——没有在工作区留下阴性对照的痕迹。

## 6. 六套件数字

全部在本 lane worktree（`SPARK_E2E_PORT=4433`）实跑，均为最终态（三次阴性对照的临时改动
已全部撤回后的重跑结果）：

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（`tsc --noEmit` 两遍，含 frontend/workspace） |
| `bun test tests/unit/` | **1229 pass / 0 fail / 0 skip**（基线 1218 + 本 lane 新增 11：`reviewer_findings_wiring.test.ts` 8 条 + `lit_review_record.test.ts` 2 条 + `narrative_parity.test.ts` 新增 1 条） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail（7 文件，未新增用例，跑它们只为确认零回归） |
| `bun run test:e2e`（`SPARK_E2E_PORT=4433`） | **14/14 passed** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

六套全绿，没有跳过、没有未跑成的套件。

## 7. 未完成 / 诚实说明

- **`orchestrator.ts` 默认构造路径仍未传 `options.findings`**：见 §2.1 的诚实说明——本波
  `orchestrator.ts` 被 W3-a 独占、本 lane 严禁触碰，接口已经按「caller 显式配好才生效」
  的口径设计好了（`ReviewerAgent` 侧的活全部做完，`reviewer_findings_wiring.test.ts`
  证明这条路径真实可用），但走 `chat()` 循环的真实会话默认仍然不落 findings 表。这不是
  遗漏——是文件所有权边界决定的，需要 W3-a 或后续收口 lane 在构造 `ReviewerAgent` 时补上
  `findings: { store: project 对应的 FindingsStore, project: slug }` 这一段。
- **`agents/contract.ts` 的 `ContractStage.check()` / `evaluateRound()` / `literature-review`
  契约本体依然没有生产调用方**——本 lane 让 `contract.ts` 不再是「零 import 的孤儿模块」
  （`literature/cli.ts` 现在真的 import 它的 `CITATION_INTEGRITY_REVIEW_KIND`），但这只
  解决了孤儿模块检测那个维度；把 `evaluateRound()` 真正接进 replan 循环、让契约的完成
  判定在生产里跑起来，仍然是 W3-a 的分内活，`tests/unit/narrative_parity.test.ts` 里
  `ALLOWED_ORPHANS` 表上方的注释已经写清楚这条边界（见该文件改动）。
- **新门禁目前只登记本 lane 亲手接上的两条线**——不是全仓库自动扫描，`STORE_WRITE_BINDINGS`
  / `CONTRACT_RECORD_PRODUCERS` 都需要后续 lane 建新存储层/新约定记录时手工补登记（§4.3
  已说明为什么不做成全量扫描）。
- 除上述三点外，本 lane 任务书列出的三项工作（`ReviewerAgent` 接线、`lit review` 接线、
  新增门禁）均已完成并通过全部阶段门，没有其他已知缺口。
