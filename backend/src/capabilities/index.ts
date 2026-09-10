import { ConnectorRegistry } from "../connectors/registry";
import { CredentialStore } from "../daemon/credentials";
import { CONFIG_SETTINGS, resolveAll, resolveSetting, type ConfigOptions } from "../config";
import { SAFETY_RULES } from "../lab/safety";
import { DEFAULT_WET_BACKEND, WET_BACKEND_IDS, wetBackend } from "../lab/wet_backend";
import { CITATION_RULE } from "../reviewer/rules";
import { CONCLUSION_RULES } from "../reviewer/conclusion_rules";
import { RATING_VIOLATION_CODES } from "../ideation/novelty";
import { EDGE_TYPES, EVIDENCE_LABELS, RECORD_TYPES } from "../project/models";
import { DEFAULT_SIMULATION_PLATFORM, SIMULATION_PLATFORM_IDS, SimulationRegistry } from "../simulation/registry";
import { loadSkills, type SkillEntry } from "../skills/frontmatter";
import { MCP_TOOLS, MCP_WITHHELD } from "../mcp/tools";
import { LLMRouter, PROVIDER_MODELS, implementedProviders, type ProviderCapabilities } from "../llm/router";
import { PROVIDER_API_KEY_ENV } from "../llm/providers/registry";
import { PACKAGE_VERSION } from "../version";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 能力自描述（P9 交付物 3）。
//
// 两个消费者，一份数据：
//   外部 LLM   `capabilities --json`：schema + **可用性状态**，一次调用 introspect 整个工作台。
//   人类用户   `capabilities`：同一份数据渲染成表格。
//
// 硬纪律：**全部从真实注册表生成**。手写清单必然漂移——写的时候对，加一个 connector
// 就错了，而且没有任何东西会报警。一致性测试（tests/unit/capabilities.test.ts）
// 反过来核对：清单里的每一项都必须真实存在且可实例化。
//
// 「可用性」分两档，刻意不混：
//   静态可用性  由注册表元数据推出（占位实现 / 需要凭据但没配），零 IO，永远可算。
//   探测可用性  真去 spawn 一个子进程问「openmm 装了吗」。有代价，所以是 opt-in（`probe`）。
// 混在一起的话，一个没装 openmm 的环境会让 `capabilities` 变慢且不确定。

export type Availability = "available" | "needs_credential" | "placeholder" | "unavailable" | "unknown";

export interface ToolSchema {
  name: string;
  description: string;
  method: string;
  endpoint: string;
}

export interface ConnectorCapability {
  id: string;
  domain: string;
  description: string;
  baseUrl: string;
  apiKeyRequired: boolean;
  credentialConfigured: boolean | null;
  availability: Availability;
  reason: string | null;
  caveat: string | null;
  tools: ToolSchema[];
}

export interface PlatformCapability {
  id: string;
  description: string;
  deterministic: boolean;
  kinds: string[];
  isDefault: boolean;
  availability: Availability;
  reason: string | null;
}

export interface WetBackendCapability {
  id: string;
  description: string;
  isDefault: boolean;
  availability: Availability;
  reason: string | null;
}

export interface SkillCapability {
  name: string;
  description: string;
  category: string;
  domain: string;
  triggers: string[];
  connectors: string[];
  platforms: string[];
  validation: string[];
  path: string;
}

export interface RuleCapability {
  id: string;
  kind: "safety" | "citation" | "conclusion" | "novelty-rating";
  severity: string;
  description: string;
}

export interface McpToolCapability {
  name: string;
  description: string;
  longRunning: boolean;
}

// R-c-2：provider 能力位（AD-12）。外部 agent 与 P12 的 ToolBus 要在**选模型之前**
// 就知道能不能跑 tool loop——`router.capabilitiesFor(model)` 已经有这个信息
// （R-a 填实），这里把它接进 `capabilities --json`。
//
// **一个坑：不能直接 `capabilitiesFor(model)` 拿每个 provider 的能力位。**
// `LLMRouter.resolve()` 在 preferred provider 没配 key 时会**隐式回退**到任何一个
// 已配置的 provider——如果我们用真实的 `process.env` 探测某个没配 key 的 provider，
// 拿到的可能是别的 provider 的能力位（配对错了）。解法：给每个 provider 探测一次时，
// 构造一个**只把这一个 provider 的 key 设成占位值**的临时 env 传给 `new LLMRouter(env)`
// ——`capabilities()` 是纯本地计算（不发网络请求），用占位 key 拿到的能力位是真实的，
// 只是"是否已配置"这件事单独用 CONFIG_SETTINGS 的 `resolveSetting` 查（真实 env/config），
// 两件事分开查，就不会互相污染。
export interface ProviderCapabilityInfo {
  id: string;
  models: readonly string[];
  /** 真实环境里这个 provider 的 API key 是否已配置——**如实**，没配就是 false。 */
  configured: boolean;
  capabilities: ProviderCapabilities;
}

// 本地端点（`local/<model>` / `local:<model>`，见 docs/devlog/P11-a.md）不进
// `Provider` 联合类型，所以不出现在上面的 `providers` 数组里（那个数组的一致性测试
// 断言 id 集合恒等于 `implementedProviders()`，硬塞会破坏这条不变式）。但它是一条
// 真实可用的路径，`capabilities --json` 完全不提它，外部 agent 就没法自描述地发现
// "可以接本地模型"这件事——所以单独开一段 `localEndpoint`。capabilities 的取法与
// 上面同一招：给 `SPARK_LOCAL_LLM_BASE_URL` 塞一个占位值构造临时 router，探测
// `local/probe` 这个模型名，拿到的是 router.ts 里 `localCapabilities()` 的真实返回值
// （不是本文件手写重复一份，避免两处漂移）。
export interface LocalEndpointCapability {
  modelPrefix: string;
  baseUrlEnvVar: string;
  apiKeyEnvVar: string;
  /** baseUrl 是否已配置；key 允许为空，不计入这个判定。 */
  configured: boolean;
  capabilities: ProviderCapabilities;
}

export interface ConfigCapability {
  key: string;
  value: string | number | null;
  source: string;
  envVar: string | null;
  allowed: string[] | null;
  secret: boolean;
  summary: string;
  effect: string;
}

export interface CapabilityManifest {
  service: "spark-research";
  version: string;
  probed: boolean;
  connectors: ConnectorCapability[];
  simulationPlatforms: PlatformCapability[];
  wetBackends: WetBackendCapability[];
  skills: SkillCapability[];
  rules: RuleCapability[];
  mcp: {
    tools: McpToolCapability[];
    // 刻意不暴露的危险动作（AD-6）。写进能力清单本身就是文档：
    // 外部 agent 一眼看到「这些必须人来做」，而不是试了才发现调不到。
    withheld: Array<{ name: string; reason: string; humanAction: string }>;
  };
  recordTypes: readonly string[];
  edgeTypes: readonly string[];
  evidenceLabels: readonly string[];
  config: ConfigCapability[];
  providers: ProviderCapabilityInfo[];
  localEndpoint: LocalEndpointCapability;
}

export interface CapabilityOptions extends ConfigOptions {
  // 探测本地可用性（spawn 子进程）。默认 false —— 零 IO 的清单永远可算。
  probe?: boolean;
  connectors?: ConnectorRegistry;
  credentials?: CredentialStore;
  // 仿真根目录；只在 probe 时需要真实目录，默认用临时目录（探测不写业务数据）。
  simulationRoot?: string;
  skillsRoot?: string;
}

function connectorAvailability(
  apiKeyRequired: boolean,
  status: string,
  configured: boolean | null,
): { availability: Availability; reason: string | null } {
  if (status === "placeholder") {
    return { availability: "placeholder", reason: "占位实现：没有可用的公开 API 渠道，调用会失败" };
  }
  if (apiKeyRequired && configured !== true) {
    return {
      availability: "needs_credential",
      reason: "需要凭据但尚未配置；统一检索会把它标为 skipped（不是失败）",
    };
  }
  return { availability: "available", reason: null };
}

export async function buildCapabilities(options: CapabilityOptions = {}): Promise<CapabilityManifest> {
  const credentials = options.credentials ?? new CredentialStore({ root: options.root });
  const connectorRegistry = options.connectors ?? new ConnectorRegistry({ credentials }).registerBuiltins();

  const connectors: ConnectorCapability[] = connectorRegistry.listAll().map((entry) => {
    const apiKeyRequired = Boolean(entry.metadata?.apiKeyRequired);
    // AD-2：只回「是否已配置」，凭据值本体永远不出 daemon。
    const configured = apiKeyRequired ? credentials.has(entry.name) : null;
    const { availability, reason } = connectorAvailability(
      apiKeyRequired,
      entry.metadata?.status ?? "available",
      configured,
    );
    return {
      id: entry.name,
      domain: entry.domain,
      description: entry.description,
      baseUrl: entry.baseUrl,
      apiKeyRequired,
      credentialConfigured: configured,
      availability,
      reason,
      caveat: entry.metadata?.caveat ?? null,
      tools: entry.tools.map((t) => ({
        name: t.name,
        description: t.description,
        method: t.method ?? "GET",
        endpoint: t.endpoint,
      })),
    };
  });

  const simRoot = options.simulationRoot ?? mkdtempSync(join(tmpdir(), "spark-caps-"));
  const simRegistry = new SimulationRegistry({ root: simRoot });
  const simulationPlatforms: PlatformCapability[] = [];
  for (const id of SIMULATION_PLATFORM_IDS) {
    const platform = simRegistry.get(id) as unknown as {
      description: string;
      deterministic: boolean;
      kinds: readonly string[];
      available: () => Promise<{ ok: boolean; reason: string | null }>;
    };
    let availability: Availability = "unknown";
    let reason: string | null = options.probe ? null : "未探测（用 --probe 真去问一次本地环境）";
    if (options.probe) {
      const status = await platform.available();
      availability = status.ok ? "available" : "unavailable";
      reason = status.reason;
    }
    simulationPlatforms.push({
      id,
      description: platform.description,
      deterministic: platform.deterministic,
      kinds: [...platform.kinds],
      isDefault: id === DEFAULT_SIMULATION_PLATFORM,
      availability,
      reason,
    });
  }

  const wetBackends: WetBackendCapability[] = [];
  for (const id of WET_BACKEND_IDS) {
    const backend = wetBackend(id);
    let availability: Availability = "unknown";
    let reason: string | null = options.probe ? null : "未探测（用 --probe 真去问一次本地环境）";
    if (options.probe) {
      const status = await backend.available();
      availability = status.ok ? "available" : "unavailable";
      reason = status.reason;
    }
    wetBackends.push({
      id,
      description: backend.description,
      isDefault: id === DEFAULT_WET_BACKEND,
      availability,
      reason,
    });
  }

  const skillEntries: SkillEntry[] = loadSkills(options.skillsRoot ? { root: options.skillsRoot } : {});
  const skills: SkillCapability[] = skillEntries.map((entry) => ({
    name: entry.name,
    description: entry.frontmatter.description,
    category: entry.frontmatter.category,
    domain: entry.frontmatter.domain,
    triggers: entry.frontmatter.triggers,
    connectors: entry.frontmatter.connectors,
    platforms: entry.frontmatter.platforms,
    validation: entry.frontmatter.validation,
    path: entry.path,
  }));

  const rules: RuleCapability[] = [
    ...SAFETY_RULES.map((rule) => ({
      id: rule.id,
      kind: "safety" as const,
      severity: "blocking",
      description: rule.description,
    })),
    {
      id: CITATION_RULE,
      kind: "citation" as const,
      severity: "hard+soft",
      description: "综述/报告草稿里的每个引用 key 必须在项目文献库内；库外 key = hard veto，陈述冲突与强断言无引用 = soft",
    },
    ...CONCLUSION_RULES.map((id) => ({
      id,
      kind: "conclusion" as const,
      severity: id === "stats-plausibility" ? "soft-only" : "hard+soft",
      description: CONCLUSION_RULE_DESCRIPTIONS[id] ?? "",
    })),
    ...RATING_VIOLATION_CODES.map((code) => ({
      id: code,
      kind: "novelty-rating" as const,
      severity: "deterministic-override",
      description: RATING_RULE_DESCRIPTIONS[code] ?? "",
    })),
  ];

  const config: ConfigCapability[] = resolveAll(options).map((r) => ({
    key: r.key,
    value: r.spec.secret ? null : r.value,
    source: r.source,
    envVar: r.spec.envVar,
    allowed: r.spec.allowed ? [...r.spec.allowed] : null,
    secret: Boolean(r.spec.secret),
    summary: r.spec.summary,
    effect: r.spec.effect,
  }));

  // R-c-2：provider 能力位 + 本地端点，见上面两个接口的大注释。
  const FALLBACK_CAPABILITIES: ProviderCapabilities = {
    toolCalling: false,
    jsonMode: false,
    streaming: false,
    usageReported: false,
  };

  const providers: ProviderCapabilityInfo[] = implementedProviders().map((provider) => {
    const models = PROVIDER_MODELS[provider];
    const probeModel = models[0]!; // orchestrator.test.ts 已钉住「每个 provider 模型列表非空」
    const envVar = PROVIDER_API_KEY_ENV[provider];
    const probeRouter = new LLMRouter(envVar ? { [envVar]: "probe-placeholder-key" } : {});
    const capabilities = probeRouter.capabilitiesFor(probeModel) ?? FALLBACK_CAPABILITIES;
    const configured = envVar ? resolveSetting(envVar, options).configured : false;
    return { id: provider, models, configured, capabilities };
  });

  const LOCAL_BASE_URL_ENV = "SPARK_LOCAL_LLM_BASE_URL";
  const LOCAL_API_KEY_ENV = "SPARK_LOCAL_LLM_API_KEY";
  const localProbeRouter = new LLMRouter({ [LOCAL_BASE_URL_ENV]: "http://localhost:0/probe-placeholder" });
  const localEndpoint: LocalEndpointCapability = {
    modelPrefix: "local/ 或 local:",
    baseUrlEnvVar: LOCAL_BASE_URL_ENV,
    apiKeyEnvVar: LOCAL_API_KEY_ENV,
    configured: resolveSetting(LOCAL_BASE_URL_ENV, options).configured,
    capabilities: localProbeRouter.capabilitiesFor("local/probe-model") ?? FALLBACK_CAPABILITIES,
  };

  return {
    service: "spark-research",
    version: PACKAGE_VERSION,
    probed: Boolean(options.probe),
    connectors,
    simulationPlatforms,
    wetBackends,
    skills,
    rules,
    mcp: {
      tools: MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description.split("\n")[0]!,
        longRunning: Boolean(tool.longRunning),
      })),
      withheld: MCP_WITHHELD.map((w) => ({ name: w.name, reason: w.reason, humanAction: w.humanAction })),
    },
    recordTypes: RECORD_TYPES,
    edgeTypes: EDGE_TYPES,
    evidenceLabels: EVIDENCE_LABELS,
    config,
    providers,
    localEndpoint,
  };
}

const CONCLUSION_RULE_DESCRIPTIONS: Record<string, string> = {
  "data-consistency":
    "结论引用的证据必须是本项目里真实存在、类型自洽的记录：断链 / 跨项目 / 类型不对 / 零证据 = hard",
  "capability-labeling":
    "引用模拟数据却不标注、或在非确定性平台上声称逐位复现 = hard（能力位 simulated / deterministic 的消费端）",
  "stats-plausibility":
    "启发式提示：样本量过小、多重比较未校正、p 值贴边、强因果断言配弱证据。只出 soft，每条带 heuristic:true",
};

const RATING_RULE_DESCRIPTIONS: Record<string, string> = {
  no_candidates: "一条候选都没检到 → 结论不可用（检索不到 ≠ 新颖）",
  rating_without_nearest: "有候选却不列最近邻 → 结论不可用",
  unknown_work: "引用了候选清单之外的 key → 结论不可用",
  existing_without_high_affinity: "评 existing 却没引到高相似候选 → 降级为 incremental",
  novel_despite_high_affinity: "存在高相似候选却评 novel → 升级为 existing",
};

export { CONFIG_SETTINGS };
