# lane γ · 设置面后端 API（U6 / U3 / V130 + 凭据写入「乙」）— worktree `~/Desktop/AI4S/spark-research-gamma`，分支 `feat/W9-gamma`

先读 `_COMMON.md` 逐条遵守，再读 `docs/USAGE_LOG.md` 的 **U6 / U3** 证据段。基线 `v0.9.0-alpha.1`。
**你只做后端**：设置面的全部 HTTP 路由、配置键、校验、凭据存储。前端全部归 lane ε（`LANE_epsilon.md`），你们通过路由契约对接——**你先出契约，ε 按契约做**；契约冻结点见文末。

对标：OpenScience `backend/cli/src/server/routes/settings/`（12 个模块 4555 行）+ `routes/{config,provider,mcp,permission}.ts`。只读克隆在 `~/Desktop/AI4S/spark-research-v0.5-plan/upstream/openscience/`。**抄路由形状与安全模型，不抄代码**（他们跑在 hono-openapi + zod + AI SDK 上，我们是 hono + 手写 adapter）。

用户 2026-09-14 拍板：**方案乙——凭据经 HTTP 写入**，照上游模型；同时 W9-2 由主会话把 AD-2 修订为 AD-18。你按 AD-18 的约束做，不等它入库。

## 新目录 `backend/src/server/routes/settings/`（一面板一文件，与 ε 的面板一一对应）

| 文件 | 对应 ε 面板 | 路由 | 底子 |
|---|---|---|---|
| `general.ts` | general | `GET /api/settings/general` · `PUT /api/settings/general/:key` · `DELETE …/:key` | `config/index.ts` 32 键（**含新增 `searchSources`**）；凭据类 key 在此 GET 只返 `configured`，PUT/DELETE **403 并指向 `/api/settings/credentials`** |
| `models.ts` | models | `GET /api/settings/models`（provider 列表 × 已登记模型 × 单价 × key 是否配置 × 当前默认/子代理覆盖）· `PUT /api/settings/models/default { model }` · `PUT …/subagent/:kind { model }` | `llm/providers/registry.ts`（β-3 派生的 `MODELS_BY_PROVIDER`）+ `defaultModel` / `subAgentModel_*`；写入经 β 导出的 `assertKnownModel` |
| `local.ts` | local-models | `GET /api/settings/local`（baseUrl / key 是否配置 / **实探** `GET <baseUrl>/v1/models` 的结果，超时 3s）· `PUT /api/settings/local { baseUrl }` | `SPARK_LOCAL_LLM_BASE_URL`；key 走 credentials |
| `scientific-tools.ts` | scientific-tools | `GET /api/settings/scientific-tools`（= `capabilities --json` 的 connector / platform / wetBackend / rule 四段 + `?probe=1` 真探）· `PUT /api/settings/sources { ids[] }`（= 写 `searchSources`） | `capabilities/*` 现成；`searchSources` 见下 |
| `credentials.ts` | credentials | `GET /api/settings/credentials`（**每个 connector / provider 一行：id · 需要哪些字段 · 哪些字段已设 · 永不返值**）· `PUT /api/settings/credentials/:id { fields }` · `DELETE …/:id` | `daemon/credentials.ts` `CredentialStore.set/list/remove`（connector）+ config 里的 `*_API_KEY`（provider）——**两类在这一个面板统一** |
| `extensions.ts` | connectors (MCP) + skills | `GET /api/settings/extensions`（`ext list` + 13 内建 skill + 触发词）· `POST /api/settings/extensions/mcp { name, cmd, env[] }`（= `ext add-mcp`，**不带 `--trust`**）· `POST …/:name/verify`（= `ext verify`）· `DELETE …/:name` | `ext` 子命令族现有实现；**`--trust` 装载、`grant`、`revoke` 三个是授权动作，走一次性令牌**（同 `lab token` 形状，令牌只能终端签发） |
| `compute.ts` | compute | `GET /api/settings/compute`（targets × 可用性 × Modal 凭据是否配置 × `computeTarget` 当前值）· `PUT /api/settings/compute/target { target }` | `compute targets`；**plan/approve/run/release 不加 HTTP**（V47 / AD-6，设计不是缺陷） |
| `network.ts` | network | `GET /api/settings/network` · `PUT` 逐键 | `originAllowlist` · `httpTimeoutMs` · `llmTimeoutMs` · `contactEmail` · `userAgent`（都是 general 的子集，**这条路由只是投影**，不另存） |
| `storage.ts` | storage | `GET /api/settings/storage`（`dataDir` · 各项目 `raw/` 与 `records` 体积 · `rawLlm` / `rawUpstreamInline` 当前值 · 已归档项目数）· `PUT` 两个开关 · `POST /api/settings/storage/export { project }`（= `data export`，返回任务句柄） | 现成；**不做目录迁移**（上游有，我们本版不做） |
| `permissions.ts` | permissions | `GET /api/settings/permissions`（`info` 的权限矩阵 + 各扩展的 credential/tool grants + 当前有效的审批令牌数）· 撤销走 `extensions.ts` 的令牌路径 | `info` 现成 + `ext grant` 状态读取 |

**统一形状**：每个 GET 返回 `{ panel, items[], meta }`；每个写路由**写入前校验**（`config/index.ts` 的 `validateSetting`，你实现）、写后返回整条记录；错误一律 `{ error, nextStep }`——`nextStep` 非空，这是本项目「失败消息带可执行下一步」的约定。契约由 `contract --json` 机械生成，**跑 `bun run gen:sdk`，不手改 `contract/**` 与 `sdk/python/**`**。

## 凭据路由的硬约束（AD-18；缺一条不许合）

照上游 `credentials.ts` 的模型逐条落实，**每条都要有测试**：

1. **write-only**：任何 HTTP 响应、日志、raw、record、usage 里永不出现凭据值；GET 只返 `fieldsSet: string[]`。
2. **loopback 硬限**：`PUT/DELETE /api/settings/credentials/*` 与 `PUT /api/settings/general/<凭据键>` 检查 `c.req.raw` 的远端地址 ∈ {`127.0.0.1`, `::1`}，**不受 `originAllowlist` 影响**——白名单放开了这条路径也是 403。
3. **永不进 `process.env`**：写入 `credentials.json`（connector）或 config（provider）后，读取方经 `CredentialStore.get` / `getApiKey()`，不 `process.env[...] = value`。
4. **脱敏登记**：写入成功即把值注册进 `redactSecrets`（`llm/providers/openai_compat.ts:221` 已在用的那个函数——找到它的定义，扩成可注册的集合），此后任何经它的输出都被打码。
5. **文件权限 0600**，写后校验。
6. **删除有确认语义**：`DELETE` 返回 `{ removed: true, note: "只删本机保存的值，不影响外部账户" }`（照上游文案）。

测试 `tests/unit/settings_credentials.test.ts`：① PUT 后 GET 只见字段名 ② 伪造非 loopback 远端地址 → 403，且 `originAllowlist` 含该地址时**仍** 403 ③ 写后 `process.env` 无该值 ④ 写后把该值塞进一条假 LLM 错误消息 → 经 `redactSecrets` 后不可见 ⑤ 文件 0600 ⑥ 值不出现在 server 日志（spy `console.*`）。

## 其余交付

- **`searchSources` 配置键**：`CONFIG_SETTINGS` 新增（非密，connector id 列表，默认 = 现 `DEFAULT_SEARCH_SOURCES`）；`config/index.ts` 加 `configuredSearchSources()`；`literature/search.ts` **只改一处**使用点读它；校验 id ∈ capabilities connector 集合；`config_reader_parity` 登记读者。测试 `tests/unit/config_search_sources.test.ts`（默认值 == 常量 / 未知 id 422 / `lit search` 无 `--sources` 时读配置）。
- **`spark-research auth --connector <id>`**（新 `backend/src/cli/auth_connector.ts`，收口接进 `index.ts:474`）：TTY 不回显读 key → `CredentialStore.set(id, { api_key })`，0600。**HTTP 与 CLI 两条写入路径共用同一个 `CredentialStore`，不许各写一份**。测试 `tests/unit/auth_connector.test.ts`。
- **U3 后端半边**：`GET /api/projects` 增加 `?includeArchived=0|1`（默认 0），前端折叠归 ε。
- **V130**：`/api/usage` 不带 project → 全局汇总，响应加 `scope`。
- **一次性令牌复用**：把 `lab/approval_token.ts` 与闸门 H 加的 `compute/approval_token.ts` 抽成通用 `server/approval_token.ts`（scope 参数），`extensions.ts` 的 trust/grant/revoke 用它。**这一条若时间不够就砍**：改为 extensions 路由只做读 + 无 trust 的 add-mcp，trust/grant/revoke 维持 CLI。

## 契约冻结点（对 ε 的承诺）

lane 开始后 **48 小时内**（或你的第 2 个 commit）先推一版只含路由骨架 + 响应 schema 的 commit，`contract --json` 能生成，路由返回固定 fixture。ε 从这个 commit 起做前端。之后契约**只增字段不改名**。

## 足迹
- 允许：`backend/src/server/routes/settings/**`（新目录，全部你的）· `backend/src/server/approval_token.ts`（新，若做）· `backend/src/config/index.ts`（只加）· `backend/src/literature/search.ts`（只改一处）· `backend/src/cli/auth_connector.ts`（新）· `backend/src/daemon/credentials.ts`（可加 `fieldsSet()` 等只读方法与 0600 校验；**不改存储格式**）· `backend/src/server/routes/usage.ts`（V130）· `backend/src/server/routes/projects.ts`（`includeArchived`）· `redactSecrets` 定义所在文件（扩成可注册集合，**只加**）· 上述测试文件 · `tests/unit/config_reader_parity.test.ts`（只加一行）· `docs/SDK.md`（只改示例）· `docs/devlog/W9-gamma.md`
- 禁止：`backend/src/server/app.ts`（挂载一行交收口）· `backend/src/index.ts`（`auth --connector` 接线交收口）· `backend/src/llm/**`（α/β 的，`assertKnownModel` 只 import）· `backend/src/config/cli.ts`（β 的）· `frontend/**`（ε 的）· `backend/src/contract/**` 与 `sdk/python/**`（只跑生成器）· `NOTICE`（收口）

## 阴性对照
- 凭据①：GET 里把 `fieldsSet` 改成返值 → 测试①红。
- 凭据②：loopback 检查改成读 `originAllowlist` → 测试②红（这条对照**必须**贴终端输出，它是 AD-18 的牙齿）。
- 凭据④：写入时不登记脱敏 → 测试④红。
- `searchSources`：`search.ts` 改回读常量 → 「配置改了检索不变」红。
- `assertKnownModel`：`models.ts` 写默认模型时跳过校验 → 未登记名被写入 → 红。

## 追加（闸门 I 盘点后由主会话填写）
（空）
