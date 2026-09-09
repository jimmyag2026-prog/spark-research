import { existsSync } from "fs";
import { join } from "path";
import type { SparkResearchDaemon } from "../daemon/daemon";
import { ControlRepl } from "./control_repl";

export type KernelType = "python" | "r" | "control_repl";

export interface KernelResult {
  status: "ok" | "error";
  stdout?: string;
  stderr?: string;
  result?: any;
  error?: string;
  // D-2：这次 execute 是否因为超时被中止（区别于「上游/用户代码自己报的 error」）。
  timedOut?: boolean;
}

export interface KernelExecuteOptions {
  // 单次 execute 的超时上限（毫秒）。省略则用模块级默认（见 DEFAULT_KERNEL_TIMEOUT_MS）；
  // 传 0 或负数显式关闭超时。
  timeoutMs?: number;
}

function resolvePython(): string {
  const env = process.env.SPARK_PYTHON;
  if (env) return env;
  const venv = join(import.meta.dir, "../../../.venv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

// D-2：config/ 面板（P9）没有对应设置项（只读不改，见 docs/devlog/P10-b.md），
// 走 env + 常量默认。120s 对照 backend/src/lab/wet_backend.ts 的
// DEFAULT_TIMEOUT_MS（同为「一次子进程调用整体等多久算挂」的量级）。
const DEFAULT_KERNEL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SPARK_KERNEL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

export class KernelTimeoutError extends Error {
  readonly timeout = true;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`kernel execute timed out after ${timeoutMs}ms`);
    this.name = "KernelTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// D-3：OS 级 stderr pipe 的尾部保留多少字节用于诊断（进程异常退出时能给出线索）。
// 这只是「保留多少」——排空本身（下面 startStderrDrain）才是修死锁的关键；
// 尾部大小小一点没关系，反正 python_kernel.py 把每次 execute() 的用户级 stderr
// 通过 stdout 的 JSON 协议正常传回来了，这里排的是旁路的 OS 级写入（native 扩展、
// 继承 fd 的子进程等）。
const STDERR_TAIL_LIMIT = 8 * 1024;

export class PythonKernel {
  private proc: import("bun").Subprocess | null = null;
  private python: string;
  private buffer = "";
  private waiters: ((line: string) => void)[] = [];
  private closed = false;
  private stderrTail = "";

  constructor(python: string = resolvePython()) {
    this.python = python;
  }

  private ensureProc() {
    if (this.proc) return;
    const script = join(import.meta.dir, "python_kernel.py");
    const proc = Bun.spawn([this.python, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.startReader(proc);
    this.startStderrDrain(proc);
    proc.exited
      .then(() => {
        // 只有「当前仍是这同一个 proc」时才把 kernel 标记为永久关闭——
        // D-2 的超时路径会主动 kill 掉一个挂起的旧进程再换上新的，
        // 旧进程稍后异步落地的 exited 不该反过来把新进程也判死刑。
        if (this.proc !== proc) return;
        this.closed = true;
        this.waiters.splice(0, this.waiters.length).forEach((w) => w(""));
      })
      .catch(() => {});
  }

  private startReader(proc: import("bun").Subprocess) {
    (async () => {
      const stdout = proc.stdout;
      if (typeof stdout === "number" || !stdout) return;
      try {
        for await (const chunk of stdout) {
          this.buffer += Buffer.from(chunk).toString();
          let idx: number;
          while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            this.waiters.shift()?.(line);
          }
        }
      } catch {
        // 进程被 kill（D-2 超时路径）时流会被强制关闭，这是正常收尾，不是错误。
      }
    })();
  }

  // D-3：stderr pipe 必须持续被读走。python_kernel.py 在每次 execute() 内部把
  // sys.stderr 重定向进 StringIO 并通过 stdout 的 JSON 响应回传用户代码的 stderr——
  // 但 OS 级的 fd 2（native 扩展直接 write、继承 fd 的子进程等旁路写入）不受那层重定向
  // 影响，照样落到这里的 proc.stderr。不读就是不排空：Bun/OS 的管道缓冲区（常见 64KB）
  // 写满后，子进程会永久阻塞在 write(2) 上——这就是「kernel 死锁」的真正机制，
  // 和 stdout 上的行协议完全是两回事。只保留一小段尾部用于诊断，其余丢弃即可，
  // 排空动作本身不需要也不应该无界持有内存。
  private startStderrDrain(proc: import("bun").Subprocess) {
    (async () => {
      const stderr = proc.stderr;
      if (typeof stderr === "number" || !stderr) return;
      try {
        for await (const chunk of stderr) {
          this.stderrTail = (this.stderrTail + Buffer.from(chunk).toString()).slice(-STDERR_TAIL_LIMIT);
        }
      } catch {
        // 同上：进程退出/被 kill 时属于正常收尾。
      }
    })();
  }

  async execute(code: string, options: KernelExecuteOptions = {}): Promise<KernelResult> {
    if (this.closed) throw new Error("PythonKernel: process exited");
    this.ensureProc();
    if (!this.proc) throw new Error("PythonKernel: process not started");
    const stdin = this.proc.stdin;
    if (typeof stdin === "number" || !stdin) throw new Error("PythonKernel: stdin not available");

    const timeoutMs = options.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
    const state = { done: false };
    const linePromise = new Promise<string>((resolve) => {
      this.waiters.push((line) => {
        state.done = true;
        resolve(line);
      });
    });

    stdin.write(JSON.stringify({ type: "execute", code }) + "\n");
    stdin.flush();

    const line = await new Promise<string>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (state.done) return;
              state.done = true;
              // D-2：这条 REPL 是严格顺序的单个 in-flight 请求，没法只取消这一次
              // execute()——只能杀掉整个子进程「隔离」这次挂起的执行；下一次
              // execute() 会透明地重新拉起一个干净进程（ensureProc 的
              // `if (this.proc) return` 在 killAndReset 把 this.proc 置空后
              // 自然会重新 spawn）。之前挂起那次调用的用户代码状态（namespace）
              // 随之丢失——这是杀进程本身的代价，不是本次改动引入的新行为。
              this.killAndReset();
              reject(new KernelTimeoutError(timeoutMs));
            }, timeoutMs)
          : null;
      linePromise.then((l) => {
        if (timer) clearTimeout(timer);
        resolve(l);
      });
    });

    if (!line) {
      const tail = this.stderrTail.trim();
      throw new Error(
        `PythonKernel: process exited without response${tail ? ` (stderr tail: ${tail.slice(-500)})` : ""}`,
      );
    }
    const parsed = JSON.parse(line);
    return {
      status: parsed.status,
      stdout: parsed.stdout ?? "",
      stderr: parsed.stderr ?? "",
      result: parsed.result,
      error: parsed.error,
    };
  }

  private killAndReset() {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.kill();
    } catch {}
    this.proc = null;
    this.buffer = "";
    // 遗留在 waiters 里等这次挂起响应的回调（正常情况下只有这一个，协议是严格
    // 顺序的）一并放行，避免它们永远等不到任何回应而挂死调用方。
    this.waiters.splice(0, this.waiters.length).forEach((w) => w(""));
  }

  dispose() {
    if (!this.proc) return;
    try {
      const stdin = this.proc.stdin;
      if (typeof stdin !== "number" && stdin) {
        stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
        stdin.flush();
      }
    } catch {}
    this.proc.kill();
    this.proc = null;
  }
}

interface KernelHandle {
  id: string;
  type: KernelType;
  repl: PythonKernel | ControlRepl | null;
}

export class KernelManager {
  private kernels = new Map<string, KernelHandle>();
  private seq = 0;
  private daemon: SparkResearchDaemon | null = null;

  setDaemon(daemon: SparkResearchDaemon) {
    this.daemon = daemon;
  }

  createKernel(kernelType: KernelType): string {
    const id = `kernel_${++this.seq}`;
    let repl: PythonKernel | ControlRepl | null = null;
    switch (kernelType) {
      case "python":
        repl = new PythonKernel();
        break;
      case "control_repl": {
        if (!this.daemon) throw new Error("KernelManager: daemon not attached");
        repl = new ControlRepl(this.daemon, id);
        break;
      }
      case "r":
        repl = null;
        break;
      default:
        throw new Error(`Unknown kernel type: '${String(kernelType)}'`);
    }
    this.kernels.set(id, { id, type: kernelType, repl });
    return id;
  }

  getKernelType(kernelId: string): KernelType {
    const kernel = this.kernels.get(kernelId);
    if (!kernel) throw new Error(`Unknown kernel: '${kernelId}'`);
    return kernel.type;
  }

  // D-2：由调用方传 timeoutMs（省略则用各 repl 自己的模块级默认）。
  async execute(kernelId: string, code: string, options: KernelExecuteOptions = {}): Promise<KernelResult> {
    const kernel = this.kernels.get(kernelId);
    if (!kernel) throw new Error(`Unknown kernel: '${kernelId}'`);
    if (kernel.type === "python") {
      // PythonKernel 自己实现「杀掉子进程」式的超时隔离（见上）——这是真正意义上
      // 能中止挂起执行的那条路径。
      return (kernel.repl as PythonKernel).execute(code, options);
    }
    if (kernel.type === "control_repl") {
      // ControlRepl 在同一事件循环里同步跑用户代码（`new Function(...)`），真正的
      // 死循环没法被 Promise.race 抢占——JS 单线程，跑起来之前定时器回调进不去。
      // 这里能兜住的是「代码本身是 async 且卡在某个永远不 resolve 的 await 上」这一类
      // 更常见的挂起（例如 daemon 分派的方法未来变成真异步之后卡住），把它变成一个
      // 可见的超时错误而不是让调用方无限等；纯 CPU 死循环仍然只能拖到进程级兜底。
      // 已在 docs/devlog/P10-b.md 记录这条局限，不在本 lane 里用 Worker 线程强杀改造它。
      const timeoutMs = options.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
      return this.raceControlRepl(kernel.repl as ControlRepl, code, timeoutMs);
    }
    return { status: "error", error: "R kernel execution not implemented yet" };
  }

  private raceControlRepl(repl: ControlRepl, code: string, timeoutMs: number): Promise<KernelResult> {
    const run = repl.execute(code);
    if (timeoutMs <= 0) return run;
    return new Promise<KernelResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ status: "error", error: new KernelTimeoutError(timeoutMs).message, timedOut: true });
      }, timeoutMs);
      run.then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: "error", error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        },
      );
    });
  }

  // 不传 id：全量销毁，只给「进程退出」这类场景用。
  // 传 id：D-5——只销毁调用方自己创建的那个内核，不影响并发会话里其它还在跑的内核。
  dispose(kernelId?: string) {
    if (kernelId !== undefined) {
      const kernel = this.kernels.get(kernelId);
      if (!kernel) return;
      if (kernel.repl instanceof PythonKernel) kernel.repl.dispose();
      this.kernels.delete(kernelId);
      return;
    }
    for (const kernel of this.kernels.values()) {
      if (kernel.repl instanceof PythonKernel) kernel.repl.dispose();
    }
    this.kernels.clear();
  }
}
