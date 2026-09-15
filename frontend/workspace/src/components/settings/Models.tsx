import { type JSX } from "solid-js";
import { extraString, settingsApi, type SettingsItem } from "../../lib/settings_api";
import { SimpleItemsPanel } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 模型面板：默认模型 + 五类子代理的模型覆盖；每个 provider 的 key 配没配、单价多少。
//
// 写路由有两条（`PUT /models/default` 与 `PUT /models/subagent/:kind`），所以这里要
// 按条目分流。分流键取自条目自己（`extra.subAgent`，退化时从 `subAgentModel_*` 的键名
// 推），不在前端维护第二份「哪五类子代理」的清单——那份清单的真源是后端的
// `SUB_AGENT_MODEL_CONFIG_TYPES`。
//
// 未登记的模型名写不进去（后端经 `assertKnownModel` 校验）：单价表里没有它就没法计费，
// 台账会出现空成本。前端不复制这条校验，只把后端的 422 原样弹出来——**同一件事两份
// 校验会分家**，而分家的那天前端会放行一个后端拒绝的值。

/** 这一条是哪一类子代理的覆盖；不是子代理覆盖就返回 null。 */
function subAgentKind(item: SettingsItem): string | null {
  const explicit = extraString(item, "subAgent");
  if (explicit) return explicit;
  const prefix = "subAgentModel_";
  return item.key.startsWith(prefix) ? item.key.slice(prefix.length) : null;
}

export default function Models(props: SettingsPanelProps): JSX.Element {
  return (
    <SimpleItemsPanel
      panelProps={props}
      load={() => settingsApi.models.list()}
      write={(item, value) => {
        const kind = subAgentKind(item);
        if (kind) return settingsApi.models.setSubAgent(kind, value.trim() === "" ? null : value);
        if (item.key === "defaultModel") return settingsApi.models.setDefault(value);
        return Promise.reject(
          new Error(`模型面板只有「默认模型」与子代理覆盖两条写路径，${item.key} 不在其中`),
        );
      }}
    />
  );
}
