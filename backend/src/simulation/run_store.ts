import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimRunState } from "./models";

// 运行状态的**磁盘真源**。
//
// 为什么不放内存：P5 的退出标准是「进程 kill 后能续跑」。只要 poll 依赖内存里的
// Subprocess 句柄，重启就必然断链。所以每个 run 一个目录，状态写 run.json，
// 结果由 runner 自己写 done.json —— 编排进程死了，任务照样在跑，重启后按磁盘接上。
//
//   <root>/<runId>/run.json     编排侧写的状态（pid / 参数 / 时间戳）
//                  params.json  runner 的输入
//                  done.json    runner 写的结果（存在即表示任务已终结）
//                  stdout.log   runner 的 stdout（tee 到文件，父进程死了也不丢）
//                  stderr.log
//                  <outputs...>

export interface RunRecord {
  runId: string;
  platform: string;
  kind: string;
  specHash: string;
  label: string | null;
  // W7-C2（V3）：`state` 比 `SimRunState`（models.ts，本 lane 足迹之外，未改）多一个
  // `"orphaned"` ——poll() 交叉核验 pid 身份失败时落这个值，见 platform.ts 与文件头
  // 「进程是否还活着」段。`SimulationPlatform.poll()` 对外的 `RunStatus.state` 仍然是
  // 原本的 `SimRunState`；platform.ts 在往外吐 `RunStatus` 的那一处做了收窄，这里的
  // `RunRecord` 是纯内部落盘结构，不受 `RunStatus` 类型收敛的约束，加宽不影响外部契约。
  state: SimRunState | "orphaned";
  pid: number | null;
  exitCode: number | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  entryPoint: string;
  params: Record<string, unknown>;
  expectedOutputs: string[];
  recoverable: boolean;
  // W7-C2（V3）：submit() 时记录 `pid` 那一刻的进程启动时间（`getProcessStartTime()`
  // 口径），供 poll() 读回时核验「现在占着这个 pid 的还是不是当年那个进程」。可选——
  // 旧记录（本 lane 之前落盘的、或 compute/sim_bridge.ts 那类 pid 恒为 null 的远端任务）
  // 没有这两个字段，`undefined` 按「查不了」处理，不当成错误（RunRecord 别处也是直接
  // object literal 构造，加成必填字段会连累 sim_bridge.ts 那个不在本 lane 足迹内的调用点）。
  pidStartedAt?: string | null;
  startTimeUnavailable?: boolean;
}

// runner 写的结果信封。status 之外的字段都由 adapter 的 runner 决定。
export interface DoneEnvelope {
  status: "completed" | "failed";
  summary?: Record<string, string | number | boolean | null>;
  files?: { filename: string; role: string }[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  wallSeconds?: number;
}

export class RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
  }

  dirOf(runId: string): string {
    return join(this.root, runId);
  }

  exists(runId: string): boolean {
    return existsSync(join(this.dirOf(runId), "run.json"));
  }

  create(record: RunRecord): RunRecord {
    mkdirSync(this.dirOf(record.runId), { recursive: true });
    this.write(record);
    return record;
  }

  read(runId: string): RunRecord | null {
    const file = join(this.dirOf(runId), "run.json");
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
    } catch {
      return null;
    }
  }

  write(record: RunRecord): void {
    writeFileSync(join(this.dirOf(record.runId), "run.json"), JSON.stringify(record, null, 2) + "\n");
  }

  patch(runId: string, patch: Partial<RunRecord>): RunRecord | null {
    const current = this.read(runId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.write(next);
    return next;
  }

  done(runId: string): DoneEnvelope | null {
    const file = join(this.dirOf(runId), "done.json");
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as DoneEnvelope;
      // 只认 runner 明确写出的两种终态；文件半写（进程正好在写的时候被杀）视为还没完成。
      if (parsed.status !== "completed" && parsed.status !== "failed") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  logTail(runId: string, name: "stdout.log" | "stderr.log", maxChars = 4000): string {
    const file = join(this.dirOf(runId), name);
    if (!existsSync(file)) return "";
    const text = readFileSync(file, "utf8");
    return text.length > maxChars ? `…（截断）\n${text.slice(-maxChars)}` : text;
  }

  list(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(this.root, e.name, "run.json")))
      .map((e) => e.name)
      .sort();
  }
}

// 进程是否还活着。kill(pid, 0) 不发信号，只做存在性 + 权限检查。
//
// 已知局限：PID 会被复用，理论上可能把一个无关的新进程认成我们的任务。
// 真正的兜底是 done.json —— poll 永远先看 done.json 再看 pid，
// 所以 PID 复用最坏只会让一个已死的任务多「running」一会儿，
// 不会把失败报成成功。
//
// W7-C2（V3）：上面这段「已知局限」现在有了部分收窄——`platform.ts` 的 poll() 在
// 「本进程没有这个 run 的活句柄」（跨进程读回）这条路径上，会额外拿 `getProcessStartTime()`
// 核验一次身份，缩小（不是消灭）pid 复用的误判窗口；`done.json` 优先的口径完全不变，
// 仍然是最终真源。
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但不属于我们；仍算活着。
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// W7-C2（V3）：查一个 pid 当前的启动时间——submit() 落盘时记一次，poll() 读回（跨进程/
// 没有活句柄）时对同一个 pid 再查一次，两次结果不相等就是 pid 被复用了。
//
// 与 server/tasks.ts 的同名函数逐字节同构（那边核验持有 HTTP 任务闭包的服务进程，这边
// 核验被 spawn 出来的算例子进程），两处各留一份是刻意的：server/ 与 simulation/ 互不
// import，避免跨层耦合（足迹里没有第三个「共享 util」文件可落这份代码）。
//
// 用 `ps -o lstart=`（macOS/Linux/BSD 通用）——Linux 专属的 `/proc/<pid>/stat` 更快更
// 精确，是任务书里「可优先」的可选优化，本 lane 未实现（双平台通用的 ps 已经够用，
// 见 docs/devlog/W7-C2.md）。只有秒级精度——只要写入、读回都用这同一个函数查同一个
// pid，两次结果在进程没换过的前提下逐字符相等，精度本身不影响判据。查不到（pid 不
// 存在、`ps` 不认识、没权限、命令超时）一律 null，调用方按 `startTimeUnavailable` 处理，
// 不拿一个可能是瞎猜的时间戳去参与比对。
export function getProcessStartTime(pid: number | null | undefined): string | null {
  if (!pid || pid <= 0) return null;
  try {
    // `ps -o lstart=` 的输出本身不带时区（`"Fri Sep 11 14:17:56 2026"`）——用 `new Date()`
    // 直接解析这种非 ISO 格式，是否按本地时区补全**是 JS 引擎的实现细节**，实测同一台机器
    // 上不同进程调用会给出不一致的结果（W7-C2 debug 时真实撞到过：两个 bun 进程各查一次
    // 同一个 pid，一个按本地时区补全、一个当成 UTC 直接吃，差了 8 小时，直接把「同一个
    // 还活着的进程」判成了 orphaned）。显式给 `ps` 传 `TZ=UTC`（`ps` 认这个 env var，会把
    // lstart 按 UTC 打印）、再在字符串末尾补一个 " UTC" 消歧义，两头都固定成同一个
    // 基准，才能保证「写入时查一次、读回时再查一次」逐字符可比。
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
