import type { McpToolRunner } from "../mcp/server";
import { MCP_TOOLS, MCP_WITHHELD } from "../mcp/tools";
import { BudgetLedger, type BudgetLimitKind, type BudgetSnapshot } from "../llm/budget";
import { redactSecrets, type ToolSpec } from "../llm/types";

// P12 · `AgentToolBus`（v0.4 方案 §4.2；波次调度 W1-a）。
//
// 定位：**不重实现业务逻辑**。P9 的 `McpToolRunner` 已经是「进程内统一工具总线」——
// 每个工具就是对 P7 HTTP app 的一次 `app.fetch()`，CLI / HTTP / UI / MCP 四个入口共享
// 同一套 service 层。`AgentToolBus` 只在它外面套三层，专门服务「子代理」这一类新调用方：
//   ① 授权（grants 白名单，AD-2 的第一个真正消费方）
//   ② 预算（`BudgetLedger`，R-c 交付，本层是它的第一个生产消费方）
//   ③ 审计（每次调用落一条记录，参数摘要脱敏）
// 加上一条贯穿三层之外的硬线：`MCP_WITHHELD` 的危险动作在这一层**同样**拒绝——
// AD-14「子代理永不自批准」不能靠调用方自觉，必须是总线自己钉死、无例外。

/** 未授权 / 被扣留 / 预算超限——三种拒绝原因，调用方（LLM 或子代理循环）据此改道。 */
export type ToolDenialReason = "not_granted" | "withheld" | "budget_exceeded";

/**
 * 结构化拒绝：**不抛异常**。模型看到的是一个它能读懂、能据此改道的对象，
 * 而不是一段异常堆栈——异常堆栈只有人能读，模型读到的是「工具调用失败」的噪音。
 */
export interface ToolDenial {
  ok: false;
  denied: ToolDenialReason;
  message: string;
  /** `denied === "not_granted"` 时：当前会话实际被授权的工具名单，模型可以据此改道。 */
  granted?: string[];
  /** `denied === "withheld"` 时：直接透传 `MCP_WITHHELD` 里的理由——两张表不能漂移。 */
  reason?: string;
  /** `denied === "withheld"` 时：人该怎么做。 */
  humanAction?: string;
  /** `denied === "budget_exceeded"` 时：确定超限的维度。 */
  exceeded?: BudgetLimitKind[];
  /** `denied === "budget_exceeded"` 时：完整快照，供调用方决定要不要请求加预算。 */
  snapshot?: BudgetSnapshot;
}

/** 工具真的执行了（无论成功失败）——与 `ToolDenial` 的区分点就是有没有 `denied` 字段。 */
export interface ToolExecuted {
  ok: boolean;
  payload: unknown;
}

/**
 * `denied` 字段是「被拒绝」与「执行失败」的唯一分界：`ToolDenial.ok` 恒为 `false`，
 * 但 `ToolExecuted.ok` 也可能是 `false`（工具真的跑了，但上游 4xx/5xx）。
 * 调用方要分辨这两种情况，判 `"denied" in outcome`（见 `isDenied`），不要只看 `ok`。
 */
export type ToolOutcome = ToolDenial | ToolExecuted;

export function isDenied(outcome: ToolOutcome): outcome is ToolDenial {
  return (outcome as ToolDenial).denied !== undefined;
}

/** 一次工具调用的审计记录。参数摘要过 `redactSecrets`，绝不落凭据。 */
export interface ToolAuditEntry {
  tool: string;
  /** 参数的脱敏摘要（JSON 字符串，过长截断）——不是完整参数原样落盘。 */
  argsSummary: string;
  ok: boolean;
  /** 被拒绝时的原因；正常执行（无论成败）时为 `undefined`。 */
  denied?: ToolDenialReason;
  durationMs: number;
  /** 结果体的近似大小（JSON 字符串长度）；被拒绝时恒为 0（没有结果体）。 */
  resultSize: number;
  timestamp: number;
}

/**
 * 一次工具调用向 `BudgetLedger` 上报的"消费量"。
 *
 * **可扩展的计价维度**（v0.4 方案 §4.2 第 6 条，2026-09-10 补的接口预留）：
 * `unit` 现在只有一个值 `"call"`——所有工具调用都只按「发生了一次」计数，
 * `costUsd` 恒为 `null`（诚实：我们确实不知道一次工具调用值多少钱，不当 0 处理）。
 *
 * v0.5 的远端算力会是 ToolBus 的下一类消费者：提交一个 Modal GPU 任务是**计费型
 * 后果动作**，那时候需要给特定工具算出一个真实 `costUsd`（例如按 GPU 秒计价）。
 * 这个类型就是那个口子——将来只需要扩 `unit` 的可能取值（如 `"computeSeconds"`）、
 * 让 `costOf()` 对那些工具名返回真实数字，`AgentToolBus` 的其余部分、`call()` 的
 * 签名、`BudgetLedger` 的记账路径都不需要改。**本 lane 只留接口，不写 v0.5 的实现**——
 * 所以 `costOf()` 目前对所有工具都返回同一个「未知/不计费」的值。
 */
export type ToolCostUnit = "call" | "computeSeconds";

export interface ToolCallCost {
  unit: ToolCostUnit;
  costUsd: number | null;
}

/** compute_* 工具的前缀。见下面 `costOf()` 的注释：它们在这一层**恒不计价**。 */
export const COMPUTE_TOOL_PREFIX = "compute_";

// 唯一实现：所有工具调用都不在这一层计价，`costUsd` 恒为 null。
//
// ── v0.5 W5-2 β：为什么算力工具**也**返回 null（这是设计，不是没做完）──────────
//
// v0.4 留下这个口子时写的是「v0.5 要接算力成本时，在这里按 name 分支返回真实 costUsd」。
// 真接的时候结论反过来了：**agent 经 MCP 拿不到任何一个会花钱的算力动作**——
// `compute_approve` / `compute_run` / `compute_release` 全在 MCP_WITHHELD 里（AD-14），
// 暴露出去的四个（plan / status / list / collect）没有一个会产生账单。
// 所以在 ToolBus 这一层给 compute_* 编一个 costUsd 出来，编的一定是个假数字：
// 计划的 `estimate.upperBoundUsd` 是**上界**不是花费，而真实花费要等 harvest 之后才知道。
//
// 真实花费的记账位置是 `ComputeBroker.collect()`：拿到 harvest 的 wallSeconds 之后
// `deps.budget.record({ inputTokens:0, outputTokens:0, costUsd: 实际值|null })`——
// 那里才有「跑了多少秒 × 单价」这两个数，查不到单价就是 null（**绝不当 0**）。
//
// `unit` 仍然扩成了 `"call" | "computeSeconds"`：类型口子留着，因为 broker 侧记的
// 确实是计算秒这一维；将来若有「agent 直接触发的计费工具」（今天一个都没有），
// 在这里按 name 分支返回 `{ unit: "computeSeconds", costUsd }` 即可，签名不用动。
function costOf(name: string, _args: Record<string, unknown>): ToolCallCost {
  if (name.startsWith(COMPUTE_TOOL_PREFIX)) {
    // 显式写出来而不是靠 fallthrough：这一条是**被断言钉住的设计决定**
    // （tests/unit/toolbus.test.ts），不是「还没实现」。
    return { unit: "call", costUsd: null };
  }
  return { unit: "call", costUsd: null };
}

export interface ToolBusOptions {
  /** P9 已有的进程内工具运行器；本层不重造它。 */
  runner: McpToolRunner;
  /** 白名单工具名——permit set 的第一个真正消费方（AD-2 兑现）。 */
  grants: string[];
  /** R-c 交付的预算账本；本层是它的第一个生产消费方。 */
  budget: BudgetLedger;
  /** 每次调用落一条审计记录（谁调的 / 参数摘要 / 耗时 / 结果规模 / 是否被拒）。 */
  audit: (entry: ToolAuditEntry) => void;
  /** 单次调用的硬超时（毫秒）。 */
  timeoutMs: number;
  /**
   * 收口(W5-3)：外部 MCP 工具的 spec（`ExternalToolRegistry.specs()` 的产物）。
   *
   * **为什么必须有这个**：W5-3 γ 把外部 MCP 的运行时接线做通了——工具能执行、
   * 每次调用都进证据图。但它自己戳破了一件事：`specs()` 原本只返回
   * `MCP_TOOLS.filter(...)` 一张固定表，**`mcp:` 前缀的外部工具永远进不了
   * 模型可见的工具列表**。γ 的原话：「我的测试用 mock LLM 直接发出工具名，
   * 证明的是『发出来就能执行』，不是『模型会发出来』——**真实模型不会自己想到
   * 调一个它从没被告知存在的工具**。」
   *
   * 没有这一项，「agent 能自主使用外部 MCP 工具」就是一句谎话。
   * `ExternalToolRegistry.specs()`（`extensions/mcp_client.ts:573`）从 W4-d 起就
   * 带着注释「供收口拼进喂给模型的 tools 列表」等在那里——等了两个波次。
   *
   * 不给或给空数组 = 与接线前逐字节同行为（没装外部扩展的用户不受影响）。
   */
  externalSpecs?: ToolSpec[];
}

const MAX_ARGS_SUMMARY_LEN = 500;

function summarizeArgs(args: Record<string, unknown>): string {
  let raw: string;
  try {
    raw = JSON.stringify(args) ?? "{}";
  } catch {
    raw = "[unserializable args]";
  }
  // 复用 llm/types.ts 的 redactSecrets——不重写一遍脱敏规则，两处规则漂移比没有更危险。
  const redacted = redactSecrets(raw);
  return redacted.length > MAX_ARGS_SUMMARY_LEN
    ? `${redacted.slice(0, MAX_ARGS_SUMMARY_LEN)}…(truncated)`
    : redacted;
}

function resultSizeOf(outcome: ToolOutcome): number {
  if (isDenied(outcome)) return 0; // 被拒绝时压根没有结果体。
  try {
    return JSON.stringify(outcome.payload)?.length ?? 0;
  } catch {
    return 0;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`工具 '${toolName}' 调用超时（>${timeoutMs}ms）`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class AgentToolBus {
  constructor(private readonly options: ToolBusOptions) {}

  /**
   * 给 LLM 的 tools 定义，与 `MCP_TOOLS` **同源**（不另写一份）——只过滤到当前会话
   * 被授权的子集。`MCP_WITHHELD` 里的危险动作本来就不在 `MCP_TOOLS` 里，所以这里
   * 天然不会把它们喂给模型；即便 `grants` 里误配了一个危险动作名，`call()` 的
   * 硬线检查也会在执行时挡下来（见类上的大段注释）。
   */
  specs(): ToolSpec[] {
    const granted = new Set(this.options.grants);
    // 收口(W5-3)：内建工具（同源于 MCP_TOOLS）+ 外部 MCP 工具（已授权的那些）。
    // 外部工具**同样过 grants 白名单**——接线不等于放开授权，`call()` 的硬线检查照旧。
    const external = (this.options.externalSpecs ?? []).filter((spec) => granted.has(spec.name));
    return MCP_TOOLS.filter((tool) => granted.has(tool.name)).map((tool) => ({
      name: tool.name,
      description: tool.description,
      // JsonSchema（mcp/tools.ts）与 ToolSpec.inputSchema（llm/types.ts）形状一致
      // （都是手写 JSON Schema），只是后者用 index signature 放宽了类型——同源数据，
      // 这里只是换一层类型外套，不是重新定义 schema。
      inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    })).concat(external);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const startedAt = Date.now();
    const argsSummary = summarizeArgs(args);

    const emit = (outcome: ToolOutcome): ToolOutcome => {
      this.options.audit({
        tool: name,
        argsSummary,
        ok: outcome.ok,
        denied: isDenied(outcome) ? outcome.denied : undefined,
        durationMs: Date.now() - startedAt,
        resultSize: resultSizeOf(outcome),
        timestamp: startedAt,
      });
      return outcome;
    };

    // 硬规则一（AD-14，最高优先级、无条件）：`MCP_WITHHELD` 直接复用，不重写一张
    // 危险动作表——两张表迟早漂移。即便 `grants` 里误配了这个名字也照样拒绝：
    // 子代理永远不能自批准，这条线不允许被"授权配置错误"绕过。
    const withheld = MCP_WITHHELD.find((w) => w.name === name);
    if (withheld) {
      return emit({
        ok: false,
        denied: "withheld",
        message: `工具 '${name}' 是扣留动作，ToolBus 不对子代理开放`,
        reason: withheld.reason,
        humanAction: withheld.humanAction,
      });
    }

    // 硬规则二（AD-2）：白名单授权。结构化拒绝，不抛异常——模型要能读懂并改道。
    if (!this.options.grants.includes(name)) {
      return emit({
        ok: false,
        denied: "not_granted",
        message: `工具 '${name}' 不在本次授权清单内`,
        granted: [...this.options.grants],
      });
    }

    // 硬规则三（预算）：调用前先看"已经超没超"，而不是"这次调用会不会导致超"——
    // 后者需要预估这次调用的成本，我们做不到；前者是可判定的，且刚好覆盖需求：
    // 已经超限时，后续调用无论大小都不该再放行。
    // 副作用（如实、不掩盖）：`BudgetLedger.exceeded` 本身是"严格大于"判定
    // （见 budget.ts），对 `calls` 这类维度而言，恰好把计数推过上限的那一次调用
    // 会被放行（检查发生在它被记账之前），下一次才会被拒绝。ToolBus 不在这里发明
    // 一个更严格的"预判"逻辑去堵这个边界——那需要 ledger 支持"预览"接口，而
    // `BudgetLedger` 刻意设计成"观测组件，是否硬停由调用方决定"（见 budget.ts 的
    // `assertWithinLimits()` 注释），ToolBus 如实复用这个语义，见对抗测试
    // `tests/unit/toolbus.test.ts` 里"calls 维度的边界语义"一节。
    const before = this.options.budget.snapshot();
    if (before.exceeded.length > 0) {
      return emit({
        ok: false,
        denied: "budget_exceeded",
        message: "预算已超限，拒绝执行新的工具调用",
        exceeded: before.exceeded,
        snapshot: before,
      });
    }

    let executed: ToolExecuted;
    try {
      executed = await withTimeout(this.options.runner.call(name, args), this.options.timeoutMs, name);
    } catch (err) {
      executed = { ok: false, payload: { error: err instanceof Error ? err.message : String(err) } };
    }

    // 调用真的发生了（无论成败）才计入预算——被拒绝的调用没有消耗任何东西。
    const cost = costOf(name, args);
    this.options.budget.record({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: cost.costUsd,
      // 显式 false：让"未知成本"这件事本身被账本看到（`unknownCostCalls` 会 +1），
      // 而不是靠 usageUnavailable=true 把它悄悄吞掉——那样将来 costOf() 对某个工具
      // 开始返回真实数字时，不需要改这里的调用方式。
      usageUnavailable: false,
    });

    return emit(executed);
  }
}
