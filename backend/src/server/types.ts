import type { ArtifactVersion } from "../artifacts/models";
import type { EdgeType, EvidenceLabel, RecordEdge, RecordType, ResearchRecord } from "../project/models";
import type { ProjectMeta } from "../project/models";
import type { SessionMode } from "../agents/orchestrator";
import type { TaskSnapshot } from "./tasks";

// ── v0.1 既有形态（保持不变，老端点与老测试依赖它） ───────────────────────────

export interface ChatRequest {
  sessionId: string;
  message: string;
  model?: string;
  mode?: SessionMode;
  /**
   * V119 的预算闸入口。A7 验收指出：路由**接受**这两个字段，但 `ChatRequest` 没声明，
   * 于是 `contract --json` 与据其生成的 SDK 都看不到它们——契约以遗漏的方式说了谎。
   * 契约必须反映真实接口（AD-12）。
   */
  budgetUsd?: number;
  allowUnpriced?: boolean;
}

export interface ChatResponse {
  response: string;
  /** U53（v0.9.1）：本轮落库的产物（如综述草稿），前端在聊天框里渲染成可点链接。此前声明为 unknown[] 且无人填写（AD-17 形状）。 */
  artifacts?: Array<{ id: string; label: string }>;
  reviewResult?: unknown;
  /** U12（v0.9）：本轮没有产出时的结构化原因（budget = 预算闸拒绝；llm = 上游调用失败）。成功时不出现。 */
  failure?: { kind: "budget" | "llm"; message: string };
}

export interface ArtifactListResponse {
  artifacts: unknown[];
}

export interface LineageResponse {
  graph: unknown;
}

// ── P7 ────────────────────────────────────────────────────────────────────────

// 所有错误响应同一形状：UI 只需要认一种。
export interface ApiErrorBody {
  error: string;
  detail?: unknown;
}

export interface ProjectSummary extends ProjectMeta {
  current: boolean;
  counts: {
    records: number;
    papers: number;
    ideas: number;
    dryExperiments: number;
    wetExperiments: number;
  };
  paths: {
    root: string;
    papersDir: string;
    artifactsDir: string;
    experimentsDir: string;
  };
}

export interface ProjectListResponse {
  projects: ProjectMeta[];
  current: string | null;
}

export interface RecordTimelinePage {
  project: string;
  records: ResearchRecord[];
  total: number;
  offset: number;
  limit: number;
  // 本页里出现过的类型（UI 的过滤器用它点亮可选项）。
  types: RecordType[];
}

export interface RecordGraphResponse {
  project: string;
  rootId: string;
  depth: number;
  nodes: ResearchRecord[];
  edges: RecordEdge[];
}

export interface RecordDetailResponse {
  project: string;
  record: ResearchRecord;
  outgoing: RecordEdge[];
  incoming: RecordEdge[];
  artifact: (ArtifactVersion & { content: string }) | null;
}

export interface TaskResponse {
  task: TaskSnapshot;
}

export type { EdgeType, EvidenceLabel, RecordType, TaskSnapshot };

// ── v0.9 lane γ · 设置面（U6）的响应类型 ───────────────────────────────────
//
// 真源在 `routes/settings/types.ts`（一面板一文件的那个新目录里），这里**只是转出去**，
// 不复制一份定义——两份类型定义迟早对不上，那正是 V34/V37 的病根。
//
// 为什么非要从这个文件转一道：`scripts/gen-contract-schemas.ts` 的 `SCHEMA_SOURCES`
// 只扫 `backend/src/server/types.ts` 与 `backend/src/data/manifest.ts` 两个入口。
// 不转出来，`contract --json` 的 `http.schemas` 里就没有设置面的响应形状——
// 路由列得出来、形状却查不到，SDK 与外部调用方只能靠猜。
export type {
  CredentialDeleteResponse,
  SettingsErrorResponse,
  SettingsItem,
  SettingsItemKind,
  SettingsItemSource,
  SettingsMeta,
  SettingsPanelId,
  SettingsPanelResponse,
  SettingsTaskResponse,
  SettingsWriteResponse,
} from "./routes/settings/types";
