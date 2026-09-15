import { For, Show, createEffect, createResource, createSignal, type JSX } from "solid-js";
import { settingsApi, type GeneralItem } from "../../lib/settings_api";
import { useWorkspace, withBusy } from "../../state";
import { Async, Badge } from "../ui";
import { PanelGroup, SettingRow, matches } from "./common";
import type { SettingsPanelProps } from "./registry";

// 通用面板 = `CONFIG_SETTINGS` 的网页端投影（U6 修改方向 A）。
//
// **这个文件里没有任何一条配置项的说明文字。** `summary` / `effect` 全部来自
// `GET /api/settings/general` 的响应体，后端从 `CONFIG_SETTINGS` 原样投影过来。
// `spark-research config list` 里已经有一份，网页端再抄一份就会分家——U6 的证据段
// 明写「每个键的说明文字 config list 里已经有了，直接用，不要另写一份」。
// tests/unit/settings_registry.test.ts ③ 会 grep 这个目录，抄了就红。

/** 把 API 给的值渲染成输入框里的字符串。list 用逗号分隔（与 CLI 的写法一致）。 */
function toInput(value: GeneralItem["value"]): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

/** 把输入框的字符串解回 API 要的类型。校验在后端（写入时就校验，不等运行时炸）。 */
function fromInput(item: GeneralItem, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (item.type === "number") return Number(trimmed);
  if (item.type === "boolean") return trimmed === "true";
  if (item.type === "list") return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  return trimmed;
}

export function GeneralRows(props: SettingsPanelProps & { endpoint: "general" | "network" }): JSX.Element {
  const ws = useWorkspace();
  const api = () => (props.endpoint === "network" ? settingsApi.network : settingsApi.general);
  const [data, ctl] = createResource(() => api().list());
  const [draft, setDraft] = createSignal<Record<string, string>>({});

  // 面板拿到 API 数据后，把「有哪些设置项、每项的可搜文本」登记给壳。文本是 API 给的
  // 原文拼出来的，不是前端另写的——登记也不许变成第二份说明。
  createEffect(() => {
    const items = data()?.items;
    if (!items) return;
    props.register(items.map((i) => ({ key: i.key, text: `${i.key} ${i.summary} ${i.effect}` })));
  });

  const visible = (items: GeneralItem[]) =>
    items.filter((i) => matches(props.query, `${i.key} ${i.summary} ${i.effect}`));

  const value = (item: GeneralItem) => draft()[item.key] ?? toInput(item.value);

  const save = async (item: GeneralItem) => {
    const next = fromInput(item, value(item));
    const done = await withBusy(ws, `保存 ${item.key}`, () =>
      props.endpoint === "network"
        ? settingsApi.network.set(item.key, next)
        : settingsApi.general.set(item.key, next),
    );
    if (!done) return;
    setDraft((d) => {
      const { [item.key]: _dropped, ...rest } = d;
      return rest;
    });
    ws.notify(`${item.key} 已保存`);
    void ctl.refetch();
  };

  const reset = async (item: GeneralItem) => {
    const done = await withBusy(ws, `恢复默认 ${item.key}`, () => settingsApi.general.reset(item.key));
    if (!done) return;
    setDraft((d) => {
      const { [item.key]: _dropped, ...rest } = d;
      return rest;
    });
    ws.notify(`${item.key} 已恢复默认值`);
    void ctl.refetch();
  };

  const control = (item: GeneralItem): JSX.Element => {
    // 凭据类 key 在这条路由上是只读的：后端 PUT/DELETE 会 403 并指向凭据面板。
    // 这里不渲染输入框——渲染一个注定 403 的输入框就是个死按钮。
    if (item.secret) {
      return (
        <div class="row wrap" style={{ gap: "8px", "align-items": "center" }}>
          <Badge tone={item.configured ? "observed" : "inferred"}>
            {item.configured ? "已配置" : "未配置"}
          </Badge>
          <span class="faint" style={{ "font-size": "11.5px" }}>
            {data()?.meta?.secretNextStep ?? "这一项是凭据，在「凭据」面板里填。"}
          </span>
        </div>
      );
    }
    if (item.type === "boolean") {
      return (
        <label class="row" style={{ gap: "6px", "align-items": "center" }}>
          <input
            type="checkbox"
            checked={value(item) === "true"}
            aria-label={item.key}
            onChange={(e) => {
              setDraft((d) => ({ ...d, [item.key]: e.currentTarget.checked ? "true" : "false" }));
              void save(item);
            }}
          />
          <span class="faint">{value(item) === "true" ? "开" : "关"}</span>
        </label>
      );
    }
    if (item.type === "enum" && item.allowed?.length) {
      return (
        <select
          class="select"
          aria-label={item.key}
          value={value(item)}
          onChange={(e) => {
            setDraft((d) => ({ ...d, [item.key]: e.currentTarget.value }));
            void save(item);
          }}
        >
          <option value="">（不设置）</option>
          <For each={item.allowed}>{(option) => <option value={option}>{option}</option>}</For>
        </select>
      );
    }
    return (
      <div class="row wrap" style={{ gap: "6px" }}>
        <input
          class="input"
          aria-label={item.key}
          type={item.type === "number" ? "number" : "text"}
          value={value(item)}
          placeholder={toInput(item.defaultValue) || "（无默认值）"}
          onInput={(e) => setDraft((d) => ({ ...d, [item.key]: e.currentTarget.value }))}
          onKeyDown={(e) => e.key === "Enter" && void save(item)}
        />
        <button class="btn btn-sm btn-primary" onClick={() => void save(item)} disabled={ws.busy() !== null}>
          保存
        </button>
        <Show when={props.endpoint === "general" && item.source !== "default"}>
          <button class="btn btn-sm" onClick={() => void reset(item)} disabled={ws.busy() !== null}>
            恢复默认
          </button>
        </Show>
      </div>
    );
  };

  return (
    <Async
      state={{ loading: data.loading, error: data.error, data: data() }}
      onRetry={() => void ctl.refetch()}
      isEmpty={(d) => visible(d.items).length === 0}
      empty={{ title: "没有匹配的设置项", hint: "换个搜索词，或清空搜索框看全部。" }}
    >
      {(d) => (
        <PanelGroup title={`${visible(d.items).length} / ${d.items.length} 项`}>
          <For each={visible(d.items)}>
            {(item) => (
              <SettingRow
                label={item.key}
                summary={item.summary}
                effect={item.effect}
                source={item.source}
                control={control(item)}
              />
            )}
          </For>
        </PanelGroup>
      )}
    </Async>
  );
}

export default function General(props: SettingsPanelProps): JSX.Element {
  return <GeneralRows query={props.query} register={props.register} endpoint="general" />;
}
