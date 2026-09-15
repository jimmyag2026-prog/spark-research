import type {
  DeltaEventData,
  PartialEvent,
  PartialCardPayload,
  PartialPaper,
  PartialPapersPayload,
  PartialSearchSourcePayload,
  StreamProgressEvent,
  UiStage,
} from "./types";

// 会话流的**纯状态模型**（lane ε-1）。
//
// 为什么单独一个文件而不是塞进 center.tsx：这里全是「事件 → 状态」的推导，
// 没有一行 DOM。组件只负责把这份状态画出来。三段式界面（阶段条 / 实时日志 / 正文区）
// 的所有判定——现在是哪一段、每段跑了多久、某条 delta 该追加还是清空重画——
// 都在这里，看得见也钉得住。
//
// **事件形状真源**：lane β 的 `backend/src/agents/progress.ts`
//（`git show feat/W10-beta:backend/src/agents/progress.ts`）。前后端不共享编译单元，
// `lib/types.ts` 里那几个 interface 是它在浏览器侧的复述，字段名逐个对齐过。
//
// 一条纪律：**拿不准就不动**。β 的 `ProgressEvent` 只有四个粗粒度 stage
//（plan/execute/summarize/review），文献流程的「检索 / 下载 / 精读 / 综述」在
// execute 段里只以人读文案（`taskNote`）出现。所以这里从文案里认关键词，
// 认不出来就**保持当前高亮不动**，绝不瞎猜一个段位——进度条上的假动作比不动更伤信任
//（同 β 在 etaMs 上的口径：拿不准就不给）。

/** 阶段条的六段。顺序即先后，索引用来判「谁已经过去了」。 */
export const UI_STAGES = ["plan", "search", "download", "read", "review", "summarize"] as const;

export const STAGE_LABEL: Record<UiStage, string> = {
  plan: "规划",
  search: "检索",
  download: "下载",
  read: "精读",
  review: "综述/复核",
  summarize: "汇总",
};

export type StageState = "pending" | "active" | "done";

export interface StageView {
  stage: UiStage;
  state: StageState;
  /** 这一段已经跑了多久（毫秒）。没进过这一段时为 null——**不显示 0ms 冒充「跑了一瞬」**。 */
  elapsedMs: number | null;
}

export interface LogLine {
  id: number;
  /** 事件自带的时刻（epoch ms）。β-1 的原话：时间戳由产生事件的那一端给。 */
  at: number;
  kind: "progress" | "papers" | "paper" | "search_source" | "card";
  text: string;
  /** `kind === "paper"` 时带上，日志行点开就能跳到文献库。 */
  paperId?: string;
}

/** 正文区的一个分区：一个 `delta.target` 一块。 */
export interface StreamSection {
  target: string;
  revision: number;
  text: string;
}

export interface StreamState {
  stages: StageView[];
  current: UiStage | null;
  /** 执行段计数（V158）。β 的 `ProgressEvent.complete/total`，前端不重算。 */
  complete: number;
  total: number;
  /** β 拿得准才给的预计剩余；拿不准时这里也没有。 */
  etaMs: number | null;
  /** 最近一条人读文案。阶段条认不出段位时，它仍然如实说现在在干什么。 */
  message: string;
  logs: LogLine[];
  sections: StreamSection[];
  papers: PartialPaper[];
  /** 用户按过「停止」。 */
  stopped: boolean;
}

export function initialStreamState(): StreamState {
  return {
    stages: UI_STAGES.map((stage) => ({ stage, state: "pending" as StageState, elapsedMs: null })),
    current: null,
    complete: 0,
    total: 0,
    etaMs: null,
    message: "",
    logs: [],
    sections: [],
    papers: [],
    stopped: false,
  };
}

/**
 * 从一条 `progress` 事件推出六段里的哪一段。
 *
 * β 的 stage 只有四个值，execute 段内部的子阶段只能从 `message` 认——那串文案由
 * `taskNote` 产生（U49 起文献流程逐段发），形如「执行中 1/3：检索 12 篇候选」。
 * 认不出来返回 null = **不动高亮**。
 */
export function stageFromProgress(event: StreamProgressEvent): UiStage | null {
  if (event.stage === "plan") return "plan";
  if (event.stage === "summarize") return "summarize";
  if (event.stage === "review") return "review";
  const text = event.message ?? "";
  if (/检索|搜索|search/i.test(text)) return "search";
  if (/下载|PDF|pdf/.test(text)) return "download";
  if (/精读|阅读|read(ing)?\b/i.test(text)) return "read";
  if (/综述|复核|review/i.test(text)) return "review";
  return null;
}

function stageIndex(stage: UiStage): number {
  return UI_STAGES.indexOf(stage);
}

/**
 * 把高亮挪到 `next`，顺手把它之前的段标成 done，并记账每段耗时。
 *
 * 耗时用**事件自带的 ts**算，不用浏览器收到的时刻：SSE 缓冲、页面卡顿、断线重连都会
 * 让后者偏（这正是 β-1 补 `ts` 的理由）。代价是活动段的秒数只在有新事件时才跳一下，
 * 而不是每秒自增——**宁可慢一拍，不要一个没有依据的数**。
 */
function enterStage(state: StreamState, next: UiStage, at: number, enteredAt: Map<UiStage, number>): void {
  const nextIdx = stageIndex(next);
  if (!enteredAt.has(next)) enteredAt.set(next, at);
  state.stages = state.stages.map((view) => {
    const idx = stageIndex(view.stage);
    const start = enteredAt.get(view.stage);
    if (idx === nextIdx) {
      // 当前段：耗时随事件时间推进（活动段的数会跳，走过的段不会再动）。
      return { stage: view.stage, state: "active" as StageState, elapsedMs: Math.max(0, at - (start ?? at)) };
    }
    if (idx < nextIdx) {
      // 走过的段：**耗时只冻结一次**——已经是 done 的不再重算，否则每来一条新事件
      // 历史段的秒数都会跟着涨，那是个越看越离谱的假数。没进过的段保持 pending，
      // 也不补一个假的 0ms。
      if (view.state === "done") return view;
      if (start === undefined) return view;
      return { stage: view.stage, state: "done" as StageState, elapsedMs: Math.max(0, at - start) };
    }
    return view;
  });
  state.current = next;
}

function pushLog(state: StreamState, line: Omit<LogLine, "id">): void {
  const id = state.logs.length === 0 ? 1 : state.logs[state.logs.length - 1]!.id + 1;
  state.logs = [...state.logs, { id, ...line }];
}

/**
 * 一次会话流的推导器。`enteredAt` 这类跨事件的账放在闭包里，
 * 调用方只管把事件喂进来、把 `state()` 画出去。
 */
export interface StreamModel {
  progress(event: StreamProgressEvent): void;
  partial(event: PartialEvent): void;
  delta(event: DeltaEventData): void;
  stop(): void;
  state(): StreamState;
}

export function createStreamModel(emit: (state: StreamState) => void): StreamModel {
  let state = initialStreamState();
  const enteredAt = new Map<UiStage, number>();
  const flush = () => emit({ ...state });

  return {
    progress(event) {
      if (state.stopped) return;
      state = { ...state };
      state.message = event.message;
      state.complete = event.complete;
      state.total = event.total;
      state.etaMs = typeof event.etaMs === "number" ? event.etaMs : null;
      const next = stageFromProgress(event);
      if (next) enterStage(state, next, event.ts, enteredAt);
      pushLog(state, { at: event.ts, kind: "progress", text: event.message });
      flush();
    },

    partial(event) {
      if (state.stopped) return;
      state = { ...state };
      if (event.kind === "papers") {
        const payload = event.payload as PartialPapersPayload;
        enterStage(state, "search", event.ts, enteredAt);
        state.papers = payload.papers;
        pushLog(state, {
          at: event.ts,
          kind: "papers",
          text: `检索「${payload.query}」命中 ${payload.found} 篇，先铺 ${payload.papers.length} 条`,
        });
        for (const paper of payload.papers) {
          pushLog(state, {
            at: event.ts,
            kind: "paper",
            paperId: paper.id,
            text: `${paper.title}${paper.year ? `（${paper.year}）` : ""} · ${paper.sources.join("/") || "—"}`,
          });
        }
      } else if (event.kind === "search_source") {
        const payload = event.payload as PartialSearchSourcePayload;
        enterStage(state, "search", event.ts, enteredAt);
        // 失败源同样上屏：「查了但失败」与「根本没查」在界面上必须分得开（β-2 的原话）。
        const count = payload.count === null ? "—" : `${payload.count} 条`;
        pushLog(state, {
          at: event.ts,
          kind: "search_source",
          text:
            `源 ${payload.source}：${payload.outcome} · ${count}` +
            (payload.elapsedMs === null ? "" : ` · ${formatMs(payload.elapsedMs)}`) +
            (payload.error ? ` · ${payload.error}` : ""),
        });
      } else {
        const payload = event.payload as PartialCardPayload;
        enterStage(state, "read", event.ts, enteredAt);
        // β 明说：α 的预筛落地前 `relevance` 恒为 null。null ≠ 0——
        // 填 0 会被读成「判定为不相关」，那是另一件事。这里显示「—」。
        const relevance = payload.relevance === null || payload.relevance === undefined
          ? "—"
          : payload.relevance.toFixed(2);
        pushLog(state, {
          at: event.ts,
          kind: "card",
          paperId: payload.paperId,
          text: `精读卡 ${payload.title}｜相关性 ${relevance}｜${payload.keyFinding ?? "（卡里没有可用的一句话）"}`,
        });
      }
      flush();
    },

    delta(event) {
      if (state.stopped) return;
      const target = event.target ?? "summary";
      const revision = event.revision ?? 1;
      state = { ...state };
      const idx = state.sections.findIndex((s) => s.target === target);
      if (idx === -1) {
        state.sections = [...state.sections, { target, revision, text: event.chunk }];
      } else {
        const prev = state.sections[idx]!;
        // revision 变了 = **另一稿**（重试 / 修正轮），清空重画；
        // 不这样做的话第二轮的增量会接在第一轮后面，拼出一段两个版本混合的正文。
        const text = prev.revision === revision ? prev.text + event.chunk : event.chunk;
        state.sections = state.sections.map((s, i) => (i === idx ? { target, revision, text } : s));
      }
      flush();
    },

    stop() {
      state = { ...state, stopped: true };
      flush();
    },

    state() {
      return state;
    },
  };
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 正文分区的人读标题。`card:<paperId>` 由 β 的 `cardTarget()` 构造。 */
export function sectionLabel(target: string): string {
  if (target === "summary") return "回答";
  if (target === "review") return "综述草稿";
  if (target.startsWith("card:")) return `精读卡 ${target.slice(5)}`;
  return target;
}
