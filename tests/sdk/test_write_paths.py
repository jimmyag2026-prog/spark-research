"""写路由挑 projects / lit / ideas / records 各至少一条走通（W8-sdk.md 交付 3）。

不花钱的原则（AD-7 同款口径）：
- `projects`：本地状态机，免费，直接真建一个项目。
- `lit`：`lit add`（按 DOI 入库）打真网络（crossref，免 key）不打 LLM，用
  `{"await": true}` 走 `taskResponse` 的同步分支，直接拿到终态，不用等 wait_task。
- `records`：**契约里没有 `POST /api/records`**（records 只由 idea/chem/experiment
  等域的副作用产生，自己没有独立的写路由）——如实交代这个跟任务书字面表述的偏差，
  改用 `POST /api/chem/depict`（本地 RDKit 计算，零网络零 LLM 成本）产生一条真实
  `evidence=computed` 的 record，再让 `GET /api/records/*` 三条路由对着这条真数据走一遍，
  比空库形状断言更"走通"。
- `ideas`：`POST /api/ideas`（co-explore）与 `POST /api/ideas/:id/check`（novelty check）
  都要打 LLM——按口径只验 4xx 形状：故意漏必填字段，确认在真正调用模型之前就被
  参数校验拦住（400），不产生任何调用。
"""
from __future__ import annotations

import uuid

import pytest

from spark_research.client import ApiError


def test_projects_write_path(client) -> None:
    slug = f"sdk-test-{uuid.uuid4().hex[:8]}"
    created = client.projects_post_projects(body={"slug": slug, "name": "SDK 写路径测试"})
    assert created["project"]["slug"] == slug

    fetched = client.projects_get_projects_by_slug(slug)
    assert fetched["project"]["slug"] == slug

    listed = client.projects_get_projects()
    assert slug in {p["slug"] for p in listed["projects"]}


def test_lit_write_path_add_by_doi(client) -> None:
    # 与 DEFAULT_SEARCH_SOURCES 无关的具体一个免 key 源：crossref。
    result = client.lit_post_lit_papers(
        body={"identifier": "10.1038/nature12373", "sources": ["crossref"], "await": True}
    )
    task = result["task"]
    assert task["state"] == "succeeded", task.get("error")
    assert task["result"]["paper"]["doi"].lower() == "10.1038/nature12373"

    papers = client.lit_get_lit_papers()
    assert papers["papers"], "入库后 GET /api/lit/papers 应该至少有一条"


def test_records_roundtrip_via_chem_depict(client) -> None:
    depict = client.chem_post_chem_depict(body={"smiles": "CCO", "name": f"sdk-test-{uuid.uuid4().hex[:8]}"})
    record_id = depict["result"]["recordId"]
    assert record_id

    detail = client.records_get_records_by_id(record_id)
    assert detail["record"]["id"] == record_id
    assert detail["record"]["evidence"] == "computed"

    graph = client.records_get_records_by_id_graph(record_id)
    assert graph["rootId"] == record_id

    history = client.records_get_records_by_id_history(record_id)
    assert history["recordId"] == record_id

    listed = client.records_get_records()
    assert record_id in {r["id"] for r in listed["records"]}


def test_ideas_money_route_only_validates_4xx_shape(client) -> None:
    # 漏 message：在 `requireString` 那步就 400，永远到不了 `ctx.llmFor(...)`。
    with pytest.raises(ApiError) as exc_info:
        client.ideas_post_ideas(body={})
    assert 400 <= exc_info.value.status < 500
