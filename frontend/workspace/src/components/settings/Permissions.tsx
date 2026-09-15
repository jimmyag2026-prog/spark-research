import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import { settingsApi } from "../../lib/settings_api";
import { ItemList, PanelFrame, usePanelData } from "./panel_kit";
import type { SettingsPanelProps } from "./registry_table";

// 权限面板：谁被授了什么。**只读**——不传 `write`，引擎据此一个控件都不渲染，
// 每条改为显示它自己的 `nextStep`（在终端跑哪条命令去改）。
//
// 授予 / 撤销是授权动作，与算力的派发/审批同一条口径（AD-6）：不暴露成 HTTP 写路由。
// 摆一个「撤销」按钮再在点下去之后弹 403，比没有这个按钮更糟。
//
// V168（v0.10 ε-3）：「有效审批令牌」那几条**不随签发/消费变化**（U34）。
// 后端本来就是现读落盘文件数的（`routes/settings/permissions.ts` 的 `activeTokenCount`
// 每次请求都 `readFileSync` 一遍），所以偏差全在前端：`createResource` 只在挂载时取一次，
// 面板开着的这段时间里终端签发/消费了令牌，界面上那个数一动不动——**一个不会变的实时数
// 比没有这个数更骗人**。修法是让这个面板自己去拿新的：
//   ① 一枚 4 秒的轮询（令牌 10 分钟失效，4 秒的粒度足够，也不会把只读端点打疼）；
//   ② 一个手动「刷新」，并把「上次读到的时刻」写在旁边——让人看得出这个数有多新。
// 只改前端：后端那半边已经是实时的，不需要新端点（γ 若改了 API 以其为准）。

const POLL_MS = 4_000;

export default function Permissions(props: SettingsPanelProps): JSX.Element {
  const panel = usePanelData(props, () => settingsApi.permissions.list());
  const [readAt, setReadAt] = createSignal<number | null>(null);

  const reload = () => {
    panel.refetch();
    setReadAt(Date.now());
  };

  const timer = setInterval(reload, POLL_MS);
  onCleanup(() => clearInterval(timer));

  return (
    <PanelFrame data={panel.data} refetch={reload} isEmpty={(d) => panel.visible(d.items).length === 0}>
      {(d) => (
        <>
          <div class="row wrap" style={{ gap: "8px", "align-items": "center" }}>
            <button class="btn btn-sm" data-testid="permissions-refresh" onClick={reload}>
              刷新
            </button>
            <span class="faint" style={{ "font-size": "11.5px" }} data-testid="permissions-read-at">
              <Show when={readAt()} fallback="每 4 秒自动重读一次令牌文件">
                {(at) => `上次重读：${new Date(at()).toLocaleTimeString("zh-CN", { hour12: false })}`}
              </Show>
            </span>
          </div>
          <div class="settings-group" data-count={panel.visible(d.items).length}>
            <ItemList items={panel.visible(d.items)} />
          </div>
        </>
      )}
    </PanelFrame>
  );
}
