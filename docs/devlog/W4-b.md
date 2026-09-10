# W4-b · 文献域补强 + 两处从未验过的验证

> lane W4-b，波次 W4。方案真源 `docs/DEVELOPMENT_PLAN_v0.3.md` §四「E-1…E-6」
> （本 lane 做 E-2…E-6，E-1 manifest 源归 W4-a），外加评审要求的两处「写下来之后
> 从未跑过」的验证（真实网络录制 `tests/integration/`、v0.2.x 老 `records.db`
> 迁移演练）。
> 文件所有权：`backend/src/literature/{dedupe,export,search,reading,review}.ts`、
> `backend/src/reviewer/citation_judge.ts`、`backend/src/connectors/literature.ts`、
> `tests/unit/{literature*,dedupe*,citation*}.test.ts`、`tests/integration/**`、本文件。

## 0. 两处验证的结论先说（评审说这条最重要）

### 0.1 真实网络录制 `tests/integration/`：发现了什么漂移

8 个用例（`literature_record.test.ts` 4 个、`novelty_record.test.ts` 2 个、
`protein_record.test.ts` 2 个）**本轮之前从未跑过**——默认 `describe.skipIf(!RECORDING)`
跳过，CI 只跑回放版。用 `FIXTURE_MODE=record` 对着真实上游重新录了一遍：

- **8/8 全部成功**，无一失败。OpenAlex / CrossRef / Europe PMC / arXiv / UniProt /
  PDB / AlphaFold DB 六个免 key 源的接口形状**没有漂移**——旧 fixture 与新录制的
  归一化结果字段结构一致，`normalizeResponse` 不用改。
- **AMiner 有真实凭据在本机生效**（`~/.spark-research/credentials.json` 已配置），
  这次录制打了一次真请求，HTTP 200，`code:200`。BACKLOG V9「AMiner getPaper 真实
  key 验证」这条因此顺带兑现——上次录的是真实凭据下的响应，不是靠猜的结构。
- **唯一的行为性漂移，且是本 lane 自己引入的**：E-4 修完之后，Semantic Scholar
  在没有凭据时**不再发起请求**（`skipped`，见下面 E-4 小节），所以本次录制里 S2
  的调用是 `skipped/0ms`，不再是过去那种「打了才知道 429」。这意味着：
  - `search-alphafold.json` / `fetch-by-id.json` / `novelty-check.json` 三个
    cassette 里，S2 那部分条目**没有被本次录制刷新**——`FixtureHttp` 的录制是
    增量式的（`load()` 时把老 entries 全读进内存 map，`record` 模式只更新真正
    发起过请求的 key，未命中的 key 原样保留），S2 的老条目（几个月前录的
    429 响应）就这样被原样带了下来，成了**再也不会被日常录制刷新的冻结历史快照**。
    这是一个值得记录的运维死角：以后除非专门给 S2 配一把凭据去录制，
    否则这几个 S2 fixture 条目会一直是旧的——不算 bug，但如果哪天上游把 429
    的错误体格式改了，不会有任何信号提醒。已如实记在本文件与下面 E-4 小节，
    不打算这一轮解决（需要一把真实 S2 key，本 lane 没有）。
  - openalex / crossref / europepmc / PDB 的响应体内容**确有变化**（索引持续
    增长：crossref 返回的条数、`search.rcsb.org` 的匹配数等），但**字段结构
    完全没变**——所有回放测试（含依赖具体字段的 `paper.venue === "Nature"`、
    `paper.year === 2021`、`alphafold.available === true` 等硬编码断言）全部
    通过，说明这不是 schema drift，只是数据自然演进。
- 结论：**六个免 key 源健康，无需任何 normalize.ts 改动**（本来也没有编辑权）；
  唯一的“漂移”是本 lane 自己的修复（E-4）造成的、预期内的行为变化。

### 0.2 v0.2.x 老 `records.db` 迁移演练：顺利，未发现问题

`git log` 显示 `backend/src/project/schema.sql` 自 v0.2.0 起只有一次提交碰过它
（P1 建库那次），之后再没变过——也就是说「当前 schema.sql（无 `rev` 列）」本身
就是**忠实的 v0.2.x 形态**，不需要靠猜的近似值。

演练脚本（`/private/tmp/.../scratchpad/migration_rehearsal/rehearsal.ts`，
未纳入仓库——是一次性验证脚本不是回归测试，见下方"为什么没有落成 test"）：

1. 用 `git show v0.2.0:backend/src/project/schema.sql` 的原文手工建一个不含
   `rev` 列的库，插入 4 条 v0.2.0 时代真实会出现的 record（`paper`/`reading`/
   `idea`/`decision`，故意不用后来才加的 `agent_run`）+ 2 条引用边（`cites`/
   `derives_from`）。
2. 用**当前代码**的 `RecordStore` 打开它——触发 `initSchema() → migrateRevColumn()`。
3. 核对：
   - `rev` 列被正确 `ALTER` 出来，`NOT NULL`；
   - 4 条老 record 全部读得出来，`title`/`content`/`evidence`/`origin`/`metadata`
     一个字段没丢；
   - 老 record 的 `rev` 全部被补成 **1**（诚实起点，不是瞎猜的历史版本号）；
   - 2 条老边（`cites`/`derives_from`）完整保留，`listEdges()` 数量对得上；
   - 迁移后的库上能正常 `create()` 新 record（`rev` 从 1 起）、`update()` 老
     record（乐观并发：`expectedRev` 校验正确，过期 `expectedRev` 被
     `RecordConflictError` 拒绝，不是静默覆盖，且拒绝后数据没被污染）；
   - **幂等**：重新打开同一个库（`new RecordStore(dbPath, ...)` 第二次），
     不会重复 `ALTER`（SQLite 本身对已存在列的 `ALTER ADD COLUMN` 会报错，
     所以如果不幂等这一步会直接炸；实测没炸），老 record 的 `rev`（已经因为
     上一步的 `update` 变成 2）没有被迁移逻辑冲回 1。

终端输出（节选，完整见下方"阴性对照③"前的原始记录）：

```
[2/5] 用当前代码的 RecordStore 打开这个老库（触发 initSchema → migrateRevColumn）
✅ 迁移后 records 表出现了 rev 列
✅ rev 列是 NOT NULL

[3/5] 核对老记录：读得出来、字段没丢、rev 正确补成 1
✅ count() 与迁移前的行数一致（4 === 4）
✅ 老的 paper record 读得出来
✅ 老 record 的 title/evidence/origin.connector/metadata 完整保留
✅ 老 record 的 rev 被正确补成 1

[3.5/5] 核对老引用边完整（cites / derives_from 都在，listEdges() 数量一致）

[4/5] 迁移后的库上做新写入：create 一条新 record，update 老 record（乐观并发）
✅ 全新创建的 record 起始 rev === 1
✅ 老 record 迁移后可以正常 update；rev 从 1 变成 2
✅ 用过期 rev 的并发写入被 RecordConflictError 拒绝，不是静默覆盖

[5/5] 重新打开同一个库，确认迁移幂等
✅ 重开后行数正确（老 4 条 + 新建 1 条 = 5）
✅ 重开后老 record 的 rev 仍然是 2（没被迁移逻辑重置回 1）

🎉 v0.2.x 老库迁移演练全部通过
```

**结论：D-9 的运行时迁移在真实 v0.2.x 形态的库上工作正常，没有发现问题。**
单测里已有的迁移覆盖（`migrateRevColumn` 相关用例，若存在于其他 lane 的测试里）
是纯逻辑层面的验证；这次是**真实旧 schema 字节级复现 + 完整数据生命周期**
（读 → 迁移 → 新写 → 并发冲突 → 重开幂等）的端到端演练，是此前从未做过的一层。

**为什么演练脚本没有落成仓库里的 test**：`backend/src/project/records.ts` 不在
本 lane 的文件所有权内（本 lane 只持有 `literature/*.ts` + `reviewer/citation_judge.ts`
+ `connectors/literature.ts`），也没有任何 `tests/unit/records*.test.ts` 落在本
lane 拥有的测试文件 glob（`literature*`/`dedupe*`/`citation*`）里。新增一个
`records`-专项测试文件会越出本 lane 的边界、可能与同波次其他 lane 的并行改动
冲突。演练脚本本身、完整终端输出、以及下面的阴性对照③，就是这次验证的完整
证据链——如果主会话收口时希望把它固化成仓库里的回归测试，建议放进
`tests/unit/records_migration.test.ts`，由持有 `project/records.ts` 编辑权的
lane（或主会话）落地。

## 1. 六项修复逐条汇报

### E-2：citation judge 降本（`reviewer/citation_judge.ts`）

现状复现：`reviewer/rules.ts` 的 `citationIntegrity()` 对草稿里每处引用出现都
串行 `await judge.judge(...)`，且完全没有去重——**这个调用循环不在本 lane 的
文件所有权内**（`rules.ts` 不在允许清单里），所以把能在判定器自己内部做到的
事情做全：

- **去重**：`LlmCitationJudge` 内置 `Map<string, Promise<CitationJudgement>>`
  缓存，key 是 `(key, sha256(statement))`。同一个 `(key, sentence)` 组合的
  重复判定（含并发重复与串行重复）只真正打一次 LLM——**对今天这条既有的串行
  调用链是直接生效的降本**，不需要 `rules.ts` 改一行。失败（调用失败 / 两次都
  解析失败）不进缓存，避免一次网络抖动把某句话永久判不出来。
- **并发限流**：内置计数信号量 `ConcurrencyGate`，默认上限 4，可通过构造函数
  第三个参数 `{ concurrency }` 调整。今天的默认调用方（`rules.ts` 的串行 for
  循环）不会触发并发；单测里用自制的 tracking fake LLM（记录任意时刻的在途
  调用数）直接对 `judge()` 发起真并发调用验证限流生效。
- **`responseFormat: "json_object"`**：P11 后 `CallOptions.responseFormat` 可用，
  已接上（`{ ...(model && {model}), responseFormat: "json_object" }`），不支持
  的 provider 忽略该字段，原有的"解析失败重试一次"逻辑原样兜底。

**诚实的限制**：并发限流的"扇出保护"在今天的默认调用路径下**不会真正生效**——
`rules.ts` 的 for 循环本来就是逐个 `await`，永远不会有第二个 `judge()` 调用在
第一个完成前发起。要把 E-2 描述的"30 次串行往返砍一个量级"真正兑现成端到端的
吞吐提升，需要把 `rules.ts` 的循环从 `for...await` 改成 `Promise.all` 风格的
并发调度——这个改动落在 `rules.ts`，不在本 lane 文件所有权内，**未做**。去重
这一半是完整、立即生效的；并发限流这一半是完整实现、单测直接验证过、但**尚未
接入唯一的生产调用点**，需要持有 `reviewer/rules.ts` 编辑权的 lane 配合一个
"把 `for` 循环换成受限并发调度"的小改动才能端到端兑现。

### E-3：`mergeAuthors` 按下标配对 affiliation（`literature/dedupe.ts`）

已复现且已修复。旧实现：`longer.map((author, i) => ... shorter[i]?.affiliation)`，
纯按下标对齐——两源作者顺序不同（常见：一个源按贡献排序、另一个按姓氏字母序）
就会张冠李戴。改成按**归一化姓名**（`titleKey()` 折叠大小写/空白后比较）在两个
列表间配对；完全同名撞出多个候选时，加一道"年份闸"：两篇论文的年份都已知且相同
才取第一个候选，否则宁可留空也不猜。评审报的 Alice→MIT/Bob→Tsinghua 场景已在
`tests/unit/dedupe.test.ts` 里精确复现并验证修复（见下方阴性对照②）。

### E-4：S2「无 key 自动降级」承诺未实现（`connectors/literature.ts`）

`apiKeyRequired` 从 `false` 改成 `true`（按 DEVELOPMENT_PLAN 原文"改真值"的要求），
补上与 AMiner 完全同款的 `CredentialProvider` 通路（connector id `semanticscholar`，
字段 `api_key`，官方鉴权头 `x-api-key`）。无 key 时 `search`/`getPaper` 直接返回
`credentialMissingResult()`，**不再发起请求**；`search.ts` 的 `isCredentialMissing()`
判断是通用的（不认连接器 id），所以统一检索会自动把它识别成 `outcome:"skipped"`
而不是 `"failed"`——`search.ts` **不需要改一行**。

副作用（已在测试里妥善处理，见 §0.1）：`tests/helpers/literature_scenario.ts` 与
`tests/helpers/ideation_scenario.ts` 里默认的 `searcherWith()`/`noveltySearcher()`
不带凭据（这两个 helper 文件不在本 lane 编辑权内），所以：
- 单元回放测试里，凡是要验证"S2 429 被如实标注为 failed"这条既有断言的用例
  （`literature_e2e.test.ts` 两处），本 lane 在**owned 的测试文件内部**本地
  构造了一个带假凭据的 registry（`searcherWithS2Credentials`），复现的是
  fixture 里真实录到的"配置了凭据但仍然 429"状态，而不是伪造。
- 真实网络录制（`tests/integration/`）默认调用方没有凭据，S2 因此被跳过——
  这正是 E-4 要的效果，见 §0.1 的漂移说明。

### E-5：CJK 元数据（`literature/export.ts` + `literature/dedupe.ts`）

两处修复，都刻意避开了 `models.ts`（跨 lane 共享，本 lane 无编辑权）：

- **bibtex key 保留 Unicode**：`export.ts` 的 `bibtexBaseKey()` 原来用
  `.replace(/[^a-z0-9]/g, "")` 把作者姓氏/标题首词里的非 ASCII 字符整个砍掉——
  中文作者/标题的 key 全部退化成 `anon2021untitled` 这类完全脱钩的占位符。改成
  `.replace(/[^a-z0-9\p{Script=Han}]/gu, "")`，汉字与 ASCII 字母数字都保留，
  英文标题/作者的行为完全不变（正则只是多留了一类字符，不影响原有过滤）。
- **中文标题模糊去重（字符 bigram）**：`models.ts` 的 `titleSimilarity()` 按
  空白切分 token 算 Jaccard——中文标题本来没有空格分词，`titleKey()` 归一化后
  整句是一个大 token，两篇标题只要有一字之差就判 0 相似，模糊去重形同虚设。
  在 `dedupe.ts` 内部（不改 `models.ts`）加了 `effectiveTitleSimilarity()`：
  标题含汉字（`\p{Script=Han}` 探测）就走字符 bigram 的 Jaccard，否则原样走
  `titleSimilarity()`。`canMerge()` 改用这个函数。AMiner 的中文优势现在能
  真正在跨源去重里兑现（不然 AMiner 单独收录的中文文献永远不会和其他源的中文
  结果合并）。

### E-6：删除论文留孤儿 record（`literature/reading.ts`）

已复现：`library.ts` 的 `remove()`（不在本 lane 编辑权内）只删 `papers` 表那
一行，`records.db` 里的 `type:"paper"` record（入库时创建）与挂在它上面的
`type:"reading"` 精读卡 record 变成孤儿——`records.list()`/`records.graph()`
照常能读到它们，指向的库内论文却已经不存在，与"证据图不撒谎"的项目主张相悖。
`listReadingCards()` 只在"列精读卡给综述用"这一条路径上过滤掉孤儿，证据图本身
不知道这件事。

修复：`reading.ts` 新增 `retractOrphanRecords(records, library)`——一次可重复
调用的对账扫描，把 `metadata.libraryPaperId` 指向"库里已不存在的论文"的
`paper`/`reading` record 标 `metadata.retracted = true`（外加 `retractedAt`/
`retractedReason`）。选"标 retracted"而不是级联物理删除，是因为 `RecordStore`
（P10-d D-9 的乐观并发设计）**没有 `delete()` 方法**——证据图的哲学本来就是
"不删、标状态"，这条路径不需要给 `RecordStore` 新增任何方法。幂等：已标过的
不会重复处理。

**诚实的限制**：这是一个独立可调用的对账函数，**没有被自动挂进
`library.remove()`**——那需要改 `library.ts`，不在本 lane 文件所有权内。今天
它需要被显式调用（CLI 或定期任务）才会生效；建议后续由持有 `library.ts` 编辑权
的 lane 在 `remove()` 里顺手调一次，或者做成一条独立的 `spark-research lit gc`
命令。已在测试里验证：删除论文后手工调用 `retractOrphanRecords` 确实能正确
回收孤儿 record（含精读卡级联）、不影响健康 record、幂等、对非文献类 record
零影响。

## 2. 阴性对照（三条，终端输出如下）

### ① 去掉 judge 去重 → 调用次数测试红

临时把 `LlmCitationJudge.judge()` 里的缓存读取短路成永远 `undefined`：

```
tests/unit/citation_integrity.test.ts:
343 |     expect(llm.calls.length).toBe(1);
                                   ^
error: expect(received).toBe(expected)
Expected: 1
Received: 3
(fail) LlmCitationJudge · 降本（E-2：去重 / 并发限流 / responseFormat） >
  同一个 (key, sentence) 重复判定只真正调用一次 LLM（去重） [3.00ms]
 5 pass / 1 fail
```

恢复后：`6 pass / 0 fail`。

### ② `mergeAuthors` 恢复按下标配对 → 张冠李戴的用例红

临时把 `mergeAuthors()` 恢复成 `longer.map((author, i) => ... shorter[i]?.affiliation)`：

```
tests/unit/dedupe.test.ts:
26 |     expect(merged.find((a) => a.name === "Alice Zhang")?.affiliation).toBe("MIT");
                                                                           ^
error: expect(received).toBe(expected)
Expected: "MIT"
Received: "Tsinghua"
(fail) E-3：mergeAuthors 按归一化姓名配对（不再按下标） >
  评审实测场景复现并验证已修复：跨源作者顺序不同不再张冠李戴 [2.59ms]
```

精确复现了评审描述的错配方向（Alice 被错配成 Tsinghua，本该是 MIT）。恢复后：
`12 pass / 0 fail`。

### ③ 老库迁移：把 rev 迁移逻辑拆掉 → 老库读取失败

临时注释掉 `RecordStore.initSchema()` 里的 `this.migrateRevColumn();`，重跑
迁移演练脚本：

```
[2/5] 用当前代码的 RecordStore 打开这个老库（触发 initSchema → migrateRevColumn）
❌ 断言失败: 迁移后 records 表出现了 rev 列
```

（脚本在第一个失败断言处退出，是设计如此——这里补一段单独验证，证明"读取失败"
不只是"列不存在"这么表面，而是会在真实调用路径上炸出 SQLite 错误：）

```
getRev threw as expected without migration: no such column: rev
update with expectedRev threw as expected: no such column: rev
```

恢复 `migrateRevColumn()` 调用后，`git diff backend/src/project/records.ts`
为空（确认零残留改动），重跑演练脚本 `🎉 全部通过`。

## 3. 测试纪律与六套件数字

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净 |
| `bun test tests/unit/` | **1332 pass / 0 fail / 0 skip**（基线 1298，本轮 +34） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e`（`SPARK_E2E_PORT=4442`） | **14/14** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |
| `bun test tests/integration/`（默认，不设 `FIXTURE_MODE`） | 0 pass / 8 skip（预期，见 §0.1） |

新增测试文件：`tests/unit/dedupe.test.ts`（新建，E-3 + E-5 专项，12 用例）。
扩充：`tests/unit/literature.test.ts`（S2 凭据降级、CJK bibtex key、E-6 孤儿
record 回收共 ~18 用例）、`tests/unit/citation_integrity.test.ts`（E-2 去重/
并发限流/responseFormat 共 6 用例）、`tests/unit/literature_e2e.test.ts`
（本地补了个带凭据的 searcher 构造，修复 E-4 引入的两处既有断言漂移，未新增
用例数）。

真实网络录制：`tests/fixtures/literature/{search-alphafold,fetch-by-id,
pdf-download,aminer-search,novelty-check}.json` 与
`tests/fixtures/proteins/protein-analysis.json` 已用 `FIXTURE_MODE=record`
对真实上游重新录制并回填仓库；请求头结构性不落盘（沿用既有 `FixtureHttp` 纪律，
未改动其实现）、凭据类查询参数照常被 `canonicalUrl` 剥离、POST body 仍只存哈希。

## 4. 未完成 / 已知限制（诚实汇报）

1. **E-2 并发限流未接入生产调用点**：`rules.ts` 的串行 for 循环不在本 lane
   文件所有权内，去重已完整生效，并发限流已实现且单测验证但需要 `rules.ts`
   配合才能端到端兑现。见 §1 E-2。
2. **E-6 未自动挂进 `library.remove()`**：`retractOrphanRecords()` 是独立可调用
   的对账函数，需要显式触发。见 §1 E-6。
3. **S2 fixture 条目是冻结快照**：没有真实 S2 key 可用于录制，`search-alphafold`/
   `fetch-by-id`/`novelty-check` 三个 cassette 里的 S2 条目是几个月前录制的、
   今后也不会被日常 `FIXTURE_MODE=record` 刷新（连接器现在跳过了请求）。见 §0.1。
4. **v0.2.x 迁移演练脚本未落成仓库测试**：不在本 lane 文件所有权内，建议主会话
   收口时安排到 `project/records.ts` 的持有方。见 §0.2。

以上四条均不影响本轮六套件全绿；如实列出供主会话决定是否排进后续波次。
