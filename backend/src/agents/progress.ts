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
export function createProgressEmitter(onProgress?: ProgressListener): ProgressEmitter {
  let stage: ProgressStage = "plan";
  let complete = 0;
  let total = 0;

  function emit(next: ProgressStage, message: string, decision?: ProgressDecision): void {
    stage = next;
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
      emit("plan", `规划完成：共 ${total} 个任务`, "continue");
    },
    taskCompleted(task) {
      complete += 1;
      const label = task?.description ? `：${clampMessage(task.description)}` : task?.kind ? `：${task.kind}` : "";
      emit("execute", `执行中 ${complete}/${Math.max(total, complete)}${label}`, "continue");
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
