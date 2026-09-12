"""自动生成，勿手改——来源：`contract.definitions`（`spark-research contract --json`）。

改法：不要编辑本文件，改 `scripts/gen-sdk-python.ts` 后跑 `bun run gen:sdk` 重新生成。
契约每加一个类型，这里就多一个 TypedDict / 类型别名；契约不变，重新生成逐字节相等。
"""
from __future__ import annotations

from typing import Any, Literal, TypedDict

class _ApiErrorBodyRequired(TypedDict):
    error: str

class ApiErrorBody(_ApiErrorBodyRequired, total=False):
    detail: Any


class ArtifactListResponse(TypedDict):
    artifacts: list[Any]


class ArtifactVersion(TypedDict):
    id: str
    project: str
    projectSlug: str | None
    filename: str
    version: float
    contentType: str
    checksum: str
    storagePath: str
    extractedCode: str | None
    codeDescription: str | None
    lineageMessages: list[LineageMessage]
    environmentSnapshot: dict[str, Any] | None
    parentVersionId: str | None
    producingCellId: str | None
    dependencyMappings: list[DependencyMapping]
    createdAt: str


class _ChatRequestRequired(TypedDict):
    sessionId: str
    message: str

class ChatRequest(_ChatRequestRequired, total=False):
    model: str
    mode: Literal["chat", "coexplore"]


class _ChatResponseRequired(TypedDict):
    response: str

class ChatResponse(_ChatResponseRequired, total=False):
    artifacts: list[Any]
    reviewResult: Any


class DependencyMapping(TypedDict):
    file: str
    versionId: str


EdgeType = Literal["supports", "contradicts", "derives_from", "cites", "supersedes"]


EvidenceLabel = Literal["observed", "sourced", "computed", "inferred"]


class ExportManifest(TypedDict):
    schemaVersion: Literal[1]
    share: str
    generator: dict[str, Any]
    createdAt: str
    range: dict[str, Any]
    forSharing: bool
    prevManifestHash: str | None
    dcat: dict[str, Any]
    schemas: dict[str, Any]
    licenses: ManifestTableCounts
    provenanceClasses: ManifestTableCounts
    excluded: dict[str, Any]
    rootHash: str
    files: list[dict[str, Any]]


class LineageMessage(TypedDict, total=False):
    role: str
    content: str
    file: str
    kind: Literal["read", "write", "message"]
    dependsOn: list[str]


class LineageResponse(TypedDict):
    graph: Any


class ManifestTableCounts(TypedDict):
    pass


class ProjectListResponse(TypedDict):
    projects: list[ProjectMeta]
    current: str | None


class ProjectMeta(TypedDict):
    schemaVersion: float
    slug: str
    name: str
    description: str
    status: Literal["active", "archived"]
    createdAt: str
    updatedAt: str


class ProjectSummary(TypedDict):
    current: bool
    counts: dict[str, Any]
    paths: dict[str, Any]
    schemaVersion: float
    slug: str
    name: str
    description: str
    status: Literal["active", "archived"]
    createdAt: str
    updatedAt: str


class RecordDetailResponse(TypedDict):
    project: str
    record: ResearchRecord
    outgoing: list[RecordEdge]
    incoming: list[RecordEdge]
    artifact: Any | None


class RecordEdge(TypedDict):
    sourceId: str
    targetId: str
    type: Literal["supports", "contradicts", "derives_from", "cites", "supersedes"]
    createdAt: str


class RecordGraphResponse(TypedDict):
    project: str
    rootId: str
    depth: float
    nodes: list[ResearchRecord]
    edges: list[RecordEdge]


class _RecordOriginRequired(TypedDict):
    kind: Literal["session", "cell", "connector", "manual", "import"]

class RecordOrigin(_RecordOriginRequired, total=False):
    sessionId: str | None
    ref: str | None
    connector: str | None


class RecordTimelinePage(TypedDict):
    project: str
    records: list[ResearchRecord]
    total: float
    offset: float
    limit: float
    types: list[Literal["idea", "decision", "experiment", "observation", "reading", "conclusion", "paper", "artifact", "agent_run"]]


RecordType = Literal["idea", "decision", "experiment", "observation", "reading", "conclusion", "paper", "artifact", "agent_run"]


class ResearchRecord(TypedDict):
    id: str
    project: str
    type: Literal["idea", "decision", "experiment", "observation", "reading", "conclusion", "paper", "artifact", "agent_run"]
    title: str
    content: str
    evidence: Literal["observed", "sourced", "computed", "inferred"]
    origin: RecordOrigin
    artifactId: str | None
    metadata: dict[str, Any]
    createdAt: str
    provenanceClass: Literal["upstream", "derived", "user_authored", "model_generated"]
    license: str | None
    quality: list[str]


class TaskEvent(TypedDict):
    seq: float
    at: str
    type: Literal["state", "progress", "result", "error"]
    message: str | None
    data: Any


class TaskProgress(TypedDict):
    done: float
    total: float | None
    message: str | None


class TaskRecovery(TypedDict):
    at: str
    reason: Literal["no-terminal-record-on-disk"]


class TaskResponse(TypedDict):
    task: TaskSnapshot


class _TaskSnapshotRequired(TypedDict):
    id: str
    kind: str
    project: str | None
    state: Literal["pending", "running", "succeeded", "failed", "orphaned"]
    createdAt: str
    startedAt: str | None
    finishedAt: str | None
    progress: TaskProgress | None
    result: Any
    error: dict[str, Any] | None
    events: list[TaskEvent]

class TaskSnapshot(_TaskSnapshotRequired, total=False):
    recovered: TaskRecovery | None
    pid: float | None
    pidStartedAt: str | None
    startTimeUnavailable: bool
    orphanReason: str | None
