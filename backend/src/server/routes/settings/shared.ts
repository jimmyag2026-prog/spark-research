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
}

export function defaultRemoteAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // 进程内 `app.fetch(new Request(...))`（CLI / MCP / 单测）没有连接信息——
    // 返回 null，由 `isLoopbackRequest` 按「进程内调用」处理，见那里的判定注释。
    return null;
  }
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]);

/**
 * AD-18 ②：凭据写路径的 loopback 硬限。
 *
 * **这条检查刻意不读 `originAllowlist`**——`app.ts` 的 D-7 闸允许用户把别的域名加进白名单，
 * 那是给「可信前端域名」开的口子；凭据写入不在那个口子里。白名单放开了，这条路径仍然 403。
 * 谁把下面这行改成去查 allowlist，`tests/unit/settings_credentials.test.ts` 的②会立刻红。
 *
 * **判定：地址解析不出来（null）= 进程内调用，放行。** 与 `app.ts` 顶部「缺 Origin 恒放行」
 * 同一条理由：CLI / MCP 的 `app.fetch()` / curl 等价于「本机 shell 里跑的东西」，
 * 挡住它们只会把没坏的路径打红。真实的远端请求一定有传输层地址，拿不掉。
 */
export function isLoopbackRequest(address: string | null): boolean {
  if (address === null) return true;
  return LOOPBACK_ADDRESSES.has(address.trim().toLowerCase());
}

export const LOOPBACK_REJECTION = {
  error: "凭据只接受本机（loopback）来源的写入请求",
  nextStep:
    "在运行 server 的那台机器上操作；或在终端执行 `spark-research auth --connector <id>` 写入凭据。" +
    "（这条限制不受 originAllowlist 影响，配置白名单也不会放开它——AD-18 ②）",
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
