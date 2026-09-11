import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuredTaskTimeoutMs } from "../config";

// 长任务句柄（P7）。
//
// 为什么需要它：文献检索、精读卡、综述、novelty check、干实验 run、湿实验 simulate
// 都是数秒到数分钟的任务。HTTP 请求上直接 await 会让浏览器超时、也没法给进度。
// 口径：**提交即返回任务句柄**，客户端用 `GET /api/tasks/:id` 轮询或 `.../stream` 走 SSE。
//
// 三条纪律：
//   1. 任务函数**自己持有**它需要的存储句柄并在结束时关掉——请求早已返回，
//      不能依赖请求作用域里的 project handle。
//   2. 失败是一等结果：`state=failed` + `error`，不是把异常吞掉留个「running」。
//   3. 事件是**只增日志**（`events`），晚订阅的客户端能补齐历史，不会丢开头。
//
// V11（W4-c）：落盘。
//
// 现状之前的问题：任务列表只在进程内存里，进程一重启，`GET /api/tasks/:id` 对任何
// 已提交的任务句柄都是 404——即便磁盘上的实验状态本身还在（`exp run --resume` 能接回）。
// v0.2.1 的零上下文外部验收撞到过这个：外部 agent 连接一断（不一定是进程重启，可能只是
// 客户端重连），句柄失效，agent 不知道该重跑还是该等。
//
// 做法：`root` 给了就在 `<root>/tasks/<id>.json` 落一份完整快照，每次 `emit()`（状态迁移 /
// progress / 结果 / 错误）之后原子覆写（temp 文件 + rename，避免另一个读者读到半写的 JSON）。
// `root` 不给（多数现有测试与 `new TaskRegistry()` 的默认构造）就完全是内存实现，
// 与 V11 之前逐字节一致——不会有任何测试在没显式要求的情况下意外写到真实磁盘。
//
// 僵尸任务判定：进程重启后用同一个 root 新建 TaskRegistry 会把磁盘上的文件读回内存
// （见 `hydrate()`）。判据是 RunStore 已经验证过的**「done.json 优先」**思路的同构版本：
// 磁盘上的快照如果是终态（succeeded/failed），直接相信它——那是任务体自己或者上一次
// TaskTimeoutError 兜底写下的，不会说谎。如果还是 running/pending，本进程压根没有那个
// `run()` 闭包（它没法跨进程序列化），也就不可能真的在跑它——**唯一诚实的做法是继续报
// running（不是 failed，也不是 succeeded——那两个都可能是假的），但额外打上 `recovered`
// 标记**，让消费方（task_status / UI）能分辨「这是本进程亲眼看着在跑的任务」还是
// 「这是上一个进程留下的、不确定是真的还在跑还是已经崩溃死掉的记录」。
// 之所以不做进程 start-time 交叉核验（BACKLOG V3 的思路：记录 pid + 进程启动时间，重启后
// 比对能不能排除掉「同一个 pid 但其实是全新进程」这类误判）——那是更精确但也更复杂的判据，
// 且不是本 lane 的范围。「只会多报 running」这个方向本身是安全的：它从不会把一个可能还在
// 正常跑的任务谎报成 failed，也不会把一个可能已经跑挂的任务谎报成 succeeded。
//
// W7-C2（V70 + V3）：上面这段是当年的决定，现在把「更精确的判据」补上了——`recovered`
// 只回答「这条记录是不是从磁盘读回来的」，从不回答「它现在到底还在不在跑」，这正是
// V70 的原始投诉（kill 进程后 `lit tasks` 永久显示 running，没有 liveness 判据）。
// 做法：`start()` 现在把本进程的 pid 与它的启动时间（`getProcessStartTime()`，
// `ps -o lstart=` 归一化到秒）一起落进快照。读回（`get()` / `list()`）时，对仍是
// running/pending 且**不是本进程亲手在跑**（`!entry.live`）的记录，重新核验一遍：
// pid 已经不存在 → 判定原进程已经死了；pid 还在但启动时间对不上 → 那是 V3 说的
// pid 复用，当前占着这个 pid 的是另一个不相干的进程，原进程同样已经不在了。
// 两种情况都落 **`orphaned`**——不是 `failed`：我们只能确认「持有 run() 闭包的进程
// 不在了」，确认不了任务体本身是正常收尾之前刚好没来得及写终态、还是真的跑挂了，
// 谎称 failed 与谎称 succeeded 一样都是在编造信息。查不出 pid 存活性之外的更多信息
// （启动时间拿不到、或本来就没记录）时保持「只多报不少报」的老口径，继续报 running，
// 只是额外标一下 `startTimeUnavailable`，让消费方知道这条判据本身没能完整核验。

// W7-C2（V70）：`orphaned` 是新增的第五态——只在读回时由 liveness 判据推导出来，
// 任务体自己从来不会主动把自己置成这个状态（对比 succeeded/failed，那是 run() 落定
// 的自然结果）。见文件头大注释「W7-C2（V70 + V3）」段。
export const TASK_STATES = ["pending", "running", "succeeded", "failed", "orphaned"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type TaskEventType = "state" | "progress" | "result" | "error";

export interface TaskEvent {
  seq: number;
  at: string;
  type: TaskEventType;
  message: string | null;
  data: unknown;
}

export interface TaskProgress {
  done: number;
  total: number | null;
  message: string | null;
}

// V11：一条快照在**这个进程**里是从磁盘恢复的、而不是本进程亲手跑出来的，就会带这个字段。
// 只可能出现在 state 仍是 running/pending 的快照上（终态快照磁盘记录本身就是可信的，
// 不需要标注）。`reason` 目前只有一种取值——磁盘上没有终态记录，判据见文件头大注释。
export interface TaskRecovery {
  at: string;
  reason: "no-terminal-record-on-disk";
}

export interface TaskSnapshot {
  id: string;
  kind: string;
  project: string | null;
  state: TaskState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: TaskProgress | null;
  result: unknown;
  // timeout=true 时这是 D-2 的超时兜底触发的失败，不是任务体自己抛的错——
  // 让轮询/SSE 的消费方能把「上游挂起」和「上游报错」分开处理。
  error: { message: string; timeout?: boolean } | null;
  events: TaskEvent[];
  // 只有从磁盘恢复的、状态仍非终态的快照才有值；本进程正常创建/正常结束的任务恒为 null。
  recovered?: TaskRecovery | null;
  // W7-C2（V70 + V3）：持有该任务 run() 闭包的进程 pid，与该进程的启动时间
  // （同一 `getProcessStartTime()` 口径，见文件头大注释）。`start()` 里恒写
  // （legacy——本 lane 之前落盘的旧快照没有这两个字段，JSON.parse 出来是 undefined，
  // 读回逻辑按「查不了，维持只多报不少报」处理，不当成错误）。
  pid?: number | null;
  pidStartedAt?: string | null;
  // ps 探测拿不到启动时间（平台不支持 / 权限受限 / 瞬时失败）时为 true——只能退化到
  // 只核 pid 存在性，不能编造一个可能是错的 pidStartedAt 去做比对。
  startTimeUnavailable?: boolean;
  // orphaned 判据命中时的人类可读原因；其余状态恒为 null。每次读回按当前 liveness
  // 重新算（见 `applyLiveness()`），不是 emit() 时一次性固化的字段。
  orphanReason?: string | null;
}

export interface TaskHandle {
  progress(done: number, total: number | null, message?: string): void;
  note(message: string, data?: unknown): void;
}

interface TaskEntry {
  snapshot: TaskSnapshot;
  subscribers: Set<(event: TaskEvent) => void>;
  settled: Promise<TaskSnapshot>;
  // true = 本进程通过 start() 创建、有真实 run() 闭包在跑；false = hydrate() 从磁盘读回来的，
  // 本进程没有、也不可能有对应的执行体（run() 闭包不能跨进程持久化）。
  live: boolean;
}

export interface StartTaskOptions {
  kind: string;
  project?: string | null;
  run: (handle: TaskHandle) => Promise<unknown>;
  // 单个任务的超时上限（毫秒），覆盖 TaskRegistry 的默认值。传 0 或负数显式关闭。
  timeoutMs?: number;
}

// D-2：任务体本身可能因为一次没设超时的上游调用（旧代码路径、第三方库内部裸 fetch
// 之类）而永久挂起——TaskRegistry 是长任务的最后一道兜底，即便任务体自己没有任何
// 超时逻辑，也不能让 `GET /api/tasks/:id` 或 `{"await":true}` 的调用方永远等下去。
// config/ 面板（P9）没有对应设置项（只读不改，见 docs/devlog/P10-b.md），走
// env + 常量默认。10 分钟：比 config 里已有的 mcpTimeoutMs（300_000ms，MCP 工具
// 同步等长任务的上限）更宽——这里包的是任务体的整个生命周期（可能内含多轮
// review 修正循环），不是单次工具调用，需要更大的余量；同时仍然是个有限值，
// 一次真正挂死的调用最终会被结构化地报出来而不是让任务句柄永远停在 running。
// P10 收口：默认值收进 config 注册表（`CONFIG_SETTINGS.taskTimeoutMs`），优先级仍是
// env > config.json > 常量默认，与仓库其余配置项走同一套解析（P9「配置面收口」）。
// 做成函数而不是模块级常量：改了 config.json 不必重启进程。
function defaultTaskTimeoutMs(): number {
  return configuredTaskTimeoutMs(600_000);
}

export class TaskTimeoutError extends Error {
  readonly timeout = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`task timed out after ${timeoutMs}ms`);
    this.name = "TaskTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TaskTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// W7-C2（V70 + V3）：pid 是否还活着。`kill(pid, 0)` 不发信号，只做存在性/权限检查——
// 与 simulation/run_store.ts 的 `isProcessAlive()` 逐字节同构（那边是核验子进程，这边
// 是核验持有 run() 闭包的服务进程自己），两处各留一份是刻意的：两个模块不互相 import，
// 避免 server/ 依赖 simulation/ 这类跨层耦合（足迹只允许改这两个文件，没有第三个
// 「共享 util」文件可落）。
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// W7-C2（V70 + V3）：查一个 pid 当前的启动时间，供落盘时记录、也供读回时对同一个 pid
// 再查一次做比对（V3 的核心判据：比对不上就是 pid 被复用）。
//
// 用 `ps -o lstart=`（macOS/Linux/BSD 通用）而不是 Linux 专属的 `/proc/<pid>/stat`——
// 后者更精确更快，但要另外读 `/proc/uptime` 换算、还要处理 comm 字段里可能带括号的
// 边界情况，是「可优先」的可选优化（任务书原文），本 lane 没有实现，双平台通用的
// `ps` 已经能满足「读回时核验」这个用途。只有秒级精度——只要写入时与读回时都用这同一个
// 函数查同一个 pid，两次结果在进程没换过的前提下逐字符相等，精度本身不影响判据。
//
// 查不到（pid 不存在、`ps` 不认识、没权限、命令本身超时）一律返回 null——调用方据此
// 标 `startTimeUnavailable`，不拿一个可能是瞎猜的时间戳去参与后续比对。
export function getProcessStartTime(pid: number | null | undefined): string | null {
  if (!pid || pid <= 0) return null;
  try {
    // `ps -o lstart=` 的输出不带时区（`"Fri Sep 11 14:17:56 2026"`）——`new Date()` 解析
    // 这种非 ISO 格式时是否按本地时区补全是 JS 引擎的实现细节，实测同一台机器上不同
    // 进程调用会给出不一致的结果（调试时真实撞到过：两个进程各查一次同一个 pid，一个
    // 按本地时区补全、一个当成 UTC 直接吃，差了 8 小时，把「同一个还活着的进程」判成
    // 了 orphaned）。显式给 `ps` 传 `TZ=UTC`（`ps` 认这个 env var，会把 lstart 按 UTC
    // 打印）、再在字符串末尾补一个 " UTC" 消歧义，两头都固定成同一个基准，才能保证
    // 「写入时查一次、读回时再查一次」逐字符可比。
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, TZ: "UTC" },
    }).trim();
    if (!out) return null;
    const parsed = new Date(`${out} UTC`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  } catch {
    return null;
  }
}

// W7-C2（V70 + V3）：读回时的核心判据。只在调用方已经确认「这条记录不是本进程亲手在跑」
// （`!entry.live`）、且状态仍是 running/pending 时才会被调用——本进程亲眼看着在跑的任务
// 不需要、也不应该去猜自己的 liveness。
//
// 返回 orphaned 的原因字符串；返回 null 表示「核验不出问题，继续按 running/pending 处理」
// ——查不出来（pid 存活但启动时间探测失败、或本来就没记录）不等于「查出来有问题」，
// 安全方向仍是「只多报不少报」（文件头大注释的既有纪律）。
function checkOrphaned(pid: number, pidStartedAt: string | null, startTimeUnavailable: boolean): string | null {
  if (!isProcessAlive(pid)) {
    return `pid ${pid} 已不存在——持有这个任务 run() 闭包的进程已经退出`;
  }
  if (startTimeUnavailable || pidStartedAt === null) return null; // 只能核存在性，存在就继续信。
  const currentStartedAt = getProcessStartTime(pid);
  if (currentStartedAt === null) return null; // 这次探测失败：不要用「测不到」误判成 orphaned。
  if (currentStartedAt !== pidStartedAt) {
    return `pid ${pid} 仍存活，但启动时间对不上（记录=${pidStartedAt}，此刻=${currentStartedAt}）——pid 已被复用，原进程已经不在了`;
  }
  return null;
}

// W7-C2（V70 + V3）：本进程自己的启动时间只可能有一个值，查一次记下来就够了——
// 没必要在每个 `start()` 调用上都重新 `ps` 一次（任务提交是「立刻返回句柄」的契约，
// 犯不着为了这个再加一次子进程调用的延迟）。惰性求值：真起了长任务才付这次查询成本。
let cachedOwnPidStartedAt: string | null | undefined;
function ownProcessStartTime(): string | null {
  if (cachedOwnPidStartedAt === undefined) {
    cachedOwnPidStartedAt = getProcessStartTime(process.pid);
  }
  return cachedOwnPidStartedAt;
}

export class TaskRegistry {
  private entries = new Map<string, TaskEntry>();
  private readonly now: () => string;
  // 只保留最近 N 条：本地单用户场景下够用，也避免长跑进程无上限吃内存。
  private readonly capacity: number;
  private readonly defaultTimeoutMs: number;
  // V11：给了 root 才落盘；不给就是纯内存实现，与落盘之前逐字节一致。
  private readonly tasksDir: string | null;

  constructor(options: { now?: () => string; capacity?: number; timeoutMs?: number; root?: string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.capacity = options.capacity ?? 200;
    this.defaultTimeoutMs = options.timeoutMs ?? defaultTaskTimeoutMs();
    this.tasksDir = options.root ? join(options.root, "tasks") : null;
    if (this.tasksDir) {
      mkdirSync(this.tasksDir, { recursive: true });
      this.hydrate();
      this.evict();
    }
  }

  // 进程启动时把磁盘上的快照读回内存。判据见文件头大注释：终态直接信；非终态打
  // `recovered` 标记（且把标记本身也落盘，重启两次不用重复计算/重复告警）。
  private hydrate(): void {
    if (!this.tasksDir) return;
    let names: string[];
    try {
      names = readdirSync(this.tasksDir).filter((n) => n.endsWith(".json") && !n.includes(".tmp-"));
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(this.tasksDir, name);
      let snapshot: TaskSnapshot;
      try {
        snapshot = JSON.parse(readFileSync(file, "utf8")) as TaskSnapshot;
      } catch {
        // 半写文件（进程正好在写的时候被杀）或其它损坏：跳过，不让一条坏文件挡住
        // 其余任务的恢复——这本身就是「done.json 优先」判据的延伸：读不出终态就当没有。
        continue;
      }
      if (!snapshot || typeof snapshot.id !== "string" || !TASK_STATES.includes(snapshot.state)) continue;
      const nonTerminal = snapshot.state === "running" || snapshot.state === "pending";
      const entry: TaskEntry = {
        snapshot,
        subscribers: new Set(),
        settled: Promise.resolve(snapshot),
        live: false,
      };
      if (nonTerminal && !snapshot.recovered) {
        snapshot.recovered = { at: this.now(), reason: "no-terminal-record-on-disk" };
        this.persist(entry);
      }
      this.entries.set(snapshot.id, entry);
    }
  }

  // 原子写：先写临时文件再 rename——避免另一个进程/读者在写到一半时读到截断的 JSON。
  private persist(entry: TaskEntry): void {
    if (!this.tasksDir) return;
    const file = join(this.tasksDir, `${entry.snapshot.id}.json`);
    const tmp = join(this.tasksDir, `${entry.snapshot.id}.json.tmp-${randomUUID()}`);
    writeFileSync(tmp, JSON.stringify(entry.snapshot, null, 2) + "\n");
    renameSync(tmp, file);
  }

  private removeFile(id: string): void {
    if (!this.tasksDir) return;
    const file = join(this.tasksDir, `${id}.json`);
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // 删不掉不影响正确性（磁盘上多留一份done任务的快照，最坏情况是 evict 没清干净）。
    }
  }

  start(options: StartTaskOptions): TaskSnapshot {
    const id = randomUUID();
    const createdAt = this.now();
    const snapshot: TaskSnapshot = {
      id,
      kind: options.kind,
      project: options.project ?? null,
      state: "pending",
      createdAt,
      startedAt: null,
      finishedAt: null,
      progress: null,
      result: null,
      error: null,
      events: [],
      recovered: null,
      // W7-C2（V70 + V3）：这个任务的 run() 闭包活在**本进程**里——记下本进程的 pid
      // 与启动时间，读回时（可能是重启后的另一个进程）才有据可查「当年那个进程还在不在」。
      pid: process.pid,
      pidStartedAt: ownProcessStartTime(),
      startTimeUnavailable: ownProcessStartTime() === null,
      orphanReason: null,
    };
    let resolveSettled: (value: TaskSnapshot) => void;
    const settled = new Promise<TaskSnapshot>((resolve) => {
      resolveSettled = resolve;
    });
    const entry: TaskEntry = { snapshot, subscribers: new Set(), settled, live: true };
    this.entries.set(id, entry);
    this.evict();

    const handle: TaskHandle = {
      progress: (done, total, message) => {
        if (entry.snapshot.state === "succeeded" || entry.snapshot.state === "failed") return;
        entry.snapshot.progress = { done, total, message: message ?? null };
        this.emit(entry, "progress", message ?? null, entry.snapshot.progress);
      },
      note: (message, data) => {
        if (entry.snapshot.state === "succeeded" || entry.snapshot.state === "failed") return;
        this.emit(entry, "progress", message, data ?? null);
      },
    };

    // 先把 pending → running 落下，再进异步体：轮询端点在第一次 tick 前也能看到正确状态。
    entry.snapshot.state = "running";
    entry.snapshot.startedAt = this.now();
    this.emit(entry, "state", "running", { state: "running" });

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    void (async () => {
      try {
        const result = await withTimeout(options.run(handle), timeoutMs);
        entry.snapshot.state = "succeeded";
        entry.snapshot.result = result ?? null;
        entry.snapshot.finishedAt = this.now();
        this.emit(entry, "result", null, result ?? null);
      } catch (error) {
        const timeout = error instanceof TaskTimeoutError;
        const message = error instanceof Error ? error.message : String(error);
        entry.snapshot.state = "failed";
        entry.snapshot.error = timeout ? { message, timeout: true } : { message };
        entry.snapshot.finishedAt = this.now();
        this.emit(entry, "error", message, { message, timeout });
      } finally {
        this.emit(entry, "state", entry.snapshot.state, { state: entry.snapshot.state });
        entry.subscribers.clear();
        resolveSettled!(entry.snapshot);
      }
    })();

    return entry.snapshot;
  }

  get(id: string): TaskSnapshot | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    this.applyLiveness(entry);
    return entry.snapshot;
  }

  list(filter: { project?: string; state?: TaskState; limit?: number } = {}): TaskSnapshot[] {
    const all = [...this.entries.values()]
      .map((e) => {
        this.applyLiveness(e);
        return e.snapshot;
      })
      .filter((s) => (filter.project ? s.project === filter.project : true))
      .filter((s) => (filter.state ? s.state === filter.state : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return filter.limit ? all.slice(0, filter.limit) : all;
  }

  // W7-C2（V70 + V3）：读回时的 liveness 交叉核验——`get()`/`list()` 是「lit tasks 数据面」
  // 与「exp status 数据面」（经由 shared.ts / session.ts 透传）唯一的两个读入口，判据只用
  // 落这一处，不散到各个调用方里各查一遍。
  private applyLiveness(entry: TaskEntry): void {
    const snapshot = entry.snapshot;
    // 本进程亲手在跑的任务：ground truth 就在这个闭包里，不需要、也不应该去猜自己的
    // liveness（猜出来的结论不可能比「我们本来就知道」更可信）。
    if (entry.live) return;
    // 已经是终态（含上一次判过的 orphaned）：不用再查一遍——orphaned 是单向的，死掉的
    // 进程不会用同一个身份复活。
    if (snapshot.state !== "running" && snapshot.state !== "pending") return;
    // V70 之前落盘的旧快照没有 pid 字段：查不了，维持既有「只多报不少报」口径。
    if (snapshot.pid == null) return;
    const reason = checkOrphaned(snapshot.pid, snapshot.pidStartedAt ?? null, snapshot.startTimeUnavailable === true);
    if (!reason) return;
    snapshot.state = "orphaned";
    snapshot.orphanReason = reason;
    this.persist(entry);
  }

  // 订阅返回「历史事件 + 取消订阅函数」：晚订阅者也拿得到开头。
  // 非 live（从磁盘恢复）的条目没有任何东西会再往里 emit——本进程没有对应的 run()，
  // 所以和终态一样，只补一次历史、不挂订阅（挂了也永远不会被触发，白占一个 Set 槽位）。
  subscribe(id: string, listener: (event: TaskEvent) => void): { history: TaskEvent[]; cancel: () => void } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const history = [...entry.snapshot.events];
    if (!entry.live || entry.snapshot.state === "succeeded" || entry.snapshot.state === "failed") {
      return { history, cancel: () => {} };
    }
    entry.subscribers.add(listener);
    return { history, cancel: () => entry.subscribers.delete(listener) };
  }

  // 等任务落定。给「同步模式」（`await=true`）与测试用；UI 走轮询/SSE。
  async settle(id: string): Promise<TaskSnapshot | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return entry.settled;
  }

  private emit(entry: TaskEntry, type: TaskEventType, message: string | null, data: unknown): void {
    const event: TaskEvent = {
      seq: entry.snapshot.events.length,
      at: this.now(),
      type,
      message,
      data,
    };
    entry.snapshot.events.push(event);
    for (const subscriber of entry.subscribers) {
      try {
        subscriber(event);
      } catch {
        // 单个订阅者（断开的 SSE 连接）不该影响任务本身。
      }
    }
    // V11：每次状态迁移 / progress / 结果 / 错误都原样落盘一份完整快照——
    // 任务体在两次事件之间的任意时刻被杀，磁盘上留的都是「上一次真实发生过的状态」，
    // 不会是半吊子的中间态（写文件本身是 persist() 里的 temp+rename，原子）。
    this.persist(entry);
  }

  private evict(): void {
    if (this.entries.size <= this.capacity) return;
    const done = [...this.entries.entries()]
      .filter(([, e]) => e.snapshot.state === "succeeded" || e.snapshot.state === "failed")
      .sort((a, b) => a[1].snapshot.createdAt.localeCompare(b[1].snapshot.createdAt));
    for (const [id] of done.slice(0, this.entries.size - this.capacity)) {
      this.entries.delete(id);
      this.removeFile(id);
    }
  }
}
