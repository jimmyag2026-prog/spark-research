"""错误封装（W8-sdk.md 交付 3 + 6）。

- 服务器有响应但状态码是错的 → `ApiError`（status/message/detail 三件套）。
- 服务器压根不可达（端口没监听）→ `ConnectionError`，且要快——不能挂死。
  这条不需要 `client` fixture（不需要真 server），单独起一个指向空端口的 Client。
"""
from __future__ import annotations

import socket
import time

import pytest

from spark_research import Client
from spark_research.client import ApiError, ConnectionError as SdkConnectionError


def test_api_error_on_404(client) -> None:
    with pytest.raises(ApiError) as exc_info:
        client.projects_get_projects_by_slug("does-not-exist")
    err = exc_info.value
    assert err.status == 404
    assert isinstance(err.message, str) and err.message


def _unused_local_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # 立刻关闭：这个端口现在没有任何进程在监听。
    return port


def test_connection_error_when_server_down_not_hang() -> None:
    dead_client = Client(f"http://127.0.0.1:{_unused_local_port()}", timeout=2.0)
    started = time.monotonic()
    with pytest.raises(SdkConnectionError):
        dead_client.request("GET", "/api/health")
    elapsed = time.monotonic() - started
    assert elapsed < 5.0, f"应该快速失败，不是挂到 timeout 边界附近: {elapsed}s"
