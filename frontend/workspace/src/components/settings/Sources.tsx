import { For, Show, createSignal, type JSX } from "solid-js";
import { extraList, settingsApi, type SettingsItem } from "../../lib/settings_api";
import { useWorkspace, withBusy } from "../../state";
import { Badge } from "../ui";
import { PanelFrame, usePanelData } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 检索源面板（Spark 独有，上游没有这一块）：勾选 = 默认检索源集合 `searchSources`。
//
// 读的是 `GET /api/settings/scientific-tools` 里 key 为 `searchSources` 的那一条
// （`allowed` = 所有可选源，`extra.selected` = 当前选中的），写的是
// `PUT /api/settings/sources { ids }`。**没有第二份源清单**——前端不维护「有哪些源」。
//
// 勾掉一个源之后，不带 `--sources` 的检索真的不再查它（后端 `literature/search.ts`
// 只改一处使用点读配置）。e2e ㉜ 用 `config get searchSources` 核这件事。

const SOURCES_KEY = "searchSources";

export default function Sources(props: SettingsPanelProps): JSX.Element {
  const ws = useWorkspace();
  const panel = usePanelData(props, () => settingsApi.scientificTools.list());
  // 本地待提交集合；null = 跟随服务端。服务端刷新后自动回到 null（保存成功才清）。
  const [pending, setPending] = createSignal<string[] | null>(null);

  const sourcesItem = (items: SettingsItem[]): SettingsItem | undefined =>
    items.find((i) => i.key === SOURCES_KEY);

  const selected = (item: SettingsItem): string[] => pending() ?? extraList(item, "selected");

  const toggle = (item: SettingsItem, id: string) => {
    const now = selected(item);
    setPending(now.includes(id) ? now.filter((s) => s !== id) : [...now, id]);
  };

  const save = async (item: SettingsItem) => {
    const ids = selected(item);
    const done = await withBusy(ws, "保存默认检索源", () => settingsApi.scientificTools.setSources(ids));
    if (!done) return;
    setPending(null);
    ws.notify(`默认检索源已保存：${ids.join("、") || "（空）"}`);
    panel.refetch();
  };

  return (
    <PanelFrame data={panel.data} refetch={panel.refetch} isEmpty={(d) => !sourcesItem(d.items)}>
      {(d) => (
        <Show
          when={sourcesItem(d.items)}
          fallback={<div class="empty">后端没有返回 searchSources 这一项</div>}
        >
          {(item) => (
            <div class="settings-group">
              <p class="settings-row__summary">{item().summary}</p>
              <div class="col" style={{ gap: "2px" }}>
                <For each={item().allowed ?? []}>
                  {(id) => (
                    <label class="row" style={{ gap: "7px", "align-items": "center", padding: "3px 0" }}>
                      <input
                        type="checkbox"
                        data-testid={`source-${id}`}
                        checked={selected(item()).includes(id)}
                        onChange={() => toggle(item(), id)}
                      />
                      <span class="mono">{id}</span>
                    </label>
                  )}
                </For>
              </div>
              <div class="row wrap" style={{ gap: "6px", "align-items": "center" }}>
                <button
                  class="btn btn-sm btn-primary"
                  data-testid="sources-save"
                  disabled={pending() === null || ws.busy() !== null}
                  onClick={() => void save(item())}
                >
                  保存
                </button>
                <Show when={pending() !== null}>
                  <button class="btn btn-sm" onClick={() => setPending(null)}>
                    放弃改动
                  </button>
                  <Badge tone="inferred">未保存</Badge>
                </Show>
                <Show when={selected(item()).length === 0}>
                  <span class="faint" style={{ "font-size": "11.5px" }}>
                    一个源都不选 = 不带 --sources 的检索查不到任何东西。
                  </span>
                </Show>
              </div>
            </div>
          )}
        </Show>
      )}
    </PanelFrame>
  );
}
