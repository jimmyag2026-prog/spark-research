import { For, Show, type JSX } from "solid-js";

// 设置面板共用的小件。和 `components/ui.tsx` 一样刻意无状态——状态住在各自面板里。
//
// 这里**没有任何一条设置项的说明文字**。说明一律由调用方从 API 响应里传进来
// （`SettingRow` 的 `summary` / `effect`）。前端写第二份说明正是 U6 修改方向里点名
// 禁止的事，也是 tests/unit/settings_registry.test.ts ③ 在 grep 级钉住的事。

/** 搜索匹配：query 已被壳 trim + 小写；空 query 一律算命中。 */
export function matches(query: string, text: string): boolean {
  if (!query) return true;
  return text.toLowerCase().includes(query);
}

/** 面板里的一个分组标题。 */
export function PanelGroup(props: { title: string; note?: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="settings-group">
      <h3 class="section-title">{props.title}</h3>
      <Show when={props.note}>
        <p class="faint" style={{ margin: "0 0 8px", "font-size": "11.5px" }}>
          {props.note}
        </p>
      </Show>
      {props.children}
    </section>
  );
}

/**
 * 一行设置。左边 key + 说明（**全部来自 API**），右边控件。
 *
 * `source` 是「这个值现在从哪来」——env / 配置文件 / 默认值。U5 的教训是「静默兜底」，
 * 界面上把来源摆出来，改之前就知道自己在改的是不是真正生效的那一层。
 */
export function SettingRow(props: {
  label: string;
  summary: string;
  effect?: string;
  source?: string;
  badge?: JSX.Element;
  control: JSX.Element;
  footer?: JSX.Element;
}): JSX.Element {
  return (
    <div class="settings-row" data-key={props.label}>
      <div class="settings-row__head">
        <span class="mono settings-row__key">{props.label}</span>
        {props.badge}
        <Show when={props.source}>
          <span class="badge" title="值的来源层">
            {props.source}
          </span>
        </Show>
      </div>
      <p class="settings-row__summary">{props.summary}</p>
      <Show when={props.effect}>
        <details class="settings-row__effect">
          <summary class="faint">影响什么</summary>
          <p class="faint">{props.effect}</p>
        </details>
      </Show>
      <div class="settings-row__control">{props.control}</div>
      <Show when={props.footer}>
        <div class="settings-row__footer">{props.footer}</div>
      </Show>
    </div>
  );
}

/**
 * 「这件事只能在终端做」的统一长相（照 bottom.tsx 审批弹窗里那条令牌提示的形状）。
 * 用在装载受信扩展、撤销授权这类**授权动作**上——它们不上 HTTP 是设计，不是缺功能，
 * 所以这里给的是命令而不是一个点了没反应的按钮。
 */
export function TerminalOnly(props: { what: string; command: string; why?: string }): JSX.Element {
  return (
    <div class="settings-terminal" role="note">
      <span class="faint" style={{ "font-size": "11.5px" }}>
        {props.what}需终端令牌：在终端运行 <code class="mono">{props.command}</code>
        {props.why ? `（${props.why}）` : ""}
      </span>
    </div>
  );
}

/** 只读键值对列表，用于 meta 段。 */
export function MetaList(props: { entries: Array<[string, string | number | null]> }): JSX.Element {
  return (
    <dl class="kv">
      <For each={props.entries.filter(([, v]) => v !== null && v !== "")}>
        {([key, value]) => (
          <>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </>
        )}
      </For>
    </dl>
  );
}

export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}
