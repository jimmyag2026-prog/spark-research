import { For, Show, Suspense, createMemo, createSignal, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createStore } from "solid-js/store";
import { Modal, Spinner } from "../ui";
import {
  DEFAULT_PANEL,
  SETTINGS_PANELS,
  SETTINGS_SECTIONS,
  preloadPanel,
  type SettingsPanel,
  type SettingsPanelId,
  type SettingsSearchEntry,
} from "./registry";

// 设置壳。结构抄上游 OpenScience `dialog-settings.tsx`（Apache-2.0，Synthetic Sciences
// 2026）：左导航按 section 分组 + 右侧懒加载面板 + 标题栏。**组件不抄**——上游那 1599 行
// 里绝大部分是 Tailwind 类名与 `@synsci/ui` 的 Dialog/Icon/IconButton，我们只有 solid-js，
// 弹窗语义（焦点陷阱 / Esc / 点背景关闭）复用 `components/ui.tsx` 的 `Modal`，不另写一遍。
//
// 与上游的两处刻意不同：
//   ① 上游没有搜索框。我们加了一个，因为 U6 的现场是「32 个配置项在网页端一个也够不着」，
//      面板分完组之后「某个 key 在哪个面板」仍然是个问题。
//   ② 上游保留最近 3 个面板挂载（LRU）。我们只挂当前面板——Spark 的面板都是薄投影，
//      重挂一次就是一次 GET；但**搜索索引在卸载后保留**，见下面 `index` 的注释。

// 搜索索引：panelId → 该面板从 API 拿到的可搜项。
//
// **这张索引只覆盖本次打开过的面板**，`general` 除外（它是默认面板，壳一开就挂上，
// 所以那 32 个配置键永远可搜——U6 的主诉正是这 32 个键）。没建索引的面板在有搜索词时
// **不隐藏**，而是降一档显示并标出来：搜索匹配不到不等于里面没有，把它藏掉就是在
// UI 里做一个自己兑现不了的承诺。彻底的解法是后端给一条 `GET /api/settings` 总索引，
// 已作为「给 γ 的契约请求」提出。
type SearchIndex = Record<string, SettingsSearchEntry[]>;

export function SettingsShell(props: { onClose: () => void }): JSX.Element {
  const [active, setActive] = createSignal<SettingsPanelId>(DEFAULT_PANEL);
  const [rawQuery, setRawQuery] = createSignal("");
  const [index, setIndex] = createStore<SearchIndex>({});

  const query = createMemo(() => rawQuery().trim().toLowerCase());
  const current = createMemo(
    () => SETTINGS_PANELS.find((p) => p.id === active()) ?? SETTINGS_PANELS[0]!,
  );

  const register = (panelId: SettingsPanelId) => (entries: SettingsSearchEntry[]) =>
    setIndex(panelId, entries);

  /** 面板在当前搜索词下的状态：命中 / 不命中 / 还没建索引（所以说不准）。 */
  const panelState = (panel: SettingsPanel): "hit" | "miss" | "unindexed" => {
    const q = query();
    if (!q) return "hit";
    if (panel.title.toLowerCase().includes(q) || panel.id.includes(q)) return "hit";
    const entries = index[panel.id];
    if (!entries) return "unindexed";
    return entries.some((e) => e.text.toLowerCase().includes(q)) ? "hit" : "miss";
  };

  const hitCount = (panel: SettingsPanel): number => {
    const q = query();
    if (!q) return 0;
    return (index[panel.id] ?? []).filter((e) => e.text.toLowerCase().includes(q)).length;
  };

  const navigate = (id: SettingsPanelId) => {
    if (id === active()) return;
    setActive(id);
    void preloadPanel(id).catch(() => undefined);
  };

  const sectionPanels = (sectionId: string) =>
    SETTINGS_PANELS.filter((p) => p.section === sectionId).filter((p) => panelState(p) !== "miss");

  return (
    <Modal title="设置" wide bodyClass="settings-layout" onClose={props.onClose}>
      <nav class="settings-nav" aria-label="设置分组">
        <label class="sr-only" for="settings-search">
          搜索设置
        </label>
        <input
          id="settings-search"
          class="input"
          type="search"
          placeholder="搜索面板或设置项…"
          value={rawQuery()}
          onInput={(e) => setRawQuery(e.currentTarget.value)}
        />
        <For each={SETTINGS_SECTIONS}>
          {(section) => (
            <Show when={sectionPanels(section.id).length > 0}>
              <div class="settings-nav__section">
                <span class="settings-nav__label">{section.label}</span>
                <For each={sectionPanels(section.id)}>
                  {(panel) => (
                    <button
                      type="button"
                      class="nav-item settings-nav__item"
                      data-panel={panel.id}
                      data-state={panelState(panel)}
                      aria-current={active() === panel.id}
                      title={
                        panelState(panel) === "unindexed"
                          ? "这个面板还没打开过，里面的设置项没进搜索索引——打开一次就能搜"
                          : undefined
                      }
                      onPointerEnter={() => void preloadPanel(panel.id).catch(() => undefined)}
                      onClick={() => navigate(panel.id)}
                    >
                      <span aria-hidden="true" class="settings-nav__glyph">
                        {panel.glyph}
                      </span>
                      <span>{panel.title}</span>
                      <Show when={hitCount(panel) > 0}>
                        <span class="nav-count">{hitCount(panel)}</span>
                      </Show>
                      <Show when={panelState(panel) === "unindexed"}>
                        <span class="nav-count faint" aria-hidden="true">
                          ?
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          )}
        </For>
        <p class="faint settings-nav__foot">
          带 <span aria-hidden="true">?</span> 的面板本次还没打开过，里面的设置项没进搜索索引。
        </p>
      </nav>

      <div class="settings-main">
        <header class="settings-main__head">
          <span class="settings-main__title">{current().title}</span>
        </header>
        {/* 能力分级（全功能 / 减配 / 只读）与「少了哪一块」由面板自己从 API 的
            `meta` 里渲染（panel_kit 的 PanelMeta）——壳不存第二份分级。 */}
        <div class="settings-main__body" data-panel={current().id}>
          <Suspense fallback={<Spinner label="载入面板…" />}>
            <Dynamic component={current().component} query={query()} register={register(current().id)} />
          </Suspense>
        </div>
      </div>
    </Modal>
  );
}
