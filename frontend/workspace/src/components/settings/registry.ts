import { lazy, type Component } from "solid-js";

// 设置面板注册表。
//
// 形状来自上游 OpenScience `frontend/workspace/src/components/settings/registry.ts`
// （Apache-2.0，Synthetic Sciences 2026）：`{ id, title, section, component: lazy(...) }`
// 加四组 section。**只抄这个形状**——上游那份还带 `icon: IconProps["name"]`（依赖
// `@synsci/ui/icon`）与 `preloadPanel()` 的空闲预热，我们没有那套组件库，图标位换成
// 一个纯文本符号，预热留给 `lazy()` 自己的 preload（solid-js 内建）。
//
// 硬规则（与上游同源，但我们这边是有牙齿的门禁，见 tests/unit/settings_registry.test.ts）：
//   ① 不许有没接后端的面板。**没有底子的能力宁可不出现，也不放占位**——
//      放一个「未实现」的 sandbox 面板等于在 UI 里声称一个不存在的能力，违反 AD-12。
//      所以上游 12 个面板里的 `sandbox` 在这张表里是**缺席**的，不是 disabled。
//   ② 面板说明文字**不在前端写第二份**：每个设置项的 summary/effect 一律来自
//      `GET /api/settings/*` 的响应（后端从 `CONFIG_SETTINGS` 投影）。
//
// 面板作者只拥有一个文件 `components/settings/<Panel>.tsx`，`export default` 一个
// `Component<SettingsPanelProps>`；壳（shell.tsx）负责左导航、搜索框与标题栏。

export type SettingsSection = "inference" | "capabilities" | "runtime" | "app";

// 可达面板的真源清单，按左导航从上到下的顺序。注册表契约测试会核这张表：
// 谁想加/删一个面板，都必须同时动它，不存在「悄悄多一个面板」。
// **这张表随交付逐个长出来**：一个面板的实现文件真的存在、真的接了后端之后，
// 它的 id 才会出现在这里。先把 12 个 id 写全、文件慢慢补，中间态就是一批点开是空的
// 面板——那正是「放占位」的另一种写法。
export const SETTINGS_PANEL_IDS = ["general"] as const;

export type SettingsPanelId = (typeof SETTINGS_PANEL_IDS)[number];

// 面板相对上游的分级，**如实标**，会渲染进面板标题旁边。
//   same    = 每个可见字段都对应后端一个真实值，能力面与上游同档
//   reduced = 我们这版少做了一块，`gap` 写清少了什么（不是「以后再说」的托词，是给用户看的）
export type PanelParity = "same" | "reduced";

/** 面板组件从壳拿到的东西：当前搜索词 + 往壳的搜索索引里登记自己的可搜项。 */
export interface SettingsPanelProps {
  /** 壳顶部搜索框的当前内容（已 trim + 小写）。空串 = 没有过滤。 */
  query: string;
  /**
   * 面板读到 API 数据后调用一次，把「这个面板里有哪些设置项、每项的可搜文本」登记给壳。
   * 文本一律来自 API 响应，面板不自己编——这是「说明只有一份」的落点。
   */
  register: (entries: SettingsSearchEntry[]) => void;
}

export interface SettingsSearchEntry {
  /** 设置项的 key（如 `llmTimeoutMs`、connector id、provider 名）。 */
  key: string;
  /** 参与匹配的全部文本（key + 标题 + API 给的说明），由面板拼好。 */
  text: string;
}

export interface SettingsPanel {
  id: SettingsPanelId;
  /** 左导航与标题栏上的名字。 */
  title: string;
  /** 纯文本图标位（没有图标库，也不为了图标引一个）。 */
  glyph: string;
  section: SettingsSection;
  parity: PanelParity;
  /** `parity === "reduced"` 时必填：少做了哪一块。渲染在面板顶部。 */
  gap?: string;
  component: Component<SettingsPanelProps> & { preload?: () => Promise<unknown> };
}

export const SETTINGS_PANELS: SettingsPanel[] = [
  // ── 应用 ──
  {
    id: "general",
    title: "通用",
    glyph: "\u2261",
    section: "app",
    parity: "same",
    component: lazy(() => import("./General")),
  },
];

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "inference", label: "推理" },
  { id: "capabilities", label: "能力" },
  { id: "runtime", label: "运行时" },
  { id: "app", label: "应用" },
];

export const DEFAULT_PANEL: SettingsPanelId = "general";

export function findPanel(id: SettingsPanelId): SettingsPanel {
  return SETTINGS_PANELS.find((p) => p.id === id) ?? SETTINGS_PANELS[0]!;
}

export async function preloadPanel(id: SettingsPanelId): Promise<void> {
  await findPanel(id).component.preload?.();
}
