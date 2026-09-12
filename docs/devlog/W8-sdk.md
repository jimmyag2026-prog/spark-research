# W8-2 · Python SDK（`spark-research-sdk`）

**日期** 2026-09-12 · **分支** `lane/W8-2-sdk` · **执行** SDK lane sonnet 子代理（与 W8-1 六条 lane / W8-2 contract 并行）

## 口径

SDK 是 HTTP 的薄投影（AD-7）：**不新增能力、不绕过审批门、不碰 MCP**。方法从
`spark-research contract --json`（`backend/src/contract/**`，见
[`W8-2-contract.md`](./W8-2-contract.md)）机械生成，不手写第二份方法表——
`scripts/gen-sdk-python.ts` 真跑 CLI（`Bun.spawnSync`，不导入 `backend/src` 内部模块，
保持"契约是外部黑盒 JSON"的口径），把 `http.routes` 渲成 `sdk/python/spark_research/_generated.py`
（一条路由一个方法），把 `definitions` 渲成 `_types.py`（TypedDict / 类型别名）。手写层
只有 `client.py`（`Client.__init__`/`request()`/`wait_task()`）与 `__init__.py`。

## 方法命名

`<group>_<verb>_<路径段>`：路径参数变 `by_<name>`（如 `/api/projects/:slug` →
`projects_get_projects_by_slug`）；根静态兜底路由 `GET /*` 单独特判成 `root_get_root`
（没有命名段可用，也是全契约唯一一条非 `/api/*` 路由）。GET 方法签名是
`(self, <path 参数...>, **params)`，写方法是 `(self, <path 参数...>, body=None)`——
直接对应任务书的口径。

78 条契约路由 ↔ 78 个生成方法，一一对应，`tests/unit/w8_sdk_generated.test.ts` 钉住
路由数 == 方法数（不是靠肉眼数出来的巧合——生成器里有一个内部撞名检查，路由改了
命名规则没跟上会直接抛错，不会是"少生成几个也不吭声"）。

## 返回值类型提示——一个实测发现，缩小了范围

任务书原话是"从 `http.schemas` 的 `$ref` 名给返回值标 TypedDict"，隐含假设是能按
`<分组>+<后缀>` 这类命名规则机械猜出每条路由的响应类型。**实测不成立**：逐条读了
`backend/src/server/routes/**` 的 handler 源码后发现，同一个分组内 GET 是否套壳
都不一致——

- `GET /api/projects` 直接返回 `ProjectListResponse`（顶层，`satisfies` 标注确认）；
- `GET /api/projects/:slug` 却是 `{"project": ProjectSummary}`（套壳，`ProjectSummary`
  被包了一层，不是顶层）；
- `GET /api/records`、`GET /api/records/:id`、`GET /api/records/:id/graph`、
  `GET /api/lineage/:versionId`、`GET /api/artifacts`、`POST /api/chat` 这六条倒是确认
  顶层直出（`satisfies` 或字面量对照源码确认）；
- `GET /api/tasks/:id` 是 `{"task": TaskSnapshot}`——但这恰好等于契约里
  `TaskResponse` 的定义（`{task: TaskSnapshot}`），所以这条反而"套壳"和"匹配已知类型"
  是同一件事。

标错的类型提示比没有类型提示更误导人（调用方会真的信 IDE 补全）。所以最终做法是：
生成器里放一张**手工核对过源码**的路由→类型名小白名单
（`VERIFIED_RETURN_TYPES`，8 条：见 `scripts/gen-sdk-python.ts`），命中就标具体
TypedDict，其余一律 `dict[str, Any]`。这是相对任务书字面表述的一个偏差，`docs/SDK.md`
「类型提示」一节把这个发现和取舍如实写清楚了。契约本身在
`docs/devlog/W8-2-contract.md`「未做 / 留给 SDK lane」里已经承认没有路由→schema 的
映射，这不是我漏做，是契约这一层目前提供不了。

## 交付清单对照

1. `scripts/gen-sdk-python.ts`（幂等，`--check` 模式）+ 生成物 `sdk/python/spark_research/{_generated,_types}.py` 已提交。
2. `sdk/python/pyproject.toml`（`spark-research-sdk`，`hatchling` 后端，version 用 PEP440
   转写与根 `package.json` 同步）+ `sdk/python/README.md`（三段示例：建项目 → 检索入库
   → 精读并等任务）。
3. `tests/sdk/`（pytest，4 个文件 56 个用例，起真实 fixture server）：
   - `test_get_routes.py`：全部 48 条 GET 路由各一条往返（`does-not-exist` 填路径参数，
     断言 200/404 之一；`root_get_root` 是静态兜底路由，单独放宽到 {200,404,503}）。
   - `test_write_paths.py`：projects（真建项目）、lit（`lit add` 打真网络 crossref，
     `await:true` 同步拿终态）、records（**契约没有独立的 `POST /api/records`**——
     偏差见下）、ideas（money 路由，只验 400 形状，不调 LLM）。
   - `test_wait_task.py`：`lit review` 空库立刻落定 failed；`lit add` 超短 timeout 验
     `TaskTimeoutError` 不挂死。
   - `test_errors.py`：404 → `ApiError`；服务器没起 → `ConnectionError`（且快）。
   `bun run test:sdk` = `.venv/bin/python -m pytest tests/sdk`（||回退系统 python3，同
   `test:py`/`test:lab` 的写法）。
4. `tests/unit/w8_sdk_generated.test.ts`：幂等 + 路由数==方法数 + 不含绝对路径，4 条全绿。
5. `docs/SDK.md`：安装/用法/长任务/错误/类型提示的取舍/"用 SDK 而不是拼 curl"/契约变化
   后怎么重新生成/测试说明。
6. 阴性对照见下表（全部真跑）。

## 与任务书的偏差（如实交代）

- **records 组没有独立写路由**：契约 78 条路由里 `records` 分组只有 5 条 GET，没有
  `POST /api/records`（records 只由 idea/chem/experiment 等域的副作用产生）。任务书
  "写路由挑 projects/lit/ideas/records 各 ≥1 条走通"里 records 这条按字面走不通——
  改用零成本的 `POST /api/chem/depict`（本地 RDKit，不打网络不打 LLM）产生一条真实
  `evidence=computed` 的 record，再让 `records_get_records{,_by_id,_by_id_graph,_by_id_history}`
  对着这条真数据走一遍（不是空库形状断言，是真数据往返）。`docs/SDK.md`/`test_write_paths.py`
  里都写明了这个替换的理由。
- **返回值类型提示范围收窄**：见上一节，只标了 8 条手工核对过的路由，其余
  `dict[str, Any]`。
- **SSE 路由不可用**：`GET /api/tasks/:id/stream`、`POST /api/session/stream` 契约里有
  生成的方法（路由数==方法数的口径要求"一条不漏"），但 SDK 的 `request()` 只解析 JSON，
  调这两个方法会因为响应不是 JSON 而报错——`docs/SDK.md` 明确写了"目前只支持轮询，不
  支持 SSE"，没有在文案里假装这两个方法能用。
- 任务书 `W8-sdk.md` 提到"`data export/verify/import` 封装"（源自
  `docs/DEVELOPMENT_PLAN_v0.8.md` §四的展望性描述），但契约的 78 条 HTTP 路由里没有
  `/api/data/*` 这类端点——`data export/verify/import` 目前只是 CLI 子命令，没有 HTTP
  投影，SDK 是 HTTP 的薄投影，没有 HTTP 路由就没有对应方法，不属于本 lane 的生成范围。

## 阴性对照（真跑，改法 → 结果 → 已复原）

| 门禁/断言 | 改法 | 结果 |
|---|---|---|
| `w8_sdk_generated.test.ts`（幂等 + 路由数==方法数） | 从已提交的 `_generated.py` 手动删掉 `health_get_health` 整个方法定义 | 3 pass / **1 fail**（"与契约不一致"那条红，报出具体 diff）；`cp` 复原后 4/4 绿 |
| `w8_sdk_version_sync.test.ts` | `sdk/python/pyproject.toml` 的 `version` 手动改成 `"0.7.9a1"` | 1 pass / **1 fail**（Expected "0.8.0a1" / Received "0.7.9a1"）；改回后 2/2 绿 |
| `client.py` 的 `ConnectionError` 封装（`test_connection_error_when_server_down_not_hang`） | 删掉 `except urllib.error.URLError` 分支 | 测试**失败**：往外抛的是原始 `urllib.error.URLError: <urlopen error [Errno 61] Connection refused>`，不是 `pytest.raises(ConnectionError)` 期待的类型；恢复后 2/2 绿 |

## 六套件数字（`spark-research-sdk` worktree，退出码口径）

- `bun run typecheck` → rc=0
- `bun test tests/unit` → 见下（后台跑，数字待补）
- `bun test tests/concurrency tests/timeout` → 见下
- `bun run test:py`（含 `tests/sdk`） → 见下
- `bun run test:lab` → 见下
- `bun run test:e2e` → 见下（本 lane 没碰 CLI 输出/前端/backend/src，理论上不受影响，仍按纪律跑一遍）
- 额外：`bun run test:sdk` 单独跑 → **56 passed**（首次真跑即绿，未发现需要重跑的 flake）

（六套件完整数字见最终回复——写 devlog 这一刻部分套件仍在后台跑，不在这里编数字。）

## 依赖/环境说明（如实记录，不算偏差）

- `tests/sdk` 需要真实公网访问（`lit add` 打 crossref API 校验免 key 检索路径，任务书
  `W8-sdk.md` 原话"检索走 --sources 里不需要 key 的源或直接用 lit add 按 DOI 入库"已经
  预期了这一点）。本机沙盒环境实测可达（`curl api.crossref.org` 200）。
- `sdk/python` 没有装进共享 `.venv`（`.venv` 是软链到主仓的，六条 lane 共用）——测试用
  `tests/sdk/conftest.py` 把 `sdk/python` 加进 `sys.path`，不做 `pip install -e`，避免
  在共享 venv 里留下这条 lane 独有的、其他 lane 不会关心也不会清理的 editable install
  记录。打包正确性额外用 `uv build` + 隔离的临时 venv（`/tmp/sdk_install_check`，跑完
  即删）验证过一次真实的 `pip install` → `import spark_research` → 读到
  `__version__`，不依赖 sys.path hack。
- fixture server 端口：CLI 的 `server <port>` 参数解析是 `Number(argv) || 4321`，字面传
  `"0"` 会被当 falsy 退回 4321，所以没法直接让 CLI 自己选端口；`tests/sdk/conftest.py`
  改成 Python 先 `socket.bind(("127.0.0.1", 0))` 问 OS 要一个真实空闲端口，再把这个端口
  号传给 CLI——效果同"用 0 端口"，只是问端口的一方换了。
