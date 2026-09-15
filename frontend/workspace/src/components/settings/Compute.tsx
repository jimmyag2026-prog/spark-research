import { type JSX } from "solid-js";
import { settingsApi } from "../../lib/settings_api";
import { SimpleItemsPanel } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 算力面板（设置面这一份）：执行地列表 × 可用性 × 默认目标。
//
// **只有一个写动作：改默认执行地。** plan / approve / run / release 刻意不走 HTTP
// （V47 / AD-6）——派发与审批是花钱动作，由人在终端做，这是设计不是缺陷。这个面板里
// 因此没有任何派发或审批按钮，和中栏那个只读算力面板（e2e ⑰ 钉着的那个）口径一致。
// 后端 `meta.notes` 会把这件事如实说出来，前端不另写一份文案。

export default function Compute(props: SettingsPanelProps): JSX.Element {
  return (
    <SimpleItemsPanel
      panelProps={props}
      load={() => settingsApi.compute.list()}
      // 只有默认执行地这一项可写；其余执行地条目后端给的是 `editable: false`，
      // 引擎不会给它们渲染控件。
      write={(item, value) =>
        item.key === "computeTarget"
          ? settingsApi.compute.setTarget(value)
          : Promise.reject(new Error(`算力面板只允许改默认执行地，不接受写 ${item.key}`))
      }
    />
  );
}
