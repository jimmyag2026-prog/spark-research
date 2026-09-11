# Spark Research v0.7 开发与测试方案（定稿 v1）

> 定稿时间：2026-09-11 PDT · 基线：main @ v0.6.0（`dd11bf3`，PR #60）
> **执行前提已满足（2026-09-11 验证）**：tag v0.6.0 = main HEAD · `package.json` 0.6.0 ·
> 工作区干净 · v0.6.0 tag 在 `origin/main` 祖先链上 · GitHub Release 由 CI 自动挂双平台二进制。
> 配套设计：`DEVELOPMENT_PLAN_v0.7_DATA_LAYER.md`（主线 A 全文，本文只引用不复述）。
> 规划期真源在本地 `~/Desktop/AI4S/spark-research-v0.7-plan/`，本文即其整理入库版。
> 执行方式与时间盒由用户启动时定（v0.6 用 `/loop` 10 小时自动推进，本版可沿用或分段）。

---

## 〇、一句话与已锁定决策

**v0.6 让用户从浏览器进来走完「文献 → 写作」并知道花了多少钱；v0.7 让这一路产生的
每一份数据都被原样留下、可导出、可判定能不能出门，同时把三轮实证里四个课题都在
流血的检索排序、和并发/长任务的可靠性补上。**

| 决策项 | 内容 | 拍板 |
|---|---|---|
| 主方向 | **A 数据层演进**（原始层 append-only · journal · 导出/湖仓 · 来源分级）· **B 检索包** · **C 可靠性包** · D Modal（等 token，不占排期） | 2026-09-11 用户 |
| 明确不做 | 3D 结构查看器（C5-①）· SDK / runtime contract（顺延 v0.8）· skill/connector 铺量（V76 口径：每轮 ≤2–3 个按课题拉动）· 售卖通道与计费 · 多用户身份（V10）· 物理 Opentrons（V6，前置 V52 未裁） | 同上 |
| 数据层六项裁定 | raw 默认开且本地 · LLM 原文永久保留 · v0.7 只 JSONL + DuckDB 直查、不做 Parquet · 共享单位 = 项目、时间窗只作增量、manifest 链式 · 售卖不开发但接口对齐 Delta Sharing / DCAT / SPDX · `raw/kernel` 只存引用 + hash | 同上（详见配套设计 §〇） |
| 实证回环 | **R4**：四课题（T1–T4，基线已冻结）全量复跑一次，指标表与 R1–R3 同列可比；新增两步 `data export --for-sharing` → 空项目 `data import` → `report export` diff | 本方案提议 |
| 每轮预算 | $2（沿用 v0.6，`--budget-usd` 强制）；R4 四课题估算 ≈ $0.3（v0.6 实测单课题 $0.03–0.09） | 沿用 |
| LLM 模型 | 沿用 `z-ai/glm-5.3-flash`；R4 中至少一课题用第二个 provider 复跑判定器（V12 裁定需要跨 provider 样本） | 本方案提议 |
| AMiner key | **2026-10-07 到期**，中文课题（T3/T4）的 R4 轮次必须排在到期前；续期由用户决定 | 用户既有指令 |
| PR 政策 | 沿用 v0.6：授权自动 squash-merge（六套件全绿 + 自审）；main 不直推；push 后验远端 ref；**单一合并权**（纪律 14） | 沿用 |
| 版本纪律 | 全部改动在 **v0.7.x 线**：W7-D0 收口 → `v0.7.0-alpha.1`，之后每波一个 alpha；R4 + 第五次零上下文验收过 → `v0.7.0`。每个 tag 必有 CHANGELOG 段 | 沿用 |

---

## 一、基线闸（第 0 步，不过不开工）

| # | 检查 | 判据 |
|---|---|---|
| 0-1 | 六套件在 v0.6.0 上全绿并记数 | unit ≥ 2145 · e2e 19 · concurrency+timeout · pytest · test:lab；数字写进 W7-D0 首个 PR 描述作为「只增不减」基线 |
| 0-2 | 二进制冒烟（CI）在 tag v0.6.0 上绿 | 两平台 Release assets 存在 |
| 0-3 | `.venv` 在每个 worktree 可用 | v0.5 教训：新 worktree 缺 `.venv` 让 python 套件**静默变 skip**——symlink + 实跑一次 `test:py` 看 skip 数 |
| 0-4 | BACKLOG 归账 | 本 PR 已做：V1/V7/V11/V15/V17/V18/V19 补 ✅ 与实证；V16 改裁定；V12 补 GLM 测量数 |
| 0-5 | AMiner key 剩余有效期 ≥ R4 中文轮次计划日 | 否则先排中文轮次或用户续期 |

---

## 二、主线 A · 数据层演进（三波，详见配套设计）

| 波次 | 交付 | 门禁（配套设计 §八） | 关联 BACKLOG |
|---|---|---|---|
| **W7-D0** | L0 原始层：`backend/src/raw/`（`RawSink` 契约 + `JsonlRawSink` + `MemoryRawSink`）· 4 处埋点（`connectors/base.ts:188` · `usage/ledger.ts:184` · `artifacts/store.ts` 写 execution_records 处 · `lab/wet_loop.ts:662`）· 脱敏 · hash 链 · blob 阈值 · L3 三列（`quality` / `provenance_class` / `license`）+ `backend/src/provenance/policy.ts` 映射表 + 回填迁移（schemaVersion 1→2）· **V78 清扫**：`orchestrator.ts` / `server/context.ts` 等 6 处 `new LLMRouter()` 的裸调用全部改经 `usageTrackingLlm`，否则 raw/llm 与 usage.jsonl 都漏 chat 与 MCP 面 | G1 覆盖率 · G2 脱敏 · G3 链 · G6 AD-16 · G7 配置有读者 | V78 · V63（raw 行带真实 rateLimitWaitMs）· V76（新 connector 必声明 license） |
| **W7-D1** | L1：`records_journal`（与 records 同事务）· `RecordStore.history()` · `records repair <id> --to-seq` · `LibraryStore.remove()` 改 tombstone 并接上 `retractOrphanRecords()` · HTTP `GET /api/records/:id/history` · CLI `report records --history` | G4 journal 对账 · D-9 完整性核验回归（`tests/unit/lab_*` 全跑） | V24 · V30 |
| **W7-D2** | L2：`spark-research data export/import`（JSONL + manifest：Delta Sharing 三级命名 · DCAT 字段 · SPDX license · `prevManifestHash` 链 · `--for-sharing` 类过滤 + upstream stub 保边）· DuckDB 直查文档三条示例 · 二进制冒烟加 export 路径 · README/llms.txt 叙事 | G5 导出往返 · G8 叙事一致 | V57 处置（验收任务书加两步） |

**顺序不可换**：D0 的三列是 D2 过滤的前提；D1 的 journal 是 D2 导出对象之一。

---

## 三、主线 B · 检索包

三轮实证四个课题共同的出血点。基线（冻结于 `docs/taskbooks/v0.6/`）：T1 里程碑召回 2/8，T2 3/8，T4 1/5@10（limit 150 仍 2/5），T3 中文 3/3 但连写复合词 0 命中。

| lane | 交付 | 判据 | 足迹 |
|---|---|---|---|
| **B-1 排序（V67）** | 现状 `literature/search.ts:158` 合并后只按「命中源数 → 首见顺序」排。改为**混合排序**：`hitCount` × 被引数归一化（`library.citedByCount` 已有，来自 OpenAlex `cited_by_count` / Crossref `is-referenced-by-count`；**补 AMiner `n_citation` 与 S2 `citationCount` 的 normalize 映射**）× 年份衰减；`lit search --rank blended\|hits\|citations\|recent`，默认 blended；status.note 写明排序依据（AD-12：结果怎么来的要可见） | 四课题冻结基线 recall@10 **每个 ≥ 基线 +2，或每条未达标有机制解释**；无回归（T3 3/3 保持） | `literature/search.ts` · `literature/normalize.ts` · `connectors/aminer.ts` · `connectors/literature.ts`（S2 字段）· `literature/cli.ts`（flag 文案） |
| **B-2 中文分词** | V65 拆词兜底只认空格。补分词器：**Python `jieba` 作可选依赖**（与 `pdf_text.py`/pypdf 同一形状：`.venv` 探测 → spawn → 缺则降级回空格拆词并在 note 如实标注）；只在「0 命中且无空格」时触发 | T3/T4 各加 2 条连写复合词查询进冻结基准，分词后可达；缺 jieba 时行为与 v0.6 完全一致（门禁：stub 缺失路径） | 新 `literature/segment.py` + `literature/segment.ts` · `search.ts` 拆词入口一处 · `doctor` 探测面加一行 |
| **B-3 desc 污染（V69）** | `projectContext` 注入改为显式「背景说明，不是任务指令」框定块；精读卡「与本项目关系」与报告「研究问题」的 prompt 模板同改 | 金测试：prompt 文本中 desc 出现在框定块内且仅一次；R4 抽查 5 张卡 desc 原文不逐字出现在正文 | `agents/prompts.ts` · `literature/reading.ts` · `report/export.ts` 的 prompt 构造处 |
| **B-4 小项** | V72 中文无作者 BibTeX key → 拼音或 `anon<year>`；V71 `review findings` 显示 citation soft finding | 单测各一 | `literature/bibtex.ts` · `reviewer/findings_store.ts` 查询面 |

---

## 四、主线 C · 可靠性包

| lane | 交付 | 判据 | 足迹 |
|---|---|---|---|
| **C-1 V64 根治** | 解析顺序：`--project` > env `SPARK_RESEARCH_PROJECT` > `state.json.sessions[sessionId]`（字段已存在，`manager.ts:197`）> 全局 `currentProject`；全局指针写入加文件锁（`state.json.lock`，O_EXCL + 过期回收）；`project use` 只改会话绑定不改全局，除非 `--global` | 两进程各 100 次交替 `project use` + 写 record，零串项目（`tests/concurrency/project_pointer.test.ts`）；R4 四课题并发复跑零污染 | `project/manager.ts` · `cli/` 的 `openProjectResolved` 单点（alpha.6 已收口，改这一处） |
| **C-2 V70 + V3** | 任务快照与仿真 run 记录 `pid` + 进程启动时间（`ps -o lstart=` / Linux `/proc/<pid>/stat` starttime）；`lit tasks` / `exp status` 读回时交叉核验，pid 不在或启动时间不符 → 标 `orphaned`（不改成 failed——那可能是假的，沿用 tasks.ts 既有口径） | kill -9 后 `lit tasks` 不再显示 running；假阳性测试：pid 复用场景标 orphaned 而非 running | `server/tasks.ts` · `simulation/run_store.ts` · `literature/cli.ts`（tasks 输出） |
| **C-3 V60** | 解析器保留词表外试剂原文片段进编译产物（`label`），Opentrons 步骤名 `未识别试剂#step-1（原文：硝酸）`；审批面（CLI + UI）显示原文并标「词表外，安全规则未覆盖」 | 单测：三种表外试剂各自原文可见、reservoir 孔位不塌缩（V60 既有断言保持）；e2e ⑨ 审批弹窗含原文 | `lab/protocol.ts` · `lab/opentrons_protocol.ts` · `lab/cli.ts` 审批渲染 · 前端审批组件（纪律 13：跨层必跑 e2e） |
| **C-4 V80** | `records.db` / `library.db` / `artifacts.db` 补 `PRAGMA busy_timeout = 5000`（`findings_store.ts:159` 已有，其余三库没有） | 并发 `idea new` + `idea check` 不再 `database is locked`（R3-T4 复现脚本进 concurrency 套件） | `project/records.ts` · `literature/library.ts` · `artifacts/store.ts` 各一行 |

---

## 五、附线 D（Modal）与债务清算 E

**D · Modal 真网关**：条件触发——用户提供 token 当天开工，按 v0.5 `COMPUTE_DESIGN.md` 与 W5-2 α 契约实现真实链路；验收路径 §1.1.9「SIGKILL → resume → 收割」在 Modal 上成立。**不占排期、不进 DONE 定义。**

**E · 债务**（每条要么做、要么裁定归档，不许悬着——BACKLOG 纪律）：

| 条目 | 处置 |
|---|---|
| V41 MCP 描述能力声称门禁 | **做**：`narrative_parity` 加第 8 条——`MCP_TOOLS[].description` 里的能力词（docking/3D/全文/…）对账 `capabilities` 真源；阴性对照沿用 W5-1 γ 那条 |
| V48 local handle 落盘 | **做**：`adapters/local.ts` 在 spawn 成功即回写 `adapterHandle`（`broker.ts:696` 已有 CAS 写点），SIGKILL → resume 在 local 成真 |
| V62 e2e tsconfig 45 个类型错误 | **做**：修到能过并纳入 `typecheck` 脚本，或写豁免理由——二选一，W7-D0 收口时定 |
| V21 超时 env 前缀 | **启动废弃周期**：新名 `SPARK_RESEARCH_*_TIMEOUT_MS` 生效，旧名读到即 warn，v0.8 删 |
| V14 白名单制 | **裁定**：与 reviewer 状态机重构同做（P13 口径），v0.7 不动，理由记 BACKLOG |
| V12 结构化输出 | **裁定关闭候选**：R1–R3 在 glm-5.3-flash 上判定器 JSON 失败率 0%（CHANGELOG v0.6.0「数字」段）；R4 用第二 provider 复跑一课题，仍 0% → 关闭；否则 `CallOptions.responseFormat` 进 v0.8 |
| V13 判定 prompt 口径 | **裁定**：R1–R3 引用核验 400+ 条 0 伪造、0 hard——「凭空归因」漏报未再现，关闭；复现再开 |
| V16 子代理模型配置 | **裁定关闭**：用户可见的一半 v0.6 G-1 已做；「与 V7 联合评估」因 V7 已删无对象 |
| V42 network 声明非强制 | **登记不做**：本地进程网络隔离需 sandbox/netns，超出 v0.7；文档明写「声明非强制」 |
| V49 deterministic 口径 | **不裁定**（用户推迟），但进 `quality` 列（W7-D0） |
| V52 浓度单位 | **等用户领域判断**，V6 前置 |

---

## 六、lane 足迹总表（并行纪律：一文件一主）

| 文件/目录 | 所有者 | 其他 lane 的进入方式 |
|---|---|---|
| `backend/src/index.ts` | **收口**（主会话） | 各 lane 交一行 `case`，收口合入（v0.5 η 教训） |
| `backend/src/raw/` · `backend/src/provenance/` · `backend/src/data/` | A（D0/D1/D2 各自） | 新目录，无冲突 |
| `connectors/base.ts` · `usage/ledger.ts` · `artifacts/store.ts` · `lab/wet_loop.ts`（埋点行） | A-D0 | B/C 不碰；C-4 的 `artifacts/store.ts` 一行 PRAGMA 交 A-D0 顺手做 |
| `project/records.ts` · `project/manager.ts` · `project/models.ts` | A-D0（加列/加路径）→ A-D1（journal）→ **C-1 在 D1 合并后**再动 `manager.ts` | 串行，不并行 |
| `literature/search.ts` · `normalize.ts` · `connectors/aminer.ts` · `connectors/literature.ts` | B-1 | B-2 只加 `segment.*` 与 search.ts 一处调用，**B-2 在 B-1 合并后开** |
| `agents/prompts.ts` · `literature/reading.ts` · `report/export.ts` | B-3 | A-D1 的 `reading.ts:466` 一处 update 不改，无冲突 |
| `server/tasks.ts` · `simulation/run_store.ts` | C-2 | — |
| `lab/protocol.ts` · `lab/opentrons_protocol.ts` · `lab/cli.ts` · 前端审批组件 | C-3 | A-D0 的 `wet_loop.ts` 埋点与之不同文件 |
| `tests/unit/narrative_parity.test.ts` | E（V41）| A-D2 的 G8 条目由 E 合入 |
| `docs/` · `README.md` · `llms.txt` | 收口 | lane 提交 devlog，叙事改动统一由收口做并过 G8 |

**波次编排**（串并关系）：

```
W7-D0 (A-L0 + 三列 + V78 清扫 + C-4 + V62 裁定)  ──→ alpha.1
   ├─ B-1 排序        ─┐
   ├─ B-3 desc        ─┼─ 并行 ──→ alpha.2
   ├─ C-2 tasks       ─┤
   ├─ C-3 V60         ─┤
   └─ E: V41 V48 V21  ─┘
W7-D1 (A-L1 journal + V24/V30)  ──→ alpha.3
   ├─ B-2 分词（B-1 后）  ─┐
   ├─ B-4 小项            ─┼─ 并行 ──→ alpha.4
   └─ C-1 V64 根治（D1 后）─┘
W7-D2 (A-L2 export/import + 叙事)  ──→ alpha.5
R4 全量复跑 + 第五次零上下文验收（含 export 两步）→ blocker 修完 → v0.7.0
```

---

## 七、门禁与验收

- **六套件 + 二进制冒烟**每个 PR 必跑；数字只增不减（基线 §一 0-1）
- **配套设计 §八 G1–G8** 全部落地并各有阴性对照实跑记录（devlog 里贴命令与红/绿）
- **跨层改动跑 e2e + 消费方清扫**（纪律 13）：C-3、W7-D2 必触发
- **R4**：四课题按 v0.6 每轮协议复跑；指标表新增列「导出往返 diff」「raw 行数 / usage 行数」
- **第五次零上下文验收**：入口浏览器；花钱路径预授权 $2；任务书新增 `data export --for-sharing` → 核 manifest 计数与排除理由 → `data import` 到新项目 → `report export` diff 为空
- **验收后不改被验收的东西**（V58）：改了就补窄验收

## 七·补、执行编排：谁来干、用什么模型（2026-09-11 用户确认，开工前补入）

> 两层模型互不相干：**产品侧 LLM**（spark-research 自己调的）全程 `z-ai/glm-5.3-flash`，
> 受 $2/轮预算管；**agent 侧模型**（Claude 干活的）按下表分配，消耗的是 Claude 额度。

| 步骤 | 执行者 | agent 模型 | 理由 |
|---|---|---|---|
| 基线闸 · **W7-D0 / W7-D1 / W7-D2** | **主会话直接干**，不开子代理 | Fable | 三波都是数据层地基，碰 `records.ts` / `manager.ts` / `base.ts` / `index.ts` 热点文件；拆给子代理要重建上下文且易撞 |
| alpha.2 五条 lane（B-1 · B-3 · C-2 · C-3 · E）| 5 个并行子代理，各自 worktree | **sonnet** | v0.5/v0.6 同量级 lane 均由 sonnet 完成 |
| alpha.4 三条 lane（B-2 · B-4 · C-1）| 3 个并行子代理，各自 worktree | sonnet | B-2 须在 B-1 合并后开；C-1 须在 W7-D1 合并后开（§六串并关系） |
| 每批合入评审 | **主会话**（单一合并权，纪律 14） | Fable | **不采信 lane 自报数字**：合并前独立复跑六套件 + 每条阴性对照；核对远端 ref |
| 各波收口（冒烟 / 窄验收 / tag / CHANGELOG） | 主会话 | Fable | 跨 lane 判断 + 发版动作 |
| R4 四课题复跑 · 第五次零上下文验收 | **零上下文子代理**（禁读源码，只给 CLI/MCP + `llms.txt` + `readme_for_agent.md`） | sonnet | 验收者必须陌生；产品侧照样走 glm，agent 模型不影响 $2 预算 |
| 指标汇总 / 发现分析 / BACKLOG 登记 | 主会话 | Fable | 判断密集 |
| 机械批量活（fixture 录制、日志扫描、召回基准核对） | 单个子代理 | **haiku** | 纯执行，省额度 |

硬纪律（沿用，逐条有事故出处）：
- 一 lane 一 worktree：`~/Desktop/AI4S/spark-research-<lane>`，禁放 /tmp；lane 从中立 cwd 启动（§5.3·补二）
- 新 worktree 先链 `.venv`、`bun install`，**实跑一次 `test:py` 看 skip 数**（v0.5：缺 `.venv` 让 17 个用例静默 skip、lane 报绿）
- 子代理任务书必须写足迹（含 `tests/e2e/`——v0.5 δ 的 e2e 回归就是足迹漏了它）、必须写阴性对照
- 子代理不授 merge 权；产出一律主会话验证后才算数
- 网络/额度中断：lane 先落 wip commit 并标「未经任何验证」，恢复后从 wip 继续（v0.5 断网五 lane 同时挂的处置）

### 时间盒（用户拍板：分两段，中间过目一次 alpha.2）

| 段 | 内容 | 预估 |
|---|---|---|
| 第一段 | 基线闸 → W7-D0 → alpha.1 → 五 lane 并行 → 合入 → alpha.2 | ~6h |
| （用户过目 alpha.2） | | |
| 第二段 | W7-D1 → alpha.3 → 三 lane 并行 → alpha.4 → W7-D2 → alpha.5 → R4 + 第五次验收 → v0.7.0 | ~6–8h |

> **执行期编号更正（2026-09-11）**：主会话的 W7-D2 先于三条 lane 完成，实际 alpha.3 = W7-D1，**alpha.4 = W7-D2**，**alpha.5 = 三 lane（B-2/B-4/C-1）收口**。CHANGELOG 以实际为准。

做不完按序砍尾（先砍 B-4、再砍 E 里的 V21/V62），**不全面减薄**；砍掉的回 BACKLOG 写明原因。

## 八、指标表（R4 必填，与 R1–R3 同列）

| 指标 | R1 | R2 | R3 | R4 目标 |
|---|---|---|---|---|
| 里程碑召回@10（T1/T2/T4） | 2/8 · — · — | — · 3/8 · 1/5 | （见 R3 汇总） | 每课题 ≥ 基线 +2 或有解释 |
| 中文召回（T3；含 2 条连写复合词） | 0/3 | 3/3 | 3/3 | 5/5 |
| 并发污染 | 双向 | 0 | 0 | 0（两进程 100 次） |
| 判定器 JSON 失败率 | 0% (glm) | 0% | 0% | 0%（第二 provider） |
| 引用核验 hard | 0 | 0 | 0 | 0 |
| 单课题花费 | $0.03–0.09 | | | ≤ $0.15 |
| **raw/llm 行数 == usage.jsonl 行数** | — | — | — | 相等（含 chat/MCP 面） |
| **导出往返 report diff** | — | — | — | 空 |
| kill -9 后僵死 running | 有 | 有 | 有 | 0 |

## 九、v0.7.0 DONE 定义（五条全满足）

- [x] 一个课题跑完，`raw/` 下 connector/llm 有行（device 只在湿实验路径、kernel 只在 chat code task 路径——V85 登记仿真不在 raw）、链校验通过（V91 修后）、grep 不到凭据（G2）
- [x] **普通导出** → `data import` → `report export` 与原报告 diff 为空（A6 第 12 步）；`--for-sharing` 下 manifest 里 upstream 计数 > 0 且为 stub、产物 grep 不到上游摘要（A6 / `w7a6_r4_fixes`）——for-sharing 往返有损，口径已在 alpha.4 更正
- [ ] **未满足**：召回 ≥ +2 只在 T1 实测（3/8 → 5/8）；T2/T4 因 OpenAlex 匿名 429 未实测（R4 全线 0/8，机制解释 = 上游限流非排序）。T3 连写复合词可检索 ✅（R4）。V67/V86 保持打开，等 contactEmail 礼貌池后复测
- [x] 两进程并发 100 次零串项目（C-1 测试 + R4 四课题实测）；kill -9 后 `orphaned` 不僵死（C-2 测试 + R4 实测）
- [x] 第五次零上下文验收走通（A6：浏览器 + 花钱 $0.21 + 导出两步），Blocker/High 清零；其 Low 复核出 V91 已修（alpha.7）

> **发布判定（2026-09-11）**：五条里四条满足，第 3 条如实标未满足（上游限流阻断实测，非产品回归）。按 v0.5 以来的口径——把细节放进 backlog、不让一条外部依赖阻断发布——建议发 v0.7.0，V67/V86 进 v0.8 首批。

## 十、风险

| 风险 | 缓解 |
|---|---|
| A-D0 的 `create()` 缺 `provenance_class` 拒绝 → 10 个写入模块要清扫 | 先 warn 一个 alpha 再拒绝；G1 覆盖率门禁兜底 |
| B-1 混合排序把 T3 已达标的中文召回打回去 | T3 进回归基准；排序权重可按源关（AMiner 无 citedByCount 时退化为 hits） |
| B-2 jieba 在二进制里不可用 | 可选依赖 + 降级 + doctor 探测，AD-12 口径与 pypdf 一致 |
| C-1 改全局指针语义影响所有 CLI | 只动 `openProjectResolved` 单点；并发测试 + R4 复跑 |
| AMiner key 10-07 到期撞上 R4 | §一 0-5 前置检查；中文轮次前置 |
| 三条主线并行导致 index.ts 冲突 | 收口单一所有者；lane 只交 case 行 |
| 磁盘：raw 层默认开 | 配套设计 §4.3 估算 <50 MB/课题；`data archive` 压缩不删 |

## 十一、BACKLOG 归口（本版）

| 去向 | 条目 |
|---|---|
| **v0.7 做** | V24 V30 V41 V48 V60 V62 V63 V64 V67 V69 V70 V71 V72 V78 V80 · V3 · V21（废弃周期启动） |
| **v0.7 裁定关闭** | V12（R4 第二 provider 复核后）· V13 · V16 |
| **v0.7 登记不做** | V14 · V42 |
| **等用户/外部** | V4 Modal（token）· V49 · V52 · V10 · V5 · V6 · D1 D2 D3 |
| **本 PR 补标已完成** | V1 V7 V11 V15 V17 V18 V19（实证见各行） |
