import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_LEDGER_ERROR_MESSAGE_CHARS,
  redactErrorMessage,
  resetSharedInFlightForTests,
  UsageStore,
  usageTrackingLlm,
  type UsageEntry,
} from "../../backend/src/usage/ledger";
import { llmFailure, llmText, type LlmResponse, type ProviderCapabilities } from "../../backend/src/llm/types";

// lane α-4（USAGE_LOG U1）：失败可诊断。
//
// U1 的现场：usage.jsonl 第一行 `ok:false`，除此之外什么都没有——不知道是 auth、
// rate_limit 还是 upstream；同一时刻 server.log 整个文件只有四行启动日志；
// 紧接着的第二次调用又成功了，所以也没法复现。事后完全无法判断该怪谁。

let dir: string;
let store: UsageStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spark-usage-errorkind-"));
  store = new UsageStore(join(dir, "usage.jsonl"));
  resetSharedInFlightForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lines(): UsageEntry[] {
  return readFileSync(store.path(), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as UsageEntry);
}

/** 一个只按脚本返回的假 LLM。`caps` 给了就顺带暴露 capabilitiesFor（生产上是 LLMRouter）。 */
function fakeLlm(script: LlmResponse[], caps?: ProviderCapabilities) {
  let i = 0;
  return {
    call: async (): Promise<LlmResponse> => script[Math.min(i++, script.length - 1)]!,
    ...(caps ? { capabilitiesFor: () => caps } : {}),
  };
}

describe("α-4 · 失败落 errorKind", () => {
  test("① 失败记录带 errorKind，成功记录不带", async () => {
    const llm = usageTrackingLlm({
      llm: fakeLlm([
        llmFailure({ provider: "openrouter", model: "z-ai/glm-5.3-flash", kind: "rate_limit", message: "HTTP 429: slow down" }),
        llmText({ provider: "openrouter", model: "z-ai/glm-5.3-flash", content: "ok" }),
      ]),
      store,
      command: "chat",
    });
    await llm.call([{ role: "user", content: "hi" }]);
    await llm.call([{ role: "user", content: "hi" }]);

    const [failed, succeeded] = lines();
    expect(failed!.ok).toBe(false);
    expect(failed!.errorKind, "U1 的整条病根：ok:false 之外什么都没留下").toBe("rate_limit");
    expect(failed!.errorMessage).toContain("429");
    expect(succeeded!.ok).toBe(true);
    expect(succeeded!.errorKind).toBeUndefined();
    expect(succeeded!.errorMessage).toBeUndefined();
  });

  test("① bis · 七种 LlmErrorKind 都能原样落盘", async () => {
    const kinds = ["auth", "rate_limit", "timeout", "parse", "upstream", "unsupported", "budget"] as const;
    for (const kind of kinds) {
      const llm = usageTrackingLlm({
        llm: fakeLlm([llmFailure({ provider: "p", model: "m", kind, message: `boom ${kind}` })]),
        store,
        command: "chat",
      });
      await llm.call([{ role: "user", content: "x" }]);
    }
    expect(lines().map((e) => e.errorKind)).toEqual([...kinds]);
  });

  test("② 脱敏：假 key 塞进错误体，台账里不得出现", async () => {
    // 三种形状各一条：有结构的 sk- 前缀、Bearer 头、以及一个**没有任何前缀**的
    // 裸 key（②那条 ≥16 位规则就是为它加的——redactSecrets 单独抓不到）。
    const leak = "sk-proj-AAAABBBBCCCCDDDDEEEE";
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz";
    const naked = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA";
    const llm = usageTrackingLlm({
      llm: fakeLlm([
        llmFailure({
          provider: "openrouter",
          model: "m",
          kind: "auth",
          message: `HTTP 401: invalid api key. request echoed: {"authorization":"${bearer}","key":"${leak}","x":"${naked}"}`,
        }),
      ]),
      store,
      command: "chat",
    });
    await llm.call([{ role: "user", content: "x" }]);

    const raw = readFileSync(store.path(), "utf8");
    expect(raw).not.toContain(leak);
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(raw).not.toContain(naked);
    // 脱敏不是「整条删掉」——分类线索必须留下来，否则台账又变回一个布尔。
    expect(lines()[0]!.errorKind).toBe("auth");
    expect(lines()[0]!.errorMessage).toContain("401");
  });

  test("② bis · 摘要截断到 200 字", async () => {
    const llm = usageTrackingLlm({
      llm: fakeLlm([llmFailure({ provider: "p", model: "m", kind: "upstream", message: "上游炸了。".repeat(200) })]),
      store,
      command: "chat",
    });
    await llm.call([{ role: "user", content: "x" }]);
    expect(lines()[0]!.errorMessage!.length).toBeLessThanOrEqual(MAX_LEDGER_ERROR_MESSAGE_CHARS);
  });

  test("② ter · redactErrorMessage 纯函数：三层规则各一条", () => {
    expect(redactErrorMessage("key=sk-ABCDEFGH12345678")).not.toContain("sk-ABCDEFGH");
    expect(redactErrorMessage("Authorization: Bearer abcdefgh12345678")).not.toContain("abcdefgh12345678");
    expect(redactErrorMessage("token ABCDEFGHIJKLMNOP1234")).toBe("token [redacted]");
    // 短串不该被误杀——否则摘要会变成一排 [redacted]，等于没记。
    expect(redactErrorMessage("HTTP 429 rate limit exceeded")).toBe("HTTP 429 rate limit exceeded");
  });

  test("③ byErrorKind 计数正确，且不给历史无 kind 的失败行凭空补桶", async () => {
    const mk = (kind: "auth" | "rate_limit" | "upstream") =>
      usageTrackingLlm({ llm: fakeLlm([llmFailure({ provider: "p", model: "m", kind, message: kind })]), store, command: "chat" });
    await mk("rate_limit").call([{ role: "user", content: "x" }]);
    await mk("rate_limit").call([{ role: "user", content: "x" }]);
    await mk("auth").call([{ role: "user", content: "x" }]);
    await usageTrackingLlm({ llm: fakeLlm([llmText({ provider: "p", model: "m", content: "fine" })]), store, command: "chat" }).call([
      { role: "user", content: "x" },
    ]);
    // U1 现场那一行：ok:false 但没有 errorKind（α-4 之前写的）。手工追加，模拟历史文件。
    store.append({
      ts: new Date().toISOString(),
      command: "chat",
      provider: "openrouter",
      model: "z-ai/glm-5.3-flash",
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    });

    const totals = store.totals();
    expect(totals.byErrorKind).toEqual({ rate_limit: 2, auth: 1 });
    expect(totals.calls).toBe(5);
    // 没有失败时是空对象而不是 undefined——下游 `Object.entries` 不用先判空。
    expect(new UsageStore(join(dir, "empty.jsonl")).totals().byErrorKind).toEqual({});
  });

  test("V77 · 「上游没返 usage」与「查不到单价」分开计", async () => {
    // 上游没返 usage：usageUnavailable=true → noUsage，补单价表也救不了。
    const caps: ProviderCapabilities = { toolCalling: true, jsonMode: true, streaming: true, usageReported: true };
    await usageTrackingLlm({
      llm: fakeLlm([llmText({ provider: "p", model: "m", content: "hi", usage: { usageUnavailable: true } })], caps),
      store,
      command: "chat",
    }).call([{ role: "user", content: "x" }]);

    const totals = store.totals();
    expect(totals.noUsageCalls).toBe(1);
    expect(totals.unknownCostCalls).toBe(1);
    // unpriced 是另一件事（V94：发前就知道模型不在单价表里），这条不该被它吃掉。
    expect(totals.unpricedCalls).toBe(0);
    expect(lines()[0]!.noUsage).toBe(true);
  });
});
