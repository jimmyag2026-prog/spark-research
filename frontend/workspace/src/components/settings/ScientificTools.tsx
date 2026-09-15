import { For, Show, createSignal, type JSX } from "solid-js";
import { extraString, settingsApi, type SettingsItem } from "../../lib/settings_api";
import { Badge } from "../ui";
import { SettingRow } from "./common";
import { PanelFrame, usePanelData } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 科学工具面板：connector / 仿真平台 / 湿实验后端 / 规则四段登记 + 「真探一次」。
//
// 不带 `?probe=1` 是零 I/O 的静态清单；点「真探一次」才会让后端 spawn 子进程去问本地
// 平台装没装。这个区分很重要：**打开设置面不该顺手 spawn 一堆子进程**，而「装没装」
// 这件事只有真探过才算数——静态清单说「可用」而实际没装，正是 AD-12 要防的那类声称。
//
// `searchSources` 那一条归「检索源」面板（同一条 GET 的另一半），这里过滤掉，
// 免得同一个设置在两个面板里各有一套控件。

export default function ScientificTools(props: SettingsPanelProps): JSX.Element {
  const [probe, setProbe] = createSignal(false);
  const panel = usePanelData(props, () => settingsApi.scientificTools.list(probe()));

  const tools = (items: SettingsItem[]) =>
    panel.visible(items).filter((i) => i.key !== "searchSources");

  const probeOf = (item: SettingsItem): { ok?: boolean; note?: string } | null => {
    const value = item.extra?.probe;
    return value && typeof value === "object" ? (value as Record<string, never>) : null;
  };

  return (
    <PanelFrame data={panel.data} refetch={panel.refetch} isEmpty={(d) => tools(d.items).length === 0}>
      {(d) => (
        <div class="settings-group" data-count={tools(d.items).length}>
          <div class="row wrap" style={{ gap: "6px", "align-items": "center" }}>
            <button
              class="btn btn-sm"
              data-testid="probe-tools"
              disabled={panel.data.loading}
              onClick={() => {
                setProbe(true);
                panel.refetch();
              }}
            >
              真探一次
            </button>
            <span class="faint" style={{ "font-size": "11.5px" }}>
              {probe() ? "下面的结论来自刚才那次真实探测。" : "下面是静态清单，没有探测过。"}
            </span>
          </div>
          <For each={tools(d.items)}>
            {(item) => (
              <SettingRow
                label={item.label}
                summary={item.summary}
                badge={
                  <>
                    <Show when={extraString(item, "category")}>
                      {(category) => <span class="chip">{category()}</span>}
                    </Show>
                    <Show when={probeOf(item)}>
                      {(result) => (
                        <Badge tone={result().ok ? "observed" : "inferred"}>
                          {result().ok ? "探通了" : "没探通"}
                        </Badge>
                      )}
                    </Show>
                  </>
                }
                control={
                  <div class="row wrap" style={{ gap: "8px", "align-items": "center" }}>
                    <Show when={probeOf(item)?.note}>
                      <span class="faint" style={{ "font-size": "11.5px" }}>
                        {probeOf(item)!.note}
                      </span>
                    </Show>
                    <Show when={item.nextStep}>
                      <span class="faint" style={{ "font-size": "11.5px" }}>
                        {item.nextStep}
                      </span>
                    </Show>
                  </div>
                }
              />
            )}
          </For>
        </div>
      )}
    </PanelFrame>
  );
}
