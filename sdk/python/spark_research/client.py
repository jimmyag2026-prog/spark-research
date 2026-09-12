"""手写层：请求/错误封装 + 长任务轮询 + 客户端入口。

SDK 口径（AD-7）：这是 `spark-research server` 的 HTTP 薄客户端，不新增能力、不绕过
审批门、不碰 MCP。每条 HTTP 路由的方法都在 `_generated.py`（从 contract 生成，不手
写）；这里只有三样手写的东西：请求/错误封装、长任务轮询、`Client` 入口本身。

见 docs/SDK.md。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from ._generated import GeneratedClient

__all__ = ["Client", "ApiError", "ConnectionError", "TaskTimeoutError"]

# tasks.ts 的 TASK_STATES：pending/running 是过程态，其余三个是终态（orphaned 也算
# 终态——它是"持有 run() 闭包的进程已经不在了"的判定结果，轮询不应该再等下去）。
_TERMINAL_TASK_STATES = frozenset({"succeeded", "failed", "orphaned"})


class ApiError(Exception):
    """服务器返回非 2xx。`status` 是 HTTP 状态码，`message`/`detail` 取自响应体
    （`{"error": ..., "detail": ...}`，与 server/types.ts 的 `ApiErrorBody` 同形）。
    """

    def __init__(self, status: int, message: str, detail: Any = None) -> None:
        super().__init__(f"[{status}] {message}")
        self.status = status
        self.message = message
        self.detail = detail


class ConnectionError(Exception):
    """服务器不可达（连接被拒绝 / DNS 失败 / 连接超时）——区别于 `ApiError`
    （服务器有响应，只是响应是错误状态）。不会挂死：底层是 `urllib` 的
    超时+连接错误，不是无限等待。
    """


class TaskTimeoutError(Exception):
    """`wait_task` 在 `timeout` 秒内任务仍未落定（`state` 仍是 pending/running）。"""

    def __init__(self, task_id: str, timeout: float, last_state: str | None) -> None:
        super().__init__(f"task {task_id} 在 {timeout}s 内未落定，最后状态={last_state}")
        self.task_id = task_id
        self.timeout = timeout
        self.last_state = last_state


class Client(GeneratedClient):
    """`spark-research server <port>` 的薄 HTTP 客户端。

    每条契约路由一个方法，方法名 = `<group>_<verb>_<路径段>`，见 `_generated.py`；
    这里只加 `__init__`、真正的 `request()` 实现、和长任务轮询 `wait_task()`。
    """

    def __init__(self, base_url: str = "http://127.0.0.1:4321", timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
    ) -> Any:
        url = self.base_url + path
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            query = urllib.parse.urlencode(clean, doseq=True)
            if query:
                url = f"{url}?{query}"
        data: bytes | None = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            payload: Any = {}
            if raw:
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    payload = {"error": raw.decode("utf-8", "replace")}
            message = payload.get("error", str(exc)) if isinstance(payload, dict) else str(exc)
            detail = payload.get("detail") if isinstance(payload, dict) else None
            raise ApiError(exc.code, message, detail) from exc
        except urllib.error.URLError as exc:
            # 连接被拒绝 / DNS 失败 / 连接超时都落在这里——服务器压根没应答，
            # 跟 HTTPError（服务器应答了但状态码是错的）区分开。
            raise ConnectionError(f"无法连接 {self.base_url}: {exc.reason}") from exc

    def wait_task(self, task_id: str, *, timeout: float = 60.0, interval: float = 0.5) -> dict[str, Any]:
        """长任务句柄轮询：写路由默认异步返回 `202 {"task": {...,"state":"pending"}}`，
        真正的结果要靠轮询 `GET /api/tasks/:id` 拿到。落定（succeeded/failed/orphaned）
        就返回那条 `task` 快照；超时抛 `TaskTimeoutError`（不会无限挂着）。
        """
        deadline = time.monotonic() + timeout
        last_state: str | None = None
        while True:
            snapshot = self.tasks_get_tasks_by_id(task_id)
            task = snapshot.get("task", snapshot) if isinstance(snapshot, dict) else snapshot
            last_state = task.get("state") if isinstance(task, dict) else None
            if last_state in _TERMINAL_TASK_STATES:
                return task  # type: ignore[return-value]
            if time.monotonic() >= deadline:
                raise TaskTimeoutError(task_id, timeout, last_state)
            time.sleep(interval)
