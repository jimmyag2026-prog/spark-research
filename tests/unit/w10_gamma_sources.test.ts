import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ServerContext } from "../../backend/src/server/context";
import { settingsRoutes } from "../../backend/src/server/routes/settings";
import { runLitCommand } from "../../backend/src/literature/cli";
import { CredentialStore } from "../../backend/src/daemon/credentials";
import {
  describeSourceState,
  participationNextStep,
  sourceParticipation,
} from "../../backend/src/literature/source_state";

// v0.10 lane γ-1（V173 / U43）门禁：「勾没勾」×「有没有凭据」= 「本次会不会真查」。
//
// U43 的形状：配了凭据的源不在检索清单里，在检索清单里的源没有凭据，两件事各自都没报错。
// 所以下面的接线断言钉的是**第三件事出现在三个出口里**，不是「合取函数自己算得对」。

const SECRET_VALUE = "9f4c2a7e51b83d06c7e2a4f8b1d093ae";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "w10g1-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeApp(): Hono {
  const ctx = new ServerContext({ root });
  const app = new Hono();
  app.route("/api/settings", settingsRoutes(ctx, { assumeLoopback: true }));
  return app;
}

describe("γ-1 ① 三态合取", () => {
  test("已勾 + 有凭据 = 本次会真查", () => {
    expect(sourceParticipation({ selected: true, apiKeyRequired: true, credentialConfigured: true })).toBe("will_search");
  });
  test("已勾 + 需 key 但没配 = missing_credential（U43 的左半边：每次静默 skip）", () => {
    expect(sourceParticipation({ selected: true, apiKeyRequired: true, credentialConfigured: false })).toBe("missing_credential");
  });
  test("未勾 + 有凭据 = configured_not_selected（U43 的右半边：配了 key 从没用上）", () => {
    expect(sourceParticipation({ selected: false, apiKeyRequired: true, credentialConfigured: true })).toBe("configured_not_selected");
  });
  test("已勾 + 免 key = 会真查（不因为 credentialConfigured=false 就判跳过）", () => {
    expect(sourceParticipation({ selected: true, apiKeyRequired: false, credentialConfigured: false })).toBe("will_search");
  });
  test("对了的两态没有下一步——不许为了「每行都有话说」编一句", () => {
    expect(participationNextStep("will_search", "aminer")).toBeNull();
    expect(participationNextStep("not_selected", "cnki")).toBeNull();
  });
  test("configured_not_selected 的下一步点名这个源", () => {
    expect(participationNextStep("configured_not_selected", "aminer")).toContain("aminer");
    expect(describeSourceState("aminer", { selected: false, apiKeyRequired: true, credentialConfigured: true }).participationLabel)
      .toContain("没勾选");
  });
});

describe("γ-1 ② 接线：检索源面板每行都带三态", () => {
  test("GET /api/settings/scientific-tools 的 options 每条都有 selected / participation / participationLabel", async () => {
    const res = await makeApp().request("/api/settings/scientific-tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ key: string; extra?: Record<string, unknown> }> };
    const sources = body.items.find((i) => i.key === "searchSources");
    const options = sources?.extra?.options as Array<Record<string, unknown>> | undefined;
    expect(options && options.length).toBeGreaterThan(0);
    for (const o of options!) {
      expect(typeof o.selected).toBe("boolean");
      expect(["will_search", "missing_credential", "configured_not_selected", "not_selected"]).toContain(o.participation);
      expect(typeof o.participationLabel).toBe("string");
    }
  });

  test("没配 key 的 aminer 默认不在清单里 → 面板上它就是 not_selected，不是「可用」", async () => {
    const res = await makeApp().request("/api/settings/scientific-tools");
    const body = (await res.json()) as { items: Array<{ key: string; extra?: Record<string, unknown> }> };
    const options = (body.items.find((i) => i.key === "searchSources")!.extra!.options as Array<Record<string, unknown>>);
    const aminer = options.find((o) => o.id === "aminer")!;
    expect(aminer.selected).toBe(false);
    expect(aminer.participation).toBe("not_selected");
  });
});

describe("γ-1 ③ 接线：凭据写入成功后给可执行的下一步（U43 ②）", () => {
  test("写 aminer 的 key，而 aminer 不在 searchSources → 响应带「去检索源面板勾选 aminer」", async () => {
    const res = await makeApp().request("/api/settings/credentials/aminer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { api_key: SECRET_VALUE } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { nextStep: string | null } };
    expect(body.item.nextStep).toContain("检索源面板");
    expect(body.item.nextStep).toContain("aminer");
    // AD-18 ①：这条新加的 nextStep 里**不许**出现凭据值本身。
    expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
  });

  test("已经在 searchSources 里的源写完 key → 不再多嘴（nextStep 回到「已配置」的口径）", async () => {
    const app = makeApp();
    await app.request("/api/settings/sources", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["openalex", "aminer"] }),
    });
    const res = await app.request("/api/settings/credentials/aminer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { api_key: SECRET_VALUE } }),
    });
    const body = (await res.json()) as { item: { nextStep: string | null } };
    expect(body.item.nextStep).toBeNull();
  });

  test("不是检索源的凭据（LLM provider）不套用这句话——那个面板根本没有这一行", async () => {
    const res = await makeApp().request("/api/settings/credentials/KIMI_API_KEY", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { value: SECRET_VALUE } }),
    });
    const body = (await res.json()) as { item: { nextStep: string | null } };
    expect(body.item.nextStep ?? "").not.toContain("检索源面板");
  });
});

describe("γ-1 ④ 接线：`lit sources` 也显示三态", () => {
  test("配了 key 但不在检索清单的源，CLI 上看得见「本次不查」和下一步", async () => {
    const credentials = new CredentialStore({ root });
    credentials.set("aminer", { api_key: SECRET_VALUE });
    const lines: string[] = [];
    const code = await runLitCommand(["sources"], { root, credentials, out: (l) => lines.push(l), err: () => {} });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("本次会真查");            // 免 key 的那几个
    expect(text).toContain("已配凭据，但没勾选");     // U43 的右半边
    expect(text).toContain("去检索源面板勾选 aminer");
    // AD-2：凭据值永不出现。
    expect(text).not.toContain(SECRET_VALUE);
  });
});
