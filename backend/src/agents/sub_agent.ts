import { join } from "node:path";
import { LLMRouter, type CallOptions, type ChatMessage, type ToolCall, type Usage } from "../llm/router";
import { BudgetLedger } from "../llm/budget";
import {
  configuredModel,
  configuredSubAgentModel,
  type ConfigOptions,
  type SubAgentModelConfigType,
} from "../config";
import { MCP_WITHHELD } from "../mcp/tools";
import type { McpToolRunner } from "../mcp/server";
import { AgentToolBus, isDenied, type ToolAuditEntry, type ToolOutcome } from "./toolbus";
// V27：prompt 的编译期内嵌副本（见 ./prompts.ts）。
import { DEFAULT_PROMPT_DIR as PROMPT_DIR, readPromptText } from "./prompts";

// P12 · 子代理 tool loop（v0.4 方案 §4.2；波次调度 W2-a）。
//
// 上一版 sub_agent.ts（88 行）的真相：`llm.call` 里零工具——所谓「任务型子代理」
// 就是一次裸的模型调用，explore 不能检索、execute 不能跑代码。这是外部评审判定
// 「名实落差最大」的地方。本文件把它变成真的：`SubAgentSpec` + 真 tool loop
// （请求工具 → 受限并发执行 → 结果回灌 → 再调，直到无 tool call 或触预算/超时）。
//
// ── W1-a 留下的待决问题：DEFAULT_PERMISSIONS 怎么办 ──────────────────────────
//
// 旧表用的是 v0.1 时代的抽象能力名（"read_frames" / "python" / "compute_submit"），
// 跟 MCP_TOOLS 的工具名（"lit_search" / "exp_run"）不是一回事，W1-a 的 devlog 把
// 这个决定明确甩给了本 lane（两条路：①重写成 MCP 工具名 ②加一层翻译）。
//
// **选择①：直接重写成 MCP 工具名，不加翻译层。** 理由：
//   1. `AgentToolBus.grants: string[]` 字面上就是 MCP 工具名——翻译层只是在中间
//      插一张「抽象能力 → 工具名集合」的表，而 toolbus.ts 自己的注释已经说清楚
//      「两张表迟早漂移」（它为此直接复用 MCP_WITHHELD，不重写一份）。同样的纪律
//      用在这里：不新造一张会漂移的表。
//   2. v0.1 的抽象名（read_frames/python/compute_submit）在 P9 的 MCP 工具面之后
//      已经没有任何真实边界对应——继续留着只是维持一具僵尸词汇，没有第二个消费方。
//   3. 这正是 W1-a 的 devlog 自己指出的「更简单、更符合字面语义」的那条路。
// 代价（如实记录）：legacy `SubAgentConfig.permission` 字段的语义从「抽象能力标签」
// 静默变成「MCP 工具名」——但 grep 全仓库确认它在运行时零消费方（orchestrator.ts
// 只读 `.prompt`/`.model`/`.type`，从不读 `.permission`），是一次安全的原地改名。
// SUB_AGENT_DEFAULTS（见下）是唯一真源：legacy 的 `SubAgentFactory.create()` 与新的
// `buildSubAgentSpec()` 共享同一张表，grants/permission 不可能两处漂移。

export type SubAgentType = "explore" | "execute" | "review" | "lab" | "literature";

// ── 新 API：SubAgentSpec + 真 tool loop ─────────────────────────────────────

export interface SubAgentBudget {
  maxToolCalls: number;
  maxTokens: number;
  maxWallMs: number;
}

export interface SubAgentSpec {
  name: string;
  type: SubAgentType;
  /** 每类独立模型（DESIGN §5.4 的死字段，本 lane 是它第一个真消费方——真的传进 CallOptions.model）。 */
  model: string;
  /** agents/prompt/<type>.txt，不再内联在 TS 里。 */
  promptFile: string;
  /** ToolBus 白名单——即 MCP 工具名，见上面「待决问题」的决定。 */
  grants: string[];
  budget: SubAgentBudget;
  /** review = true，硬约束：grants 里出现非只读工具直接拒绝构造/运行，不静默剔除。 */
  readOnly: boolean;
}

export type SubAgentStopReason = "done" | "budget" | "timeout" | "denied" | "error";

export interface SubAgentResult {
  finalText: string;
  /** 本次运行发生过的全部工具调用审计记录（来自 AgentToolBus 的 audit 回调）。 */
  toolCalls: ToolAuditEntry[];
  usage: Usage;
  /** 必须如实回流：预算耗尽 ≠ 完成，宁可报「预算内没做完」，不假装完成。 */
  stopReason: SubAgentStopReason;
  /** 模型不支持 tool calling 时的显式降级标记——不许静默失败。 */
  degraded?: boolean;
  degradedReason?: string;
  /** stopReason === "error" 时的原始错误信息。 */
  error?: string;
}

export class SubAgentGrantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubAgentGrantViolationError";
  }
}

export interface SubAgentSpecOverrides {
  name?: string;
  model?: string;
  promptFile?: string;
  /** 给了就整体替换默认 grants（不是合并）——调用方要给出完整期望清单。 */
  grants?: string[];
  budget?: Partial<SubAgentBudget>;
  /**
   * V16：仅在没有显式传 `model` 时才会被用来解析 config 层的 per-type 模型覆盖
   * （`subAgentModel_<type>` → `defaultModel` → 代码常量）。测试注入 `{root, env}`
   * 走隔离配置；生产不传时读真实 `process.env` / `~/.spark-research/config.json`
   * ——与 `backend/src/lab/cli.ts` 的 `configuredWetBackend(DEFAULT_WET_BACKEND)`
   * 同一套约定：调用方给了显式值就不会走到这条读取路径。
   */
  configOptions?: ConfigOptions;
}

// ── 只读工具分类（review 的硬约束用它）───────────────────────────────────────
//
// 判据：mcp/tools.ts 里每个工具的 `request()` 固定用 GET 或 POST 之一（没有工具会
// 按参数在 GET/POST 之间切换，只会在多个 GET 路径之间切换）。GET = 只读，POST/PATCH
// 一律当作「可能有副作用」处理——即使个别 POST 语义上是只读查询（如 `lit_search`
// 用 POST 是因为查询体复杂，不是因为它会写东西），保守优先于精确：误伤好过误放。
// 这张表是手工维护的（与 ALLOWED_ORPHANS/SKILL_ENTRYPOINTS 同一套纪律），来源是
// 对 backend/src/mcp/tools.ts 里全部 `method: "GET"` 站点的一次性核对，见
// docs/devlog/W2-a.md。mcp/tools.ts 若新增/改动工具的 HTTP method，这张表要手工跟上——
// tests/unit/sub_agent.test.ts 里有一组交叉检查兜底（覆盖 review 默认 grants 与几个
// 已知写工具），但不是穷举式的运行时校验（避免用合成参数反复调用 29 个工具的 request()
// 带来的脆弱性）。
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "research_capabilities",
  "project_list",
  "lit_list",
  "lit_export",
  "idea_list",
  "exp_list",
  "lab_status",
  "records_timeline",
  "record_get",
  "conclusion_list",
  "conclusion_get",
  "report_export",
  "task_status",
]);

const WITHHELD_NAMES: ReadonlySet<string> = new Set(MCP_WITHHELD.map((w) => w.name));

/** AD-14 防线前移：grants 里出现扣留动作，在构造/运行期直接拒绝——不等 ToolBus 兜底。 */
function assertNoWithheldGrants(name: string, type: SubAgentType, grants: string[]): void {
  const bad = grants.filter((g) => WITHHELD_NAMES.has(g));
  if (bad.length > 0) {
    throw new SubAgentGrantViolationError(
      `子代理 '${name}'（type=${type}）的 grants 包含扣留动作：${bad.join(", ")}。` +
        `AD-14：子代理永不自批准。ToolBus 会拦这个（见 toolbus.ts 硬规则一），但把危险动作写进` +
        `grants 本身就是不该发生的配置错误信号，sub_agent.ts 在源头直接拒绝构造，不给它跑到运行期。`,
    );
  }
}

/** readOnly 硬约束：grants 里出现非只读工具，直接拒绝——不静默剔除（剔除会掩盖调用方的配置错误）。 */
function assertReadOnlyGrants(name: string, type: SubAgentType, readOnly: boolean, grants: string[]): void {
  if (!readOnly) return;
  const violations = grants.filter((g) => !READ_ONLY_TOOL_NAMES.has(g));
  if (violations.length > 0) {
    throw new SubAgentGrantViolationError(
      `子代理 '${name}'（type=${type}）声明 readOnly:true，但 grants 里包含非只读工具：` +
        `${violations.join(", ")}。readOnly 是硬约束，不是建议——一律拒绝构造/运行，不静默剔除。`,
    );
  }
}

// V27：原来是裸 `readFileSync(join(dir, filename))`——单二进制里 DEFAULT_PROMPT_DIR 是
// `/$bunfs/root/prompt`，五个子代理的 system prompt 全部读不到。readPromptText 保留
// "调用方传的 dir 优先"，只在读不到时落编译期内嵌副本（见 ./prompts.ts）。
function loadPromptFile(dir: string, filename: string): string | null {
  return readPromptText(dir, filename);
}

interface SubAgentDefaults {
  model: string;
  promptFile: string;
  grants: string[];
  budget: SubAgentBudget;
  readOnly: boolean;
}

// explore 的检索类工具集合——literature 在它基础上加写权限，避免两处各写一份检索清单。
const EXPLORE_GRANTS = ["lit_search", "lit_list", "lit_read_cards", "records_timeline", "record_get"];

// 单一真源：legacy `SubAgentFactory.create()` 与新 `buildSubAgentSpec()` 都从这张表派生，
// grants/prompt/model/budget/readOnly 不可能在两条路径上各自漂移一份。
//
// 预算数值的取舍（如实记录，不是精确调优过的常量）：
//   - lab 最小（6 次工具调用 / 3 万 token / 2 分钟墙钟）：lab_compile+lab_status 两个工具，
//     单轮往返足够，且 lab_approve/lab_simulate 本来就不在 grants 里（扣留动作）。
//   - execute 墙钟最长（5 分钟）：exp_run 可能触发较慢的计算任务。
//   - literature 工具调用与墙钟都比 explore 更宽（多了 lit_add/lit_export/lit_review_draft
//     三个写动作，一轮典型工作流比纯检索更长）。
//   - review 工具调用预算克制（8 次）：只读 5 个工具，一次评审不需要很多轮。
const SUB_AGENT_DEFAULTS: Record<SubAgentType, SubAgentDefaults> = {
  explore: {
    model: LLMRouter.DEFAULT_MODEL,
    promptFile: "explore.txt",
    grants: [...EXPLORE_GRANTS],
    budget: { maxToolCalls: 12, maxTokens: 60_000, maxWallMs: 180_000 },
    readOnly: false,
  },
  literature: {
    model: LLMRouter.DEFAULT_MODEL,
    promptFile: "literature.txt",
    grants: [...EXPLORE_GRANTS, "lit_add", "lit_export", "lit_review_draft"],
    budget: { maxToolCalls: 15, maxTokens: 80_000, maxWallMs: 240_000 },
    readOnly: false,
  },
  execute: {
    model: LLMRouter.DEFAULT_MODEL,
    promptFile: "execute.txt",
    grants: ["exp_design", "exp_run", "exp_list", "task_status"],
    budget: { maxToolCalls: 10, maxTokens: 60_000, maxWallMs: 300_000 },
    readOnly: false,
  },
  lab: {
    model: LLMRouter.DEFAULT_MODEL,
    promptFile: "lab.txt",
    // 刻意不给 lab_approve / lab_simulate——它们本来就在 MCP_WITHHELD 里，
    // 这里再次不列入只是让 grants 本身读起来就是「诚实的」，不依赖读者去翻 MCP_WITHHELD。
    grants: ["lab_compile", "lab_status"],
    budget: { maxToolCalls: 6, maxTokens: 30_000, maxWallMs: 120_000 },
    readOnly: false,
  },
  review: {
    model: LLMRouter.DEFAULT_MODEL,
    promptFile: "reviewer.txt",
    grants: ["record_get", "records_timeline", "conclusion_list", "conclusion_get", "report_export"],
    budget: { maxToolCalls: 8, maxTokens: 40_000, maxWallMs: 120_000 },
    readOnly: true,
  },
};

// V16：SUB_AGENT_DEFAULTS 的 key 集合是 `SubAgentType` 唯一的运行时体现（类型本身在
// 编译期就被擦除，config/index.ts 没法反向 import 这个文件去读它）。导出这份名字清单，
// 供 tests/unit/sub_agent.test.ts 与 config/index.ts 的 `SUB_AGENT_MODEL_CONFIG_TYPES`
// 做一次显式的集合相等断言——两张手写清单谁漏改另一边，测试立刻红（见 config/index.ts
// 里 V16 那段注释：这是「provider 那次没法做成派生」同一类问题的翻版）。
export const SUB_AGENT_TYPE_NAMES: readonly SubAgentType[] = Object.keys(
  SUB_AGENT_DEFAULTS,
) as SubAgentType[];

const DEFAULT_PROMPT_DIR = PROMPT_DIR;

// V16：单一真源——`buildSubAgentSpec()` 与 legacy 的 `SubAgentFactory.create()` 都
// 通过这一处解析「这个 type 该用哪个模型」，不各自手写一份解析链。
// 解析顺序：显式 override（调用方最清楚自己要什么）> config 的 per-type 覆盖
// （`subAgentModel_<type>`）> config 的全局默认模型（`defaultModel`）> 代码常量
// （defaults.model，目前恒为 LLMRouter.DEFAULT_MODEL）。
function resolveSubAgentModel(
  type: SubAgentType,
  overrideModel: string | undefined,
  configOptions: ConfigOptions | undefined,
): string {
  if (overrideModel) return overrideModel;
  const codeDefault = SUB_AGENT_DEFAULTS[type].model;
  const globalDefault = configuredModel(codeDefault, configOptions);
  return configuredSubAgentModel(type as SubAgentModelConfigType, globalDefault, configOptions);
}

/** 构造一个 SubAgentSpec。校验在这里就跑一遍——非法配置不该等到 runSubAgent() 才炸。 */
export function buildSubAgentSpec(
  type: SubAgentType,
  overrides: SubAgentSpecOverrides = {},
): SubAgentSpec {
  const defaults = SUB_AGENT_DEFAULTS[type];
  const name = overrides.name ?? type;
  const grants = overrides.grants ?? [...defaults.grants];
  const spec: SubAgentSpec = {
    name,
    type,
    model: resolveSubAgentModel(type, overrides.model, overrides.configOptions),
    promptFile: overrides.promptFile ?? defaults.promptFile,
    grants,
    budget: { ...defaults.budget, ...overrides.budget },
    // readOnly 只由 type 决定，不接受 overrides——否则调用方能靠
    // `{readOnly: false}` 绕开硬约束，"硬约束"就名不副实了。
    readOnly: defaults.readOnly,
  };
  assertNoWithheldGrants(spec.name, spec.type, spec.grants);
  assertReadOnlyGrants(spec.name, spec.type, spec.readOnly, spec.grants);
  return spec;
}

// ── tool loop 本体 ───────────────────────────────────────────────────────

/** 同一轮内多个 tool call 的受限并发度。导出供测试断言真的没有退化成串行执行。 */
export const SUB_AGENT_TOOL_CONCURRENCY = 3;

// 安全阀，独立于预算之外：即便预算配置得很宽松（或 usage 一直拿不到导致 token 维度
// 永远不超），也不允许无限循环下去。命中这个上限时 stopReason 报 "budget"（宁可报
// 「预算内没做完」，不假装完成）——它和真正的 ledger 超限是同一类事件，只是触发条件
// 不同（ledger 管"消耗了多少"，这个管"跑了多少轮"）。
const DEFAULT_MAX_ROUNDS = 64;

// 连续两轮「这一轮请求的全部工具调用都被拒绝」——模型显然卡在一个它结构性拿不到的
// 动作上（工具名不在 grants 里、或撞了 MCP_WITHHELD），继续烧预算陪它重试没有意义，
// 提前止损比等预算耗尽更诚实：stopReason 直接报 "denied"，而不是笼统的 "budget"。
const DENIED_ROUND_LIMIT = 2;

export interface SubAgentDeps {
  /** LLMRouter 的最小子集——测试用假实现注入这两个方法即可，不需要构造真 LLMRouter。 */
  llm: Pick<LLMRouter, "call" | "capabilitiesFor">;
  /** P9 的进程内工具运行器；本 lane 不重造它，只是每个子代理各自套一层 AgentToolBus。 */
  runner: McpToolRunner;
  /** 每次工具调用之外，额外想旁路审计记录时给一个 sink（可选）。 */
  auditSink?: (entry: ToolAuditEntry) => void;
  /**
   * 父预算账本（R-c 的 `BudgetLedger.child()`）。多子代理编排场景下，调用方把
   * 一个共享父账本传进来，本函数会派生两个子账本（工具调用 / token），花费向上汇总。
   * 不给就各自开一本新账（单子代理场景）。
   */
  parentBudget?: BudgetLedger;
  /** 单次工具调用的硬超时，转发给 AgentToolBus。默认 30s。 */
  toolTimeoutMs?: number;
  /** 墙钟时钟注入，默认 Date.now——测试用，不依赖真实时间流逝。 */
  now?: () => number;
  /** 安全阀轮数，默认 DEFAULT_MAX_ROUNDS。测试用小值来在合理时间内命中它。 */
  maxRounds?: number;
  /** prompt 文件目录，默认 agents/prompt/。测试用来注入临时目录。 */
  promptDir?: string;
}

function toolResultContent(outcome: ToolOutcome): string {
  try {
    return JSON.stringify(outcome);
  } catch {
    return JSON.stringify({ ok: outcome.ok, error: "[unserializable tool result]" });
  }
}

/** 一轮内的多个 tool call：受限并发执行，结果按原始顺序对齐回 calls 数组。 */
async function runToolCallsLimited(
  calls: ToolCall[],
  bus: AgentToolBus,
  limit: number,
): Promise<{ call: ToolCall; outcome: ToolOutcome }[]> {
  const results = new Array<{ call: ToolCall; outcome: ToolOutcome }>(calls.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= calls.length) return;
      const call = calls[i]!;
      const outcome = await bus.call(call.name, call.args);
      results[i] = { call, outcome };
    }
  }
  const workers = Array.from({ length: Math.min(limit, calls.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function checkBudgets(toolBudget: BudgetLedger, tokenBudget: BudgetLedger): "timeout" | "budget" | null {
  const exceeded = [...toolBudget.snapshot().exceeded, ...tokenBudget.snapshot().exceeded];
  if (exceeded.length === 0) return null;
  return exceeded.includes("wallMs") ? "timeout" : "budget";
}

function usageFromLedger(ledger: BudgetLedger, anyUsageUnavailable: boolean): Usage {
  const snap = ledger.snapshot();
  return {
    inputTokens: snap.inputTokens,
    outputTokens: snap.outputTokens,
    costUsd: snap.costUsd,
    usageUnavailable: anyUsageUnavailable,
  };
}

/**
 * 不支持 tool calling 的模型（`capabilitiesFor(model).toolCalling === false`，比如
 * 本地端点）——显式降级路径：禁用全部工具，只做单轮文本生成，并把降级事实写进
 * finalText（人读）与 degraded/degradedReason（程序读）两处。不许静默失败：
 * 调用方不传 tools 给 provider，provider 也就不会因为「不支持工具」报错，
 * 但如果不主动声明，结果看起来就像「这个子代理就是不会用工具」——那是撒谎。
 */
async function runDegraded(
  spec: SubAgentSpec,
  task: string,
  systemPrompt: string,
  deps: SubAgentDeps,
  tokenBudget: BudgetLedger,
): Promise<SubAgentResult> {
  const note =
    `[降级：模型 '${spec.model}' 不支持 tool calling（capabilitiesFor().toolCalling === false）。` +
    `本次子代理运行已禁用全部工具，仅做单轮文本生成——不能检索文献、不能跑实验、不能操作任何 MCP 工具。]`;
  const messages: ChatMessage[] = [
    { role: "system", content: `${systemPrompt}\n\n${note}` },
    { role: "user", content: task },
  ];
  const res = await deps.llm.call(messages, { model: spec.model });
  tokenBudget.record(res.usage, { provider: res.provider, model: res.model });
  const usage = usageFromLedger(tokenBudget, res.usage.usageUnavailable === true);

  if (!res.ok) {
    return {
      finalText: "",
      toolCalls: [],
      usage,
      stopReason: "error",
      degraded: true,
      degradedReason: note,
      error: res.error.message,
    };
  }
  return {
    finalText: `${note}\n\n${res.content}`,
    toolCalls: [],
    usage,
    stopReason: "done",
    degraded: true,
    degradedReason: note,
  };
}

/**
 * 真 tool loop：`llm.call(messages, {tools: bus.specs()})` → 有 toolCalls 就（受限并发）
 * 执行 → 结果以 role:"tool" 消息回灌 → 再调 → 直到无 tool call 或触预算/超时。
 *
 * stopReason 如实回流（见 SubAgentResult 上的注释）：这是本函数唯一不能妥协的契约。
 */
export async function runSubAgent(
  spec: SubAgentSpec,
  task: string,
  deps: SubAgentDeps,
): Promise<SubAgentResult> {
  // 防御性地再校验一遍：spec 可能是手工构造、绕过了 buildSubAgentSpec() 的调用方。
  // readOnly 是硬约束，不能只在构造期查一次就放心——运行期也要挡。
  assertNoWithheldGrants(spec.name, spec.type, spec.grants);
  assertReadOnlyGrants(spec.name, spec.type, spec.readOnly, spec.grants);

  const promptDir = deps.promptDir ?? DEFAULT_PROMPT_DIR;
  const systemPrompt = loadPromptFile(promptDir, spec.promptFile);
  if (systemPrompt === null) {
    throw new Error(`子代理 '${spec.name}' 的 prompt 文件不存在：${join(promptDir, spec.promptFile)}`);
  }

  const rootBudget = deps.parentBudget ?? new BudgetLedger({}, { now: deps.now });
  const toolBudget = rootBudget.child(
    { maxCalls: spec.budget.maxToolCalls, maxWallMs: spec.budget.maxWallMs },
    `${spec.name}.tools`,
  );
  const tokenBudget = rootBudget.child(
    { maxTotalTokens: spec.budget.maxTokens, maxWallMs: spec.budget.maxWallMs },
    `${spec.name}.tokens`,
  );

  const caps = deps.llm.capabilitiesFor(spec.model);
  if (caps && caps.toolCalling === false) {
    return runDegraded(spec, task, systemPrompt, deps, tokenBudget);
  }

  const auditLog: ToolAuditEntry[] = [];
  const bus = new AgentToolBus({
    runner: deps.runner,
    grants: spec.grants,
    budget: toolBudget,
    audit: (entry) => {
      auditLog.push(entry);
      deps.auditSink?.(entry);
    },
    timeoutMs: deps.toolTimeoutMs ?? 30_000,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task },
  ];

  let anyUsageUnavailable = false;
  let lastText = "";
  let deniedRounds = 0;
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;

  for (let round = 0; round < maxRounds; round++) {
    const preCheck = checkBudgets(toolBudget, tokenBudget);
    if (preCheck) {
      return {
        finalText: lastText,
        toolCalls: [...auditLog],
        usage: usageFromLedger(tokenBudget, anyUsageUnavailable),
        stopReason: preCheck,
      };
    }

    const options: CallOptions = { model: spec.model, tools: bus.specs() };
    const res = await deps.llm.call(messages, options);
    tokenBudget.record(res.usage, { provider: res.provider, model: res.model });
    if (res.usage.usageUnavailable) anyUsageUnavailable = true;

    if (!res.ok) {
      return {
        finalText: lastText,
        toolCalls: [...auditLog],
        usage: usageFromLedger(tokenBudget, anyUsageUnavailable),
        stopReason: "error",
        error: res.error.message,
      };
    }

    lastText = res.content;

    if (!res.toolCalls || res.toolCalls.length === 0) {
      return {
        finalText: res.content,
        toolCalls: [...auditLog],
        usage: usageFromLedger(tokenBudget, anyUsageUnavailable),
        stopReason: "done",
      };
    }

    // assistant 的这一轮回复（含 toolCalls）先入历史，再把每个 tool call 的结果
    // 以 role:"tool" 消息回灌——这是「结果必须回灌进下一轮 prompt」这条契约的落地处。
    messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });

    const executed = await runToolCallsLimited(res.toolCalls, bus, SUB_AGENT_TOOL_CONCURRENCY);
    let allDenied = true;
    for (const { call, outcome } of executed) {
      if (!isDenied(outcome)) allDenied = false;
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: toolResultContent(outcome),
      });
    }

    deniedRounds = allDenied ? deniedRounds + 1 : 0;
    if (deniedRounds >= DENIED_ROUND_LIMIT) {
      return {
        finalText: lastText,
        toolCalls: [...auditLog],
        usage: usageFromLedger(tokenBudget, anyUsageUnavailable),
        stopReason: "denied",
      };
    }

    const postCheck = checkBudgets(toolBudget, tokenBudget);
    if (postCheck) {
      return {
        finalText: lastText,
        toolCalls: [...auditLog],
        usage: usageFromLedger(tokenBudget, anyUsageUnavailable),
        stopReason: postCheck,
      };
    }
  }

  // 命中安全阀（见 DEFAULT_MAX_ROUNDS 上的注释）：宁可报「预算内没做完」，不假装完成。
  return {
    finalText: lastText,
    toolCalls: [...auditLog],
    usage: usageFromLedger(tokenBudget, anyUsageUnavailable),
    stopReason: "budget",
  };
}

/** 便捷入口：一步构造 spec 并跑——W3-a 的 replan 循环大概率只需要这一个函数。 */
export async function runSubAgentOfType(
  type: SubAgentType,
  task: string,
  deps: SubAgentDeps,
  overrides?: SubAgentSpecOverrides,
): Promise<SubAgentResult> {
  const spec = buildSubAgentSpec(type, overrides);
  return runSubAgent(spec, task, deps);
}

// ── legacy 兼容层：orchestrator.ts 现有的 `SubAgentFactory`/`SubAgentType` 消费方 ──
//
// orchestrator.ts（W3-a 的文件所有权，本 lane 不碰）目前的 "subagent" 任务分支还是
// 「裸 llm.call，零工具」的旧路径：`this.subAgents.create(type)` 拿到 `.prompt`/`.model`，
// 直接喂给 `llm.call`。接上面 `runSubAgent()` 的真 tool loop 是 W3-a 的活（它要动
// orchestrator.ts 才能把 "subagent" 任务分支换成真循环）。本 lane 只保证：
//   ① 这层旧接口继续编译、继续跑（不破坏 orchestrator.ts 的现有行为）；
//   ② 它的 prompt/grants 数据源换成跟新 API 同一张 SUB_AGENT_DEFAULTS 表——
//      等 W3-a 把 orchestrator.ts 接到 runSubAgent() 时，grants 已经是对的，
//      不需要再做一次「发现旧表是错的」的返工。

export interface SubAgentConfig {
  name: string;
  type: SubAgentType;
  model: string;
  prompt: string;
  /** 见文件顶部「待决问题」：现在是 MCP 工具名，不再是 v0.1 的抽象能力名。 */
  permission: string[];
}

export class SubAgent {
  readonly name: string;
  readonly type: SubAgentType;
  readonly model: string;
  readonly prompt: string;
  readonly permission: string[];

  constructor(config: SubAgentConfig) {
    this.name = config.name;
    this.type = config.type;
    this.model = config.model;
    this.prompt = config.prompt;
    this.permission = [...config.permission];
  }
}

export class SubAgentFactory {
  private promptDir: string;

  constructor(promptDir = DEFAULT_PROMPT_DIR) {
    this.promptDir = promptDir;
  }

  // `configOptions` 仅在 `overrides.model` 没给时用来解析 config 层的 per-type 覆盖
  // （见 resolveSubAgentModel）——加在第三个参数位置而不是塞进 SubAgentConfig，
  // 因为它不是 agent 的一个字段，只是"这次解析用哪个 env/config 源"的旁路开关。
  create(
    type: SubAgentType,
    overrides: Partial<Omit<SubAgentConfig, "type">> = {},
    configOptions?: ConfigOptions,
  ): SubAgent {
    const defaults = SUB_AGENT_DEFAULTS[type];
    const promptFile = defaults.promptFile;
    const loaded = loadPromptFile(this.promptDir, promptFile);
    if (loaded === null && overrides.prompt === undefined) {
      throw new Error(`子代理类型 '${type}' 的 prompt 文件不存在：${join(this.promptDir, promptFile)}`);
    }
    return new SubAgent({
      name: overrides.name ?? type,
      type,
      model: resolveSubAgentModel(type, overrides.model, configOptions),
      prompt: overrides.prompt ?? loaded ?? "",
      permission: overrides.permission ?? [...defaults.grants],
    });
  }
}
