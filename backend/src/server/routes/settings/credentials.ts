import { Hono } from "hono";
import type { ServerContext } from "../../context";
import {
  BAD_BODY,
  LOOPBACK_REJECTION,
  defaultRemoteAddress,
  fail,
  isLoopbackRequest,
  panel,
  settingsBody,
  written,
  type SettingsRouteOptions,
} from "./shared";
import type { CredentialDeleteResponse, SettingsItem, SettingsMeta } from "./types";

// credentials 面板（方案「乙」，用户 2026-09-14 拍板；约束见 AD-18）。
//
// 六条硬约束，缺一条不许合：
//   ① write-only：任何响应 / 日志 / raw / record / usage 里永不出现凭据值
//   ② loopback 硬限，且**不受 originAllowlist 影响**
//   ③ 永不进 `process.env`
//   ④ 写入成功即登记进 `redactSecrets`
//   ⑤ 文件 0600，写后校验
//   ⑥ 删除有确认语义
// 对应 `tests/unit/settings_credentials.test.ts` 的六条。

export const DELETE_NOTE = "只删本机保存的值，不影响外部账户";

const META: SettingsMeta = {
  level: "full",
  summary: "各文献源 / 算力 connector 与各 LLM provider 的凭据：只看得到字段名，看不到值",
  notes: [
    "值写进来之后永不回显——响应、日志、raw、record、usage 里都不会再出现它（AD-18 ①）",
    "只接受本机（loopback）来源的写入；配了 originAllowlist 也不会放开这条路径（AD-18 ②）",
  ],
};

const FIXTURE: SettingsItem[] = [
  {
    key: "aminer",
    label: "AMiner",
    kind: "secret",
    value: null,
    configured: false,
    editable: true,
    summary: "AMiner 文献源的 API key",
    nextStep: "在本面板直填，或在终端执行 `spark-research auth --connector aminer`",
    fields: ["api_key"],
    fieldsSet: [],
    extra: { category: "connector" },
  },
];

export function credentialsRoutes(_ctx: ServerContext, options: SettingsRouteOptions = {}): Hono {
  const app = new Hono();
  const remoteAddress = options.remoteAddress ?? defaultRemoteAddress;

  app.get("/credentials", (c) => panel(c, "credentials", FIXTURE, META));

  // AD-18 ②：写路径先过 loopback 闸，再看别的。
  app.put("/credentials/:id", async (c) => {
    if (!isLoopbackRequest(remoteAddress(c))) {
      return fail(c, 403, LOOPBACK_REJECTION.error, LOOPBACK_REJECTION.nextStep);
    }
    const body = await settingsBody(c);
    if (body === null) return fail(c, 400, BAD_BODY.error, BAD_BODY.nextStep);
    return written(c, "credentials", FIXTURE[0]!, META);
  });

  app.delete("/credentials/:id", (c) => {
    if (!isLoopbackRequest(remoteAddress(c))) {
      return fail(c, 403, LOOPBACK_REJECTION.error, LOOPBACK_REJECTION.nextStep);
    }
    const id = c.req.param("id");
    return c.json({
      panel: "credentials",
      removed: true,
      id,
      note: DELETE_NOTE,
      item: FIXTURE[0]!,
    } satisfies CredentialDeleteResponse);
  });

  return app;
}
