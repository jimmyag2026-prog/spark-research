// 设置面（U6）的 HTTP 契约 —— lane γ 对 lane ε 的承诺。
//
// **契约冻结纪律**：本文件从骨架 commit 起只**增字段、不改名、不改语义**。
// lane ε 用 `git show feat/W9-gamma:backend/src/server/routes/settings/types.ts`
// 读它来做面板，前后端不共享编译单元，所以这里是唯一的形状真源。
//
// 统一形状（LANE_gamma.md「统一形状」）：
//   · 每个 GET 返回 `{ panel, items[], meta }`
//   · 每个写路由先校验、写后返回**整条记录**（`{ panel, item, meta }`）
//   · 错误一律 `{ error, nextStep }`，`nextStep` 非空——这是本项目
//     「失败消息带可执行下一步」的约定（U6 证据段最后一节点名了它）。

/** 面板 id。与 lane ε 的面板注册表一一对应。 */
export type SettingsPanelId =
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

/**
 * 一个条目的编辑形态。
 *   · `string` / `number` / `enum` / `bool`：可直接编辑的非密配置
 *   · `secret`：凭据类。**`value` 恒为 null**，只看 `configured` / `fieldsSet`（AD-18 ①）
 *   · `info`：只读展示（体积、探测结果、权限矩阵……）
 *   · `action`：不是值，是一个动作入口（导出、verify、卸载……），`editable` 恒 false
 */
export type SettingsItemKind = "string" | "number" | "enum" | "bool" | "secret" | "info" | "action";

/** 值的来源，与 `config/index.ts` 的 `SettingSource` 同口径。 */
export type SettingsItemSource = "env" | "config" | "default" | "unset";

export interface SettingsItem {
  /** 面板内唯一键：配置键 / provider id / connector id / 执行地名 / 扩展名。 */
  key: string;
  /** 人读标题。 */
  label: string;
  kind: SettingsItemKind;
  /** 当前值；`kind === "secret"` 时**恒为 null**，永不返回凭据值。 */
  value: string | number | boolean | null;
  /** 值从哪来；`info` / `action` 条目可缺省。 */
  source?: SettingsItemSource;
  /** 是否已配置（secret 条目唯一可见的状态位）。 */
  configured?: boolean;
  /** enum 的可选值；非 enum 为 null。 */
  allowed?: string[] | null;
  /** 这一条能不能在网页端改。false 时 `nextStep` 必须说明去哪改。 */
  editable: boolean;
  /** 这一项是什么（直接用 `CONFIG_SETTINGS` 的 summary，不另写一份）。 */
  summary: string;
  /** 改了影响什么。 */
  effect?: string;
  /** 不可写 / 未配置时的可执行下一步；可写且已配置时为 null。 */
  nextStep?: string | null;
  /** 仅 credentials 面板：这个 id 需要哪些字段名。 */
  fields?: string[];
  /** 仅 credentials 面板：**已设置**的字段名（只有名字，永远没有值）。 */
  fieldsSet?: string[];
  /** 面板专属附加数据（探测结果、体积、计数……）。只增键，不改既有键的含义。 */
  extra?: Record<string, unknown>;
}

export interface SettingsMeta {
  /** 这个面板的能力分级，如实标注（AD-12）：`full` 全功能 / `reduced` 减配 / `readonly` 只读。 */
  level: "full" | "reduced" | "readonly";
  /** 面板一句话说明，给 ε 直接渲染在标题下。 */
  summary: string;
  /** 面板级的注意事项（减配的地方在这里如实写明）。 */
  notes: string[];
  /** 面板专属元数据。只增键。 */
  extra?: Record<string, unknown>;
}

/** 每个 GET 的响应。 */
export interface SettingsPanelResponse {
  panel: SettingsPanelId;
  items: SettingsItem[];
  meta: SettingsMeta;
}

/** 每个写路由的响应：写后返回整条记录。 */
export interface SettingsWriteResponse {
  panel: SettingsPanelId;
  item: SettingsItem;
  meta: SettingsMeta;
}

/** 凭据删除的响应（AD-18 ⑥：删除有确认语义）。 */
export interface CredentialDeleteResponse {
  panel: "credentials";
  removed: boolean;
  id: string;
  note: string;
  item: SettingsItem;
}

/** 统一错误体。`nextStep` 非空是硬约定。 */
export interface SettingsErrorResponse {
  error: string;
  nextStep: string;
}

/** `POST /api/settings/storage/export` 的响应：复用既有任务句柄形状。 */
export interface SettingsTaskResponse {
  panel: SettingsPanelId;
  task: { id: string; kind: string; state: string; project: string | null };
}
