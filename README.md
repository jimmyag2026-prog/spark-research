# Spark Research

**面向科研人群的开源科研工作台。** 用自然语言驱动一个可审计的研究代理，走完
「文献调研 → 思路共探 → 实验验证 → 数据记录 → 创新性核验 → 结论评审 → 报告」的完整循环，
全过程本地优先、证据可溯源。

> 一句话主张：**你的研究项目是一等公民，每一步思考和实验都留下可审计的证据链。**

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

> ⚠️ **安全门当前的真实覆盖范围**（v0.3.0 起如实写在这里，不再只说「四条规则」）：
> 四条规则里**只有 `volume_capacity` 在自然语言主管线上全程可信**。
> `chemical_compatibility` 的试剂词表已扩到中英文与常见分子式，但仍然是有限词表；
> **`concentration_limit` 与 `biosafety` 在自然语言主管线上仍然空转**——协议编译器
> 目前产不出它们所需的 `concentration` / `biosafetyLevel` 字段（规则本身有对抗测试，
> 但真实入口喂不进那种输入）。
>
> 兜底的是 `unconsumedWarnings`：协议里出现了量纲/试剂/条件、却没有被任何规则消费的，
> 编译产物会带出显式告警，CLI 的编译与审批输出**必须**显示它。口径是——
> **「用户写了但安全门没看见」的内容绝不静默绿灯通过**。
>
> 这也是接物理设备的硬门槛：在 `concentration_limit` / `biosafety` 补齐之前，
> 本项目不对接真实 Opentrons（BACKLOG V6）。**过度声明的安全门比没有安全门更危险。**

---

## 五大功能域

| 域 | 做什么 | 主要入口 |
|----|-------|---------|
| **A 文献调研与写作** | 9 个文献源跨源检索去重入库、OA PDF 下载、结构化精读卡、综述草稿、BibTeX/CSL 导出 | `spark-research lit` |
| **B 实验验证** | 干实验：仿真平台适配（OpenMM / pyref），`design→dry_run→collect→analyze→conclude` 状态机，断点续跑<br>湿实验：自然语言协议 → Opentrons Python Protocol v2 → 安全门 → 人工 approve → 官方模拟器执行 | `spark-research exp` / `lab` |
| **C 全流程数据记录** | 8 类 record + 5 类边的证据图、artifact 版本与 lineage、时间线、**研究报告导出** | `spark-research report` |
| **D 创新性验证** | claim 提取 → 密集检索 → 对比报告 → **确定性评级校验层**（检索不到 ≠ 新颖） | `spark-research idea check` |
| **E 结论分析与 Review** | 引用真伪核验、数据-结论一致性、统计合理性提示、**结论卡 review 门槛** | `spark-research conclusion` |

外部 agent 可以经 **MCP** 把整个工作台当工具箱接入（`spark-research mcp`），见下方「扩展与接入」。

界面上，CLI 与 HTTP API 是能力真源，Web 工作台是它们的投影（AD-7）——
UI 上出现的每个动作在 CLI/API 里都有对应入口，反之亦然（有对照测试守着）。

---

## 安装

需要 [Bun](https://bun.sh) ≥ 1.3 与 Python ≥ 3.11。

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

**文献源（9）**：OpenAlex · CrossRef · EuropePMC · Semantic Scholar · PubMed · arXiv ·
AMiner（需 key）· CNKI / 万方（占位，无公开 API）
**科学 connector（8）**：UniProt · PDB · AlphaFold · Ensembl · NCBI · CNCB · ChEMBL · PubChem
**仿真平台（2）**：OpenMM（`deterministic=false`）· pyref 纯 Python 参考实现（`deterministic=true`）
**湿实验后端（2）**：`opentrons_simulate`（默认，官方模拟器）· `mock_devices`（单测用）
**技能（10）**：literature-search · paper-download · library-curation · literature-review ·
idea-coexplore · novelty-check · protein-analysis · dry-experiment · wet-protocol · research-report
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
    records.db                    证据图：8 类 record + 5 类边
    papers/                       PDF（不入 git）
    artifacts/                    产物 + artifacts.db（版本与 lineage）
    experiments/<platform>/       仿真状态真源：prepared/ 与 runs/
```

状态真源在磁盘，不在内存：编排进程死了任务还在，重启能接回来。

---

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

暴露 24 个工具（检索 / 文献库 / 思路 / novelty / 实验 / 记录 / 结论 / 报告）。
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
