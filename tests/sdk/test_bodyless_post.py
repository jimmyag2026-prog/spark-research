"""R5 P1-6：无 body 的 POST 方法此前 100% 415。

契约里确实存在「不需要请求体的写路由」（`POST /api/lit/papers/:id/pdf`）。生成的方法
默认 `body=None`，而旧 `request()` 只在 `body is not None` 时才设 `Content-Type:
application/json`——服务端对写请求强制校验该头，于是这类方法全部 415，只能退回 CLI。

修法：写方法（POST/PUT/PATCH/DELETE）在 body 为 None 时按 `{}` 发送并带上 JSON 头。
断言口径：**不能是 415**（走没走到业务层、业务层怎么判，由路由自己决定，与本条无关）。
"""
from __future__ import annotations

from spark_research.client import ApiError


def _assert_not_415(call) -> None:
    try:
        call()
    except ApiError as exc:
        assert exc.status != 415, f"无 body 的写请求仍被当成非 JSON 挡掉：{exc}"


def test_bodyless_generated_post_is_not_415(client) -> None:
    _assert_not_415(lambda: client.lit_post_lit_papers_by_id_pdf("does-not-exist"))


def test_bodyless_raw_write_request_is_not_415(client) -> None:
    _assert_not_415(lambda: client.request("POST", "/api/lit/papers/does-not-exist/pdf"))
    _assert_not_415(lambda: client.request("POST", "/api/projects/does-not-exist/archive"))
