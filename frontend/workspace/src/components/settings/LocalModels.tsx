import { For, Show, type JSX } from "solid-js";
import { settingsApi, type SettingsItem } from "../../lib/settings_api";
import { MetaList } from "./common";
import { PanelFrame, usePanelData, ItemList } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 本地模型面板：一个 OpenAI 兼容端点的 baseUrl + 实探 `<baseUrl>/v1/models` 的结果。
//
// 减配（后端 `meta.level: "reduced"` 已如实标注）：**不做 Ollama 模型拉取**，也不做本地
// 进程管理。端点的 key 在凭据面板写，这里只显示配没配。
//
// 探测结果是后端探的（`extra.probe`），前端一个字都不编——「探不通」的原因来自那次
// 真实请求，不是前端猜的。探不通就如实显示探不通。

/** `extra.probe` 的结构由后端给：`{ ok, reason, models }`，缺省为 null（没探）。 */
function probeOf(item: SettingsItem): { ok?: boolean; reason?: string; models?: string[] } | null {
  const probe = item.extra?.probe;
  return probe && typeof probe === "object" ? (probe as Record<string, never>) : null;
}

export default function LocalModels(props: SettingsPanelProps): JSX.Element {
  const panel = usePanelData(props, () => settingsApi.local.list());

  return (
    <PanelFrame
      data={panel.data}
      refetch={panel.refetch}
      isEmpty={(d) => panel.visible(d.items).length === 0}
    >
      {(d) => (
        <div class="settings-group" data-count={panel.visible(d.items).length}>
          <ItemList
            items={panel.visible(d.items)}
            write={(_item, value) => settingsApi.local.setBaseUrl(value)}
            onWritten={panel.refetch}
            footerFor={(item) => {
              const probe = probeOf(item);
              if (!probe) return undefined;
              return (
                <div class="col" style={{ gap: "4px" }}>
                  <MetaList
                    entries={[
                      ["连通性", probe.ok ? "探通了" : "没探通"],
                      ["原因", probe.reason ?? null],
                    ]}
                  />
                  <Show when={(probe.models ?? []).length > 0}>
                    <div class="row wrap" style={{ gap: "4px" }}>
                      <For each={probe.models ?? []}>
                        {(model) => <span class="chip mono">{model}</span>}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          />
        </div>
      )}
    </PanelFrame>
  );
}
