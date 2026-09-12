"""spark-research-sdk：`spark-research server` 的 Python 薄客户端。

口径（AD-7）：SDK 是 HTTP 的薄投影，不新增能力、不绕过审批门、不碰 MCP。
方法从 runtime contract（`spark-research contract --json`）生成，见 `_generated.py`；
手写的只有 `Client.__init__`/`request()`/`wait_task()`（`client.py`）。

用法见 docs/SDK.md，或：

    from spark_research import Client, ApiError

    client = Client("http://127.0.0.1:4321")
    project = client.projects_post_projects(body={"slug": "demo"})
"""
from __future__ import annotations

from .client import ApiError, Client, ConnectionError, TaskTimeoutError

__all__ = ["Client", "ApiError", "ConnectionError", "TaskTimeoutError", "__version__"]

try:
    from importlib.metadata import version as _version

    __version__ = _version("spark-research-sdk")
except Exception:  # pragma: no cover - 未安装/editable 安装的极端情况
    __version__ = "0.0.0"
