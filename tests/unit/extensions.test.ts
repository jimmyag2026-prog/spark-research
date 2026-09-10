// W2-c · 扩展装载 + `ext verify` 的测试（v0.4 P17，AD-11 的落点）。
//
// 结构对应任务书的验收清单：
//   §1 manifest schema（types.ts）
//   §2 装载三种强度（loader.ts）+ 信任指纹（fingerprint.ts）
//   §3 授权账本（grants.ts）+ ExtensionContext 的结构性拒绝（context.ts）
//   §4 ext verify 四类扩展各自的验收（connector/platform/rule/skill）
//   §5 恶意扩展矩阵（①-⑤，任务书强制项）
//   §6 阴性对照（①②，任务书强制项，终端输出记入 docs/devlog/W2-c.md）
//   §7 capabilities 自描述 + verify 结果缓存
//   §8 CLI（runExtCommand）

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateExtensionManifest, ExtensionManifestError, requiresTrust } from "../../backend/src/extensions/types";
import { extensionsRoot, extensionDir, trustFilePath, grantsFilePath } from "../../backend/src/extensions/paths";
import { checkTrust, sha256File } from "../../backend/src/extensions/fingerprint";
import { ExtensionGrantStore, ExtensionGrantError } from "../../backend/src/extensions/grants";
import { buildExtensionContext } from "../../backend/src/extensions/context";
import type { ExtensionManifest } from "../../backend/src/extensions/types";
import { verifyExtension, formatVerifyResult } from "../../backend/src/extensions/verify";
import { runJobs, compareSerialParallel, type Job } from "../../backend/src/extensions/connector_verify";
import { loadExtension } from "../../backend/src/extensions/loader";
import { listExtensionCapabilities } from "../../backend/src/extensions/capabilities";
import { readVerifyCache, writeVerifyCache, subjectPathFor } from "../../backend/src/extensions/verify_cache";
import { runExtCommand } from "../../backend/src/extensions/cli";
import { HttpConnector, type HttpConnectorConfig } from "../../backend/src/connectors/base";
import { StubHttp, BufferedResponse, type HttpRequestInit } from "../../backend/src/http/client";

const FIXTURES = join(import.meta.dir, "../fixtures/extensions");

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-ext-test-"));
}

// 整个测试文件默认落进一个临时数据目录，绝不写真实的 ~/.spark-research——
// 凡是调用 loadExtension/checkTrust/ExtensionGrantStore 时没有显式传 pathOptions.root
// 的地方，都会落进这里，而不是跑测试的这台机器的真实数据目录。
process.env.SPARK_RESEARCH_DATA_DIR = freshRoot();

// ── §1 manifest schema ────────────────────────────────────────────────────

describe("extension.json schema（types.ts）", () => {
  test("正向：合法 manifest 全字段通过", () => {
    const m = validateExtensionManifest({
      kind: "connector",
      name: "good-connector",
      version: "0.1.0",
      description: "示例",
    });
    expect(m.kind).toBe("connector");
    expect(m.requires).toEqual({ credentials: [], tools: [] });
  });

  test("拒绝未知 kind", () => {
    expect(() => validateExtensionManifest({ kind: "eval", name: "x", version: "1", description: "d" })).toThrow(
      ExtensionManifestError,
    );
  });

  test("拒绝非 kebab-case 的 name", () => {
    expect(() => validateExtensionManifest({ kind: "rule", name: "Bad_Name", version: "1", description: "d" })).toThrow(
      ExtensionManifestError,
    );
  });

  test("拒绝非法 version", () => {
    expect(() => validateExtensionManifest({ kind: "rule", name: "x", version: "not-a-version!", description: "d" })).toThrow(
      ExtensionManifestError,
    );
  });

  test("requires.credentials / requires.tools 必须是字符串数组", () => {
    expect(() =>
      validateExtensionManifest({ kind: "rule", name: "x", version: "1", description: "d", requires: { credentials: [1] } }),
    ).toThrow(ExtensionManifestError);
  });

  test("requiresTrust：只有 connector 不需要 --trust", () => {
    expect(requiresTrust("connector")).toBe(false);
    expect(requiresTrust("skill")).toBe(true);
    expect(requiresTrust("platform")).toBe(true);
    expect(requiresTrust("backend")).toBe(true);
    expect(requiresTrust("rule")).toBe(true);
  });
});

// ── paths.ts ────────────────────────────────────────────────────────────

describe("扩展路径解析（paths.ts）", () => {
  test("root 覆盖生效，且三个路径函数落在同一棵树下", () => {
    const root = freshRoot();
    expect(extensionsRoot({ root })).toBe(join(root, "extensions"));
    expect(extensionDir("foo", { root })).toBe(join(root, "extensions", "foo"));
    expect(trustFilePath("foo", { root })).toBe(join(root, "extensions", "foo", ".trust.json"));
    expect(grantsFilePath({ root })).toBe(join(root, "extensions", ".grants.json"));
  });
});

// ── §2 信任指纹（TOFU）────────────────────────────────────────────────────

describe("信任指纹（fingerprint.ts，TOFU 模型）", () => {
  test("没有记录 + 不给 --trust → 拒绝，且消息里带 sha256 指纹", () => {
    const root = freshRoot();
    const entry = join(FIXTURES, "good-rule/index.ts");
    const result = checkTrust("good-rule", entry, false, { root });
    expect(result.trusted).toBe(false);
    expect(result.firstTime).toBe(true);
    expect(result.message).toContain("sha256:");
    expect(result.message).toContain(sha256File(entry));
    expect(existsSync(trustFilePath("good-rule", { root }))).toBe(false);
  });

  test("没有记录 + 给 --trust → 放行且落盘指纹记录", () => {
    const root = freshRoot();
    const entry = join(FIXTURES, "good-rule/index.ts");
    const result = checkTrust("good-rule", entry, true, { root });
    expect(result.trusted).toBe(true);
    expect(result.firstTime).toBe(true);
    expect(existsSync(trustFilePath("good-rule", { root }))).toBe(true);
    const record = JSON.parse(readFileSync(trustFilePath("good-rule", { root }), "utf8"));
    expect(record.sha256).toBe(sha256File(entry));
  });

  test("已信任且内容未变 → 不需要重复 --trust", () => {
    const root = freshRoot();
    const entry = join(FIXTURES, "good-rule/index.ts");
    checkTrust("good-rule", entry, true, { root }); // 首次信任
    const again = checkTrust("good-rule", entry, false, { root }); // 第二次不给 --trust
    expect(again.trusted).toBe(true);
    expect(again.firstTime).toBe(false);
    expect(again.changed).toBe(false);
  });

  test("已信任但内容变化（模拟指纹漂移）→ 必须重新 --trust", () => {
    const root = freshRoot();
    const entry = join(FIXTURES, "good-rule/index.ts");
    checkTrust("good-rule", entry, true, { root });
    // 用一个不同内容的文件冒充"同一个扩展换了代码"（不改动 fixture 本身）。
    const otherEntry = join(FIXTURES, "malicious-io-rule/index.ts");
    const denied = checkTrust("good-rule", otherEntry, false, { root });
    expect(denied.trusted).toBe(false);
    expect(denied.changed).toBe(true);
    const reconfirmed = checkTrust("good-rule", otherEntry, true, { root });
    expect(reconfirmed.trusted).toBe(true);
    expect(reconfirmed.changed).toBe(true);
  });
});

// ── §3 授权账本 + ExtensionContext 结构性拒绝（恶意矩阵①②）────────────────

describe("ExtensionGrantStore（grants.ts）", () => {
  test("grant / revoke 凭据与工具授权可持久化", () => {
    const root = freshRoot();
    const store = new ExtensionGrantStore({ root });
    expect(store.get("ext-a")).toEqual({ credentials: [], tools: [] });
    store.grantCredential("ext-a", "paidsource");
    store.grantTool("ext-a", "lit_search");
    expect(store.get("ext-a")).toEqual({ credentials: ["paidsource"], tools: ["lit_search"] });
    store.revokeCredential("ext-a", "paidsource");
    expect(store.get("ext-a")).toEqual({ credentials: [], tools: ["lit_search"] });
  });
});

describe("恶意矩阵 ① + ②：ExtensionContext 的结构性拒绝（context.ts）", () => {
  const manifest: ExtensionManifest = {
    kind: "rule",
    name: "matrix-ext",
    version: "0.1.0",
    description: "恶意矩阵①②测试用 manifest",
    requires: { credentials: ["allowed-cred"], tools: ["allowed-tool"] },
  };

  test("① manifest 声明 A 却调用未声明的 B 工具 → 拒；声明且授权过的工具正常放行", async () => {
    const ctx = buildExtensionContext(
      manifest,
      { credentials: [], tools: ["allowed-tool"] },
      { tools: { call: async (name) => `called:${name}` } },
    );
    await expect(ctx.tools.call("unlisted-tool")).rejects.toThrow(ExtensionGrantError);
    await expect(ctx.tools.call("unlisted-tool")).rejects.toThrow(/manifest\.requires\.tools 里没有声明/);
    await expect(ctx.tools.call("allowed-tool")).resolves.toBe("called:allowed-tool");
  });

  test("① 声明过但没被 grant 的工具，同样拒——声明不等于拿到", async () => {
    const ctx = buildExtensionContext(manifest, { credentials: [], tools: [] }, { tools: { call: async () => "x" } });
    await expect(ctx.tools.call("allowed-tool")).rejects.toThrow(/尚未被 `ext grant` 授权/);
  });

  test("② 未 grant 却取凭据 → 拒（即使 manifest 声明过）", () => {
    const ctx = buildExtensionContext(
      manifest,
      { credentials: [], tools: [] },
      { credentials: { has: () => true, get: () => ({ api_key: "secret" }) } },
    );
    expect(() => ctx.credentials.get("allowed-cred")).toThrow(ExtensionGrantError);
    expect(() => ctx.credentials.get("allowed-cred")).toThrow(/尚未被 `ext grant` 授权/);
    expect(ctx.credentials.has("allowed-cred")).toBe(false);
  });

  test("② manifest 根本没声明的凭据 id，grant 了也拒——授权不能越过声明", () => {
    const ctx = buildExtensionContext(
      manifest,
      { credentials: ["not-declared"], tools: [] },
      { credentials: { has: () => true, get: () => ({ api_key: "secret" }) } },
    );
    expect(() => ctx.credentials.get("not-declared")).toThrow(/没有声明这个 id/);
  });

  test("声明 + 授权同时满足 → 正常放行，值本体来自真实凭据源", () => {
    const ctx = buildExtensionContext(
      manifest,
      { credentials: ["allowed-cred"], tools: [] },
      { credentials: { has: () => true, get: () => ({ api_key: "secret" }) } },
    );
    expect(ctx.credentials.has("allowed-cred")).toBe(true);
    expect(ctx.credentials.get("allowed-cred")).toEqual({ api_key: "secret" });
  });

  test("没有接入真实凭据源/ToolBus 时，即使声明+授权都满足也明确拒绝（不是静默返回 null）", async () => {
    const ctx = buildExtensionContext(manifest, { credentials: ["allowed-cred"], tools: ["allowed-tool"] }, {});
    expect(() => ctx.credentials.get("allowed-cred")).toThrow(/没有接入真实凭据源/);
    await expect(ctx.tools.call("allowed-tool")).rejects.toThrow(/没有接入 ToolBus/);
  });
});

// ── §4 + §5 + §6：ext verify 各类型 + 恶意矩阵③④ + 阴性对照①────────────────

describe("ext verify · connector（含恶意矩阵③）", () => {
  test("正向：good-connector 全部检查通过", async () => {
    const result = await verifyExtension(join(FIXTURES, "good-connector"));
    if (!result.ok) console.log(formatVerifyResult(result));
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toContain("100 并发参数映射不变式（同 connector_race.test.ts 手法）");
  }, 30_000);

  test("恶意矩阵③：connector.json 塞内网地址（云 metadata）→ 装载路径拒绝，ext verify 同样拒绝", async () => {
    const result = await verifyExtension(join(FIXTURES, "malicious-ssrf-connector"));
    expect(result.ok).toBe(false);
    expect(result.checks[0]!.ok).toBe(false);
    expect(result.checks[0]!.detail).toMatch(/内网\/保留地址段|SSRF/);

    // "验证装载路径也走到它"——不是只测 verify，还要测 loadExtension 本身。
    const loaded = await loadExtension(join(FIXTURES, "malicious-ssrf-connector"));
    expect(loaded.status).toBe("failed");
    expect(loaded.reason).toMatch(/内网\/保留地址段|SSRF/);
  });
});

describe("阴性对照①：明知违反并发不变式的 connector 必须让检查变红", () => {
  // 复现 W1-c devlog 记录的手法：一个跨调用共享的可变字段（raceState），
  // 在 await 之前写、await 之后读——精确复现旧版 __handlingTool 那类竞态的形状。
  // 这里**不改动** connectors/base.ts / manifest.ts（两者都是只读复用），
  // 只在测试文件里手写一个独立的、结构性有毛病的 HttpConnector 子类。
  class BrokenConnector extends HttpConnector {
    private raceState: { toolName: string; mapped: Record<string, unknown> } | null = null;

    async call(toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const mapped = { ...params };
      this.raceState = { toolName, mapped };
      await Promise.resolve(); // 让出一次事件循环——竞态窗口
      const raced = this.raceState!; // 读共享字段：并发下可能已被别的调用覆盖
      return this.requestRaw(raced.toolName, raced.mapped);
    }
  }

  function echoHttp(): StubHttp {
    return new StubHttp(async (url: string, init: HttpRequestInit) => {
      const echo = { url, method: init.method ?? "GET" };
      return new BufferedResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify(echo)),
      });
    });
  }

  const config: HttpConnectorConfig = {
    baseUrl: "https://api.example.org",
    description: "阴性对照①测试用 connector",
    tools: [
      { name: "search", description: "s", endpoint: "/v1/search" },
      { name: "getById", description: "g", endpoint: "/v1/records/{id}" },
    ],
  };

  test("对一个真的有并发竞态的 connector，compareSerialParallel 必须判红（不能永远绿）", async () => {
    const jobs: Job[] = [];
    for (let i = 0; i < 40; i++) {
      jobs.push(i % 2 === 0 ? { toolName: "search", params: { q: `term-${i}` } } : { toolName: "getById", params: { id: `id-${i}` } });
    }

    const serial = await runJobs("serial", new BrokenConnector("broken", config, { http: echoHttp() }), jobs);
    const parallel = await runJobs("parallel", new BrokenConnector("broken", config, { http: echoHttp() }), jobs);

    const result = compareSerialParallel(serial, parallel, jobs);
    // 记入 devlog 的实跑输出——如实打印，不是断言之外的装饰。
    console.log(`[阴性对照①] compareSerialParallel 对已知有竞态的 connector 的判定：ok=${result.ok}`);
    if (result.detail) console.log(result.detail);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/并发结果与串行结果不一致/);
  });
});

describe("ext verify · rule", () => {
  test("正向：good-rule 通过（零 IO + 确定性）", async () => {
    const result = await verifyExtension(join(FIXTURES, "good-rule"));
    if (!result.ok) console.log(formatVerifyResult(result));
    expect(result.ok).toBe(true);
  });

  test("恶意矩阵：声称是纯函数规则、实际读文件系统 → 静态扫描拦下", async () => {
    const result = await verifyExtension(join(FIXTURES, "malicious-io-rule"));
    expect(result.ok).toBe(false);
    const scan = result.checks.find((c) => c.name.includes("静态扫描"));
    expect(scan?.ok).toBe(false);
    expect(scan?.detail).toContain("node:fs");
  });
});

describe("ext verify · skill", () => {
  test("正向：good-skill 通过（frontmatter schema + e2e 能跑）", async () => {
    const result = await verifyExtension(join(FIXTURES, "good-skill"));
    if (!result.ok) console.log(formatVerifyResult(result));
    expect(result.ok).toBe(true);
    expect(result.checks.some((c) => c.name.startsWith("e2e 能跑"))).toBe(true);
  }, 30_000);
});

describe("ext verify · platform（直接复用 P5 SimulationPlatform 契约测试套件）", () => {
  test(
    "正向：good-platform 过完 describeSimulationContract 的 13 条断言",
    async () => {
      const result = await verifyExtension(join(FIXTURES, "good-platform"));
      if (!result.ok) console.log(formatVerifyResult(result));
      expect(result.ok).toBe(true);
      const contractCheck = result.checks.find((c) => c.name.includes("describeSimulationContract"));
      expect(contractCheck?.ok).toBe(true);
      expect(contractCheck?.detail).toContain("pass");
    },
    60_000,
  );
});

describe("ext verify · backend（已知限制：只做结构检查，不覆盖完整 WetLabBackend 契约）", () => {
  test("正向：good-backend 导出形状正确", async () => {
    const result = await verifyExtension(join(FIXTURES, "good-backend"));
    if (!result.ok) console.log(formatVerifyResult(result));
    expect(result.ok).toBe(true);
  });

  test("loadExtension 能装载 backend kind 并拿到 module.backend", async () => {
    const loaded = await loadExtension(join(FIXTURES, "good-backend"), { trust: true });
    expect(loaded.status).toBe("loaded");
    const mod = loaded.module as { backend: { id: string } };
    expect(mod.backend.id).toBe("good-backend");
  });
});

// ── 恶意矩阵④：扩展抛异常，主进程存活，capabilities 标 failed ──────────────

describe("恶意矩阵④：扩展抛异常 → 主进程存活，status 标 failed", () => {
  test("loadExtension 对一个顶层直接 throw 的扩展，返回 status:failed 而不是把异常扔出来", async () => {
    const loaded = await loadExtension(join(FIXTURES, "throwing-extension"), { trust: true });
    expect(loaded.status).toBe("failed");
    expect(loaded.reason).toContain("boom");
    // 关键断言：这一行代码本身能执行到，证明上面那次装载没有把测试进程带崩。
    expect(true).toBe(true);
  });

  test("capabilities 清单里一个 manifest 损坏的扩展不会拖垮整份清单", async () => {
    const root = freshRoot();
    const dir = join(extensionsRoot({ root }), "broken-manifest");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "extension.json"), "{ 这不是合法 JSON", "utf8");

    const dir2 = join(extensionsRoot({ root }), "fine-connector");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "extension.json"), JSON.stringify({ kind: "connector", name: "fine-connector", version: "0.1.0", description: "d" }), "utf8");

    const caps = await listExtensionCapabilities({ root });
    expect(caps.length).toBe(2);
    const broken = caps.find((c) => c.name === "broken-manifest")!;
    expect(broken.status).toBe("failed");
    const fine = caps.find((c) => c.name === "fine-connector")!;
    expect(fine.status).toBe("unverified"); // 还没跑过 ext verify
  });
});

// ── 恶意矩阵⑤：未过 ext verify 的扩展装载时显式警告 ─────────────────────────

describe("恶意矩阵⑤：未过 ext verify 的扩展装载时显式警告", () => {
  test("从未 verify 过 → 装载时出现「从未跑过 ext verify」警告", async () => {
    const loaded = await loadExtension(join(FIXTURES, "good-connector"));
    expect(loaded.status).toBe("loaded");
    expect(loaded.warnings.some((w) => w.includes("从未跑过"))).toBe(true);
  });

  test("verify 过且通过、内容未变 → 不再出现该警告", async () => {
    const dir = join(FIXTURES, "good-connector");
    const result = await verifyExtension(dir);
    expect(result.ok).toBe(true);
    const subjectPath = subjectPathFor(dir, { kind: "connector" });
    writeVerifyCache(dir, { ok: true, at: new Date().toISOString(), subjectSha256: sha256File(subjectPath) });

    const loaded = await loadExtension(dir);
    expect(loaded.warnings.some((w) => w.includes("从未跑过"))).toBe(false);
    expect(loaded.warnings.some((w) => w.includes("已过期"))).toBe(false);
    expect(loaded.warnings.some((w) => w.includes("未通过"))).toBe(false);

    // 清理：这个仓库内 fixture 目录会被 git 跟踪，不要把 .verify.json 留在里面。
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, ".verify.json"), { force: true });
  });

  test("verify 过但上次没通过 → 警告标出“未通过”", async () => {
    const dir = join(FIXTURES, "good-rule");
    const subjectPath = subjectPathFor(dir, { kind: "rule", entry: "index.ts" });
    writeVerifyCache(dir, { ok: false, at: new Date().toISOString(), subjectSha256: sha256File(subjectPath) });

    const loaded = await loadExtension(dir, { trust: true });
    expect(loaded.warnings.some((w) => w.includes("未通过"))).toBe(true);

    const { rmSync } = await import("node:fs");
    rmSync(join(dir, ".verify.json"), { force: true });
  });
});

// ── 阴性对照②：去掉 --trust 确认 → 测试红 ───────────────────────────────────

describe("阴性对照②：TS 扩展去掉 --trust 确认 → 装载必须失败", () => {
  test("good-rule 不带 --trust → 装载失败，原因提到需要 --trust", async () => {
    const root = freshRoot();
    const loaded = await loadExtension(join(FIXTURES, "good-rule"), { pathOptions: { root } });
    console.log(`[阴性对照②] 不带 --trust 装载 good-rule：status=${loaded.status}, reason=${loaded.reason}`);
    expect(loaded.status).toBe("failed");
    expect(loaded.reason).toContain("--trust");
  });

  test("同一个扩展带 --trust → 装载成功（对照：确认 pathOptions/trust 接线本身没问题）", async () => {
    const root = freshRoot();
    const loaded = await loadExtension(join(FIXTURES, "good-rule"), { trust: true, pathOptions: { root } });
    expect(loaded.status).toBe("loaded");
    expect(loaded.module).toBeTruthy();
  });
});

// ── loader.ts 装载三种强度的基本形态 ────────────────────────────────────────

describe("loadExtension：三种装载强度", () => {
  test("kind=connector：不需要 --trust，直接编译成 HttpConnector", async () => {
    const loaded = await loadExtension(join(FIXTURES, "good-connector"));
    expect(loaded.status).toBe("loaded");
    expect(loaded.connector).toBeTruthy();
    expect(loaded.connector!.name).toBe("good-connector");
    const listed = loaded.connector!.listTools().map((t) => t.name);
    expect(listed).toEqual(["search", "getById", "createThing"]);
  });

  test("kind=rule：--trust 后拿到 module 与受限 context", async () => {
    const loaded = await loadExtension(join(FIXTURES, "good-rule"), { trust: true });
    expect(loaded.status).toBe("loaded");
    expect(loaded.context).toBeTruthy();
    const mod = loaded.module as { rule: { evaluate: (i: unknown) => unknown } };
    expect(mod.rule.evaluate({ name: "x" })).toEqual({ check: "nonempty name", passed: true, detail: undefined });
  });

  test("kind=platform：--trust 后拿到 createPlatform 工厂，能实例化出一个可用的 SimulationPlatform", async () => {
    const loaded = await loadExtension(join(FIXTURES, "good-platform"), { trust: true });
    expect(loaded.status).toBe("loaded");
    const mod = loaded.module as { createPlatform: (root: string) => { id: string; description: string } };
    const platform = mod.createPlatform(freshRoot());
    expect(platform.id).toBe("good-platform");
  });

  test("找不到 extension.json → 明确失败而不是抛异常", async () => {
    const loaded = await loadExtension(join(FIXTURES, "does-not-exist"));
    expect(loaded.status).toBe("failed");
  });
});

// ── capabilities.ts ─────────────────────────────────────────────────────

describe("listExtensionCapabilities：需要 grant 才 available（不执行任何扩展代码）", () => {
  test("有 requires 但未 grant → needs_grant；grant 后且 verify 通过 → available", async () => {
    const root = freshRoot();
    const dir = extensionDir("needs-cred-ext", { root });
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "extension.json"),
      JSON.stringify({
        kind: "rule",
        name: "needs-cred-ext",
        version: "0.1.0",
        entry: "index.ts",
        description: "d",
        requires: { credentials: ["some-source"], tools: [] },
      }),
      "utf8",
    );
    writeFileSync(join(dir, "index.ts"), 'export const rule = { id:"x", check:"x", description:"d", evaluate:(i:unknown)=>({check:"x",passed:true}) };\nexport const VERIFY_SAMPLE_INPUT = {};\n', "utf8");

    let caps = await listExtensionCapabilities({ root });
    expect(caps[0]!.status).toBe("needs_grant");

    new ExtensionGrantStore({ root }).grantCredential("needs-cred-ext", "some-source");
    caps = await listExtensionCapabilities({ root });
    expect(caps[0]!.status).toBe("unverified"); // grant 了，但还没 ext verify 过

    const result = await verifyExtension(dir);
    expect(result.ok).toBe(true);
    writeVerifyCache(dir, { ok: true, at: new Date().toISOString(), subjectSha256: sha256File(join(dir, "index.ts")) });
    caps = await listExtensionCapabilities({ root });
    expect(caps[0]!.status).toBe("available");
  });
});

// ── §8 CLI ──────────────────────────────────────────────────────────────

describe("runExtCommand（cli.ts）", () => {
  test("ext verify <path> 打印结果并按 ok/fail 返回退出码", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const code = await runExtCommand(["verify", join(FIXTURES, "good-connector")]);
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("ext verify: PASS");

      const badCode = await runExtCommand(["verify", join(FIXTURES, "malicious-ssrf-connector")]);
      expect(badCode).toBe(1);
    } finally {
      console.log = orig;
      const { rmSync } = await import("node:fs");
      rmSync(join(FIXTURES, "good-connector/.verify.json"), { force: true });
      rmSync(join(FIXTURES, "malicious-ssrf-connector/.verify.json"), { force: true });
    }
  }, 30_000);

  test("ext grant / revoke 往 .grants.json 写入并可再读出", async () => {
    const root = freshRoot();
    const prev = process.env.SPARK_RESEARCH_DATA_DIR;
    process.env.SPARK_RESEARCH_DATA_DIR = root;
    try {
      const code = await runExtCommand(["grant", "some-ext", "--credential", "some-source"]);
      expect(code).toBe(0);
      const store = new ExtensionGrantStore();
      expect(store.get("some-ext").credentials).toEqual(["some-source"]);

      const revokeCode = await runExtCommand(["revoke", "some-ext", "--credential", "some-source"]);
      expect(revokeCode).toBe(0);
      expect(store.get("some-ext").credentials).toEqual([]);
    } finally {
      process.env.SPARK_RESEARCH_DATA_DIR = prev;
    }
  });

  test("ext（无参数）打印帮助", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const code = await runExtCommand([]);
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("ext list");
    } finally {
      console.log = orig;
    }
  });
});

// ── verify_cache.ts ─────────────────────────────────────────────────────

describe("verify_cache.ts：subjectPathFor 对齐 connector/其它 kind", () => {
  test("connector kind 校验对象是 connector.json，其它 kind 是 entry 文件", () => {
    expect(subjectPathFor("/x/ext", { kind: "connector" })).toBe("/x/ext/connector.json");
    expect(subjectPathFor("/x/ext", { kind: "rule", entry: "main.ts" })).toBe("/x/ext/main.ts");
    expect(subjectPathFor("/x/ext", { kind: "rule" })).toBe("/x/ext/index.ts");
  });

  test("readVerifyCache 对不存在/损坏的缓存文件返回 null，不抛错", () => {
    expect(readVerifyCache(freshRoot())).toBeNull();
  });
});
