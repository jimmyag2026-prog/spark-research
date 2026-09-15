import { del, get, post, put } from "./api";

// `/api/settings/**` 的前端客户端。
//
// 后端由 lane γ 提供（`backend/src/server/routes/settings/`，一面板一文件）。契约冻结
// 在 `docs/taskbooks/v0.9/LANE_gamma.md` 文末：**每个 GET 返回 `{ panel, items[], meta }`；
// 每个写路由写入前校验、写后返回整条记录；错误一律 `{ error, nextStep }`**。
// 冻结之后只增字段不改名，所以这里的类型都写成「我用到的字段」而不是穷举后端返回的
// 一切——多出来的字段不会让前端红。
//
// 一条纪律照抄 `api.ts` 顶部那条：**UI 不许有 API 之外的能力**。这里没有的东西，
// 设置面里就不该出现按钮。凭据面板的「值」尤其如此：契约里**根本没有**返回值的字段
// （GET 只给 `fieldsSet: string[]`），所以前端连回显的材料都拿不到——这不是靠自觉。

/** 所有设置 GET 的统一信封。 */
export interface SettingsEnvelope<Item, Meta = Record<string, unknown>> {
  panel: string;
  items: Item[];
  meta: Meta;
}

// ── general ────────────────────────────────────────────────────────────────
// 一项 = `CONFIG_SETTINGS` 的一条投影。`summary` / `effect` 是后端从那张表直接吐出来
// 的原文——**前端一个字都不复制**，这也是 tests/unit/settings_registry.test.ts ③ 在
// grep 级钉住的事。
export interface GeneralItem {
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "list";
  value: string | number | boolean | string[] | null;
  defaultValue: string | number | boolean | string[] | null;
  /** 值从哪来：env / config 文件 / 默认值。 */
  source: "env" | "config" | "default";
  summary: string;
  effect: string;
  allowed?: string[] | null;
  /** 凭据类 key：GET 不返值，PUT/DELETE 在这条路由上 403，要去凭据面板改。 */
  secret: boolean;
  configured: boolean;
}

export interface GeneralMeta {
  /** 凭据类 key 被拒时后端给的下一步文案（`{ error, nextStep }` 的 nextStep）。 */
  secretNextStep?: string;
}

// ── models ─────────────────────────────────────────────────────────────────
export interface ModelItem {
  provider: string;
  model: string;
  /** 每百万 token 的输入/输出单价；后端查不到就是 null（不是 0——「查不到单价」≠「免费」）。 */
  inputPerMTokUsd: number | null;
  outputPerMTokUsd: number | null;
  /** 这个 provider 的 key 配没配。配没配是状态，不是值。 */
  credentialConfigured: boolean;
  toolCalling: boolean;
}

export interface ModelsMeta {
  defaultModel: string | null;
  /** 五类子代理各自的模型覆盖；null = 退回 defaultModel。 */
  subAgents: Array<{ kind: string; model: string | null; summary: string }>;
}

// ── local models ───────────────────────────────────────────────────────────
export interface LocalModelItem {
  id: string;
  /** 实探 `<baseUrl>/v1/models` 拿到的原始 id 之外，后端给的可读名（没有就等于 id）。 */
  label: string;
}

export interface LocalMeta {
  baseUrl: string | null;
  credentialConfigured: boolean;
  /** 实探结果：ok / 探不通（带原因）/ 没配端点所以没探。 */
  probe: { ok: boolean; reason: string | null; probedAt: string | null };
}

// ── scientific tools ───────────────────────────────────────────────────────
export interface ScientificToolItem {
  /** 四段登记：connector / platform / wetBackend / rule。 */
  group: "connector" | "platform" | "wetBackend" | "rule";
  id: string;
  name: string;
  detail: string;
  available: boolean;
  /** `?probe=1` 才有：真探一次的结论。 */
  probe?: { ok: boolean; note: string } | null;
}

// ── credentials ────────────────────────────────────────────────────────────
// **这张表里没有任何「值」字段，是契约层面就没有。**
export interface CredentialItem {
  id: string;
  kind: "provider" | "connector";
  label: string;
  /** 这个 id 需要哪些字段（如 `api_key`）。 */
  fields: string[];
  /** 哪些字段已经设过。只有字段名，永远没有值。 */
  fieldsSet: string[];
  /** 备选路径：去终端跑什么命令也能配。面板里能直接填，这只是「另一条路」。 */
  cliHint: string;
}

// ── extensions（connectors + skills 共用一条路由）────────────────────────────
export interface ExtensionItem {
  kind: "mcp" | "connector" | "skill";
  name: string;
  description: string;
  /** skill：触发词；mcp/connector：发现到的工具名。 */
  entries: string[];
  trusted: boolean;
  builtin: boolean;
  verifiedAt: string | null;
}

// ── compute ────────────────────────────────────────────────────────────────
export interface ComputeTargetItem {
  target: string;
  available: boolean;
  reason: string | null;
  credentialConfigured: boolean | null;
}

// ── network / storage / permissions ────────────────────────────────────────
export interface StorageItem {
  project: string;
  rawBytes: number;
  recordCount: number;
}

export interface StorageMeta {
  dataDir: string;
  rawLlm: boolean;
  rawUpstreamInline: boolean;
  archivedProjects: number;
}

export interface PermissionItem {
  subject: string;
  capability: string;
  granted: boolean;
  /** 撤销要在终端做，后端把命令原样给出来（前端不拼命令行）。 */
  revokeCommand: string | null;
}

// ── 检索源（Spark 独有；读用既有的 /api/lit/sources，写走 γ 的 PUT）────────────
export interface SourceItem {
  name: string;
  description: string;
  apiKeyRequired: boolean;
  credentialConfigured: boolean | null;
}

const BASE = "/api/settings";

export const settingsApi = {
  general: {
    list: () => get<SettingsEnvelope<GeneralItem, GeneralMeta>>(`${BASE}/general`),
    set: (key: string, value: unknown) =>
      put<{ item: GeneralItem }>(`${BASE}/general/${encodeURIComponent(key)}`, { value }),
    reset: (key: string) => del<{ item: GeneralItem }>(`${BASE}/general/${encodeURIComponent(key)}`),
  },

  models: {
    list: () => get<SettingsEnvelope<ModelItem, ModelsMeta>>(`${BASE}/models`),
    setDefault: (model: string) => put<{ meta: ModelsMeta }>(`${BASE}/models/default`, { model }),
    setSubAgent: (kind: string, model: string | null) =>
      put<{ meta: ModelsMeta }>(`${BASE}/models/subagent/${encodeURIComponent(kind)}`, { model }),
  },

  local: {
    get: () => get<SettingsEnvelope<LocalModelItem, LocalMeta>>(`${BASE}/local`),
    setBaseUrl: (baseUrl: string) => put<{ meta: LocalMeta }>(`${BASE}/local`, { baseUrl }),
  },

  scientificTools: {
    list: (probe = false) =>
      get<SettingsEnvelope<ScientificToolItem>>(`${BASE}/scientific-tools${probe ? "?probe=1" : ""}`),
  },

  sources: {
    // 写：把「默认检索源集合」整组交上去（`searchSources` 配置键）。
    set: (ids: string[]) => put<{ sources: string[] }>(`${BASE}/sources`, { ids }),
  },

  credentials: {
    list: () => get<SettingsEnvelope<CredentialItem>>(`${BASE}/credentials`),
    // `fields` 是 { 字段名: 值 }。值只往上走，永远不往回走。
    set: (id: string, fields: Record<string, string>) =>
      put<{ item: CredentialItem }>(`${BASE}/credentials/${encodeURIComponent(id)}`, { fields }),
    remove: (id: string) =>
      del<{ removed: boolean; note: string }>(`${BASE}/credentials/${encodeURIComponent(id)}`),
  },

  extensions: {
    list: () => get<SettingsEnvelope<ExtensionItem>>(`${BASE}/extensions`),
    addMcp: (body: { name: string; cmd: string; env?: string[] }) =>
      post<{ item: ExtensionItem }>(`${BASE}/extensions/mcp`, body),
    verify: (name: string) =>
      post<{ item: ExtensionItem }>(`${BASE}/extensions/${encodeURIComponent(name)}/verify`),
    remove: (name: string) => del<{ removed: boolean }>(`${BASE}/extensions/${encodeURIComponent(name)}`),
  },

  compute: {
    list: () =>
      get<SettingsEnvelope<ComputeTargetItem, { computeTarget: string | null }>>(`${BASE}/compute`),
    setTarget: (target: string) => put<{ computeTarget: string }>(`${BASE}/compute/target`, { target }),
  },

  network: {
    list: () => get<SettingsEnvelope<GeneralItem, GeneralMeta>>(`${BASE}/network`),
    set: (key: string, value: unknown) =>
      put<{ item: GeneralItem }>(`${BASE}/network/${encodeURIComponent(key)}`, { value }),
  },

  storage: {
    list: () => get<SettingsEnvelope<StorageItem, StorageMeta>>(`${BASE}/storage`),
    set: (key: "rawLlm" | "rawUpstreamInline", value: boolean) =>
      put<{ meta: StorageMeta }>(`${BASE}/storage/${key}`, { value }),
    exportProject: (project: string) => post<{ task: { id: string } }>(`${BASE}/storage/export`, { project }),
  },

  permissions: {
    list: () => get<SettingsEnvelope<PermissionItem>>(`${BASE}/permissions`),
  },
};
