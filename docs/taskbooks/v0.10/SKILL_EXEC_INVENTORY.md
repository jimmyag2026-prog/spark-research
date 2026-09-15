# 技能执行入口盘点表（V172 后半 · lane γ-4）

> 产出时间：2026-09-16 · 分支 `feat/W10-gamma`
> 口径：逐个读 `backend/src/skills/<name>/SKILL.md` 的 frontmatter + 该技能背后**真实存在的程序化实现**
> （CLI 子命令 / 导出的类与函数），不凭印象。每一行的「执行入口」列写的是**能在进程内直接调用**的东西；
> 没有的写「无（只有说明书）」。
>
> 背景：`orchestrator.ts` 的 `case "skill"` 目前只对 `literature-review` / `literature-search`
> 两个技能真执行（走 `runLiteraturePipeline`），其余 11 个一律 `this.skillContextFor(name)`
> ——把技能说明书塞进上下文，让模型自己手搓 connector 调用。U42 / U47 / U48 三次真实会话
> 都死在这条路上。

## 判定口径

**「乙直调」**：技能的全部工作在一个确定性管线里（已有类/函数），编排层只需构造入参 →
调用 → 把结构化结果 digest 回给模型。无需二级 agent，无需多轮判断。

**「甲子代理」**：技能本身是**多轮对话**或**需要模型在中途做判断/生成**的，
必须开一个子 agent（`sub_agent.ts`）带着 SKILL.md 跑。

**grants** 取三处的并集：SKILL.md frontmatter 的 `allowed-tools`、`connectors`、`platforms`，
加上实现真正要碰的东西（凭据 / LLM 调用 / 本地写盘 / 子进程）。

---

## 盘点表

| # | 技能 | 执行入口（程序化实现） | 所需 grants | 乙直调 / 甲子代理 | 工作量 | 现状 |
|---|---|---|---|---|---|---|
| 1 | `literature-search` | ✅ `runLiteraturePipeline(mode:"search")`（`agents/literature_pipeline.ts`）→ `LiteratureSearcher.search` | connectors: openalex/crossref/europepmc/semanticscholar/arxiv/pubmed/biorxiv/**aminer(key)**；网络 | 乙 | — | **已接**（V172） |
| 2 | `literature-review` | ✅ `runLiteraturePipeline(mode:"review")`：检索→入库→`PdfDownloader`→`ReadingCardGenerator`→`ReviewDraftGenerator`→`citationIntegrity` | 同上 + LLM 调用（预算闸）+ 写 `papers/` `artifacts/` | 乙 | — | **已接**（V172） |
| 3 | `paper-download` | ✅ `PdfDownloader.download(paperId)` / `.downloadMany(ids)`（`literature/pdf.ts:101`）；CLI `lit pdf` | 网络（OA 直链）+ 写 `<项目>/papers/` + 读写 `library.db` | **乙** | **S**（半天） | 本轮接 |
| 4 | `research-report` | ✅ `buildReport(input)`（`report/export.ts:101`）；CLI `report export` | 读 `records.db`/`library.db` + 写 artifact/文件 | **乙** | **S** | 本轮接 |
| 5 | `novelty-check` | ✅ `NoveltyChecker.check(idea)`（`ideation/novelty.ts:825`）；CLI `idea check <record-id>` | LLM（claim 抽取 + 比较，预算闸）+ 检索 connectors + 写 records/artifacts | **乙** | **M**（要先拿到 idea 卡） | 本轮接 |
| 6 | `library-curation` | ✅ `LibraryStore.add/list/tag`、`LiteratureSearcher.fetchById`、`libraryKeyIndex`（export.ts）；CLI `lit add/list/remove/export` | 网络（按 id 取单篇）+ 读写 `library.db` + records | 乙 | S | 未接 |
| 7 | `idea-coexplore` | ⚠️ 有 `ideation/coexplore.ts` + `IdeaStore`，但**本质是多轮苏格拉底式对话**，一次调用产不出有用的卡 | LLM（多轮）+ library 读 + 写 records | **甲** | **L** | 未接 |
| 8 | `protein-analysis` | ✅ `proteins/analysis.ts` 的链路函数；CLI `protein …` | connectors: uniprot/pdb/alphafold；网络 | 乙 | M | 未接 |
| 9 | `dry-experiment` | ⚠️ `experiment/` 状态机（CLI `exp new/run/status/collect`）——**多步、跨进程、要人确认**，一次调用跑不完 | 子进程（仿真 runner）+ 写盘 + 状态机持久化 | **甲** | **L** | 未接 |
| 10 | `cobrapy` | ⚠️ `simulation/cobrapy`（`SIMULATION_PLATFORM_IDS`），是 `dry-experiment` 的一个平台形态，入口同 #9 | 本地装了 cobrapy 的 python 环境 + 子进程 | 甲（随 #9） | M（#9 之后） | 未接 |
| 11 | `pydeseq2` | ⚠️ 同 #10，平台 id `pydeseq2` | 本地 python + 子进程 + 计数矩阵文件 | 甲（随 #9） | M | 未接 |
| 12 | `scanpy` | ⚠️ 同 #10，平台 id `scanpy` | 本地 python + 子进程 + h5ad 文件 | 甲（随 #9） | M | 未接 |
| 13 | `wet-protocol` | ⚠️ `lab/` 的 compile → token → **approve（人类签名）** → simulate，安全闸在中间 | 湿实验后端 + **人类审批 token**（不可由 agent 自动过闸） | **甲**（且必须停在审批前） | L | 未接 · 本版不接 |

---

## 结论与顺序

1. **本轮（γ-4）接 3 个**：`paper-download`、`research-report`、`novelty-check`。
   三者都是乙型（确定性管线已存在，只差编排层构造入参），加起来 ≈ 1 天。
   接完 chat 可执行技能数 **2 → 5**（对上 DEVELOPMENT_PLAN §六「chat 可执行技能 ≥ 5 个」）。

2. **下一批（乙，v0.11 候选）**：`library-curation`、`protein-analysis`。同样是乙型，
   只是入参形状比本轮三个复杂（前者要先判标识符形态，后者要先把自然语言蛋白名收敛到
   唯一 accession）。

3. **甲型五个**（`idea-coexplore` / `dry-experiment` / `cobrapy` / `pydeseq2` / `scanpy`）
   共用一个前提：**子 agent 跑多步 + 状态机续跑**。不该一个一个接，应该先把
   「带 SKILL.md 的子 agent 执行器」做出来，五个才有共同地基。

4. **`wet-protocol` 本版明确不接**：它的安全闸是**人类签名的审批 token**。
   把它接进 chat 的自动执行路径，等于给 agent 开一条绕过审批的口子。
   要接也只能接到「compile + 出 token」为止，`approve` 永远由人来做。

## 分发表落在哪

`orchestrator.ts` 是收口专属文件，所以分发表做成 **`backend/src/agents/skill_runners.ts`** 的注册表：

- `SKILL_RUNNERS: Record<string, SkillRunner>`，每个 runner 的签名统一为
  `(ctx: SkillRunnerContext, params: Record<string, unknown>) => Promise<SkillRunResult>`；
- `runSkill(name, ctx, params)` 查表；表里没有就返回 `{ handled: false }`，
  编排层照旧退回「加载说明书」——**不接的技能行为逐字节不变**。

收口只需在 `case "skill"` 里加一行接线（见 `docs/devlog/W10-gamma.md` §收口 diff）。
