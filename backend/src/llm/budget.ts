import type { ConfigOptions } from "../config";
import { priceFor } from "./providers/registry";
import type { CallOptions, ChatMessage, Usage } from "./types";

// R-c-1：预算账本。
//
// 定位（v0.3 方案 §4.2 已经画出消费方）：P12 的 `AgentToolBus`/`SubAgentSpec` 需要
// 「调用数 / 墙钟 / token 上限」（方案原文），P13 的帧级账本需要逐帧记账。
// 两者共同点是**一个预算句柄要能跨很多次调用传递而不丢状态**——不是「传参数进函数，
// 函数算完就扔」，而是调用方创建一次 `BudgetLedger`，之后每次 LLM 调用后 `record()`
// 一次，账本自己攒状态。设计成 class 而不是纯函数就是为了这个「句柄」语义。
//
// **铁律（与 R-a/接口先行一致）**：拿不到 usage（`usage.usageUnavailable`）或
// 拿不到单价（`priceFor` 返回 null）时，这一次调用的成本记作「未知」，
// **绝不当 0 处理**——0 会被下游误读成「这次真的免费」。账本的 `costUsd` 只要有
// 一次调用的成本未知，就**整体**报 `null`（诚实：我们说不出一个确定的总花费），
// 同时单独暴露 `knownCostUsd`（已知部分的下界，用于判断「至少花了多少」）与
// `unknownCostCalls`（有几次调用的花费我们说不出来），让下游自己决定怎么用。

export interface BudgetLimits {
  maxCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  /** 墙钟耗时上限（毫秒），从账本创建那一刻起算（或注入的 `now()`）。 */
  maxWallMs?: number;
  /** 已知成本上限。未知成本的调用不会让这项被判定为"确定超"，见 `exceeded` 的注释。 */
  maxCostUsd?: number;
}

export type BudgetLimitKind = "calls" | "inputTokens" | "outputTokens" | "totalTokens" | "wallMs" | "costUsd";

export interface BudgetSnapshot {
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  wallMs: number;
  /** 已知成本之和（只加能定价的调用）——是真实总花费的**下界**，不是全部。 */
  knownCostUsd: number;
  /** 有多少次 record() 说不出这次花了多少钱（usage 拿不到，或 usage 拿到了但查不到单价）。 */
  unknownCostCalls: number;
  /**
   * 只要 `unknownCostCalls > 0` 就是 `null`——不能诚实报出一个确定总数。
   * 全部调用都定了价时才等于 `knownCostUsd`。
   */
  costUsd: number | null;
  /**
   * V93（v0.8 G-3）：**在飞预留**——已过闸、尚未返回的调用按发前估价预留的金额之和。
   * 不计入 knownCostUsd（那是已结算的确定下界），但 `tryReserve()` 判「能不能再发一个」
   * 时用 `knownCostUsd + inFlightUsd + 估价`，这样 `Promise.all` 下 N 个在飞的合计不越闸。
   */
  inFlightUsd: number;
  inFlightCalls: number;
  limits: BudgetLimits;
  /**
   * 确定超限的维度。**`costUsd` 这一项的判定用 `knownCostUsd`（下界）而不是
   * `costUsd`**——即便存在未知花费的调用，只要已知部分就已经超过上限，那"总花费
   * ≥ 已知部分"这条逻辑推论是必然成立的，判定为超限不需要等未知部分也查清楚。
   * 反过来，`knownCostUsd` 没超但存在未知调用时，**不会**把 costUsd 计入 `exceeded`
   * ——那种情况下我们真的不知道有没有超，报"确定超"是撒谎，报"确定没超"也是撒谎，
   * 所以两者都不报，调用方想知道就去看 `unknownCostCalls`。
   */
  exceeded: BudgetLimitKind[];
}

export interface BudgetRecordOptions {
  /** 给了 provider+model 才能查单价表；只给其中一个不生效（当作没给）。 */
  provider?: string;
  model?: string;
}

export interface BudgetRecordResult {
  /** 这一次调用算出的成本；拿不到 usage 或单价时为 null。 */
  costUsd: number | null;
  /** 这一次调用的成本是否属于"未知"（对应 costUsd === null）。 */
  costUnavailable: boolean;
  /** 记完这一次之后的完整快照。 */
  snapshot: BudgetSnapshot;
  /** 这一次 record() **新增**变成超限的维度（记录之前没超、记录之后超了）。 */
  newlyExceeded: BudgetLimitKind[];
}

/**
 * V93：一次在飞预留的句柄。`settle()` 用真实 usage 结算（预留额释放、走 `record()`），
 * `release()` 用于调用抛异常/被取消时只释放不记账。两者都幂等，第二次调用无效。
 */
export interface BudgetReservation {
  readonly estimateUsd: number;
  settle(usage: Usage, options?: BudgetRecordOptions): BudgetRecordResult;
  release(): void;
  readonly settled: boolean;
}

/**
 * 发前估价（V93「按模型上限价预留」）：输入按字符数粗估 token（≈3 字符/token——对中英混排
 * 偏保守，宁多预留不少预留），输出按 `maxTokens`（没给就按 4096 这个各适配器的保守默认）。
 * 查不到单价返回 null——**不是 0**；调用方决定 null 怎么处理（G-4 之后默认拒绝未定价模型）。
 */
export function estimateCallCostUsd(
  messages: ChatMessage[],
  options: CallOptions,
  target: { provider: string; model: string; configOptions?: ConfigOptions },
): number | null {
  const price = priceFor(target.provider, target.model, target.configOptions ?? {});
  if (!price) return null;
  let chars = 0;
  for (const m of messages) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  const inputTokens = Math.ceil(chars / 3);
  const outputTokens = options.maxTokens ?? 4096;
  return (inputTokens / 1_000_000) * price.inputPerMillionUsd + (outputTokens / 1_000_000) * price.outputPerMillionUsd;
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly kind: BudgetLimitKind,
    public readonly snapshot: BudgetSnapshot,
  ) {
    super(`预算超限（${kind}）：${JSON.stringify(snapshot)}`);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetLedgerOptions {
  label?: string;
  /**
   * 父账本。给了之后每次 `record()` 会**同时**转发给父账本记一次——子账本与父账本
   * 各自独立计数（各自的 `snapshot()` 只反映自己直接 record 过的调用之和 + 子账本
   * 转发上来的调用），用于 P12「每个子代理有自己的预算，同时受一个全局上限约束」
   * 的场景：给每个子代理一个 `parentLedger.child(subLimits)`，子代理只看到自己的
   * 账本，但花费会汇总到父账本，父账本的 `maxCostUsd` 能拦住"每个子代理都没超，
   * 但加起来超了"的情况。
   */
  parent?: BudgetLedger;
  /** 单价表的 config 覆盖走这里注入（测试用；生产默认 `process.env`）。 */
  configOptions?: ConfigOptions;
  /** 墙钟时钟注入，默认 `Date.now`——测试用，不依赖真实时间流逝。 */
  now?: () => number;
}

export class BudgetLedger {
  readonly label: string;
  private readonly limits: BudgetLimits;
  private readonly parent?: BudgetLedger;
  private readonly configOptions: ConfigOptions;
  private readonly now: () => number;
  private readonly startedAtMs: number;

  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private knownCostUsd = 0;
  private unknownCostCalls = 0;
  private inFlightUsd = 0;
  private inFlightCalls = 0;

  constructor(limits: BudgetLimits = {}, options: BudgetLedgerOptions = {}) {
    this.label = options.label ?? "budget";
    this.limits = limits;
    this.parent = options.parent;
    this.configOptions = options.configOptions ?? {};
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  /**
   * 记一次 LLM 调用。`options.provider`+`options.model` 给了才会去查单价表；
   * 会**优先信任 `usage.costUsd`**（如果它已经非 null——例如某个 provider 未来
   * 直接从响应头里拿到了真实账单金额，那就不该被这里的估算覆盖），只有它是 null
   * 且给了 provider/model 时才用 `registry.priceFor` 估算。
   */
  record(usage: Usage, options: BudgetRecordOptions = {}): BudgetRecordResult {
    const before = this.snapshot();

    this.calls += 1;
    if (!usage.usageUnavailable) {
      this.inputTokens += usage.inputTokens;
      this.outputTokens += usage.outputTokens;
    }

    let costUsd: number | null = null;
    if (!usage.usageUnavailable) {
      if (usage.costUsd !== null && usage.costUsd !== undefined) {
        costUsd = usage.costUsd;
      } else if (options.provider && options.model) {
        const price = priceFor(options.provider, options.model, this.configOptions);
        if (price) {
          costUsd =
            (usage.inputTokens / 1_000_000) * price.inputPerMillionUsd +
            (usage.outputTokens / 1_000_000) * price.outputPerMillionUsd;
        }
      }
    }

    if (costUsd === null) {
      this.unknownCostCalls += 1;
    } else {
      this.knownCostUsd += costUsd;
    }

    // 转发给父账本：父账本独立地把这次调用也记一遍（不是共享同一份计数器），
    // 这样子账本删除/丢弃不会腐蚀父账本已经累计的历史。
    this.parent?.record(usage, options);

    const snapshot = this.snapshot();
    const newlyExceeded = snapshot.exceeded.filter((k) => !before.exceeded.includes(k));

    return {
      costUsd,
      costUnavailable: costUsd === null,
      snapshot,
      newlyExceeded,
    };
  }

  /** V93：再发一个估价 `estimateUsd` 的调用，是否会让「已结算 + 在飞 + 这一个」越过 maxCostUsd。 */
  wouldExceedCost(estimateUsd: number): boolean {
    if (this.limits.maxCostUsd === undefined) return false;
    return this.knownCostUsd + this.inFlightUsd + Math.max(0, estimateUsd) > this.limits.maxCostUsd;
  }

  /**
   * V93：发前预留。越闸返回 null（一分钱都没预留）；否则把估价计入在飞，返回结算句柄。
   * 有父账本时**先向父账本预留**——父账本拒绝就整体拒绝（全局上限拦住"每个子代理都没超，
   * 加起来超了"的在飞版本）。预留与判定在同一个同步段内完成，`Promise.all` 里 N 个调用
   * 的同步前缀依次执行，后来者一定看得到先到者的预留——这就是 TOCTOU 的封口。
   */
  tryReserve(estimateUsd: number): BudgetReservation | null {
    const estimate = Math.max(0, estimateUsd);
    if (this.wouldExceedCost(estimate)) return null;
    const parentReservation = this.parent ? this.parent.tryReserve(estimate) : null;
    if (this.parent && !parentReservation) return null;
    this.inFlightUsd += estimate;
    this.inFlightCalls += 1;
    let settled = false;
    const unreserve = () => {
      this.inFlightUsd = Math.max(0, this.inFlightUsd - estimate);
      this.inFlightCalls = Math.max(0, this.inFlightCalls - 1);
    };
    const ledger = this;
    return {
      estimateUsd: estimate,
      get settled() {
        return settled;
      },
      settle(usage, options = {}) {
        if (settled) return { costUsd: null, costUnavailable: true, snapshot: ledger.snapshot(), newlyExceeded: [] };
        settled = true;
        unreserve();
        // 父账本的在飞额先释放，再由 record() 的常规转发把结算额记到父账本。
        parentReservation?.release();
        return ledger.record(usage, options);
      },
      release() {
        if (settled) return;
        settled = true;
        unreserve();
        parentReservation?.release();
      },
    };
  }

  /** `tryReserve` 的抛错版：越闸抛 `BudgetExceededError("costUsd")`。 */
  reserve(estimateUsd: number): BudgetReservation {
    const r = this.tryReserve(estimateUsd);
    if (!r) throw new BudgetExceededError("costUsd", this.snapshot());
    return r;
  }

  snapshot(): BudgetSnapshot {
    const totalTokens = this.inputTokens + this.outputTokens;
    const wallMs = this.now() - this.startedAtMs;
    const costUsd = this.unknownCostCalls > 0 ? null : this.knownCostUsd;

    const exceeded: BudgetLimitKind[] = [];
    if (this.limits.maxCalls !== undefined && this.calls > this.limits.maxCalls) exceeded.push("calls");
    if (this.limits.maxInputTokens !== undefined && this.inputTokens > this.limits.maxInputTokens)
      exceeded.push("inputTokens");
    if (this.limits.maxOutputTokens !== undefined && this.outputTokens > this.limits.maxOutputTokens)
      exceeded.push("outputTokens");
    if (this.limits.maxTotalTokens !== undefined && totalTokens > this.limits.maxTotalTokens)
      exceeded.push("totalTokens");
    if (this.limits.maxWallMs !== undefined && wallMs > this.limits.maxWallMs) exceeded.push("wallMs");
    // 用已知成本（下界）判定，见类型上的大注释：已知部分就已经超，不需要等未知部分查清楚。
    if (this.limits.maxCostUsd !== undefined && this.knownCostUsd > this.limits.maxCostUsd) exceeded.push("costUsd");

    return {
      label: this.label,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens,
      wallMs,
      knownCostUsd: this.knownCostUsd,
      unknownCostCalls: this.unknownCostCalls,
      costUsd,
      inFlightUsd: this.inFlightUsd,
      inFlightCalls: this.inFlightCalls,
      limits: this.limits,
      exceeded,
    };
  }

  /** 任意维度已确定超限。P12 的 `stopReason:"budget"` 判定走这个（而不是 `done`）。 */
  isExceeded(): boolean {
    return this.snapshot().exceeded.length > 0;
  }

  /** 超限时抛 `BudgetExceededError`；不超限时什么也不做。账本本身不强制调用这个—— */
  /** 它是"观测"组件，是否要硬停由调用方（ToolBus/子代理循环）决定。 */
  assertWithinLimits(): void {
    const snapshot = this.snapshot();
    if (snapshot.exceeded.length > 0) {
      throw new BudgetExceededError(snapshot.exceeded[0]!, snapshot);
    }
  }

  /**
   * 派生一个子账本，花费向上汇总到 `this`（见 `BudgetLedgerOptions.parent` 的注释）。
   * P12 的每个子代理各自持有一个 `child()`，互不干扰地看自己的 `snapshot()`，
   * 但主循环通过父账本的 `snapshot()`/`isExceeded()` 能看到全局汇总。
   */
  child(limits: BudgetLimits = {}, label?: string): BudgetLedger {
    return new BudgetLedger(limits, {
      label: label ?? `${this.label}.child`,
      parent: this,
      configOptions: this.configOptions,
      now: this.now,
    });
  }
}
