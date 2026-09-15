// v0.9 R6 修复窗口门禁（USAGE_LOG U11 U12 U15 U21 U22 U23）。
// 每条对应 docs/devlog/R6.md 里一条独立复现过的发现；阴性对照见 docs/devlog/R6-window-fixes.md。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfigEnvDefaults,
  isBridgedEnvVar,
  loadConfig,
  resolveSetting,
  saveConfig,
  validateSetting,
  SettingValidationError,
} from "../../backend/src/config";
import { runConfigCommand } from "../../backend/src/config/cli";
import { UsageStore, usageTrackingLlm } from "../../backend/src/usage/ledger";
import { FakeLlm } from "../helpers/review_scenario";
import { makeServer, type ServerFixture } from "../helpers/server_scenario";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

const GLM = "z-ai/glm-5.3-flash";
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "r6w-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("U15 · 桥进 process.env 的 config 值不遮住 config.json 的后续改动", () => {
  const ENV = "SPARK_RESEARCH_MODEL";
  test("启动桥接后改 config.json → resolveSetting 读到新值、source 是 config；桥接的 env 同步刷新", () => {
    const hadEnv = process.env[ENV];
    delete process.env[ENV];
    try {
      saveConfig({ defaultModel: GLM }, { root: tmp });
      // 用 process.env 走真实桥接路径（options.env 注入的假 env 不登记为桥接）。
      const applied = applyConfigEnvDefaults({ root: tmp });
      expect(applied).toContain(ENV);
      expect(isBridgedEnvVar(ENV)).toBe(true);
      expect(process.env[ENV]).toBe(GLM);

      const before = resolveSetting("defaultModel", { root: tmp });
      expect(before.value).toBe(GLM);
      expect(before.source).toBe("config"); // 不是 env——那是我们自己桥过去的

      saveConfig({ defaultModel: "moonshotai/kimi-k2.6" }, { root: tmp });
      const after = resolveSetting("defaultModel", { root: tmp });
      expect(after.value).toBe("moonshotai/kimi-k2.6");
      expect(after.source).toBe("config");
      expect(process.env[ENV]).toBe("moonshotai/kimi-k2.6"); // 只读 env 的读者也看到新值
    } finally {
      if (hadEnv === undefined) delete process.env[ENV];
      else process.env[ENV] = hadEnv;
    }
  });

  test("用户自己设的环境变量仍优先（不是桥接的就不动）", () => {
    saveConfig({ defaultModel: GLM }, { root: tmp });
    const resolved = resolveSetting("defaultModel", { root: tmp, env: { [ENV]: "user/own-model" } });
    expect(resolved.source).toBe("env");
    expect(resolved.value).toBe("user/own-model");
  });
});

describe("U23 · config set 拒收凭据", () => {
  test("config set OPENROUTER_API_KEY <值> → 退出码 1、文件不写、值不回显、指向 auth", () => {
    const lines: string[] = [];
    const sink = (l: string) => lines.push(l);
    const code = runConfigCommand(["set", "OPENROUTER_API_KEY", "T5-FAKE-KEY-r6"], { root: tmp, env: {}, out: sink, err: sink });
    expect(code).toBe(1);
    expect(loadConfig({ root: tmp }).OPENROUTER_API_KEY).toBeUndefined();
    const text = lines.join("\n");
    expect(text).toContain("凭据");
    expect(text).toContain("spark-research auth");
    expect(text).not.toContain("T5-FAKE-KEY-r6");
  });
  test("非凭据项照常写入", () => {
    const lines: string[] = [];
    const sink = (l: string) => lines.push(l);
    expect(runConfigCommand(["set", "llmTimeoutMs", "30000"], { root: tmp, env: {}, out: sink, err: sink })).toBe(0);
    expect(loadConfig({ root: tmp }).llmTimeoutMs).toBe(30000);
  });
});

describe("U22 · llmTimeoutMs 下限", () => {
  test("500 拒（422 语义），1000 收；CLI 与 validateSetting 同一判据", () => {
    expect(() => validateSetting("llmTimeoutMs", 500)).toThrow(SettingValidationError);
    expect(validateSetting("llmTimeoutMs", 1000)).toBe(1000);
    const lines: string[] = [];
    const sink = (l: string) => lines.push(l);
    expect(runConfigCommand(["set", "llmTimeoutMs", "500"], { root: tmp, env: {}, out: sink, err: sink })).toBe(1);
    expect(loadConfig({ root: tmp }).llmTimeoutMs).toBeUndefined();
    expect(lines.join("\n")).toContain("不能小于 1000");
  });
});

class CountingLlm {
  calls = 0;
  async call(_m: ChatMessage[], _o?: unknown): Promise<LlmResponse> {
    this.calls++;
    return {
      ok: true,
      content: "x",
      provider: "openrouter",
      model: GLM,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    } as unknown as LlmResponse;
  }
}

describe("U12 ③ · 预算闸拒绝落台账", () => {
  test("被拒的调用写一行 ok:false / errorKind:budget / costUsd:0，byErrorKind 能看见", async () => {
    const store = new UsageStore(join(tmp, "usage.jsonl"));
    const inner = new CountingLlm();
    const wrapped = usageTrackingLlm({ llm: inner, store, command: "chat", budgetUsd: 0.0000001, configOptions: { env: {} } });
    const r1 = await wrapped.call([{ role: "user", content: "1" }], GLM); // 估价 > 上限 → 发前就拒
    expect(r1.ok).toBe(false);
    expect(inner.calls).toBe(0);
    const lines = readFileSync(join(tmp, "usage.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as { ok: boolean; errorKind?: string; costUsd: number | null };
    expect(row.ok).toBe(false);
    expect(row.errorKind).toBe("budget");
    expect(row.costUsd).toBe(0);
    expect(store.totals().byErrorKind["budget"]).toBe(1);
    expect(store.totals().knownCostUsd).toBe(0); // 闸的记录不能抬高「已知花费」
  });
});

describe("U12 ② / U21 · 被闸拒绝的 chat 有结构化 failure，review 不 approved，不跑默认计划", () => {
  let fx: ServerFixture | undefined;
  afterEach(async () => {
    await fx?.stop();
    fx = undefined;
  });
  test("HTTP /api/session/chat：failure.kind=budget、review.approved=false、模型零调用", async () => {
    const llm = new FakeLlm([JSON.stringify({ tasks: [{ kind: "analysis", description: "x" }] }), "答"]);
    fx = makeServer({ slug: "r6gate", llm });
    const res = await fx.post<{ response: string; review?: { approved: boolean }; failure?: { kind: string; message: string } }>(
      "/api/session/chat",
      { sessionId: "s-gate", message: "hi", budgetUsd: 0.0000001 },
    );
    expect(res.status).toBe(200);
    expect(res.body.failure?.kind).toBe("budget");
    expect(res.body.review?.approved).toBe(false);
    expect(res.body.response).toContain("预算闸");
    expect(res.body.response).toContain("未执行任何任务"); // plan 被拒即止，没有退到默认计划
  });
  test("正常路径没有 failure 字段", async () => {
    const llm = new FakeLlm([JSON.stringify({ tasks: [{ kind: "analysis", description: "x" }] }), "答"]);
    fx = makeServer({ slug: "r6ok", llm });
    const res = await fx.post<{ failure?: unknown; review?: { approved: boolean } }>("/api/session/chat", { sessionId: "s-ok", message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.failure).toBeUndefined();
  });
});

describe("U11 · /api/session/chat 认 ?project=", () => {
  let fx: ServerFixture | undefined;
  afterEach(async () => {
    await fx?.stop();
    fx = undefined;
  });
  test("?project=<slug> 把会话绑到该项目；不存在的 slug → 404", async () => {
    const llm = new FakeLlm([JSON.stringify({ tasks: [{ kind: "analysis", description: "x" }] }), "答"]);
    fx = makeServer({ slug: "r6proj", llm });
    await fx.post("/api/projects", { slug: "r6other", name: "另一个" });
    const res = await fx.post<{ projectSlug: string | null }>("/api/session/chat?project=r6other", { sessionId: "s-p", message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.projectSlug).toBe("r6other");
    const missing = await fx.post("/api/session/chat?project=nope-404", { sessionId: "s-q", message: "hi" });
    expect(missing.status).toBe(404);
  });
});
