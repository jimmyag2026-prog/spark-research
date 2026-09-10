# W1-b · findings 状态机（P13 C-b，v0.4 第二波 lane）

> 方案真源：`DEVELOPMENT_PLAN_v0.4.md` §4.3（P13）+ `DEVELOPMENT_PLAN_v0.3.md` §4.3.4（findings 状态机原始设计）。
> 与同一波的 W1-a（contract + replan + ledger）**零文件重叠**，完全独立完成。

## 1. 补的是什么

外部评审对比 Claude Science：Claude 的 REVIEWER 是常驻后台 + findings 状态机 +
`mark_addressed` 复核闭环；spark 现有的 `ReviewerAgent.review()`（`backend/src/reviewer/agent.ts`，
本 lane 只读参考、未改动）是**一次性 pass**——每次调用从头生成一批 `Finding[]`，不落库，
无法回答「这条上次报过吗」「标了已处理之后是不是真的好了」。soft finding 也没有一个
「主动查」的入口（Claude 的 `host.findings()` 等价物）。

本 lane 交付：`backend/src/reviewer/findings_store.ts`（新）+ `backend/src/reviewer/cli.ts`（新）+
`index.ts` 一个 case 分支 + 两份测试 + 本文档。**没有**接 `ReviewerAgent.review()` 的产出到这张表
——那属于「谁在调用 reviewTarget()」的接线工作，方案把它列在别的阶段（P13 描述的是「状态机」
本身，接线是消费方的事，接线时机会撞 agent.ts/rules.ts 的所有权，本 lane 明确不碰这两个文件）。
这一点在下面「未接线」一节展开。

## 2. 表结构与状态机

独立 SQLite 库 `<project.paths.root>/findings.db`，与 `records.db` 是同一目录下的兄弟文件、
**不共用表也不共用连接**——方案原话「findings 状态机（C-b）与 contract/replan（C-a）全程并行，
零文件重叠」，独立建库是这条原则最直接的落实。`ProjectPaths` 类型不在本 lane 文件所有权内，
没有新增字段，路径直接由 `cli.ts` 的 `findingsDbPath(project)` 拼出来。

```sql
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  session TEXT,
  target_kind TEXT NOT NULL,   -- 'record' | 'artifact'
  target_id TEXT NOT NULL,
  checker TEXT NOT NULL,
  severity TEXT NOT NULL,      -- 'hard' | 'soft'
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,         -- 'open' | 'addressed' | 'resolved' | 'reflagged'
  evidence TEXT,
  note TEXT,
  reflag_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_by TEXT
);
CREATE UNIQUE INDEX idx_findings_dedupe ON findings (checker, target_kind, target_id, fingerprint);
```

`target` 在 TS 类型里是 `{ kind: "record" | "artifact", id }`，落库拆成 `target_kind` + `target_id`
两列——任务书写的「target(record_id|artifact_id)」是「这个字段存的是 record 的 id 或 artifact
的 id」，不是要求裸字符串；record 和 artifact 各自的 id 唯一性互不保证，拆成两列可以避免
「同一个字符串撞在不同种类的两个目标上」这种边角情况被去重键误判成同一条。

状态机四态：

- `open`——刚报出来，没人处理过
- `addressed`——人工 `mark-addressed`，等下一轮复核
- `resolved`——复核时检查器不再命中（不论是从 `open` 直接消失，还是从 `addressed` 复核通过）
- `reflagged`——曾经 `addressed` 或 `resolved`，复核又命中了——「以为处理好了，其实没有」

转移只有两个入口：

1. `reviewTarget({project, session?, target, checker, hits})`——一次「针对某个 (checker,
   target) 重新跑一遍检查」的完整结果。语义：
   - `hits` 里每个 fingerprint 按 `(checker, target, fingerprint)` upsert；`open`/`reflagged`
     续命中只刷新 `evidence`/`last_seen_at`，**不算 reflag**（reflag 记的是「以为好了结果没有」，
     不是「一直都没处理」）；`addressed`/`resolved` 被再次命中 → 转 `reflagged` 且
     `reflag_count += 1`；已经是 `reflagged` 的再命中不重复计数（这一条测试里专门验证过：
     同一 fingerprint 连续三轮命中，`reflagCount` 停在 1，不是 2）。
   - 上一轮还是 `open`/`addressed`/`reflagged`、这一轮 `hits` 里已经不存在的 fingerprint
     → `resolved`。
2. `markAddressed(id, {note, actor})`——只能从 `open`/`reflagged` 转到 `addressed`，
   `UPDATE ... WHERE id=? AND state IN ('open','reflagged')`，`changes=0` 时读回真实状态抛
   `FindingsStoreError`。

`reviewTarget` 把「去重 upsert」与「复核闭环」绑在同一次调用，因为二者共享同一份
「这一轮到底检查了哪些 fingerprint」的上下文——拆成两个方法要么让调用方传两遍这份上下文
（容易传漏一半），要么 store 自己猜「这轮查了哪些」（猜不出来）。

## 3. 并发写入口径

`records.ts` 的 `rev`/CAS 是给**通用 patch**用的：调用方决定 title/content 怎么改，store 不知道
「对」的合并结果是什么，只能靠 `expectedRev` 保证「没人在我读之后、写之前抢先改过」。

findings 状态机不是通用 patch——状态转移是一张**封闭、确定性**的规则表（见上面四态的定义），
store 自己就知道「命中一次该怎么转」。所以这里的选择是把整条转移规则写成**单条原子 SQL 语句**：

```sql
INSERT INTO findings (...) VALUES (...)
ON CONFLICT(checker, target_kind, target_id, fingerprint) DO UPDATE SET
  state = CASE WHEN findings.state IN ('addressed','resolved') THEN 'reflagged' ELSE findings.state END,
  reflag_count = CASE WHEN findings.state IN ('addressed','resolved') THEN findings.reflag_count + 1 ELSE findings.reflag_count END,
  ...
```

而不是「先 `SELECT` 读状态、应用层判断、再 `UPDATE`」。后者才需要 rev/CAS 来防「读写之间被
别人抢跑」；前者从设计上不存在这个窗口——SQLite 对单条语句的执行本身是原子的，多个连接
并发对同一行触发 upsert，谁先谁后由 SQLite 的写锁天然序列化，每一条语句执行时读到的都是
「当前」状态，不会出现一个写入把另一个写入的判断依据覆盖掉的中间态。

`markAddressed` 同理：`UPDATE ... WHERE id=? AND state IN (...)` 本身就是状态守卫——两个并发
的 `markAddressed` 只有一个能匹配到 `WHERE`，另一个 `changes=0`，读回真实状态后抛出明确错误，
不会静默覆盖 note。这是跟 rev 数字版本号等价的守卫机制，只是守卫条件是「状态」本身。

`reviewTarget` 一次调用里的「N 条 upsert + 1 条 resolve」额外包了一层 `db.transaction()`：
要么这一轮完整生效，要么完全不生效，不会出现「upsert 了一半、resolve 用的是另一轮 hits
列表」的半成品状态。连接层面加了 `journal_mode=WAL` + `busy_timeout=5000`（`records.ts` /
`artifacts/store.ts` 只设了 WAL，没设 busy_timeout——这里的 upsert 更可能撞并发写，两个进程
同时对同一个 target 跑复核是可预见的场景，所以多加了这一条）。

**没有照搬 `rev`/`integrityHash`**：这张表不需要一个独立的乐观并发计数器，因为它的每一次写入
本身就是可重入、幂等意义下确定的单条 SQL（同样的 hits 重复 upsert 多次，落库结果与只 upsert
一次完全一样）——引入 rev 只会多一层调用方不需要携带的负担，不会增加任何安全性。

## 4. CLI 命令形态

```
spark-research review findings [--open] [--checker <id>] [--json]
spark-research review mark-addressed <id> [--note "..."] [--actor 谁] [--json]
```

风格照抄 `conclusion/cli.ts`（`parseArgs`/`flagString`/`resolveActor` 三个小工具函数是同一套
写法的直接复用，没有拆共享文件——两处体量都小，抽出来意义不大，且会跨到不属于本 lane 的
文件）。`--open` 就是任务书要求的「soft finding 主动查入口」，口径是 `state IN ('open',
'reflagged')`——「仍需要人关注」，addressed/resolved 不算。`review` 不是任何 `skills/*/SKILL.md`
的入口（不是文献/思路/实验/湿实验这类领域技能，是横切的运维/审查命令），所以
`tests/unit/narrative_parity.test.ts` 的 `SKILL_ENTRYPOINTS` 登记表没有改动——确认过
`backend/src/skills/` 目录下没有 reviewer/findings 相关技能，不属于"该登记却漏登"的情形。
同理没有动 `ALLOWED_ORPHANS`：`findings_store.ts` 被 `cli.ts` 引用，`cli.ts` 被 `index.ts`
引用，走的是真实生产 import 链，不是孤儿模块。

## 5. 两次阴性对照（实跑）

流程：临时 patch `findings_store.ts` → 跑 `bun test tests/unit/findings_store.test.ts` 记录红 →
用 `/tmp` 备份还原 → 重跑确认恢复 14/14 绿 → `git status --short` 确认工作区只剩预期的新增/改动文件。

### ① 去掉去重逻辑（同一问题重复报变成多条）

去掉唯一索引 `idx_findings_dedupe`，把 upsert 语句从 `INSERT ... ON CONFLICT DO UPDATE`
换成裸 `INSERT`（不带 `ON CONFLICT`，每次都插入新行）。

```
error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 2
(fail) FindingsStore · 去重 upsert > 同一个 (checker, target, fingerprint) 报两次不会变成两条 [7.11ms]
...
error: expect(received).toBe(expected)
Expected: "reflagged"
Received: "resolved"
(fail) FindingsStore · 复核闭环 > resolved 之后又命中 → 也会 reflag（不是只有 addressed 才会复发） [4.39ms]
...
error: expect(received).toEqual(expected)
@@ -2,3 +2,3 @@
   "open",
-  "reflagged",
+  "open",
(fail) FindingsStore · list 过滤 > --open 口径只包含 open / reflagged [4.40ms]

 10 pass
 4 fail
 26 expect() calls
```

4 个用例红（去重本身、mark-addressed 复发、resolved 后复发、list --open 口径），符合预期
——去重是好几条断言共同依赖的底层不变式，坏了会连带炸穿复核闭环的测试（同一 fingerprint
变成两行之后，`state`/`reflagCount` 的转移逻辑作用在了错误的那一行上）。

### ② mark-addressed 之后问题仍在，下一轮不 reflag

把 `CASE` 转移表达式的 `'addressed'` 分支去掉，只留 `'resolved'` 会转 `reflagged`——模拟
「addressed 之后复核命中，但状态原地不动」这个 bug。

```
error: expect(received).toBe(expected)
Expected: "reflagged"
Received: "addressed"
(fail) FindingsStore · 复核闭环 > mark-addressed 之后仍命中 → reflagged 且 reflagCount 递增 [2.19ms]
...
error: expect(received).toEqual(expected)
@@ -2,3 +2,3 @@
   "open",
-  "reflagged",
(fail) FindingsStore · list 过滤 > --open 口径只包含 open / reflagged [2.75ms]

 12 pass
 2 fail
 31 expect() calls
```

2 个用例红，精确命中「mark-addressed 复核闭环」这条核心断言（另一个是 `--open` 口径的
连带断言，因为那个测试场景里包含了一条依赖 reflag 转移的 finding）。

还原后重跑：`14 pass / 0 fail / 35 expect() calls`。`git status --short` 确认改动只剩
`backend/src/index.ts`（M）+ `backend/src/reviewer/cli.ts` / `findings_store.ts` /
`tests/unit/findings_store.test.ts`（新增）——两次阴性对照没有在工作区留下痕迹。

## 6. 六套件数字

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（含前端 tsconfig） |
| `bun test tests/unit/` | **1032 pass / 0 fail / 0 skip**（基线 1018 + 本 lane 新增 14） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail（7 文件，未新增用例——本 lane 没有触碰这两个目录，跑它们只为确认零回归） |
| `bun run test:e2e`（`SPARK_E2E_PORT=4412`） | **13/13 passed** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

六套全绿，没有跳过、没有未跑成的套件。

## 7. 未接线（诚实说明，不是缺口，是方案边界）

`ReviewerAgent.review()`（`agent.ts`）目前的调用方（`OrchestratorAgent.chat()` 一类）没有改成
把 `ReviewResult.findings` 灌进 `FindingsStore.reviewTarget()`——`agent.ts` / `rules.ts` 不在本
lane 文件所有权内，任务书也明确写着「只读参考，改它们会撞其他 lane」。这张状态机表现在是一个
**完整、独立、可测的存储层 + CLI**，但还没有一条生产路径在实际调用 `reviewTarget()`——
这是刻意的边界，不是遗漏。等接线的那一刻，消费方只需要把 `Finding[]` 映射成
`FindingHit[]`（`severity`/`fingerprint`/`evidence`）、按 `(checker, target)` 分组调用一次
`reviewTarget()` 即可，接口已经是按这个使用方式设计的。

`fingerprint` 目前由检查器/调用方自己决定怎么算（例如 `${rule}:${artifactId}:${message}` 的
哈希）——`rules.ts` 的 `Finding` 类型本身没有现成的 fingerprint 字段，这也是接线时需要一并
设计的一部分，本 lane 没有越界去改 `Finding` 类型。
