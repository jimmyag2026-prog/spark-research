# lane γ · 非密配置面 + 工作台收尾（U6·A / U3 / V130）— worktree `~/Desktop/AI4S/spark-research-gamma`，分支 `feat/W9-gamma`

先读 `_COMMON.md` 逐条遵守，再读 `docs/USAGE_LOG.md` 的 **U6 与 U3** 证据段。基线 `v0.9.0-alpha.1`。**你是唯一碰 `frontend/**` 的 lane**，前端里的所有 v0.9 改动都归你（含原 δ-3 归档折叠、顶栏版本）。

## 四件事（四个 commit）

### γ-1 · 配置读写路由（新 `backend/src/server/routes/config.ts`）
现状：78 条路由里涉及配置/凭据/数据源的只有三条 GET；13 个路由模块没有 `config.ts`。
交付：`GET /api/config`（返回与 `config list` 完全同一份数据：key / 当前值 / 来源 / 说明——**从 `config/index.ts` 的 `CONFIG_SETTINGS` 投影，不要另写一份说明文字**）；`PUT /api/config/:key { value }`（写 `config.json`，经 γ-3 校验，返回写后的整条记录）；`DELETE /api/config/:key`（= `config unset`）。**凭据类 key（`*_API_KEY`、`SPARK_LOCAL_LLM_API_KEY`）在 GET 里只返 `configured: boolean`，在 PUT/DELETE 里一律 403**，消息固定：「凭据不经 HTTP 写入（AD-2），请在终端运行 spark-research auth」。
契约：跑 `bun run gen:sdk`（若契约生成脚本另有名字以 `package.json` 为准），`contract --json` 与 SDK 自动跟上；**不要手改 `backend/src/contract/**` 与 `sdk/python/**`**。`tests/unit/runtime_contract.test.ts` 与 `contract.test.ts` 必须绿。
测试 `tests/unit/server_config.test.ts`：① GET 投影与 `config list` 键集合相等 ② PUT 非密 key 落盘且再 GET 可见 ③ PUT 凭据 key → 403 且 config.json 未改 ④ PUT 非法值（见 γ-3）→ 422 且未改。

### γ-3 · 写入校验（`backend/src/config/index.ts`，只加不改）
交付：`validateSetting(key, value): { ok: true } | { ok: false, reason }`——模型类 key 调 β 导出的 `assertKnownModel`（**若 β 尚未合入，先按名字 import，用 `ALLOWED_ORPHANS` 登记「等收口接 β-3」**）；`*TimeoutMs` 必须正整数且 ≥ 1000；`computeTarget` ∈ 已注册执行地；`originAllowlist` 逐项校验主机名形态。CLI `config set` 与 HTTP PUT **调同一个函数**（β 在 `config/cli.ts` 接 CLI 侧，你只提供函数 + HTTP 侧接线）。
测试并入 `server_config.test.ts` 的 ④，再加 `tests/unit/config_validate.test.ts` 逐 key 一条。

### γ-2 · 设置面板（新 `frontend/workspace/src/components/settings.tsx`）
交付：左栏「运维」下加「设置」导航项（`left.tsx`），中栏新视图（`center.tsx` 的视图 switch 加一个 case；数字键 `6`）。表单按 `GET /api/config` 渲染：每个 key 一行 = 名称 / 说明（来自 API，**不在前端写第二份**）/ 当前值 / 来源标签 / 输入框 / 保存。凭据类 key 只显示「已配置 / 未配置」+ **一行可执行的下一步**：「在终端运行 `spark-research auth`」（U6 裁定前就该做的那件小事）。保存失败把 422 的 reason 原样显示。
e2e `tests/e2e/workbench.spec.ts` **追加**（不改既有编号）：㉑ 设置视图可见且 key 数量 == `config list` 数量 ㉒ 改 `llmTimeoutMs` 后刷新仍是新值 ㉓ 凭据行无输入框且有「spark-research auth」文案。

### γ-4 · 工作台收尾（U3 + 顶栏版本 + V130）
- **U3 归档折叠**：`project archive` 已落 `status: "archived"`（`project/cli.ts:160`），`left.tsx:127` 只加了「（已归档）」标签没折叠。改：下拉框默认隐藏已归档，末尾一项「显示已归档（N）」切换。**并在 devlog 里列出你建议归档的验收产物清单**（`r4-*` / `r5-*` / `a5-*` / `*-copy` / `speed-probe` / `binary-probe` / `v27probe` / `acceptance-compute`），**不要替用户执行归档**——那是他的数据。
- **顶栏显示 server 版本**（`app.tsx` header）：从 `/api/health` 取 `version`，与前端构建时的 `package.json` 版本比对，**不一致时显示黄色徽标「server v0.8.0-alpha.3 ≠ UI v0.9.0」**——U2 那次版本困惑持续两天的直接原因就是界面上看不到。
- **V130**：`/api/usage` 不带 `project` 时返回当前项目而非全局汇总。改成：不带 → 全局汇总（各项目相加，`unknownCostCalls` 也相加），带 → 该项目；响应里加 `scope: "global" | "project"`。**这是 HTTP 契约变更**，跑生成器、更新 `docs/SDK.md` 里对应示例（若有）。
e2e 追加：㉔ 归档项目默认不在下拉框，切换后出现 ㉕ 顶栏有版本徽标。

### γ-5 · 数据源面板 + 凭据指引改对（2026-09-14 追加；参考 OpenScience 前端，只抄模式不抄组件）

**先说参考对象查到了什么**（上游只读克隆 `~/Desktop/AI4S/spark-research-v0.5-plan/upstream/openscience/frontend/workspace/src/components/settings/`）：
- 设置是**注册表驱动的面板集**：`registry.ts` 的 `SETTINGS_PANELS = [{ id, title, icon, section, component: lazy(...) }]`，12 个面板分 `inference / capabilities / runtime / app` 四组。**这个模式抄**——`registry.ts` 可移植部分只依赖 `solid-js` 的 `lazy`，Spark 也是 SolidJS。
- 他们的 `Connectors.tsx`（1244 行）管的是 **MCP server**，不是科学数据源；科学数据源在 `ScientificTools.tsx`，是能力成熟度/可用性登记表，**没有单源启停或默认集开关**。所以「默认检索源集合」这件事上游没有现成的，是 Spark 自己的需求。
- 凭据在 `CredentialServices.tsx` 经 **`PUT` 走 HTTP**（`server/routes/settings/credentials.ts`，805 行）：值**写入后永不返回**、永不进 `process.env`、登记进输出脱敏；UI 侧只知道「哪些字段已设」。这与 AD-2 相反。**是否照它把凭据写入放进 v0.9，由用户拍板（见方案 §〇 第 3 条）；未拍板前本 lane 不做凭据写入。**
- 组件本身**不抄**：85 行 Tailwind class、i18n、`@synsci/ui` 图标，Spark 没有这些依赖；抄过来等于重写样式。

**交付（不依赖凭据裁定的部分，本版必做）**
- **`searchSources` 配置键**：`config/index.ts` 的 `CONFIG_SETTINGS` 新增（非密，逗号分隔的 connector id 列表；默认值 = 现在的 `DEFAULT_SEARCH_SOURCES` 常量）。`literature/search.ts` 读它（**这一处改动在 β/收口之外、在你足迹内**：把常量改成 `configuredSearchSources()` helper，helper 在 `config/index.ts`；`config_reader_parity` 门禁要登记读者）。校验：每项必须是 `capabilities` 里存在的 connector id，否则 422。这一键自动出现在 γ-2 的设置面板里。
- **「数据源」面板**（`frontend/workspace/src/components/settings/sources.tsx`）：按 `GET /api/connectors` 渲染每个 connector 一行 = 名称 / 分类 / 是否在 `searchSources` 里（勾选即改 `searchSources`，走 `PUT /api/config/searchSources`）/ 凭据状态（`apiKeyRequired` × `credentialConfigured`）/ **正确的下一步**。
- **凭据指引改对**：γ-2 里写的「去终端运行 `spark-research auth`」对 **connector 凭据是错的**——`auth` 只管 LLM provider key，connector 凭据今天靠手工编辑 `~/.spark-research/credentials.json`。改法：新增 `backend/src/cli/auth_connector.ts`（`spark-research auth --connector <id>`：TTY 不回显读 key，调 `daemon/credentials.ts` 的 `CredentialStore.set(id, { api_key })`，写后 `chmod 600`），**收口 diff** 接进 `index.ts:474 case "auth"`。面板与 CLI 的提示文案统一为「在终端运行 `spark-research auth --connector <id>`」。LLM provider key 的提示保持 `spark-research auth`。
- **面板注册表**：把 γ-2 的单页设置改成 `frontend/workspace/src/components/settings/registry.ts`（照上游形状：`{ id, title, section, component }`），首批三个面板：`general`（32 个配置键）/ `sources`（本条）/ `credentials`（只读状态 + 下一步；**若用户拍板凭据写入进 v0.9，这里就是落点**）。
- 测试：`tests/unit/config_search_sources.test.ts`（① 默认值 == 原常量 ② 未知 id → 422 ③ `lit search` 无 `--sources` 时读配置）· `tests/unit/auth_connector.test.ts`（管道输入下写入 `credentials.json`、权限 0600、值不出现在 stdout）· e2e 追加 ㉖ 数据源面板行数 == `GET /api/connectors` 条数 ㉗ 勾掉一个源后 `config get searchSources` 变化 ㉘ 需 key 且未配置的行显示 `auth --connector <id>` 文案。
- **NOTICE**：若从上游复制了 `registry.ts` 的结构（哪怕改写），在仓库根新建 `NOTICE`，第一段照上游格式写 Apache-2.0 归属（Synthetic Sciences, 2026）。收口负责合并 NOTICE，你只提供段落。

## 真实核验
起 server，浏览器里走一遍：新建项目 → 设置里把 `defaultModel` 改成另一个已登记模型 → 发一条 chat → `usage --project <slug> --json` 里 `model` 字段是新值（**这一步依赖 β-1 合入，收口后由主会话做；你在 devlog 里写「待收口验证」**）。

## 足迹
- 允许：`backend/src/server/routes/config.ts`（新）· `backend/src/server/routes/usage.ts`（V130）· `backend/src/config/index.ts`（只加 `validateSetting` 与 `searchSources` 键 + `configuredSearchSources()` helper）· `backend/src/literature/search.ts`（**只改一处**：`DEFAULT_SEARCH_SOURCES` 常量的使用点改读 helper，常量本身保留作默认值）· `backend/src/cli/auth_connector.ts`（新）· `frontend/workspace/src/**`（含新 `components/settings/registry.ts` / `sources.tsx`）· `tests/e2e/workbench.spec.ts`（只追加）· `tests/unit/server_config.test.ts` · `tests/unit/config_validate.test.ts` · `tests/unit/config_search_sources.test.ts` · `tests/unit/auth_connector.test.ts`（均新）· `tests/unit/config_reader_parity.test.ts`（只加 `searchSources` 一行读者登记）· `docs/SDK.md`（只改 usage 示例）· `docs/devlog/W9-gamma.md`（含 NOTICE 段落草稿）
- 禁止：`backend/src/server/app.ts`（挂载路由的一行交收口）· `backend/src/index.ts`（`auth --connector` 接线交收口）· `backend/src/daemon/credentials.ts`（只调用不改；要改交 diff）· `backend/src/config/cli.ts`（β 的）· `backend/src/llm/**`（α/β 的）· `backend/src/contract/**` 与 `sdk/python/**`（只跑生成器）· `NOTICE`（收口建）

## 阴性对照
- γ-1：PUT 凭据 key 的 403 分支去掉 → 测试③红。
- γ-3：`validateSetting` 恒返回 ok → 测试④红。
- γ-2：设置视图里把说明文字改成前端硬编码 → 「key 数量 == config list」仍绿但 **你要在 devlog 里说明这条门禁抓不到「第二份说明文字」**，并加一条单测：settings.tsx 源码里不得出现 `CONFIG_SETTINGS` 任一 key 的说明原文（grep 级）。
- γ-4：版本比对分支去掉 → e2e ㉕ 的「不一致时有徽标」用例红（用 fixture server 伪造一个不同版本）。
- γ-5：`searchSources` 校验里去掉「必须是已存在 connector id」→ 测试②红；`literature/search.ts` 改回直接用常量 → 测试③红（配置改了检索不跟着变）；`auth --connector` 把 key 打到 stdout → `auth_connector` 「值不出现在 stdout」红。

## 追加（闸门 I 盘点后由主会话填写）
（空）
