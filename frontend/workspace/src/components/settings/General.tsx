import { Show, type JSX } from "solid-js";
import { settingsApi } from "../../lib/settings_api";
import { useWorkspace, withBusy } from "../../state";
import { SimpleItemsPanel, coerce } from "./panel_kit";
import type { SettingsPanelProps } from "./registry";

// 通用面板 = `config list` 的 32 键在网页端的投影（U6 修改方向 A）。
//
// **这个文件里没有任何一条配置项的说明文字。** `summary` / `effect` / `nextStep` 全部
// 来自 `GET /api/settings/general` 的响应体，后端从 `CONFIG_SETTINGS` 原样投影过来。
// U6 的证据段明写「每个键的说明文字 config list 里已经有了，直接用，不要另写一份」。
// tests/unit/settings_registry.test.ts ③ 会 grep 这个目录，抄了就红。
//
// 凭据类 key（`kind === "secret"`）在这条路由上 `editable: false`，引擎据此不渲染输入框
// ——渲染一个注定 403 的输入框就是个死按钮。它的 `nextStep` 会告诉用户去凭据面板。

export default function General(props: SettingsPanelProps): JSX.Element {
  const ws = useWorkspace();
  return (
    <SimpleItemsPanel
      panelProps={props}
      load={() => settingsApi.general.list()}
      write={(item, value) => settingsApi.general.set(item.key, coerce(item, value))}
      actionsFor={(item, refetch) => (
        // 「恢复默认」只在值确实被 env / config.json 覆盖过时才出现——值本来就是默认值时
        // 摆一个什么都不会发生的按钮，跟死按钮没区别。
        <Show when={item.editable && item.source && item.source !== "default"}>
          <button
            class="btn btn-sm"
            disabled={ws.busy() !== null}
            onClick={async () => {
              const done = await withBusy(ws, `恢复默认 ${item.key}`, () =>
                settingsApi.general.reset(item.key),
              );
              if (!done) return;
              ws.notify(`${item.key} 已恢复默认值`);
              refetch();
            }}
          >
            恢复默认
          </button>
        </Show>
      )}
    />
  );
}
