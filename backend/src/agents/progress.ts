// 三段结构化进度（lane α-3 · USAGE_LOG U4）。
//
// **在修什么**：`routes/session.ts:95` 在整条管线开跑前发**一次**固定文案
// （「规划与执行中」/「共探中」），之后到 `result` 为止再无任何事件。于是不管 plan 跑了
// 三秒还是三十秒，界面上永远是那五个字，不动——既不区分现在是 plan / execute 还是
// review，也没有任何推进感。**回复越好、等待越长，而等待期内的信息量恒定为零。**
// U4 的原话：这不是性能问题，是预期管理问题。
//
// **对标**：OpenScience `backend/cli/src/session/contract-progress.ts` 的形状
// （阶段 + 完成数/总数 + 一个决策枚举）。只抄机制不抄代码。
//
// **为什么是一个 emitter 而不是四个散落的回调**：`total` 这个数只有在 plan 落地之后
// 才知道（= 任务数），而 `complete` 要跨 execute 的循环与 review 的修正轮累加。
// 把状态放在调用方（orchestrator）就意味着四个接线点各自维护一份计数，
// `complete ≤ total` 这条不变式没有任何地方能保证。放在这里，接线点就只剩一行一个动词，
// 收口 diff 也压得进 10 行（见 `docs/devlog/W9-alpha.md`「收口 diff」）。
//
// **与前端的兼容性**：`frontend/workspace/src/lib/api.ts:133` 的消费端签名是
// `onProgress?: (data: { message: string }) => void`，`center.tsx:66` 只读 `data.message`。
// `ProgressEvent` 带着 `message: string` 字段，多出来的 stage / complete / total / decision
// 是结构化附加信息，旧消费端原样忽略——**前端一行不用改**（任务书要求在 devlog 里确认，已确认）。

/** 管线的四个阶段。`summarize` 与 `review` 在 U4 的文案里合称「复核中」。 */
export type ProgressStage = "plan" | "execute" | "summarize" | "review";

/**
 * 本轮跑完之后管线打算做什么。纯观测字段，不参与控制流——
 * 它的用途是让等待中的用户知道「还要不要再等一轮」。
 * - `continue`：还有后续阶段要跑；
 * - `repair`：review 出了硬 finding，要进修正轮（`total` 会随之变大）；
 * - `ready`：review 通过，这是最后一个事件；
 * - `await_user`：管线停下来等用户（目前没有生产触发点，留给后续的权限/澄清轮）。
 */
export type ProgressDecision = "ready" | "continue" | "repair" | "await_user";

export interface ProgressEvent {
  stage: ProgressStage;
  /** 已完成的任务数。**恒 ≤ total**。 */
  complete: number;
  /** 本轮任务总数。plan 落地前是 0；进修正轮时加上修正任务数。 */
  total: number;
  decision?: ProgressDecision;
  /** 人读文案。**前端唯一消费的字段**，必须自足（不依赖其它字段也能读懂）。 */
  message: string;
  /**
   * β-1（v0.10）：事件发出时刻（epoch ms）。
   * 前端此前只能用「收到的时刻」当时间戳——SSE 缓冲、页面卡顿、断线重连都会让它偏；
   * 而「这一阶段跑了多久」正是 v0.10 要上屏的东西，所以时间戳由产生事件的那一端给。
   */
  ts: number;
  /** β-1：自 emitter 创建（= 本次请求开始）以来的毫秒数。**单调不减**。 */
  elapsedMs: number;
  /**
   * β-1：预计剩余毫秒。**拿不准就没有这个字段**（任务书原话：eta 拿不准就不给字段）。
   * 唯一给得出的场景：execute 阶段、已完成 ≥ 1 个任务、且还有任务没完成——
   * 此时按「本会话内已完成任务的平均耗时 × 剩余任务数」外推。plan / summarize / review
   * 三段没有可外推的样本（每段只跑一次，且时长与任务数无关），一律不给。
   */
  etaMs?: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

export interface ProgressEmitter {
  /** plan 开始。此刻还不知道有几个任务，`total` = 0。 */
  planStarted(): void;
  /** plan 落地：`total` 就此确定 = 任务数。 */
  planned(taskCount: number): void;
  /** 一个任务执行完毕：`complete++`，并发一次 execute 事件。 */
  taskCompleted(task?: { kind?: string; description?: string }): void;
  /** 开始汇总。 */
  /** U49（v0.9.1）：某个任务**内部**的阶段（如文献流程的「检索 / 下载 / 精读 3 篇 / 综述」）。计数不变，只换文案。 */
  taskNote(message: string): void;
  summarizing(): void;
  /** review 返回。`approved` 决定 decision 是 `ready` 还是 `repair`。 */
  reviewed(input: { approved: boolean; hardFindings: number }): void;
  /** 进入修正轮：`total` 加上修正任务数。 */
  repairing(fixCount: number): void;
  /** 当前快照（不发事件），给测试与诊断用。 */
  snapshot(): { stage: ProgressStage; complete: number; total: number };
}

function clampMessage(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 建一个进度发射器。`onProgress` 不传就是一个完整的空操作——
 * CLI 路径与所有既有测试都不传，行为与接线前**完全一致**（不发事件、不抛、不记账）。
 */
export function createProgressEmitter(
  onProgress?: ProgressListener,
  /** β-1：注入时钟（测试用）。生产不传 = Date.now。 */
  options: { now?: () => number } = {},
): ProgressEmitter {
  let stage: ProgressStage = "plan";
  let complete = 0;
  let total = 0;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  // 执行段的起点：plan 落地那一刻。没有 planned() 的路径（直接 taskCompleted）退回 startedAt。
  let executeStartedAt: number | null = null;

  /**
   * β-1：只在 execute 段、且已有完成样本时外推。分母用 `complete`（已完成任务数），
   * 分子用「execute 段已经过的时间」——不含 plan 的耗时，否则第一个任务的 eta 会被
   * 一次慢 plan 调用整体抬高，越往后越偏。
   */
  function etaFor(next: ProgressStage, at: number): number | undefined {
    if (next !== "execute") return undefined;
    if (complete <= 0 || total <= complete) return undefined;
    const spent = at - (executeStartedAt ?? startedAt);
    if (spent <= 0) return undefined;
    return Math.round((spent / complete) * (total - complete));
  }

  function emit(next: ProgressStage, message: string, decision?: ProgressDecision): void {
    stage = next;
    const at = now();
    const etaMs = etaFor(next, at);
    // 不变式兜底：任何一条路径把 complete 推过 total（例如 review 的修正任务先执行、
    // repairing() 漏调）时，宁可把 total 抬上来，也不要发出一个 `3/2` 的事件——
    // 进度条上的 150% 比慢一点更伤信任。这条兜底触发说明有接线点漏了，
    // 所以它同时是测试里那条 `complete ≤ total` 断言的最后一道防线。
    if (complete > total) total = complete;
    onProgress?.({
      stage,
      complete,
      total,
      ...(decision ? { decision } : {}),
      message,
      ts: at,
      elapsedMs: Math.max(0, at - startedAt),
      ...(etaMs !== undefined ? { etaMs } : {}),
    });
  }

  return {
    planStarted() {
      complete = 0;
      total = 0;
      emit("plan", "规划中：正在拆解任务", "continue");
    },
    planned(taskCount: number) {
      total = Math.max(0, taskCount);
      executeStartedAt = now();
      emit("plan", `规划完成：共 ${total} 个任务`, "continue");
    },
    taskCompleted(task) {
      complete += 1;
      const label = task?.description ? `：${clampMessage(task.description)}` : task?.kind ? `：${task.kind}` : "";
      emit("execute", `执行中 ${complete}/${Math.max(total, complete)}${label}`, "continue");
    },
    taskNote(message) {
      const shown = Math.min(complete + 1, Math.max(total, complete + 1));
      emit("execute", `执行中 ${shown}/${Math.max(total, shown)}：${clampMessage(message)}`, "continue");
    },
    summarizing() {
      emit("summarize", "汇总中：正在生成结果摘要", "continue");
    },
    reviewed({ approved, hardFindings }) {
      if (approved || hardFindings === 0) {
        emit("review", "复核通过", "ready");
        return;
      }
      emit("review", `复核发现 ${hardFindings} 处硬问题，准备修正`, "repair");
    },
    repairing(fixCount: number) {
      total += Math.max(0, fixCount);
      emit("review", `修正轮：新增 ${Math.max(0, fixCount)} 个任务（共 ${total}）`, "repair");
    },
    snapshot() {
      return { stage, complete, total };
    },
  };
}

// ── v0.10 lane β · 新事件类型（协议只增不改）────────────────────────────────
//
// 六种既有事件（start/progress/delta/result/done/error）一个不动、一个字段不改，
// 这里只**新增** `partial`，并给 `delta` 补两个字段。为什么类型定义放在这个文件：
// 它们和 `ProgressEvent` 是同一件事的三个粒度（阶段 / 中间产物 / 正文增量），
// 产生端都在 `agents/`，而 `server/types.ts` 只把它们**转出去**给 contract 生成器
// （同 settings 类型那条既有先例，见 server/types.ts 的注释）——两份定义迟早对不上。

/** `partial` 的三种中间产物。 */
export type PartialKind = "papers" | "search_source" | "card";

/** `papers`：检索一回来就推的候选清单条目（≤ 20 条，够前端先把标题铺上屏）。 */
export interface PartialPaper {
  id: string;
  title: string;
  year: number | null;
  doi: string | null;
  /** 命中它的检索源（多源命中时是合并后的列表）。 */
  sources: string[];
}

export interface PartialPapersPayload {
  query: string;
  /** 本次检索命中的总条数（可能 > papers.length，清单被截到 20 条）。 */
  found: number;
  papers: PartialPaper[];
}

/** `search_source`：每源一条 ok/failed/timeout/skipped + 条数。 */
export interface PartialSearchSourcePayload {
  query: string;
  source: string;
  outcome: string;
  count: number | null;
  elapsedMs: number | null;
  /** 失败原因（截断）。ok 时不出现——**不填空串冒充「没有错误」**。 */
  error?: string;
}

/** `card`：每张精读卡完成即推——标题 + 一句 keyFindings + 相关性。 */
export interface PartialCardPayload {
  paperId: string;
  title: string;
  year: number | null;
  /** 一句话关键发现。卡里没有可用句子时为 null（不编）。 */
  keyFinding: string | null;
  /** 相关性分 0–1。管线目前不产出分数时为 null（`basis` 仍给，说明卡是全文还是摘要级）。 */
  relevance: number | null;
  basis: string | null;
}

export type PartialPayload = PartialPapersPayload | PartialSearchSourcePayload | PartialCardPayload;

export interface PartialEvent {
  kind: PartialKind;
  /** 产生它的任务 id（chat 的 plan 任务）。管线被直接调用（CLI / 测试）时没有。 */
  taskId?: string;
  ts: number;
  payload: PartialPayload;
}

export type PartialListener = (event: PartialEvent) => void;

/**
 * β-3：`delta` 的去向。`summary` = chat 的最终正文（W3-a 既有那条），
 * `review` = 综述草稿正文，`card:<paperId>` = 某张精读卡（用 `cardTarget()` 构造）。
 * 没有 target 的老 delta 事件在收口后一律补 `summary`（值域只增不减）。
 *
 * **为什么不是模板字面量类型**（`"summary" | "review" | \`card:${string}\``）：
 * `scripts/gen-contract-schemas.ts` 不认模板字面量，会在 schema 里写一条
 * `{"$comment":"unhandled:..."}`——lane ε 与外部 SDK 按契约渲染时拿到的是一个
 * 「这里有个东西但说不清是什么」的洞。**宁可类型宽一格、契约诚实**，
 * 也不要一个漂亮却在 contract 里说不出口的类型（AD-12）。
 */
export type DeltaTarget = "summary" | "review" | string;

export interface DeltaEvent {
  chunk: string;
  target: DeltaTarget;
  /**
   * 同一个 target 的第几版，从 1 开始。**重试 / 修正轮会 +1**，前端据此清空重画——
   * 不然第二轮的增量会接在第一轮后面，拼出一段两个版本混合的正文
   * （W3-a 的注释里已经预告过这个坑：多轮 summarize 的增量会依次到达）。
   */
  revision: number;
}

export type DeltaListener = (event: DeltaEvent) => void;

/** 拼一个 `card:<paperId>` 的 target（避免各处手写字符串拼接拼错前缀）。 */
export function cardTarget(paperId: string): DeltaTarget {
  return `card:${paperId}`;
}

/**
 * 每个 target 的 revision 计数器。第一次问某个 target 给 1，之后每次 `bump` +1。
 * 放在一个小对象里而不是散落的局部变量：revision 的唯一不变式是「同 target 单调递增」，
 * 三个产生端（summarize / review / card）各维护一份计数就没有任何地方能保证它。
 */
export interface RevisionCounter {
  current(target: DeltaTarget): number;
  bump(target: DeltaTarget): number;
}

export function createRevisionCounter(): RevisionCounter {
  const revisions = new Map<string, number>();
  return {
    current(target) {
      const n = revisions.get(target) ?? 1;
      revisions.set(target, n);
      return n;
    },
    bump(target) {
      const n = (revisions.get(target) ?? 0) + 1;
      revisions.set(target, n);
      return n;
    },
  };
}
