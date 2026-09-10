import { TaskRegistry, type TaskEvent, type TaskHandle, type TaskProgress, type TaskSnapshot } from "../server/tasks";

// V35：把长任务在 CLI 层变可见。
//
// 现状（v0.5 闸门 F 的零上下文外部验收，头号卡点）：`lit read --all` 跑 8 分钟零输出，
// 没有进度、没有任务句柄，终端一断就再也查不到状态——验收者只能杀掉进程、再用
// `lit list` 反推「它其实是在工作的」。
//
// 关键判断：**这不是缺功能，是能力不对等。** `server/tasks.ts` 的 TaskRegistry 早就有
// 状态机 + progress 事件 + 只增事件日志，W4-c（V11）还补了落盘与进程重启后的 hydrate；
// MCP 层有 `task_status`。三条入口里，只有 CLI 没接。所以本文件做的是**接线**，
// 不是另起一套 CLI 专用的进度机制——另起一套就等于把「同一件事两份实现」这个
// V34 形状的问题再犯一遍（V34 就是「能力做好了、另一处副本没跟上」）。
//
// 两个 CLI 专属的决定，都写在这里而不是改 tasks.ts：
//
// 1. **默认不设超时**（`timeoutMs: 0`）。TaskRegistry 的默认 600s 是给 HTTP / MCP 调用方
//    兜底的——那边没有真人守着，一个挂死的任务会让轮询方永远等下去。CLI 不一样：
//    真人在终端前，Ctrl-C 随时可用，而且本改动之前 `lit read --all` 压根没有任何超时。
//    如果这里套上 600s，一个 30 篇的合法长跑会在第 10 分钟被我们自己掐断——**为了让长任务
//    可见而引入一条新的失败路径，方向是反的**。挂死本身由进度行暴露（每条事件都带 `+Xs`，
//    卡住时最后一行的时间戳不动），这正是 V35 要的效果。调用方要超时可以显式传。
// 2. **`--json` 模式下静音进度**。进度行走 `out`，而 `--json` 的 stdout 必须是一段可解析的
//    JSON；把进度混进去等于把一个可用性修复变成一个解析 bug。

export interface CliTaskRenderOptions {
  // 进度行的输出口（与命令自身的 out 同一个，便于测试注入）。
  out: (line: string) => void;
  // --json 等结构化输出模式：只跑任务、不打进度行（否则污染 stdout）。
  quiet?: boolean;
  // 落盘根目录（通常是项目根）。给了才能在断开/重启后用 `lit tasks <id>` 查回来。
  root?: string;
  // 复用一个已有 registry（测试注入 / 同一条命令内跑多个任务）。
  registry?: TaskRegistry;
  // 显式超时；默认 0 = 不超时，理由见文件头。
  timeoutMs?: number;
  now?: () => number;
}

export interface CliTaskResult<T> {
  snapshot: TaskSnapshot;
  // 任务体的返回值。任务失败时为 null——失败是一等结果（tasks.ts 纪律 2），
  // 调用方要么看 `snapshot.error`，要么看这个值是不是 null，不存在「静默拿到半个结果」。
  value: T | null;
}

// CLI 侧的任务 registry。默认落盘到 `<root>/tasks/`，与 server 用的是同一套目录布局，
// 所以 daemon 起来之后 `GET /api/tasks/:id` 看到的就是同一批任务快照（同一 root 时）。
export function cliTaskRegistry(root?: string): TaskRegistry {
  return new TaskRegistry(root ? { root } : {});
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `+${s.toFixed(1)}s` : `+${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

function asProgress(data: unknown): TaskProgress | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.done !== "number") return null;
  if (!(typeof obj.total === "number" || obj.total === null)) return null;
  return { done: obj.done, total: obj.total as number | null, message: (obj.message as string | null) ?? null };
}

// 单条事件 → 一行人读文本。导出是为了让测试直接核实渲染，而不是靠抓 stdout 猜。
export function renderTaskEvent(event: TaskEvent, elapsedMs: number): string | null {
  const stamp = formatElapsed(elapsedMs);
  if (event.type === "progress") {
    const progress = asProgress(event.data);
    if (progress) {
      const counter = progress.total !== null ? `${progress.done}/${progress.total}` : `${progress.done}`;
      return `   ${stamp} [${counter}] ${progress.message ?? ""}`.trimEnd();
    }
    return `   ${stamp} · ${event.message ?? ""}`.trimEnd();
  }
  if (event.type === "error") return `   ${stamp} ❌ ${event.message ?? "任务失败"}`;
  // state / result 由收尾行统一汇报，不逐条刷屏。
  return null;
}

/**
 * 跑一个长任务并把过程打出来。返回任务快照 + 任务体的返回值。
 *
 * 输出形态（`quiet` 关闭时）：
 * ```
 * ⏳ 任务 4f0c… 已启动（reading-cards）· 断开后用 spark-research lit tasks 4f0c… 查状态
 *    +0.4s [1/12] 精读卡：Highly accurate protein structure prediction…
 *    ...
 * ✅ 任务完成（12 项，用时 3m41s）
 * ```
 */
export async function runCliTask<T>(
  options: CliTaskRenderOptions & {
    kind: string;
    project?: string | null;
    label?: string;
    run: (handle: TaskHandle) => Promise<T>;
  },
): Promise<CliTaskResult<T>> {
  const registry = options.registry ?? cliTaskRegistry(options.root);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const quiet = options.quiet === true;
  const out = options.out;

  let value: T | null = null;
  const snapshot = registry.start({
    kind: options.kind,
    project: options.project ?? null,
    timeoutMs: options.timeoutMs ?? 0,
    run: async (handle) => {
      value = await options.run(handle);
      return value;
    },
  });

  if (!quiet) {
    const short = snapshot.id.slice(0, 8);
    out(
      `⏳ 任务 ${short} 已启动（${options.label ?? options.kind}）` +
        `· 断开后用 spark-research lit tasks ${short} 查状态`,
    );
  }

  // 订阅在 start() 之后：TaskRegistry 的 subscribe() 会先补齐历史事件，
  // 所以 start() 到这里之间已经发生的事件不会丢（tasks.ts 纪律 3：事件是只增日志）。
  const subscription = quiet
    ? null
    : registry.subscribe(snapshot.id, (event) => {
        const line = renderTaskEvent(event, now() - startedAt);
        if (line !== null) out(line);
      });
  if (subscription) {
    for (const event of subscription.history) {
      const line = renderTaskEvent(event, now() - startedAt);
      if (line !== null) out(line);
    }
  }

  const settled = (await registry.settle(snapshot.id))!;
  subscription?.cancel();

  if (!quiet) {
    const elapsed = formatElapsed(now() - startedAt).replace(/^\+/, "");
    if (settled.state === "succeeded") {
      out(`✅ 任务 ${settled.id.slice(0, 8)} 完成（用时 ${elapsed}）`);
    } else {
      out(`❌ 任务 ${settled.id.slice(0, 8)} 失败（用时 ${elapsed}）：${settled.error?.message ?? "未知原因"}`);
    }
  }

  return { snapshot: settled, value: settled.state === "succeeded" ? value : null };
}

// ── `... tasks` 子命令的渲染 ────────────────────────────────────────────────

export function renderTaskSnapshot(snapshot: TaskSnapshot, eventTail = 10): string[] {
  const lines: string[] = [];
  lines.push(`任务 ${snapshot.id}`);
  lines.push(`  类型 ${snapshot.kind}${snapshot.project ? ` · 项目 ${snapshot.project}` : ""}`);
  lines.push(`  状态 ${snapshot.state}${snapshot.recovered ? "（recovered：上一个进程留下的记录，本进程没有它的执行体）" : ""}`);
  lines.push(`  创建 ${snapshot.createdAt}${snapshot.finishedAt ? ` · 结束 ${snapshot.finishedAt}` : ""}`);
  if (snapshot.progress) {
    const p = snapshot.progress;
    lines.push(`  进度 ${p.done}${p.total !== null ? `/${p.total}` : ""}${p.message ? ` · ${p.message}` : ""}`);
  }
  if (snapshot.error) {
    lines.push(`  错误 ${snapshot.error.message}${snapshot.error.timeout ? "（超时兜底触发）" : ""}`);
  }
  const tail = snapshot.events.slice(-eventTail);
  if (tail.length > 0) {
    lines.push(`  事件（最近 ${tail.length}/${snapshot.events.length} 条）:`);
    for (const event of tail) lines.push(`    [${event.seq}] ${event.at} ${event.type} ${event.message ?? ""}`.trimEnd());
  }
  return lines;
}

export function renderTaskList(snapshots: TaskSnapshot[]): string[] {
  if (snapshots.length === 0) {
    return ["没有任务记录。长任务（lit read --all / lit review）会在这里留下句柄与进度。"];
  }
  return snapshots.map((s) => {
    const progress = s.progress ? ` · ${s.progress.done}${s.progress.total !== null ? `/${s.progress.total}` : ""}` : "";
    return `  ${s.id.slice(0, 8)}  ${s.state.padEnd(9)} ${s.kind.padEnd(16)} ${s.createdAt}${progress}`;
  });
}
