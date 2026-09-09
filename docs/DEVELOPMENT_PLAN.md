# Spark Research v0.2 开发与验证计划

> 状态：随 [DESIGN.md](DESIGN.md) 定稿 · 2026-09-09
> 原则：每阶段一个分支一个 PR，squash merge；测试只增不减；每阶段留 devlog；先验证后进入下一阶段。

---

## 〇、工程纪律（全阶段生效）

1. **分支流**：`main` 不直推。每阶段开 `feat/p<N>-<slug>` 分支 → PR → squash merge → 删分支。
2. **测试门槛**：进入 PR 前 `bun run typecheck` + `bun test tests/unit/` 必须全绿；新模块必须带单测；e2e 用 fixture 回放进 CI（真实网络请求只在本地验证跑，录制后回放）。
3. **devlog**：每阶段完成时写 `docs/devlog/P<N>-<slug>.md`：做了什么、关键决策、测试结果（含失败与修复）、与设计的偏差。
4. **凭据纪律**：任何凭据不进 repo/prompt/日志；新增文件 commit 前跑密钥 grep。
5. **模型分工**：设计与验收评审用 Fable 5（主会话）；实现类任务可委派 Opus 5 子代理，子代理产出必须经主会话审查 + 测试验证后才 merge。
6. **文档同步**：实现与设计出现偏差时，同 PR 内更新 DESIGN.md，不留漂移。
7. **工作树隔离**（P6 事故后新增）：子代理开发期间，主会话**不得**在主工作树做任何 git 操作（checkout/branch/commit）；主会话需要并行改动时用独立 worktree，或等子代理收尾。事故记录见 devlog P6。
8. **worktree 一律建在 `~/Desktop/AI4S/<repo>-<topic>`**（P7 事故后修正）：`~/Desktop/` 下的其他路径可能因沙箱策略在会话中途变为不可访问，导致未提交成果彻底丢失。
9. **阶段性成果及时保存**（P7 后新增，用户要求）：每完成一个逻辑块就 commit **并 push feature 分支**到远端。推送 feature 分支不违反「main 不直推」——合并仍走 PR + 主会话审查。遇到额度中断、环境故障时成果不丢。

---

## 一、阶段总览

```
P0 设计入库（本 PR）
P1 Project 基座 ──────────► 一切持久化的根
P2 文献域·检索与文献库 ────► 域 A 前半（A1/A2）
P3 文献域·综述与引用核验 ──► 域 A 后半（A3）+ 域 E 引用检查器
P4 Co-explore 与 Novelty ──► 域 A4 + 域 D
P5 干实验闭环 ─────────────► 域 B1/B3 + 域 C 实验记录
P6 湿实验模拟器 ───────────► 域 B2
P7 前端工作台 ─────────────► 时间线 + 项目导航 + 实验面板升级
P8 功能收口 ───────────────► 报告导出 + README + P8-gate 清偿 + 判据核验
P9 扩展面与 LLM 友好化 ────► EXTENDING + 脚手架 + capabilities + MCP + 发布 v0.2.0
```

依赖关系：P1 是所有阶段前置；P2→P3→P4 串行（同域递进）；P5、P6 可在 P1 后与文献域并行；P7 需要 P1-P5 的 API 稳定；P8 收口。

---

## 二、各阶段明细

### P1 Project 基座

**范围**
- `backend/src/project/`：Project 管理器（create/open/list/archive），目录布局 `~/.spark-research/projects/<slug>/`
- `records.db` schema：record 表（7 类型）+ 边表（5 边类型）+ 与 artifacts 互链（AD-3）
- 凭据服务：daemon 内 `CredentialStore`（`credentials.json` 0600 读写，按 connector id 取用；AD-2）
- CLI：`spark-research project new|list|open`；session 归属 project
- 现有 artifact store 迁移：`project` 字段从自由字符串变为真实 project 引用

**验证**
- 单测：project 生命周期、record CRUD、边一致性、凭据文件权限（0600 断言）、permit set 拦截 kernel 直读凭据
- e2e：CLI 建项目 → 会话产生 artifact + record → 重启进程 → 数据完整可查

**退出标准**：全部测试绿；devlog P1 落库。

### P2 文献域 · 检索与文献库

**范围**
- Connector 扩展：OpenAlex、CrossRef、EuropePMC、Semantic Scholar（免 key）；AMiner（走凭据服务，29 API 中先接 search/paper-detail 两个核心）
- 跨源统一检索：并发查询 → DOI/标题去重 → 归一化 Paper 模型
- Project Library：`library.db`（论文/作者/标签/笔记/阅读状态）+ PDF 下载管线（arXiv/EuropePMC OA 直下，403 降级策略）+ checksum
- 引文关系抓取（OpenAlex citations API）
- BibTeX / CSL-JSON 导出
- 技能：literature-search、paper-download、library-curation

**验证**
- 单测：去重逻辑（DOI 相同/标题模糊）、归一化、BibTeX 输出格式
- 本地真实 e2e：一次跨 5 源检索 + 2 篇 OA PDF 真实下载入库；请求响应录制为 fixture
- CI e2e：fixture 回放跑同一链路

**退出标准**：真实检索+下载 e2e 通过并录制；AMiner connector 在有 key 环境验证、无 key 环境优雅降级（明确报「未配置」而非报错）。

### P3 文献域 · 综述与引用核验

**范围**
- 精读卡 pipeline：库内论文 → 结构化卡片（record: paper 锚点）
- 综述草稿生成：基于精读卡组织，引用只允许指向库内论文
- Reviewer 新检查器：`citation-integrity`（草稿引用 ↔ 库内论文匹配；不匹配 = hard finding → veto）
- 技能：literature-review

**验证**
- 单测：citation-integrity 规则（真引用过 / 伪造引用 veto / 库外引用 veto）
- e2e：10 篇真实文献 → 综述 → 故意注入一条伪造引用 → Reviewer 必须抓到（对抗测试）

**退出标准**：对抗测试稳定通过（伪造引用检出率 100%，注入 3 种伪造模式：不存在 DOI、真标题假结论、库外真文献）。

### P4 Co-explore 与 Novelty

**范围**
- Co-explore 会话模式：批判性探讨 workflow prompt + 文献 grounding（观点必须带来源或标注 inferred）
- Idea 卡：产出、入库（record: idea）、支持/反对文献边
- Novelty pipeline：claim 提取 → 密集检索（复用 P2 统一检索）→ 对比报告（novel/incremental/existing 评级）→ 引用核验（复用 P3 检查器）
- 技能：idea-coexplore、novelty-check

**验证**
- 单测：claim 提取结构、报告 schema、评级逻辑
- e2e 双向对照：(a) 拿一个**已发表工作的核心 idea** 跑 novelty check → 必须评为 existing 且找到原文；(b) 拿一个**刻意杜撰的组合 idea** → 应评 novel/incremental 且给出最近邻

**退出标准**：双向对照 e2e 通过；Idea 卡在证据图中与文献正确连边。

### P5 干实验闭环

**范围**
- `SimulationPlatform` 接口（prepare/submit/poll/collect；AD-4）
- 参考实现 ×2：OpenMM（进程内）+ 第二实现（GROMACS 或纯 Python 仿真脚本，视本机环境定，devlog 记录选择理由）
- 闭环状态机：`design → dry_run → collect → analyze → iterate|conclude`，状态持久化（record: experiment）、断点续跑
- Kernel 集成：仿真产出自动进 artifact + observation record
- 技能：dry-experiment、protein-analysis（把现有蛋白 connector 链路补上技能与 e2e）

**验证**
- 单测：状态机转移全覆盖、断点恢复、adapter 契约 mock 测试
- e2e：OpenMM 最小 MD 任务（如水盒子平衡）端到端：设计 → 运行 → 数据回收 → observation 入图 → 中途 kill 进程 → 恢复续跑

**退出标准**：e2e 含断点恢复通过；两个 adapter 实现共用同一契约测试套件全绿。

### P6 湿实验模拟器

**范围**
- Opentrons 集成：`opentrons_simulate` 替换 `mock_devices.py` 作为默认湿实验后端（mock 保留用于单测）
- 协议编译目标：现有 protocol compiler 输出 → Opentrons Python protocol API v2 脚本
- approve gate 落地：湿实验执行前 CLI/API 强制确认（AD-6）
- 干湿闭环状态机接通：`dry_run → approve → wet_run → collect`
- 技能：wet-protocol

**验证**
- 单测：编译输出合法性（opentrons_simulate 解析通过即合法）、safety gate 拦截清单（超浓度/不兼容试剂/缺 approve 各一例）
- e2e：自然语言协议（「取样品 50µL 加入 96 孔板，37°C 孵育…」）→ 编译 → 安全门 → approve → 模拟器执行 → 执行日志入 record

**退出标准**：至少 2 个不同类型协议在真实 `opentrons_simulate` 下执行成功；safety gate 对抗样例全部拦截。

### P7 前端工作台

**范围**（2026-09-09 用户修订：UI 详细程度参考 OpenScience 工作台，非冒烟版）
- **第一步 API 层**（仍是重点）：P1-P6 全部能力补齐 HTTP API（project/lit/idea/exp/lab 端点 + SSE 会话流），server/app.ts 从 v0.1 形态升级；无 API 能力不许只存在于 UI
- **第二步 UI 升级为 SolidJS 工作台**（AD-7 的「到 P7 再迁」触发）：对标 OpenScience `frontend/workspace` 的体验水准与交互模式（本地 clone 可研究其组件组织/主题/会话流渲染，Apache 2.0 可参考但代码自研）：
  - 左：项目切换 + 文献库/思路库/实验导航树
  - 中：会话流（含 coexplore 模式）+ 精读卡/综述/novelty 报告的富渲染
  - 右：record 时间线（按类型/时间过滤）+ artifact/证据图浏览
  - 底：实验面板——干湿状态机可视化 + approve/reject 按钮（decision record 联动）
  - 明暗主题、键盘可用性、加载与错误态完整
- 科学渲染以轻量为限（表格/曲线/run log），分子/结构 3D 渲染排 v0.3

**验证**
- API 层：每个新端点单测（现有 server.test.ts 模式）
- e2e：浏览器全流程（建项目 → 检索入库 → 精读/综述 → idea/novelty → 干实验 approve→湿实验模拟 → 时间线完整呈现），Playwright 或等价
- UI 与 CLI 行为对照：同一操作两侧产生相同 record/artifact

**退出标准**：全流程浏览器 e2e 通过；UI 全部是 API 投影；体验对照 OpenScience workspace 无明显断档（会话流/导航/时间线三项主观验收由用户过目）。

### P8 收口发布 v0.2

**范围**
- 研究报告导出：证据图 → Markdown（问题/思路/实验/结论分区，结论卡 review 门槛生效）
- 技能：research-report
- README 重写（对齐新定位与五域）、DESIGN.md 终稿核对、CHANGELOG
- 发布判据核验：DESIGN.md §7 的 4 条逐条打勾，记入 devlog P8

**验证**：§7 成功标准即验收清单——特别是那条完整研究线索的全流程演练（文献 → idea → novelty → 干实验 → 结论 → 报告），作为最终 e2e 保存为可重放脚本。

**退出标准**：4 条判据全过。（2026-09-09 修订：tag 与 Release 移至 P9 末尾——发布必须带完整的扩展性故事。）

### P9 扩展面梳理与 LLM 友好化（2026-09-09 用户新增，发布前最后一阶段）

> 用户原话口径：梳理 skill / tool / connector 这些方便科研人员自己配置和修改的地方，并进行 LLM 友好的封装和适配。

**范围**

一、扩展面梳理（面向科研人员的自助配置）
- `docs/EXTENDING.md`：六个扩展点各一节，每节 = 契约说明 + 最小可运行示例 + 测试方法 + 文件放置位置：
  1. **Skill**（`backend/src/skills/<name>/SKILL.md`，规范化 frontmatter：name/description/triggers/所需 connector）
  2. **Connector**（Connector 契约 + 凭据经 CredentialStore，AD-2；免 key 与带 key 两个示例）
  3. **SimulationPlatform**（干实验平台，P5 契约测试套件直接复用作新平台的验收）
  4. **WetLabBackend**（湿实验执行端；含 V6 施工说明：非 Opentrons 设备族需把设备语言编译下沉进 backend）
  5. **安全门规则**（纯函数规则，加一条 = 一个函数 + 单测）
  6. **Prompt 与模型路由**（agents/prompt/*.txt 双层结构 + 每子代理独立模型配置）
- 脚手架：`spark-research new skill|connector|platform <name>` 生成带测试桩的模板
- 用户配置面收口：`~/.spark-research/config.json` 统一登记（默认模型、politeness header 的 mailto、backend 选择），文档写清哪些能改、改了影响什么

二、LLM 友好封装与适配
- **能力自描述**：`spark-research capabilities --json` 输出机器可读清单（全部 connectors/platforms/backends/skills/安全规则 + 各自的输入 schema 与可用性状态）——agent 一次调用即可 introspect 整个工作台
- **llms.txt + llms-full.txt**（对标 OpenScience docs 的做法）：纯文本全量文档，外部 LLM 可直接消化
- **SKILL.md 规范化**：统一 frontmatter schema，校验进 CI；agent 按需加载（技能目录 = LLM 的操作手册，不预填 context）
- **MCP server 模式**：`spark-research mcp` 把核心能力（lit search/library/idea/novelty/exp/lab/records）暴露为 MCP tools——任何外部 LLM agent（Claude Code、其他 MCP 客户端）可直接把 Spark Research 当科研工具箱接入。approve 类危险动作在 MCP 层保持人工确认语义
- 工具描述打磨：每个 MCP tool / API 端点的 description 按「LLM 第一次见就会用」标准写（参数示例 + 常见错误 + 何时不该用）

**验证**
- EXTENDING.md 六节各带的最小示例真实可跑（CI 里跑通示例 skill/connector/规则各一个）
- `capabilities --json` schema 校验 + 与实际注册表一致性测试（清单里的每一项真实存在）
- MCP server：用 MCP 客户端真实连接跑通 lit search → idea → novelty 链路的 e2e；approve 动作在 MCP 层被要求确认的对抗测试
- llms.txt 生成脚本幂等（文档变更后重新生成 diff 干净）

**退出标准**：外部验收——用一个全新的 Claude Code 会话（无本仓库上下文）仅凭 MCP 接入 + llms.txt，完成一次「检索文献入库 → 建 idea → novelty check」操作；EXTENDING.md 三类示例 CI 全绿；tag `v0.2.0` + GitHub Release（从 P8 移入）。

**P9 完成状态（2026-09-09）**：范围全部落地，见 [devlog/P9-extensibility.md](devlog/P9-extensibility.md)。
机器版退出标准已由 `tests/unit/mcp_e2e.test.ts` 覆盖（真实 MCP 客户端跑通
capabilities → 检索入库 → idea → novelty → 时间线 → 报告，零网络零真实模型）；
**人版外部验收（全新 Claude Code 会话接 MCP）留给主会话执行**，tag 与 Release 同。

| 层 | 工具 | 网络 | 运行时机 |
|----|------|------|---------|
| 单元 | bun test | 无 | 每次 commit |
| 契约（adapter/connector） | bun test + mock | 无 | 每次 commit |
| e2e 回放 | bun test + fixture | 无（回放） | CI |
| e2e 真实 | bun test（tagged） | 有 | 本地验证 + 录制 fixture 时 |
| 对抗 | 专用测试（伪造引用/安全门样例） | 无 | CI |
| Python（kernel/lab） | pytest | 无 | 每次 commit |

**模拟测试原则**（用户要求「分步骤有逻辑的自己做模拟测试和验证」的落点）：
1. 每阶段先写「验证」小节列出的测试，再实现（测试即验收口径）
2. 真实外部依赖（网络 API、模拟器）本地跑通一次 → 录制 → CI 永远回放，杜绝 flaky
3. 对抗测试优先于 happy path：伪造引用、安全门违规、断点 kill 都是一等测试用例

## 四、执行方式

- 每阶段启动时：主会话（Fable 5）确认范围 → 委派 Opus 5 子代理实现 → 主会话跑测试 + 审代码 + 对照设计验收 → PR → squash merge → devlog
- 阶段间与用户同步一次进度与下阶段范围（「后面商议的需求」的插入点：新需求进 backlog，评估后排进阶段或 v0.3）
- 本地目录 `~/Desktop/AI4S/spark-research` 与 GitHub `jimmyag2026-prog/spark-research` 实时同步（每个 PR merge 即推送）
