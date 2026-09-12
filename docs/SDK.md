# Python SDK

`spark-research-sdk` 是 `spark-research server` 的 Python 薄客户端。口径同 MCP（AD-7）：
**HTTP 的薄投影，不新增能力、不绕过审批门、不碰 MCP**。每条方法都是从
`spark-research contract --json`（`backend/src/contract/**`，见
[`docs/devlog/W8-2-contract.md`](devlog/W8-2-contract.md)）机械生成的，不是手写的第二份
方法表——契约加一条路由，SDK 重新生成后就多一个方法。

## 安装

```bash
pip install -e sdk/python
```

（还没发 PyPI；`-e` 直接用仓库里的源码。包名是 `spark-research-sdk`，导入名是
`spark_research`。）

先起一个 server：

```bash
spark-research server 4321
```

## 用法

### 一、建项目

```python
from spark_research import Client

client = Client("http://127.0.0.1:4321")
project = client.projects_post_projects(body={"slug": "gpcr-allostery", "name": "GPCR 变构位点"})
print(project["project"]["slug"])

client.projects_post_projects_current(body={"slug": "gpcr-allostery"})
```

### 二、检索入库

`lit search` / `lit add` 是长任务（打网络，秒级），默认异步：POST 立刻返回
`202 {"task": {...}}`，用 `wait_task` 轮询到落定。测试/脚本图省事也可以在请求体里加
`"await": true`，服务器会同步等它跑完再返回（`taskResponse` 的口径，见
`backend/src/server/routes/shared.ts`）。

```python
# 异步 + 轮询（生产代码的默认路子）
submitted = client.lit_post_lit_search(body={"query": "allosteric GPCR modulator", "add": True})
task = client.wait_task(submitted["task"]["id"], timeout=60)
print(task["result"]["counts"])

# 同步（脚本/测试图省事）
result = client.lit_post_lit_papers(body={"identifier": "10.1038/nature12373", "await": True})
print(result["task"]["result"]["paper"]["title"])
```

### 三、精读并等任务

```python
from spark_research.client import TaskTimeoutError

submitted = client.lit_post_lit_read(body={"paperIds": [paper_id]})
try:
    task = client.wait_task(submitted["task"]["id"], timeout=120)
except TaskTimeoutError:
    print("2 分钟还没读完——去 GET /api/tasks/:id 手动看看进度，不用重新提交")
else:
    print(task["state"], task.get("result"))
```

## 长任务：`wait_task`

写路由默认异步（202 + 任务句柄）。`Client.wait_task(task_id, timeout=60, interval=0.5)`
轮询 `GET /api/tasks/:id` 直到落定：

- 终态是 `succeeded` / `failed` / `orphaned`（`orphaned` 是"持有任务的进程已经不在了"，
  同样不会再变化，见 `backend/src/server/tasks.ts` 的 `TASK_STATES`）——三者都直接返回
  那条 `task` 快照，`failed`/`orphaned` **不会**自动抛异常，检查 `task["state"]`。
- 超时抛 `TaskTimeoutError(task_id, timeout, last_state)`——不会挂死，也不会把超时悄悄
  当成功。

SSE（`GET /api/tasks/:id/stream`、`POST /api/session/stream`）契约里有这两条路由的方法，
但 SDK 目前只支持 JSON 请求/响应，**不解析 SSE**——调这两个方法会因为响应体不是 JSON
而报错。轮询 `wait_task` 是目前唯一支持的长任务消费方式；需要真正的流式推送就还是走
CLI/前端。

## 错误

- `ApiError(status, message, detail)`：服务器有响应但状态码 ≥ 400。`message`/`detail`
  取自响应体（`{"error": ..., "detail": ...}`，与 `server/types.ts` 的 `ApiErrorBody`
  同形）。
- `ConnectionError`：服务器压根不可达（拒绝连接/DNS 失败/连接超时）——区别于
  `ApiError`。不会挂死：底层是 `urllib` 的超时+连接错误。
- `TaskTimeoutError`：见上。

```python
from spark_research import ApiError, ConnectionError

try:
    client.projects_get_projects_by_slug("does-not-exist")
except ApiError as e:
    print(e.status, e.message)  # 404 "项目 'does-not-exist' 不存在"
except ConnectionError as e:
    print("server 没起：", e)
```

## 类型提示

`spark_research._types` 是契约 `definitions`（`server/types.ts` 的每个导出接口）机械生成
的 `TypedDict` / `Literal` 别名，供调用方在自己代码里显式标注、做 IDE 补全。**只有一小撮
方法的返回值标了具体类型**——`projects_get_projects` → `ProjectListResponse`、
`records_get_records(_by_id/_by_id_graph)` → `RecordTimelinePage`/`RecordDetailResponse`/
`RecordGraphResponse`、`lineage_get_lineage_by_versionId` → `LineageResponse`、
`artifacts_get_artifacts` → `ArtifactListResponse`、`chat_post_chat` → `ChatResponse`、
`tasks_get_tasks_by_id` → `TaskResponse`——这几条是逐个读了对应 handler 源码、确认响应体
在**顶层**（没套 `{project: ...}` 这类信封）才标的。契约本身不带"路由 → 响应 schema"的
映射（`docs/devlog/W8-2-contract.md`「未做 / 留给 SDK lane」已如实写明），实测同一个
分组内 GET/POST 是否套壳并不一致（比如 `GET /api/projects` 直接是 `ProjectListResponse`，
`GET /api/projects/:slug` 却是 `{"project": ProjectSummary}`），没法从路径/分组名机械
可靠地猜——**标错的类型提示比没有更糟**，所以其余方法一律 `dict[str, Any]`，如实反映
"我们还不知道"，不是偷懒。

## 用 SDK 而不是拼 curl

- 方法名对得上路由，参数是 Python 关键字参数，不用记 HTTP 方法/路径拼写；契约改了
  IDE 补全会跟着变（`_generated.py` 重新生成后方法表就是最新的）。
- 长任务轮询、连接失败、HTTP 错误码已经封装好——拼 curl/`requests` 自己写这三样，
  没有一个是"每次都记得写对"的事。
- 错误是类型化异常（`ApiError`/`ConnectionError`/`TaskTimeoutError`），不是"读 status
  code 自己 if/else"。

（不是不能拼 curl/requests——契约本身是黑盒 HTTP，你当然可以直接打。SDK 只是把这层
样板代码机械生成掉，省下来的是"每次都要重新写对"的心智负担，不是新增能力。）

## 契约变化后怎么重新生成

```bash
bun run gen:sdk        # 重新生成 sdk/python/spark_research/_generated.py 与 _types.py
bun run test:sdk       # 对着 fixture server 跑一遍往返测试
bun test tests/unit/w8_sdk_generated.test.ts   # 幂等门禁：不一致就是忘了 gen:sdk
```

`scripts/gen-sdk-python.ts --check` 只比对不写盘（CI 用），不一致 exit 1。

## 测试

`tests/sdk/`（pytest）起一个真实 `spark-research server`（临时 `SPARK_RESEARCH_DATA_DIR`，
随机空闲端口）：

- `test_get_routes.py`：每条 GET 路由至少一条往返（200 或 404 之一）。
- `test_write_paths.py`：projects（真建项目）、lit（`lit add` 打真网络，crossref，免
  key）、records（**契约里没有独立的 `POST /api/records`**——改用零成本的
  `POST /api/chem/depict` 产生一条真 record 再让三条 `GET /api/records/*` 走一遍）、
  ideas（co-explore/novelty check 都要打 LLM——只验证漏必填字段时的 400 形状，不真的
  调模型）。
- `test_wait_task.py`：`lit review` 空库立刻落定为 `failed`（验证轮询到终态）；`lit add`
  给一个必然来不及在毫秒级落定的超短 timeout（验证 `TaskTimeoutError` 不挂死）。
- `test_errors.py`：404 → `ApiError`；服务器没起 → `ConnectionError`（且要快）。

```bash
bun run test:sdk
```
