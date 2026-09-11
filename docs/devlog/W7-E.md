# W7-E · 债务清算三条（V41 · V48 · V21）

> worktree `~/Desktop/AI4S/spark-research-E`，分支 `feat/W7-E-debt`。三条互不相关，分三个 commit，各自可单独回退。

## E-1 · V41：MCP 工具描述的能力声称门禁

现状：`backend/src/mcp/tools.ts` 的 `chem_depict` 描述如果被改成谎称支持 3D docking，没有任何既有测试变红——MCP 描述是给外部 agent 看的能力声明，`tests/unit/narrative_parity.test.ts` 已有的七条 AD-12 断言全部只查 `capabilities`/skills/数字/状态机这些结构化端点，没有一条查 `MCP_TOOLS` 的自然语言 `description` 本身。

### 交付

- `tests/unit/narrative_parity.test.ts` 新增「第 9 条（W7-E1 · V41）：MCP 工具描述里的能力声称必须对得上真源，不许空口白牙」。
- 小而显式的能力词表 `CAPABILITY_WORDS`（5 类：`3D/docking/对接`、`全文/fulltext`、`真检索/实时`、`GPU`、`远端/Modal`），每类配一个 `verify()`，去读真实源码文件做结构性核实（导出函数是否存在、写入方是否真 import+调用、注册表里是否有非空条目），不是关键词全仓库模糊搜索：
  - `3D/docking/对接` → `backend/src/chem`、`backend/src/proteins`（唯一可能承载这类计算的目录）里核实不到任何 `dock`/对接 字样 → 本仓库不提供该能力。
  - `全文/fulltext` → `literature/pdf_text.ts` 定义 `extractPdfText`，`literature/cli.ts` 真 import 并调用它（`extractPdfText(p.pdfPath)`，第 628 行）。
  - `真检索/实时` → `http/client.ts` 的 `defaultHttp = new NativeHttp()`，`connectors/registry.ts` 默认 `options.http ?? rateLimitedHttp()` 且不 import `FixtureHttp`，`connectors/base.ts` 兜底 `options.http ?? defaultHttp`——生产路径真打网络，不是回放层。
  - `GPU` → `defaultComputeAdapters()` 里至少一个 adapter 的 `capabilities().gpus` 非空（modal）。
  - `远端/Modal` → `TARGET_KINDS` 含 `modal` 且 `defaultComputeAdapters()` 真注册了它；显式声明不核实"真实 gateway 是否已录制"，那是 `compute_modal.test.ts`「等真实录制」阴性对照的职责，两条断言分工不同。
- 提取判据：把每个工具的 `description` 按硬标点（`。！？` 与换行）切句，一句里出现能力词、且**同一句**里没有否定标记（`不算/不做/不能/不可/不支持/并非/并不/无法/没有(排除"有没有")/非+字母数字`）才算"声称"——用句子而不是逗号/顿号/破折号切分，因为本仓库大量描述用"要 X——其实不做 X"这种跨读一整句才成立的免责声明句式。
- 顺带发现并修正一处不实措辞（非 chem_depict）：`protein_analyze` 原文把"对接"列为 `exp_design` 之后可能要跑的干实验类型之一（"准备跑干实验（MD / 对接）之前……"），但 `exp_design` 的两个平台 `pyref`/`openmm` 的 `kinds` 分别只有 `damped-oscillator` 与 `water-box-md`，全仓库都没有任何对接/docking 的 kind 或实现——这句话把"用户可能想做对接"（合理）悄悄读成"这条链路支持对接"（不合理）。已改成只提 MD，并加一句现状说明。

### 阴性对照（真跑，2026-09-11）

| 改法 | 结果 |
|---|---|
| 给 `chem_depict` 描述追加一句无否定标记的独立句子「本工具还支持 3D docking。」 | **红**：`工具 'chem_depict' 的描述声称了能力词 '3D'/'docking'，但真源核实不通过……本仓库目前不提供 3D 对接能力` |
| 撤回上面那句 | 绿，`tests/unit/narrative_parity.test.ts` 11/11 |

第一版判据踩过一个真实边界：ASCII 能力词（`3D`/`GPU`/`Modal`/`docking`/`fulltext`）不加词边界时，`lit_read_cards` 描述里的示例 id `"a1b2c3d4"` 会被当成命中 `3D`（子串 `c3d4` 里的 `3d`）——改成纯 ASCII 词要求 `\b...\b` 词边界后消失；中文能力词不能加同样的边界（`\b` 只认 ASCII `\w`，两个中文字之间永远没有边界，加了反而永远匹配不到），两类词分开处理。

### 数字

`bun run typecheck`：0 错误。`tests/unit/narrative_parity.test.ts`：11 pass / 0 fail（新增 1 条，原 10 条不变）。
