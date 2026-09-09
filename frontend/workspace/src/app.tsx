import { For, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { BottomPanel } from "./components/bottom";
import { CenterPanel } from "./components/center";
import { LeftPanel } from "./components/left";
import { RightPanel } from "./components/right";
import { api } from "./lib/api";
import { Badge, Spinner } from "./components/ui";
import { useWorkspace, WorkspaceProvider } from "./state";

function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = createSignal<"light" | "dark">(
    (document.documentElement.dataset.theme as "light" | "dark") ?? "light",
  );
  const toggle = () => {
    const next = theme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("spark-theme", next);
    setTheme(next);
  };
  return (
    <button
      class="btn btn-sm btn-ghost"
      onClick={toggle}
      aria-label={`切换到${theme() === "dark" ? "浅色" : "深色"}主题`}
      title="切换主题"
    >
      {theme() === "dark" ? "☀" : "☾"}
    </button>
  );
}

function Toasts(): JSX.Element {
  const ws = useWorkspace();
  return (
    <For each={ws.toasts}>
      {(toast, index) => (
        <div
          class="toast"
          data-kind={toast.kind}
          role={toast.kind === "error" ? "alert" : "status"}
          style={{ bottom: `${16 + index() * 52}px` }}
        >
          {toast.message}
        </div>
      )}
    </For>
  );
}

function Shell(): JSX.Element {
  const ws = useWorkspace();

  // 键盘：1-5 切换中栏视图（不在输入框里时）。焦点态由 :focus-visible 统一处理。
  onMount(() => {
    const views = ["session", "papers", "cards", "ideas", "artifacts"] as const;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < views.length) {
        ws.setView({ kind: views[index]! });
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="app">
      <header class="head">
        <span class="brand">Spark Research</span>
        <Show when={ws.project()} fallback={<Spinner label="打开项目…" />}>
          {(project) => (
            <>
              <Badge tone="computed">{project().slug}</Badge>
              <span class="faint" style={{ "font-size": "12px" }}>
                {project().counts.records} record · {project().counts.papers} 文献 ·{" "}
                {project().counts.ideas} 思路
              </span>
            </>
          )}
        </Show>
        <span class="spacer" />
        <Show when={ws.busy()}>
          <Spinner label={ws.busy()!} />
        </Show>
        <Show when={ws.project()}>
          {/* 导出走 GET /api/report?format=markdown：浏览器直接下载，前端不复制一份渲染逻辑。 */}
          <a
            class="btn btn-sm"
            href={api.report.markdownUrl(ws.slug())}
            download=""
            title="导出研究报告（Markdown，结论区受 review 门槛约束）"
          >
            导出报告
          </a>
        </Show>
        <ThemeToggle />
      </header>

      <LeftPanel />
      <CenterPanel />
      <RightPanel />
      <BottomPanel />
      <Toasts />
    </div>
  );
}

export function App(): JSX.Element {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}
