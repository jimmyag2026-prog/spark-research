"""tests/sdk 的共享 fixture：真实起一个 `spark-research server`，SDK 对着它做往返测试。

口径（W8-sdk.md）：SDK 打的是真 server，不是 mock——`lit search`/`lit add` 走真网络
（crossref，免 key），任何会花钱的路由（LLM）只验 4xx 形状，不真的调。

隔离：
- `SPARK_RESEARCH_DATA_DIR` 指到 `tempfile.mkdtemp()`，绝不碰 `~/.spark-research`
  （`_COMMON.md` 的 V83 事故纪律）。
- 端口用 `socket.bind(("127.0.0.1", 0))` 现取一个操作系统分配的空闲端口再传给 CLI——
  `spark-research server <port>` 自己的参数解析是 `Number(argv) || 4321`，字面传 "0"
  会被当成 falsy 退回 4321，所以不能直接传 0，得由调用方先问 OS 要一个真实端口号。
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterator

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SDK_SRC = REPO_ROOT / "sdk" / "python"
if str(SDK_SRC) not in sys.path:
    sys.path.insert(0, str(SDK_SRC))

from spark_research import Client  # noqa: E402


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_ready(base_url: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/api/health", timeout=1) as resp:
                if resp.status == 200:
                    return
        except Exception as exc:  # noqa: BLE001 - 起server阶段，任何异常都是"还没起来"
            last_err = exc
            time.sleep(0.2)
    raise RuntimeError(f"spark-research server 在 {timeout}s 内没起来（{base_url}）：{last_err}")


@pytest.fixture(scope="session")
def server_base_url() -> Iterator[str]:
    data_dir = tempfile.mkdtemp(prefix="spark-research-sdk-test-")
    port = _free_port()
    env = dict(os.environ)
    env["SPARK_RESEARCH_DATA_DIR"] = data_dir
    proc = subprocess.Popen(
        ["bun", "backend/src/index.ts", "server", str(port)],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        _wait_ready(base_url)
        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        shutil.rmtree(data_dir, ignore_errors=True)


@pytest.fixture()
def client(server_base_url: str) -> Client:
    # 30s：`experiments_get_experiments_platforms` 要探测 OpenMM/scanpy/pydeseq2/cobrapy
    # 是否可用（真 import），实测冷启动能到 ~7s；给足余量避免并行噪音下的假超时。
    return Client(server_base_url, timeout=30.0)
