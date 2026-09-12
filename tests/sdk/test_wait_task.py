"""长任务句柄轮询：202 → `wait_task` 轮到落定（W8-sdk.md 交付 3 + 6）。

`lit review` 在空库（没有精读卡）时 `run()` 在拿到 LLM 之前就同步抛错——落定成
`failed` 又快又不花钱，是 devlog 建议的"立刻落定"路子，用来验证 `wait_task` 不用真的
等一个慢任务跑完。

`test_wait_task_timeout_raises_not_hangs` 是交付 6 的阴性对照的自动化版本：故意给一个
真的要打网络（因此不会在 1 个轮询间隔内落定）的任务一个极短 timeout，确认
`wait_task` 老老实实抛 `TaskTimeoutError`——不是无限等，也不是把超时吞掉当成功。
"""
from __future__ import annotations

import pytest

from spark_research.client import TaskTimeoutError


def test_wait_task_polls_to_terminal_failed_state(client) -> None:
    submitted = client.lit_post_lit_review(body={})
    task = submitted["task"]
    assert task["state"] in ("pending", "running")

    settled = client.wait_task(task["id"], timeout=10.0, interval=0.05)
    assert settled["state"] == "failed"
    assert "精读卡" in settled["error"]["message"]


def test_wait_task_timeout_raises_not_hangs(client) -> None:
    # lit add 打一次真网络（crossref），几乎不可能在 50ms 内落定——第一次轮询大概率
    # 还是 pending/running，timeout 立刻到期，`wait_task` 必须抛出而不是转去无限等待。
    submitted = client.lit_post_lit_papers(body={"identifier": "10.1038/s41586-021-03819-2", "sources": ["crossref"]})
    task_id = submitted["task"]["id"]

    with pytest.raises(TaskTimeoutError) as exc_info:
        client.wait_task(task_id, timeout=0.05, interval=0.01)
    assert exc_info.value.task_id == task_id
