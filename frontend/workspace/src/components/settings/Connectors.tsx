import { For, Show, createSignal, type JSX } from "solid-js";
import { extraList, extraString, settingsApi, type SettingsItem } from "../../lib/settings_api";
import { useWorkspace, withBusy } from "../../state";
import { Badge } from "../ui";
import { SettingRow } from "./common";
import { PanelFrame, usePanelData } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 连接器（MCP）面板：装了哪些扩展、发现到哪些工具、验证与卸载。
//
// **减配，而且减在哪儿是硬的**（后端 `meta.level: "reduced"` + `notes` 已如实写明）：
// 这里的「添加」等价于**不带 `--trust`** 的 `ext add-mcp`；`--trust` 装载、`grant`、
// `revoke` 三个是授权动作，不暴露成 HTTP 写路由（AD-6，与算力的派发/审批同一口径）。
// 所以面板里没有「授予权限」按钮——每条的 `nextStep` 会给出该在终端跑的命令。

function AddMcpForm(props: { onAdded: () => void }): JSX.Element {
  const ws = useWorkspace();
  const [name, setName] = createSignal("");
  const [cmd, setCmd] = createSignal("");
  const [env, setEnv] = createSignal("");

  const submit = async () => {
    if (!name().trim() || !cmd().trim()) return;
    const done = await withBusy(ws, `添加 MCP ${name().trim()}`, () =>
      settingsApi.extensions.addMcp({
        name: name().trim(),
        cmd: cmd().trim(),
        env: env()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    );
    if (!done) return;
    ws.notify(`${name().trim()} 已添加（未授信：工具能被发现，但不会自动获得凭据）`);
    setName("");
    setCmd("");
    setEnv("");
    props.onAdded();
  };

  return (
    <div class="settings-group">
      <h3 class="section-title">添加 MCP server</h3>
      <div class="row wrap" style={{ gap: "6px" }}>
        <input
          class="input"
          placeholder="名字"
          aria-label="MCP 名字"
          data-testid="mcp-name"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <input
          class="input mono"
          placeholder="启动命令"
          aria-label="MCP 启动命令"
          data-testid="mcp-cmd"
          value={cmd()}
          onInput={(e) => setCmd(e.currentTarget.value)}
        />
        <input
          class="input mono"
          placeholder="要透传的环境变量名，逗号分隔（可空）"
          aria-label="MCP 环境变量"
          value={env()}
          onInput={(e) => setEnv(e.currentTarget.value)}
        />
        <button
          class="btn btn-sm btn-primary"
          data-testid="mcp-add"
          disabled={!name().trim() || !cmd().trim() || ws.busy() !== null}
          onClick={() => void submit()}
        >
          添加
        </button>
      </div>
    </div>
  );
}

export default function Connectors(props: SettingsPanelProps): JSX.Element {
  const ws = useWorkspace();
  const panel = usePanelData(props, () => settingsApi.extensions.list());

  const connectors = (items: SettingsItem[]) =>
    panel.visible(items).filter((i) => {
      const category = extraString(i, "category");
      return category === "mcp" || category === "connector";
    });

  const act = async (label: string, run: () => Promise<unknown>) => {
    const done = await withBusy(ws, label, run);
    if (!done) return;
    ws.notify(`${label}完成`);
    panel.refetch();
  };

  return (
    <PanelFrame data={panel.data} refetch={panel.refetch}>
      {(d) => (
        <>
          <AddMcpForm onAdded={panel.refetch} />
          <div class="settings-group" data-count={connectors(d.items).length}>
            <h3 class="section-title">已装（{connectors(d.items).length}）</h3>
            <Show when={connectors(d.items).length > 0} fallback={<div class="empty">还没有装扩展</div>}>
              <For each={connectors(d.items)}>
                {(item) => (
                  <SettingRow
                    label={item.label}
                    summary={item.summary}
                    badge={
                      <>
                        <span class="chip">{extraString(item, "category")}</span>
                        <Show when={extraString(item, "trusted") === "true" || item.extra?.trusted === true}>
                          <Badge tone="observed">已授信</Badge>
                        </Show>
                      </>
                    }
                    control={
                      <div class="row wrap" style={{ gap: "6px" }}>
                        <button
                          class="btn btn-sm"
                          disabled={ws.busy() !== null}
                          onClick={() => void act(`验证 ${item.key}`, () => settingsApi.extensions.verify(item.key))}
                        >
                          验证
                        </button>
                        <button
                          class="btn btn-sm btn-danger"
                          disabled={ws.busy() !== null}
                          onClick={() => void act(`卸载 ${item.key}`, () => settingsApi.extensions.remove(item.key))}
                        >
                          卸载
                        </button>
                      </div>
                    }
                    footer={
                      <div class="col" style={{ gap: "4px" }}>
                        <Show when={extraList(item, "tools").length > 0}>
                          <div class="row wrap" style={{ gap: "4px" }}>
                            <For each={extraList(item, "tools")}>
                              {(tool) => <span class="chip mono">{tool}</span>}
                            </For>
                          </div>
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
            </Show>
          </div>
        </>
      )}
    </PanelFrame>
  );
}
