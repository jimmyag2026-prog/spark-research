"""自动生成，勿手改——来源：`http.routes`（`spark-research contract --json`）。

一条契约路由一个方法，方法名 = `<group>_<verb>_<路径段>`（路径参数变 `by_<name>`）。
改法：不要编辑本文件，改 `scripts/gen-sdk-python.ts` 后跑 `bun run gen:sdk` 重新生成。
门禁 `tests/unit/w8_sdk_generated.test.ts` 钉住幂等性 + 路由数 == 方法数。
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from ._types import *  # noqa: F401,F403


class GeneratedClient:
    """由契约生成的 HTTP 方法集合。`Client`（见 client.py）继承它并提供真正的 `request()`。"""

    def request(self, method: str, path: str, *, params: dict[str, Any] | None = None, body: Any = None) -> Any:
        raise NotImplementedError  # Client 覆写

    def root_get_root(self, path: str, **params: Any) -> dict[str, Any]:
        """GET /*"""
        return self.request("GET", f"/{quote(str(path), safe='/')}", params=params)

    def artifacts_get_artifacts(self, **params: Any) -> ArtifactListResponse:
        """GET /api/artifacts"""
        return self.request("GET", f"/api/artifacts", params=params)

    def artifacts_get_artifacts_by_sessionId(self, sessionId: str, **params: Any) -> dict[str, Any]:
        """GET /api/artifacts/:sessionId"""
        return self.request("GET", f"/api/artifacts/{quote(str(sessionId), safe='')}", params=params)

    def artifacts_get_artifacts_version_by_versionId(self, versionId: str, **params: Any) -> dict[str, Any]:
        """GET /api/artifacts/version/:versionId"""
        return self.request("GET", f"/api/artifacts/version/{quote(str(versionId), safe='')}", params=params)

    def artifacts_get_artifacts_version_by_versionId_lineage(self, versionId: str, **params: Any) -> dict[str, Any]:
        """GET /api/artifacts/version/:versionId/lineage"""
        return self.request("GET", f"/api/artifacts/version/{quote(str(versionId), safe='')}/lineage", params=params)

    def capabilities_get_capabilities(self, **params: Any) -> dict[str, Any]:
        """GET /api/capabilities"""
        return self.request("GET", f"/api/capabilities", params=params)

    def chat_post_chat(self, body: dict[str, Any] | None = None) -> ChatResponse:
        """POST /api/chat"""
        return self.request("POST", f"/api/chat", body=body)

    def chem_post_chem_depict(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/chem/depict"""
        return self.request("POST", f"/api/chem/depict", body=body)

    def compute_get_compute_jobs(self, **params: Any) -> dict[str, Any]:
        """GET /api/compute/jobs"""
        return self.request("GET", f"/api/compute/jobs", params=params)

    def compute_post_compute_jobs(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/compute/jobs"""
        return self.request("POST", f"/api/compute/jobs", body=body)

    def compute_get_compute_jobs_by_id(self, id: str, **params: Any) -> dict[str, Any]:
        """GET /api/compute/jobs/:id"""
        return self.request("GET", f"/api/compute/jobs/{quote(str(id), safe='')}", params=params)

    def compute_post_compute_jobs_by_id_approve(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/compute/jobs/:id/approve"""
        return self.request("POST", f"/api/compute/jobs/{quote(str(id), safe='')}/approve", body=body)

    def compute_post_compute_jobs_by_id_collect(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/compute/jobs/:id/collect"""
        return self.request("POST", f"/api/compute/jobs/{quote(str(id), safe='')}/collect", body=body)

    def compute_post_compute_jobs_by_id_reject(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/compute/jobs/:id/reject"""
        return self.request("POST", f"/api/compute/jobs/{quote(str(id), safe='')}/reject", body=body)

    def compute_get_compute_machine(self, **params: Any) -> dict[str, Any]:
        """GET /api/compute/machine"""
        return self.request("GET", f"/api/compute/machine", params=params)

    def compute_get_compute_targets(self, **params: Any) -> dict[str, Any]:
        """GET /api/compute/targets"""
        return self.request("GET", f"/api/compute/targets", params=params)

    def conclusions_get_conclusions(self, **params: Any) -> dict[str, Any]:
        """GET /api/conclusions"""
        return self.request("GET", f"/api/conclusions", params=params)

    def conclusions_get_conclusions_by_id(self, id: str, **params: Any) -> dict[str, Any]:
        """GET /api/conclusions/:id"""
        return self.request("GET", f"/api/conclusions/{quote(str(id), safe='')}", params=params)

    def conclusions_post_conclusions_by_id_review(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/conclusions/:id/review"""
        return self.request("POST", f"/api/conclusions/{quote(str(id), safe='')}/review", body=body)

    def conclusions_get_conclusions_meta(self, **params: Any) -> dict[str, Any]:
        """GET /api/conclusions/meta"""
        return self.request("GET", f"/api/conclusions/meta", params=params)

    def connectors_get_connectors(self, **params: Any) -> dict[str, Any]:
        """GET /api/connectors"""
        return self.request("GET", f"/api/connectors", params=params)

    def experiments_get_experiments(self, **params: Any) -> dict[str, Any]:
        """GET /api/experiments"""
        return self.request("GET", f"/api/experiments", params=params)

    def experiments_post_experiments(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/experiments"""
        return self.request("POST", f"/api/experiments", body=body)

    def experiments_get_experiments_by_id(self, id: str, **params: Any) -> dict[str, Any]:
        """GET /api/experiments/:id"""
        return self.request("GET", f"/api/experiments/{quote(str(id), safe='')}", params=params)

    def experiments_post_experiments_by_id_conclude(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/experiments/:id/conclude"""
        return self.request("POST", f"/api/experiments/{quote(str(id), safe='')}/conclude", body=body)

    def experiments_post_experiments_by_id_run(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/experiments/:id/run"""
        return self.request("POST", f"/api/experiments/{quote(str(id), safe='')}/run", body=body)

    def experiments_get_experiments_machine(self, **params: Any) -> dict[str, Any]:
        """GET /api/experiments/machine"""
        return self.request("GET", f"/api/experiments/machine", params=params)

    def experiments_get_experiments_platforms(self, **params: Any) -> dict[str, Any]:
        """GET /api/experiments/platforms"""
        return self.request("GET", f"/api/experiments/platforms", params=params)

    def health_get_health(self, **params: Any) -> dict[str, Any]:
        """GET /api/health"""
        return self.request("GET", f"/api/health", params=params)

    def ideas_get_ideas(self, **params: Any) -> dict[str, Any]:
        """GET /api/ideas"""
        return self.request("GET", f"/api/ideas", params=params)

    def ideas_post_ideas(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/ideas"""
        return self.request("POST", f"/api/ideas", body=body)

    def ideas_get_ideas_by_id(self, id: str, **params: Any) -> dict[str, Any]:
        """GET /api/ideas/:id"""
        return self.request("GET", f"/api/ideas/{quote(str(id), safe='')}", params=params)

    def ideas_post_ideas_by_id_check(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/ideas/:id/check"""
        return self.request("POST", f"/api/ideas/{quote(str(id), safe='')}/check", body=body)

    def lab_get_lab_backends(self, **params: Any) -> dict[str, Any]:
        """GET /api/lab/backends"""
        return self.request("GET", f"/api/lab/backends", params=params)

    def lab_get_lab_devices(self, **params: Any) -> dict[str, Any]:
        """GET /api/lab/devices"""
        return self.request("GET", f"/api/lab/devices", params=params)

    def lab_get_lab_experiments(self, **params: Any) -> dict[str, Any]:
        """GET /api/lab/experiments"""
        return self.request("GET", f"/api/lab/experiments", params=params)

    def lab_post_lab_experiments(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lab/experiments"""
        return self.request("POST", f"/api/lab/experiments", body=body)

    def lab_get_lab_experiments_by_id(self, id: str, **params: Any) -> dict[str, Any]:
        """GET /api/lab/experiments/:id"""
        return self.request("GET", f"/api/lab/experiments/{quote(str(id), safe='')}", params=params)

    def lab_post_lab_experiments_by_id_approve(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lab/experiments/:id/approve"""
        return self.request("POST", f"/api/lab/experiments/{quote(str(id), safe='')}/approve", body=body)

    def lab_post_lab_experiments_by_id_compile(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lab/experiments/:id/compile"""
        return self.request("POST", f"/api/lab/experiments/{quote(str(id), safe='')}/compile", body=body)

    def lab_post_lab_experiments_by_id_reject(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lab/experiments/:id/reject"""
        return self.request("POST", f"/api/lab/experiments/{quote(str(id), safe='')}/reject", body=body)

    def lab_post_lab_experiments_by_id_simulate(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lab/experiments/:id/simulate"""
        return self.request("POST", f"/api/lab/experiments/{quote(str(id), safe='')}/simulate", body=body)

    def lab_get_lab_machine(self, **params: Any) -> dict[str, Any]:
        """GET /api/lab/machine"""
        return self.request("GET", f"/api/lab/machine", params=params)

    def lab_post_lab_protocol(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lab/protocol"""
        return self.request("POST", f"/api/lab/protocol", body=body)

    def lineage_get_lineage_by_versionId(self, versionId: str, **params: Any) -> LineageResponse:
        """GET /api/lineage/:versionId"""
        return self.request("GET", f"/api/lineage/{quote(str(versionId), safe='')}", params=params)

    def lit_get_lit_cards(self, **params: Any) -> dict[str, Any]:
        """GET /api/lit/cards"""
        return self.request("GET", f"/api/lit/cards", params=params)

    def lit_get_lit_export(self, **params: Any) -> dict[str, Any]:
        """GET /api/lit/export"""
        return self.request("GET", f"/api/lit/export", params=params)

    def lit_get_lit_papers(self, **params: Any) -> dict[str, Any]:
        """GET /api/lit/papers"""
        return self.request("GET", f"/api/lit/papers", params=params)

    def lit_post_lit_papers(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lit/papers"""
        return self.request("POST", f"/api/lit/papers", body=body)

    def lit_get_lit_papers_by_id(self, id: str, **params: Any) -> dict[str, Any]:
        """GET /api/lit/papers/:id"""
        return self.request("GET", f"/api/lit/papers/{quote(str(id), safe='')}", params=params)

    def lit_patch_lit_papers_by_id(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """PATCH /api/lit/papers/:id"""
        return self.request("PATCH", f"/api/lit/papers/{quote(str(id), safe='')}", body=body)

    def lit_post_lit_papers_by_id_pdf(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lit/papers/:id/pdf"""
        return self.request("POST", f"/api/lit/papers/{quote(str(id), safe='')}/pdf", body=body)

    def lit_post_lit_read(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lit/read"""
        return self.request("POST", f"/api/lit/read", body=body)

    def lit_post_lit_review(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lit/review"""
        return self.request("POST", f"/api/lit/review", body=body)

    def lit_post_lit_search(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/lit/search"""
        return self.request("POST", f"/api/lit/search", body=body)

    def lit_get_lit_sources(self, **params: Any) -> dict[str, Any]:
        """GET /api/lit/sources"""
        return self.request("GET", f"/api/lit/sources", params=params)

    def projects_get_projects(self, **params: Any) -> ProjectListResponse:
        """GET /api/projects"""
        return self.request("GET", f"/api/projects", params=params)

    def projects_post_projects(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/projects"""
        return self.request("POST", f"/api/projects", body=body)

    def projects_get_projects_by_slug(self, slug: str, **params: Any) -> dict[str, Any]:
        """GET /api/projects/:slug"""
        return self.request("GET", f"/api/projects/{quote(str(slug), safe='')}", params=params)

    def projects_post_projects_by_slug_archive(self, slug: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/projects/:slug/archive"""
        return self.request("POST", f"/api/projects/{quote(str(slug), safe='')}/archive", body=body)

    def projects_get_projects_current(self, **params: Any) -> dict[str, Any]:
        """GET /api/projects/current"""
        return self.request("GET", f"/api/projects/current", params=params)

    def projects_post_projects_current(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/projects/current"""
        return self.request("POST", f"/api/projects/current", body=body)

    def proteins_post_proteins_analyze(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/proteins/analyze"""
        return self.request("POST", f"/api/proteins/analyze", body=body)

    def records_get_records(self, **params: Any) -> RecordTimelinePage:
        """GET /api/records"""
        return self.request("GET", f"/api/records", params=params)

    def records_get_records_by_id(self, id: str, **params: Any) -> RecordDetailResponse:
        """GET /api/records/:id"""
        return self.request("GET", f"/api/records/{quote(str(id), safe='')}", params=params)

    def records_get_records_by_id_graph(self, id: str, **params: Any) -> RecordGraphResponse:
        """GET /api/records/:id/graph"""
        return self.request("GET", f"/api/records/{quote(str(id), safe='')}/graph", params=params)

    def records_get_records_by_id_history(self, id: str, **params: Any) -> dict[str, Any]:
        """GET /api/records/:id/history"""
        return self.request("GET", f"/api/records/{quote(str(id), safe='')}/history", params=params)

    def records_get_records_meta(self, **params: Any) -> dict[str, Any]:
        """GET /api/records/meta"""
        return self.request("GET", f"/api/records/meta", params=params)

    def report_get_report(self, **params: Any) -> dict[str, Any]:
        """GET /api/report"""
        return self.request("GET", f"/api/report", params=params)

    def session_get_session_by_sessionId(self, sessionId: str, **params: Any) -> dict[str, Any]:
        """GET /api/session/:sessionId"""
        return self.request("GET", f"/api/session/{quote(str(sessionId), safe='')}", params=params)

    def session_post_session_chat(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/session/chat"""
        return self.request("POST", f"/api/session/chat", body=body)

    def session_get_session_modes(self, **params: Any) -> dict[str, Any]:
        """GET /api/session/modes"""
        return self.request("GET", f"/api/session/modes", params=params)

    def session_post_session_stream(self, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /api/session/stream"""
        return self.request("POST", f"/api/session/stream", body=body)

    def tasks_get_tasks(self, **params: Any) -> dict[str, Any]:
        """GET /api/tasks"""
        return self.request("GET", f"/api/tasks", params=params)

    def tasks_get_tasks_by_id(self, id: str, **params: Any) -> TaskResponse:
        """GET /api/tasks/:id"""
        return self.request("GET", f"/api/tasks/{quote(str(id), safe='')}", params=params)

    def tasks_get_tasks_by_id_stream(self, id: str, **params: Any) -> dict[str, Any]:
        """GET /api/tasks/:id/stream"""
        return self.request("GET", f"/api/tasks/{quote(str(id), safe='')}/stream", params=params)

    def usage_get_usage(self, **params: Any) -> dict[str, Any]:
        """GET /api/usage"""
        return self.request("GET", f"/api/usage", params=params)

    def usage_get_usage_api(self, **params: Any) -> dict[str, Any]:
        """GET /api/usage/api"""
        return self.request("GET", f"/api/usage/api", params=params)
