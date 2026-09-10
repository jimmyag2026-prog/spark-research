import { createHash } from "node:crypto";
import type { RecordOrigin, ResearchRecord } from "../project/models";
import {
  AGENT_RUN_RECORD_TYPE,
  RecordStore,
  type AgentRunRecordInput,
} from "../project/records";
import type { Usage } from "../llm/types";
import type { SubAgentStopReason } from "./sub_agent";

// W3-b · `AgentRunLedger`（v0.4 方案 §4.3「帧级记账」；波次调度 W3-b）。
//
// 定位：Claude Science 的 `frames` 表带 model/effort/token/total_cost，OpenScience 有
// harness `fingerprint`。spark 已经有证据图（`project/records.ts` 的 RecordStore）——
// 记账不新起一张表，直接落图：`agent_run` 是第 9 类 record，`report`/lineage/UI 时间线
// 因为本来就读图，**免费**获得对这类 record 的支持。这是「证据图是万能接口」这个架构
// 赌注的第二次兑现（第一次是 P5/P6 干湿实验闭环共用同一套 record/edge 语义）。
//
// **诚实铁律**（与 `llm/budget.ts` 的 `BudgetLedger` 一致，这里不重造，只透传）：
// 拿不到 usage 或拿不到单价 → `usage.costUsd` 必须是 `null`，绝不填 0 冒充免费。
// `record()` 在 `frame.usage` 整体缺失时，会补一个显式的「未知」默认值——**这正是
// 最容易埋雷的地方**（缺省值的诱惑是随手填 `costUsd: 0`），所以本文件把这个默认值
// 单独抽成 `UNKNOWN_USAGE` 常量，且专门有一条阴性对照钉住它（见
// `tests/unit/ledger.test.ts` 与 `docs/devlog/W3-b.md` §阴性对照①）。
//
// **指纹**（`systemHash`/`promptHash`）要回答「这个产物是哪个模型、哪版 prompt 产的」
// ——OpenScience 的 harness fingerprint 缺口在这里一并补上。算法：对输入（可以是
// 字符串，也可以是消息数组等可 JSON 化的结构）先递归排序 key（`canonicalize`，与
// `lab/wet_models.ts` 的 `computeMetaIntegrityHash` 同一手法，避免「内容一样但 key
// 插入顺序不同」被误判成变了），再 `JSON.stringify` 后 sha256。纯函数、不掺
// `Date.now()`/`randomUUID()`：prompt 变一个字节指纹就变，同一 prompt 不管调用几次、
// 跨不跨进程都得到同一个指纹。
//
// **完整性**：`rev`（乐观并发 CAS）是 `RecordStore` 通用机制，本文件不碰；但
// `agent_run` 的核心字段（agent/model/provider/systemHash/promptHash/usage/toolCalls/
// stopReason/parentRunId）还需要一层「有没有被绕过 `AgentRunLedger` 直接改过」的可检测性
// ——这正是 `lab/wet_loop.ts` 已经验证过的模式（`computeMetaIntegrityHash` +
// `verifyMetaIntegrity`）：写入时把这些字段（不含 `integrityHash` 自己）算一次 sha256
// 存进 `metadata.integrityHash`；`get()`/`children()` 读回来时重算一遍比对，对不上就
// 拒绝信任、抛 `AgentRunIntegrityError`，不是静默放行。`RecordStore.update()` 仍然是
// 通用窄口（其他调用方可以合法地改 title/content/metadata 的其他字段），但只要谁碰了
// 这几个受保护字段，下一次读就会被本机制逮到。
//
// **父子表达**：子代理 run 建一条 `derives_from` 边指向父 run（`records.link(childId,
// parentId, "derives_from")`）——方向与全仓库既有的「产物→来源」口径一致（见
// `mcp/tools.ts` 的边方向说明；子 run 是从父 run「派生」出来的）。产物 record（idea/
// observation/artifact/...）同理挂在产生它的 agent_run 下：
// `records.link(producedId, agentRunId, "derives_from")`，`linkProduced()` 是这个操作的
// 窄口。两条边规则相同、方向一致，接线方（W3-a 的 orchestrator 或 replan 循环）不需要
// 记两套方向。

/**
 * `agent_run` 的 stopReason 取两个既有消费方各自枚举的并集——不新发明第三套词汇。
 * `SubAgentStopReason`（`./sub_agent`，只读引用，W2-a 交付，已有生产调用方
 * `orchestrator.ts`，本文件类型导入不影响它的孤儿门禁状态）覆盖子代理 tool loop；
 * `"no_progress"` 是 `./contract`（W2-b 交付）`StopReason` 里子代理循环没有的那个值——
 * **这里手工内联字面量、不从 `./contract` 做类型导入**：`contract.ts` 目前在
 * `ALLOWED_ORPHANS` 登记为「等 W3-a 接线」的孤儿模块，只有测试引用它；哪怕只是
 * `import type`，也会在 `narrative_parity.test.ts` 的孤儿检测里把它标记成"已被生产代码
 * 引用"，提前抹掉那条登记本该反映的真实状态（真正的接线是 W3-a 把 replan 循环接上，
 * 不是本 lane 顺手 import 一个类型）。已知的小重复（"no_progress" 这一个字面量）
 * 换来的是两条 lane 互不干扰——与 registry.ts 里 `PROVIDER_API_KEY_ENV` 曾经历过的
 * 同一类取舍。
 */
export type AgentRunStopReason = SubAgentStopReason | "no_progress";

/** `record()` 的输入——一次 agent/子代理运行的原始素材，指纹与完整性哈希由本文件算。 */
export interface AgentRunFrame {
  agent: string;
  model: string;
  provider: string;
  /** 系统 prompt 原文（字符串或可 JSON 化的结构，如消息数组）——喂给 `computeSystemHash`。 */
  systemPrompt: unknown;
  /** 本次真正发给模型的 prompt 内容——喂给 `computePromptHash`。 */
  prompt: unknown;
  /**
   * 缺省 = `undefined`（调用方真的拿不到 usage，例如上游模型不返回 usage 字段）——
   * 此时落成 `UNKNOWN_USAGE`（`costUsd: null` + `usageUnavailable: true`），**不是** 0。
   * 若调用方能拿到 usage 但查不到单价，应显式传 `{ inputTokens, outputTokens,
   * costUsd: null }`（`BudgetLedger.record()` 已经是这个形状，直接透传即可）。
   */
  usage?: Usage;
  toolCalls: number;
  stopReason: AgentRunStopReason;
  /** 顶层 run 传 `null`/不传；子代理 run 传父 run 的 record id。 */
  parentRunId?: string | null;
  title?: string;
  content?: string;
  origin?: RecordOrigin;
  createdAt?: string;
}

/** `get()`/`record()`/`children()` 的返回视图：结构化字段 + 完整性状态 + 底层 record。 */
export interface AgentRunView {
  id: string;
  agent: string;
  model: string;
  provider: string;
  systemHash: string;
  promptHash: string;
  usage: Usage;
  toolCalls: number;
  stopReason: string;
  parentRunId: string | null;
  /** `null` = 这条记录写入时本机制尚未保护（理论上不会发生——本文件是它唯一的写入口）。 */
  integrityHash: string | null;
  record: ResearchRecord;
}

/** `frame.usage` 缺省时落的「未知」usage——诚实铁律的字面体现：不是 `costUsd: 0`。 */
const UNKNOWN_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: null, usageUnavailable: true };

export class AgentRunValidationError extends Error {
  constructor(message: string) {
    super(`AgentRunValidation: ${message}`);
    this.name = "AgentRunValidationError";
  }
}

// `get()`/`children()` 发现 metadata 完整性哈希对不上时抛这个——见文件头大注释。
// 与 `lab/wet_models.ts` 的 `RecordIntegrityError` 同一模式、不同域，刻意不复用那个类
// （它的消息文案是湿实验专属的，且那个文件不在本 lane 所有权内）。
export class AgentRunIntegrityError extends Error {
  constructor(runId: string) {
    super(
      `agent_run ${runId.slice(0, 8)} 的 metadata 完整性校验失败——agent/model/provider/` +
        `systemHash/promptHash/usage/toolCalls/stopReason/parentRunId 中至少一项可能被绕过 ` +
        `AgentRunLedger 直接改写，拒绝信任该记录。如需排查原始内容：` +
        `RecordStore.get('${runId}')（不经过 AgentRunLedger 的窄口）。`,
    );
    this.name = "AgentRunIntegrityError";
  }
}

// 递归排序 object 的 key（数组顺序保留）——与 `lab/wet_models.ts` 的 `canonicalize` 同一
// 手法，各自本地一份（两个文件不共享私有函数，且都是几行的纯工具，复制比新开一个共享
// 模块更不容易在未来产生跨 lane 的文件所有权纠纷）。
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/**
 * 系统 prompt 指纹。纯函数：同一输入任何时候、任何进程调用都得到同一个哈希
 * （不掺时间戳/随机数），输入变一个字节哈希就变——`tests/unit/ledger.test.ts` 的
 * 「指纹的两条性质」分别钉住这两点。
 */
export function computeSystemHash(systemPrompt: unknown): string {
  return sha256Of(systemPrompt);
}

/** 调用 prompt 指纹，算法与 `computeSystemHash` 相同（各自独立导出，语义不同）。 */
export function computePromptHash(prompt: unknown): string {
  return sha256Of(prompt);
}

// 参与完整性哈希的字段集合——`integrityHash` 自己不参与（否则自指）。字段顺序无所谓，
// `canonicalize` 会排序。
interface ProtectedFields {
  agent: string;
  model: string;
  provider: string;
  systemHash: string;
  promptHash: string;
  usage: Usage;
  toolCalls: number;
  stopReason: string;
  parentRunId: string | null;
}

function computeIntegrityHash(fields: ProtectedFields): string {
  return sha256Of(fields);
}

function extractProtectedFields(metadata: Record<string, unknown>): ProtectedFields {
  return {
    agent: String(metadata.agent ?? ""),
    model: String(metadata.model ?? ""),
    provider: String(metadata.provider ?? ""),
    systemHash: String(metadata.systemHash ?? ""),
    promptHash: String(metadata.promptHash ?? ""),
    usage: (metadata.usage as Usage) ?? UNKNOWN_USAGE,
    toolCalls: Number(metadata.toolCalls ?? 0),
    stopReason: String(metadata.stopReason ?? ""),
    parentRunId: (metadata.parentRunId as string | null | undefined) ?? null,
  };
}

export interface AgentRunLedgerOptions {
  records: RecordStore;
}

export class AgentRunLedger {
  private readonly records: RecordStore;

  constructor(options: AgentRunLedgerOptions) {
    this.records = options.records;
  }

  /**
   * 记一次 agent/子代理运行，落成 `agent_run` record。
   * `frame.usage` 缺省时落 `UNKNOWN_USAGE`（诚实：说不出花了多少，不是没花）。
   * `frame.parentRunId` 给了会额外建一条 `derives_from` 边（子 run → 父 run）。
   */
  record(frame: AgentRunFrame): AgentRunView {
    const usage = frame.usage ?? UNKNOWN_USAGE;
    assertHonestUsage(usage);

    const systemHash = computeSystemHash(frame.systemPrompt);
    const promptHash = computePromptHash(frame.prompt);
    const parentRunId = frame.parentRunId ?? null;

    const protectedFields: ProtectedFields = {
      agent: frame.agent,
      model: frame.model,
      provider: frame.provider,
      systemHash,
      promptHash,
      usage,
      toolCalls: frame.toolCalls,
      stopReason: frame.stopReason,
      parentRunId,
    };
    const integrityHash = computeIntegrityHash(protectedFields);

    const input: AgentRunRecordInput = {
      agent: frame.agent,
      model: frame.model,
      provider: frame.provider,
      systemHash,
      promptHash,
      usage,
      toolCalls: frame.toolCalls,
      stopReason: frame.stopReason,
      parentRunId,
      extraMetadata: { integrityHash },
      title: frame.title,
      content: frame.content,
      origin: frame.origin,
      createdAt: frame.createdAt,
    };
    const record = this.records.createAgentRun(input);

    if (parentRunId) {
      // 方向口径见文件头注释：产物（子 run）→ 来源（父 run），与全仓库既有的
      // derives_from 方向一致（mcp/tools.ts 的边方向说明）。
      this.records.link(record.id, parentRunId, "derives_from");
    }

    return this.toView(record);
  }

  /**
   * 「产物 record 挂 agent_run 的 id」的落地方式：任何在这次 run 里产出的 record
   * （idea/observation/artifact/...）都可以调这个方法挂到对应的 agent_run 下——
   * `records.link(producedId, agentRunId, "derives_from")`，产物→来源同一方向。
   */
  linkProduced(agentRunRecordId: string, producedRecordId: string): void {
    this.records.link(producedRecordId, agentRunRecordId, "derives_from");
  }

  /**
   * 读一条 agent_run record，**核验完整性**——哈希对不上（被绕过 `record()`、直接用
   * `RecordStore.update()` 改过受保护字段）一律拒绝信任，抛 `AgentRunIntegrityError`，
   * 不是「猜是无害改动」后静默放行。
   */
  get(id: string): AgentRunView {
    const record = this.records.get(id);
    // `record.type` 静态类型是 `RecordType`（8 种字面量），但 `createAgentRun()`
    // 落库的真实字符串是 "agent_run"——models.ts 的 RECORD_TYPES 尚未收录它（见
    // records.ts 的 `AGENT_RUN_RECORD_TYPE` 大注释）。运行时比较必须转成 string，
    // 否则 TS 会判定两侧字面量无交集直接报错（TS2367）。
    if (!record || (record.type as string) !== AGENT_RUN_RECORD_TYPE) {
      throw new AgentRunValidationError(`agent_run 记录 '${id}' 不存在`);
    }
    return this.toView(record);
  }

  /** 某个父 run 下面挂的全部子 run（`derives_from` 入边里 type=agent_run 的那些）。 */
  children(parentRunId: string): AgentRunView[] {
    const { incoming } = this.records.edgesOf(parentRunId);
    return incoming
      .filter((e) => e.type === "derives_from")
      .map((e) => this.records.get(e.sourceId))
      .filter((r): r is ResearchRecord => r !== null && (r.type as string) === AGENT_RUN_RECORD_TYPE)
      .map((r) => this.toView(r));
  }

  private toView(record: ResearchRecord): AgentRunView {
    const metadata = record.metadata as Record<string, unknown>;
    const storedHash = typeof metadata.integrityHash === "string" ? metadata.integrityHash : null;
    const fields = extractProtectedFields(metadata);

    if (storedHash !== null && computeIntegrityHash(fields) !== storedHash) {
      throw new AgentRunIntegrityError(record.id);
    }

    return {
      id: record.id,
      agent: fields.agent,
      model: fields.model,
      provider: fields.provider,
      systemHash: fields.systemHash,
      promptHash: fields.promptHash,
      usage: fields.usage,
      toolCalls: fields.toolCalls,
      stopReason: fields.stopReason,
      parentRunId: fields.parentRunId,
      integrityHash: storedHash,
      record,
    };
  }
}

// 诚实铁律的运行时兜底：usage 声明「拿不到」（`usageUnavailable: true`）却同时给了一个
// 非 null 的 costUsd，这是调用方自相矛盾（既然拿不到 usage，就不可能算出真实成本）——
// 账本不替它圆谎，直接拒绝写入。真正的「拿到 usage、查不到单价」场景应该是
// `usageUnavailable` 为 false/undefined 且 `costUsd: null`，这条检查不挡这种情况。
function assertHonestUsage(usage: Usage): void {
  if (usage.usageUnavailable && usage.costUsd !== null) {
    throw new AgentRunValidationError(
      "usage.usageUnavailable=true 但 costUsd 不是 null —— 诚实铁律：拿不到 usage 时成本" +
        "必须记为 null，不许填 0 或猜测值冒充免费/已知",
    );
  }
}
