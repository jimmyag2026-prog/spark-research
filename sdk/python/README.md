# spark-research-sdk

`spark-research server` 的 Python 薄客户端。方法从 runtime contract
（`spark-research contract --json`）生成，不是手写的第二份方法表——HTTP 的薄投影，
不新增能力。完整文档见仓库根 `docs/SDK.md`。

## 安装

```bash
pip install -e sdk/python
```

先起一个 server：

```bash
spark-research server 4321
```

## 三段示例

> **长对话用 `/stream`，不要用同步 chat（δ-4 / V156）**
> `session_post_session_chat()` 打的是同步路由，最多等 `chatSyncMaxMs`（默认 200s，
> 上限是 Bun.serve 的 255s）；超过就回 **202 + `taskId`**，任务在后台继续跑，
> 用 `client.wait_task(resp["taskId"])` 接回。要全程可见（阶段进度 + 正文逐字）就用
> `session_post_session_stream()`（SSE）。**别只判 HTTP 成功**——202 也是成功，但那一份
> 返回体里没有 `summary`，只有句柄。

### 1. 建项目

```python
from spark_research import Client

client = Client("http://127.0.0.1:4321")
created = client.projects_post_projects(body={"slug": "gpcr-allostery", "name": "GPCR 变构位点"})
client.projects_post_projects_current(body={"slug": "gpcr-allostery"})
print(created["project"]["slug"])
```

### 2. 检索入库

```python
submitted = client.lit_post_lit_search(body={"query": "allosteric GPCR modulator", "add": True})
task = client.wait_task(submitted["task"]["id"], timeout=60)
print(task["state"], task.get("result", {}).get("counts"))
```

### 3. 精读并等任务

```python
from spark_research.client import TaskTimeoutError

paper_id = task["result"]["papers"][0]["id"]
submitted = client.lit_post_lit_read(body={"paperIds": [paper_id]})
try:
    settled = client.wait_task(submitted["task"]["id"], timeout=120)
except TaskTimeoutError:
    print("还没读完——去 GET /api/tasks/:id 手动看看进度")
else:
    print(settled["state"])
```

## 错误与长任务

- `ApiError(status, message, detail)`：服务器返回非 2xx。
- `ConnectionError`：服务器不可达（不会挂死）。
- `TaskTimeoutError`：`wait_task` 超时（不会无限等）。

详见仓库根 [`docs/SDK.md`](../../docs/SDK.md)。
