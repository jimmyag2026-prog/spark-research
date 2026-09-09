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
  state: SimRunState;
  pid: number | null;
  exitCode: number | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  entryPoint: string;
  params: Record<string, unknown>;
  expectedOutputs: string[];
  recoverable: boolean;
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
