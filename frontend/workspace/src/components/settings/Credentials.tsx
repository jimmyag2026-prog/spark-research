import { For, Show, createSignal, type JSX } from "solid-js";
import { settingsApi, type SettingsItem } from "../../lib/settings_api";
import { useWorkspace, withBusy } from "../../state";
import { Badge, Modal } from "../ui";
import { SettingRow } from "./common";
import { PanelFrame, usePanelData } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 凭据面板 —— 方案「乙」在前端侧的落点（用户 2026-09-14 拍板；约束见 AD-18）。
//
// U6 的现场是：「界面**能告诉你**某个源需要 key、以及配没配，**却不给你任何地方把 key
// 填进去**」。这个面板给的就是那个地方。connector 与 LLM provider 统一在一张表里，
// 每行 = id · 需要哪些字段 · **哪些字段已设（只有字段名）** · `type="password"` 输入 ·
// 保存 / 删除。
//
// **值永不回显，而且不是靠自觉**：
//   · 契约层面 `SettingsItem.value` 在 `kind === "secret"` 时恒为 null，`GET` 只给
//     `fieldsSet: string[]`——前端连回显的材料都拿不到。
//   · 本组件保存成功后**立刻清空本地草稿**（`setDraft({})`），不把刚填的值留在内存里
//     等着某次重渲染把它画回输入框。
//   · e2e ㉛ 用 Playwright 的 `page.on("response")` 盯住**所有**响应体，填进去的假 key
//     一次都不许出现；同时断言整页文本里也没有它。把回显加回来那条阴性对照必须是红的。

/** 一行凭据的字段编辑器。 */
function CredentialRow(props: { item: SettingsItem; refetch: () => void }): JSX.Element {
  const ws = useWorkspace();
  const [draft, setDraft] = createSignal<Record<string, string>>({});
  const [confirming, setConfirming] = createSignal(false);

  const fields = () => props.item.fields ?? [];
  const fieldsSet = () => props.item.fieldsSet ?? [];
  const filled = () => Object.values(draft()).some((v) => v.trim() !== "");

  const save = async () => {
    const payload: Record<string, string> = {};
    for (const [name, value] of Object.entries(draft())) {
      if (value.trim() !== "") payload[name] = value;
    }
    if (Object.keys(payload).length === 0) return;
    const done = await withBusy(ws, `保存 ${props.item.key} 凭据`, () =>
      settingsApi.credentials.set(props.item.key, payload),
    );
    // 无论成败都先把草稿清掉：失败时把刚填的 key 继续留在输入框里，只是多给它一次
    // 被截图 / 被别人看见的机会，重填的成本远低于此。
    setDraft({});
    if (!done) return;
    ws.notify(`${props.item.key} 凭据已保存（值不会再显示出来）`);
    props.refetch();
  };

  const remove = async () => {
    const done = await withBusy(ws, `删除 ${props.item.key} 凭据`, () =>
      settingsApi.credentials.remove(props.item.key),
    );
    setConfirming(false);
    if (!done) return;
    // 确认文案由后端给（`note`），前端不另写一份「会不会影响外部账户」的说法。
    ws.notify(done.note);
    props.refetch();
  };

  return (
    <>
      <SettingRow
        label={props.item.label}
        summary={props.item.summary}
        badge={
          <>
            <span class="mono faint" style={{ "font-size": "11px" }}>
              {props.item.key}
            </span>
            <Badge tone={props.item.configured ? "observed" : "inferred"}>
              {props.item.configured ? "已配置" : "未配置"}
            </Badge>
          </>
        }
        control={
          <div class="col" style={{ gap: "6px", width: "100%" }}>
            <For each={fields()}>
              {(field) => (
                <label class="row wrap" style={{ gap: "6px", "align-items": "center" }}>
                  <span class="mono faint" style={{ "font-size": "11.5px", "min-width": "78px" }}>
                    {field}
                  </span>
                  {/* type="password" + autocomplete off：不让浏览器替我们把它存下来。 */}
                  <input
                    class="input"
                    type="password"
                    autocomplete="off"
                    spellcheck={false}
                    data-testid={`cred-${props.item.key}-${field}`}
                    aria-label={`${props.item.key} 的 ${field}`}
                    placeholder={fieldsSet().includes(field) ? "已设置（值不显示）" : "未设置"}
                    value={draft()[field] ?? ""}
                    onInput={(e) => setDraft({ ...draft(), [field]: e.currentTarget.value })}
                  />
                  <Show when={fieldsSet().includes(field)}>
                    <span class="badge badge-ok">已设</span>
                  </Show>
                </label>
              )}
            </For>
            <div class="row wrap" style={{ gap: "6px" }}>
              <button
                class="btn btn-sm btn-primary"
                data-testid={`cred-save-${props.item.key}`}
                disabled={!filled() || ws.busy() !== null}
                onClick={() => void save()}
              >
                保存
              </button>
              <Show when={fieldsSet().length > 0}>
                <button
                  class="btn btn-sm btn-danger"
                  disabled={ws.busy() !== null}
                  onClick={() => setConfirming(true)}
                >
                  删除
                </button>
              </Show>
            </div>
          </div>
        }
        footer={
          <Show when={props.item.nextStep}>
            <span class="faint" style={{ "font-size": "11.5px" }}>
              {props.item.nextStep}
            </span>
          </Show>
        }
      />

      <Show when={confirming()}>
        <Modal
          title={`删除 ${props.item.key} 的凭据`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button class="btn" onClick={() => setConfirming(false)}>
                取消
              </button>
              <button class="btn btn-danger" onClick={() => void remove()} disabled={ws.busy() !== null}>
                删除
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            将删除本机保存的 <span class="mono">{fieldsSet().join(" / ")}</span>。
          </p>
          {/* 「删了会怎样」的准确说法由后端在 DELETE 的 `note` 里给。这里只说会删掉哪些
              字段——那是前端自己知道的事实（`fieldsSet` 就在手上）。 */}
        </Modal>
      </Show>
    </>
  );
}

export default function Credentials(props: SettingsPanelProps): JSX.Element {
  const panel = usePanelData(props, () => settingsApi.credentials.list());
  return (
    <PanelFrame
      data={panel.data}
      refetch={panel.refetch}
      isEmpty={(d) => panel.visible(d.items).length === 0}
    >
      {(d) => (
        <div class="settings-group" data-count={panel.visible(d.items).length}>
          <For each={panel.visible(d.items)}>
            {(item) => <CredentialRow item={item} refetch={panel.refetch} />}
          </For>
        </div>
      )}
    </PanelFrame>
  );
}
