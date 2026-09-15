import { type JSX } from "solid-js";
import { settingsApi } from "../../lib/settings_api";
import { SimpleItemsPanel } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 权限面板：谁被授了什么。**只读**——不传 `write`，引擎据此一个控件都不渲染，
// 每条改为显示它自己的 `nextStep`（在终端跑哪条命令去改）。
//
// 授予 / 撤销是授权动作，与算力的派发/审批同一条口径（AD-6）：不暴露成 HTTP 写路由。
// 摆一个「撤销」按钮再在点下去之后弹 403，比没有这个按钮更糟。

export default function Permissions(props: SettingsPanelProps): JSX.Element {
  return <SimpleItemsPanel panelProps={props} load={() => settingsApi.permissions.list()} />;
}
