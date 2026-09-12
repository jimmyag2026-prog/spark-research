// v0.8 W8-1 β · V97 + V99①② · usage/ledger.ts 三笔口径修复：
//   V97  UsageStore.append() 前置类型守卫——model 不是字符串就记 "(unknown)"，
//        不再把整个对象序列化成 "[object Object]" 躺进 usage.jsonl；同时计入 corruptLines()。
//   V99① append() 写盘失败吞掉 + stderr 告警，不让台账故障拖垮已经发生的 LLM 调用。
//   V99② error.kind ∈ {auth, rate_limit} 的失败记 costUsd:0 + zeroCostReason，
//        不再计入 unknownCostCalls（这两种失败发生在计费前，$0 是可证明的事实）。
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore, usageTrackingLlm, type UsageEntry } from "../../backend/src/usage/ledger";
import { failure } from "../../backend/src/llm/providers/types";
import { llmExtras } from "../../backend/src/llm/types";
import type { ChatMessage, LlmResponse } from "../../backend/src/llm/types";

function tmpFile(name = "usage.jsonl"): string {
  return join(mkdtempSync(join(tmpdir(), "w8-beta-usage-")), name);
}

function withCapturedErrors<T>(fn: () => T): { result: T; warnings: string[] } {
  const original = console.error;
  const warnings: string[] = [];
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.error = original;
  }
}

describe("V97 · UsageStore.append() 的 model 类型守卫", () => {
  test("model 是字符串：原样落盘，不计 corrupt", () => {
    const store = new UsageStore(tmpFile());
    const { warnings } = withCapturedErrors(() =>
      store.append({ ts: "2026-09-12T00:00:00.000Z", command: "test", provider: "openrouter", model: "glm-5", ok: true, inputTokens: 1, outputTokens: 1, costUsd: 0.01 }),
    );
    expect(warnings.length).toBe(0);
    expect(store.corruptLines()).toBe(0);
    expect(store.totals().calls).toBe(1);
  });

  test("model 不是字符串（真实 bug 形状：整个 CallOptions 对象递进来）：记 \"(unknown)\"，不再是 [object Object]，计入 corrupt 并告警", () => {
    const file = tmpFile();
    const store = new UsageStore(file);
    const badEntry = {
      ts: "2026-09-12T00:00:00.000Z",
      command: "test",
      provider: "openrouter",
      model: { model: "glm-5", temperature: 0.2 }, // 真实场景：调用方把 CallOptions 当 model 传
      ok: true,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.01,
    } as unknown as UsageEntry;
    const { warnings } = withCapturedErrors(() => store.append(badEntry));
    expect(warnings.length).toBeGreaterThan(0);
    expect(store.corruptLines()).toBe(1);
    const written = readFileSync(file, "utf8").trim();
    expect(written).not.toContain("[object Object]");
    expect(JSON.parse(written).model).toBe("(unknown)");
  });
});

describe("V99① · UsageStore.append() 写盘失败吞掉 + stderr 告警", () => {
  test("目标路径本身是目录（appendFileSync 必然失败）：不抛异常，只告警", () => {
    const dir = mkdtempSync(join(tmpdir(), "w8-beta-usage-writefail-"));
    const filePath = join(dir, "usage.jsonl");
    mkdirSync(filePath); // 让「文件」路径实际上是个目录——写入必然报错（EISDIR）
    const store = new UsageStore(filePath);
    let threw = false;
    const { warnings } = withCapturedErrors(() => {
      try {
        store.append({ ts: "2026-09-12T00:00:00.000Z", command: "test", provider: "p", model: "m", ok: true, inputTokens: 1, outputTokens: 1, costUsd: 0 });
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(true); // 仍然是那个目录，没有变成文件
  });

  test("usageTrackingLlm().call()：台账写盘失败时，LLM 调用的产出仍然正常返回给上层", async () => {
    // 构造期（new UsageStore + usageTrackingLlm 内部的 store.totals()）要能正常读到一个
    // 存在、可读的空文件——只有 append() 那次真实写入失败，才是 V99① 要覆盖的场景
    // （与「文件路径本身就是目录」那种连 readAll() 都会先炸的场景不同，那是另一个问题）。
    const dir = mkdtempSync(join(tmpdir(), "w8-beta-usage-tracking-writefail-"));
    const filePath = join(dir, "usage.jsonl");
    writeFileSync(filePath, "");
    const store = new UsageStore(filePath);
    const llm = {
      call: async (): Promise<LlmResponse> => ({
        ok: true,
        provider: "openrouter",
        model: "glm-5",
        content: "hello",
        ...llmExtras(),
      }),
    };
    const tracked = usageTrackingLlm({ llm, store, command: "test" });
    chmodSync(filePath, 0o444); // 只读：append() 内部的 appendFileSync 应该会失败
    const { result: res, warnings } = await (async () => {
      const original = console.error;
      const collected: string[] = [];
      console.error = (...args: unknown[]) => collected.push(args.map(String).join(" "));
      try {
        const r = await tracked.call([{ role: "user", content: "hi" }] as ChatMessage[], "glm-5");
        return { result: r, warnings: collected };
      } finally {
        console.error = original;
        chmodSync(filePath, 0o644); // 恢复可写，避免临时目录清理卡住
      }
    })();
    expect(res.ok).toBe(true);
    expect(res.content).toBe("hello");
    expect(warnings.length).toBeGreaterThan(0);
    // 真的没写进去（文件仍是构造时的空文件）——不是「假装失败其实写成功了」。
    expect(readFileSync(filePath, "utf8")).toBe("");
  });
});

describe("V99② · error.kind ∈ {auth, rate_limit} 记可证明的 costUsd:0（不污染 unknown）", () => {
  function trackedWith(store: UsageStore, response: LlmResponse) {
    return usageTrackingLlm({ llm: { call: async () => response }, store, command: "test" });
  }

  test("auth 失败：costUsd=0、zeroCostReason 写明原因，totals() 不计入 unknownCostCalls", async () => {
    const file = tmpFile();
    const store = new UsageStore(file);
    const tracked = trackedWith(store, failure("openrouter", "glm-5", { kind: "auth", message: "no api key", retryable: false }));
    const res = await tracked.call([{ role: "user", content: "hi" }] as ChatMessage[], "glm-5");
    expect(res.ok).toBe(false);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0].costUsd).toBe(0);
    expect(typeof lines[0].zeroCostReason).toBe("string");
    expect(lines[0].zeroCostReason).toContain("auth");
    const totals = store.totals();
    expect(totals.unknownCostCalls).toBe(0);
    expect(totals.knownCostUsd).toBe(0);
  });

  test("rate_limit 失败：同样记可证明的 costUsd:0", async () => {
    const file = tmpFile();
    const store = new UsageStore(file);
    const tracked = trackedWith(store, failure("openrouter", "glm-5", { kind: "rate_limit", message: "429", retryable: true }));
    await tracked.call([{ role: "user", content: "hi" }] as ChatMessage[], "glm-5");
    const totals = store.totals();
    expect(totals.unknownCostCalls).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].costUsd).toBe(0);
    expect(lines[0].zeroCostReason).toContain("rate_limit");
  });

  test("对照：timeout 失败不在可证明 $0 的白名单里，仍然记未知成本（costUsd:null，unknownCostCalls+1）", async () => {
    const file = tmpFile();
    const store = new UsageStore(file);
    const tracked = trackedWith(store, failure("openrouter", "glm-5", { kind: "timeout", message: "timed out", retryable: true }));
    await tracked.call([{ role: "user", content: "hi" }] as ChatMessage[], "glm-5");
    const totals = store.totals();
    expect(totals.unknownCostCalls).toBe(1);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].costUsd).toBeNull();
    expect(lines[0].zeroCostReason).toBeUndefined();
  });
});
