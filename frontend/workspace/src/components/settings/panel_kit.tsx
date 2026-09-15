import { For, Show, createEffect, createResource, createSignal, type JSX, type Resource } from "solid-js";
import type { SettingsItem, SettingsMeta, SettingsPanelResponse } from "../../lib/settings_api";
import { ApiError } from "../../lib/api";
import { useWorkspace } from "../../state";
import { Async, Badge } from "../ui";
import { SettingRow, matches } from "./common";
import type { SettingsPanelProps, SettingsSearchEntry } from "./registry";

// 面板引擎。
//
// γ 的契约把**所有面板的条目统一成一个 `SettingsItem`**（`{ key, label, kind, value,
// editable, summary, nextStep, extra }`），所以十一个面板的共同部分只需要写一遍：
// 取数 → 登记搜索索引 → 按 query 过滤 → 按 `kind` 渲染控件 → 写回去刷新。
// 各面板剩下的只有自己那点特殊长相（凭据的字段表、检索源的勾选、MCP 的添加表单……）。
//
// 三条纪律钉在这里，不在各面板里各写一遍：
//   ① **说明只有一份**：`summary` / `effect` / `notes` 一律渲染 API 给的字符串。
//   ② **不可写的条目不给控件**：`editable === false` 渲染 `nextStep`（去哪做），
//      而不是一个点了必然 403 的输入框。死按钮比缺功能更糟。
//   ③ **能力分级来自 API**：`meta.level` 由后端标注，前端不存第二份。

/** 一个条目参与搜索匹配的全部文本。索引登记与行过滤用同一个函数，不会对不上。 */
export function itemText(item: SettingsItem): string {
  return [item.key, item.label, item.summary, item.effect ?? "", item.nextStep ?? ""].join(" ");
}

const LEVEL_LABEL: Record<SettingsMeta["level"], string> = {
  full: "全功能",
  reduced: "减配",
  readonly: "只读",
};

/** 面板抬头：能力分级 + 一句话说明 + 注意事项，**全部来自 API 的 meta**。 */
export function PanelMeta(props: { meta: SettingsMeta }): JSX.Element {
  return (
    <div class="settings-meta">
      <div class="row wrap" style={{ gap: "8px", "align-items": "center" }}>
        <Badge tone={props.meta.level === "full" ? "observed" : "inferred"}>
          {LEVEL_LABEL[props.meta.level]}
        </Badge>
        <span class="faint" style={{ "font-size": "11.5px" }}>
          {props.meta.summary}
        </span>
      </div>
      <Show when={props.meta.notes.length > 0}>
        <ul class="settings-notes">
          <For each={props.meta.notes}>{(note) => <li>{note}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}

/** 取数 + 登记搜索索引 + 过滤。每个面板都从这里开头。 */
export function usePanelData(
  props: SettingsPanelProps,
  load: () => Promise<SettingsPanelResponse>,
): {
  data: Resource<SettingsPanelResponse>;
  refetch: () => void;
  visible: (items: SettingsItem[]) => SettingsItem[];
} {
  const [data, ctl] = createResource(load);

  createEffect(() => {
    const items = data()?.items;
    if (!items) return;
    const entries: SettingsSearchEntry[] = items.map((i) => ({ key: i.key, text: itemText(i) }));
    props.register(entries);
  });

  return {
    data,
    refetch: () => void ctl.refetch(),
    visible: (items) => items.filter((i) => matches(props.query, itemText(i))),
  };
}

/** 三态 + 空态 + 抬头的统一外壳。 */
export function PanelFrame(props: {
  data: Resource<SettingsPanelResponse>;
  refetch: () => void;
  isEmpty?: (data: SettingsPanelResponse) => boolean;
  children: (data: SettingsPanelResponse) => JSX.Element;
}): JSX.Element {
  return (
    <Async
      state={{ loading: props.data.loading, error: props.data.error, data: props.data() }}
      onRetry={props.refetch}
      isEmpty={props.isEmpty}
      empty={{ title: "没有匹配的设置项", hint: "换个搜索词，或清空搜索框看全部。" }}
    >
      {(d) => (
        <>
          <PanelMeta meta={d.meta} />
          {props.children(d)}
        </>
      )}
    </Async>
  );
}

/** 输入框里的字符串 → 写路由要的类型。校验在后端（写入时就校验，不等运行时炸）。 */
export function coerce(item: SettingsItem, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (item.kind === "number") return Number(trimmed);
  if (item.kind === "bool") return trimmed === "true";
  return trimmed;
}

function toInput(value: SettingsItem["value"]): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * 按 `kind` 渲染一个条目的控件。
 *
 * `write` 是面板给的写回调——写路由各不相同（`PUT /general/:key`、`PUT /models/default`、
 * `PUT /compute/target`……），引擎不猜，由面板传进来。
 */
export function ItemControl(props: {
  item: SettingsItem;
  write?: (item: SettingsItem, value: string) => Promise<unknown>;
  onWritten?: () => void;
  /** 额外的行内动作（如 general 的「恢复默认」）。 */
  extraActions?: JSX.Element;
}): JSX.Element {
  const ws = useWorkspace();
  const [draft, setDraft] = createSignal<string | null>(null);
  // V159（ε-2）：写被拒时的行内失败。此前 `withBusy` 只把消息丢进 toast——
  // toast 三秒就飘走，而且离「是哪一项被拒了」隔着半个屏幕；U19 的原话是
  // 「设置项被 422 拒时界面不显示错误」。现在错在哪一行，就写在哪一行下面。
  const [failure, setFailure] = createSignal<{ message: string; nextStep: string | null } | null>(null);
  const value = () => draft() ?? toInput(props.item.value);

  const commit = async (next: string) => {
    if (!props.write) return;
    setFailure(null);
    ws.setBusy(`保存 ${props.item.key}`);
    try {
      await props.write(props.item, next);
      setDraft(null);
      ws.notify(`${props.item.key} 已保存`);
      props.onWritten?.();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      // `ApiError.message` 里已经把 nextStep 拼在第二行（api.ts 的既有口径，toast 靠它）；
      // 行内要分两行显示，所以从 `ApiError.nextStep` 单独取，取不到才退回整段消息。
      const nextStep = error instanceof ApiError ? error.nextStep : null;
      setFailure({ message: nextStep ? raw.split("\n")[0]! : raw, nextStep });
      // toast 照旧发：别的地方（右上角通知区）仍然靠它，行内显示是**多一处**不是换一处。
      ws.notify(raw, "error");
    } finally {
      ws.setBusy(null);
    }
  };

  /** 行内失败条：为什么不行 + 去哪做。三种控件共用一份，不在每个分支各写一遍。 */
  const failureBox = (): JSX.Element => (
    <Show when={failure()}>
      {(f) => (
        <div class="settings-row__error" role="alert" data-testid={`setting-error-${props.item.key}`}>
          <span>{f().message}</span>
          <Show when={f().nextStep}>
            <span class="faint" data-testid={`setting-error-next-${props.item.key}`}>
              下一步：{f().nextStep}
            </span>
          </Show>
        </div>
      )}
    </Show>
  );

  // 不可写 = 不给控件。`nextStep` 是「那去哪做」，U6 点名批过只报状态不给下一步。
  if (!props.item.editable || !props.write) {
    return (
      <div class="row wrap" style={{ gap: "8px", "align-items": "center" }}>
        <Show when={props.item.kind === "secret"}>
          <Badge tone={props.item.configured ? "observed" : "inferred"}>
            {props.item.configured ? "已配置" : "未配置"}
          </Badge>
        </Show>
        <Show when={props.item.kind !== "secret" && toInput(props.item.value) !== ""}>
          <span class="mono">{toInput(props.item.value)}</span>
        </Show>
        <Show when={props.item.nextStep}>
          <span class="faint" style={{ "font-size": "11.5px" }}>
            {props.item.nextStep}
          </span>
        </Show>
      </div>
    );
  }

  if (props.item.kind === "bool") {
    return (
      <>
        <label class="row" style={{ gap: "6px", "align-items": "center" }}>
          <input
            type="checkbox"
            aria-label={props.item.key}
            checked={value() === "true"}
            onChange={(e) => void commit(e.currentTarget.checked ? "true" : "false")}
          />
          <span class="faint">{value() === "true" ? "开" : "关"}</span>
        </label>
        {failureBox()}
      </>
    );
  }

  if (props.item.kind === "enum" && props.item.allowed?.length) {
    return (
      <>
        <div class="row wrap" style={{ gap: "6px" }}>
          <select
            class="select"
            aria-label={props.item.key}
            value={value()}
            onChange={(e) => void commit(e.currentTarget.value)}
          >
            <option value="">（不设置）</option>
            <For each={props.item.allowed}>{(option) => <option value={option}>{option}</option>}</For>
          </select>
          {props.extraActions}
        </div>
        {failureBox()}
      </>
    );
  }

  return (
    <>
      <div class="row wrap" style={{ gap: "6px" }}>
        <input
          class="input"
          aria-label={props.item.key}
          type={props.item.kind === "number" ? "number" : "text"}
          value={value()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && void commit(value())}
        />
        <button
          class="btn btn-sm btn-primary"
          onClick={() => void commit(value())}
          disabled={ws.busy() !== null}
        >
          保存
        </button>
        {props.extraActions}
      </div>
      {failureBox()}
    </>
  );
}

/** 一整块「条目列表」。绝大多数面板就是这一行。 */
export function ItemList(props: {
  items: SettingsItem[];
  write?: (item: SettingsItem, value: string) => Promise<unknown>;
  onWritten?: () => void;
  actionsFor?: (item: SettingsItem) => JSX.Element | undefined;
  footerFor?: (item: SettingsItem) => JSX.Element | undefined;
}): JSX.Element {
  return (
    <For each={props.items}>
      {(item) => (
        <SettingRow
          label={item.label}
          summary={item.summary}
          effect={item.effect}
          source={item.source}
          badge={
            <Show when={item.key !== item.label}>
              <span class="mono faint" style={{ "font-size": "11px" }}>
                {item.key}
              </span>
            </Show>
          }
          control={
            <ItemControl
              item={item}
              write={props.write}
              onWritten={props.onWritten}
              extraActions={props.actionsFor?.(item)}
            />
          }
          footer={props.footerFor?.(item)}
        />
      )}
    </For>
  );
}

/**
 * 「取数 → 列条目 → 写回去」的面板，一行搞定。general / network / storage / compute /
 * permissions 都是它。
 */
export function SimpleItemsPanel(props: {
  panelProps: SettingsPanelProps;
  load: () => Promise<SettingsPanelResponse>;
  write?: (item: SettingsItem, value: string) => Promise<unknown>;
  actionsFor?: (item: SettingsItem, refetch: () => void) => JSX.Element | undefined;
  footerFor?: (item: SettingsItem, refetch: () => void) => JSX.Element | undefined;
}): JSX.Element {
  const panel = usePanelData(props.panelProps, props.load);
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
            write={props.write}
            onWritten={panel.refetch}
            actionsFor={(item) => props.actionsFor?.(item, panel.refetch)}
            footerFor={(item) => props.footerFor?.(item, panel.refetch)}
          />
        </div>
      )}
    </PanelFrame>
  );
}
