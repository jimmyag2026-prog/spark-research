import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCapabilities, clearProbeCache, computeVenvFingerprint } from "../../backend/src/capabilities";
import { runCapabilitiesCommand } from "../../backend/src/capabilities/cli";
import { CONFIG_SETTINGS, saveConfig } from "../../backend/src/config";
import { implementedProviders, LLMRouter, PROVIDER_MODELS } from "../../backend/src/llm/router";
import { PROVIDER_API_KEY_ENV } from "../../backend/src/llm/providers/registry";
import { BUILTIN_CONNECTORS, ConnectorRegistry } from "../../backend/src/connectors/registry";
import { CredentialStore } from "../../backend/src/daemon/credentials";
import { SAFETY_RULES } from "../../backend/src/lab/safety";
import { WET_BACKEND_IDS, wetBackend } from "../../backend/src/lab/wet_backend";
import { CONCLUSION_RULES } from "../../backend/src/reviewer/conclusion_rules";
import { RATING_VIOLATION_CODES } from "../../backend/src/ideation/novelty";
import { EDGE_TYPES, EVIDENCE_LABELS, RECORD_TYPES } from "../../backend/src/project/models";
import { SIMULATION_PLATFORM_IDS, SimulationRegistry } from "../../backend/src/simulation/registry";
import { MCP_TOOLS, MCP_WITHHELD } from "../../backend/src/mcp/tools";
import { skillDirs } from "../../backend/src/skills/frontmatter";

// P9 · 能力自描述的**一致性测试**。
//
// 手写清单必然漂移：写的时候对，加一个 connector 就错了，而且没有任何东西会报警。
// 所以清单必须从真实注册表生成，并由这组测试双向核对：
//   正向：清单里的每一项都真实存在**且可实例化**（不是「注册表里有这个名字」而已）。
//   反向：注册表里的每一项都出现在清单里（防止静默漏项——那是更隐蔽的一种漂移）。

const REPO_ROOT = join(import.meta.dir, "../..");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-caps-"));
}

const manifest = await buildCapabilities({ root: tmpRoot(), env: {} });

describe("capabilities · connectors 双向一致", () => {
  const registered = Object.entries(BUILTIN_CONNECTORS).flatMap(([domain, defs]) =>
    defs.map((d) => ({ domain, name: d.name })),
  );

  test("正向：清单里的每个 connector 都能实例化并列出工具", () => {
    const registry = new ConnectorRegistry().registerBuiltins();
    for (const entry of manifest.connectors) {
      const connector = registry.get(entry.id);
      expect(connector, `connector '${entry.id}' 在清单里但注册表拿不到`).toBeDefined();
      const tools = connector!.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(entry.tools.map((t) => t.name).sort());
      expect(entry.tools.every((t) => t.description.length > 0)).toBe(true);
    }
  });

  test("反向：注册表里的每个 connector 都在清单里（不许静默漏项）", () => {
    expect(manifest.connectors.map((c) => c.id).sort()).toEqual(registered.map((r) => r.name).sort());
    for (const { domain, name } of registered) {
      expect(manifest.connectors.find((c) => c.id === name)!.domain).toBe(domain);
    }
  });

  test("可用性分档正确：占位 / 需凭据 / 可用", () => {
    const byId = Object.fromEntries(manifest.connectors.map((c) => [c.id, c]));
    // 占位实现（无公开 API 渠道）
    expect(byId.cnki!.availability).toBe("placeholder");
    expect(byId.wanfang!.availability).toBe("placeholder");
    // 需凭据但未配置：明说会被 skip 而不是失败
    expect(byId.aminer!.availability).toBe("needs_credential");
    expect(byId.aminer!.reason).toContain("skipped");
    // 免 key 源
    expect(byId.openalex!.availability).toBe("available");
    // 已知的坑要原样透出（P2 实测 S2 匿名 429）
    expect(byId.semanticscholar!.caveat).toContain("429");
  });

  test("凭据配置后状态翻转，但值本体永远不出现在清单里（AD-2）", async () => {
    const root = tmpRoot();
    const credentials = new CredentialStore({ root });
    credentials.set("aminer", { api_key: "sk-should-never-appear" });
    const withKey = await buildCapabilities({ root, env: {}, credentials });
    const aminer = withKey.connectors.find((c) => c.id === "aminer")!;
    expect(aminer.credentialConfigured).toBe(true);
    expect(aminer.availability).toBe("available");
    expect(JSON.stringify(withKey)).not.toContain("sk-should-never-appear");
  });
});

describe("capabilities · 平台与后端双向一致", () => {
  test("正向：每个仿真平台都能实例化，kinds 非空", () => {
    const registry = new SimulationRegistry({ root: tmpRoot() });
    for (const p of manifest.simulationPlatforms) {
      const platform = registry.get(p.id) as unknown as { kinds: readonly string[]; deterministic: boolean };
      expect(platform.kinds.length).toBeGreaterThan(0);
      expect([...platform.kinds].sort()).toEqual([...p.kinds].sort());
      expect(platform.deterministic).toBe(p.deterministic);
    }
  });

  test("反向：注册表里的平台与后端一个不少，默认项唯一", () => {
    expect(manifest.simulationPlatforms.map((p) => p.id).sort()).toEqual([...SIMULATION_PLATFORM_IDS].sort());
    expect(manifest.wetBackends.map((b) => b.id).sort()).toEqual([...WET_BACKEND_IDS].sort());
    expect(manifest.simulationPlatforms.filter((p) => p.isDefault)).toHaveLength(1);
    expect(manifest.wetBackends.filter((b) => b.isDefault)).toHaveLength(1);
  });

  test("正向：每个湿实验后端都能实例化", () => {
    for (const b of manifest.wetBackends) {
      expect(wetBackend(b.id).id).toBe(b.id);
    }
  });

  test("不探测时可用性是 unknown 而不是假装 available", () => {
    for (const p of manifest.simulationPlatforms) expect(p.availability).toBe("unknown");
    for (const b of manifest.wetBackends) expect(b.availability).toBe("unknown");
    expect(manifest.probed).toBe(false);
  });

  test("--probe 时给出真实探测结论（pyref 零依赖，必须可用）", async () => {
    const probed = await buildCapabilities({ root: tmpRoot(), env: {}, probe: true });
    expect(probed.probed).toBe(true);
    const pyref = probed.simulationPlatforms.find((p) => p.id === "pyref")!;
    expect(pyref.availability).toBe("available");
    const mock = probed.wetBackends.find((b) => b.id === "mock_devices")!;
    expect(mock.availability).toBe("available");
    // 装没装 openmm/opentrons 因机器而异，但结论不能是 unknown——探测了就要给答案。
    for (const p of probed.simulationPlatforms) expect(["available", "unavailable"]).toContain(p.availability);
    for (const b of probed.wetBackends) expect(["available", "unavailable"]).toContain(b.availability);
  }, 120_000);
});

describe("capabilities · --probe 结果缓存（V18）", () => {
  test("不带 --probe 时不产生 probeCache 字段（静态可用性路径零 IO，不该扯上缓存）", async () => {
    for (const p of manifest.simulationPlatforms) expect(p.probeCache).toBeUndefined();
    for (const b of manifest.wetBackends) expect(b.probeCache).toBeUndefined();
  });

  test("同一个 venv 指纹下，第二次 --probe 复用缓存（不重新 spawn 子进程）", async () => {
    clearProbeCache();
    const first = await buildCapabilities({ root: tmpRoot(), env: {}, probe: true });
    const pyrefFirst = first.simulationPlatforms.find((p) => p.id === "pyref")!;
    const mockFirst = first.wetBackends.find((b) => b.id === "mock_devices")!;
    expect(pyrefFirst.probeCache).toBe("miss");
    expect(mockFirst.probeCache).toBe("miss");

    const second = await buildCapabilities({ root: tmpRoot(), env: {}, probe: true });
    const pyrefSecond = second.simulationPlatforms.find((p) => p.id === "pyref")!;
    const mockSecond = second.wetBackends.find((b) => b.id === "mock_devices")!;
    expect(pyrefSecond.probeCache).toBe("hit");
    expect(mockSecond.probeCache).toBe("hit");
    // 缓存命中给出的结论必须和当初探测出来的一致——不是随便垫一个默认值。
    expect(pyrefSecond.availability).toBe(pyrefFirst.availability);
    expect(mockSecond.availability).toBe(mockFirst.availability);
  }, 30_000);

  test("venv 指纹是三段式：路径 / 解释器 mtime / site-packages mtime，同一进程内两次计算结果相同", () => {
    const a = computeVenvFingerprint();
    const b = computeVenvFingerprint();
    expect(a).toEqual(b);
    expect(a.python.length).toBeGreaterThan(0);
  });

  test("V18 核心判据：venv 变了（换了解释器路径 + mtime）→ 缓存整体作废，不撒谎报旧结果", async () => {
    const prevPython = process.env.SPARK_PYTHON;
    const workDir = mkdtempSync(join(tmpdir(), "spark-caps-altpy-"));
    try {
      clearProbeCache();
      process.env.SPARK_PYTHON = "python3";
      const first = await buildCapabilities({ root: tmpRoot(), env: {}, probe: true });
      expect(first.simulationPlatforms.find((p) => p.id === "pyref")!.probeCache).toBe("miss");

      const second = await buildCapabilities({ root: tmpRoot(), env: {}, probe: true });
      expect(second.simulationPlatforms.find((p) => p.id === "pyref")!.probeCache).toBe("hit");

      // 换一个不同路径、全新 mtime 的解释器——一个转发到真实 python3 的 wrapper 脚本。
      // 探测结论（pyref 可用与否）本身不会变，但指纹的「解释器路径」与「解释器文件
      // mtime」两段都变了：这正是判据要抓的「venv 变更」，不是探测结论变了才失效。
      const wrapper = join(workDir, "python-alt");
      writeFileSync(wrapper, '#!/bin/sh\nexec python3 "$@"\n');
      chmodSync(wrapper, 0o755);
      process.env.SPARK_PYTHON = wrapper;

      const third = await buildCapabilities({ root: tmpRoot(), env: {}, probe: true });
      // 核心判据：指纹变了必须重新探测（miss），不能偷懒复用上一个解释器缓存下来的结果。
      expect(third.simulationPlatforms.find((p) => p.id === "pyref")!.probeCache).toBe("miss");
    } finally {
      if (prevPython === undefined) delete process.env.SPARK_PYTHON;
      else process.env.SPARK_PYTHON = prevPython;
      clearProbeCache();
    }
  }, 30_000);
});

describe("capabilities · 技能与规则双向一致", () => {
  test("正向：每个技能的 SKILL.md 与 validation 文件都在磁盘上", () => {
    for (const skill of manifest.skills) {
      expect(existsSync(skill.path)).toBe(true);
      for (const rel of skill.validation) expect(existsSync(join(REPO_ROOT, rel))).toBe(true);
      expect(skill.triggers.length).toBeGreaterThan(0);
    }
  });

  test("反向：技能目录一个不少", () => {
    expect(manifest.skills.map((s) => s.name).sort()).toEqual([...skillDirs()].sort());
  });

  test("规则清单覆盖四类真实规则，且 id 与真源一致", () => {
    const ids = (kind: string) => manifest.rules.filter((r) => r.kind === kind).map((r) => r.id);
    expect(ids("safety").sort()).toEqual(SAFETY_RULES.map((r) => r.id).sort());
    expect(ids("conclusion").sort()).toEqual([...CONCLUSION_RULES].sort());
    expect(ids("novelty-rating").sort()).toEqual([...RATING_VIOLATION_CODES].sort());
    expect(ids("citation")).toEqual(["citation-integrity"]);
    // 每条规则都要有非空描述——清单里出现一个只有 id 的规则等于没说明。
    for (const rule of manifest.rules) expect(rule.description.length).toBeGreaterThan(8);
  });

  test("stats-plausibility 的严重度必须标成 soft-only（它只提示不否决）", () => {
    expect(manifest.rules.find((r) => r.id === "stats-plausibility")!.severity).toBe("soft-only");
  });
});

describe("capabilities · MCP 与证据图与配置", () => {
  test("MCP 工具清单与真源一致，且刻意不暴露的动作被写进清单", () => {
    expect(manifest.mcp.tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(manifest.mcp.withheld.map((w) => w.name)).toEqual(MCP_WITHHELD.map((w) => w.name));
    for (const w of manifest.mcp.withheld) {
      expect(w.reason.length).toBeGreaterThan(10);
      expect(w.humanAction).toContain("spark-research");
    }
  });

  test("证据图的类型集合来自真源", () => {
    expect(manifest.recordTypes).toEqual(RECORD_TYPES);
    expect(manifest.edgeTypes).toEqual(EDGE_TYPES);
    expect(manifest.evidenceLabels).toEqual(EVIDENCE_LABELS);
  });

  test("配置段与设置表一一对应，凭据只报是否配置", async () => {
    expect(manifest.config.map((c) => c.key)).toEqual(CONFIG_SETTINGS.map((s) => s.key));
    const root = tmpRoot();
    saveConfig({ KIMI_API_KEY: "sk-should-never-appear" }, { root });
    const withSecret = await buildCapabilities({ root, env: {} });
    expect(JSON.stringify(withSecret)).not.toContain("sk-should-never-appear");
    expect(withSecret.config.find((c) => c.key === "KIMI_API_KEY")!.value).toBeNull();
  });
});

describe("capabilities · provider 能力位（R-c-2，AD-12）", () => {
  test("正向：provider 集合与真实实现的 implementedProviders() 一致", () => {
    expect(manifest.providers.map((p) => p.id).sort()).toEqual([...implementedProviders()].sort());
  });

  test("每个 provider 都带非空模型列表、configured 布尔值、四个能力位", () => {
    for (const p of manifest.providers) {
      expect(p.models.length).toBeGreaterThan(0);
      expect([...p.models].sort()).toEqual([...PROVIDER_MODELS[p.id as keyof typeof PROVIDER_MODELS]].sort());
      expect(typeof p.configured).toBe("boolean");
      expect(typeof p.capabilities.toolCalling).toBe("boolean");
      expect(typeof p.capabilities.jsonMode).toBe("boolean");
      expect(typeof p.capabilities.streaming).toBe("boolean");
      expect(typeof p.capabilities.usageReported).toBe("boolean");
    }
  });

  test("configured 如实反映真实 env：没配 key 就是 false，配了就是 true", async () => {
    const root = tmpRoot();
    const noKey = await buildCapabilities({ root, env: {} });
    for (const p of noKey.providers) expect(p.configured).toBe(false);

    const withKey = await buildCapabilities({ root, env: { OPENAI_API_KEY: "sk-test" } });
    const openai = withKey.providers.find((p) => p.id === "openai")!;
    expect(openai.configured).toBe(true);
    // 没配的 provider 依然如实报 false，不会因为别的 provider 配了就被带偏。
    const kimi = withKey.providers.find((p) => p.id === "kimi")!;
    expect(kimi.configured).toBe(false);
  });

  test("每个 provider 的能力位与直接探测该 provider（env 只给它自己的 key）一致——不会因为隐式回退串味", () => {
    for (const provider of implementedProviders()) {
      const envVar = PROVIDER_API_KEY_ENV[provider]!;
      const probeModel = PROVIDER_MODELS[provider][0]!;
      const direct = new LLMRouter({ [envVar]: "probe-key" }).capabilitiesFor(probeModel);
      expect(direct).not.toBeNull();
      const fromManifest = manifest.providers.find((p) => p.id === provider)!.capabilities;
      expect(fromManifest).toEqual(direct!);
    }
  });

  test("本地端点单独一段可见，不混进 providers 数组（local 不是 Provider 联合类型成员）", () => {
    expect(manifest.providers.some((p) => p.id === "local")).toBe(false);
    expect(manifest.localEndpoint).toBeDefined();
    expect(manifest.localEndpoint.baseUrlEnvVar).toBe("SPARK_LOCAL_LLM_BASE_URL");
    expect(manifest.localEndpoint.apiKeyEnvVar).toBe("SPARK_LOCAL_LLM_API_KEY");
    expect(typeof manifest.localEndpoint.configured).toBe("boolean");
    // 保守能力位：本地模型是否支持 tool calling/json 模式因模型而异，不能一刀切报 true。
    expect(manifest.localEndpoint.capabilities.toolCalling).toBe(false);
    expect(manifest.localEndpoint.capabilities.jsonMode).toBe(false);
    expect(manifest.localEndpoint.capabilities.usageReported).toBe(false);
  });

  test("本地端点 configured 如实反映 SPARK_LOCAL_LLM_BASE_URL 是否设置", async () => {
    const root = tmpRoot();
    const unset = await buildCapabilities({ root, env: {} });
    expect(unset.localEndpoint.configured).toBe(false);
    const set = await buildCapabilities({ root, env: { SPARK_LOCAL_LLM_BASE_URL: "http://localhost:11434" } });
    expect(set.localEndpoint.configured).toBe(true);
  });

  test("--json 输出里 providers/localEndpoint 与 buildCapabilities 同构", async () => {
    const lines: string[] = [];
    const code = await runCapabilitiesCommand(["--json"], {
      root: tmpRoot(),
      env: {},
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.providers.map((p: { id: string }) => p.id).sort()).toEqual(
      manifest.providers.map((p) => p.id).sort(),
    );
    expect(parsed.localEndpoint.modelPrefix).toBe(manifest.localEndpoint.modelPrefix);
  });

  test("不带 --json 的人看表格包含 LLM Provider 段", async () => {
    const lines: string[] = [];
    await runCapabilitiesCommand([], { root: tmpRoot(), env: {}, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(text).toContain("LLM Provider");
    expect(text).toContain("本地端点");
  });
});

describe("capabilities · CLI 两种输出同源", () => {
  test("--json 输出可解析且与 buildCapabilities 同构", async () => {
    const lines: string[] = [];
    const code = await runCapabilitiesCommand(["--json"], {
      root: tmpRoot(),
      env: {},
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.service).toBe("spark-research");
    expect(parsed.connectors.map((c: { id: string }) => c.id)).toEqual(manifest.connectors.map((c) => c.id));
    expect(parsed.mcp.tools).toHaveLength(MCP_TOOLS.length);
  });

  test("不带 --json 输出人看的表格，且包含不暴露动作的说明", async () => {
    const lines: string[] = [];
    await runCapabilitiesCommand([], { root: tmpRoot(), env: {}, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(text).toContain("能力清单");
    expect(text).toContain("Connector");
    expect(text).toContain("刻意不暴露");
    expect(text).toContain("lab_approve");
    expect(text).toContain("人来做");
  });

  test("未知参数报错而不是静默忽略", async () => {
    const lines: string[] = [];
    const code = await runCapabilitiesCommand(["--jsno"], {
      root: tmpRoot(),
      env: {},
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("未知参数");
  });
});
