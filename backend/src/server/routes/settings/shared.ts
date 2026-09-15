import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import type {
  SettingsItem,
  SettingsMeta,
  SettingsPanelId,
  SettingsPanelResponse,
  SettingsWriteResponse,
} from "./types";

// 设置面路由的共用薄层。与 `routes/shared.ts` 同一条纪律：只做「解析 → 调用 → 序列化」，
// 不在这里长出第二套业务逻辑。业务在 `config/index.ts` / `capabilities/*` / `daemon/credentials.ts`。

/**
 * 远端地址解析器。生产走 Bun 的连接信息；测试注入伪造地址（AD-18 ② 的阴性对照靠它）。
 *
 * **为什么不读 header**：`X-Forwarded-For` / `Host` 这类头是请求方自己写的，
 * 拿它当远端地址等于把门禁交给攻击者填。只认传输层给的地址。
 */
export type RemoteAddressResolver = (c: Context) => string | null;

export interface SettingsRouteOptions {
  /** 只给测试注入；生产不传，走 `defaultRemoteAddress`。 */
  remoteAddress?: RemoteAddressResolver;
  /**
   * **只给进程内调用方用**（单测的 `app.fetch(new Request(...))`）：当作 loopback 放行。
   *
   * 它是一个**构造参数**，不是请求数据——请求方无论发什么头、什么 body 都拿不到它，
   * 只有在代码里构造这个路由器的人能给。生产的挂载点（`app.ts` 的
   * `app.route("/api/settings", settingsRoutes(ctx))`）不传它，所以生产路径上
   * 这个开关恒为 false。刻意不做成「`NODE_ENV=test` 时认某个请求头」——那种开关
   * 一旦生产环境的 NODE_ENV 被设错，就变成一个人人可发的绕过头。
   */
  assumeLoopback?: boolean;
}

export function defaultRemoteAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // 进程内 `app.fetch(new Request(...))`（MCP / 单测）没有连接信息。
    // 返回 null，而 null 一律**拒绝**（fail-closed，见 `isLoopbackRequest`）——
    // 进程内调用方要写凭据请用 `CredentialStore` / `auth --connector`，不要绕这条 HTTP 路径。
    return null;
  }
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]);

/**
 * AD-18 ②：凭据写路径的 loopback 硬限。**fail-closed。**
 *
 * **这条检查刻意不读 `originAllowlist`**——`app.ts` 的 D-7 闸允许用户把别的域名加进白名单，
 * 那是给「可信前端域名」开的口子；凭据写入不在那个口子里。白名单放开了，这条路径仍然 403。
 * 谁把下面这行改成去查 allowlist，`tests/unit/settings_credentials.test.ts` 的②会立刻红。
 *
 * **地址解析不出来（null）→ 403，不放行。**
 * 这一条在收口复核时被改过（原先是「解析不出来当进程内调用，放行」）。改的理由：
 * AD-18 的要义是**不受任何配置放开**，而「解析不出来就放行」本身就是一条隐性放开路径——
 * 一旦某个部署形态（反向代理、非 Bun 运行时、未来换适配器）让 `getConnInfo` 拿不到地址，
 * 这条硬限就静默失效，而且失效时没有任何信号。fail-open 的门禁等于没有门禁。
 *
 * 进程内调用（单测的 `app.fetch`）走 `SettingsRouteOptions.assumeLoopback` 这个**构造参数**，
 * 请求方拿不到它。见 `loopbackGuard()`。
 */
export function isLoopbackRequest(address: string | null): boolean {
  if (address === null) return false;
  return LOOPBACK_ADDRESSES.has(address.trim().toLowerCase());
}

/**
 * 凭据写路径的闸。所有需要 loopback 硬限的地方共用这一个，免得各写一份判定逻辑
 * ——那正是「两处算同一件事」迟早对不上的形状。
 */
export function loopbackGuard(options: SettingsRouteOptions): (c: Context) => boolean {
  // A8 U28（v0.9.0）：传输层是回环还不够——浏览器发来的请求还带 `Origin`。用户把某个远端域名
  // 加进 originAllowlist 是给「用远端页面看工作台」开的口子，不该顺带把凭据写路径也开给它：
  // 一个被加进白名单的页面就能在用户本机上改写/删除凭据。所以这里对 Origin 单独再卡一道，
  // **不看 originAllowlist**：Origin 缺省（curl / 同源）或本身是回环才放行。
  if (options.assumeLoopback === true) return (c) => isLoopbackOrigin(c.req.header("origin"));
  const resolve = options.remoteAddress ?? defaultRemoteAddress;
  return (c) => isLoopbackRequest(resolve(c)) && isLoopbackOrigin(c.req.header("origin"));
}

/** Origin 头缺省 → true（非浏览器/同源）；有 → 主机名必须是回环。解析不出来的 Origin 一律拒。 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "" || origin === "null") return origin !== "null";
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export const LOOPBACK_REJECTION = {
  error: "凭据只接受本机（loopback）来源的写入请求",
  nextStep:
    "在运行 server 的那台机器上，用浏览器打开 http://127.0.0.1:<端口> 再操作（页面来源也必须是本机）；" +
    "或在终端执行 `spark-research auth --connector <id>` 写入凭据。" +
    "（这条限制不受 originAllowlist 影响，配置白名单也不会放开它；" +
    "取不到来源地址时同样拒绝，不会因为「看不出来是谁」就放行——AD-18 ②）",
} as const;

/** `?probe=1` 这类开关。与 `routes/shared.ts` 的 `queryBool` 同口径。 */
export function queryFlag(c: Context, name: string): boolean {
  const raw = c.req.query(name);
  return raw === "1" || raw === "true" || raw === "yes";
}

/** 统一错误出口：`{ error, nextStep }`，`nextStep` 非空是硬约定。 */
export function fail(c: Context, status: number, error: string, nextStep: string): Response {
  return c.json({ error, nextStep }, status as 400);
}

export function panel(
  c: Context,
  id: SettingsPanelId,
  items: SettingsItem[],
  meta: SettingsMeta,
): Response {
  return c.json({ panel: id, items, meta } satisfies SettingsPanelResponse);
}

export function written(
  c: Context,
  id: SettingsPanelId,
  item: SettingsItem,
  meta: SettingsMeta,
): Response {
  return c.json({ panel: id, item, meta } satisfies SettingsWriteResponse);
}

/** 请求体解析：非法 JSON 报 400 且带下一步，而不是 500。 */
export async function settingsBody(c: Context): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const BAD_BODY = {
  error: "请求体必须是 JSON 对象",
  nextStep: "用 `Content-Type: application/json` 发一个对象，如 `{\"value\": \"...\"}`",
} as const;
