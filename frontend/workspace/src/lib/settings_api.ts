import { del, get, post, put } from "./api";

// `/api/settings/**` 的前端客户端。
//
// **形状真源是 lane γ 的 `backend/src/server/routes/settings/types.ts`**
// （`git show feat/W9-gamma:backend/src/server/routes/settings/types.ts`），从骨架
// commit `d2fa8d4` 起冻结：只增字段、不改名、不改语义。前后端不共享编译单元，所以这里
// 是那份契约在浏览器侧的复述——字段名逐个对齐过，没有自己发明的键。
//
// 一条纪律照抄 `api.ts` 顶部那条：**UI 不许有 API 之外的能力**。这里没有的东西，
// 设置面里就不该出现按钮。凭据的「值」尤其如此：契约里 `SettingsItem.value` 在
// `kind === "secret"` 时**恒为 null**，前端连回显的材料都拿不到——这不是靠自觉。

export type SettingsBackendPanelId =
  | "general"
  | "models"
  | "local"
  | "scientific-tools"
  | "credentials"
  | "extensions"
  | "compute"
  | "network"
  | "storage"
  | "permissions";

export type SettingsItemKind = "string" | "number" | "enum" | "bool" | "secret" | "info" | "action";

export type SettingsItemSource = "env" | "config" | "default" | "unset";

export interface SettingsItem {
  key: string;
  label: string;
  kind: SettingsItemKind;
  /** `kind === "secret"` 时恒为 null。契约层面就没有凭据值这回事。 */
  value: string | number | boolean | null;
  source?: SettingsItemSource;
  configured?: boolean;
  allowed?: string[] | null;
  editable: boolean;
  /** 这一项是什么。**来自后端从 `CONFIG_SETTINGS` 的投影，前端不写第二份。** */
  summary: string;
  effect?: string;
  /** 不可写 / 未配置时的可执行下一步。 */
  nextStep?: string | null;
  /** 仅 credentials：这个 id 需要哪些字段名。 */
  fields?: string[];
  /** 仅 credentials：**已设置**的字段名。只有名字，永远没有值。 */
  fieldsSet?: string[];
  /** 面板专属附加数据（探测结果、体积、分类、触发词……）。 */
  extra?: Record<string, unknown>;
}

export interface SettingsMeta {
  /** 面板能力分级，**由后端如实标注**（AD-12）。前端不许再存一份。 */
  level: "full" | "reduced" | "readonly";
  summary: string;
  notes: string[];
  extra?: Record<string, unknown>;
}

export interface SettingsPanelResponse {
  panel: SettingsBackendPanelId;
  items: SettingsItem[];
  meta: SettingsMeta;
}

export interface SettingsWriteResponse {
  panel: SettingsBackendPanelId;
  item: SettingsItem;
  meta: SettingsMeta;
}

export interface CredentialDeleteResponse {
  panel: "credentials";
  removed: boolean;
  id: string;
  note: string;
  item: SettingsItem;
}

export interface SettingsTaskResponse {
  panel: SettingsBackendPanelId;
  task: { id: string; kind: string; state: string; project: string | null };
}

const BASE = "/api/settings";
const key = (k: string) => encodeURIComponent(k);

export const settingsApi = {
  general: {
    list: () => get<SettingsPanelResponse>(`${BASE}/general`),
    set: (k: string, value: unknown) => put<SettingsWriteResponse>(`${BASE}/general/${key(k)}`, { value }),
    reset: (k: string) => del<SettingsWriteResponse>(`${BASE}/general/${key(k)}`),
  },

  models: {
    list: () => get<SettingsPanelResponse>(`${BASE}/models`),
    setDefault: (model: string) => put<SettingsWriteResponse>(`${BASE}/models/default`, { model }),
    setSubAgent: (kind: string, model: string | null) =>
      put<SettingsWriteResponse>(`${BASE}/models/subagent/${key(kind)}`, { model }),
  },

  local: {
    list: () => get<SettingsPanelResponse>(`${BASE}/local`),
    setBaseUrl: (baseUrl: string) => put<SettingsWriteResponse>(`${BASE}/local`, { baseUrl }),
  },

  scientificTools: {
    list: (probe = false) =>
      get<SettingsPanelResponse>(`${BASE}/scientific-tools${probe ? "?probe=1" : ""}`),
    /** 勾选默认检索源集合 → 写 `searchSources` 配置键。 */
    setSources: (ids: string[]) => put<SettingsWriteResponse>(`${BASE}/sources`, { ids }),
  },

  credentials: {
    list: () => get<SettingsPanelResponse>(`${BASE}/credentials`),
    /** `fields` 是 { 字段名: 值 }。值只往上走，永远不往回走。 */
    set: (id: string, fields: Record<string, string>) =>
      put<SettingsWriteResponse>(`${BASE}/credentials/${key(id)}`, { fields }),
    remove: (id: string) => del<CredentialDeleteResponse>(`${BASE}/credentials/${key(id)}`),
  },

  extensions: {
    list: () => get<SettingsPanelResponse>(`${BASE}/extensions`),
    addMcp: (body: { name: string; cmd: string; env?: string[] }) =>
      post<SettingsWriteResponse>(`${BASE}/extensions/mcp`, body),
    verify: (name: string) => post<SettingsWriteResponse>(`${BASE}/extensions/${key(name)}/verify`),
    remove: (name: string) => del<SettingsWriteResponse>(`${BASE}/extensions/${key(name)}`),
  },

  compute: {
    list: () => get<SettingsPanelResponse>(`${BASE}/compute`),
    setTarget: (target: string) => put<SettingsWriteResponse>(`${BASE}/compute/target`, { target }),
  },

  network: {
    list: () => get<SettingsPanelResponse>(`${BASE}/network`),
    set: (k: string, value: unknown) => put<SettingsWriteResponse>(`${BASE}/network/${key(k)}`, { value }),
  },

  storage: {
    list: () => get<SettingsPanelResponse>(`${BASE}/storage`),
    set: (k: string, value: unknown) => put<SettingsWriteResponse>(`${BASE}/storage/${key(k)}`, { value }),
    exportProject: (project: string) => post<SettingsTaskResponse>(`${BASE}/storage/export`, { project }),
  },

  permissions: {
    list: () => get<SettingsPanelResponse>(`${BASE}/permissions`),
  },
};

/** `extra.category` 的读取助手：契约把它定成 `Record<string, unknown>`，取值要显式收窄。 */
export function extraString(item: SettingsItem, name: string): string | null {
  const value = item.extra?.[name];
  return typeof value === "string" ? value : null;
}

export function extraList(item: SettingsItem, name: string): string[] {
  const value = item.extra?.[name];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function extraNumber(item: SettingsItem, name: string): number | null {
  const value = item.extra?.[name];
  return typeof value === "number" ? value : null;
}
