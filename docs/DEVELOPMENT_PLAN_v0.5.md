# Spark Research v0.5.0 开发方案

> 制订时间：2026-09-10（PDT）· 起点：`main` v0.4.0（`ebcf118`）
> 输入：`~/Desktop/AI4S/spark-research-v0.5-plan/`（独立规划目录，**未入库**）——
> 含 OpenScience v2.0.86 源码级对比、远端算力设计、29 个 staged connector、154 个 staged skill、provider 情报
> 本文是 v0.5 的**施工真源**；规划目录是**素材库**，两者分工见 §0.2

---

## 〇、起点与定位

### 0.1 一句话

**v0.4 把「agent」两个字变成了真的，v0.5 做两件事：把算力送出本机，把「少而深」这条路
在有 183 个候选摆在面前时仍然走住。**

第二句才是这一版真正的难点。

### 0.2 规划目录已经产出了什么，以及它不是什么

| 产出 | 数量 | 状态 |
|---|---|---|
| staged connector | **29 个** | 结构测试 201 pass / tsc 干净；**fixture 未录、真实网络未验** |
| staged skill | **154 个** | 目录完整、frontmatter 全过真 parser；**功能未验、无生产入口** |
| 远端算力设计 | COMPUTE_DESIGN.md | 含上游源码逐条引用 + 7 个实施切片 |
| provider 情报 | PROVIDER_QUIRKS / V05_PROVIDER_DESIGN | 已反哺 v0.4 的 P11 |

**这是弹药库，不是排期承诺。** 规划目录自己写得很清楚：「154 个 staged 是弹药库不是排期承诺」。
本方案把这句话当硬约束执行——见 §2。

### 0.2·补 · 资源清点（2026-09-10 实测）

**规划目录体量 70M，其中 66M 是 upstream/openscience 只读参考克隆**（Apache 2.0，main @ 2026-09-10）。
真正的自产素材约 4M：

#### 29 个 staged connector

```
arrayexpress bindingdb biogrid biorxiv chebi clinvar dbsnp depmap expression-atlas
geo gnomad gtex gtopdb hpa intact interpro kegg mygene myvariant ncbi-gene
opentargets pdbe reactome sifts single-cell-atlas string-db surechembl ucsc wikipathways
```

| 维度 | 实测 |
|---|---|
| 需凭据 | **仅 biogrid 1 个**，其余 28 个免 key |
| 验证状态 | 结构测试 201 pass / 0 fail + `tsc` 干净；**fixture 未录、真实网络未验** |
| **主机合池风险（V26）** | **ncbi.nlm.nih.gov 4 个**（clinvar/dbsnp/geo/ncbi-gene）· ebi.ac.uk 系 4 个。加上仓库已有的 pubmed，**NCBI eutils 单主机就有 5 个消费方** |
| 已知红旗 | WikiPathways 实测 403；KEGG 学术免费/商业收费/3 req/s；COSMIC 需注册 |

> **V26 的紧迫性被这份清点抬高了**：connector 层至今**没有任何限速器**，只有礼貌头。
> 一旦这批集成，NCBI 单主机会有 5 个消费方各自打各自的——限速器必须**按 host 键控合池**，
> 而不是每个 connector 自己限自己。这条要排进 C2 的第一批，**先于任何 NCBI 系 connector 集成**。

#### 154 个 staged skill

| 域 | 数量 | 形态 |
|---|---|---|
| experiment | **105** | 平台型 29 个（走 `SimulationPlatform`）· 带 scripts 97 个 |
| literature | 28 | |
| report | 15 | |
| ideation | 6 | |

**依赖分布**：约 125/158 行的 connector 字段是 `—`——**大多数技能不依赖 connector**，
靠 kernel 脚本干活。这对集成节奏是好消息：技能与 connector 两条线**耦合比预想的松**，
可以各自按拉动推进，不必等对方。

**目录总账**：313 全量盘点 = SKIP(初判) 143 + staged 154 + SKIP(细判) 9 + 折并 1。
每个 SKIP 都有书面理由。

#### 其余资源

| 资源 | 内容 |
|---|---|
| `workstreams/compute/COMPUTE_DESIGN.md` | 远端算力设计，含上游源码逐条引用 + 7 个实施切片 + 风险表 |
| `workstreams/provider/`（4 份） | PROVIDER_INTEL · **PROVIDER_QUIRKS（已在 v0.4 反哺 P11）** · V05_PROVIDER_DESIGN |
| `upstream/openscience/` | 只读参考克隆，**不入库** |
| 集成候选提案（5 条） | 见 BATCH_ROLLUP：方程发现须 held-out 验证的确定性规则 · C0/C1 算力分层 · base.ts per-tool content-type · `registerCustom()` 作近期桥 · **湿实验技能一律汇入 wet-protocol 现有审批门，禁止平行审批通道** |

> 最后那条提案（禁止平行审批通道）**应该直接写进 `EXTENDING.md` 的技能规范**，
> 而不是等某个技能集成时才想起来——它是 AD-6 在技能层的推论。

### 0.3 v0.4 完成之后，依赖图全清

规划目录的依赖表写于 v0.4 在飞时，列了 8 处「等 P11/P12/P15/P16 落地」。**这些约束现在全部解除**：

| 原约束 | 现状 |
|---|---|
| C1 CB-5 审批接线等 P12 ToolBus | ✅ ToolBus 已交付，且 P12 **专门为「计费型后果动作」预留了计价维度接口**（不硬编码 token） |
| C1 预算上报等 P13 帧级记账 | ✅ `agent_run` record 已落图 |
| C2 集成等 P15 manifest + ext verify | ✅ 已交付，**但边界比预期窄**（见 §2.2） |
| C3 集成等 R-d 的 AD-5 收紧判据 | ✅ 技能可达性门禁已在 CI |
| C4 embedding 等 P11 provider 抽象 | ✅ `llm/types.ts` 三件套已就位 |
| 附线 V15 删别名等废弃周期 | ✅ v0.4.0 已发布，周期走完（别名仍在 `base.ts:180-186`） |

**所以 v0.5 的约束不再是依赖，是容量与审查带宽。**

---

## 一、闸门 F：v0.5 开工前必须清的四件事

> 与 v0.3 的闸门 D、v0.4 的闸门语义相同：**不清完不开新功能**。
> 但这次四件里有三件是「v0.4 欠的」与「有 deadline 的」，不是技术债。

| # | 项 | 为什么必须在前面 |
|---|---|---|
| **F-1** | **补跑三次零上下文外部验收** | v0.4 方案要求 W2/W3/W4 末各一次，**一次都没跑**。这是本项目信噪比最高的检验——v0.2.1 的三个真实摩擦点就是这么发现的。**第二次必须由未参与开发的人/会话执行**。v0.5 引入远端算力（真花钱）与大批扩展之前，先知道当前的外部体验有多少摩擦 |
| **F-2** | **AMiner key 续期（2026-10-07 到期）** | 运维项，**有硬 deadline**。过期后中文文献检索直接 401，AMiner 是中文主路径 |
| **F-3** | **V15 删 deprecated 别名** | v0.4 §2.2 明文「走废弃周期到 v0.5」。`MCPConnector` / `MCPConnectorConfig` / `MCPTool` 三个别名（`base.ts:180-186`）。**breaking change，进 CHANGELOG** |
| **F-4** | **V27 定性：修还是永久降级** | 单二进制只有浅层命令可用。v0.4 按用户决定不修。v0.5 要么修（23 处资产加载），要么**把「不发单二进制」写成永久承诺**并从 INSTALL.md 移除该路径。**不许再挂一版** |

**F-1 的产出直接影响 §2 的选择**：外部验收暴露的摩擦点，优先级高于任何 staged 素材。

---

## 二、核心难题：183 个候选摆在面前，怎么不重演铺量

### 2.1 数字先说清楚

当前仓库：**17 个 connector，11 个技能**。
规划目录：**29 个 staged connector，154 个 staged skill**。

如果全部集成，connector 变 46（正好追平 OpenScience），技能变 165。
**这恰恰是 AD-5 当初立下来要避免的形态**——评审对 OpenScience 的判语是「313 技能质量参差」。

规划目录的纪律是「每迭代 2–3 个」。但 154 ÷ 2.5 ≈ **62 个迭代**。
那不是排期，是把「以后再说」写成了看起来像计划的样子。

### 2.2 所以 v0.5 的选择原则：需求拉动，不是队列消费

**硬规则三条**：

1. **只集成有真实拉动的**。拉动 = ① F-1 外部验收暴露的缺口，② 用户当前课题真的要用，
   ③ 已集成能力的**明确短板**（如 kegg 缺 conv/link 让某条链路断掉）。
   **「它在 staged 里且看起来有用」不是拉动。**
2. **v0.5 的集成上限：connector ≤ 8，技能 ≤ 8**。写死数字不是为了保守，是为了逼出选择——
   没有上限时「再加一个」永远是最省事的决定。
3. **每个集成物必须过 v0.4 建的三道门**：AD-5 收紧版（e2e + 可达生产入口 + 进 capabilities）、
   `ext verify` 的 100 并发参数映射不变式、以及**存储层写入方门禁**（如果它带存储）。
   **过不了就不集成，不是"先合了再补"。**

### 2.3 优先候选（待 F-1 结果调整）

规划目录建议「先集成与已 staged connector 即插即用的」。结合 v0.4 的实测边界：

| 类别 | 候选 | 理由 |
|---|---|---|
| connector（选 ≤8） | clinvar · biorxiv · opentargets · reactome · string-db（后三个同时补能力缺口） | 生物医药是用户的实际方向；这五个能支撑 database 类技能 |
| 技能（选 ≤8） | **平台三件套 scanpy / pydeseq2 / cobrapy** 优先 | 规划目录实测它们的接线点 `simulation/registry.ts` 存在且不属任何 lane；它们走 `SimulationPlatform` 契约，**AD-4 的两实现投资第三次回本** |

> ⚠️ **W3-d 的实测边界要带进 C2**：manifest 的声明式路径只覆盖
> 「**JSON 响应 + 单次请求**」的源。XML 归一化结构上表达不了；多跳请求没有原语。
> 规划目录写的「集成时优先评估走 P15 声明式 manifest」要按这条判据先分流，
> **别在不可能的源上耗时间**。

---

## 三、主线 C1：远端算力（关键路径）

设计已完成（`workstreams/compute/COMPUTE_DESIGN.md`，含上游源码逐条引用）。本方案只记**排期与接线**。

### 3.1 七个切片与依赖

| 切片 | 内容 | 依赖 |
|---|---|---|
| CB-1 | 契约先行：lifecycle 三轴状态机 + Plan schema + Target/Adapter 接口 + 穷举转移测试 | 无 |
| CB-2 | local adapter：把「本地子进程 + 磁盘真源」重述成第一个 `ComputeAdapter` | CB-1 |
| CB-3 | 上传面：deny-list / 限额 / sha256 / preflight 重验，纯函数层单测 | CB-1 |
| CB-4 | Modal adapter：run/recover/collect/release 四路 + ownership tags | CB-1，**需用户提供 Modal token** |
| **CB-5** | **审批接线**：plan digest → decision record → 一次性消费 → 执行前重验 digest | ToolBus ✅ |
| CB-6 | SimulationPlatform 对接（可选路径） | CB-4 |

### 3.2 CB-5 是这条主线的重心，不是 CB-4

**远端算力是 spark 遇到的第一类「计费型后果动作」**——提交一个 Modal GPU 任务 = 花真钱。
这与湿实验的物理后果同构，所以必须复用同一套已验证的机制：

- **`compute approve` 进 `MCP_WITHHELD`**——AD-14 的对抗测试天然覆盖（子代理永不自批准）
- **digest 一次性消费**——照 v0.3.0 D-10 给湿实验做的 approval 消费语义，
  **重跑必须重新审批**，崩溃重启后也不例外
- **审批要求可交互终端**——V19 已在 v0.4 落地（`isTTY` 是内核层属性，piping 绕不过），
  算力审批直接复用
- **预算走 ToolBus 的计价维度**——P12 **专门为此预留过接口**（`ToolCallCost { unit }`，
  不硬编码 token），v0.5 只需加一个 `unit` 值与真实数字

> **这条主线的成败判据不是「Modal 能跑起来」，是「花钱这件事被人批准过、批的是哪一版、
> 批了几次、花了多少」全部可查。** 前者是集成工作，后者才是这个项目的立身之本。

### 3.3 验收

一条真实 OpenMM MD 任务在 Modal GPU 上跑通：
plan → 审批（digest 一次性消费）→ 派发 → **本地进程 SIGKILL** → 重启后 recover 收割 →
observation record 进证据图。契约测试由 local adapter 承担（**CI 零凭据可跑**）。

---

## 四、其余主线

### C4 · embedding 抽象 + novelty 语义化

**这是 v0.5 唯一直接提升既有能力可信度的项。**

现状风险（post-v0.3 已知）：novelty 相似度是**词面匹配**，阈值 0.75，
**标定样本只有 2 个 claim**，最近邻余量 0.08。

做法：
1. `llm/` 加 embedding provider 抽象（复用 P11 的 provider 适配层形态）
2. novelty 的相似度换成 embedding
3. **重标定阈值**：标定集扩到 **≥20 claim**，含已知 novel / existing 双向对照
4. AD-8 不变：**模型原判与校正后评级都留在产物里**

### C5 · 内联科学视图（先做零依赖那条）

- **② SMILES → 2D 结构图**：走 kernel 侧 RDKit 出 SVG → artifact 通道，**零前端新依赖**。先做这条。
- ① PDB/mmCIF 3D 查看器：需引入 3Dmol.js/NGL（前端目前只有 solid-js/vite）。
  **做完 ② 再评估**——AD-7 的前端纪律是「产物不入 git、依赖要克制」。

验收：UI 与 CLI 行为对照进 `ui_cli_parity.test.ts`；Playwright 各加一条。

### 附线 · BACKLOG 清扫（38 条存活）

规划目录点名的碎项：V3 · V8 · V9 · V13 · V14 · V21 · V24。
加上 v0.4 新增的 V25 · V27 · V29 · V30 · V31 · V32。

**纪律：v0.5 评审时逐条决定「吸收」或「明确不做」，不许悬着。**
其中三条有特殊分量：

- **V25**（安全门 concentration/biosafety 字段兑现）——**物理 Opentrons 的硬前置**。
  v0.5 至少把编译器产出字段做实，否则 V6 永远开不了工
- **V31/V32**（外部 MCP 调用记录进证据图）——「外部工具调用天然进 provenance」
  这个相对 OpenScience 的差异化点**目前只兑现一半**。接上或撤下宣称，二选一
- **V21**（超时环境变量前缀统一）——breaking，与 F-3 同批走废弃周期

---

## 五、波次调度

> 沿用 v0.4 验证有效的形态：**任务级依赖 + 波次并行 + 收口串行**。
> 四条 lane 上限不变——瓶颈是审查带宽，不是算力。

```
闸门 F（串行，不可并行）
  F-1 三次外部验收 · F-2 AMiner key · F-3 删别名 · F-4 V27 定性
        │
        ▼
W5-1 ─┬─ α  C1 CB-1/CB-2/CB-3（契约 + local adapter + 上传面）  ← 关键路径起点
      ├─ β  C4 embedding 抽象 + novelty 重标定
      ├─ γ  C5-② SMILES→SVG（kernel 侧，零前端依赖）
      └─ δ  附线：V25 安全门字段兑现（物理设备硬前置）
        │
        ▼
W5-2 ─┬─ α  C1 CB-4 Modal adapter（需 token）
      ├─ β  C1 CB-5 审批接线（digest 一次性消费 + MCP_WITHHELD + TTY）
      ├─ γ  C2 connector 集成第一批（≤4，按 F-1 结果选）
      └─ δ  附线：V31/V32 外部 MCP 记录进证据图
        │
        ▼
W5-3 ─┬─ α  C1 CB-6 + 真实 Modal e2e（SIGKILL → recover）
      ├─ β  C3 技能集成第一批（平台三件套优先）
      ├─ γ  C2 connector 第二批（≤4）
      └─ δ  runtime contract + Python SDK
        │
        ▼
收口 + 发布 v0.5.0
```

**关键路径**：F → CB-1/2/3 → CB-4 → CB-5 → 真实 e2e。其余全部绕开它并行。

### 5.1 枢纽文件（本版起延续 v0.4 的规矩）

从所有 lane 摘出，**收口统一接线**：
`backend/src/index.ts` · `mcp/tools.ts` · `capabilities/**` · `agents/orchestrator.ts` ·
`agents/toolbus.ts` · `server/app.ts` · `connectors/registry.ts` · `literature/normalize.ts` ·
`tests/unit/narrative_parity.test.ts`（只许加/删登记条目，不许动断言逻辑）。

v0.4 实测：不这么做的代价是 `index.ts` 冲突三次、**六个「建好但没人喂」**。

### 5.2 五条并行纪律（v0.4 实测有效，原样沿用）

1. **spawn 前 cd 回中立目录**（主仓）——子代理继承 cwd，错配会和隔离规则组合成
   一个看似合理的错误推论。在 brief 第一行写 `cd` **不足以解决**（v0.4 试过，照样触发）
2. **枢纽文件收口专属**（§5.1）
3. **阴性对照强制**——每条关键测试都要验证「回退实现会红」，终端输出写进 devlog
4. **「等接线」登记**——新建但无权接线的模块自己登记 `ALLOWED_ORPHANS`，收口接上后按对称检查删除。
   v0.4 里 7 个模块走完了这个生命周期，**两次抓到主会话本人**
5. **多 lane 必走 integration 分支**——各 lane 自己全绿、合起来红是常态

**加一条 v0.4 学到的**：

6. **别信 lane 的自报数字。** 主会话要独立重跑关键阴性对照与线格式探针。
   v0.4 里主会话独立复验抓到的真 bug 包括：二进制是另一个运行时、循环 import 让 CLI 崩溃、
   **记账 record 废掉了防烧钱的停机条件**（所有测试仍然绿，只有一个数字从 1 变 2）。

---

## 六、验证方案

### 6.1 阶段门（每波每条 lane，无例外）

沿用 v0.4 的六套件：`typecheck` · `tests/unit/`（基线 **1396**，0 fail / **0 skip**）·
`tests/concurrency/` + `tests/timeout/` · **`bun run test:e2e`** · `test:py` · `test:lab`。

### 6.2 v0.5 新增的两条

| 新增 | 为什么 |
|---|---|
| **算力契约测试由 local adapter 承担** | CI 零凭据可跑（照 pyref 对 OpenMM 的先例）。**Modal e2e 用录制回放** |
| **每个新集成物过三道门**（AD-5 收紧版 / `ext verify` 并发不变式 / 存储层写入方） | §2.2 的硬规则三。**过不了就不集成** |

### 6.3 零上下文外部验收：v0.5 跑三次，且这次真跑

| 时点 | 任务 |
|---|---|
| **闸门 F**（开工前） | 当前状态基线——摸清 v0.4 交付的外部体验有多少摩擦 |
| W5-2 末 | 提交一个远端算力任务并读回结论（**含审批流程**） |
| 发布前 | 干净机器完整链路 |

**第二次必须由未参与开发的人/会话执行。** v0.4 三次一次没跑，v0.5 不重演。

---

## 七、明确不做

| 不做 | 理由 |
|---|---|
| SSH adapter 实现 | 只留 Host schema 与槽位；上游 1800 行，等真实需求 |
| 物理 Opentrons | **V25 安全门字段兑现是硬前置**；兑现后单独立项 |
| 多用户真实身份 | v0.5 算力仍是单用户自己的账户，不触发 |
| 313 skill 全量移植 / connector 全量对齐 | §2.2 的上限：connector ≤8、技能 ≤8 |
| 基因组浏览器 · 桌面 Electron 壳 | 用户方向暂不需要 |
| 追平 OpenScience 日更节奏 | **总线因子 1，拼速度必败**（v0.3 评审的战略结论未变） |

---

## 八、风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **弹药库诱惑**：154 个 staged 摆在那里，"再加一个"永远最省事 | 重演铺量，AD-5 失守 | §2.2 写死上限 + 需求拉动判据；**集成数不是 KPI** |
| Modal 真实计费失控 | 花真钱 | CB-5 先于 CB-4 的真实 e2e；预算走 ToolBus；**审批要 TTY** |
| staged 素材未经真实网络验证 | 集成时批量返工 | 每个集成物先录 fixture 再合；规划目录已标 `UNTESTED` |
| manifest 边界比预期窄（W3-d 实测） | C2 集成路线判断错 | 先按「JSON + 单请求」分流，不可能的源直接走 TS 扩展 |
| embedding 重标定样本不足 | novelty 仍不可信 | 标定集 ≥20 claim 是硬要求，含双向对照 |
| 外部验收再次被跳过 | 又一版没有真验收 | **写进闸门 F**，不是尾部可选项 |

---

## 九、给维护者

v0.4 证明了一件事：**并行开发在这个仓库可行**，而且那套「失败长得像成功」的防御
（五道门禁 + 强制阴性对照 + 等接线登记）真的在抓东西——包括抓主会话自己。

v0.5 的技术难点是远端算力，但**真正的考验是 §2**：当 183 个做好的候选摆在面前，
还能不能守住「少而深」。

这个项目对 OpenScience 的全部差异化——证据图、确定性校验层、契约化验收、
完成判定问图不问模型——都建立在「每一样东西都被验过」这个前提上。
**集成一个没验过的技能，损失的不是那个技能，是那个前提。**
