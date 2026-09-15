import { lazy, type Component } from "solid-js";
import {
  SETTINGS_PANEL_INFO,
  type SettingsPanelId,
  type SettingsPanelInfo,
  type SettingsPanelProps,
} from "./registry_table";

// 设置面板注册表：把真源清单（`registry_table.ts`）里的每个面板绑到它的实现文件上。
//
// 形状来自上游 OpenScience `frontend/workspace/src/components/settings/registry.ts`
// （Apache-2.0，Synthetic Sciences 2026）：`{ id, title, section, component: lazy(...) }`
// 加四组 section。**只抄这个形状**——上游那份还带 `icon: IconProps["name"]`（依赖
// `@synsci/ui/icon`），我们没有那套组件库，图标位换成一个纯文本符号。
//
// 硬规则（与上游同源，但我们这边是有牙齿的门禁，见 tests/unit/settings_registry.test.ts）：
//   ① 不许有没接后端的面板。**没有底子的能力宁可不出现，也不放占位**——
//      放一个「未实现」的 sandbox 面板等于在 UI 里声称一个不存在的能力，违反 AD-12。
//      所以上游 12 个面板里的 `sandbox` 在这张表里是**缺席**的，不是 disabled。
//   ② 面板说明文字与能力分级**不在前端写第二份**：一律来自 `GET /api/settings/*`。
//
// 面板作者只拥有一个文件 `components/settings/<Panel>.tsx`，`export default` 一个
// `Component<SettingsPanelProps>`；壳（shell.tsx）负责左导航、搜索框与标题栏。

export * from "./registry_table";

export interface SettingsPanel extends SettingsPanelInfo {
  component: Component<SettingsPanelProps> & { preload?: () => Promise<unknown> };
}

// 面板 id → 实现文件。**这张映射是 registry.ts 里唯一一处 `lazy(import)`**，
// 单测会把它从源码里读出来跟清单对账（正反两向），所以写错一个字母就会红。
const PANEL_COMPONENTS: Record<SettingsPanelId, SettingsPanel["component"]> = {
  models: lazy(() => import("./Models")),
  "local-models": lazy(() => import("./LocalModels")),
  credentials: lazy(() => import("./Credentials")),
  sources: lazy(() => import("./Sources")),
  "scientific-tools": lazy(() => import("./ScientificTools")),
  connectors: lazy(() => import("./Connectors")),
  skills: lazy(() => import("./Skills")),
  compute: lazy(() => import("./Compute")),
  network: lazy(() => import("./Network")),
  storage: lazy(() => import("./Storage")),
  permissions: lazy(() => import("./Permissions")),
  general: lazy(() => import("./General")),
};

export const SETTINGS_PANELS: SettingsPanel[] = SETTINGS_PANEL_INFO.map((info) => ({
  ...info,
  component: PANEL_COMPONENTS[info.id],
}));

export function findPanel(id: SettingsPanelId): SettingsPanel {
  return SETTINGS_PANELS.find((p) => p.id === id) ?? SETTINGS_PANELS[0]!;
}

export async function preloadPanel(id: SettingsPanelId): Promise<void> {
  await findPanel(id).component.preload?.();
}
