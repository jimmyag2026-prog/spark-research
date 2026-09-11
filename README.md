# Spark Research

**面向科研人群的开源科研工作台。** 用自然语言驱动一个可审计的研究代理，走完
「文献调研 → 思路共探 → 实验验证 → 数据记录 → 创新性核验 → 结论评审 → 报告」的完整循环，
全过程本地优先、证据可溯源。

> 一句话主张：**你的研究项目是一等公民，每一步思考和实验都留下可审计的证据链。**

**上手指南**：[readme_for_human.md](readme_for_human.md)（人类用户）·
[readme_for_agent.md](readme_for_agent.md)（AI agent 集成，配合 [llms.txt](llms.txt)）

设计与开发文档：[docs/DESIGN.md](docs/DESIGN.md) · [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) ·
[docs/BACKLOG.md](docs/BACKLOG.md) · [各阶段 devlog](docs/devlog/)

---

## 它和别的东西不一样在哪

三个赌注（详见 DESIGN §3）：

1. **项目是持久层的根，不是聊天记录的标签。** 所有产出挂在 project 下：文献库、思路库、
   实验、观察、结论、产物，构成一张可查询的证据图（`records.db`）。换台机器、隔半年回来，
   每条结论都还能追回到产生它的那次执行。
2. **模型说的话要被确定性代码约束。** 凡是「模型给结论、结论会影响下游动作」的地方，
   都有一层零 IO 的纯函数按可计算特征卡它（AD-8）：引用必须在库内、novelty 评级要被检索
   结果约束、结论引用的观察必须真实存在于执行记录。模型判断可以当输入，不能既当运动员又当裁判。
3. **干湿闭环里物理世界的操作永远不自动化审批。** 湿实验的安全门是必要非充分条件，
   通过之后停在 `awaiting_approval` 等一个**具名的人**按批准，批的是某一版协议的 hash（AD-6）。

> ⚠️ **安全门当前的真实覆盖范围**（V25 更新，如实写在这里，不再只说「四条规则」）：
> `volume_capacity` 在自然语言主管线上全程可信；`chemical_compatibility` 的试剂词表
> 已扩到中英文与常见分子式，但仍然是**有限词表**——**词表之外的试剂它完全看不见，
> 不是「相容」**。
>
> ⚠️ **自然语言步骤解析目前只吃中文**（发布前外部验收发现）：英文协议
> （`Transfer 50uL of sample into well A1...`）编译不出任何步骤，会直接报错
> 「协议没有任何步骤」——不会静默产出空协议，但也确实用不了。
> 试剂词表是双语的，可上游解析器不是，所以词表永远拿不到英文输入。
>
> ⚠️ **限值表里没有的试剂，`concentration_limit` 不放行**（发布前外部验收，BLOCKER-2）。
> 它原来把「没有这条规则可查」渲染成 ✅——验收者一句话点破：
> 「『我查了，没有针对这个试剂的规则』和『我查了，通过了』在输出里是同一个符号」。
> 现在它拦下来并说明理由是「没有规则可查」而不是「超标」，**一个阈值都没有编造**。
> 另外浓度百分比 > 100 一律拦（物理上不存在，与限值表无关）。
>
> **`concentration_limit` 与 `biosafety` 从 V25 起不再恒空转，但覆盖是部分的、边界明确**：
> `concentration_limit` 只在**同一子句里恰好点名一种试剂**时才吃得到浓度（例如
> 「配制10%次氯酸钠溶液」）——同一子句出现两种及以上试剂、或浓度描述和试剂名分处
> 不同分句（例如「配制次氯酸钠，浓度为10%」，两个逗号分开的分句），编译器不瞎猜
> 归属，这条规则仍然拿不到输入，仍是空转。`biosafety` 能挂到「这句话最终归属的步骤」
> （本句新建的步骤，或它作为续句合并进的上一步）；一句独立的生物安全描述、前面
> 没有任何步骤可挂时，同样拿不到输入。**跨句归属这种最常见的写法，两条规则目前都不认。**
>
> 兜底的是 `unconsumedWarnings`：现在只在解析失败或归属不了时才报（不再是全部场合），
> 编译产物会带出显式告警，CLI 的编译与审批输出**必须**显示它。口径不变——
> **「用户写了但安全门没看见」的内容绝不静默绿灯通过**。
>
> 这仍然是接物理设备的硬门槛：`concentration_limit` / `biosafety` 现在能接住的只是
> 「浓度/生物安全等级与目标试剂或步骤同句出现」这一类最简单的写法，更常见的跨句写法
> （先说试剂、后说浓度）依旧空转。在这个边界被继续收窄之前，本项目不对接真实 Opentrons
> （BACKLOG V6）。**过度声明的安全门比没有安全门更危险。**

---

## 六大功能域

| 域 | 做什么 | 主要入口 |
|----|-------|---------|
| **A 文献调研与写作** | 9 个文献源跨源检索去重入库、OA PDF 下载、结构化精读卡、综述草稿、BibTeX/CSL 导出 | `spark-research lit` |
| **B 实验验证** | 干实验：仿真平台适配（OpenMM / pyref），`design→dry_run→collect→analyze→conclude` 状态机，断点续跑<br>湿实验：自然语言协议 → Opentrons Python Protocol v2 → 安全门 → 人工 approve → 官方模拟器执行 | `spark-research exp` / `lab` |
| **C 全流程数据记录** | 9 类 record + 5 类边的证据图、artifact 版本与 lineage、时间线、**研究报告导出** | `spark-research report` |
| **D 创新性验证** | claim 提取 → 密集检索 → 对比报告 → **确定性评级校验层**（检索不到 ≠ 新颖） | `spark-research idea check` |
| **E 结论分析与 Review** | 引用真伪核验、数据-结论一致性、统计合理性提示、**结论卡 review 门槛** | `spark-research conclusion` |
| **F 远端算力**（v0.5 新增） | `plan → approve → run → collect` 的作业生命周期；plan 摘要审批（计费/联网/用密钥三者任一成立就要人点头）、逐文件上传清单与 sha256、产物收割与释放。**执行地目前只有 `local` 可用** | `spark-research compute` |

> ⚠️ **算力域的真实状态（如实说明）**：`local`（本机子进程）完整可用。
> **Modal 只交付了契约与录制层，真实 gateway 尚未实现——填了 token 也跑不起来**，
> `doctor` 会如实报 `unavailable` 并说明原因。SSH 是明确的占位槽位。
> 另外**算力产出目前不进证据图**（`compute collect` 收回的文件不注册成 artifact，
> 也不落 execution record），所以还无法基于一次算力运行写出能通过评审的结论。
> 两件都登记在 `docs/BACKLOG.md`，v0.5 的 W5-3 处理。

外部 agent 可以经 **MCP** 把整个工作台当工具箱接入（`spark-research mcp`），见下方「扩展与接入」。

界面上，CLI 与 HTTP API 是能力真源，Web 工作台是它们的投影（AD-7）——
UI 上出现的每个动作在 CLI/API 里都有对应入口，反之亦然（有对照测试守着）。

---

## 安装

三条路径的完整对比见 **[docs/INSTALL.md](docs/INSTALL.md)**。要点先说清楚：

> ⚠️ **三条路径都需要预装 Bun。** 代码用了 `bun:sqlite`（整个持久层）、`Bun.spawn`、`Bun.serve`，
> **在 node 下跑不起来**——所以 npm 包也只是把「clone 仓库」换成「npm install」，
> 该装的 Bun 一样得装。
>
> 唯一不需要预装运行时的是**单二进制**，v0.5 起它**深层命令也能用了**（V27 已修）：
> `project new` / `lit search` / `lit add` / `exp run` / `lab compile` / `compute` /
> `report export` / `chem depict` 都在干净目录里实测通过——**一条完整研究线索可以在
> 纯二进制上走通**，不需要 clone 仓库、不需要装 Bun。
>
> 二进制里**仍然不可用的两处**（V43，如实列出）：`server` 起得来但没有前端产物；
> `new skill|connector|platform` 与 `ext verify --kind platform` 已改成**显式拒绝**
> （而不是静默做错），只在源码 checkout 可用。
> Python 相关能力（openmm / scanpy / pydeseq2 / cobrapy / opentrons / rdkit）仍需自己装依赖，
> `doctor` 会逐档告诉你缺什么、装哪条命令。

下面是推荐路径（源码）。需要 [Bun](https://bun.sh) ≥ 1.3 与 Python ≥ 3.11。

```bash
git clone <repo> && cd spark-research
bun install

# Python 侧（干实验仿真 + 湿实验模拟器）。依赖清单见 pyproject.toml [dependencies]
uv venv --python 3.12 .venv
VIRTUAL_ENV=.venv uv pip install numpy pandas jupyter-client ipykernel pytest
VIRTUAL_ENV=.venv uv pip install openmm      # 可选：OpenMM 干实验平台（pyref 零依赖，不装也能跑）
VIRTUAL_ENV=.venv uv pip install opentrons   # 可选：湿实验真模拟器（默认后端；会把 numpy 钉到 1.26.x）

bun run build:web                                  # Web 工作台（构建产物不入 git）
```

配置模型（BYOK，模型无关）：

```bash
spark-research auth          # 交互式写入 ~/.spark-research/config.json
# 或直接给环境变量
export OPENROUTER_API_KEY=…  # 默认路由，默认模型 moonshotai/kimi-k2.6
export KIMI_API_KEY=…
```

带 key 的文献源（如 AMiner）走凭据服务，**凭据只在 daemon 进程内**，
存在 `~/.spark-research/credentials.json`（0600），永不进入 kernel/env/prompt（AD-2）。

**这些 key 一律自备（BYOK）**：仓库不附带任何可用凭据，AMiner 等源需要你自己去申请。
没配 key 的源在检索结果里显示为 `skipped` 并附配置指引（**不是静默返回空**）；
key 失效则上游 401 会如实报成 `failed`。

---

## 快速开始

一条完整研究线索（就是下面这些命令，`scripts/demo-research-thread.ts` 把它们串成了可重放演练）：

```bash
# ① 建项目 —— 项目描述就是你的研究问题，它会成为报告的第一节
spark-research project new 折叠预测 --description "端到端方法能否不依赖 MSA？"

# ② 文献调研入库（跨源检索 + 去重 + 分配 bibtex key）
spark-research lit search "protein structure prediction" --add
spark-research lit pdf <paper-id>            # OA PDF 下载
spark-research lit read --all                # 结构化精读卡
spark-research lit review --topic 折叠预测    # 综述草稿 + 引用真伪核验

# ③ 思路共探与新颖性核验
spark-research idea new -m "能不能完全丢掉 MSA？"
spark-research idea check <idea-id>          # → novel / incremental / existing（带最近邻）

# ④ 干实验闭环（真跑仿真，进程挂了能 --resume 接回来）
spark-research exp new "阻尼振子基线" --platform pyref --param steps=200
spark-research exp run <exp-id>              # dry_run → collect → analyze

# ⑤ 湿实验（安全门 → 人工批准 → Opentrons 模拟器）
spark-research lab compile "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD"
spark-research lab approve <exp-id> --actor 张三
spark-research lab simulate <exp-id>

# ⑥ 结论评审门槛 —— 只有 approved 的结论能进报告的「结论」区
spark-research conclusion list
spark-research conclusion review <conclusion-id> --actor 张三

# ⑦ 导出带证据链的研究报告
spark-research report export --out report.md

# Web 工作台
spark-research server                        # http://127.0.0.1:4321
```

亲手跑一遍完整演练（用录制的 cassette + fake 模型 + 真 pyref，零网络）：

```bash
bun scripts/demo-research-thread.ts
```

---

## 能力概览

**文献源（10）**：OpenAlex · CrossRef · EuropePMC · Semantic Scholar · PubMed · arXiv · bioRxiv ·
AMiner（需自备 key）· CNKI / 万方（占位，无公开 API）

> **默认集是七个**：`openalex` / `crossref` / `europepmc` / `semanticscholar` / `pubmed` /
> `arxiv` / `biorxiv` ——已实装的源默认全部参与检索，所以 `lit add <arxiv-id>` 直接可用
> （V34，v0.5 修复）。
>
> ⚠️ **两条要知道的**：`semanticscholar` 实测**匿名调用持续 429**，没配 key 时它会报
> `skipped`（不是静默返回空），所以它虽在默认集里但没 key 时不出结果；
> **`biorxiv` 的 `search` 不是真正的全文检索**——上游没有检索端点，connector 用
> 「最近 N 篇 + 客户端关键词打分」模拟，**查不到 ≠ 不存在**，用它的结果时要知道这一点。
>
> `aminer` 需自备 key、`cnki` / `wanfang` 是占位实现无公开 API，这三个默认不参与，
> 但**排除必须带理由**：`tests/unit/literature_source_parity.test.ts` 以连接器注册表为真源，
> 任何已实装且无需 key 的源不在默认集里就会让门禁变红。
> 这条门禁是 V34 的教训——当时 `lit search --sources arxiv` 能用、`capabilities` 也报可用，
> 只有默认值没跟上，而 AD-12 只核「在不在注册表」，核不了「在不在默认集」。
**科学 connector（非文献类 11，连接器总数 21）**：UniProt · PDB · AlphaFold · Ensembl · NCBI ·
CNCB · ChEMBL · PubChem · ClinVar · Reactome · STRING-DB
**仿真平台（5）**：OpenMM · pyref 纯 Python 参考实现 · scanpy（`sc-cluster`）·
pydeseq2（`bulk-de`）· cobrapy（`fba`）。`deterministic` 标签的口径见 BACKLOG **V49**——
后四个同机重跑逐字节一致，**但不保证跨机器 / 跨 BLAS / 换求解器**。
**湿实验后端（2）**：`opentrons_simulate`（默认，官方模拟器）· `mock_devices`（单测用）
**技能（13）**：literature-search · paper-download · library-curation · literature-review ·
idea-coexplore · novelty-check · protein-analysis · dry-experiment · wet-protocol ·
research-report · scanpy · pydeseq2 · cobrapy
**Reviewer 检查器（4）**：`citation-integrity` · `data-consistency` · `capability-labeling` ·
`stats-plausibility`（前三条出 hard，最后一条只出 soft 提示）

能力位会一路传到报告措辞里：证据来自非确定性平台就写「区间/趋势对账」而不是「逐位可复现」；
证据来自模拟执行（Opentrons 全 0.0 读数）就必须在结论里标注，否则检查器直接否决。

---

## 数据放在哪

```
~/.spark-research/
  state.json                      当前项目 + session→project 归属
  credentials.json                0600，仅 daemon 可读
  projects/<slug>/
    project.json                  项目元信息
    library.db                    文献库（论文/作者/标签/笔记/阅读状态）
    records.db                    证据图：9 类 record + 5 类边
    papers/                       PDF（不入 git）
    artifacts/                    产物 + artifacts.db（版本与 lineage）
    experiments/<platform>/       仿真状态真源：prepared/ 与 runs/
```

状态真源在磁盘，不在内存：编排进程死了任务还在，重启能接回来。

---

### 原始层、日志与导出（v0.7）

- **原始层 `raw/`（AD-15）**：每次 connector 调用（脱敏参数 + 原始响应体）、每次 LLM 调用（prompt 与响应原文）、
  每个 kernel 执行、每个设备读数，落 `raw/{connector,llm,kernel,device}/<date>.jsonl`，只追加不改，行内 prevHash 成链；
  >64KB 正文落 `raw/blobs/` 去重。默认开、只在本地；`config set rawLlm off` 可关（原文不可追溯，不建议）。
- **证据图日志 `records_journal`**：records 的每次 create/update/link/tombstone/repair 一行，`report records --history <id>`
  可看；完整性核验失败后 `report records --repair <id> --to-seq N --actor X` 署名重建。
- **来源分级三列**：每条 record 带 `provenanceClass`（upstream / derived / user_authored / model_generated）、`license`
  （SPDX 表达式）、`quality`。**AD-16：upstream 永不进入共享集合。**
- **导出 / 导入**：`spark-research data export [--for-sharing] [--since ts]` 把项目导成 Hive 分区 JSONL + `manifest.json`
  （share/schema/table 三级命名、DCAT 字段、每文件 sha256 与 rootHash、增量成链）；`data verify <dir>` 核完整性；
  `data import <dir> --project <新slug>` 原样重建到空项目。`--for-sharing` 把不可共享的 record 打成 stub 保边、
  上游 raw 与文献库不出门，排除计数写进 `manifest.excluded`。只有 JSONL，不做 Parquet；DuckDB 直查：

  ```sql
  SELECT type, count(*) FROM read_json_auto('export/*/records/**/*.jsonl', union_by_name=true) GROUP BY type;
  SELECT provenance_class, license, count(*) FROM read_json_auto('export/*/records/**/*.jsonl', union_by_name=true) GROUP BY 1,2;
  SELECT kind, count(*) FROM read_json_auto('export/*/raw/**/*.jsonl', union_by_name=true) GROUP BY kind;
  ```

## 测试

```bash
bun run typecheck        # tsc（后端 + 前端各一次）
bun test tests/unit/     # 单元 + 契约 + fixture 回放 e2e
bun test tests/integration/
bun run test:py          # pytest（仿真 kernel + Opentrons 后端）
bun run test:e2e         # Playwright 浏览器全流程（会自动构建前端）
bun run check:llms       # llms.txt 是否与当前文档同步
```

LLM 与网络在测试里一律走 fake / 录制回放，**没有一条 CI 路径打真实模型或外部 API**。
唯一的例外是 `scripts/measure-citation-judge.ts`（真实模型判准率测量），它单独跑、不进 CI。

---

## 扩展与接入

六个扩展点，每个都有契约 + 最小可运行示例 + 测试方法 + 文件位置：**[docs/EXTENDING.md](docs/EXTENDING.md)**。

| 扩展点 | 位置 | 加一个新的要写什么 |
|--------|------|------------------|
| Skill | `backend/src/skills/<name>/SKILL.md` | 带规范化 frontmatter 的说明 + 配套验证（AD-5：`validation` 字段由 CI 去磁盘核对） |
| Connector | `backend/src/connectors/` | 一份 `HttpConnectorConfig`；要 key 就走 CredentialStore（AD-2） |
| 仿真平台 | `backend/src/simulation/<id>/` | 实现 `SimulationPlatform`，**直接复用现成契约测试套件当验收** |
| 湿实验后端 | `backend/src/lab/wet_backend.ts` | 同设备族即插即用；换设备族按 EXTENDING 第 4 节的五步施工说明 |
| 安全门规则 | `backend/src/lab/safety.ts` | 一个纯函数 + 一条对抗单测 + 一条阴性对照 |
| Prompt 与模型路由 | `backend/src/agents/prompt/` | 双层 prompt（core + workflow），子代理可配独立模型 |

三个扩展点有脚手架，生成的测试桩当场能跑（CI 里真跑一遍）：

```bash
spark-research new skill <name>
spark-research new connector <name> [--with-key]
spark-research new platform <name>
```

### 能力自描述

```bash
spark-research capabilities            # 人看的表格
spark-research capabilities --json     # agent 看的清单：schema + 可用性状态
spark-research capabilities --probe    # 真去探测 openmm / opentrons 装没装
```

清单**从真实注册表生成**（有双向一致性测试守着），不是手写的。你接进来的东西注册之后自动出现。

### 并发使用与会话绑定（v0.7）

多个终端/agent 同时用一个数据目录时，每个终端先 `export SPARK_RESEARCH_SESSION=<任意名字>`，再
`spark-research project use <slug>` 只绑定本会话（不改全局指针；`--global` 才改）。项目解析顺序：
`--project` > env `SPARK_RESEARCH_PROJECT` > 会话绑定 > 全局指针；全局指针的写入带文件锁。不设会话 id 时
`project use` 退化为改全局指针（有提示）——并发场景请一律带 `--project`。

### 用户配置

`~/.spark-research/config.json` 是配置真源，优先级 **环境变量 > config.json > 默认值**：

```bash
spark-research config list       # 每一项都写清「当前值 / 来源 / 改了影响什么」
spark-research config set contactEmail you@lab.edu
```

凭据与设置同文件，但 `config list` 只显示「已设置 / 未设置」，值永不打印。

### 作为 MCP 工具箱接入外部 agent

```bash
spark-research mcp    # stdio 传输
```

```json
{ "mcpServers": { "spark-research": { "command": "spark-research", "args": ["mcp"] } } }
```

暴露 **30** 个工具（检索 / 文献库 / 思路 / novelty / 实验 / 记录 / 结论 / 报告 / 算力 / 化学），
并**刻意扣留 8 个**（`lab_approve` / `lab_reject` / `lab_simulate` / `conclusion_review` /
`project_archive` / `compute_approve` / `compute_run` / `compute_release`）——
花钱与碰物理世界的动作不做成工具，`capabilities` 对每一条都给出扣留理由与人该敲的命令。
接入后第一步调 `research_capabilities`。

**`lab approve` / `lab reject` / `lab simulate` / `conclusion review` 刻意不暴露为 MCP 工具**：
若外部 agent 能自己批准，它就能自己编译协议、自己批准、自己执行，approve gate 退化成注释（AD-6）。
`lab_compile` 会停在 `awaiting_approval` 并在返回体里写清「需要人执行哪条命令」。
这条边界有结构性测试守着——遍历全部已暴露工具的请求构造，断言没有一个能打到审批类端点。

### 给外部 LLM 读的文本

[`llms.txt`](llms.txt)（索引）与 [`llms-full.txt`](llms-full.txt)（全量文档 + 技能手册 + MCP 工具描述），
由 `bun run gen:llms` 生成，幂等且有 CI 门守着与文档同步。

---

## License

Apache 2.0
