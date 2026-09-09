import { For, Show, createEffect, createMemo, onCleanup, type JSX } from "solid-js";
import { renderMarkdown } from "../lib/markdown";

// 共用小件。刻意都是无状态函数组件：状态住在 state.tsx，这里只负责长相。

export function Spinner(props: { label?: string }): JSX.Element {
  return (
    <span class="row" style={{ gap: "6px" }}>
      <span class="spinner" aria-hidden="true" />
      <span class="muted">{props.label ?? "加载中…"}</span>
      <span class="sr-only" role="status">
        {props.label ?? "加载中"}
      </span>
    </span>
  );
}

export function EmptyState(props: { title: string; hint?: string }): JSX.Element {
  return (
    <div class="empty">
      <div>{props.title}</div>
      <Show when={props.hint}>
        <div class="faint" style={{ "margin-top": "4px", "font-size": "12px" }}>
          {props.hint}
        </div>
      </Show>
    </div>
  );
}

export function ErrorBox(props: { error: unknown; onRetry?: () => void }): JSX.Element {
  const message = () =>
    props.error instanceof Error ? props.error.message : String(props.error ?? "未知错误");
  return (
    <div class="error-box" role="alert">
      <div style={{ "white-space": "pre-wrap" }}>{message()}</div>
      <Show when={props.onRetry}>
        <button class="btn btn-sm" style={{ "margin-top": "8px" }} onClick={() => props.onRetry?.()}>
          重试
        </button>
      </Show>
    </div>
  );
}

// 三态包装：加载 / 出错 / 有数据。每个面板都走它，省得各处手写 if。
export function Async<T>(props: {
  state: { loading: boolean; error: unknown; data: T | undefined };
  empty?: { title: string; hint?: string };
  isEmpty?: (data: T) => boolean;
  onRetry?: () => void;
  children: (data: T) => JSX.Element;
}): JSX.Element {
  return (
    <Show
      when={!props.state.loading || props.state.data !== undefined}
      fallback={
        <div class="loading">
          <Spinner />
        </div>
      }
    >
      <Show when={!props.state.error} fallback={<ErrorBox error={props.state.error} onRetry={props.onRetry} />}>
        <Show
          when={props.state.data !== undefined && !(props.isEmpty?.(props.state.data as T) ?? false)}
          fallback={<EmptyState title={props.empty?.title ?? "暂无内容"} hint={props.empty?.hint} />}
        >
          {props.children(props.state.data as T)}
        </Show>
      </Show>
    </Show>
  );
}

const BADGE_TONE: Record<string, string> = {
  observed: "badge-ok",
  computed: "badge-accent",
  sourced: "badge-ok",
  inferred: "badge-warn",
  awaiting_approval: "badge-warn",
  rejected: "badge-danger",
  failed: "badge-danger",
  concluded: "badge-ok",
  iterated: "badge",
  wet_run: "badge-accent",
  analyze: "badge-accent",
  "checked-overlap": "badge-warn",
  "checked-novel": "badge-ok",
  "checked-incremental": "badge-accent",
  unchecked: "badge",
};

export function Badge(props: { children: JSX.Element; tone?: string; title?: string }): JSX.Element {
  const cls = () => `badge ${props.tone ? BADGE_TONE[props.tone] ?? "badge" : ""}`;
  return (
    <span class={cls()} title={props.title}>
      {props.children}
    </span>
  );
}

// 焦点陷阱 + Esc 关闭。approve 弹窗必须能纯键盘走完，否则「人在环」只对鼠标用户成立。
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
}): JSX.Element {
  let panel: HTMLDivElement | undefined;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab" || !panel) return;
    const focusable = panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  createEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel?.querySelector<HTMLElement>("input, textarea, button")?.focus();
    onCleanup(() => previous?.focus());
  });

  return (
    <div
      class="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        ref={panel}
        onKeyDown={onKeyDown}
      >
        <div class="modal-head">
          <span>{props.title}</span>
          <span class="spacer" />
          <button class="btn btn-sm btn-ghost" onClick={() => props.onClose()} aria-label="关闭">
            ✕
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
        <Show when={props.footer}>
          <div class="modal-foot">{props.footer}</div>
        </Show>
      </div>
    </div>
  );
}

// Markdown 正文。innerHTML 的内容全部来自 renderMarkdown（先转义再套白名单标记）。
export function Markdown(props: { source: string; knownKeys?: Set<string> }): JSX.Element {
  const html = createMemo(() => renderMarkdown(props.source, { knownKeys: props.knownKeys }));
  return <div class="md" innerHTML={html()} />;
}

// 轻量折线图（能量曲线一类）。SVG 手绘，不引图表库——P7 范围里科学渲染「以轻量为限」。
export function LineChart(props: {
  points: number[];
  label?: string;
  width?: number;
  height?: number;
}): JSX.Element {
  const geometry = createMemo(() => {
    const width = props.width ?? 320;
    const height = props.height ?? 96;
    const pad = 18;
    const values = props.points.filter((v) => Number.isFinite(v));
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    // 常数序列的 span=0，除下去会得到 NaN——退化成一条居中的水平线。
    const span = max - min || 1;
    const stepX = (width - pad * 2) / (values.length - 1);
    const d = values
      .map((value, i) => {
        const x = pad + i * stepX;
        const y = height - pad - ((value - min) / span) * (height - pad * 2);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return { width, height, pad, min, max, d };
  });

  return (
    <Show when={geometry()} fallback={<div class="faint">数据点不足，画不出曲线</div>}>
      {(g) => (
        <svg
          class="chart"
          viewBox={`0 0 ${g().width} ${g().height}`}
          role="img"
          aria-label={`${props.label ?? "曲线"}：${props.points.length} 个采样点，从 ${g().min.toPrecision(4)} 到 ${g().max.toPrecision(4)}`}
        >
          <line
            class="chart-axis"
            x1={g().pad}
            y1={g().height - g().pad}
            x2={g().width - g().pad}
            y2={g().height - g().pad}
          />
          <line class="chart-axis" x1={g().pad} y1={g().pad} x2={g().pad} y2={g().height - g().pad} />
          <path class="chart-line" d={g().d} />
          <text class="chart-label" x={g().pad + 2} y={g().pad - 5}>
            {g().max.toPrecision(4)}
          </text>
          <text class="chart-label" x={g().pad + 2} y={g().height - g().pad - 3}>
            {g().min.toPrecision(4)}
          </text>
        </svg>
      )}
    </Show>
  );
}

// 键值表（实验摘要、协议元信息）。
export function KeyValues(props: { entries: Array<[string, unknown]> }): JSX.Element {
  return (
    <dl class="kv">
      <For each={props.entries.filter(([, v]) => v !== null && v !== undefined && v !== "")}>
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
