# lane ε · 前端设置面（对标 OpenScience 12 面板，用户拍板「乙」）— worktree `~/Desktop/AI4S/spark-research-epsilon`，分支 `feat/W9-epsilon`

先读 `_COMMON.md` 逐条遵守，再读 `docs/USAGE_LOG.md` 的 **U6 / U3** 证据段。基线 `v0.9.0-alpha.1`。
**你拥有 `frontend/**` 的全部**（v0.9 里没有第二条 lane 碰前端），后端路由由 lane γ 提供，**契约冻结点见 `LANE_gamma.md` 文末**——γ 的骨架 commit 出来之前，你先做壳与注册表，面板用 fixture 数据开发。

## 参考对象（只读克隆 `~/Desktop/AI4S/spark-research-v0.5-plan/upstream/openscience/frontend/workspace/src/components/`）

- **抄模式**：`settings/registry.ts` 的 `SETTINGS_PANELS = [{ id, title, icon, section, component: lazy(...) }]` 与 `SettingsSection = "inference" | "capabilities" | "runtime" | "app"` 四组；`dialog-settings.tsx` 的壳（左导航按 section 分组 + 顶部搜索过滤面板与设置项 + 面板懒加载）。
- **不抄组件**：上游用 Tailwind（`Connectors.tsx` 85 行 class）、i18n、`@synsci/ui`、`@kobalte/core`，Spark 前端只有 `solid-js`。**不引入 Tailwind / Kobalte / 路由库**——沿用 `components/ui.tsx` 里现有的 `btn / input / tabs / kv / section-title` 类，不够就在 `ui.tsx` 加，不要在面板里写内联样式。
- **归属**：只要从上游复制了结构（哪怕改写），在报告里附一段 NOTICE 文字（Apache-2.0，Synthetic Sciences 2026），收口合进仓库根 `NOTICE`。

## 面板清单：哪些能做到「一样」，哪些做不到要如实标

| 面板 | section | 后端（γ） | 与上游的差距 | 本版 |
|---|---|---|---|---|
| **general** | app | `GET/PUT /api/settings/general` | 一样（32 键；上游是 preferences） | **必做** |
| **models** | inference | `GET /api/settings/models` · `PUT …/default` · `PUT …/subagent/:kind` | 一样：provider × 模型 × 单价 × key 状态 × 默认/五个子代理覆盖；上游的 ProviderLogo 用文字代替 | **必做** |
| **local-models** | inference | `GET/PUT /api/settings/local` | 减配：只有一个 OpenAI 兼容端点 + 实探 `/v1/models` 列表；上游能管 Ollama 拉取，我们不做 | 做 |
| **scientific-tools** | capabilities | `GET /api/settings/scientific-tools[?probe=1]` | 一样：connector / 仿真平台 / 湿实验后端 / 规则四段登记 + 「真探一次」按钮 | **必做** |
| **sources**（Spark 独有） | capabilities | `PUT /api/settings/sources` | 上游没有：每源勾选 = 默认检索源集合 `searchSources` | **必做**（U3 之外的 γ-5 前端半边） |
| **credentials** | inference | `GET/PUT/DELETE /api/settings/credentials/:id` | 一样：connector 与 LLM provider 统一一张表；每行 = id · 需要的字段 · 已设字段（**只见字段名**）· `type="password"` 输入 · 保存 / 删除（删除有确认文案）。**这是「乙」的落点** | **必做** |
| **connectors**（MCP） | capabilities | `GET /api/settings/extensions` · `POST …/mcp` · `POST …/:name/verify` · `DELETE …/:name` | 减配：能添加（不带 `--trust`）、验证、删除、看发现结果；**`--trust` 装载 / grant / revoke 显示为「需终端令牌」并给命令**（照 lab 审批弹窗的形状，`bottom.tsx:295` 那种「在终端运行 … 获取」文案） | 做 |
| **skills** | capabilities | `GET /api/settings/extensions`（同一路由的 skill 段） | 一样：13 内建 + 已装扩展 + 触发词；上游 `Skills.tsx` 只有 19 行，本来就是列表 | 做 |
| **compute** | runtime | `GET /api/settings/compute` · `PUT …/target` | 减配：执行地 × 可用性 × Modal 凭据状态 × 默认目标；**不做派发/审批**（V47 / AD-6，现有算力面板已断言无这些按钮，e2e ⑰ 不许变红） | 做 |
| **network** | runtime | `GET/PUT /api/settings/network` | 一样（五个键的投影） | 做 |
| **storage** | runtime | `GET /api/settings/storage` · `PUT` 两开关 · `POST …/export` | 减配：路径 / 各项目 raw 与 records 体积 / `rawLlm` `rawUpstreamInline` 开关 / 一键导出；**不做目录迁移** | 做 |
| **permissions** | runtime | `GET /api/settings/permissions` | 减配：权限矩阵 + 扩展授权只读；撤销给终端命令 | 做 |
| sandbox | runtime | 无 | **没有底子**（V42：local network 声明不强制）。**不做面板，也不放占位**——放一个「未实现」面板等于在 UI 里声称一个不存在的能力，违反 AD-12 | 不做 |
| billing / wallet / updates / ManagedInference | — | 无 | 上游的托管商业面，与我们无关 | 不做 |

**「一样」的判据**：面板里每个可见字段都对应后端一个真实值，没有一个是前端硬编码的说明文字或假状态。`narrative_parity` 门禁会核面板文案里的能力词。

## 交付（按序 commit；每个面板一个 commit）

1. **壳**：`components/settings/registry.ts`（面板注册表 + section）· `components/settings/shell.tsx`（左导航分组 + 搜索框过滤：既过滤面板名也过滤面板内设置项的 key/说明 + 右侧懒加载面板 + `Esc` 关闭）· 左栏「运维」加「设置」入口 · 数字键 `6` 切到设置。壳先用 `general` 一个面板跑通。
2. `general`（复用 γ 的 `GET /api/settings/general`：说明文字来自 API，**前端不写第二份**）
3. `credentials`
4. `models`
5. `sources` + `scientific-tools`
6. `network` · `storage` · `compute`
7. `connectors` · `skills` · `permissions`
8. `local-models`
9. **U3 前端半边**：项目下拉默认隐藏已归档（`GET /api/projects?includeArchived=0`），末尾「显示已归档（N）」；**顶栏 server 版本徽标**：`/api/health.version` ≠ 构建时版本 → 黄色「server vX ≠ UI vY」（U2 那次困惑持续两天的直接原因）。
10. **凭据行的下一步文案**：LLM provider → `spark-research auth`；connector → `spark-research auth --connector <id>`；**两者都可在面板里直接填**（乙），文案只是备选路径。

## 测试

- 单测（`tests/unit/settings_registry.test.ts`）：① 注册表里每个面板 id 唯一、section ∈ 四组 ② 每个面板的 `component` 可懒加载 ③ **面板源码里不得出现任何 `CONFIG_SETTINGS` key 的说明原文**（grep 级，防第二份文案）④ 没有 `sandbox` 面板。
- e2e（`tests/e2e/workbench.spec.ts` **只追加**，编号接 ㉑ 起）：每个面板一条「可见且行数 == 对应 GET 的 items 数」；`credentials`：填一个假 key 保存 → 该行显示字段已设 → **页面任何位置、任何 XHR 响应体里不出现该值**（Playwright `page.on("response")` 断言）；`sources`：勾掉一个源 → `config get searchSources` 变化；`general`：改 `llmTimeoutMs` 刷新仍在；顶栏版本徽标：fixture server 伪造不同版本 → 徽标出现。
- **既有 e2e ⑰（算力面板无派发/审批按钮）必须仍绿**。

## 足迹
- 允许：`frontend/workspace/src/**` · `tests/e2e/workbench.spec.ts`（只追加）· `tests/unit/settings_registry.test.ts`（新）· `docs/devlog/W9-epsilon.md`（含 NOTICE 段落草稿）
- 禁止：`backend/**` 一行不碰（需要后端改动 → 写进报告「给 γ 的契约请求」，不自己做）· `NOTICE`（收口）· `tests/e2e/fixture_server.ts` 若需加假路由，**加不改**，并在报告里列出

## 阴性对照
- 注册表：加一个 `section: "misc"` 的面板 → 测试①红。
- 第二份文案：在 `general` 面板里硬编码一条 key 说明 → 测试③红。
- 凭据泄露：让 `credentials` 面板把保存的值回显到行里 → e2e「响应体/页面不出现该值」红（**这条对照必须贴终端输出，它是「乙」在前端侧的牙齿**）。
- sandbox：注册一个 `sandbox` 面板 → 测试④红。

## 砍尾顺序（做不完从后往前砍；§七 已登记）
`local-models` → `permissions` → `storage` → `skills` → `connectors`（MCP）→ `compute` → `network`。**general / credentials / models / sources / scientific-tools / 壳 不砍。**

## 追加（闸门 I 盘点后由主会话填写）
（空）
