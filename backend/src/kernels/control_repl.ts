import type { KimiScienceDaemon } from "../daemon/daemon";

export const ALLOWED_MODULES = ["json", "os", "sys", "pathlib", "datetime", "uuid"] as const;

const MODULE_STUBS: Record<string, unknown> = {
  json: JSON,
  os: { platform: process.platform },
  sys: { version: "bun", platform: process.platform },
  pathlib: {
    Path: (p: string) => ({ path: p, name: p.split("/").pop(), toString: () => p }),
  },
  datetime: {
    now: () => new Date(),
    datetime: (y: number, m: number, d: number) => new Date(y, m - 1, d),
  },
  uuid: { uuid4: () => crypto.randomUUID(), v4: () => crypto.randomUUID() },
};

export class ControlRepl {
  private daemon: KimiScienceDaemon;
  private kernelId: string;

  constructor(daemon: KimiScienceDaemon, kernelId: string) {
    this.daemon = daemon;
    this.kernelId = kernelId;
  }

  private makeRequire() {
    return (mod: string) => {
      if (!(ALLOWED_MODULES as readonly string[]).includes(mod)) {
        throw new Error(
          `ControlRepl: module '${mod}' not allowed; allowed: ${ALLOWED_MODULES.join(", ")}`,
        );
      }
      return MODULE_STUBS[mod];
    };
  }

  async execute(code: string): Promise<{
    status: "ok" | "error";
    result?: any;
    stdout?: string;
    error?: string;
  }> {
    const logs: string[] = [];
    const sandbox = {
      require: this.makeRequire(),
      console: {
        log: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
        warn: (...a: unknown[]) => logs.push("warn: " + a.map(String).join(" ")),
        error: (...a: unknown[]) => logs.push("error: " + a.map(String).join(" ")),
      },
      mcp: {
        call: (server: string, tool: string, args?: any) =>
          this.daemon.handleKernelCall(this.kernelId, "mcp_call", { server, tool, args }),
      },
      createAgent: (config?: any) =>
        this.daemon.handleKernelCall(this.kernelId, "create_agent", config ?? {}),
      delegateTask: (spec?: any) =>
        this.daemon.handleKernelCall(this.kernelId, "delegate_task", spec ?? {}),
      queryFrames: (query?: any) =>
        this.daemon.handleKernelCall(this.kernelId, "query_frames", query ?? {}),
      manageSkills: (action?: any) =>
        this.daemon.handleKernelCall(this.kernelId, "manage_skills", action ?? {}),
      computeSubmit: (job?: any) =>
        this.daemon.handleKernelCall(this.kernelId, "compute_submit", job ?? {}),
    };

    const params = Object.keys(sandbox);
    const fn = new Function(
      ...params,
      `"use strict"; return (async () => {\n${code}\n})();`,
    );
    try {
      const result = await fn(...params.map((k) => (sandbox as Record<string, unknown>)[k]));
      return { status: "ok", result, stdout: logs.join("\n") };
    } catch (err) {
      return {
        status: "error",
        stdout: logs.join("\n"),
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      };
    }
  }
}
