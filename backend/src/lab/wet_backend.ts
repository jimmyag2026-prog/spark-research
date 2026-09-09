import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpentronsProgram } from "./opentrons_protocol";

// 湿实验执行后端（DESIGN 域 B2 · DEVELOPMENT_PLAN P6）。
//
// 两个实现：
//   opentrons_simulate  **默认**。跑 opentrons 官方模拟器，真实解析并执行协议脚本。
//   mock_devices        单测后端。不依赖 opentrons 安装，从编译产物合成等价形状的 run log。
//
// 为什么保留 mock：契约测试需要一个在**任何**环境都跑得通的实现（与 P5 的 pyref 同一条理由）。
// 但默认必须是真模拟器 —— mock 只能验「管线通不通」，验不了「协议合不合法」。
// 一个 opentrons 拒绝解析的脚本在 mock 后端一样会「跑成功」，那是最危险的假绿。
//
// 状态落盘：每次执行一个 run 目录 `<root>/<runId>/`，里面有
// `protocol.py`（执行的**就是**这个文件）/ `runlog.json` / `runlog.txt` / `done.json`。
// 沿用 P5 的「磁盘是真源」思路：done.json 由 python 侧原子写，编排侧只读不猜。
// 与 P5 的差别：湿实验模拟是秒级同步任务（实测单协议 30–60 ms），
// 所以这里 await 子进程结束，不做 detach + poll —— 那套复杂度只有长任务才配得上。

export interface WetRunLogEntry {
  index: number;
  depth: number;
  type: string;
  text: string;
  // 锚回编译产物里的步骤（来自协议里注入的 `[spark-step]` 标记）。
  stepId: string | null;
  action: string | null;
  volume?: number;
  repetitions?: number;
  seconds?: number;
  temperature?: number;
  rpm?: number;
  location?: string;
  source?: string;
  dest?: string;
  instrument?: string;
  reading?: unknown;
  note?: string;
}

export type WetSummaryValue = string | number | boolean | null;

export interface WetRunFile {
  path: string;
  filename: string;
  role: string;
  bytes: number;
}

export interface WetRunResult {
  backend: string;
  runId: string;
  runDir: string;
  status: "completed" | "failed";
  protocolHash: string;
  entries: WetRunLogEntry[];
  summary: Record<string, WetSummaryValue>;
  text: string;
  files: WetRunFile[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
  wallSeconds: number;
  detail: Record<string, WetSummaryValue>;
}

export interface WetBackendAvailability {
  ok: boolean;
  reason: string | null;
  detail: Record<string, string | number | boolean | null>;
}

export interface WetExecuteOptions {
  // run 目录的父目录，一般是 `<project>/experiments/opentrons/wet`。
  root: string;
  runId?: string;
  timeoutMs?: number;
}

export interface WetLabBackend {
  readonly id: string;
  readonly description: string;
  available(): Promise<WetBackendAvailability>;
  execute(program: OpentronsProgram, options: WetExecuteOptions): Promise<WetRunResult>;
}

export class WetRunError extends Error {
  constructor(
    message: string,
    readonly runDir: string | null = null,
  ) {
    super(message);
    this.name = "WetRunError";
  }
}

// Python 解释器解析：与 simulation/platform.ts 同一口径（SPARK_PYTHON > 仓库 .venv > python3）。
// 刻意复制而不是 import：lab 层不该为了一个路径函数把整个仿真层拖进依赖图。
export function resolveLabPython(): string {
  const env = process.env.SPARK_PYTHON;
  if (env) return env;
  const venv = join(import.meta.dir, "../../../.venv/bin/python");
  return existsSync(venv) ? venv : "python3";
}

const BACKEND_SCRIPT = join(import.meta.dir, "opentrons_backend.py");
const DEFAULT_TIMEOUT_MS = 120_000;

function nowIso(): string {
  return new Date().toISOString();
}

function prepareRunDir(options: WetExecuteOptions, backendId: string): { runId: string; dir: string } {
  const runId = options.runId ?? `${backendId}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const dir = join(options.root, runId);
  mkdirSync(dir, { recursive: true });
  return { runId, dir };
}

function collectFiles(dir: string, declared: Array<{ filename: string; role: string }>): WetRunFile[] {
  const files: WetRunFile[] = [];
  for (const entry of declared) {
    const path = join(dir, entry.filename);
    if (!existsSync(path)) continue;
    files.push({ path, filename: entry.filename, role: entry.role, bytes: statSync(path).size });
  }
  return files;
}

// ── 默认后端：Opentrons 官方模拟器 ────────────────────────────────────────────
export class OpentronsSimulatorBackend implements WetLabBackend {
  readonly id = "opentrons_simulate";
  readonly description = "Opentrons 官方模拟器（opentrons.simulate.simulate，Flex / Protocol API v2）";
  private readonly python: string;

  constructor(options: { python?: string } = {}) {
    this.python = options.python ?? resolveLabPython();
  }

  async available(): Promise<WetBackendAvailability> {
    const proc = Bun.spawn([this.python, BACKEND_SCRIPT, "--probe"], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      return {
        ok: false,
        reason:
          `opentrons 模拟器不可用（python=${this.python}, exit=${exitCode}）：` +
          `${stderr.trim().split("\n").slice(-2).join(" ")}。` +
          `安装：VIRTUAL_ENV=.venv uv pip install opentrons`,
        detail: { python: this.python, exitCode },
      };
    }
    let detail: Record<string, string | number | boolean | null> = { python: this.python };
    try {
      detail = { ...detail, ...(JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, never>) };
    } catch {
      detail.probe = stdout.trim().slice(0, 200);
    }
    return { ok: true, reason: null, detail };
  }

  async execute(program: OpentronsProgram, options: WetExecuteOptions): Promise<WetRunResult> {
    const { runId, dir } = prepareRunDir(options, this.id);
    const scriptPath = join(dir, "protocol.py");
    // 执行的**就是**落盘的这个文件：审计时能拿到与 run log 逐行对得上的源码。
    writeFileSync(scriptPath, program.source);
    writeFileSync(
      join(dir, "program.json"),
      JSON.stringify(
        {
          protocolId: program.protocolId,
          protocolHash: program.protocolHash,
          apiLevel: program.apiLevel,
          robotType: program.robotType,
          deck: program.deck,
          steps: program.steps.map((s) => ({ stepId: s.stepId, action: s.action, execution: s.execution })),
        },
        null,
        2,
      ) + "\n",
    );

    const startedAt = nowIso();
    const started = Date.now();
    const proc = Bun.spawn([this.python, BACKEND_SCRIPT, "--script", scriptPath, "--outdir", dir], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    let exitCode: number | null = null;
    let stderr = "";
    try {
      [exitCode, , stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const wallSeconds = Number(((Date.now() - started) / 1000).toFixed(3));

    const donePath = join(dir, "done.json");
    if (!existsSync(donePath)) {
      // 没有 done.json 就是「进程死了但没留终态」——不猜，直接报失败并指向 run 目录。
      throw new WetRunError(
        `opentrons 后端没有写出 done.json（exit=${exitCode}）：${stderr.trim().slice(-400) || "无错误输出"}`,
        dir,
      );
    }
    const done = JSON.parse(readFileSync(donePath, "utf8")) as {
      status: "completed" | "failed";
      summary?: Record<string, WetSummaryValue>;
      error?: string;
      opentronsVersion?: string;
      files?: Array<{ filename: string; role: string }>;
      startedAt?: string;
      finishedAt?: string;
      wallSeconds?: number;
    };

    let entries: WetRunLogEntry[] = [];
    let text = "";
    if (done.status === "completed") {
      const runlog = JSON.parse(readFileSync(join(dir, "runlog.json"), "utf8")) as {
        entries: WetRunLogEntry[];
      };
      entries = runlog.entries;
      text = readFileSync(join(dir, "runlog.txt"), "utf8");
    }

    const declared = done.files ?? [];
    const files = collectFiles(dir, [
      { filename: "protocol.py", role: "protocol" },
      ...declared,
    ]);

    return {
      backend: this.id,
      runId,
      runDir: dir,
      status: done.status,
      protocolHash: program.protocolHash,
      entries,
      summary: done.summary ?? {},
      text,
      files,
      error: done.error ?? null,
      startedAt: done.startedAt ?? startedAt,
      finishedAt: done.finishedAt ?? nowIso(),
      wallSeconds: done.wallSeconds ?? wallSeconds,
      detail: { opentronsVersion: done.opentronsVersion ?? null, exitCode },
    };
  }
}

// ── 单测后端：mock 设备层 ─────────────────────────────────────────────────────
//
// 从**编译产物**合成 run log（不从自然语言协议），所以它和真模拟器看到的是同一份输入，
// 产出的条目形状也一致。它验证的是「编排 → 执行 → 回收」这条管线，
// **不**验证协议在 Opentrons 上合不合法 —— 后者只有真模拟器说了算。
export class MockDeviceBackend implements WetLabBackend {
  readonly id = "mock_devices";
  readonly description = "mock 设备层（单测后端，不需要安装 opentrons；不校验协议合法性）";

  async available(): Promise<WetBackendAvailability> {
    return { ok: true, reason: null, detail: { backend: this.id } };
  }

  async execute(program: OpentronsProgram, options: WetExecuteOptions): Promise<WetRunResult> {
    const { runId, dir } = prepareRunDir(options, this.id);
    const startedAt = nowIso();
    const started = Date.now();
    writeFileSync(join(dir, "protocol.py"), program.source);

    const entries: WetRunLogEntry[] = [];
    const push = (entry: Omit<WetRunLogEntry, "index">) => {
      entries.push({ ...entry, index: entries.length });
    };
    for (const step of program.steps) {
      push({
        depth: 0,
        type: "step_marker",
        text: `[spark-step] ${step.stepId} ${step.action}`,
        stepId: step.stepId,
        action: step.action,
      });
      if (step.execution === "manual") {
        push({
          depth: 0,
          type: "note",
          text: `[spark-note] ${step.summary}`,
          stepId: step.stepId,
          action: step.action,
          note: step.summary,
        });
        continue;
      }
      for (const transfer of step.transfers) {
        push({
          depth: 0,
          type: "aspirate",
          text: `Aspirating ${transfer.volumeUl} uL from ${transfer.from}`,
          stepId: step.stepId,
          action: step.action,
          volume: transfer.volumeUl,
          location: transfer.from,
        });
        push({
          depth: 0,
          type: "dispense",
          text: `Dispensing ${transfer.volumeUl} uL into ${transfer.to}`,
          stepId: step.stepId,
          action: step.action,
          volume: transfer.volumeUl,
          location: transfer.to,
        });
      }
      if (step.action === "incubate" || step.action === "shake") {
        push({
          depth: 0,
          type: step.action === "incubate" ? "set_temperature" : "shake",
          text: step.summary,
          stepId: step.stepId,
          action: step.action,
        });
      }
      if (step.action === "read") {
        push({
          depth: 0,
          type: "read_result",
          text: `[spark-read] ${step.summary}`,
          stepId: step.stepId,
          action: step.action,
          reading: null,
        });
      }
    }

    const dispensed = entries
      .filter((e) => e.type === "dispense")
      .reduce((sum, e) => sum + (e.volume ?? 0), 0);
    const summary: Record<string, WetSummaryValue> = {
      runLogEntries: entries.length,
      protocolSteps: program.steps.length,
      aspirates: entries.filter((e) => e.type === "aspirate").length,
      dispenses: entries.filter((e) => e.type === "dispense").length,
      dispensedUl: Number(dispensed.toFixed(3)),
      readings: entries.filter((e) => e.type === "read_result").length,
    };
    const text = entries.map((e) => `${"\t".repeat(e.depth)}${e.text}`).join("\n");
    writeFileSync(join(dir, "runlog.json"), JSON.stringify({ entries, summary }, null, 2) + "\n");
    writeFileSync(join(dir, "runlog.txt"), text + "\n");
    writeFileSync(
      join(dir, "done.json"),
      JSON.stringify({ status: "completed", backend: this.id, summary }, null, 2) + "\n",
    );

    return {
      backend: this.id,
      runId,
      runDir: dir,
      status: "completed",
      protocolHash: program.protocolHash,
      entries,
      summary,
      text,
      files: collectFiles(dir, [
        { filename: "protocol.py", role: "protocol" },
        { filename: "runlog.json", role: "runlog" },
        { filename: "runlog.txt", role: "log" },
      ]),
      error: null,
      startedAt,
      finishedAt: nowIso(),
      wallSeconds: Number(((Date.now() - started) / 1000).toFixed(3)),
      detail: { backend: this.id },
    };
  }
}

export const WET_BACKEND_IDS = ["opentrons_simulate", "mock_devices"] as const;
export type WetBackendId = (typeof WET_BACKEND_IDS)[number];
// **默认是真模拟器**，不是 mock（DEVELOPMENT_PLAN P6 的明确要求）。
export const DEFAULT_WET_BACKEND: WetBackendId = "opentrons_simulate";

export function wetBackend(id: string = DEFAULT_WET_BACKEND): WetLabBackend {
  switch (id) {
    case "opentrons_simulate":
      return new OpentronsSimulatorBackend();
    case "mock_devices":
      return new MockDeviceBackend();
    default:
      throw new WetRunError(`未知湿实验后端 '${id}'（可用：${WET_BACKEND_IDS.join(", ")}）`);
  }
}
