import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { configuredRawLlm, type ConfigOptions } from "../config";
import { USER_OWNED_LICENSE } from "../provenance/policy";
import { redactLlmOptions, type RawSink } from "../raw";
import { BudgetLedger } from "../llm/budget";
import { failure } from "../llm/providers/types";
import type { CallOptions, ChatMessage, LlmResponse } from "../llm/types";

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
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 已知成本之和——真实总花费的下界。 */
  knownCostUsd: number;
  unknownCostCalls: number;
  byCommand: Record<string, { calls: number; knownCostUsd: number; unknownCostCalls: number }>;
  byModel: Record<string, { calls: number; knownCostUsd: number; unknownCostCalls: number }>;
}

export class UsageStore {
  constructor(private readonly file: string) {}

  path(): string {
    return this.file;
  }

  append(entry: UsageEntry): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
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

  /** readAll 中跳过的坏行数（文件被手改/写坏时不装作没看见）。 */
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
      byCommand: {},
      byModel: {},
    };
    for (const e of entries) {
      totals.calls += 1;
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
  llm: { call(messages: ChatMessage[], modelOrOptions?: string | CallOptions): Promise<LlmResponse> };
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
export function usageTrackingLlm(options: UsageTrackingOptions): UsageTrackingLlm {
  const { llm, store, command, budgetUsd, configOptions, rawSink } = options;
  const rawOn = rawSink !== undefined && configuredRawLlm(configOptions);
  const priorKnownCostUsd = store.totals().knownCostUsd;
  const ledger = new BudgetLedger(
    budgetUsd !== undefined ? { maxCostUsd: Math.max(0, budgetUsd - priorKnownCostUsd) } : {},
    { label: `usage:${command}`, configOptions },
  );

  return {
    ledger,
    async call(messages: ChatMessage[], modelOrOptions: string | CallOptions = {}): Promise<LlmResponse> {
      if (budgetUsd !== undefined) {
        const spent = priorKnownCostUsd + ledger.snapshot().knownCostUsd;
        if (spent >= budgetUsd) {
          const requested =
            typeof modelOrOptions === "string" ? modelOrOptions : (modelOrOptions.model ?? "(默认)");
          return failure("budget-gate", requested, {
            kind: "budget",
            message:
              `预算闸：本项目已知花费 $${spent.toFixed(4)} 已达上限 $${budgetUsd.toFixed(2)}（已知下界口径，` +
              `未知成本调用另见 usage 输出）。这次调用没有发出、没有新花费；已完成的产出都已保存。` +
              `下一步：提高 --budget-usd，或用 spark-research usage 查各命令花费后缩小范围重跑。`,
            retryable: false,
          });
        }
      }
      const res = await llm.call(messages, modelOrOptions);
      const recorded = ledger.record(res.usage, {
        provider: res.provider,
        model: res.model,
      });
      store.append({
        ts: new Date().toISOString(),
        command,
        provider: res.provider,
        model: res.model,
        ok: res.ok,
        inputTokens: res.usage.usageUnavailable ? 0 : res.usage.inputTokens,
        outputTokens: res.usage.usageUnavailable ? 0 : res.usage.outputTokens,
        costUsd: recorded.costUsd,
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
              costUsd: recorded.costUsd,
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
