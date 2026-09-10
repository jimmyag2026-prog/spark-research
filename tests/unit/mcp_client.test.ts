// W4-d · 装载强度③「外部 MCP client」的测试（v0.4 P15 X-c）。
//
// 结构对应任务书验收清单：
//   §1 mcp.json schema（mcp_client.ts 的 validateMcpClientConfig）
//   §2 凭据 → 子进程 env（resolveMcpChildEnv）+ 阴性对照③
//   §3 connectExternalMcp：真实 spawn 一个假的外部 MCP server（stdio），列工具 + 调用
//   §4 外部 server 挂了/超时：主进程存活 + 阴性对照②
//   §5 执行记录：每次调用必落一条 + 阴性对照①
//   §6 discoverExternalMcpTools + 发现缓存
//   §7 loader.ts：kind=mcp_client 的三种装载强度接入（TOFU）
//   §8 ext verify（mcp_client_verify.ts）
//   §9 capabilities.ts：origin/mcpTools/failed 状态
//   §10 CLI `ext add-mcp`
//   §11 ExternalToolRegistry + McpToolRunnerWithExternal（ToolBus 接线的可用性证明）
//
// 测试纪律：**不连真实的外部 MCP server**——tests/fixtures/mcp/ 下的三个脚本
// （good_server.ts / dead_on_arrival.ts / silent.ts）是本 lane 自己的假替身，
// 用 `command: process.execPath` 现场 spawn，走真实的 stdio JSON-RPC，但对端
// 是完全可控、可预测的本地进程。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateMcpClientConfig,
  loadMcpClientConfig,
  McpClientConfigError,
  resolveMcpChildEnv,
  connectExternalMcp,
  discoverExternalMcpTools,
  readMcpDiscoveryCache,
  appendMcpCallRecord,
  readMcpCallRecords,
  qualifyExternalToolName,
  parseQualifiedToolName,
  ExternalToolRegistry,
  createExternalToolRunner,
} from "../../backend/src/extensions/mcp_client";
import type { ExtensionManifest } from "../../backend/src/extensions/types";
import type { ExtensionGrant } from "../../backend/src/extensions/grants";
import type { CredentialAccessor } from "../../backend/src/extensions/context";
import { extensionDir, extensionsRoot } from "../../backend/src/extensions/paths";
import { loadExtension } from "../../backend/src/extensions/loader";
import { verifyExtension } from "../../backend/src/extensions/verify";
import { listExtensionCapabilities } from "../../backend/src/extensions/capabilities";
import { runExtCommand } from "../../backend/src/extensions/cli";
import { ExtensionGrantStore } from "../../backend/src/extensions/grants";
import { MCP_TOOLS } from "../../backend/src/mcp/tools";
import { createApp } from "../../backend/src/server/app";
import { ProjectManager } from "../../backend/src/project/manager";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { RecordStore } from "../../backend/src/project/records";
import {
  EXTERNAL_TOOL_CALL_OBSERVATION_KIND,
  type ExternalToolCallObservationMetadata,
} from "../../backend/src/agents/contract";

const FIXTURES = join(import.meta.dir, "../fixtures/mcp");
const GOOD_SERVER = join(FIXTURES, "good_server.ts");
const DEAD_ON_ARRIVAL = join(FIXTURES, "dead_on_arrival.ts");
const SILENT = join(FIXTURES, "silent.ts");

// 每个测试自己的临时数据根目录——绝不写真实的 ~/.spark-research。
function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-mcp-client-test-"));
}

function manifestFor(name: string, requires: { credentials?: string[]; tools?: string[] } = {}): ExtensionManifest {
  return {
    kind: "mcp_client",
    name,
    version: "0.1.0",
    description: "测试用外部 MCP client 扩展",
    requires: { credentials: requires.credentials ?? [], tools: requires.tools ?? [] },
  };
}

function emptyGrant(): ExtensionGrant {
  return { credentials: [], tools: [] };
}

function goodServerConfig(overrides: Partial<Parameters<typeof validateMcpClientConfig>[0] & Record<string, unknown>> = {}) {
  return validateMcpClientConfig({
    command: process.execPath,
    args: [GOOD_SERVER],
    startupTimeoutMs: 5_000,
    callTimeoutMs: 3_000,
    ...overrides,
  });
}

// ── §1 mcp.json schema ───────────────────────────────────────────────────────

describe("mcp.json schema（validateMcpClientConfig）", () => {
  test("正向：最小合法配置，缺省字段有合理默认值", () => {
    const config = validateMcpClientConfig({ command: "true" });
    expect(config.args).toEqual([]);
    expect(config.env).toEqual([]);
    expect(config.credentials).toEqual([]);
    expect(config.startupTimeoutMs).toBeGreaterThan(0);
    expect(config.callTimeoutMs).toBeGreaterThan(0);
  });

  test("拒绝空 command", () => {
    expect(() => validateMcpClientConfig({ command: "" })).toThrow(McpClientConfigError);
    expect(() => validateMcpClientConfig({})).toThrow(McpClientConfigError);
  });

  test("拒绝非字符串数组的 args/env", () => {
    expect(() => validateMcpClientConfig({ command: "x", args: [1, 2] })).toThrow(McpClientConfigError);
    expect(() => validateMcpClientConfig({ command: "x", env: [1] })).toThrow(McpClientConfigError);
  });

  test("credentials 每一项必须是 {id, field, env}", () => {
    expect(() => validateMcpClientConfig({ command: "x", credentials: [{ id: "a" }] })).toThrow(McpClientConfigError);
    const ok = validateMcpClientConfig({ command: "x", credentials: [{ id: "a", field: "apiKey", env: "API_KEY" }] });
    expect(ok.credentials).toEqual([{ id: "a", field: "apiKey", env: "API_KEY" }]);
  });

  test("loadMcpClientConfig：非法 JSON 抛 McpClientConfigError", () => {
    expect(() => loadMcpClientConfig("{not json")).toThrow(McpClientConfigError);
  });
});

// ── §2 凭据 → 子进程 env（resolveMcpChildEnv）+ 阴性对照③ ───────────────────

describe("resolveMcpChildEnv：凭据默认拿不到（AD-2 在子进程边界上的落点）", () => {
  const manifest = manifestFor("cred-ext", { credentials: ["paidsource"] });
  const config = validateMcpClientConfig({
    command: "true",
    credentials: [{ id: "paidsource", field: "apiKey", env: "UPSTREAM_KEY" }],
  });
  const fakeCredentials: CredentialAccessor = {
    has: (id) => id === "paidsource",
    get: (id) => (id === "paidsource" ? { apiKey: "super-secret-value" } : null),
  };

  test("正向：声明 + 授权都满足时，值被注入子进程 env", () => {
    const grant: ExtensionGrant = { credentials: ["paidsource"], tools: [] };
    const env = resolveMcpChildEnv(manifest, config, grant, { credentials: fakeCredentials });
    expect(env.UPSTREAM_KEY).toBe("super-secret-value");
  });

  test("【阴性对照③】未 grant 时，env 里既没有变量名也没有值本体", () => {
    const grant: ExtensionGrant = emptyGrant(); // 没有 ext grant --credential
    const env = resolveMcpChildEnv(manifest, config, grant, { credentials: fakeCredentials });
    expect(env.UPSTREAM_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain("super-secret-value");
    expect(JSON.stringify(env)).not.toContain("super-secret-value");
  });

  test("manifest 未声明该凭据 id 时，即使 grant 了也拿不到（声明+授权缺一不可）", () => {
    const undeclaredManifest = manifestFor("cred-ext-2", { credentials: [] }); // 没声明 paidsource
    const grant: ExtensionGrant = { credentials: ["paidsource"], tools: [] };
    const env = resolveMcpChildEnv(undeclaredManifest, config, grant, { credentials: fakeCredentials });
    expect(env.UPSTREAM_KEY).toBeUndefined();
  });

  test("没有接入真实 CredentialStore（deps.credentials 缺省）时，即使 grant 了也拿不到", () => {
    const grant: ExtensionGrant = { credentials: ["paidsource"], tools: [] };
    const env = resolveMcpChildEnv(manifest, config, grant, {});
    expect(env.UPSTREAM_KEY).toBeUndefined();
  });

  test("env 白名单：只透传显式声明的宿主变量名", () => {
    process.env.SPARK_MCP_TEST_PROBE = "probe-value";
    try {
      const cfg = validateMcpClientConfig({ command: "true", env: ["SPARK_MCP_TEST_PROBE"] });
      const env = resolveMcpChildEnv(manifestFor("env-ext"), cfg, emptyGrant(), {});
      expect(env.SPARK_MCP_TEST_PROBE).toBe("probe-value");
      // 没在白名单里的变量不会被顺带透传。
      expect(env.HOME).toBeUndefined();
    } finally {
      delete process.env.SPARK_MCP_TEST_PROBE;
    }
  });
});

// ── §3 connectExternalMcp：真实 spawn 一个假的外部 MCP server ───────────────

describe("connectExternalMcp · 正向：真实 stdio 往返", () => {
  test("列出工具 + 调用 echo 成功往返", async () => {
    const manifest = manifestFor("good-ext");
    const config = goodServerConfig();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant() });
    expect(result.ok).toBe(true);
    expect(result.session!.tools.map((t) => t.name).sort()).toEqual(["echo", "slow", "whoami"]);

    const outcome = await result.session!.call("echo", { text: "hello" });
    expect(outcome.ok).toBe(true);
    expect(outcome.payload).toEqual({ echoed: { text: "hello" } });

    await result.session!.close();
  });

  test("凭据不会泄漏进子进程：whoami 探针看不到未透传的变量", async () => {
    const manifest = manifestFor("good-ext-2");
    const config = goodServerConfig(); // 没有声明任何 env/credentials
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant() });
    const outcome = await result.session!.call("whoami", {});
    expect(outcome.ok).toBe(true);
    expect((outcome.payload as { env: Record<string, string | null> }).env.UPSTREAM_KEY).toBeNull();
    await result.session!.close();
  });

  test("调用一个不存在的外部工具名：结构化失败，不抛异常", async () => {
    const manifest = manifestFor("good-ext-3");
    const config = goodServerConfig();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant() });
    const outcome = await result.session!.call("nope", {});
    expect(outcome.ok).toBe(false);
    expect((outcome.payload as { error: string }).error).toContain("nope");
    await result.session!.close();
  });

  test("调用超时：callTimeoutMs 短于工具实际耗时，结构化失败而不是挂起", async () => {
    const manifest = manifestFor("good-ext-4");
    const config = goodServerConfig({ callTimeoutMs: 200 });
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant() });
    const outcome = await result.session!.call("slow", { delayMs: 3000 });
    expect(outcome.ok).toBe(false);
    expect((outcome.payload as { error: string }).error).toMatch(/超时|timed? ?out/i);
    await result.session!.close();
  }, 10_000);
});

// ── §4 外部 server 挂了/超时：主进程存活 + 阴性对照②（第一支：connectExternalMcp 级别）──

describe("connectExternalMcp · 阴性对照②：外部 server 挂掉/超时不拖垮主进程", () => {
  test("命令启动即崩溃（dead_on_arrival）：结构化失败，本测试进程本身继续正常运行", async () => {
    const manifest = manifestFor("dead-ext");
    const config = validateMcpClientConfig({ command: process.execPath, args: [DEAD_ON_ARRIVAL], startupTimeoutMs: 3_000 });
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant() });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    // 走到这里就是"主进程存活"的证明——没有走到这里说明上面那行已经把测试进程炸了。
    expect(1 + 1).toBe(2);
  });

  test("命令起来了但从不回应（silent）：启动超时后结构化失败，不会无限期挂起", async () => {
    const manifest = manifestFor("silent-ext");
    const config = validateMcpClientConfig({ command: process.execPath, args: [SILENT], startupTimeoutMs: 800 });
    const startedAt = Date.now();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant() });
    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000); // 确认真的是"超时返回"而不是恰好很慢地成功
  }, 10_000);
});

// ── §5 执行记录：阴性对照①（差异化点） ──────────────────────────────────────

describe("执行记录（.mcp_calls.jsonl）：相对 OpenScience 的差异化点", () => {
  test("成功调用落一条记录", async () => {
    const root = freshRoot();
    const manifest = manifestFor("record-ext-1");
    const config = goodServerConfig();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root } });
    const before = readMcpCallRecords(manifest.name, { root }).length;
    await result.session!.call("echo", { text: "x" });
    const after = readMcpCallRecords(manifest.name, { root });
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].ok).toBe(true);
    expect(after[after.length - 1].tool).toBe("echo");
    await result.session!.close();
  });

  test("失败调用（未知工具）也落一条记录，ok=false", async () => {
    const root = freshRoot();
    const manifest = manifestFor("record-ext-2");
    const config = goodServerConfig();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root } });
    await result.session!.call("does-not-exist", {});
    const records = readMcpCallRecords(manifest.name, { root });
    expect(records.length).toBe(1);
    expect(records[0].ok).toBe(false);
    expect(records[0].errorSummary).toBe("unknown_tool");
    await result.session!.close();
  });

  test("超时调用也落一条记录（不是悬而未决，是明确的失败记录）", async () => {
    const root = freshRoot();
    const manifest = manifestFor("record-ext-3");
    const config = goodServerConfig({ callTimeoutMs: 200 });
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root } });
    await result.session!.call("slow", { delayMs: 2000 });
    const records = readMcpCallRecords(manifest.name, { root });
    expect(records.length).toBe(1);
    expect(records[0].ok).toBe(false);
    await result.session!.close();
  }, 10_000);

  test("参数摘要经过脱敏（redactSecrets），不会把 apiKey 明文落进执行记录", async () => {
    const root = freshRoot();
    const manifest = manifestFor("record-ext-4");
    const config = goodServerConfig();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root } });
    await result.session!.call("echo", { apiKey: "sk-abcdefghijklmnop" });
    const records = readMcpCallRecords(manifest.name, { root });
    expect(records[0].argsSummary).not.toContain("sk-abcdefghijklmnop");
    await result.session!.close();
  });

  test("appendMcpCallRecord/readMcpCallRecords 是唯一记账口——直接验证 JSONL 落盘格式", () => {
    const root = freshRoot();
    appendMcpCallRecord("raw-ext", { extension: "raw-ext", tool: "t", ok: true, argsSummary: "{}", durationMs: 1, timestamp: Date.now() }, { root });
    appendMcpCallRecord("raw-ext", { extension: "raw-ext", tool: "t2", ok: false, argsSummary: "{}", durationMs: 2, timestamp: Date.now() }, { root });
    const records = readMcpCallRecords("raw-ext", { root });
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.tool)).toEqual(["t", "t2"]);
  });
});

// ── §6 discoverExternalMcpTools + 发现缓存 ──────────────────────────────────

describe("discoverExternalMcpTools · 发现缓存", () => {
  test("成功发现：缓存 ok=true，记录工具清单", async () => {
    const root = freshRoot();
    const dir = extensionDir("discover-ok", { root });
    mkdirSync(dir, { recursive: true });
    const manifest = manifestFor("discover-ok");
    const config = goodServerConfig();
    const cache = await discoverExternalMcpTools(dir, manifest, config, emptyGrant(), {}, { root });
    expect(cache.ok).toBe(true);
    expect(cache.tools.map((t) => t.name).sort()).toEqual(["echo", "slow", "whoami"]);
    const reread = readMcpDiscoveryCache(dir);
    expect(reread?.ok).toBe(true);
  });

  test("失败发现：缓存 ok=false，带上原因，不抛异常", async () => {
    const root = freshRoot();
    const dir = extensionDir("discover-fail", { root });
    mkdirSync(dir, { recursive: true });
    const manifest = manifestFor("discover-fail");
    const config = validateMcpClientConfig({ command: process.execPath, args: [DEAD_ON_ARRIVAL], startupTimeoutMs: 2_000 });
    const cache = await discoverExternalMcpTools(dir, manifest, config, emptyGrant(), {}, { root });
    expect(cache.ok).toBe(false);
    expect(cache.reason).toBeTruthy();
    expect(cache.tools).toEqual([]);
  });
});

// ── §7 loader.ts：kind=mcp_client 的装载（TOFU） ────────────────────────────

describe("loadExtension · kind=mcp_client", () => {
  function writeMcpExtension(root: string, name: string, mcpJson: Record<string, unknown>) {
    const dir = extensionDir(name, { root });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "extension.json"),
      JSON.stringify({ kind: "mcp_client", name, version: "0.1.0", description: "测试扩展" }, null, 2),
    );
    writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcpJson, null, 2));
    return dir;
  }

  test("找不到 mcp.json 时装载失败", async () => {
    const root = freshRoot();
    const dir = extensionDir("no-mcp-json", { root });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "extension.json"), JSON.stringify({ kind: "mcp_client", name: "no-mcp-json", version: "0.1.0", description: "d" }));
    const loaded = await loadExtension(dir, { pathOptions: { root } });
    expect(loaded.status).toBe("failed");
    expect(loaded.reason).toContain("mcp.json");
  });

  test("不带 --trust：拒绝装载（同 TS 扩展一样的 TOFU 模型）", async () => {
    const root = freshRoot();
    const dir = writeMcpExtension(root, "untrusted-mcp", { command: process.execPath, args: [GOOD_SERVER] });
    const loaded = await loadExtension(dir, { pathOptions: { root } });
    expect(loaded.status).toBe("failed");
    expect(loaded.reason).toContain("尚未信任");
  });

  test("带 --trust：装载成功，返回解析后的 mcpConfig，且不会顺手启动子进程", async () => {
    const root = freshRoot();
    const dir = writeMcpExtension(root, "trusted-mcp", { command: process.execPath, args: [GOOD_SERVER] });
    const loaded = await loadExtension(dir, { trust: true, pathOptions: { root } });
    expect(loaded.status).toBe("loaded");
    expect(loaded.kind).toBe("mcp_client");
    expect(loaded.mcpConfig?.command).toBe(process.execPath);
    // "不会顺手启动子进程"这句话的可验证形式：装载后没有发现缓存文件——
    // 发现缓存只由 discoverExternalMcpTools() 写入，装载器本身从不调用它。
    expect(existsSync(join(dir, ".mcp_discovery.json"))).toBe(false);
  });

  test("内容变化后需要重新 --trust", async () => {
    const root = freshRoot();
    const dir = writeMcpExtension(root, "changing-mcp", { command: process.execPath, args: [GOOD_SERVER] });
    const first = await loadExtension(dir, { trust: true, pathOptions: { root } });
    expect(first.status).toBe("loaded");

    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ command: process.execPath, args: [GOOD_SERVER, "--extra-arg"] }, null, 2));
    const second = await loadExtension(dir, { pathOptions: { root } }); // 没再传 --trust
    expect(second.status).toBe("failed");
    expect(second.reason).toContain("重新确认");
  });

  test("mcp.json 内容非法：装载失败，报出校验错误", async () => {
    const root = freshRoot();
    const dir = writeMcpExtension(root, "bad-mcp-json", { command: "" });
    const loaded = await loadExtension(dir, { trust: true, pathOptions: { root } });
    expect(loaded.status).toBe("failed");
    expect(loaded.reason).toContain("command");
  });
});

// ── §8 ext verify（mcp_client_verify.ts） ───────────────────────────────────

describe("ext verify · kind=mcp_client", () => {
  test("正向：mcp.json 校验通过 + 能连接发现工具 + 声明的 verifySample 往返成功 + 执行记录确实落盘", async () => {
    const root = freshRoot();
    process.env.SPARK_RESEARCH_DATA_DIR = root;
    try {
      const dir = extensionDir("verify-good", { root });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "extension.json"), JSON.stringify({ kind: "mcp_client", name: "verify-good", version: "0.1.0", description: "d" }));
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({ command: process.execPath, args: [GOOD_SERVER], verifySample: { tool: "echo", args: { text: "verify" } } }, null, 2),
      );
      const result = await verifyExtension(dir);
      expect(result.ok).toBe(true);
      expect(result.checks.some((c) => c.name.includes("发现工具") && c.ok)).toBe(true);
      expect(result.checks.some((c) => c.name.includes("verifySample") && c.ok)).toBe(true);
      expect(result.checks.some((c) => c.name.includes("执行记录确实落盘") && c.ok)).toBe(true);
    } finally {
      delete process.env.SPARK_RESEARCH_DATA_DIR;
    }
  });

  test("未声明 verifySample：跳过往返检查，如实标注，不计入失败", async () => {
    const root = freshRoot();
    process.env.SPARK_RESEARCH_DATA_DIR = root;
    try {
      const dir = extensionDir("verify-no-sample", { root });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "extension.json"), JSON.stringify({ kind: "mcp_client", name: "verify-no-sample", version: "0.1.0", description: "d" }));
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({ command: process.execPath, args: [GOOD_SERVER] }, null, 2));
      const result = await verifyExtension(dir);
      expect(result.ok).toBe(true);
      expect(result.checks.some((c) => c.name.includes("跳过"))).toBe(true);
    } finally {
      delete process.env.SPARK_RESEARCH_DATA_DIR;
    }
  });

  test("外部 server 连不上：verify 失败，报出原因，不抛异常", async () => {
    const root = freshRoot();
    process.env.SPARK_RESEARCH_DATA_DIR = root;
    try {
      const dir = extensionDir("verify-dead", { root });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "extension.json"), JSON.stringify({ kind: "mcp_client", name: "verify-dead", version: "0.1.0", description: "d" }));
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({ command: process.execPath, args: [DEAD_ON_ARRIVAL], startupTimeoutMs: 2000 }, null, 2));
      const result = await verifyExtension(dir);
      expect(result.ok).toBe(false);
      expect(result.checks.some((c) => c.name.includes("发现工具") && !c.ok)).toBe(true);
    } finally {
      delete process.env.SPARK_RESEARCH_DATA_DIR;
    }
  });
});

// ── §9 capabilities.ts：origin / mcpTools / failed 状态 ─────────────────────

describe("listExtensionCapabilities · mcp_client", () => {
  test("从未发现过：unverified，且带 origin 标记来源是外部 MCP server", async () => {
    const root = freshRoot();
    const dir = extensionDir("cap-unverified", { root });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "extension.json"), JSON.stringify({ kind: "mcp_client", name: "cap-unverified", version: "0.1.0", description: "d" }));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ command: process.execPath, args: [GOOD_SERVER] }, null, 2));

    const caps = await listExtensionCapabilities({ root });
    const entry = caps.find((c) => c.name === "cap-unverified")!;
    expect(entry.status).toBe("unverified");
    expect(entry.origin).toBe("external_mcp_server");
  });

  test("【阴性对照②·capabilities 侧】发现失败：状态变成 failed，reason 带外部原因", async () => {
    const root = freshRoot();
    const dir = extensionDir("cap-failed", { root });
    mkdirSync(dir, { recursive: true });
    const manifestJson = { kind: "mcp_client", name: "cap-failed", version: "0.1.0", description: "d" };
    writeFileSync(join(dir, "extension.json"), JSON.stringify(manifestJson));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ command: process.execPath, args: [DEAD_ON_ARRIVAL], startupTimeoutMs: 2000 }, null, 2));

    await discoverExternalMcpTools(dir, manifestFor("cap-failed"), validateMcpClientConfig({ command: process.execPath, args: [DEAD_ON_ARRIVAL], startupTimeoutMs: 2000 }), emptyGrant(), {}, { root });

    const caps = await listExtensionCapabilities({ root });
    const entry = caps.find((c) => c.name === "cap-failed")!;
    expect(entry.status).toBe("failed");
    expect(entry.reason).toContain("外部 MCP server 不可达");
  });

  test("发现成功：capabilities 里能看到工具清单", async () => {
    const root = freshRoot();
    const dir = extensionDir("cap-ok", { root });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "extension.json"), JSON.stringify({ kind: "mcp_client", name: "cap-ok", version: "0.1.0", description: "d" }));
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ command: process.execPath, args: [GOOD_SERVER] }, null, 2));

    await discoverExternalMcpTools(dir, manifestFor("cap-ok"), goodServerConfig(), emptyGrant(), {}, { root });

    const caps = await listExtensionCapabilities({ root });
    const entry = caps.find((c) => c.name === "cap-ok")!;
    expect(entry.mcpTools?.map((t) => t.name).sort()).toEqual(["echo", "slow", "whoami"]);
  });

  test("needs_grant 优先于 discovery 失败展示（用户能直接采取行动的那一档）", async () => {
    const root = freshRoot();
    const dir = extensionDir("cap-needs-grant", { root });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "extension.json"),
      JSON.stringify({ kind: "mcp_client", name: "cap-needs-grant", version: "0.1.0", description: "d", requires: { credentials: ["x"], tools: [] } }),
    );
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ command: process.execPath, args: [DEAD_ON_ARRIVAL], startupTimeoutMs: 2000 }, null, 2));

    const caps = await listExtensionCapabilities({ root });
    const entry = caps.find((c) => c.name === "cap-needs-grant")!;
    expect(entry.status).toBe("needs_grant");
  });
});

// ── §10 CLI `ext add-mcp` ────────────────────────────────────────────────────

describe("runExtCommand · ext add-mcp", () => {
  test("正向：写入 extension.json + mcp.json，--trust 后发现工具，退出码 0", async () => {
    const root = freshRoot();
    process.env.SPARK_RESEARCH_DATA_DIR = root;
    try {
      const code = await runExtCommand(["add-mcp", "cli-good", "--cmd", `${process.execPath} ${GOOD_SERVER}`, "--trust"]);
      expect(code).toBe(0);
      const dir = extensionDir("cli-good", { root });
      expect(existsSync(join(dir, "extension.json"))).toBe(true);
      expect(existsSync(join(dir, "mcp.json"))).toBe(true);
      const cache = readMcpDiscoveryCache(dir);
      expect(cache?.ok).toBe(true);
      expect(cache?.tools.length).toBeGreaterThan(0);
    } finally {
      delete process.env.SPARK_RESEARCH_DATA_DIR;
    }
  });

  test("不带 --trust：写文件但不发现，退出码非 0", async () => {
    const root = freshRoot();
    process.env.SPARK_RESEARCH_DATA_DIR = root;
    try {
      const code = await runExtCommand(["add-mcp", "cli-untrusted", "--cmd", `${process.execPath} ${GOOD_SERVER}`]);
      expect(code).toBe(1);
      const dir = extensionDir("cli-untrusted", { root });
      expect(existsSync(join(dir, "extension.json"))).toBe(true);
      expect(readMcpDiscoveryCache(dir)).toBeNull();
    } finally {
      delete process.env.SPARK_RESEARCH_DATA_DIR;
    }
  });

  test("外部 server 连不上：仍然返回（不抛异常），退出码非 0，发现缓存记录失败", async () => {
    const root = freshRoot();
    process.env.SPARK_RESEARCH_DATA_DIR = root;
    try {
      const code = await runExtCommand(["add-mcp", "cli-dead", "--cmd", `${process.execPath} ${DEAD_ON_ARRIVAL}`, "--trust"]);
      expect(code).toBe(1);
      const dir = extensionDir("cli-dead", { root });
      const cache = readMcpDiscoveryCache(dir);
      expect(cache?.ok).toBe(false);
    } finally {
      delete process.env.SPARK_RESEARCH_DATA_DIR;
    }
  });

  test("--credential 映射被正确解析进 mcp.json 与 extension.json.requires.credentials", async () => {
    const root = freshRoot();
    process.env.SPARK_RESEARCH_DATA_DIR = root;
    try {
      await runExtCommand([
        "add-mcp",
        "cli-cred",
        "--cmd",
        `${process.execPath} ${GOOD_SERVER}`,
        "--credential",
        "paidsource:apiKey:UPSTREAM_KEY",
        "--trust",
      ]);
      const dir = extensionDir("cli-cred", { root });
      const mcpJson = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(mcpJson.credentials).toEqual([{ id: "paidsource", field: "apiKey", env: "UPSTREAM_KEY" }]);
      const extJson = JSON.parse(readFileSync(join(dir, "extension.json"), "utf8"));
      expect(extJson.requires.credentials).toEqual(["paidsource"]);
    } finally {
      delete process.env.SPARK_RESEARCH_DATA_DIR;
    }
  });
});

// ── §11 ExternalToolRegistry + McpToolRunnerWithExternal（ToolBus 接线证明） ──

describe("qualifyExternalToolName / parseQualifiedToolName", () => {
  test("往返一致", () => {
    const qualified = qualifyExternalToolName("my-server", "search");
    expect(qualified).toBe("mcp:my-server:search");
    expect(parseQualifiedToolName(qualified)).toEqual({ extension: "my-server", tool: "search" });
  });

  test("不带前缀的名字解析为 null（不是外部工具名）", () => {
    expect(parseQualifiedToolName("research_capabilities")).toBeNull();
  });
});

describe("ExternalToolRegistry", () => {
  test("specs() 汇总所有已注册扩展的工具，名字带前缀", async () => {
    const manifest = manifestFor("registry-ext");
    const config = goodServerConfig();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant() });
    const registry = new ExternalToolRegistry();
    registry.register(result.session!);

    const specs = registry.specs();
    expect(specs.map((s) => s.name).sort()).toEqual(["mcp:registry-ext:echo", "mcp:registry-ext:slow", "mcp:registry-ext:whoami"]);
    expect(registry.has("mcp:registry-ext:echo")).toBe(true);
    expect(registry.has("mcp:unknown-ext:echo")).toBe(false);

    const outcome = await registry.call("mcp:registry-ext:echo", { text: "via-registry" });
    expect(outcome.ok).toBe(true);

    await result.session!.close();
  });

  test("call() 对未注册扩展 / 非法工具名结构化失败", async () => {
    const registry = new ExternalToolRegistry();
    const notQualified = await registry.call("not-a-qualified-name");
    expect(notQualified.ok).toBe(false);
    const unregistered = await registry.call("mcp:ghost:tool");
    expect(unregistered.ok).toBe(false);
  });
});

function makeTestApp() {
  const root = mkdtempSync(join(tmpdir(), "spark-mcp-runner-test-"));
  const manager = new ProjectManager(root);
  const created = manager.create("w4d", { name: "W4-d 测试项目", description: "" });
  created.close();
  return createApp({ root, projects: manager, wetBackend: new MockDeviceBackend(), sseHeartbeatMs: 0 });
}

describe("createExternalToolRunner · 子类可赋值给 McpToolRunner，路由正确", () => {
  test("外部工具名路由给 registry，内置工具名原样交给父类", async () => {
    const manifest = manifestFor("runner-ext");
    const config = goodServerConfig();
    const connected = await connectExternalMcp({ manifest, config, grant: emptyGrant() });
    const registry = new ExternalToolRegistry();
    registry.register(connected.session!);

    const app = makeTestApp();
    const runner = await createExternalToolRunner({ app, timeoutMs: 5_000, pollIntervalMs: 20 }, registry);

    // 外部工具：走 registry。
    const externalOutcome = await runner.call("mcp:runner-ext:echo", { text: "via-runner" });
    expect(externalOutcome.ok).toBe(true);
    expect(externalOutcome.payload).toEqual({ echoed: { text: "via-runner" } });

    // 内置工具：MCP_TOOLS 里随便挑一个只读、零依赖的（research_capabilities 不依赖项目状态）。
    expect(MCP_TOOLS.some((t) => t.name === "research_capabilities")).toBe(true);
    const internalOutcome = await runner.call("research_capabilities", {});
    expect(internalOutcome.ok).toBe(true);

    // 未知工具：既不在 registry 也不在 MCP_TOOLS——父类的"未知工具"分支原样生效。
    const unknownOutcome = await runner.call("totally-unknown-tool", {});
    expect(unknownOutcome.ok).toBe(false);

    await connected.session!.close();
  });
});

// ── §12 一致性：ExtensionGrantStore 与 mcp_client 的授权面共用同一套账本 ────

describe("ExtensionGrantStore 与 mcp_client 共用授权账本（不另起一套）", () => {
  test("ext grant --credential 写入的授权，resolveMcpChildEnv 能读到", () => {
    const root = freshRoot();
    const store = new ExtensionGrantStore({ root });
    store.grantCredential("shared-ledger-ext", "paidsource");
    const grant = store.get("shared-ledger-ext");

    const manifest = manifestFor("shared-ledger-ext", { credentials: ["paidsource"] });
    const config = validateMcpClientConfig({ command: "true", credentials: [{ id: "paidsource", field: "apiKey", env: "UPSTREAM_KEY" }] });
    const env = resolveMcpChildEnv(manifest, config, grant, { credentials: { has: () => true, get: () => ({ apiKey: "v" }) } });
    expect(env.UPSTREAM_KEY).toBe("v");
  });
});

// ── §13 V31（W5-2 δ）：外部工具调用再落一条证据图 observation ────────────────
//
// 相对 §5（.mcp_calls.jsonl 的阴性对照①）的关系：这里测的是 jsonl **之外**新增的
// 那一半——`recordSink` 给了之后，同一个 record() 分发点要**同时**落两份记录。
// 用真的 `RecordStore`（不是手搓假对象）：更贴近生产形态，也顺带验证 metadata 形状
// 真的能被 `EvidenceRecordSink = Pick<RecordStore, "create">` 这个窄类型接住。

function freshRecordStore(): RecordStore {
  const root = freshRoot();
  return new RecordStore(join(root, "records.db"), "w52d-test");
}

function externalToolCallObservations(store: RecordStore) {
  return store
    .list({ type: "observation" })
    .filter((r) => (r.metadata as Partial<ExternalToolCallObservationMetadata>).kind === EXTERNAL_TOOL_CALL_OBSERVATION_KIND);
}

describe("V31：recordSink 给了之后，外部工具调用再落一条 observation record", () => {
  test("正向：成功调用——jsonl 和 observation 都落，observation 的 metadata 形状正确", async () => {
    const root = freshRoot();
    const store = freshRecordStore();
    const manifest = manifestFor("v31-ok");
    const config = goodServerConfig();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root }, recordSink: store });

    const jsonlBefore = readMcpCallRecords(manifest.name, { root }).length;
    await result.session!.call("echo", { text: "hi" });

    // jsonl 那一半：W4-d 原有行为不受影响。
    expect(readMcpCallRecords(manifest.name, { root }).length).toBe(jsonlBefore + 1);

    // observation 那一半：V31 新增。
    const obs = externalToolCallObservations(store);
    expect(obs.length).toBe(1);
    expect(obs[0]!.type).toBe("observation");
    expect(obs[0]!.evidence).toBe("sourced");
    const meta = obs[0]!.metadata as unknown as ExternalToolCallObservationMetadata;
    expect(meta.extension).toBe("v31-ok");
    expect(meta.tool).toBe("echo");
    expect(meta.ok).toBe(true);
    expect(typeof meta.durationMs).toBe("number");
    expect(meta.argsSummary).toContain("hi");

    await result.session!.close();
  });

  test("不给 recordSink：只落 jsonl，不落 observation（W4-d 原样行为，V31 是纯增量不是替换）", async () => {
    const root = freshRoot();
    const store = freshRecordStore(); // 建了但不传给 connectExternalMcp
    const manifest = manifestFor("v31-no-sink");
    const config = goodServerConfig();
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root } });
    await result.session!.call("echo", { text: "hi" });
    expect(readMcpCallRecords(manifest.name, { root }).length).toBe(1); // jsonl 照常落
    expect(externalToolCallObservations(store).length).toBe(0); // 没传 recordSink，图上什么都没有
    await result.session!.close();
  });

  test(
    "【阴性对照③】失败调用（未知工具）也要落 observation，ok=false——不是只在成功时才落",
    async () => {
      const root = freshRoot();
      const store = freshRecordStore();
      const manifest = manifestFor("v31-fail-unknown");
      const config = goodServerConfig();
      const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root }, recordSink: store });
      await result.session!.call("does-not-exist", {});
      const obs = externalToolCallObservations(store);
      expect(obs.length).toBe(1);
      const meta = obs[0]!.metadata as unknown as ExternalToolCallObservationMetadata;
      expect(meta.ok).toBe(false);
      expect(meta.tool).toBe("does-not-exist");
      await result.session!.close();
    },
  );

  test("超时调用也要落 observation，ok=false（第四个分支，不是悬而未决）", async () => {
    const root = freshRoot();
    const store = freshRecordStore();
    const manifest = manifestFor("v31-fail-timeout");
    const config = goodServerConfig({ callTimeoutMs: 200 });
    const result = await connectExternalMcp({ manifest, config, grant: emptyGrant(), pathOptions: { root }, recordSink: store });
    await result.session!.call("slow", { delayMs: 2000 });
    const obs = externalToolCallObservations(store);
    expect(obs.length).toBe(1);
    expect((obs[0]!.metadata as unknown as ExternalToolCallObservationMetadata).ok).toBe(false);
    await result.session!.close();
  }, 10_000);

  test("落 observation 失败（recordSink.create 抛错）不拖垮工具调用本身的返回值，jsonl 仍然照常落", async () => {
    const root = freshRoot();
    const manifest = manifestFor("v31-sink-throws");
    const config = goodServerConfig();
    const brokenSink = {
      create(): never {
        throw new Error("boom：模拟 RecordStore 写入失败（比如磁盘满/db 锁住）");
      },
    };
    const result = await connectExternalMcp({
      manifest,
      config,
      grant: emptyGrant(),
      pathOptions: { root },
      recordSink: brokenSink as unknown as RecordStore,
    });
    const outcome = await result.session!.call("echo", { text: "hi" });
    expect(outcome.ok).toBe(true); // 调用本身没受影响
    expect(readMcpCallRecords(manifest.name, { root }).length).toBe(1); // jsonl 那一半照常落
    await result.session!.close();
  });
});
