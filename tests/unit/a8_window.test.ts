// v0.9.0 A8 修复窗口门禁（docs/devlog/A8.md：BLOCKER-1 / HIGH-1 / HIGH-2）。
// U32（凭据「删除」空操作）复核不成立，不在此列——见 docs/devlog/A8-window-fixes.md。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ServerContext } from "../../backend/src/server/context";
import { settingsRoutes } from "../../backend/src/server/routes/settings";
import { isLoopbackOrigin } from "../../backend/src/server/routes/settings/shared";
import { CredentialStore } from "../../backend/src/daemon/credentials";
import * as labToken from "../../backend/src/lab/approval_token";
import * as computeToken from "../../backend/src/compute/approval_token";
import { FakeLlm } from "../helpers/review_scenario";
import { makeServer, type ServerFixture } from "../helpers/server_scenario";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8w-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("U28 · 凭据写路径对 Origin 单独卡回环，不看 originAllowlist（AD-18 ②）", () => {
  const app = () => {
    const ctx = new ServerContext({ root });
    const h = new Hono();
    h.route("/api/settings", settingsRoutes(ctx, { assumeLoopback: true }));
    return h;
  };
  const put = (h: Hono, origin?: string) =>
    h.fetch(
      new Request("http://127.0.0.1/api/settings/credentials/semanticscholar", {
        method: "PUT",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ fields: { api_key: "a8-u28-fake-value" } }),
      }),
    );
  test("远端 Origin → 403 且不落盘；缺省 / 回环 Origin → 200", async () => {
    const h = app();
    const remote = await put(h, "http://a8-remote.example");
    expect(remote.status).toBe(403);
    expect(new CredentialStore({ root }).describe("semanticscholar")).toBeNull();
    expect((await put(h, "http://127.0.0.1:4321")).status).toBe(200);
    expect((await put(h)).status).toBe(200);
    const del = await h.fetch(
      new Request("http://127.0.0.1/api/settings/credentials/semanticscholar", { method: "DELETE", headers: { origin: "http://a8-remote.example" } }),
    );
    expect(del.status).toBe(403);
    expect(new CredentialStore({ root }).describe("semanticscholar")).not.toBeNull(); // 远端 DELETE 没删掉
  });
  test("isLoopbackOrigin 判定表", () => {
    expect(isLoopbackOrigin(undefined)).toBe(true);
    expect(isLoopbackOrigin("http://localhost:5173")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:4321")).toBe(true);
    expect(isLoopbackOrigin("null")).toBe(false);
    expect(isLoopbackOrigin("http://127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackOrigin("garbage")).toBe(false);
  });
});

describe("U29 · 规划调用失败即止：failure.kind=llm，不跑默认计划，不挂", () => {
  let fx: ServerFixture | undefined;
  afterEach(async () => {
    await fx?.stop();
    fx = undefined;
  });
  test("上游失败 → 一次调用后立即返回 failure，review 不 approved", async () => {
    const llm = new FakeLlm([{ ok: false, content: "网络层失败：Unable to connect" }, "不该被调到", "不该被调到"]);
    fx = makeServer({ slug: "a8u29", llm });
    const t0 = Date.now();
    const res = await fx.post<{ response: string; review?: { approved: boolean }; failure?: { kind: string } }>("/api/session/chat", {
      sessionId: "s-u29",
      message: "hi",
    });
    expect(res.status).toBe(200);
    expect(res.body.failure?.kind).toBe("llm");
    expect(res.body.review?.approved).toBe(false);
    expect(res.body.response).toContain("未执行任何任务");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("U30 · 审批令牌接受唯一前缀（UI/CLI 印的是短 id）", () => {
  test("lab：全 UUID 签发，8 位前缀可兑现一次，第二次拒", () => {
    const full = "3f1c9a2e-7b44-4d1e-9c0a-5e6f7a8b9c0d";
    const issued = labToken.issue(root, full);
    expect(() => labToken.consume(root, full.slice(0, 8), issued.token)).not.toThrow();
    expect(() => labToken.consume(root, full.slice(0, 8), issued.token)).toThrow(/已被使用|used/);
  });
  test("lab：前缀太短（<8）不匹配；不相干的前缀不匹配", () => {
    const full = "3f1c9a2e-7b44-4d1e-9c0a-5e6f7a8b9c0d";
    const issued = labToken.issue(root, full);
    expect(() => labToken.consume(root, full.slice(0, 6), issued.token)).toThrow(/令牌无效/);
    expect(() => labToken.consume(root, "deadbeef", issued.token)).toThrow(/令牌无效/);
  });
  test("compute：同一规则", () => {
    const full = "8a7b6c5d-1111-4222-8333-444455556666";
    const issued = computeToken.issue(root, full);
    expect(() => computeToken.consume(root, full.slice(0, 8), issued.token)).not.toThrow();
  });
});
