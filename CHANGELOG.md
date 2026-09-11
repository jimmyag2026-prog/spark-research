# Changelog

本文件记录面向用户可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## [0.7.0] — 2026-09-11

**v0.7：这一路产生的每一份数据都被原样留下、可导出、可判定能不能出门；检索排序与并发/长任务可靠性补上。**

本版由七个 alpha（alpha.1–alpha.7）、R4 四课题零上下文全量复跑、第五次零上下文外部验收（A6，浏览器入口 +
花钱路径 + 导出两步）打磨而成。每条 lane 由主会话独立复跑测试与阴性对照后合入；**8 + 4 + 6 + 6 条阴性对照全部实跑变红**。

## 给用户的亮点

- **原始层 `raw/`（AD-15）**：每次 connector 调用（脱敏参数 + 原始响应体）、每次 LLM 调用（prompt 与响应原文）、
  每个 kernel 执行、每个设备读数，落 `projects/<slug>/raw/…/<date>.jsonl`，只追加不改、行内 prevHash 成链、
  多进程安全；证据图之下多了 `records_journal`（每次 create/update/link/tombstone/repair 一行），
  `report records --history <id>` 可看，`--repair` 可署名重建（V24）。
- **来源分级三列**：每条 record 带 `provenanceClass`（upstream / derived / user_authored / model_generated）、
  `license`（SPDX）、`quality`；**AD-16：upstream 永不进入共享集合**。
- **`data export / import / verify`**：项目整体导成 Hive 分区 JSONL + manifest（Delta Sharing 三级命名、
  DCAT、SPDX 计数、每文件 sha256、rootHash、增量成链）；`--for-sharing` 把不可共享的 record 打成 stub 保边、
  LLM prompt 只存 hash、上游 raw 与文献库不出门，排除计数写进 manifest。普通导出 → 空项目导入 → 报告 diff 为空
  （A6 实测）。DuckDB 直查三条示例在 `data --help`。
- **检索**：`lit search --rank blended|hits|citations|recent`，默认 blended + 每源深池 30；中文连写复合词
  走 jieba 分词（可选依赖）；AMiner 多词要求同时命中。
- **可靠性**：项目指针文件锁 + 会话绑定（V64 根治）；长任务 kill -9 → `orphaned` → 断点续跑不重复花钱；
  同项目并发写不再 `database is locked`（写事务 IMMEDIATE + 迁移事务化）。
- **审批面看得见词表外试剂原文**（V60）；`lit remove` 可达且不硬删（tombstone）；`lit review` 的逐条
  citation finding 终于进 `review findings`（V71）；`lit search --json` 真是 JSON。

## 如实交代的已知限制

- **方案 DONE 第 3 条未满足**：检索召回「每课题 ≥ +2」只在 T1 实测（3/8 → 5/8）；T2/T4 因 OpenAlex 匿名池
  持续 429 未实测，R4 四课题在 429 下全线 0/8。排序修好了、深度加深了，但**没有 mailto 礼貌池的话
  OpenAlex 会限流**——请 `config set contactEmail <邮箱>`。V67/V86 保持打开。
- raw 层「四类」不含仿真平台执行（`exp run` 走子进程不经 KernelManager，V85）；kernel 类只在 chat 的
  code task 路径有行；raw/kernel 行的 `executionRecordId` 仍为 null。
- for-sharing 往返**有损**（上游正文与文献库不出门）——「report diff 为空」只对普通导出成立。
- CLI 无持久会话 id：并发使用请每终端 `export SPARK_RESEARCH_SESSION=<名字>`，或一律带 `--project`。
- V91 之前（alpha.7 前）多进程混用的项目，raw 链可能带历史断点；`data import` 会指出行号，不回填。
- **开发期事故（V83）**：alpha.1–alpha.5 的单测经 raw 全局兜底往开发者真实 `~/.spark-research` 写了 324MB
  回放记录。代码已隔离（bunfig preload + 门禁）；这是给自己记的，用户安装不受影响。
- 精读任务进度条不实时（V88）；co-explore 一次两张雷同卡（V89）；项目下拉框不显示 slug（V90）。

## 数字

单测 2147 → **2271** · Playwright 19 → **20** · concurrency+timeout 25 → **31** · pytest 73 · lab 26 ·
R4：并发四课题零串项目、kill -9 后 orphaned、单课题 $0.03–0.05 · A6：60 次调用 $0.2136，三方对账一致，无 Blocker。

## 安装

- **单二进制（推荐）**：本页 assets（macOS arm64 / Linux x64），`chmod +x` 即用
- 源码：`git clone` → `bun install` → `bun backend/src/index.ts`（需 Bun ≥1.2）
- 各 alpha 的逐段明细见下文（alpha.1–alpha.7，保留供追溯）

## [0.7.0-alpha.7] — 2026-09-11

**A6（第五次零上下文验收）通过，无 Blocker/High；但它的一条 Low 观察项挖出了 raw 链的真问题（V91）。**

A6 报告：`spark-research-v0.7-plan/A6/A6_report.md`（37 张截图）。验收者把 `data import` 返回的 `verified:false`
读成「没顺带校验」——**实际是链真断了**：源项目的 raw/llm 第 59 行 prevHash 指向第 57 行。真因是
`JsonlRawSink` 把「上一行 hash」按**进程**缓存，server 与 CLI 两个进程同时往同一个文件 append 时各自接在
同一行后面。这是 AD-15 承诺的核心（链可核）在多进程场景下不成立，不修不发。

### 修复

- **raw append 多进程安全（V91）**：每次 append 从文件尾重读上一行 hash（只读最后 64KB），
  「读尾 → 写入」用 `<file>.lock`（O_EXCL，过期 10s 回收）做成临界区；`importEntry` 同样。
  两个真实子进程各 100 次 append 同一文件 → 200 行链完整（`tests/concurrency/raw_append_race`，
  阴性对照：回到按进程缓存 + 无锁 → 红）。
- **`data import` 逐链复核并逐项报告**：`verification.journal` 与 `verification.raw.{connector,llm,kernel,device}`
  各带 ok/lines/reason，CLI 一行打全；不再是一个裸 `verified` 布尔。
- **raw 导入不再按 ts 重排**：按导出的源文件顺序回放（同毫秒并发 append 的行重排会断链）。

### 如实交代

- A6 那次导出的源项目链**已经断了**，导入它照样报 ❌——这是对的（导入不修链，只如实报）。
- V91 之前所有多进程混用（server + CLI 同时跑）的项目，raw 链都可能带这种断点；`data import` /
  `JsonlRawSink.verify()` 会指出行号。历史断点不回填（回填等于伪造）。

## [0.7.0-alpha.6] — 2026-09-11

**R4 修复窗口。** R4（四课题零上下文全量复跑，`spark-research-v0.7-plan/R4/`）三条 P0 全在数据层，
外加一条 R4 证据里挖出的、比 P0 更严重的事故。逐条如实：

### 事故：单测把 324MB raw 写进了用户真实 `~/.spark-research`（V83）

alpha.1 起 raw 层的全局兜底 sink 按 `dataDir()` 现算，单测里大量 connector/内核调用没有项目上下文、
也没设 `SPARK_RESEARCH_DATA_DIR`——一天下来 43,680 行 connector 回放记录（含脚手架的假 connector）、
253 行 kernel 记录落进用户真实目录，与 R4 真实课题的行混在一起；`api_calls.jsonl` 从 v0.6 起同样如此
（59,462 行）。**修**：`bunfig.toml` preload（`tests/preload.ts`）给每个 `bun test` 进程注入临时数据目录，
落在 `~/.spark-research` 下直接抛错（V74 的系统性修法）；e2e 的 fixture 服务器同样隔离；门禁
`test_isolation.test.ts`。**已污染的真实目录未动**——归档还是删除等用户裁定（R4 真实行混在里面）。

### R4 P0

- **P0-1 `--for-sharing` 经 raw/llm 泄漏上游摘要**：prompt（messages）里嵌着精读时喂给模型的论文摘要。
  现在 for-sharing 下 llm 行的 `messages` 只存 hash（response 照常带），`manifest.excluded.llmPromptsHashed`
  计数；导入侧对这类行只核链。
- **P0-2 connector/kernel 的 raw 落全局而非项目**：CLI（lit/idea/protein）与 HTTP 检索入口此前在解析
  项目之前就建 registry。现在 registry 带 `project.raw()` 与 command；解析不出项目才全局兜底。
- **P0-3 for-sharing 往返报告 diff 非空**：stub 现在保留书目指针（title / DOI 或 URL / 来源 connector），
  引用标签与参考文献不再消失；**但 for-sharing 往返本就是有损的**（上游正文与文献库不出门），
  G5「diff 为空」只对普通导出成立——R4 任务书把两者混写了，已更正，A6 分开验。

### R4 P1

- **P1-5 并发 `idea check` 仍 `database is locked`**——V80 的 C-4 只补了 busy_timeout，**真因有两个**：
  ① bun:sqlite `transaction()` 默认 DEFERRED，读→写升级时后来者立即 SQLITE_BUSY，busy_timeout 不起作用
  → 写事务一律 `.immediate()`（阴性对照：改回 DEFERRED，两进程 120 次落库出 7 次 locked）；
  ② 并发首开时各库的 `PRAGMA table_info → ALTER` 迁移竞态（后来者 locked 或 duplicate column）
  → 建表 + 迁移整体进 IMMEDIATE 事务。两个真实子进程的复现测试进 concurrency 套件（25 → 30）。
- **P1-4 `lit search --json` 不生效**：现在真是 JSON（`--add` 并用时入库计数进 `added`）。
- **P1-6 AMiner 拆词合并查准低**：多词查询要求 ≥2 词同时命中，全无才退回单词命中并在 note 说明。
- **P1-7 召回@10 全线 0/8**：本轮 OpenAlex 会话内 100% 429（深池 30/源 × 四课题并发）。加了
  `api.openalex.org` 主机限速策略（官方 10 rps）；**礼貌池要 mailto——用户请 `config set contactEmail`**。
  召回数字要等 429 消退后 A6 复测，V67 不关。
- **P1-8** `idea new/check --help` 补 `--budget-usd` / `--model` / `--project`。

### 如实交代

- 仿真平台（`exp run`）的执行不在 raw 层（它走 SimulationPlatform 子进程，不是 KernelManager）；产物与
  observation 带 contentHash，但 raw 的「四类」不含仿真——登记 V85。
- `lit review` 的「解析引用数 > 判定数」差额未说明去向（R4 P2-10）——登记 V87。
- AMiner 对中文查询返回的多为中国期刊英文版，T4 预期的中英双发去重场景本轮未出现（P2-11）——登记，不算缺陷。

## [0.7.0-alpha.5] — 2026-09-11

**alpha.5：第二段三条 lane（B-2 · B-4 · C-1）+ 收口。** PR #73 B-4 · #74 C-1 · #76 B-2 · 收口 PR。

### 新增

- **blended 默认深池 30/源（V67 深度，用户拍板）**：`lit search` 与 HTTP 入口在 blended 档不再把 `--limit`
  当每源抓取数，每源抓 30 后合并排序、返回 `limit` 条；`--per-source N` 显式覆盖；`--rank hits` 保持 10。
  真实核验（免 key 源）：T1 recall@10 hits 3/8 → blended 5/8（**达 +2**）；**T2/T4 因 OpenAlex 匿名池持续 429
  未实测**，R4 补。
- **中文分词器（V65 残余）**：Python `jieba` 作可选依赖（与 pypdf 同形状），连写复合词 0 命中时先分词再走
  深池合并，note 如实标注；缺 jieba 退回空格拆词；`doctor` 加探测。
- **V64 根治**：`state.json.lock` 文件锁（O_EXCL + pid/时间，过期且 pid 不存活即回收）；项目解析四档
  `--project` > env `SPARK_RESEARCH_PROJECT` > 会话绑定 > 全局指针；`project use` 默认只绑会话
  （会话 id 取 env `SPARK_RESEARCH_SESSION`），`--global` 才改全局。两个真实子进程 100 次交替零串项目。
- **V72**：BibTeX key 只允许 `[a-z0-9]`，中文作者/无作者降级 `anon<year>…`（覆盖 E-5 旧决定）。
- **V71**：`lit review` 现在把逐条 citation finding 登记进 findings.db（fingerprint 复用 reviewer 口径），
  `review findings` 终于看得到——根因不是查询侧，是落库侧从没写过。

### 如实交代

- CLI 没有持久会话 id：不设 `SPARK_RESEARCH_SESSION` 时 `project use` 退化为改全局指针（有提示）。并发使用请
  每个终端 `export SPARK_RESEARCH_SESSION=<名字>`，或一律带 `--project`。
- 深池让 fixture cassette（按 10/源录制）失配——修法是 `LiteratureSearcher` 新增 `deepPool` 选项、测试场景
  如实注入 10，不重录 cassette，生产默认不变。
- B-2 lane 曾因 Claude 额度中断，未提交改动由主会话落 wip commit 保存后复活续做；终态分支无「未验证」提交。

## [0.7.0-alpha.4] — 2026-09-11

**W7-D2：`data export / import / verify`——项目整体可导出（JSONL + manifest）、可核、可重建；`--for-sharing` 把 AD-16 落到产物上。**
（编号说明：主会话的 D2 先于三条 lane 完成，故 alpha.4 = D2，alpha.5 = 三 lane 收口。）

### 新增

- **`spark-research data export`**：`projects/<slug>/export/<ts>/` 下 Hive 分区 JSONL——
  `records/type=…/date=…` · `edges/` · `records_journal/date=…` · `raw/kind=…/date=…`（+ `raw/blobs/`）·
  `artifacts/`（版本行 + 文件 + 依赖 + execution_records）· `library/papers.jsonl`（含已 tombstone 的）·
  `usage.jsonl`。`manifest.json`：Delta Sharing 三级命名（share = 项目）、DCAT 核心字段、SPDX 许可计数、
  来源分级计数、每个文件的 sha256 与 `rootHash`；`--since` 增量导出带 `prevManifestHash` 成链。
  **只有 JSONL，不做 Parquet**（用户裁定）；帮助里给了三条 DuckDB 直查示例。
- **`data import <dir> --project <新slug>`**：先核每个文件 sha256 与 rootHash，再原样重建到**空**项目
  （records / edges / journal 保 seq 与 hash 不重算；raw 行原样，链不重算；artifacts 文件与行；文献库行；
  usage）。`data verify <dir>` 只核不导。
- **`--for-sharing`（AD-16 的产物面）**：`shareable()` 判否的 record 打成 **stub**（只有 id/type/hash/
  来源分级，无内容）**保边**；这些 record 的 journal 行同样打桩（seq/prevHash/hash 原样、patch 换骨架）；
  raw 的 connector 行与整个文献库不出门；被排除的计数写进 `manifest.excluded`。导入侧 `verifyJournal()`
  对 stub 行只核链不核 hash——stub 标记本身可见。
- **V82 关闭**：orchestrator 的 code task 现在把每次 kernel 执行落 `execution_records`（frame = 会话，
  cell_index 递增）——这张表从 v0.1 起第一次有了生产写入方。

### 门禁

- G5：export → 空项目 import → records/edges/journal/raw/artifacts/library 逐条相等，`report export` 的
  Markdown diff 为空（slug 归一化）；篡改任一文件 `verify` 与 `import` 都拒。
- G6 导出面：`--for-sharing` 产物里 grep 不到上游内容；stub 保边；导入后边仍在。
- 5 条阴性对照实跑全红（import 不导 journal / 不导 raw · 放行 upstream · 不丢上游 raw · verify 不核 sha256）。

### 如实交代

- raw 行的 `project` 字段在导入后仍是来源 slug（hash 覆盖了它，改写会断链）——链完整性优先，manifest.share 记着来源。
- raw/kernel 行的 `executionRecordId` 仍为 null（raw 在 execute() 内先落、拿不到 id）；两边靠 contentHash 对得上，接线留后续。
- `data import` 只重建到空项目；不做合并。

## [0.7.0-alpha.3] — 2026-09-11

**W7-D1：证据图之下的 append-only 日志（AD-15 的 L1 半边）· V24 恢复路径 · V30 删论文可达且不硬删。**

### 新增

- **`records_journal`**：records 表的每次 `create` / `update` / `link` / `tombstone` / `repair` 在同一事务
  落一行日志（create 为全量快照、update 为调用方原样 patch），行内 `prevHash` 成链，`verifyJournal()`
  逐行重算可抓篡改。老库首次打开给既有 record 各落一行 `backfill` 快照——历史从这一刻起可追溯，
  更早的改写本来就没记录，不编造。9 处状态机调用方一行未改（可变投影之下加不可变日志，不重写状态机）。
- **`report records --history <id>`**：看一条 record 的完整日志；HTTP `GET /api/records/:id/history` 同源。
- **`report records --repair <id> --to-seq N --actor <署名>`（V24）**：完整性核验失败后的恢复路径——
  按日志把投影重建到第 N 步，需要署名，落一行 `op=repair`，不删任何历史。
- **`lit remove <paperId|doi> [--reason]`（V30）**：删论文这条路终于可达。`LibraryStore.remove()`
  改 **tombstone**（`removed_at`，行留着；re-add 同一 DOI 即复活），同一动作里跑孤儿对账，指向它的
  paper/reading record 一律 `tombstone`（不再是泛用 update）。

### 门禁

- G4：随机 46 次写操作后按日志重放 == 投影逐字段相等；篡改任一行 `verifyJournal` 报 brokenAt。
- 4 条阴性对照实跑全红（update/create 不落日志 · remove 退回硬删 · repair 不落 op=repair），见 devlog W7-D1。

### 如实交代

- V82（`execution_records` 无生产写入方）本波**未处置**：接线要定 frame/cell_index 语义且牵动 orchestrator，
  留到 W7-D2 与导出一起定（导出时它是一张空表，如实导空）。
- journal 是**按项目一条链**，不是按 record；导出时整本导。
- `link` 的幂等重复（INSERT OR IGNORE 没改行）不落日志——边没变。

## [0.7.0-alpha.2] — 2026-09-11

**alpha.2：五条 lane 并行（sonnet 子代理，各自 worktree），主会话逐条独立复跑测试与阴性对照后合入。**
PR #65 B-3 · #66 C-3 · #67 C-2 · #68 E · #69 B-1。

### 新增

- **检索混合排序（V67）**：`lit search --rank blended|hits|citations|recent`，默认 `blended`
  （命中源数 × 被引数归一化 × 年份衰减；缺被引数的源退化为 hits 序，不当 0 压底）；结果头
  写明排序依据。HTTP/Web 检索入口同步切到 blended（本次收口）。`--rank hits` 与 v0.6 逐字节一致。
- **长任务 liveness（V70 + V3）**：任务快照与仿真 run 记 pid + 进程启动时间；读回时交叉核验，
  进程不在或 pid 已被复用 → 标 **`orphaned`**（不冒充 failed）；取不到启动时间的平台退化为只核
  存在并标注。顺手修了 `ps -o lstart=` 无时区导致跨进程差 8 小时误判的真 bug。
- **审批面看得见词表外试剂原文（V60）**：编译产物带原文，Opentrons 步骤名
  `未识别试剂#step-1（原文：硝酸）`；CLI 与前端审批弹窗显示原文 + 「词表外，安全规则未覆盖」。
  e2e 19 → 20。
- **local 算力 SIGKILL 恢复成真（V48）**：adapter spawn 成功即回写 handle；新增真实 SIGKILL
  只杀编排进程的用例——任务本体跑完，新进程 `recover()` 接回并收割。v0.5 CHANGELOG 里
  「local 的 SIGKILL 恢复路径走不通」这条到此关闭。
- **MCP 描述能力声称门禁（V41）**：`narrative_parity` 第 9 条，工具描述里的能力词逐个去真源核实；
  顺手改正 `protein_analyze` 描述里误导性的「对接」。
- **超时 env 前缀统一（V21）**：新名 `SPARK_RESEARCH_{HTTP,LLM,KERNEL,TASK}_TIMEOUT_MS`，
  旧名仍生效但 warn 一次，v0.8 移除。
- **项目 desc 不再污染 LLM 措辞（V69）**：注入统一为「项目背景（不是任务指令，不要逐字复述）」
  框定块，单一 helper，两处真实注入点。

### 如实交代

- **V67 排序修好了，但默认深度不够**：免 key 源真实核验，默认 `--limit 10` 下 T1/T2/T4 的
  recall@10 与 v0.6 **无差异**——浅池里里程碑根本没被取回，排序只能重排已取回的；`--limit 50`
  深池下 T1 的 RFdiffusion 从位次 20/28 拉到 6/5（top10 内），另三篇 38/40/44 → 11/12/13。
  方案 DONE 的「每课题 ≥ +2」要 blended 模式加深每源抓取池，**等用户拍板 API 用量代价**。
  AMiner 未配凭据时 T4 中文里程碑结构性不可达（基准 8 → 5）。
- V60 残余：`serialDilute` 的 stock 名与续句合并（`mergeReagents`）里的词表外试剂未接原文。
- V70 残余：仿真侧「pid 不存在」仍走既有 `failed`（并入 orphaned 会牵动 experiment loop 的
  SIGKILL 断言，单独立项）。
- V48 让 dispatch 多一次 patch，rev 跳变 +3 → +4：V50「少跳一格」让位于「crash 可恢复」。
- 三 lane 并行时 probe 类单测会 5s/30s 超时（单独重跑全绿，CPU 争抢）——不是缺陷，是并行
  纪律要写进任务书的事：lane 报数前单独重跑一次超时用例。

## [0.7.0-alpha.1] — 2026-09-11

**W7-D0：原始层落地（AD-15）· 来源分级三列（AD-16）· 基线闸清账。** v0.7 方案见
`docs/DEVELOPMENT_PLAN_v0.7.md`，数据层配套设计见 `DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md`。

### 新增

- **L0 原始层（append-only）**：每个项目新增 `raw/{connector,llm,kernel,device}/<date>.jsonl`
  ——connector 的脱敏请求参数 + 原始响应体、LLM 的 prompt 与响应原文、kernel 的 source/stdout/
  stderr、湿实验设备读数，**只追加不改**，行内 `prevHash` 成链，`verify()` 逐行重算可抓篡改。
  超 64KB 的正文落 `raw/blobs/` 按 sha256 去重。四个埋点各一处（`connectors/base.ts` ·
  `usage/ledger.ts` · `kernels/manager.ts` · `lab/wet_loop.ts`），全体调用方自动覆盖；没有项目
  上下文的调用（capabilities 探测、daemon mcp_call）落全局兜底 `<dataDir>/raw/`——不记等于漏。
- **来源分级三列**：records 表新增 `provenance_class`（upstream / derived / user_authored /
  model_generated）、`license`（SPDX 表达式；凭据源 `LicenseRef-proprietary-<源>`；用户/模型产出
  占位 `LicenseRef-spark-user-owned`）、`quality`（把散在 metadata 里的 deterministic / basis /
  simulated / caveat 收成一列）。老库打开即迁移回填，幂等。18 个生产写入点全部显式声明来源
  分级，**源码门禁**核每一处，省略即红。
- `shareable()` 判定（AD-16）：upstream 一律不出门、license 未知不出门、proprietary 不出门。
  W7-D2 的 `data export --for-sharing` 只认它。
- 两个配置项：`rawLlm`（默认 on；关掉后 agent_run 仍有 hash 但原文不可追溯）·
  `rawUpstreamInline`（默认 off；凭据源响应体只存 hash）。两者都过 config_reader_parity 门禁。
- 门禁 G1（raw 行数 == 台账行数，四类各一）· G2（带假 key 的调用后 grep raw 目录）·
  G3（篡改任一行 verify 必红）· G6 · G7，**8 条阴性对照全部实跑变红**（devlog W7-D0）。

### 修复

- **chat 路径进用量台账与 raw（V78 主体）**：OrchestratorAgent 此前自建 LLMRouter 直调，
  usage.jsonl 与 raw/llm 都漏。现在会话绑定项目即经 `usageTrackingLlm`（command=chat）。
  **残余**：子代理 tool loop 的 `subAgentLlm()` 仍是裸调用（无 sessionId 可绑），登记在 V78。
- **同项目并发写 `database is locked`（V80）**：records / library / artifacts 三库补
  `PRAGMA busy_timeout = 5000`（此前只有 findings.db 有）。
- **v0.6.0 带着一条全套必红的 e2e 发布了（V81）**：⑱ 用量面板改增量断言。CI 不跑 e2e 所以没人看见。

### 如实交代

- **`execution_records` 至今没有生产写入方（V82）**：kernel 的 cell 执行从未落过这张表，
  所以 raw/kernel 行的 `executionRecordId` 恒 null，行内自带 source/stdout/stderr 与 contentHash。
- raw/connector 行的 `rateLimitWaitMs` 未接（V63 未动）。
- `tests/e2e` 的 45 个既有类型错误（V62）本波裁定**豁免并写明理由**（Bun 特有 import 属性），
  不纳入 typecheck。

## [0.6.0] — 2026-09-11

**v0.6：装完就能用，用了知道花了多少钱，读论文是真读。**

本版由六个 alpha 迭代（alpha.1–alpha.6）与 **B2 三轮零上下文实证回环**（4 个真实课题 ×
并发执行 × 逐轮修复回归）打磨而成——全部能力声明都有实测背书，全部已知限制都如实登记。

## 给用户的亮点

- **开箱即有工作台**：下载本页的单二进制（macOS arm64 / Linux x64，零预装）或源码起
  `server`，浏览器打开即完整 UI——新增长任务进度、record/证据图、算力只读、用量四个面板
- **精读真读全文**：有 PDF 的论文经 pypdf 抽全文喂给模型，每张卡标注「基于全文/仅摘要」；
  综述因此写得出具体数字与方法对比（实测 7–12k 字、9–32 篇引用、**三轮 400+ 条引用
  0 伪造**）
- **花钱有闸有账**：`--budget-usd` 预算闸（超即优雅停、产出保留）+ `usage` 命令按命令/
  模型归因；成本未知绝不当零。实测一个完整课题 **$0.03–0.09**（glm-5.3-flash）
- **中文检索可用了**：AMiner 词序列匹配的机制修复（0 命中自动拆词深池合并并如实标注）；
  中文基准召回实测 0/3 → 3/3
- **并发多开安全**：全部 CLI 支持 `--project` 显式隔离——四会话并行 22+ 分钟实测零污染
- **上手文档**：`readme_for_human.md`（人类）/ `readme_for_agent.md`（AI agent 集成）

## 如实交代的已知限制

检索排序会让奠基论文沉底（DOI 直加可补救，V67 已立项）· 连写中文复合词仍无法检索
（需分词器）· 中文全文获取率低（OA 供给）· Modal 远端算力仅契约无真实链路 ·
湿实验止步模拟器 · bioRxiv 的 search 是窗口模拟非真检索 · 项目 desc 会渗入 LLM 措辞。
完整登记见 `docs/BACKLOG.md`。

## 数字

单测 2036 → 2145+ · Playwright 15 → 19 · CI（单测+双平台二进制冒烟）从无到有 ·
三轮实证：中文召回 0/3→3/3 · 并发污染 双向实锤→0 · 判定器 JSON 失败率 0% ·
新 P0 发现 R1:2 → R2:1 → R3:**0**（收敛）

## 安装

- **单二进制（推荐）**：下载本页 assets 中对应平台的文件，`chmod +x` 即用
- 源码：`git clone` → `bun install` → `bun backend/src/index.ts`（需 Bun ≥1.2）
- 各 alpha 的逐项变更见 [CHANGELOG.md](https://github.com/jimmyag2026-prog/spark-research/blob/main/CHANGELOG.md)

（以下 alpha.1–alpha.7 为本版开发期的逐段明细，保留供追溯）

## [0.6.0-alpha.7] — 2026-09-11

**A5 浏览器入口验收的两个 blocker 修复。**

- **UI 的 Idea 生成不再永久挂起**：Bun.serve 默认 10 秒请求超时会掐死同步 LLM 路由
  （后端算完了、前端永远等不到）。idleTimeout 显式设为 255 秒（Bun 上限）并有测试钉住。
- **HTTP/UI 的 LLM 调用真实入账**：G-3 用量台账此前只接了 CLI——UI 花真钱、用量面板
  报 $0。现在 read/review/co-explore/novelty 四条 HTTP 路由全部经 llmFor 计量，
  与 CLI 写同一份 usage.jsonl。
- **UI 精读接上全文（V66 对齐）**：HTTP read 路由此前漏接 fullTextFor，UI 读出来
  全是摘要卡、与 CLI 行为分叉。

## [0.6.0-alpha.6] — 2026-09-11

**R2（T2+T4）修复窗口。** R2 关键数字：中文召回 0/3→3/3（V65 实证）、中英去重 1 正确/0 误/0 漏、引用核验 112 条 0 hard、双课题合计 $0.11。

- **`--project` 收口到全部 CLI（V64 防线补全）**：R1 只修了 lit/idea/report；R2 零上下文
  实测当场抓到 exp 是盲区（用户全程带 --project 仍被全局指针出卖，实验记录写进并发
  会话的另一个项目）。现在 exp/lab/compute/conclusion/chem/proteins/reviewer 全部经
  `openProjectResolved` 单点解析，并立门禁：CLI 文件禁止裸调 `defaultProject()`。
- `report export --help` / `idea new --help` 不再真执行/掉进交互 REPL（V39 家族补全，
  与 lit 同款 switch 前拦截）。
- connector 上游返回空响应或非法 JSON 时给指明上游的可读错误（R2 撞上 bioRxiv 服务端
  故障期 HTTP 200+0 字节，此前报裸 SyntaxError）。
- T2 任务书更正：scanpy 平台不带内置示例数据集（任务书早先说法有误，数据集自备）。

## [0.6.0-alpha.5] — 2026-09-11

- **中文检索可用了（V65，V8 机制修复）**：AMiner 的 title 检索是词序列匹配，多概念
  查询整体扑空（R1 中文召回 0/3 的根源）。现在原查询 0 命中时自动按空格拆词、
  深池（≥20/词）检索、按命中词数合并，结果状态里如实标注「拆词合并」。实测 R1
  扑空的查询 0→8 条相关结果。残余限制如实写明：连写复合词（无空格）仍无法拆分
  （需要分词器）；检索时概念之间请用空格分隔。
- 源状态行 ok 时也显示 note（拆词等「结果怎么来的」说明不再被吞）。
- V73（AMiner 间歇 401）复核：12 并发 burst 无法复现，保持观察不编造修法。

## [0.6.0-alpha.4] — 2026-09-11

- **idea new / idea check 接任务句柄（V68）**：R1 实测进程被杀 100% 丢工作零痕迹，
  与 lit read/review 能力不对等。现在走同一套 runCliTask：快照落盘（lit tasks 可查）、
  失败时原始错误原因透出。交互式 idea new 刻意不包。

## [0.6.0-alpha.3] — 2026-09-11

**精读卡真的读全文了（V66）。** R1 实测 10/10 张卡全是摘要级推理——PDF 下载了但
从未被抽取喂给模型。现在：有 PDF 的论文精读时经 pypdf 抽全文（40k 字符截断）注入
prompt；每张卡的 record 元数据带 `basis: fulltext|abstract`（降级时含原因），CLI 输出
逐卡显示「基于全文/仅摘要」——名不副实从此可审计。pypdf 是可选依赖：缺了整体优雅
降级回摘要模式，行为与从前一致。

## [0.6.0-alpha.2] — 2026-09-11

**B2 第 1 轮（零上下文双课题实测）后的 P0 修复。** 轮次汇总见规划目录 R1/SUMMARY.md；
全部发现登记 BACKLOG V64–V74。

### 修复

- **并发会话项目污染的最小防线（V64）**：`lit` / `idea` / `report` 全部子命令支持
  `--project <slug>` 显式指定项目。全局 currentProject 指针无锁，两个并发会话会互相
  改写对方的落库目标（R1 双向实锤）；显式 flag 让并发使用可靠，指针加锁另行立项。
- **`lit add` 不再让不可解析的标识符去撞库（S1 形状补全）**：unknown 形态此前整体绕过
  S1 的 shape 门禁——R1 实测 AMiner 内部 id 被透传、静默匹配到无关论文并报 ✅。
  现在「没有任何源能按 id 取数」的标识符前置拒绝、零查询；AMiner 24 位 id 被识别为
  独立形态并给检索绕行指引（getPaper 接入取数管线另行排期）。
- 测试隔离：sub_agent legacy 断言不再读真实用户 config（用户设过 defaultModel 会假红，V74）。

## [0.6.0-alpha.1] — 2026-09-11

**v0.6 第一个内部基线：闸门 G（模型配置化 / 预算闸 / 发行面）+ W6-1 三 lane
（connector 台账 / 工作台四面板 / CLI 清扫）。**

### 新增

- **模型配置化（G-1）**：`z-ai/glm-5.3-flash` 进 openrouter 路由与定价表（实效价含
  5.5% 手续费，保守估计）；CLI 模型解析链 `--model` flag > 注入 > config `defaultModel`
  > 内部默认——此前 CLI 是三个入口里唯一不读 `defaultModel` 的（V40「只写不读」形状
  第 8 例）。新门禁 `config_reader_parity`：可写配置项必须登记读者且读者真有调用点。
- **轮级用量台账与预算闸（G-3）**：每次 LLM 调用落 `usage.jsonl`（按项目、跨进程累计）；
  `lit read/review`、`idea new/check` 支持 `--budget-usd N`——已知花费下界达上限即拒绝
  后续调用（kind=`budget`，请求不发出、已完成产出保留、消息给下一步）。成本未知**绝不
  当 0**：unknown>0 时 `usage` 命令明说总花费报不出。新命令 `spark-research usage`。
- **connector 调用台账（W6-1 α）**：base 层单点埋点，全部 connector 的每次 HTTP 调用落
  `api_calls.jsonl`（只记 host 绝不记 URL，防 query 里的凭据；有源码级门禁）。
  `usage api` 子命令与 `GET /api/usage`、`GET /api/usage/api` 两个只读端点。
- **工作台四面板（W6-1 β）**：长任务进度（落盘快照、刷新仍在）、record/证据图浏览、
  算力只读（**无任何派发入口**——V47 裁定的 UI 面兑现，面板内说明「派发与审批仅 CLI」）、
  用量面板（只消费后端数字，前端零成本算术）。
- **发行面（G-2）**：前端构建产物内嵌进单二进制——`npx`/二进制起 `server` 打开即是
  工作台（V43① 关闭）；npm 打包字段补齐（`files`/`engines`/`prepublishOnly`，V29）；
  首个 GitHub Actions CI（单测 + 二进制冒烟，V28）。
- `lit read --all` 默认跳过已有精读卡的论文（断点重跑不重复花钱），`--redo` 强制全读。

### 修复

- **Linux 单二进制技能索引恒为空**：`existsSync("/$bunfs/…")` 的语义平台相关（macOS
  假 → 内嵌兜底生效；Linux 真 → 枚举拿不到技能 → 平静地报 0 个）。判据改为显式
  `/$bunfs` 前缀。首个 Linux CI 冒烟实测抓到——正是 V28 想抓的「本机绿 ≠ 产物绿」。
- bioRxiv「search 不是真检索」的 caveat 现在显示在 `lit sources` / `lit search` 两个
  人类入口（V54）；标题/摘要的 HTML 实体解码。
- 未知命令回显打错的词；`report export` 携带湿实验 unconsumedWarnings、observation
  表格不再压成一行（V56）。
- AMiner `getPaper` 详情接口带真实 key 实测验证通过（V9）。

### Changed

- **算力任务的 rev 跳变收窄（BACKLOG V50，行为变更）**：`compute dispatch` 内部
  `resource_start → resource_active → start → run` 四步状态机转换原来分两次落盘，
  中间没有真正的异步边界，纯粹是写法副作用，会让用户看到的 `rev` 无解释地多跳一格。
  现在这四步在真正调用执行后端之前合并成一次落盘。`rev` 仍是同一个字段、仍然是
  每次 `job_store.patch()` 调用 +1 的写计数（CAS 语义不变），这次改动只减少了单次
  `dispatch` 内部触发的 `patch()` 调用次数，让跳变的格数更接近「真的发生了几次状态
  变化」。**未做到的部分**：`compute list/status` 展示的 rev 与 CAS 用的仍是同一个
  内部写计数字段——没有做「用户可见 rev 与内部写计数」的字段级分离，因为该分离会
  牵动 `backend/src/compute/approval.ts`（CAS 依赖 `job.rev` 每次写都变）与
  `backend/src/compute/cli.ts`（展示层）两个不在本 lane 文件所有权内的文件，且会
  破坏 `tests/unit/compute_job_store.test.ts` 里「patch 每次 rev+1」的既有断言。

---

## [0.5.0] — 2026-09-11

**把「远端算力」从一个假实现变成一条真链路，并把三次外部验收补齐。**

v0.4 补的是运行时与生态。v0.5 做四件：远端算力的作业生命周期与审批链、
单二进制从「只有浅层命令可用」变成真的能用、外部 MCP 工具真正接进 agent 运行时、
以及**三次零上下文外部验收全部跑完**（v0.4 方案要求三次、一次没跑，这是当时如实记下的欠账）。

分闸门 F + 三个波次并行开发（W5-1 七条 lane · W5-2 四条 · W5-3 四条），
单元测试 **1403 → 2035**，pytest **48 → 73**，e2e 14 → 15。

### ⚠️ 发布时如实说明的九件事

1. **Modal 远端算力只有契约，没有真实链路。** 本版本交付了 adapter 契约、录制层与假
   gateway，**真实 `ModalGateway`（Modal SDK 客户端）尚未实现——填了 token 也跑不起来**。
   `doctor` 与 `compute targets` 会如实报 `unavailable` 并说明原因，不会报「只差一把钥匙」。
   准确的说法是：**算力抽象层与审批链已落地并有 `local` 实现；Modal adapter 的契约已立、
   真实链路未验证**。SSH 是明确的占位槽位。
2. **local 算力的 SIGKILL 恢复路径今天走不通**（BACKLOG V48）。adapter handle 在执行期间
   不落盘，编排进程中途被杀就既接不回也收不了。设计里写的「SIGKILL → resume → 收割」
   这条验收路径在 local 上**不成立**。
3. **湿实验安全门仍是部分覆盖**（V25，边界写在 README）。`concentration_limit` /
   `biosafety` 从「恒空转」变成真消费，但只吃「浓度/BSL 与目标试剂或步骤**同句**出现」；
   跨句写法（最常见的那种）编译器**拒绝猜归属**、仍落未消费告警。
   **对接真实 Opentrons 的门槛不因此解除。**
4. **单二进制仍有两处不可用**（V43）：`server` 起得来但没有前端产物；
   `new skill|connector|platform` 与 `ext verify --kind platform` 已改成**显式拒绝**
   （而不是静默做错），只在源码 checkout 可用。
5. **`deterministic=true` 的口径待裁定**（V49）：三个新平台同机重跑逐字节一致，
   但**不保证跨机器 / 跨 BLAS / 换求解器**。
6. **湿实验的自然语言解析只吃中文**（V55）。试剂词表是双语的，但上游步骤解析器不是，
   英文协议编译不出任何步骤（会直接报错，不会静默产出空协议）。
7. **浓度限值表的单位未声明**（V52）。表里三个数没说是 % 还是 mol/L，
   `strong_acid` 的 200 在百分比语境下没有意义；次氯酸钠阈值 100% 意味着这条规则
   只拦物理上不可能的浓度（商用漂白水是 5–15%）。**这要请领域判断，不该由实现者拍。**
8. **安全门仍有明确缺口**（V59，发布前最后一次验收挖出、本版未修）：限值表只覆盖 4 类试剂
   且多数阈值就是 100%（**所以 `100% 硫酸 → ✅` 只表示「没超物理极限」，不表示「在安全限值内」**）；
   `biosafety` 只认字面 `BSL-n`，`P3 实验室` 这种写法静默通过；`chemical_compatibility` 不看孔位。
   **这些都不改变一条：本项目这一版不对接真实 Opentrons。**
9. **bioRxiv 的 `search` 不是真正的全文检索**（V54）。上游没有检索端点，connector 用
   「最近 N 篇 + 客户端关键词打分」模拟——**查不到 ≠ 不存在**。它在默认源集合里，
   README 已写明，但 `lit sources` / `lit search` 两个 CLI 入口目前**还不显示这条 caveat**。

### 新增

**远端算力（主线 C1）**
- `spark-research compute`：`plan / approve / reject / run / status / list / collect /
  cancel / release / recover / targets` 的完整作业生命周期。
- **审批语义做进状态机本体**：`dispatch` 只有两条入边——`approved`（携带 digest 相符的
  未消费 approval）或 `planned`（仅当 `approvalRequired === false`，而这是派生值）。
  broker 没有 `force` 参数，**「无审批派发」在结构上没有落脚点，所以不需要测试后门**。
- **审批门按后果开**：计费 / 联网 / 用密钥三者任一成立才要人点头；都不成立
  （典型是 `local` + `network=none` + 无 secret）直接可跑，**plan 的输出会说明免审批的原因**。
- CLI 审批要求真实 TTY（AD-9），非交互环境默认拒绝；`compute_approve` / `compute_run` /
  `compute_release` **一律不暴露为 MCP 工具**（AD-14），HTTP 面也没有派发端点。
- **算力产出进证据图**：一条 `observation`（`kind=compute_output`, `evidence=computed`,
  `runId=jobId`）+ harvest 文件各一条 artifact record + `derives_from` 边。
  这一步让「基于一次算力运行写出能通过评审的结论」真的走得通。

**单二进制**
- 10 处资产真正嵌进二进制（3 处 `schema.sql` 静态 import · 4 处 `.py` 内嵌文本 +
  运行期解包再 spawn · 3 处 prompt `.txt`），外加 3 处危险默认路径。
  `project new` / `lit search --add` / `doctor` / `exp run --platform pyref` 在干净目录全部可用。
- **`workspaceRoot` 不再解析到文件系统根**（V33）。原默认值在编译产物里等于 `/workspaces`，
  紧接着就是 `mkdirSync(..., {recursive:true})`——**这不是读不到文件，是往根目录写**。
- 技能索引不再为空：二进制里 `capabilities --json` 从「技能 0 个」修到 10 个（现 13 个）。

**外部 MCP 接进 agent 运行时**
- 完整生命周期：发现已装且已 `--trust` 的扩展 → 连接子进程 → 注册 → 绑定 `recordSink` →
  收尾 → **逐扩展失败隔离（一个坏扩展不许拖垮整轮）**。
- 每次外部工具调用落一条 `observation`（四个分支：成功/失败/超时/未知工具都落），
  **并被排除出证据图**——外部调用是审计不是进展，算进证据会让停止条件失效。
- 外部工具的 spec 进模型可见的 tools 列表（同样过 grants 白名单）。
  **没装外部扩展的用户行为与 v0.4 逐字节一致。**

**仿真平台三件套** scanpy（`sc-cluster`）· pydeseq2（`bulk-de`）· cobrapy（`fba`）。
科学判据不是「跑完没报错」：cobrapy 的 nuoA 敲除掉到厌氧那个值（两条独立路径同一个数）、
pydeseq2 全部 30 个 spike-in 方向正确且噪声假阳性 1.5%、scanpy 三组 marker 纯度 100%。

**文献与可用性**
- 默认检索源 4 → 6（补上已实装的 arxiv / pubmed），并加**对等门禁**：
  已实装且无需 key 的源必须在默认集里，或在排除表里带理由。
- CLI 长任务可见性：`lit read --all` / `lit review` 走任务句柄，
  **开跑第一行就给句柄与重连命令**，新增 `lit tasks` 断开后查状态。
- 证据图可见性：`report records` / `report show`（含入边出边）。
- 化学结构图：`chem depict`（SMILES → 2D SVG，落 artifact + record）。
- connector +4：clinvar · biorxiv · reactome · string-db；**限速器按 host 合池**
  （不按 connector——四个 connector 各自为政会集体被 429）。
- `auth` 与 `config list` / `doctor` 口径统一（V37），并加断言禁止手写 provider 表复发。

### 💥 破坏性变更

- **删除 `connectors/base.ts` 的三个 deprecated 别名** `MCPConnector` /
  `MCPConnectorConfig` / `MCPTool`（V15）。废弃周期已随 v0.4.0 走完，全仓库确认零活引用后
  直接删除。**外部扩展请改用 `Connector` / `ConnectorConfig` / `ConnectorTool`**——
  只是改名，形状完全一致。
- **删除 `compute` 技能**。它从 v0.1 起就是假的：`ComputeService` / `DefaultCompute`
  返回写死的成功结果，从不真的提交作业。同批清掉两个同族假实现（`query_frames` 永远返回
  空 frames、`analytic_libraries` 零调用方）。**在真算力落地前，声称能力比没有能力更糟。**
- **词面新颖性阈值 `HIGH_AFFINITY` 0.75 → 0.70**。原值是在 **2 条样本**上定的；
  新值依据 68 条真实样本（错分 2 → 1，假阴清零）。方向是安全的那边：
  阈值降低 → 更多「novel」被降级为 existing。**并加了门禁**：在同一份语料上用生产函数
  重扫阈值，断言生产值落在最优区间内——**它不再是一个魔数**。

### 修复

- **湿实验编译器不再改写试剂身份**（发布前外部验收的头号 blocker）。写「硫酸」，
  编译产物曾经是「**盐酸**」——`extractReagents()` 用组内第一个关键词替换掉用户实际写的名字。
  **这不是显示瑕疵，是落在物理世界路径上的身份改写**：人在 `lab approve` 读的是协议原文（硫酸）、
  批准的是编译产物的 hash（盐酸）——**他批的不是他读的那个东西**，AD-6 的署名审批失去意义；
  审计记录里还会出现方案中根本不存在的化学品。
- **`concentration_limit` 不再把「查不到规则」渲染成「✅ 通过」**（同一次验收的第二个 blocker）。
  限值表里没有条目的试剂，阈值曾被当成无穷大、一律放行。验收者一句话点破性质：
  **「『我查了，没有针对这个试剂的规则』和『我查了，通过了』在输出里是同一个符号」**
  ——这是本项目红线「没查到 ≠ 查了没有」的镜像违反，而且落在**安全门**上。
  现在它拦下来并说明理由是「没有规则可查」而不是「超标」，**一个阈值都没有编造**；
  另加一条与限值表无关的判断：**浓度百分比 > 100 物理上不存在，一律拦**。
  顺带修好更深的一层：浓度解析器原来**把单位丢了**，`%` 与 `mol/L` 都只返回裸数字，
  **规则在比较自己不知道单位的数**（单位口径本身待定，见 BACKLOG V52）。
- **湿实验安全门不再跨单位比大小**（发布前窄范围验收）。`200mmol/L 乙醇`（0.2 M，实验室最普通
  的东西）曾被拦下并报「over-limit 乙醇 (200)」——规则把单位剥掉，拿裸数字去撞百分比限值表。
  **最恶劣的不是拦，是理由撒谎**：说「超标」，真相是「我把 mmol/L 读成了 %」。
  现在非百分比口径一律走未消费告警，并**说出这一次真正的原因**（原消息枚举的两个原因
  在实测场景里一个都不成立）。`g/L` / `mg/L` / `ppm` / 稀释比此前**连告警都没有**，现已纳入。
- **两种未识别试剂不再被塌缩到同一个 reservoir 孔**。词表外试剂曾一律叫 `reagent`，
  而孔位是按名字分配的——**编译产物会指示机器人从同一个孔取两次液**。这已经不是显示问题。
  占位符现按步骤唯一化，并补了未消费告警（身份仍未保留，见 BACKLOG V60）。
- **`chem depict` 在单二进制里真的能用了**。它此前报 `can't open file '/$bunfs/root/depict.py'`，
  而 `--help` / `capabilities` / MCP / `llms.txt` **四处都声称它可用**——
  按本项目的价值观，「声称有、实际用不了」比没有更糟。
- **`lit add` 不再把一种标识符形态降级成另一种去撞库**。`lit add 9999.99999`
  （不存在的 arXiv id）曾导入一篇 1978 年的无关论文并**报 ✅、退出码 0**——
  **不是「没查到」被报成「查了没有」，而是「没查到」被报成「查到了，给你另一篇」**。
  垃圾论文会落进证据图、被精读卡花真钱处理、并列进报告参考文献，而「引用必须在库内」
  的核验会**全部放行**。
- **未知 task kind 不再被静默吞掉**：原先的 `default` 失败分支是**看起来存在、实际不可达
  的守卫**（上游已把非法 kind 过滤掉了）。
- **`defaultProvider` 从只写不读变成真的生效**：`auth` 让用户挑、落盘、回显，
  但没有任何代码用它选 provider——用户选了 kimi，只要 openrouter 的 key 也在就走 openrouter。
- `doctor` 补上算力段；`chem` 补进主帮助；`compute plan` 打印目标项目
  （**证据静默落进错误项目而用户收不到信号**是信任损伤）；`project new` 明说不自动切换当前项目。
- BibTeX 的「Last F」作者名解析（连带修好 `dedupe.ts` 的跨源姓氏比对）；
  `lit review --help` 不再直接执行；`report export` 的证据索引不再是不加说明的空表。

## [0.4.0] — 2026-09-10

**把「agent」这两个字变成真的。** v0.3 还清了并发与超时的债，v0.4 补运行时与生态这条最短的板：
子代理真的会用工具、任务完成由证据图判定、模型中立从声称变成事实、扩展从「改仓库源码」
变成「写一个 manifest 并过契约测试」。

分五个波次并行开发（P11 + W1–W4，共 20 条 lane），单元测试 **905 → 1396**。

### ⚠️ 发布时如实说明的三件事

1. **单二进制只有浅层命令可用**（BACKLOG V27）。`bun build --compile` 不嵌入 `.sql` / `.py`
   资产，`project new` 直接 `ENOENT: /$bunfs/root/schema.sql`。三条安装路径**都需要预装 Bun**
   （代码用 `bun:sqlite` 等，node 跑不起来），npm 包只是换个装法。见 `docs/INSTALL.md`。
2. **外部 MCP 工具调用的记录没进证据图**（V31/V32）。审计记录有了（四个分支都落，
   对照钉死），但写在 `extensions/<name>/.mcp_calls.jsonl`——「外部工具调用天然进 provenance」
   这个相对 OpenScience 的差异化点**只兑现了一半**。
3. **湿实验安全门的两条规则仍在主管线上空转**（V25，v0.3 起未变）。
   `concentration_limit` / `biosafety` 所需字段编译器从不产生，兜底是 `unconsumedWarnings`
   强制告警。**对接物理设备的硬前置仍未满足。**

### 新增

**Agent Runtime（主线 A）**
- **`AgentToolBus`**：授权 / 预算 / 审计三层，套在 P9 已有的进程内工具总线外，与 30 个 MCP 工具同源。
  **AD-14 红线**：`MCP_WITHHELD` 的五个危险动作在 ToolBus 层硬拒，**子代理永远不能自批准**
  （实测：把五个全塞进 grants 仍全部 denied，且它们不出现在给模型的工具清单里）
- **真子代理 tool loop**：`SubAgentSpec`（每类独立模型 / grants / 预算 / readOnly）+ 真实工具调用循环。
  `stopReason` 如实回流——**预算耗尽 ≠ 完成**。不支持 tool calling 的模型走显式降级路径
- **Research Contract（AD-10）**：**完成判定由确定性代码对证据图查询得出，不由模型自报**。
  `check(q: EvidenceQuery)` 的签名根本没有入口接收「模型怎么说」，`EvidenceQuery` 的类型是
  `Pick<RecordStore, "list"|"get"|"edgesOf">`——写图在类型层不可能。
  **两个参照系（Claude Science / OpenScience）都没有等价物**
- **replan 循环**：观察结构化回流（不再是 200 字符截断）+ 三条并行停机条件
  （`allDone` / `noProgress` / `budget`）
- **`agent_run` 帧级记账**（第 9 类 record）：model / provider / systemHash / promptHash /
  usage / toolCalls / stopReason，落进证据图 → report / lineage / UI 时间线免费获得。
  同时补上 OpenScience 的 harness 指纹缺口
- **findings 状态机**：`open → addressed → resolved → reflagged` + 复核闭环 + CLI
  `review findings --open`（Claude Science 的 `host.findings()` 等价物）
- **删除 `swarm`**（330 行，v0.1 遗留、生产零调用方、评审判定虚标）

**模型中立（P11）**
- 实装 provider **由 2 个增至 6 个**（openrouter / kimi / anthropic / openai / deepseek / qwen）
  **+ 任意 OpenAI 兼容本地端点**。v0.3.1 实测缺口是「声明 6 个、`call()` 里只有 2 个」
- **tool calling · 流式 · JSON 模式 · token 用量与成本核算**（单价表每条附来源与核实日期）
- **provider 能力位进 `capabilities --json`**——外部 agent 选模型**之前**就知道能不能跑 tool loop

**扩展性（主线 C）**
- **扩展装载三强度**：声明式 connector manifest（不执行代码 + SSRF 白名单）/ TS 扩展（`--trust` + 指纹）
  / **外部 MCP client**
- **`ext verify`（AD-11）**：扩展「能装上」不算装好，**过得了对应契约测试**才算。
  connector 复用 100 并发参数映射不变式，platform 直接复用 P5 的契约测试套件
- **arXiv / PubMed 接入**（BACKLOG V1）——XML 解析走 TS 扩展

**上手性（主线 B）**
- `init` 向导 · **`demo` 离线示例（零网络零 key）** · `doctor` 环境诊断 · 依赖三档分层
- **SSE 流式**：`delta` 是**权威答案本身**的增量
- 长任务句柄落盘（V11）· MCP 进度回传（V17）· probe 缓存带 venv 失效判据（V18）

**可信度基建**
- **技能可达性门禁**：每个技能必须至少有一条可达入口（CLI / HTTP / MCP），登记表逐条去三处真源对账
- **存储层写入方门禁**：新建的存储层必须有生产写入方——补孤儿检测的文件粒度盲区
- **版本号单一真源断言** · **审批要求可交互终端（V19）**：`isTTY` 是内核层属性，
  piping 一个 `yes` 进 stdin 绕不过去；CI 旁路默认拒绝，需 token + reason 且折进 decision record

### 变更

- **`LlmResponse` 改为可辨识联合（AD-13）**：`ok:false` 分支 `content` 是字面量 `""`、`error` 必填。
  「失败但带内容」与「失败但没说原因」在编译期都不可能
- 失败类型机器可读（`error.kind`），调用方区分失败不再需要读文案
- 湿实验 `unconsumedWarnings` 接进 Web 审批弹窗（此前只有 CLI）
- `protein-analysis` 补齐 CLI / HTTP / MCP 三个入口——此前 `capabilities` 带 `triggers`
  对外广播它，却没有任何调用路径

### 修复

- **`mergeAuthors` 按下标配对 affiliation**（跨源作者顺序不同时张冠李戴）
- **citation judge 降本**：按 `(key, sentence hash)` 去重 + 并发限流 + `response_format: json_object`
- S2「无 key 自动降级」承诺兑现（此前每次白撞 429）；CJK bibtex key 保 Unicode
- orchestrator 四处读 `res.content` 当诊断——AD-13 之后恒为 `""`，**那四条日志从 P11 起一直是空的**
- 循环模块初始化链导致真实 CLI 启动崩溃（单测测不出，靠 `cli_entry.test.ts` 的真实进程冒烟抓到）

### 测试

单元 **905 → 1396**（0 fail / 0 skip）· e2e 13 → **14** · concurrency + timeout 12 ·
pytest 48 · `test:lab` 26。

**两处「写下来之后从未跑过」的验证**（本版首次执行）：真实网络录制 `tests/integration/` 8 个用例
——**上游零 schema 漂移**；v0.2.x 老 `records.db` 迁移演练——**无 bug**。

---

<details>
<summary>v0.4.0 的分阶段明细（P11 · LLM Runtime v2 + 可达性闸门）</summary>

### P11 · LLM Runtime v2 + 可达性闸门

**模型中立从声称变成事实。** v0.3.1 实测：`SUPPORTED_PROVIDERS` 声明 6 个 provider，
`call()` 里只有 kimi / openrouter 两个能真发请求，其余静默落到 OpenRouter 或失败。

#### 新增

- **provider 适配层**：`ProviderAdapter` 契约 + 两个实现——
  `openai_compat`（一套代码覆盖 openai / kimi / deepseek / qwen / openrouter /
  ollama / vLLM / 任意自建 baseUrl）与 `anthropic`（原生 Messages API，与 OpenAI 形状差七处）。
  **实装 provider 由 2 个增至 6 个 + 任意本地端点。**
- **tool calling**（P12 真子代理的前提）· **流式**（`onDelta`，P14 的 SSE 流接它）·
  **JSON 模式**（`response_format`，根治 BACKLOG V12）· **token 用量与成本核算**
- **`BudgetLedger`**：调用数 / token / 成本上限，供 P12 子代理与 P13 帧级账本使用
- **单价表**（`providers/registry.ts`）：各 provider/model 输入输出单价，**每条附来源与核实日期**，
  可用 `SPARK_LLM_PRICING_JSON` 覆盖。查不到单价时 `costUsd` 保持 `null`，**绝不填 0 冒充免费**
- **provider 能力位进 `capabilities --json`**：`{id, models, configured, capabilities:{toolCalling,
  jsonMode, streaming, usageReported}}` + 独立的 `localEndpoint` 段。
  外部 agent 与 ToolBus 在**选模型之前**就能知道能不能跑 tool loop
- **`protein-analysis` 补齐三个生产入口**：CLI `spark-research protein <query>` ·
  `POST /api/proteins/analyze` · MCP 工具 `protein_analyze`（MCP 工具 29 → 30）。
  此前它有 SKILL.md、12 个 e2e、被 DESIGN 列为 10 技能之一，**却没有任何调用路径**，
  而 `capabilities` 照常带 `triggers` 对外广播它
- **技能可达性断言进门禁**（`narrative_parity.test.ts` 第 7 条）：每个技能必须至少有一条
  可达入口，登记表的每条都去 `index.ts` 的 `switch(cmd)` case 字面量 / `MCP_TOOLS` /
  `capabilities` 三处对账（不靠散文正则）
- 湿实验 `unconsumedWarnings` **接进 Web 审批弹窗**（此前只有 CLI 强制显示），配套 e2e ⑨b
- 配置项：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `QWEN_API_KEY` /
  `SPARK_LOCAL_LLM_BASE_URL` / `SPARK_LOCAL_LLM_API_KEY` / `llmPricingOverridesJson`
- `CallOptions.maxTokens`：Anthropic 的 `max_tokens` 是必填参数，此前硬编码 4096
  会让综述草稿这类长文本**静默截断**（只能从 `finishReason:"length"` 看出来）

#### 变更

- **`LlmResponse` 改为可辨识联合（AD-13）**：`ok:false` 分支的 `content` 是**字面量 `""`**、
  `error` **必填**。于是「失败但带内容」（内容被误当产出）与「失败但没说为什么」
  在编译期都不可能。调用方读失败原因请用 `error.message`，不要读 `content`
- 失败类型改为**机器可读**（`error.kind`：`auth` / `rate_limit` / `timeout` / `parse` /
  `upstream` / `unsupported`），调用方区分失败不再需要读文案
- `SUPPORTED_PROVIDERS`（模型名字典）与 `ADAPTERS`（真能发请求的清单）**显式分开**——
  v0.3.1 那个缺口的根因就是两者被混为一谈
- `providers/registry.ts` 的 `PROVIDER_API_KEY_ENV` 改为**从 router 的 ADAPTERS 派生**。
  它原本是手工副本，接线 anthropic 时立刻失同步、当场把一致性断言打红
- `index.ts` 的 `CONFIG_DIR` 改走 `dataDir()`，与 `config/index.ts` 归一解析（V20）
- 移除 `LlmResponse.mock`（v0.1 移除 mock 模式后的残留，零消费方）

#### 修复

- 五个域消费方（citation_judge / novelty / review / reading / coexplore）此前把
  `content` 当错误信息读。AD-13 清空 content 后，若不迁移它们的排障信息会**变成一片空白**
  ——测试全绿但诊断没了。已全部迁到 `error?.message`

#### 测试

单元 905 → **1018**（0 fail / 0 skip）· e2e 12 → **13** · concurrency + timeout 12 ·
pytest 48 · `test:lab` 26。

</details>

---

## [0.3.1] — 2026-09-10

### 修复

- **Web 工作台里湿实验批准后无法执行（v0.3.0 引入的回归）**：v0.3.0 把 `wet_run` 拆成
  `approved` / `executing`，但工作台底部实验面板的「执行（模拟器）」按钮仍按
  `state === "wet_run"` 判断是否可用——该状态已不存在，于是**按钮永远是灰的**，
  用户可以在 UI 里批准却永远执行不了，湿实验闭环在 Web 上断掉（CLI / HTTP / MCP 不受影响）。
  状态徽章色表同样缺 `approved` / `executing` 两个键。
- 执行按钮在 `executing` 态下的提示改为「已在执行中（执行权已被原子声明，approval 已消费）」，
  与 D-10 的一次性 approval 语义对齐。

### 新增

- **叙事一致性门禁扩到前端消费方**（`tests/unit/narrative_parity.test.ts`）：
  ① 已退役的状态名不许出现在任何源码里（后端 + 前端）；
  ② 前端 badge 色表的键必须真实存在于后端两套状态机，非状态键走显式白名单。
  阴性对照已验证：把前端改回 `"wet_run"` 会红。

### 教训

v0.3.0 的这个回归**有现成的 e2e 用例能抓到**（`workbench.spec.ts` ⑧「批准后落 decision record
并可执行」），发布前没跑而已——不是测试缺失，是流程缺失。原因是 v0.3.0 的验证清单里
只有 `bun test` / pytest / typecheck，漏了 `bun run test:e2e`；而 typecheck 抓不到它，
因为那是字符串比较不是枚举。**跨层改动（后端词汇表变更）必须跑前端 e2e。**

---

## [0.3.0] — 2026-09-10

**闸门 D：把「单线程测试永远测不出」的那批债一次还清。**

外部评审（对象 `b4aab02`，全量源码精读 + 本机复现）给出两条裂缝：一条是叙事超前于实现，
一条是并发与超时等工程基本功缺口。本版消化后者的全部，并为前者装上 CI 门禁。
**本版不含任何新功能**——评审列出的 Agent 层重做（真子代理 / contract / 扩展机制）顺延 v0.4.0，
路线见 `docs/DEVELOPMENT_PLAN_v0.3.md`。

### ⚠️ 破坏性变更

- **湿实验状态 `wet_run` 已移除**，拆成 `approved`（已批准待执行）/ `executing`（执行中）。
  读取实验 `state` 字符串的外部集成需要同步。
- **`GET /api/lab/machine` 响应形状变化**：`approvalGate.to` 由 `"wet_run"` 改为 `"approved"`；
  新增 `executionGate`（`approved → executing`，`consumesApproval: true`）。
- **写请求（POST/PUT/PATCH/DELETE）现在强制 `Content-Type: application/json`**，否则 415。
- **带 Origin 头的跨站写请求被拒**（403）。本地回环任意端口恒放行；
  无 Origin 的调用方（CLI / MCP 进程内 / curl）不受影响。可用 `originAllowlist` 扩展白名单。
- **approval 一次性消费**：执行权一旦被声明即消费 approval，**重跑必须重新审批**，
  进程崩溃重启后也不例外（此前 approval 跨崩溃存活，可免审批整体重跑）。

### 修复

- **P0 并发竞态**：`HttpConnector.call()` 曾用跨请求共享的单值实例字段 `__handlingTool`
  判定 handler 重入，并发下会被彼此的状态污染，导致参数映射与 AMiner 凭据检查被**静默跳过**、
  退化成零参数通用直通。CLI / ServerContext 每次新建 registry 天然不共享该字段——
  这就是 824 个既有单测测不出它的原因。改为构造期一次性写入、运行期只读的 handlers 表，
  全程不写任何跨请求可变实例状态。**「同名方法即 handler」这个魔法分发契约同时废除**
  （脚手架模板与 `EXTENDING.md` 已同步改为显式 `this.handle(toolName, fn)` 注册）。
- **全链路超时**：`http/client.ts` 的裸 `fetch`、LLM 调用、`PythonKernel.execute`、
  server 长任务此前全部无超时——任一上游挂起即永久卡死。四层各加显式超时，
  默认值收进 config 注册表（`httpTimeoutMs` 30s / `llmTimeoutMs` 120s /
  `kernelTimeoutMs` 120s / `taskTimeoutMs` 600s），优先级 env > config.json > 默认。
- **Python kernel 死锁**：stderr 管道从不排空，长会话写满 64KB 缓冲后 kernel 永久卡死。
- **LLM 失败被静默当成功**：orchestrator 四处 `llm.call()` 都不检查 `res.ok`，
  没配 key 时整条链路「成功」地把错误文本当产出、review 照样放行。四处全部改为走失败路径，
  且错误文本不再进入用户可见的 summary。
- **`kernelManager.dispose()` 摧毁全部内核**：并发会话里先结束的会杀掉另一个正在执行的 kernel。
  改为按 id 销毁。
- **`config.json` 以 0644 存放 LLM API key**：系统里最值钱的密钥，保护弱于 connector 凭据（0600）。
  改为目录 0700 / 文件 0600 + 显式 `chmod`，并在每次 `loadConfig()` 时自愈收紧。
- **状态机无乐观并发控制**：并发执行同一份已获批协议会双双通过三道门 →
  **同一协议被执行两次**。records 加 `rev` 列做 CAS，执行权原子声明，冲突返回 409 语义。
- **`bun run test:py` 从未在干净环境跑通**（脚本写的是 `python` 而非 venv 解释器，
  直接 `command not found`）；**`bun run test:lab` 是空转**（`tests/lab/` 下只有 `.test.py`，
  `bun test` 一个都跑不到）。两条都已修——后者原本 0 个用例，现在 26 个。

### 变更

- **安全门声明收敛（口径诚实化）**：此前宣称「4 条独立规则」，实测只有 `volume_capacity`
  在自然语言主管线上全程可信；`chemical_compatibility` 词表已扩到中英文与常见分子式但仍有限；
  **`concentration_limit` / `biosafety` 在主管线上恒空转**（编译器从不产生它们所需的字段）。
  README 与 DESIGN 现在如实写明真实覆盖范围。新增 `unconsumedWarnings`：
  协议里出现却未被任何规则消费的量纲/试剂/条件会产出显式告警，CLI 编译与审批输出必须显示——
  **「用户写了但安全门没看见」的内容绝不静默绿灯**。对接物理设备的硬前置见 BACKLOG V6/V25。
- `record` 新增完整性哈希：绕过状态机直接改 `state` / `approval` 变得可检测。

### 新增

- **叙事一致性门禁（AD-12）** `tests/unit/narrative_parity.test.ts`：
  ① 孤儿模块检测（生产代码零引用者必须在册并写清理由，白名单只许缩短）；
  ② 文档数量声称与运行期真源对撞；
  ③ **自描述端点必须能从真源推导**——`/api/lab/machine` 的两道门由转移表算出来比对。
  第三条在本版就抓到一个真 bug：状态拆分后该端点仍自称 `to: "wet_run"`，
  AD-6 的机器可读表达对外撒谎而全部测试皆绿。
  门禁同时登记了两处**已知缺口**：`swarm.ts`（v0.1 遗留、零调用方，v0.4 P12 删除）与
  `proteins/analysis.ts`（protein-analysis 技能有 e2e 却无任何生产入口，BACKLOG V22）。
- **两个新测试维度**：`tests/concurrency/`（共享 connector 100 并发参数映射不变式、
  N=30 并发执行同一份已批协议恰好 1 次成功、两 session kernel 互不摧毁）与
  `tests/timeout/`（注入永不响应的上游，断言四个入口都在可控时间内返回可见超时错误）。
- 配置项：`originAllowlist`、`httpTimeoutMs`、`llmTimeoutMs`、`kernelTimeoutMs`、`taskTimeoutMs`。

### 测试

单元 824 → 904（`bun test tests/unit/`，0 fail / 0 skip，含 venv 环境下的 OpenMM 契约测试）；
新增 `tests/concurrency/` 8 例 + `tests/timeout/` 4 例；pytest 48；`test:lab` 由 0 → 26。

---

## [0.2.1] — 2026-09-09

零上下文外部验收（一个对本仓库一无所知、被禁止读源码的 agent 只靠 MCP + llms.txt
跑完整链路，结果 8/10）暴露的三个问题，逐条修复。详见 devlog/P9-extensibility.md。

### 修复

- **长任务句柄的跨连接语义**：`task_status` / `exp_run` 此前笼统承诺「任务仍在后台跑」，
  但任务句柄存在 server 进程内存里，连接一断即失效。现在讲清边界，并分别给出干实验
  （磁盘有状态，`exp_list` + `resume` 接回）与文献类长任务（无 checkpoint，需重跑）的
  处置方式；`task not found` 的 404 也带上原因与下一步，而不只是说「不存在」
- **批量精读的增量语义**：`lit_read_cards(all=true)` 默认跳过已有精读卡的论文，避免超时
  重跑时把已读的重烧一遍模型调用；新增 `redoRead` 强制重生成；全部已读时明确报错而非静默空跑
- **`ideaId` 命名一致性**：`idea_coexplore` 返回体新增顶层 `ideaId` 别名（`stored.recordId`
  保留不变），与 `idea_novelty_check` 的参数名对齐

### 测试

833 单元测试（824 → 833，新增 9 条钉住上述三处 + 一条护栏断言：修描述不得碰坏 AD-9 的
五个扣留工具）· pytest 48 · Playwright 12

---

## [0.2.0] — 2026-09-09

从「科学 Agent 平台」重新定位为**面向科研人群的开源科研工作台**：项目成为持久层的根，
五大功能域（文献 / 实验 / 记录 / 创新性 / 评审）围绕一张可审计的证据图组织。

### 新增

**P1 · Project 基座**
- `spark-research project new|list|open|archive`；数据布局 `~/.spark-research/projects/<slug>/`
- Research Record 存储 `records.db`：8 类 record（idea / decision / experiment / observation /
  reading / conclusion / paper / artifact）+ 5 类边（supports / contradicts / derives_from /
  cites / supersedes），与 artifact 表 id 互链（AD-3）
- 凭据服务 `CredentialStore`：`credentials.json` 0600，**只在 daemon 进程内**；
  kernel 走 permit set 代访问，值本体不出 daemon（AD-2）

**P2 · 文献检索与文献库**
- 文献源扩到 9 个：OpenAlex / CrossRef / EuropePMC / Semantic Scholar / PubMed / arXiv /
  AMiner（走凭据服务）/ CNKI / 万方（后两个是占位，无公开 API）
- 跨源并发检索 + DOI/标题去重 + 归一化；项目文献库 `library.db`（标签 / 笔记 / 阅读状态）
- OA PDF 下载管线（arXiv / EuropePMC）+ checksum；BibTeX / CSL-JSON 导出
- `spark-research lit search|add|list|pdf|export|sources`
- 技能：literature-search、paper-download、library-curation

**P3 · 综述与引用核验**
- 结构化精读卡 pipeline（schema 校验是硬门，不合格不落半成品 record）
- 综述草稿生成：引用白名单双保险（prompt 层 + 生成后校验）
- Reviewer 检查器 `citation-integrity`：库外 key = hard veto；与精读卡冲突 = soft；
  强断言无引用 = soft；判定器故障 = 可见的 soft（不静默当「通过」）
- `spark-research lit read|review`；技能：literature-review

**P4 · Co-explore 与 Novelty check**
- 批判性共探会话 → Idea 卡（观点必须带库内来源或显式标 inferred）
- Novelty pipeline：claim 提取 → 密集检索 → 对比报告 → **确定性评级校验层**
  （检索不到 ≠ 新颖；模型原判与校正后评级都留在产物里，AD-8）
- Idea 卡 novelty 状态：unchecked / checked-novel / checked-incremental / checked-overlap
- `spark-research idea new|list|check`；技能：idea-coexplore、novelty-check

**P5 · 干实验闭环**
- `SimulationPlatform` 契约（prepare / submit / poll / collect，AD-4）+ 两个参考实现：
  OpenMM 与 pyref（纯标准库，零依赖）；两者共用同一套契约测试
- 状态机 `design → dry_run → collect → analyze → concluded | iterated`，
  **状态真源在磁盘**：编排进程被 SIGKILL 后 `exp run --resume` 能接回来
- 能力位 `deterministic` 随 observation 落库，供报告与检查器区分对账口径
- `spark-research exp new|run|status|list|platforms`；技能：dry-experiment、protein-analysis

**P6 · 湿实验**
- Opentrons 官方模拟器（`opentrons_simulate`）成为默认湿实验后端，取代 mock
- 协议编译：自然语言 → Opentrons Flex Python Protocol API v2；
  平台上没有的硬件编译成 `[spark-note]` 人工步骤，**不假装执行过**
- 安全门 4 条独立纯函数规则（试剂兼容 / 浓度上限 / 生物安全等级 / 体积容量）
- **approve gate（AD-6）**：安全门通过只到 `awaiting_approval`；唯一进入执行的门是
  记名的 `approve()`，批的是协议 hash，协议一改批准立刻作废
- 能力位 `simulated` 随 observation 落库
- `spark-research lab compile|approve|reject|simulate|status|backends`；技能：wet-protocol

**P7 · 前端工作台**
- HTTP API 层补齐 P1-P6 全部能力（域端点 + 长任务句柄 + SSE 生命周期事件）
- Web 工作台从 vanilla JS 换成 SolidJS + Vite（AD-7）：项目导航 / 会话流 / record 时间线 /
  证据子图（确定性环形布局）/ 干湿实验面板 / 明暗主题
- HTTP 层的 approve **不接受环境变量兜底**：缺 actor 直接 400，`actorSource` 记 `http:explicit`

**P8 · 功能收口**
- **结论卡 review 门槛（域 E2）**：review 状态 pending / approved / vetoed。
  判定规则不可协商——任一 hard finding → vetoed，零 hard → approved；每次评审落一条
  记名的 decision record。`spark-research conclusion list|show|review`
- **新增 3 个 Reviewer 检查器**：
  - `data-consistency`：结论引用的 observation 必须真实存在于执行记录
    （断链 / 跨项目 / 类型不对 = hard；无执行锚点 / 图上没连边 = soft）
  - `capability-labeling`：模拟读数没标注 = hard；在非确定性平台上声称逐位复现 = hard
  - `stats-plausibility`：**只出 soft** 的启发式提示（样本量过小 / 多重比较未校正 /
    p 值边缘 0.04–0.05 / 结论强度超过数据支撑）
- **研究报告导出（域 C2）**：证据图 → Markdown（问题 / 思路 / 实验 / 结论 / 待验证 +
  证据索引 + 参考文献）。正文由代码渲染不经过模型；结论区只收 approved 的卡。
  `spark-research report export|stats`、`GET /api/report[?format=markdown]`、工作台导出按钮
- 技能 research-report（第 10 个，凑齐设计里的技能目录）
- `scripts/demo-research-thread.ts`：一条完整研究线索的可重放演练（CI 可跑，零网络）
- `scripts/measure-citation-judge.ts`：真实模型下的引用一致性判准率测量（分三档报告，不进 CI）

**P9 · 扩展面与 LLM 友好化**
- **[docs/EXTENDING.md](docs/EXTENDING.md)**：六个扩展点（Skill / Connector /
  SimulationPlatform / WetLabBackend / 安全门规则 / Prompt 与模型路由）各一节，
  每节 = 契约 + 最小可运行示例 + 怎么测 + 放哪里。示例全部在 CI 里真跑：
  skill/connector/platform 三类是脚手架产物（生成后 `bun test` 一遍），
  安全门规则是 `examples/extending/flammable_over_heat_rule.ts`（11 例，含阴性对照）
- **脚手架**：`spark-research new skill|connector|platform <name>`，
  生成带可执行测试桩的模板；connector 有免 key 与 `--with-key` 两版；
  platform 生成的测试**直接接 P5 契约测试套件**（新平台的验收标准）
- **能力自描述**：`spark-research capabilities [--json] [--probe]` 与 `GET /api/capabilities`。
  **全部从真实注册表生成**并有双向一致性测试；可用性分静态档（零 IO）与探测档（spawn 子进程）
- **MCP server**：`spark-research mcp`（stdio）。24 个工具覆盖检索 / 文献库 / 思路 /
  novelty / 实验 / 记录 / 结论 / 报告；长任务默认同步等待，超时才降级为任务句柄。
  **`lab approve` / `lab reject` / `lab simulate` / `conclusion review` / `project archive`
  刻意不暴露**（AD-9）：不暴露清单是显式数据，进 capabilities 与 server instructions，
  `lab_compile` 返回体里直接给出「需要人执行哪条命令」
- **用户配置面收口**：`~/.spark-research/config.json` + 一张设置表作单一真源，
  优先级 env > config.json > 默认值。`spark-research config list|get|set|unset|path`，
  每一项都写清「改了影响什么」；凭据同文件但只显示「已设置 / 未设置」
- **SKILL.md frontmatter 规范化**：新增 `triggers` / `connectors` / `validation` 三个必填字段，
  schema 校验进 CI。`validation` 让 AD-5 从口号变成一道门——校验器去磁盘核对测试文件真实存在
- **llms.txt / llms-full.txt**：`bun run gen:llms` 幂等生成，CI 守与文档同步
- connector 元数据新增 `caveat`：`status: available` 只说明「接口实现了」，
  不等于「无条件可用」（如 Semantic Scholar 匿名请求实测持续 429）

### 变更

- **connector 基类 `MCPConnector` 改名 `HttpConnector`**（连同 `MCPConnectorConfig` →
  `HttpConnectorConfig`、`MCPTool` → `HttpTool`）。这个类与 Model Context Protocol
  毫无关系，名字是 v0.1 的历史包袱；P9 落地了真正的 MCP 实现之后，同名会主动误导读者。
  **旧名保留为 deprecated 别名，外部代码不会断**；移除记在 BACKLOG V15
- 报告与检查器统一「可复现性口径」措辞：证据来自非确定性平台一律写**区间/趋势对账**，
  不再出现「逐位可复现」这类承诺
- 结论卡 `review` 字段从裸字符串升级为结构化评审记录（谁 / 何时 / 依据哪些 finding）。
  **向后兼容**：P5/P6 落的旧形态照常读得出来，解析不了的一律落回 `pending`，不会被当成 approved

### 移除

- 删除 v0.1 遗留的 `backend/src/compute/`（`providers.ts` / `manager.ts` / `job_manager.ts`）
  及其测试。这套内存态、阻塞 `wait()` 的任务抽象自 P5 起就标了 DEPRECATED，
  干实验已全部走 `SimulationPlatform`；留着两套「提交任务」抽象只会让下一个人选错

### 修复

- bibtex key 非确定性（`LibraryStore.list()` 用随机 uuid 参与排序，导致同姓同年论文的
  引用 key 可能在两次运行间互换）——次序键改为 rowid，`RecordStore` 同一问题一并修
- 句子切分把并列引用 `[@a; @b]` 劈成两半，导致后一个 key 逃过引用核验
- 综述草稿（无产生它的 cell）被 trace-don't-recompute 规则误判为 hard finding
- pytest 静默收集 0 个用例（测试文件名 `*.test.py` 不匹配默认模式）——
  P0-P4 期间 Python 侧其实没有测试门禁

---

## [0.1.0]

Daemon-Worker 架构 + permit set、有状态 Python kernel、Artifact 与 lineage、
Reviewer veto（trace-don't-recompute）、11 个科学 connector、协议编译器与安全门、
vanilla JS 三栏 Web 界面。
