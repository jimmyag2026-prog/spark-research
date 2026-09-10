// W5-3 γ · V45：「agent 运行时连接外部 MCP 扩展」这条流程的**发现 + 运行时**两层。
//
// 分工（不与既有文件重叠）：
//   tests/unit/mcp_client.test.ts   —— W4-d/W5-2-δ：单次连接、单次调用、记录、registry。
//   tests/unit/orchestrator.test.ts —— V45 在 agent 运行路径上的接线（本文件的下游）。
//   本文件                          —— discoverInstalledMcpClients() + ExternalMcpRuntime。
//
// 测试纪律沿用 W4-d：不连真实的外部 MCP server，用 tests/fixtures/mcp/ 下的假替身
// （good_server.ts / dead_on_arrival.ts）现场 spawn，走真实 stdio JSON-RPC。
// 每个用例自己的临时数据根目录，绝不写真实的 ~/.spark-research。

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverInstalledMcpClients,
  ExternalMcpRuntime,
  type ExternalMcpLifecycleEvent,
  type McpClientDiscovery,
} from "../../backend/src/extensions/loader";
import type { ConnectExternalMcpOptions, ConnectResult } from "../../backend/src/extensions/mcp_client";
import { extensionDir, trustFilePath } from "../../backend/src/extensions/paths";
import { sha256File } from "../../backend/src/extensions/fingerprint";
import { loadExtension } from "../../backend/src/extensions/loader";

const FIXTURES = join(import.meta.dir, "../fixtures/mcp");
const GOOD_SERVER = join(FIXTURES, "good_server.ts");
const DEAD_ON_ARRIVAL = join(FIXTURES, "dead_on_arrival.ts");

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-v45-runtime-"));
}

/** 装一个 kind=mcp_client 扩展。`trust` 决定要不要顺手完成 TOFU 确认。 */
async function installMcpExtension(
  root: string,
  name: string,
  options: { args?: string[]; trust?: boolean; mcpJson?: Record<string, unknown> } = {},
): Promise<string> {
  const dir = extensionDir(name, { root });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "extension.json"),
    JSON.stringify({ kind: "mcp_client", name, version: "0.1.0", description: "V45 测试用外部 MCP 扩展" }, null, 2),
  );
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify(
      options.mcpJson ?? {
        command: process.execPath,
        args: options.args ?? [GOOD_SERVER],
        startupTimeoutMs: 5_000,
        callTimeoutMs: 3_000,
      },
      null,
      2,
    ),
  );
  // 用户侧的 TOFU 确认（生产上是 `ext add-mcp` / `ext verify --trust` 干的）。
  if (options.trust !== false) {
    const loaded = await loadExtension(dir, { trust: true, pathOptions: { root } });
    expect(loaded.status).toBe("loaded");
  }
  return dir;
}

/**
 * 装一个**非** mcp_client 的 TS 扩展，入口文件一被 import 就写一个标记文件。
 * 这是「发现动作不许顺手执行别的扩展的代码」这条纪律的探针：标记文件出现 = 代码跑过了。
 *
 * **必须是已 --trust 的**：否则 `loadExtension()` 会先被 TOFU 拦下，探针测的就成了
 * "trust 挡住了"而不是"kind 判定挡住了"——阴性对照④第一次跑就撞上过这个假阳性
 * （去掉 kind 判定，测试依然全绿）。这里直接写 `.trust.json`（等价于用户跑过一次
 * `--trust`），而不是调 `loadExtension(dir, {trust:true})`——后者本身就会 import 入口
 * 文件、把标记写出来，探针就废了。
 */
function installSideEffectSkill(root: string, name: string, markerPath: string): string {
  const dir = extensionDir(name, { root });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "extension.json"),
    JSON.stringify({ kind: "skill", name, version: "0.1.0", description: "副作用探针扩展" }, null, 2),
  );
  const entry = join(dir, "index.ts");
  writeFileSync(
    entry,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "executed");\nexport const skill = { name: ${JSON.stringify(name)} };\n`,
  );
  writeFileSync(
    trustFilePath(name, { root }),
    JSON.stringify({ sha256: sha256File(entry), trustedAt: new Date().toISOString() }, null, 2),
  );
  return dir;
}

// ── §1 发现：纯文件系统，零代码执行、零子进程 ─────────────────────────────────

describe("V45 · discoverInstalledMcpClients", () => {
  test("扩展根目录不存在 / 是空的：返回空结果，不抛", async () => {
    const missing = await discoverInstalledMcpClients({ root: join(freshRoot(), "nope") });
    expect(missing.ready).toEqual([]);
    expect(missing.skipped).toEqual([]);

    const empty = freshRoot();
    mkdirSync(join(empty, "extensions"), { recursive: true });
    const result = await discoverInstalledMcpClients({ root: empty });
    expect(result.ready).toEqual([]);
  });

  test("正向：已装 + 已 --trust 的 mcp_client 扩展进 ready，带着解析好的 config 与 grant", async () => {
    const root = freshRoot();
    await installMcpExtension(root, "v45-good");
    const result = await discoverInstalledMcpClients({ root });
    expect(result.ready.map((r) => r.name)).toEqual(["v45-good"]);
    expect(result.ready[0]!.config.command).toBe(process.execPath);
    expect(result.ready[0]!.manifest.kind).toBe("mcp_client");
    expect(result.ready[0]!.grant).toEqual({ credentials: [], tools: [] });
    expect(result.skipped).toEqual([]);
  });

  test("没过 --trust 的 mcp_client 扩展进 skipped，不进 ready——agent 运行不会顺手替用户信任它", async () => {
    const root = freshRoot();
    await installMcpExtension(root, "v45-untrusted", { trust: false });
    const result = await discoverInstalledMcpClients({ root });
    expect(result.ready).toEqual([]);
    expect(result.skipped.map((s) => s.extension)).toEqual(["v45-untrusted"]);
    expect(result.skipped[0]!.reason).toContain("尚未信任");
  });

  test("mcp.json 非法 / extension.json 坏掉：各进 skipped 一条，都不影响同目录下别的扩展", async () => {
    const root = freshRoot();
    await installMcpExtension(root, "v45-ok-among-bad");

    // mcp.json 非法（command 为空）——注意它连 --trust 都过不了 loadMcpClientConfig 那一步。
    await installMcpExtension(root, "v45-bad-mcp", { trust: false, mcpJson: { command: "" } });

    // extension.json 根本解析不了。
    const brokenDir = extensionDir("v45-broken-manifest", { root });
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "extension.json"), "{ not json");

    const result = await discoverInstalledMcpClients({ root });
    expect(result.ready.map((r) => r.name)).toEqual(["v45-ok-among-bad"]);
    expect(result.skipped.map((s) => s.extension).sort()).toEqual(["v45-bad-mcp", "v45-broken-manifest"]);
  });

  test(
    "【关键纪律】发现动作不执行任何扩展代码：同目录下的 kind=skill 扩展入口文件不会被 import",
    async () => {
      const root = freshRoot();
      const marker = join(root, "skill-was-executed.marker");
      installSideEffectSkill(root, "v45-side-effect", marker);
      await installMcpExtension(root, "v45-alongside");

      const result = await discoverInstalledMcpClients({ root });
      expect(result.ready.map((r) => r.name)).toEqual(["v45-alongside"]);
      // kind !== "mcp_client" 的扩展连 loadExtension() 都不该走一遍——loadExtension()
      // 对 TS 扩展会 `await import(entry)`，那是同 UID 的任意代码执行。
      expect(existsSync(marker)).toBe(false);
    },
  );
});

// ── §2 ExternalMcpRuntime：惰性、连接、注册、收尾、失败隔离 ────────────────────

describe("V45 · ExternalMcpRuntime 的惰性策略（约束二）", () => {
  test("构造 runtime 本身零 I/O：不 discover、不 connect", async () => {
    let discoverCalls = 0;
    let connectCalls = 0;
    new ExternalMcpRuntime({
      pathOptions: { root: freshRoot() },
      discover: async () => {
        discoverCalls += 1;
        return { ready: [], skipped: [] };
      },
      connect: async () => {
        connectCalls += 1;
        return { ok: false, reason: "不该被调到" };
      },
    });
    expect(discoverCalls).toBe(0);
    expect(connectCalls).toBe(0);
  });

  test(
    "【阴性对照④】扩展目录里没有任何 mcp_client 扩展时：一个子进程都不起，registry 都不建",
    async () => {
      const root = freshRoot();
      // 目录里**有**扩展，只是没有一个是 mcp_client——"没装 mcp_client 扩展"的真实形态。
      installSideEffectSkill(root, "v45-only-skill", join(root, "should-not-exist.marker"));

      const connectAttempts: string[] = [];
      const runtime = new ExternalMcpRuntime({
        pathOptions: { root },
        connect: async (options: ConnectExternalMcpOptions): Promise<ConnectResult> => {
          connectAttempts.push(options.manifest.name);
          return { ok: false, reason: "不该被调到" };
        },
      });

      const attachment = await runtime.attach();
      // 四条断言，缺一不可：
      //   ① 一次连接都没试过（= 一个子进程都没起）
      expect(connectAttempts).toEqual([]);
      //   ② registry 是 undefined，不是"空表"——orchestrator 据此退回裸 McpToolRunner
      expect(attachment.registry).toBeUndefined();
      //   ③ 连 skipped 都该是空的：一个 kind=skill 的扩展根本**不是**外部 MCP 的候选，
      //      它不该以任何形式（哪怕只是"被跳过"）出现在这条流程里。去掉 kind 判定之后
      //      它会变成"候选但没有 mcp.json"，这条断言就会红。
      expect(attachment.skipped).toEqual([]);
      //   ④ 顺带：连接是唯一会写这些文件的动作，它们不该出现
      expect(existsSync(join(extensionDir("v45-only-skill", { root }), ".mcp_discovery.json"))).toBe(false);
      expect(existsSync(join(extensionDir("v45-only-skill", { root }), ".mcp_calls.jsonl"))).toBe(false);
      //   ⑤ 而且这个 skill 扩展的代码一行都没跑（它是 --trust 过的，挡住它的只能是 kind 判定）
      expect(existsSync(join(root, "should-not-exist.marker"))).toBe(false);
      await attachment.close();
    },
  );

  test("全都连不上时也退回 registry=undefined（不给一张空表）", async () => {
    const root = freshRoot();
    await installMcpExtension(root, "v45-all-dead", { args: [DEAD_ON_ARRIVAL] });
    const runtime = new ExternalMcpRuntime({ pathOptions: { root } });
    const attachment = await runtime.attach();
    expect(attachment.connected).toEqual([]);
    expect(attachment.failed.map((f) => f.extension)).toEqual(["v45-all-dead"]);
    expect(attachment.registry).toBeUndefined();
    await attachment.close();
  }, 20_000);
});

describe("V45 · ExternalMcpRuntime 的完整生命周期", () => {
  test("发现 → 连接（真子进程）→ 注册 → 可调用 → 收尾摘除", async () => {
    const root = freshRoot();
    await installMcpExtension(root, "v45-lifecycle");

    const events: ExternalMcpLifecycleEvent[] = [];
    const runtime = new ExternalMcpRuntime({ pathOptions: { root }, onEvent: (e) => events.push(e) });
    const attachment = await runtime.attach();

    expect(attachment.connected).toEqual(["v45-lifecycle"]);
    expect(attachment.registry).toBeDefined();
    expect(attachment.registry!.specs().map((s) => s.name).sort()).toEqual([
      "mcp:v45-lifecycle:echo",
      "mcp:v45-lifecycle:slow",
      "mcp:v45-lifecycle:whoami",
    ]);

    const outcome = await attachment.registry!.call("mcp:v45-lifecycle:echo", { text: "v45" });
    expect(outcome.ok).toBe(true);
    expect(outcome.payload).toEqual({ echoed: { text: "v45" } });

    await attachment.close();
    // 收尾之后这张表里不该还留着这个扩展——留着的话下一轮拿到的是一个已经死掉的 session。
    expect(attachment.registry!.has("mcp:v45-lifecycle:echo")).toBe(false);
    expect(events.some((e) => e.phase === "connected" && e.extension === "v45-lifecycle")).toBe(true);
    expect(events.some((e) => e.phase === "closed" && e.extension === "v45-lifecycle")).toBe(true);

    // 幂等：再关一次不抛、也不重复发事件。
    const closedCount = events.filter((e) => e.phase === "closed").length;
    await attachment.close();
    expect(events.filter((e) => e.phase === "closed").length).toBe(closedCount);
  }, 20_000);

  test("两次 attach 拿到两张不同的 registry（并发安全：不共享可变状态）", async () => {
    const root = freshRoot();
    await installMcpExtension(root, "v45-two-attach");
    const runtime = new ExternalMcpRuntime({ pathOptions: { root } });
    const a = await runtime.attach();
    const b = await runtime.attach();
    expect(a.registry).toBeDefined();
    expect(b.registry).toBeDefined();
    expect(a.registry).not.toBe(b.registry);
    // a 收尾不该影响仍在跑的 b。
    await a.close();
    expect(b.registry!.has("mcp:v45-two-attach:echo")).toBe(true);
    await b.close();
  }, 30_000);

  test(
    "【阴性对照①】一个扩展连不上：只产生一条 failed 记录，其它扩展照常连上，attach() 不抛",
    async () => {
      const root = freshRoot();
      await installMcpExtension(root, "v45-broken", { args: [DEAD_ON_ARRIVAL] });
      await installMcpExtension(root, "v45-healthy");

      const events: ExternalMcpLifecycleEvent[] = [];
      const runtime = new ExternalMcpRuntime({ pathOptions: { root }, onEvent: (e) => events.push(e) });

      // "不抛"本身就是断言的一部分——失败隔离是硬要求。
      const attachment = await runtime.attach();

      expect(attachment.connected).toEqual(["v45-healthy"]);
      expect(attachment.failed.map((f) => f.extension)).toEqual(["v45-broken"]);
      expect(attachment.failed[0]!.reason.length).toBeGreaterThan(0); // 可见记录，不是空字符串
      expect(events.some((e) => e.phase === "failed" && e.extension === "v45-broken")).toBe(true);

      // 关键：坏扩展没有把好扩展一起带走。
      const outcome = await attachment.registry!.call("mcp:v45-healthy:echo", { text: "ok" });
      expect(outcome.ok).toBe(true);
      await attachment.close();
    },
    30_000,
  );

  test("【阴性对照①·补】connect 实现自己抛异常时同样被兜住（不指望实现方老实）", async () => {
    const root = freshRoot();
    await installMcpExtension(root, "v45-throwing");
    await installMcpExtension(root, "v45-survivor");

    const runtime = new ExternalMcpRuntime({
      pathOptions: { root },
      connect: async (options) => {
        if (options.manifest.name === "v45-throwing") throw new Error("boom：模拟 SDK 构造函数直接抛");
        // 其余走真实实现，证明"抛的那个被隔离"不是靠把所有连接都换成假件才成立的。
        const { connectExternalMcp } = await import("../../backend/src/extensions/mcp_client");
        return connectExternalMcp(options);
      },
    });

    const attachment = await runtime.attach();
    expect(attachment.failed.map((f) => f.extension)).toEqual(["v45-throwing"]);
    expect(attachment.failed[0]!.reason).toContain("boom");
    expect(attachment.connected).toEqual(["v45-survivor"]);
    await attachment.close();
  }, 20_000);

  test("recordSink 被原样递给每一个 connect（V31 的绑定点确实在这条流程上）", async () => {
    const root = freshRoot();
    await installMcpExtension(root, "v45-sink-a");
    await installMcpExtension(root, "v45-sink-b");

    const sink = { create: () => ({}) as never };
    const seen: Array<string | undefined> = [];
    const fakeDiscovery: McpClientDiscovery = await discoverInstalledMcpClients({ root });
    const runtime = new ExternalMcpRuntime({
      pathOptions: { root },
      discover: async () => fakeDiscovery,
      connect: async (options) => {
        seen.push(options.recordSink === sink ? options.manifest.name : undefined);
        return { ok: false, reason: "只验参数传递，不真连" };
      },
    });
    await runtime.attach({ recordSink: sink });
    // 首个 CI run（Linux）抓到的顺序不确定性：两个扩展的 connect 完成序在 Linux 与
    // macOS 上不同。本断言验的是「recordSink 递给了每一个 connect」，顺序不是它的
    // 语义——排序后比较，别让平台差异当回归。
    expect([...seen].sort()).toEqual(["v45-sink-a", "v45-sink-b"]);
  });
});
