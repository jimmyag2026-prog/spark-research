// 设置面板的**真源清单**：有哪些面板、叫什么、排在哪一组。
//
// 与 `registry.ts` 分家的唯一理由是编译单元：这个文件只有数据，不 import 任何 `.tsx`，
// 所以仓库根的 `tsconfig.json`（`include: tests/**/*.ts`，没有开 `jsx`）能把引用它的
// 单测收进来。`registry.ts` 里那句 `lazy(() => import("./General"))` 会把一个 `.tsx`
// 拽进 program，在那个 tsconfig 下必然 `TS6142: --jsx is not set`。
//
// 分家之后两边的一致性不靠自觉：`tests/unit/settings_registry.test.ts ②` 会核对
// 这张表里的每个 id 在 `registry.ts` 里都有一条 `lazy(() => import("./X"))` 绑定、
// 那个 `X.tsx` 真的存在、真的有 `export default`，反向也核（registry.ts 里不许有
// 清单外的绑定）。

export type SettingsSection = "inference" | "capabilities" | "runtime" | "app";

// 按左导航从上到下的顺序。**这张表随交付逐个长出来**：一个面板的实现文件真的存在、
// 真的接了后端之后，它的 id 才会出现在这里。先把 12 个 id 写全、文件慢慢补，中间态
// 就是一批点开是空的面板——那正是「放占位」的另一种写法。
export const SETTINGS_PANEL_IDS = [
  "models",
  "local-models",
  "credentials",
  "sources",
  "scientific-tools",
  "connectors",
  "skills",
  "compute",
  "network",
  "storage",
  "permissions",
  "general",
] as const;

export type SettingsPanelId = (typeof SETTINGS_PANEL_IDS)[number];

export interface SettingsPanelInfo {
  id: SettingsPanelId;
  /** 左导航与标题栏上的名字。 */
  title: string;
  /** 纯文本图标位（没有图标库，也不为了图标引一个）。 */
  glyph: string;
  section: SettingsSection;
}

// **能力分级不在这张表里。** 「全功能 / 减配 / 只读」由后端在 `GET /api/settings/*` 的
// `meta.level` 里如实标注（γ 契约 `types.ts` 的 `SettingsMeta`），面板抬头直接渲染那个
// 值。前端再存一份分级，等于给同一件事写第二个真源——那正是「减配面板被标成全功能」
// 这类偏差的来源，而且没有任何测试会红。
export const SETTINGS_PANEL_INFO: SettingsPanelInfo[] = [
  { id: "models", title: "模型", glyph: "◆", section: "inference" },
  { id: "local-models", title: "本地模型", glyph: "◇", section: "inference" },
  { id: "credentials", title: "凭据", glyph: "⚿", section: "inference" },
  { id: "sources", title: "检索源", glyph: "◎", section: "capabilities" },
  { id: "scientific-tools", title: "科学工具", glyph: "⚗", section: "capabilities" },
  { id: "connectors", title: "连接器（MCP）", glyph: "⇄", section: "capabilities" },
  { id: "skills", title: "技能", glyph: "✦", section: "capabilities" },
  { id: "compute", title: "算力", glyph: "▤", section: "runtime" },
  { id: "network", title: "网络", glyph: "≋", section: "runtime" },
  { id: "storage", title: "存储", glyph: "▦", section: "runtime" },
  { id: "permissions", title: "权限", glyph: "⛨", section: "runtime" },
  { id: "general", title: "通用", glyph: "≡", section: "app" },
];

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "inference", label: "推理" },
  { id: "capabilities", label: "能力" },
  { id: "runtime", label: "运行时" },
  { id: "app", label: "应用" },
];

export const DEFAULT_PANEL: SettingsPanelId = "general";

/** 面板组件从壳拿到的东西：当前搜索词 + 往壳的搜索索引里登记自己的可搜项。 */
export interface SettingsPanelProps {
  /** 壳顶部搜索框的当前内容（已 trim + 小写）。空串 = 没有过滤。 */
  query: string;
  /**
   * 面板读到 API 数据后调用，把「这个面板里有哪些设置项、每项的可搜文本」登记给壳。
   * 文本一律来自 API 响应，面板不自己编——这是「说明只有一份」的落点。
   */
  register: (entries: SettingsSearchEntry[]) => void;
}

export interface SettingsSearchEntry {
  /** 设置项的 key（配置键 / provider id / connector id / 扩展名……）。 */
  key: string;
  /** 参与匹配的全部文本（key + 标题 + API 给的说明）。 */
  text: string;
}
