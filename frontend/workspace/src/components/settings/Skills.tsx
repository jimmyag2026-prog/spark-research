import { For, Show, type JSX } from "solid-js";
import { extraList, extraString } from "../../lib/settings_api";
import { settingsApi } from "../../lib/settings_api";
import { PanelFrame, usePanelData } from "./panel_kit";
import { SettingRow } from "./common";
import type { SettingsPanelProps } from "./registry_table";

// 技能面板：内建技能 + 已装扩展技能，各自的触发词。
//
// 与「连接器」面板共用 `GET /api/settings/extensions` 一条路由，按 `extra.category`
// 分流：这里只要 `skill`。技能本身没有可改的设置——它是只读清单，所以不传 `write`。

export default function Skills(props: SettingsPanelProps): JSX.Element {
  const panel = usePanelData(props, () => settingsApi.extensions.list());
  const skills = (items: Parameters<typeof panel.visible>[0]) =>
    panel.visible(items).filter((i) => extraString(i, "category") === "skill");

  return (
    <PanelFrame data={panel.data} refetch={panel.refetch} isEmpty={(d) => skills(d.items).length === 0}>
      {(d) => (
        <div class="settings-group" data-count={skills(d.items).length}>
          <For each={skills(d.items)}>
            {(item) => (
              <SettingRow
                label={item.label}
                summary={item.summary}
                control={
                  <Show
                    when={extraList(item, "triggers").length > 0}
                    fallback={<span class="faint">（没有登记触发词）</span>}
                  >
                    <div class="row wrap" style={{ gap: "4px" }}>
                      <For each={extraList(item, "triggers")}>
                        {(trigger) => <span class="chip mono">{trigger}</span>}
                      </For>
                    </div>
                  </Show>
                }
              />
            )}
          </For>
        </div>
      )}
    </PanelFrame>
  );
}
