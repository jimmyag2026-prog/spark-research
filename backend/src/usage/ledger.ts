import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { configuredRawLlm, type ConfigOptions } from "../config";
import { USER_OWNED_LICENSE } from "../provenance/policy";
import { redactLlmOptions, type RawSink } from "../raw";
import { BudgetLedger, estimateCallCostUsd } from "../llm/budget";
import { DEFAULT_MODEL } from "../llm/router";
import { resolveModelName } from "../llm/providers/registry";
import { failure } from "../llm/providers/types";
import { redactSecrets } from "../llm/types";
import type { CallOptions, ChatMessage, LlmErrorKind, LlmResponse, ProviderCapabilities } from "../llm/types";

// G-3（v0.6）：轮级用量台账 + 预算闸。
//
// 一「轮」（B2 的一次课题执行）跨很多条 CLI 命令——search → add → read → review →
// idea → novelty，每条是独立进程。BudgetLedger 是进程内句柄，管不到跨进程累计；
// 这里补的就是那半截：**每次 LLM 调用落一行 usage.jsonl（按项目），预算闸读
// 「文件里的历史累计 + 本进程增量」判 maxCostUsd**。
//
// 三条铁律（与 BudgetLedger 同口径，不另立标准）：
// 1. 成本未知**绝不当 0**——文件里 costUsd 为 null 的行数单独计（unknownCostCalls），
//    总花费有未知就不能报确定总数，只报已知下界。
// 2. 预算闸用**已知下界**判超（下界都超了，真实总额必超；反之未知部分多时
//    「确定没超」也说不出口，但闸不误杀——诚实的代价由 usage 命令的示警补足）。
// 3. 定价数学**只有 BudgetLedger 一份**（priceFor 的消费封装在它的 record() 里），
//    本模块不重新实现单价换算——V46「同一件事两份手写副本」的形状不重演。

export interface UsageEntry {
  ts: string;
  /** 归因标签：哪条命令花的（lit-read / lit-review / idea-new / novelty-check…）。 */
  command: string;
  provider: string;
  model: string;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  /** 这一次调用的已知成本；null = 拿不到 usage 或查不到单价（不是免费）。 */
  costUsd: number | null;
  /** V94：这次调用的模型在单价表里查不到（发前就知道）。只在 true 时写入。 */
  unpriced?: boolean;
  /**
   * V99②：`costUsd` 被强制记成可证明的 0（不是「未知」）时的原因。目前只覆盖
   * `error.kind ∈ {auth, rate_limit}` 两种——上游在产生任何可计费 token 之前就
   * 拒绝了请求，$0 是确定的事实，不该和「拿不到 usage / 查不到单价」的真未知
   * 混进同一个 unknownCostCalls 桶里（那会让「已知花费下界」比实际更保守）。
   */
  zeroCostReason?: string;
  /**
   * α-4（USAGE_LOG U1）：这次失败属于哪一类。`LlmErrorKind` 这个类型一直存在
   * （auth / rate_limit / timeout / parse / upstream / unsupported / budget），
   * 但失败时从来没落进台账——U1 现场的那一行 `ok:false` 除了「失败了」之外什么都没留下，
   * 紧接着的第二次调用又成功了，于是事后**完全无法判断这次失败该怪谁**。只在 ok:false 时写入。
   */
  errorKind?: LlmErrorKind;
  /**
   * α-4：错误摘要，**≤ 200 字且已脱敏**。上游错误体可能回显请求内容（含鉴权头），
   * 台账是明文落盘的长期文件，所以这里的脱敏比 `LlmError.message` 那层更狠（见 `redactErrorMessage`）。
   */
  errorMessage?: string;
  /**
   * V77：**上游根本没返 usage 帧**（不是「返了但查不到单价」）。两者此前都掉进
   * `unknownCostCalls` 一个桶里，于是「补一份单价表就能解决」和「这个 provider 压根不报用量」
   * 这两件完全不同的事看起来一模一样。只在 true 时写入。
   */
  noUsage?: boolean;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 已知成本之和——真实总花费的下界。 */
  knownCostUsd: number;
  unknownCostCalls: number;
  /** V94：其中因「模型无单价」而成本未知的次数（unknownCostCalls 的子集）。 */
  unpricedCalls: number;
  /**
   * V77：其中因「上游没返 usage 帧」而成本未知的次数（unknownCostCalls 的子集，与
   * `unpricedCalls` **互不蕴含**：能拿到 usage 但查不到单价 → unpriced；
   * 拿不到 usage → noUsage，补单价表也救不了）。
   */
  noUsageCalls: number;
  /** α-4（U1）：失败按 `LlmErrorKind` 的分布。没有失败时是空对象，不是 undefined。 */
  byErrorKind: Record<string, number>;
  byCommand: Record<string, { calls: number; knownCostUsd: number; unknownCostCalls: number }>;
  byModel: Record<string, { calls: number; knownCostUsd: number; unknownCostCalls: number }>;
}

export class UsageStore {
  constructor(private readonly file: string) {}

  path(): string {
    return this.file;
  }

  /**
   * V97（v0.8 W8-1 β）：`entry.model` 在类型上恒是 `string`，但真实调用方有时把一整个
   * `CallOptions` 对象递进来（`tests/helpers/ideation_scenario.ts` 的 `ScriptedLlm.call()`
   * 撞过这个 bug——`llm.call(messages, options)` 的第二参是 `string | CallOptions`，
   * fake 只认字符串分支，序列化后就是一行 `model:"[object Object]"`，usage 台账被写坏）。
   * 落盘前兜底核一次类型，坏值记 `"(unknown)"` 并计入 `corrupt`（与 readAll() 的
   * 「坏行不装作没看见」同一计数口径），而不是让一个格式错误的字符串悄悄躺进文件里。
   *
   * V99①：写盘失败（磁盘满/权限/只读文件系统）**吞掉 + stderr 告警**，产出（`res`）
   * 照常由调用方返回——与 `api_ledger.ts` 的 `ApiCallStore.append()` 同一条纪律
   * （台账是观测，不是业务，不能因为记不下去而让已经发生、已经计费的真实调用失败）；
   * 这里额外加一条 `console.error`（api_ledger.ts 没加，不在本次改动范围内）——
   * 静默降级不留痕在这条台账上风险更高：它是预算闸读「已知花费下界」的输入源，
   * 吞得不出声，下一次判断就会悄悄失真。
   */
  append(entry: UsageEntry): void {
    let model = entry.model;
    if (typeof model !== "string") {
      this.corrupt += 1;
      console.error(
        `[usage] UsageStore.append: model 字段不是字符串（收到 ${JSON.stringify(entry.model)}），已记为 "(unknown)"（file=${this.file}）`,
      );
      model = "(unknown)";
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify({ ...entry, model })}\n`, "utf8");
    } catch (error) {
      console.error(
        `[usage] UsageStore.append: 写入 ${this.file} 失败（本次 LLM 调用产出仍正常返回，仅这一行台账没记上）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  readAll(): UsageEntry[] {
    if (!existsSync(this.file)) return [];
    const out: UsageEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as UsageEntry;
        // 最小结构校验：坏行跳过但**计数**，不静默吞（见 totals 的 corruptLines）。
        if (typeof parsed.command !== "string" || typeof parsed.ts !== "string") {
          this.corrupt += 1;
          continue;
        }
        out.push(parsed);
      } catch {
        this.corrupt += 1;
      }
    }
    return out;
  }

  private corrupt = 0;

  /**
   * 坏数据计数：readAll() 中跳过的坏行（文件被手改/写坏）+ V97 append() 写入时
   * model 字段类型不对、被改记成 "(unknown)" 的次数——两种都是「台账里出现了
   * 不该出现的坏数据」，不装作没看见，合并一个计数器上报。
   */
  corruptLines(): number {
    return this.corrupt;
  }

  totals(): UsageTotals {
    const entries = this.readAll();
    const totals: UsageTotals = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      knownCostUsd: 0,
      unknownCostCalls: 0,
      unpricedCalls: 0,
      noUsageCalls: 0,
      byErrorKind: {},
      byCommand: {},
      byModel: {},
    };
    for (const e of entries) {
      totals.calls += 1;
      if (e.unpriced === true) totals.unpricedCalls += 1;
      if (e.noUsage === true) totals.noUsageCalls += 1;
      // 只统计真正落了 kind 的失败行。历史文件里 ok:false 但没有 errorKind 的行
      // （α-4 之前写的，U1 现场那一行就是）**不计入**——凭空补一个 "unknown" 桶
      // 会把「我们当时没记」伪装成「我们记了、就是不知道」。
      if (e.ok === false && typeof e.errorKind === "string") {
        totals.byErrorKind[e.errorKind] = (totals.byErrorKind[e.errorKind] ?? 0) + 1;
      }
      totals.inputTokens += e.inputTokens;
      totals.outputTokens += e.outputTokens;
      const cmd = (totals.byCommand[e.command] ??= { calls: 0, knownCostUsd: 0, unknownCostCalls: 0 });
      const mdl = (totals.byModel[e.model] ??= { calls: 0, knownCostUsd: 0, unknownCostCalls: 0 });
      cmd.calls += 1;
      mdl.calls += 1;
      if (e.costUsd === null || e.costUsd === undefined) {
        totals.unknownCostCalls += 1;
        cmd.unknownCostCalls += 1;
        mdl.unknownCostCalls += 1;
      } else {
        totals.knownCostUsd += e.costUsd;
        cmd.knownCostUsd += e.costUsd;
        mdl.knownCostUsd += e.costUsd;
      }
    }
    return totals;
  }
}

/** α-4：错误摘要进台账前的上限（字符）。够读懂上游说了什么，又不至于把一页 HTML 落盘。 */
export const MAX_LEDGER_ERROR_MESSAGE_CHARS = 200;

/**
 * α-4（U1）：错误摘要脱敏。**比 `llm/types.ts` 的 `redactSecrets` 更狠**，因为落点不同——
 * `LlmError.message` 是进程内的一次性对象，这里是**明文长期落盘**的 usage.jsonl。
 *
 * 三层：
 *   ① `redactSecrets`：`sk-…` / `Bearer …` / `api_key: …` 这些有结构的形状；
 *   ② 任何 ≥16 位的连续字母数字串——上游错误体常常原样回显请求（含鉴权头），
 *      而一个没有 `sk-` 前缀的 key（Anthropic/Qwen/自建网关都有）① 抓不到；
 *   ③ 截断到 200 字。
 *
 * **已知代价，如实记**：② 会把长 request-id 一起抹掉（它们也是 ≥16 位字母数字串）。
 * 诊断主力是 `errorKind`，摘要是补充；宁可少一个 request-id，不可多一个 key 落盘。
 */
export function redactErrorMessage(raw: string): string {
  return redactSecrets(raw)
    .replace(/[A-Za-z0-9]{16,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LEDGER_ERROR_MESSAGE_CHARS);
}

// --budget-usd 的统一校验（literature 与 ideation CLI 共用，不留两份副本）。
// 失败时给下一步（V36），不让用户猜格式。
export function parseBudgetUsd(
  raw: string | true | undefined,
  err: (line: string) => void,
): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const value = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    err("❌ --budget-usd 需要一个正数（美元）。例如：--budget-usd 2 表示本项目累计已知花费达到 $2 后停止新的 LLM 调用。");
    return { ok: false };
  }
  return { ok: true, value };
}

export interface UsageTrackingOptions {
  llm: {
    call(messages: ChatMessage[], modelOrOptions?: string | CallOptions): Promise<LlmResponse>;
    /**
     * V77：可选。生产上这里递进来的就是 `LLMRouter`，它有这个方法；测试里的假 LLM
     * 大多没有——所以是可选的，**拿不到就不猜**（`noUsage` 仍按 usageUnavailable 记，
     * 只是少了「上游声称会报却没报」那条异常提示）。
     */
    capabilitiesFor?(model: string): ProviderCapabilities | null;
  };
  store: UsageStore;
  command: string;
  /** 项目累计已知成本（含历史 + 本进程）达到即拒绝后续调用。不给 = 只记账不设闸。 */
  budgetUsd?: number;
  configOptions?: ConfigOptions;
  /**
   * v0.7 W7-D0 · L0：每次真调用的 prompt/响应原文落 raw/llm/（AD-15）。这里是所有花钱路径
   * 的必经点（G-3 预算闸也在这里），埋在这一处全体覆盖——不逐模块手写（V46 形状）。
   * 不给 sink = 不记（测试与无项目上下文）；config `rawLlm=off` 也不记。
   */
  rawSink?: RawSink;
  project?: string | null;
  sessionId?: string | null;
  /**
   * V93：发前估价函数，默认 `estimateCallCostUsd`（按字符数 + maxTokens 上限价）。
   * 返回 null = 查不到单价（不是 0）。测试注入用；生产不传。
   */
  estimateUsd?: (messages: ChatMessage[], options: CallOptions, target: { provider: string; model: string }) => number | null;
  /**
   * V94：设了 `budgetUsd` 时，单价表查不到的模型**默认拒绝**（否则闸对它静默失效——花多少都算"未知"，
   * 永远不会越线）。`--allow-unpriced` 显式放行：调用照发，usage 行标 `unpriced:true`，闸对它不计价。
   */
  allowUnpriced?: boolean;
}

export interface UsageTrackingLlm {
  call(messages: ChatMessage[], modelOrOptions?: string | CallOptions): Promise<LlmResponse>;
  /** 本进程内的账本快照（跨进程累计看 store.totals()）。 */
  ledger: BudgetLedger;
}

/**
 * 把任意 llm.call 包成「先过预算闸 → 真调用 → 落台账」。
 *
 * 预算闸语义：`已知花费下界 = 文件历史 knownCostUsd（创建时读一次）+ 本进程账本
 * knownCostUsd`，达到 budgetUsd 即拒绝——返回 kind:"budget" 的失败响应，**不发请求、
 * 不产生新花费**。已完成的产出（精读卡等）由各 pipeline 自己已保存，不受影响；
 * 拒绝消息里写清已花多少、怎么继续（V36：失败要给下一步）。
 */
/**
 * A7 Blocker-1（V125）：**跨请求共享的在飞预留**，按 usage.jsonl 路径（= 项目）聚合。
 *
 * V93 修的是「一个 ledger 内 N 个并发调用」（CLI 里 `Promise.all` 那种）。但 HTTP 面每个请求都
 * 新建一个 `usageTrackingLlm` → 新建一个 `BudgetLedger`，在飞预留互相看不见；而闸的另一半
 * （实时重读 usage.jsonl）只看得到**已结算**的花费。于是 N 个并发请求同时过闸、同时开跑，
 * 项目累计花费越过各自声明的上限——A7 实测 10 并发 × `budgetUsd=0.03` 实际花掉 $0.0807。
 *
 * 这里把在飞额按项目聚合到进程级注册表：同一个 server 进程内的并发请求彼此可见。
 * **残余（如实记）**：跨进程的在飞预留仍不共享（两个 CLI 进程同时起跑），那一段只能靠
 * 实时重读已结算花费兜底——上界是「每进程一次调用的估价」。
 */
const SHARED_IN_FLIGHT = new Map<string, number>();

function sharedInFlight(key: string): number {
  return SHARED_IN_FLIGHT.get(key) ?? 0;
}

function addSharedInFlight(key: string, delta: number): void {
  const next = sharedInFlight(key) + delta;
  if (next <= 1e-12) SHARED_IN_FLIGHT.delete(key);
  else SHARED_IN_FLIGHT.set(key, next);
}

/** 测试用：清空进程级在飞注册表（每个用例之间互不干扰）。 */
export function resetSharedInFlightForTests(): void {
  SHARED_IN_FLIGHT.clear();
}

export function usageTrackingLlm(options: UsageTrackingOptions): UsageTrackingLlm {
  const { llm, store, command, budgetUsd, configOptions, rawSink } = options;
  const rawOn = rawSink !== undefined && configuredRawLlm(configOptions);
  const estimateUsd = options.estimateUsd ?? ((m, o, t) => estimateCallCostUsd(m, o, { ...t, configOptions }));
  const priorKnownCostUsd = store.totals().knownCostUsd;
  const ledger = new BudgetLedger(
    budgetUsd !== undefined ? { maxCostUsd: Math.max(0, budgetUsd - priorKnownCostUsd) } : {},
    { label: `usage:${command}`, configOptions },
  );

  return {
    ledger,
    async call(messages: ChatMessage[], modelOrOptions: string | CallOptions = {}): Promise<LlmResponse> {
      const callOptions: CallOptions = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions;
      const requestedModel = callOptions.model ?? DEFAULT_MODEL;
      const known = resolveModelName(requestedModel); // β（v0.9）：不抛版本——记账层不能被未登记名打断
      const provider = known ? (known.kind === "local" ? "local" : known.provider) : "(unknown)";
      // V93：发前估价。查不到单价 → 预留 0（闸仍按已结算+在飞判，未定价模型的拒绝由 G-4 负责）。
      const estimated = estimateUsd(messages, callOptions, { provider, model: requestedModel });
      const unpriced = estimated === null;
      const estimate = estimated ?? 0;
      // U12 ③（v0.9 R6）：被闸拒绝也落一行——ok:false / errorKind:"budget" / costUsd:0（可证明的 $0：请求根本没发）。
      // 之前拒绝不留痕，`usage` 里查不到「这个项目今天被闸拒了 20 次」，byErrorKind 对闸是盲的。
      const recordGate = (message: string) => {
        store.append({
          ts: new Date().toISOString(),
          command,
          provider,
          model: requestedModel,
          ok: false,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          zeroCostReason: "预算闸拒绝：请求未发出，可证明 $0",
          errorKind: "budget",
          errorMessage: message.slice(0, 200),
        });
      };

      // V94：预算闸开着、模型无单价 → 默认拒绝。"未知成本"在闸里等价于"免费"，那闸就是假的。
      if (budgetUsd !== undefined && unpriced && options.allowUnpriced !== true) {
        {
          const gateMessage =
            `预算闸：模型 '${requestedModel}'（provider ${provider}）在单价表里没有价格，--budget-usd 无法对它计价，默认不放行。` +
            `这次调用没有发出、没有新花费。下一步：加 --allow-unpriced 显式放行（这些调用在 usage 里标 unpriced，不计入预算判定），` +
            `或用 SPARK_LLM_PRICING_JSON 补上 "${provider}:${requestedModel}" 的单价。`;
          recordGate(gateMessage);
          return failure("budget-gate", requestedModel, { kind: "budget", message: gateMessage, retryable: false });
        }
      }

      // V93 闸：**实时重读** usage.jsonl（跨进程：别的进程刚花的钱这里立刻看得见，不再只在
      // 构造时读一次）+ 本进程在飞预留 + 这一次的估价。三者之和越线就拒绝，一分钱不发。
      // 预留在同一个同步段内完成——`Promise.all` 下第 k 个调用的同步前缀跑到这里时，
      // 前 k-1 个已经把估价记进 inFlight 了，集体越闸的窄缝就此封死。
      const budgetKey = store.path();
      if (budgetUsd !== undefined) {
        const live = store.totals().knownCostUsd;
        // 本 ledger 的在飞 + 同项目其它并发请求的在飞（A7 Blocker-1）。
        const inFlight = Math.max(ledger.snapshot().inFlightUsd, sharedInFlight(budgetKey));
        const committed = live + inFlight;
        if (committed >= budgetUsd || committed + estimate > budgetUsd) {
          {
            const gateMessage =
              `预算闸：本项目已知花费 $${live.toFixed(4)} + 在飞预留 $${inFlight.toFixed(4)} + 本次估价 $${estimate.toFixed(4)}` +
              ` 将超过上限 $${budgetUsd.toFixed(2)}（已知下界口径，未知成本调用另见 usage 输出）。` +
              `这次调用没有发出、没有新花费；已完成的产出都已保存。` +
              `下一步：提高 --budget-usd，或用 spark-research usage 查各命令花费后缩小范围重跑。`;
            recordGate(gateMessage);
            return failure("budget-gate", requestedModel, { kind: "budget", message: gateMessage, retryable: false });
          }
        }
      }
      const reservation = ledger.tryReserve(estimate);
      if (reservation) addSharedInFlight(budgetKey, estimate);
      if (!reservation) {
        // 本进程账本自己的上限（budget − 构造时历史）也越了——与上面同语义，不同路径都拦。
        {
          const gateMessage =
            `预算闸：本进程在飞预留已达上限 $${(budgetUsd ?? 0).toFixed(2)}。这次调用没有发出、没有新花费。`;
          recordGate(gateMessage);
          return failure("budget-gate", requestedModel, { kind: "budget", message: gateMessage, retryable: false });
        }
      }
      let res: LlmResponse;
      try {
        res = await llm.call(messages, modelOrOptions);
      } catch (error) {
        reservation.release();
        addSharedInFlight(budgetKey, -estimate);
        throw error;
      }
      const recorded = reservation.settle(res.usage, {
        provider: res.provider,
        model: res.model,
      });
      addSharedInFlight(budgetKey, -estimate);
      // V99②：auth/rate_limit 失败发生在上游产生任何可计费 token 之前——$0 是可证明的
      // 事实，不是「查不到/拿不到」那种真未知。两种都覆盖 `recorded.costUsd`（budget.ts
      // 结算出来的值，通常是 null，因为没有 usage 可结算），避免它们被 totals() 计进
      // unknownCostCalls，拖累「已知花费下界」的可信度。
      let costUsd = recorded.costUsd;
      let zeroCostReason: string | undefined;
      if (!res.ok && (res.error.kind === "auth" || res.error.kind === "rate_limit")) {
        costUsd = 0;
        zeroCostReason = `error.kind=${res.error.kind}：上游在计费前拒绝了请求，可证明 $0`;
      }
      // V77：「上游没返 usage 帧」与「返了 usage 但查不到单价」此前都掉进
      // unknownCostCalls 一个桶。后者补一份单价表就解决，前者补什么都没用——
      // 合在一起统计等于把两件事的下一步混成一件。
      const caps = llm.capabilitiesFor?.(res.model) ?? null;
      const noUsage = costUsd === null && res.usage.usageUnavailable === true;
      if (caps?.usageReported && res.usage.usageUnavailable === true) {
        // provider 的能力位声称它会报 usage，这次却没报——不是配置问题，是上游行为异常
        // （或我们的解析漏了一种帧形状）。静默降级必须留痕，否则下次还是查不出来。
        console.error(
          `[usage] provider=${res.provider} model=${res.model} 声明 usageReported=true 但本次调用没有返回 usage 帧（command=${command}）`,
        );
      }
      // α-4（U1）：失败落 kind + 脱敏摘要。server 此前对 ok:false 完全静默——
      // U1 现场的 logs/server.log 整个文件只有四行启动日志。
      const errorKind = res.ok ? undefined : res.error.kind;
      const errorMessage = res.ok ? undefined : redactErrorMessage(res.error.message);
      if (!res.ok) {
        // 只打 kind，**不打 message**（任务书要求）：message 即便脱敏过也可能带上游回显的
        // 请求片段，而日志的受众比台账更广（会被 tail、被贴进工单）。要看摘要去 usage.jsonl。
        console.error(`[llm] fail provider=${res.provider} model=${res.model} kind=${res.error.kind} command=${command}`);
      }
      store.append({
        ts: new Date().toISOString(),
        command,
        provider: res.provider,
        model: res.model,
        ok: res.ok,
        inputTokens: res.usage.usageUnavailable ? 0 : res.usage.inputTokens,
        outputTokens: res.usage.usageUnavailable ? 0 : res.usage.outputTokens,
        costUsd,
        ...(unpriced ? { unpriced: true } : {}),
        ...(noUsage ? { noUsage: true } : {}),
        ...(zeroCostReason ? { zeroCostReason } : {}),
        ...(errorKind ? { errorKind } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      });
      if (rawOn) {
        // 失败也记：AD-13 的失败响应没有内容，但「问了什么、为什么失败」本身就是过程数据。
        rawSink!.append({
          kind: "llm",
          project: options.project ?? undefined,
          sessionId: options.sessionId ?? null,
          command,
          provenanceClass: "model_generated",
          license: USER_OWNED_LICENSE,
          payload: {
            provider: res.provider,
            model: res.model,
            ok: res.ok,
            failureKind: res.ok ? null : res.error.kind,
            messages: rawSink!.body(JSON.stringify(messages)),
            response: res.ok ? rawSink!.body(res.content) : null,
            usage: {
              inputTokens: res.usage.usageUnavailable ? 0 : res.usage.inputTokens,
              outputTokens: res.usage.usageUnavailable ? 0 : res.usage.outputTokens,
              // 与 usage.jsonl 同一份事实：auth/rate_limit 的可证明 $0 覆盖同步反映到 raw/llm。
              costUsd,
              usageUnavailable: Boolean(res.usage.usageUnavailable),
            },
            options: redactLlmOptions(typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions),
          },
        });
      }
      return res;
    },
  };
}
