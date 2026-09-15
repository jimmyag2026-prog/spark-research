import { Show, type JSX } from "solid-js";
import { extraNumber, settingsApi } from "../../lib/settings_api";
import { useWorkspace, withBusy } from "../../state";
import { MetaList, bytesLabel } from "./common";
import { ItemList, PanelFrame, usePanelData, coerce } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 存储面板：工作区占了多少盘、原始层留不留、导出一份走人。
//
// 减配（后端已标 `reduced`）：**不做目录迁移**——`dataDir` 只读，换工作区要设
// `SPARK_RESEARCH_DATA_DIR` 再重启。给一个「迁移」按钮然后在点下去之后说做不到，
// 比没有这个按钮更糟。
//
// 导出走 `POST /api/settings/storage/export`，返回一个任务句柄——和其它长任务一样进
// 「任务」面板看进度，不在这里自造第二套进度显示。

export default function Storage(props: SettingsPanelProps): JSX.Element {
  const ws = useWorkspace();
  const panel = usePanelData(props, () => settingsApi.storage.list());

  const exportCurrent = async () => {
    const slug = ws.slug();
    if (!slug) return;
    const done = await withBusy(ws, `导出 ${slug}`, () => settingsApi.storage.exportProject(slug));
    if (!done) return;
    ws.notify(`${slug} 的导出任务已提交（在「任务」面板看进度）`);
  };

  return (
    <PanelFrame data={panel.data} refetch={panel.refetch}>
      {(d) => (
        <div class="settings-group" data-count={panel.visible(d.items).length}>
          <ItemList
            items={panel.visible(d.items)}
            write={(item, value) => settingsApi.storage.set(item.key, coerce(item, value))}
            onWritten={panel.refetch}
            footerFor={(item) => {
              const bytes = extraNumber(item, "bytes");
              const records = extraNumber(item, "records");
              if (bytes === null && records === null) return undefined;
              return (
                <MetaList
                  entries={[
                    ["raw 体积", bytes === null ? null : bytesLabel(bytes)],
                    ["record 数", records],
                  ]}
                />
              );
            }}
          />
          <div class="row wrap" style={{ gap: "6px", "align-items": "center" }}>
            <button
              class="btn btn-sm"
              data-testid="storage-export"
              disabled={!ws.slug() || ws.busy() !== null}
              onClick={() => void exportCurrent()}
            >
              导出当前项目
            </button>
            <Show when={ws.slug()} fallback={<span class="faint">还没打开项目，没有可导出的东西。</span>}>
              <span class="faint" style={{ "font-size": "11.5px" }}>
                当前项目：<span class="mono">{ws.slug()}</span>
              </span>
            </Show>
          </div>
        </div>
      )}
    </PanelFrame>
  );
}
