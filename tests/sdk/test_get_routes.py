"""每条契约 GET 路由至少一条往返（W8-sdk.md 交付 3）。

用 `does-not-exist` 填所有路径参数，断言响应是 200（能列/能算）或 404（找不到这个 id）
两种形状之一——不追求覆盖每个分支，只保证"方法名对得上真路由、走一圈不炸"。
`root_get_root` 是静态资源兜底路由（不是 JSON API），这个 worktree 没 build 前端，
真实响应是 503 + HTML，单独放宽。
"""
from __future__ import annotations

import inspect

import pytest

from spark_research._generated import GeneratedClient
from spark_research.client import ApiError

_ACCEPTED_STATUS: dict[str, set[int]] = {
    "root_get_root": {200, 404, 503},
}
_DEFAULT_ACCEPTED_STATUS = {200, 404}


def _get_method_names() -> list[str]:
    names = []
    for name in dir(GeneratedClient):
        if name.startswith("_") or name == "request":
            continue
        attr = getattr(GeneratedClient, name)
        if not callable(attr):
            continue
        # 方法名约定 `<group>_<verb>_<路径段>`：verb 永远是第二个下划线分隔的 token。
        verb = name.split("_", 2)[1]
        if verb == "get":
            names.append(name)
    return sorted(names)


GET_METHOD_NAMES = _get_method_names()
# 契约里 GET 路由数应该等于这里收集到的方法数——不是本文件的门禁（那是
# tests/unit/w8_sdk_generated.test.ts 的活），这里只是个 sanity print。
assert len(GET_METHOD_NAMES) >= 40, f"GET 方法数看起来不对: {len(GET_METHOD_NAMES)}"


@pytest.mark.parametrize("method_name", GET_METHOD_NAMES)
def test_get_route_roundtrip(client, method_name: str) -> None:
    method = getattr(client, method_name)
    sig = inspect.signature(method)
    args = []
    for name, param in sig.parameters.items():
        if param.kind is inspect.Parameter.VAR_KEYWORD:
            continue
        args.append("does-not-exist")

    accepted = _ACCEPTED_STATUS.get(method_name, _DEFAULT_ACCEPTED_STATUS)
    try:
        result = method(*args)
        assert 200 in accepted, f"{method_name} 200 了，但预期只接受 {accepted}"
        assert result is None or isinstance(result, (dict, list))
    except ApiError as exc:
        assert exc.status in accepted, f"{method_name} -> {exc.status} {exc.message!r}，预期 {accepted}"
