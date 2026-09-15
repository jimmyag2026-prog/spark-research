import { For, Show, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { BottomPanel } from "./components/bottom";
import { CenterPanel } from "./components/center";
import { LeftPanel } from "./components/left";
import { RightPanel } from "./components/right";
import { api } from "./lib/api";
import { SettingsShell } from "./components/settings/shell";
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

// U2：孤儿 server 活了两天没人发现，直接原因是「界面上没有任何地方提示你连的是个旧构建」。
// `/api/health.version` 一直有这个数，只是从来没上过屏。两个版本一致时只显示一枚安静的
// 徽标；不一致就变黄并说清是哪两个版本——不阻断，但没法再视而不见。
function VersionBadge(): JSX.Element {
  const [health] = createResource(() => api.health());
  const serverVersion = () => health()?.version;
  const mismatch = () => Boolean(serverVersion()) && serverVersion() !== __SPARK_UI_VERSION__;
  return (
    <Show when={serverVersion()}>
      <span
        class="badge"
        classList={{ "badge-warn": mismatch() }}
        data-testid="version-badge"
        data-mismatch={mismatch() ? "true" : "false"}
        title={
          mismatch()
            ? "浏览器里这份工作台和正在服务的 server 不是同一个构建。多半是有个旧 server 还在监听这个端口——先把它停掉再重开。"
            : "server 与工作台是同一个构建"
        }
      >
        {mismatch() ? `server v${serverVersion()} ≠ UI v${__SPARK_UI_VERSION__}` : `v${serverVersion()}`}
      </span>
    </Show>
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
      // 6 = 设置（U6）。它排在 1-5 那五个中栏视图后面，但不是第六个视图——
      // 它是覆盖层，开在当前视图之上，Esc 关掉回到原处。
      if (event.key === "6") {
        ws.setSettingsOpen(true);
        return;
      }
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
        <VersionBadge />
        <ThemeToggle />
      </header>

      <LeftPanel />
      <CenterPanel />
      <RightPanel />
      <BottomPanel />
      <Show when={ws.settingsOpen()}>
        <SettingsShell onClose={() => ws.setSettingsOpen(false)} />
      </Show>
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
