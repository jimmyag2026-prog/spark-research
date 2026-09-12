import type { Context } from "hono";
import { HttpError, type ServerContext } from "../context";
import type { TaskSnapshot } from "../tasks";

// 路由层共用的小工具。刻意保持薄：真正的业务在各域模块里，HTTP 层只做
// 「解析 → 调用 → 序列化」，不允许在这里长出第二套业务逻辑。

export function queryString(c: Context, name: string): string | undefined {
  const value = c.req.query(name);
  return value === undefined || value === "" ? undefined : value;
}

export function queryNumber(c: Context, name: string): number | undefined {
  const raw = queryString(c, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new HttpError(400, `查询参数 ${name} 必须是数字，收到 '${raw}'`);
  return value;
}

export function queryBool(c: Context, name: string): boolean {
  const raw = queryString(c, name);
  return raw === "1" || raw === "true" || raw === "yes";
}

export function queryList(c: Context, name: string): string[] | undefined {
  const raw = queryString(c, name);
  return raw?.split(",").map((s) => s.trim()).filter(Boolean);
}

// R5 P0-2：写路由的项目归属此前**只看 query**，body 里的 `project` 被静默忽略，请求落进全局
// current-project 指针指向的项目——SDK 恰恰是 body 风格，等于「显式指定了项目仍然写错地方」，
// 且响应体还回报了错误的 project 名。这里让 body 成为 query 之后的兜底来源：
// 优先级 query > body（URL 里写死的最显式），两者都没有才落回当前项目指针。
// `jsonBody()` 解析完就把 body 挂在 context 上（见下），所有 POST 路由都是先 jsonBody 再取 slug，
// 所以这一处改动覆盖全部写路由，不必逐个改 47 个调用点。
const JSON_BODY_KEY = "__sparkJsonBody";

export function projectSlug(c: Context): string | undefined {
  const fromQuery = queryString(c, "project");
  if (fromQuery !== undefined) return fromQuery;
  const body = (c.get as (k: string) => unknown)(JSON_BODY_KEY) as Record<string, unknown> | undefined;
  const fromBody = body?.project;
  return typeof fromBody === "string" && fromBody.trim() !== "" ? fromBody : undefined;
}

// body 解析：非法 JSON 报 400 而不是 500——这是调用方的错，不是服务端崩了。
export async function jsonBody<T extends Record<string, unknown>>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text.trim()) return {} as T;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "请求体必须是 JSON 对象");
    }
    // R5 P0-2：挂到 context 上，供 projectSlug() 兜底读 body.project。
    (c.set as (k: string, v: unknown) => void)(JSON_BODY_KEY, parsed);
    return parsed as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `缺少必填字段: ${field}`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `字段 ${field} 必须是字符串`);
  return value.trim() === "" ? undefined : value;
}

export function optionalStringList(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new HttpError(400, `字段 ${field} 必须是字符串或字符串数组`);
  }
  return (value as string[]).map((s) => s.trim()).filter(Boolean);
}

export function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) throw new HttpError(400, `字段 ${field} 必须是数字`);
  return num;
}

// V79③：UI 的「预算 $」输入 / `allowUnpriced` 勾选框透传到 body 的解析——只做类型校验，
// 闸的判定逻辑在 usage/ledger.ts，这里不碰。
export function optionalBool(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `字段 ${field} 必须是布尔值`);
  return value;
}

// 长任务的统一出口。
//
// 默认异步：202 + 任务句柄，客户端轮询 `/api/tasks/:id` 或订阅 SSE。
// `{"await": true}`（或 `?await=1`）时同步等落定后返回终态——这是给 CLI 对照测试与
// e2e 用的确定性入口，UI 走异步路径。
export async function taskResponse(
  c: Context,
  ctx: ServerContext,
  body: Record<string, unknown>,
  options: { kind: string; project: string | null; run: Parameters<ServerContext["tasks"]["start"]>[0]["run"] },
): Promise<Response> {
  const snapshot = ctx.tasks.start({ kind: options.kind, project: options.project, run: options.run });
  const wantsAwait = body.await === true || queryBool(c, "await");
  if (!wantsAwait) {
    return c.json({ task: snapshot }, 202);
  }
  const settled: TaskSnapshot = (await ctx.tasks.settle(snapshot.id)) ?? snapshot;
  // 同步模式下任务失败要以 HTTP 错误呈现，否则调用方要靠读 body 才知道失败。
  return c.json({ task: settled }, settled.state === "failed" ? 500 : 200);
}
