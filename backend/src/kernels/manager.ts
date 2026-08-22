import { existsSync } from "fs";
import { join } from "path";
import type { KimiScienceDaemon } from "../daemon/daemon";
import { ControlRepl } from "./control_repl";

export type KernelType = "python" | "r" | "control_repl";

export interface KernelResult {
  status: "ok" | "error";
  stdout?: string;
  stderr?: string;
  result?: any;
  error?: string;
}

function resolvePython(): string {
  const env = process.env.KIMI_PYTHON;
  if (env) return env;
  const venv = join(import.meta.dir, "../../../.venv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

export class PythonKernel {
  private proc: Subprocess | null = null;
  private python: string;
  private buffer = "";
  private waiters: ((line: string) => void)[] = [];
  private closed = false;

  constructor(python: string = resolvePython()) {
    this.python = python;
  }

  private ensureProc() {
    if (this.proc) return;
    const script = join(import.meta.dir, "python_kernel.py");
    this.proc = Bun.spawn([this.python, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.startReader();
    this.proc.exited
      .then(() => {
        this.closed = true;
        this.waiters.shift()?.("");
      })
      .catch(() => {});
  }

  private startReader() {
    (async () => {
      for await (const chunk of this.proc!.stdout) {
        this.buffer += Buffer.from(chunk).toString();
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          this.waiters.shift()?.(line);
        }
      }
    })();
  }

  async execute(code: string): Promise<KernelResult> {
    if (this.closed) throw new Error("PythonKernel: process exited");
    this.ensureProc();
    const linePromise = new Promise<string>((resolve) => this.waiters.push(resolve));
    this.proc!.stdin.write(JSON.stringify({ type: "execute", code }) + "\n");
    this.proc!.stdin.flush();
    const line = await linePromise;
    if (!line) throw new Error("PythonKernel: process exited without response");
    const parsed = JSON.parse(line);
    return {
      status: parsed.status,
      stdout: parsed.stdout ?? "",
      stderr: parsed.stderr ?? "",
      result: parsed.result,
      error: parsed.error,
    };
  }

  dispose() {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
      this.proc.stdin.flush();
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
  private daemon: KimiScienceDaemon | null = null;

  setDaemon(daemon: KimiScienceDaemon) {
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

  async execute(kernelId: string, code: string): Promise<KernelResult> {
    const kernel = this.kernels.get(kernelId);
    if (!kernel) throw new Error(`Unknown kernel: '${kernelId}'`);
    if (kernel.type === "python") return (kernel.repl as PythonKernel).execute(code);
    if (kernel.type === "control_repl") return (kernel.repl as ControlRepl).execute(code);
    return { status: "error", error: "R kernel execution not implemented yet" };
  }

  dispose() {
    for (const kernel of this.kernels.values()) {
      if (kernel.repl instanceof PythonKernel) kernel.repl.dispose();
    }
    this.kernels.clear();
  }
}
