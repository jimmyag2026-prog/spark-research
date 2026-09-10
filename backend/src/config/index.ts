import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 用户配置面收口（P9）。
//
// v0.2 之前，「可配置的东西」散在三处：`~/.spark-research/config.json`（只有 API key）、
// 一串 `SPARK_RESEARCH_*` 环境变量、以及各模块里的 `DEFAULT_*` 常量。
// 用户要改一个默认模型得先读源码才知道改哪儿——这正是 P9 要消掉的摩擦。
//
// 收口方式是**一张设置表**（`CONFIG_SETTINGS`），它是单一真源：
//   - `spark-research config list` 的表格由它渲染
//   - `spark-research capabilities` 的 config 段由它生成
//   - docs/EXTENDING.md 第六节的「哪些能改 / 改了影响什么」由它对照
// 手写第二份清单必然漂移，所以这里一份都不许有。
//
// 优先级一律 **env > config.json > 默认值**：临时改一次用环境变量，长期改用配置文件。
// 凭据（API key）与设置放在同一个文件里（沿用 v0.1 的 `auth` 行为），但在这一层
// 被显式标成 `secret`：`config list` 只显示「已设置 / 未设置」，值永不打印（AD-2 的延伸）。

export const CONFIG_FILE = "config.json";

// D-6（外部评审）：config.json 与 credentials.json 装着同等敏感的东西——LLM API key
// （KIMI_API_KEY / OPENROUTER_API_KEY，见下面 CONFIG_SETTINGS 的 secret: true 项）。
// credentials.json 从 P2 起就是 0600（daemon/credentials.ts AD-2），config.json 却一直
// 没指定 mode、落盘就是 umask 默认的 0644——同一台机器上，系统里最值钱的密钥反而是
// 保护最弱的那份。这里照抄 credentials.ts 的写法：目录 0700 / 文件 0600 / 写入后显式 chmod
// （`writeFileSync` 的 mode 只在创建新文件时生效，已存在的文件必须显式收紧）。
const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;

export type SettingType = "string" | "number" | "enum";

export interface SettingSpec {
  key: string;
  type: SettingType;
  // 对应的环境变量；给了就意味着 env 可以临时覆盖。
  envVar: string | null;
  // 默认值。`null` 表示「没有默认，由下游各自决定」。
  defaultValue: string | number | null;
  allowed?: readonly string[];
  // 这个设置是什么。
  summary: string;
  // **改了影响什么**——文档里最常缺的一段，放进真源里强制它存在。
  effect: string;
  // 凭据类：值永不出现在任何输出里。
  secret?: boolean;
}

// 默认值刻意在这里重新声明而不是 import 各模块常量：config 层不该反向依赖 lab/simulation/llm
// （那会把整个后端拖进 `spark-research config` 这条本该零依赖的命令）。
// 一致性由 `tests/unit/config.test.ts` 里的断言钉住——常量改了这里不改，测试会红。
export const CONFIG_SETTINGS: readonly SettingSpec[] = [
  {
    key: "defaultModel",
    type: "string",
    envVar: "SPARK_RESEARCH_MODEL",
    defaultValue: "moonshotai/kimi-k2.6",
    summary: "所有 LLM 调用的默认模型（provider 由模型名推断）",
    effect:
      "影响精读卡、综述草稿、Co-explore、novelty claim 提取与引用判定。换成弱模型会直接降低引用核验的判准率；换 provider 需要对应的 API key 已配置。",
  },
  {
    key: "defaultProvider",
    type: "enum",
    envVar: null,
    defaultValue: null,
    // R-c-3：R-a（P11-a）已经把 openai/deepseek/qwen 填进 router.ts 的 ADAPTERS
    // （真的能发请求的清单），这里的 allowed 之前还是只有 kimi/openrouter 两个——
    // 「声明支持的 provider」与「真的实现了的 provider」又要分家。用
    // tests/unit/config.test.ts 里的一致性测试钉住：allowed 必须与
    // `implementedProviders()` 集合相等，往后谁改了 ADAPTERS 忘了改这里，测试会红。
    allowed: ["kimi", "openrouter", "openai", "deepseek", "qwen", "anthropic"],
    summary: "`spark-research auth` 记录的默认 provider（key 选取顺序）",
    effect: "只影响没有显式指定模型时挑哪把 key；配了多把时按这个顺序取。",
  },
  {
    key: "contactEmail",
    type: "string",
    envVar: "SPARK_RESEARCH_CONTACT_EMAIL",
    defaultValue: "spark-research@example.invalid",
    summary: "文献 API 礼貌头里的联系邮箱（OpenAlex/CrossRef 的 polite pool）",
    effect:
      "未配置时用占位邮箱，请求照样走但进不了 polite pool——高频检索更容易被限流。配置成真实邮箱是对数据源的基本礼貌，不是可选项。",
  },
  {
    key: "userAgent",
    type: "string",
    envVar: "SPARK_RESEARCH_USER_AGENT",
    defaultValue: null,
    summary: "文献 connector 的 User-Agent（默认由版本号 + 项目地址 + contactEmail 拼出）",
    effect: "只影响 HTTP 请求头。自定义时请保留可联系到你的信息，否则数据源封禁时你不会收到通知。",
  },
  {
    key: "wetBackend",
    type: "enum",
    envVar: "SPARK_RESEARCH_WET_BACKEND",
    defaultValue: "opentrons_simulate",
    allowed: ["opentrons_simulate", "mock_devices"],
    summary: "湿实验默认执行后端",
    effect:
      "改成 mock_devices 会让协议**不再被 Opentrons 解析**——管线照样绿，但一个非法协议也会「执行成功」。除非在写单测，否则不要改。",
  },
  {
    key: "simulationPlatform",
    type: "enum",
    envVar: "SPARK_RESEARCH_SIM_PLATFORM",
    defaultValue: "pyref",
    allowed: ["pyref", "openmm"],
    summary: "`exp new` 不给 --platform 时的默认干实验平台",
    effect:
      "pyref 零依赖且确定性（deterministic=true）；openmm 需要装 openmm 且 CPU 上不逐位可复现（deterministic=false），下游结论会被要求按「区间对账」措辞。",
  },
  {
    key: "dataDir",
    type: "string",
    envVar: "SPARK_RESEARCH_DATA_DIR",
    defaultValue: null,
    summary: "工作区根目录（默认 ~/.spark-research）",
    effect:
      "一切持久化的根：projects/、credentials.json、config.json 全在它下面。改了等于换一套工作区，旧项目不会自动迁移。只能用环境变量设，不能写进 config.json（先有目录才有文件）。",
  },
  {
    key: "originAllowlist",
    type: "string",
    envVar: "SPARK_RESEARCH_ORIGIN_ALLOWLIST",
    defaultValue: null,
    summary: "HTTP 服务器额外信任的 Origin 主机名（逗号分隔）；本地 localhost/127.0.0.1（任意端口）恒信任，无需在此列出",
    effect:
      "D-7：写请求（POST/PUT/PATCH/DELETE）若带 Origin header，只有 localhost/127.0.0.1 或这里列出的主机名会被接受，其余一律 403——挡的是浏览器打开恶意网页后对本机 API 发起的跨站写请求。缺 Origin 的请求（CLI / MCP 进程内调用）不受此项影响，恒放行；只有真正要把服务暴露给别的可信前端域名时才需要配置它。",
  },
  {
    key: "httpTimeoutMs",
    type: "number",
    envVar: "SPARK_HTTP_TIMEOUT_MS",
    defaultValue: 30_000,
    summary: "单次 connector HTTP 请求的超时上限（毫秒）",
    effect:
      "超时后该次请求抛 HttpTimeoutError（与「上游返回 4xx/5xx」是两种不同的失败）。调小会让冷启动慢的源更容易被判超时；调大则一个挂起的上游能拖住整条跨源检索更久。",
  },
  {
    key: "llmTimeoutMs",
    type: "number",
    envVar: "SPARK_LLM_TIMEOUT_MS",
    defaultValue: 120_000,
    summary: "单次 LLM 调用的超时上限（毫秒）",
    effect:
      "超时按可见失败处理（`ok:false`），不会被当成模型产出。调小会让长文本生成（综述草稿）更容易被掐；调大则一次卡住的模型调用能挂住整条 orchestrator 流程更久。",
  },
  {
    key: "kernelTimeoutMs",
    type: "number",
    envVar: "SPARK_KERNEL_TIMEOUT_MS",
    defaultValue: 120_000,
    summary: "单次 Python kernel execute 的超时上限（毫秒）",
    effect:
      "超时会杀掉并重建子进程（kernel 内的变量状态随之丢失）。跑长仿真时要调大，否则会在中途被杀。传 0 或负数显式关闭超时。",
  },
  {
    key: "taskTimeoutMs",
    type: "number",
    envVar: "SPARK_TASK_TIMEOUT_MS",
    defaultValue: 600_000,
    summary: "server 长任务整个生命周期的超时上限（毫秒）",
    effect:
      "**与 `mcpTimeoutMs` 是两回事，且必须一起调**：后者是 MCP 等待多久改走句柄，这里是任务本身多久被判超时失败。只调 mcpTimeoutMs 的话，任务仍会在这里被掐掉（v0.2.1 × P10 的语义漂移就是这么来的）。",
  },
  {
    key: "mcpTimeoutMs",
    type: "number",
    envVar: "SPARK_RESEARCH_MCP_TIMEOUT_MS",
    defaultValue: 300_000,
    summary: "MCP 工具同步等待长任务的超时上限（毫秒）",
    effect:
      "超时后工具返回任务句柄而不是结果，外部 agent 需要改用 `task_status` 轮询。调小会让综述/novelty 这类分钟级任务经常走句柄路径。",
  },
  {
    key: "KIMI_API_KEY",
    type: "string",
    envVar: "KIMI_API_KEY",
    defaultValue: null,
    summary: "Kimi（Moonshot）API key",
    effect: "缺了 kimi 系模型不可用。值永不打印，也永不进 prompt / 日志。",
    secret: true,
  },
  {
    key: "OPENROUTER_API_KEY",
    type: "string",
    envVar: "OPENROUTER_API_KEY",
    defaultValue: null,
    summary: "OpenRouter API key（默认模型走这条路）",
    effect: "缺了默认模型不可用，所有需要模型的能力降级为不可用而不是静默出错。",
    secret: true,
  },
  // R-c-3：以下五项是 R-a（P11-a）留给本 lane 的收口缺口——docs/devlog/P11-a.md
  // 「遗留给后续 lane / 阶段的缺口」第 1 条：这些环境变量在 router.ts 里已经真的
  // 被读取（`ADAPTERS`/本地端点前缀路由），但没进这张表，`spark-research config`
  // 系列命令看不到它们、`config get/set` 用不了，`capabilities --json` 的
  // config 段也不会列出——本次一并补上。
  {
    key: "OPENAI_API_KEY",
    type: "string",
    envVar: "OPENAI_API_KEY",
    defaultValue: null,
    summary: "OpenAI API key",
    effect:
      "缺了 openai 系模型（gpt-4o / gpt-4o-mini / o4-mini 等）不可用。值永不打印，也永不进 prompt / 日志。" +
      "只认环境变量：与 KIMI_API_KEY/OPENROUTER_API_KEY 同样是 secret 项，router.ts 直接读 process.env，" +
      "不经过 config.json → env 的桥接（凭据永不进 env，见 applyConfigEnvDefaults 的 AD-2 纪律），" +
      "所以写进 config.json 只会让 `config list` 显示「已设置」，真正生效仍需 `export OPENAI_API_KEY=...`。",
    secret: true,
  },
  {
    key: "ANTHROPIC_API_KEY",
    type: "string",
    envVar: "ANTHROPIC_API_KEY",
    defaultValue: null,
    summary: "Anthropic API key",
    effect:
      "缺了 claude-* 系模型不可用。Anthropic 走原生 Messages API（不是 OpenAI 兼容形状），" +
      "适配器见 backend/src/llm/providers/anthropic.ts。值永不打印，也永不进 prompt / 日志。" +
      "同 OPENAI_API_KEY：只认环境变量，config.json 里的值不会被 router.ts 读取。",
    secret: true,
  },
  {
    key: "DEEPSEEK_API_KEY",
    type: "string",
    envVar: "DEEPSEEK_API_KEY",
    defaultValue: null,
    summary: "DeepSeek API key",
    effect:
      "缺了 deepseek 系模型（deepseek-chat / deepseek-reasoner 等）不可用。值永不打印，也永不进 prompt / 日志。" +
      "同 OPENAI_API_KEY：只认环境变量，config.json 里的值不会被 router.ts 读取。",
    secret: true,
  },
  {
    key: "QWEN_API_KEY",
    type: "string",
    envVar: "QWEN_API_KEY",
    defaultValue: null,
    summary: "Qwen（阿里云 DashScope / Model Studio）API key",
    effect:
      "缺了 qwen 系模型（qwen-max 等）不可用。值永不打印，也永不进 prompt / 日志。" +
      "同 OPENAI_API_KEY：只认环境变量，config.json 里的值不会被 router.ts 读取。" +
      "router.ts 目前硬编码中国大陆网关 baseUrl（dashscope.aliyuncs.com），国际网关" +
      "（dashscope-intl.aliyuncs.com）不可切换——这项只管 key，不管网关，如实记录这个已知缺口。",
    secret: true,
  },
  {
    key: "SPARK_LOCAL_LLM_BASE_URL",
    type: "string",
    envVar: "SPARK_LOCAL_LLM_BASE_URL",
    defaultValue: null,
    summary: "本地/自建 OpenAI 兼容 LLM 端点的 baseUrl（ollama / vLLM / 任意自建服务）",
    effect:
      "配了之后模型名形如 `local/<真实模型名>` 或 `local:<真实模型名>` 会被显式路由到这个 baseUrl，" +
      "剥掉前缀后的名字才是发给本地服务器的 `model` 字段。**不参与「没配 key 就退到任一已配置云端 " +
      "provider」的隐式回退**——本地端点是显式 opt-in，没配这项时请求 `local/...` 会得到可见的" +
      "「没配 SPARK_LOCAL_LLM_BASE_URL」失败，不会静默打到别的已配置 provider。非 secret：" +
      "本地端点用的服务器地址通常不敏感，且需要 applyConfigEnvDefaults 桥接才能靠 config.json 生效" +
      "（secret 项永远不桥接），所以这项特意不标 secret，写进 config.json 就能用，不必手动 export。",
  },
  {
    key: "SPARK_LOCAL_LLM_API_KEY",
    type: "string",
    envVar: "SPARK_LOCAL_LLM_API_KEY",
    defaultValue: null,
    summary: "本地/自建 LLM 端点的 API key（很多本地服务不校验，允许留空）",
    effect:
      "允许为空——为空时不发 Authorization 头（不是发一个空 Bearer），很多本地服务本来就不校验凭据。" +
      "标 secret 是因为**万一**自建服务确实配了鉴权，这个值也不该被打印；不同于 " +
      "SPARK_LOCAL_LLM_BASE_URL，它只认环境变量，config.json 里的值不会被桥接生效。",
    secret: true,
  },
  {
    key: "llmPricingOverridesJson",
    type: "string",
    envVar: "SPARK_LLM_PRICING_JSON",
    defaultValue: null,
    summary: "覆盖 llm/providers/registry.ts 内置单价表的 JSON（`{\"<provider>:<model>\": {inputPerMillionUsd, outputPerMillionUsd}}`）",
    effect:
      "影响 BudgetLedger.record() 给一次调用估算的 costUsd。内置单价表有核实日期但定价会变，" +
      "长期漂移应该靠这里覆盖而不是等下一次改代码。格式错误（不是合法 JSON，或某一项缺" +
      "input/output 数字）时整个覆盖被忽略、退回内置表——不会部分生效，也不会让 costUsd 变成" +
      "一个基于半解析数据算出的可疑数字。",
  },
];

export function settingSpec(key: string): SettingSpec | undefined {
  return CONFIG_SETTINGS.find((s) => s.key === key);
}

export type UserConfig = Record<string, string | number | undefined>;

export interface ConfigOptions {
  // 工作区根目录（测试注入 mkdtemp）。未给则 env SPARK_RESEARCH_DATA_DIR → ~/.spark-research。
  root?: string;
  env?: Record<string, string | undefined>;
  // 权限告警出口，默认 console.warn；注入便于单测断言（与 CredentialStore 同口径）。
  warn?: (message: string) => void;
}

export function dataDir(options: ConfigOptions = {}): string {
  if (options.root) return options.root;
  const env = options.env ?? process.env;
  return env.SPARK_RESEARCH_DATA_DIR ?? join(homedir(), ".spark-research");
}

export function configPath(options: ConfigOptions = {}): string {
  return join(dataDir(options), CONFIG_FILE);
}

export interface ConfigFilePermission {
  ok: boolean;
  mode: string;
  path: string;
  warning?: string;
}

// 文件权限体检：宽于 0600 时告警（不阻断，读侧只报告不强改——避免在只读文件系统上
// 把用户锁在门外）。判定逻辑与 daemon/credentials.ts 的 checkPermissions 同口径。
export function checkConfigPermissions(options: ConfigOptions = {}): ConfigFilePermission {
  const path = configPath(options);
  if (!existsSync(path)) return { ok: true, mode: "-", path };
  const mode = statSync(path).mode & 0o777;
  const modeStr = mode.toString(8).padStart(3, "0");
  if ((mode & 0o077) === 0) return { ok: true, mode: modeStr, path };
  return {
    ok: false,
    mode: modeStr,
    path,
    warning: `配置文件权限过宽（${modeStr}）：${path}，其中可能含 LLM API key，请执行 chmod 600 收紧`,
  };
}

// 启动时权限自检：发现过宽立即收紧到 0600，并把「发现时」的状态报告给调用方去告警。
// （collectConfigPermissions 里的 chmod 只在文件已经落盘的前提下生效；新建文件走
// saveConfig 那条路径，创建时就是 0600，不会走到这里。）
export function enforceConfigPermissions(options: ConfigOptions = {}): ConfigFilePermission {
  const result = checkConfigPermissions(options);
  if (!result.ok) chmodSync(result.path, CONFIG_FILE_MODE);
  return result;
}

export function loadConfig(options: ConfigOptions = {}): UserConfig {
  const path = configPath(options);
  if (!existsSync(path)) return {};
  const perm = enforceConfigPermissions(options);
  if (!perm.ok && perm.warning) (options.warn ?? ((m: string) => console.warn(m)))(perm.warning);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as UserConfig;
  } catch {
    // 配置文件坏了不该让整个 CLI 起不来；但也不能静默——由调用方（config CLI）报告。
    return {};
  }
}

export function saveConfig(config: UserConfig, options: ConfigOptions = {}): string {
  const dir = dataDir(options);
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  const path = configPath(options);
  // writeFileSync 的 mode 只在创建新文件时生效；已存在的文件（例如从 0644 升级而来）
  // 要显式 chmod 才会真的被收紧——这是 D-6 里最容易漏的一条路径。
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: CONFIG_FILE_MODE });
  chmodSync(path, CONFIG_FILE_MODE);
  return path;
}

export type SettingSource = "env" | "config" | "default" | "unset";

export interface ResolvedSetting {
  key: string;
  value: string | number | null;
  source: SettingSource;
  spec: SettingSpec;
  // secret 为真时 value 恒为 null，只看 configured。
  configured: boolean;
}

// 单个设置的解析：env > config.json > 默认值。
export function resolveSetting(key: string, options: ConfigOptions = {}): ResolvedSetting {
  const spec = settingSpec(key);
  if (!spec) throw new Error(`未知配置项 '${key}'（可用：${CONFIG_SETTINGS.map((s) => s.key).join(", ")}）`);
  const env = options.env ?? process.env;
  const config = loadConfig(options);

  const envRaw = spec.envVar ? env[spec.envVar] : undefined;
  const configRaw = config[spec.key];

  let source: SettingSource;
  let raw: string | number | undefined;
  if (envRaw !== undefined && envRaw !== "") {
    source = "env";
    raw = envRaw;
  } else if (configRaw !== undefined && configRaw !== "") {
    source = "config";
    raw = configRaw;
  } else if (spec.defaultValue !== null) {
    source = "default";
    raw = spec.defaultValue;
  } else {
    source = "unset";
    raw = undefined;
  }

  const configured = source === "env" || source === "config";
  if (spec.secret) {
    return { key, value: null, source, spec, configured };
  }
  const value =
    raw === undefined ? null : spec.type === "number" ? Number(raw) : String(raw);
  return { key, value, source, spec, configured };
}

export function resolveAll(options: ConfigOptions = {}): ResolvedSetting[] {
  return CONFIG_SETTINGS.map((spec) => resolveSetting(spec.key, options));
}

// ── 下游取值的窄口 ──────────────────────────────────────────────────────────
//
// 各模块的 `DEFAULT_*` 常量保持不变（它们是「代码层默认」），
// 这里给的是「用户层默认」：只在调用方本来要落到常量默认的位置替换。
// 这样注入了显式值的测试与调用路径行为完全不变。

function stringOr(key: string, fallback: string, options: ConfigOptions): string {
  const resolved = resolveSetting(key, options);
  return typeof resolved.value === "string" && resolved.value !== "" ? resolved.value : fallback;
}

export function configuredModel(fallback: string, options: ConfigOptions = {}): string {
  return stringOr("defaultModel", fallback, options);
}

export function configuredWetBackend(fallback: string, options: ConfigOptions = {}): string {
  return stringOr("wetBackend", fallback, options);
}

export function configuredSimulationPlatform(fallback: string, options: ConfigOptions = {}): string {
  return stringOr("simulationPlatform", fallback, options);
}

export function configuredMcpTimeoutMs(fallback: number, options: ConfigOptions = {}): number {
  const resolved = resolveSetting("mcpTimeoutMs", options);
  const value = typeof resolved.value === "number" ? resolved.value : Number(resolved.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function configuredHttpTimeoutMs(fallback: number, options: ConfigOptions = {}): number {
  const resolved = resolveSetting("httpTimeoutMs", options);
  const value = typeof resolved.value === "number" ? resolved.value : Number(resolved.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function configuredLlmTimeoutMs(fallback: number, options: ConfigOptions = {}): number {
  const resolved = resolveSetting("llmTimeoutMs", options);
  const value = typeof resolved.value === "number" ? resolved.value : Number(resolved.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function configuredKernelTimeoutMs(fallback: number, options: ConfigOptions = {}): number {
  const resolved = resolveSetting("kernelTimeoutMs", options);
  const value = typeof resolved.value === "number" ? resolved.value : Number(resolved.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function configuredTaskTimeoutMs(fallback: number, options: ConfigOptions = {}): number {
  const resolved = resolveSetting("taskTimeoutMs", options);
  const value = typeof resolved.value === "number" ? resolved.value : Number(resolved.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}


// 礼貌头是唯一「配置必须变成 env」的地方：politeness.ts 从 v0.2 起就只读 env，
// 而 connector 层在很多路径上拿不到 config 句柄。做法是**进程启动时把 config 的值
// 补进 env（已有 env 则不动）**——一次性、显式、优先级不变。
// 凭据不走这条路：secret 永远不进 env（AD-2）。
export function applyConfigEnvDefaults(options: ConfigOptions = {}): string[] {
  const env = options.env ?? process.env;
  const config = loadConfig(options);
  const applied: string[] = [];
  for (const spec of CONFIG_SETTINGS) {
    if (spec.secret || !spec.envVar) continue;
    if (spec.key === "dataDir") continue; // 先有目录才有文件，倒过来设没有意义
    const current = env[spec.envVar];
    if (current !== undefined && current !== "") continue;
    const value = config[spec.key];
    if (value === undefined || value === "") continue;
    env[spec.envVar] = String(value);
    applied.push(spec.envVar);
  }
  return applied;
}
