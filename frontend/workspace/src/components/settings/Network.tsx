import { type JSX } from "solid-js";
import { settingsApi } from "../../lib/settings_api";
import { SimpleItemsPanel, coerce } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 网络面板：对外请求的礼貌头、超时上限与可信 Origin 白名单。
//
// 后端说得很清楚，这条路由**只是 general 的投影，不另存一份**——同一批键、同一个
// config.json、同一套校验。分出来只是因为面板按用途分，用户不该为了改超时去 32 键里翻。
// 所以前端这边也只是换个 endpoint，连控件渲染都复用同一套引擎。

export default function Network(props: SettingsPanelProps): JSX.Element {
  return (
    <SimpleItemsPanel
      panelProps={props}
      load={() => settingsApi.network.list()}
      write={(item, value) => settingsApi.network.set(item.key, coerce(item, value))}
    />
  );
}
