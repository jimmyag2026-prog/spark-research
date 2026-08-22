import { randomUUID } from "node:crypto";

export type JobStatus = "submitted" | "running" | "completed" | "failed";

export type ProviderType = "docker" | "ssh" | "cloud";

export type SchedulerKind = "slurm" | "pbs" | "lsf" | "none";

export type CloudBackend = "modal" | "volcengine";

export interface JobInit {
  id: string;
  providerName: string;
  script: string;
  inputs: Record<string, unknown>;
  outputs: string[];
}

export class Job {
  readonly id: string;
  readonly providerName: string;
  readonly script: string;
  readonly inputs: Record<string, unknown>;
  readonly outputs: string[];
  status: JobStatus = "submitted";
  result?: unknown;

  constructor(init: JobInit) {
    this.id = init.id;
    this.providerName = init.providerName;
    this.script = init.script;
    this.inputs = init.inputs;
    this.outputs = init.outputs;
  }
}

export interface ComputeProvider {
  readonly name: string;
  readonly type: ProviderType;
  submit(script: string, inputs: Record<string, unknown>, outputs: string[]): Promise<string>;
  wait(jobId: string): Promise<void>;
  harvest(jobId: string): Promise<unknown>;
}

// 模拟执行后端：submit 立即返回 jobId（非阻塞），setTimeout 模拟计算耗时后置为 completed。
// wait 轮询直到完成；harvest 返回模拟输出。MVP 阶段三个 provider 都走这里，不实际连接任何外部资源。
class SimulatedBackend {
  private jobs = new Map<string, { status: JobStatus; result: unknown }>();

  submit(script: string, inputs: Record<string, unknown>, outputs: string[]): string {
    const id = randomUUID();
    this.jobs.set(id, { status: "submitted", result: null });
    setTimeout(() => {
      this.jobs.set(id, {
        status: "completed",
        result: {
          jobId: id,
          exitCode: 0,
          stdout: `[mock] script executed\n${script}`,
          stderr: "",
          inputs,
          outputs,
        },
      });
    }, 20);
    return id;
  }

  async wait(jobId: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`unknown job: ${jobId}`);
      if (job.status === "completed" || job.status === "failed") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`job ${jobId} timed out`);
  }

  async harvest(jobId: string): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (job.status !== "completed") throw new Error(`job ${jobId} not completed`);
    return job.result;
  }
}

abstract class BaseProvider implements ComputeProvider {
  abstract readonly name: string;
  abstract readonly type: ProviderType;
  protected readonly runner = new SimulatedBackend();

  submit(script: string, inputs: Record<string, unknown>, outputs: string[]): Promise<string> {
    return Promise.resolve(this.runner.submit(script, inputs, outputs));
  }

  wait(jobId: string): Promise<void> {
    return this.runner.wait(jobId);
  }

  harvest(jobId: string): Promise<unknown> {
    return this.runner.harvest(jobId);
  }
}

// DockerProvider：MVP 用 child_process（Bun.spawnSync）探测本地 docker 是否可用；
// 无论是否可用，任务执行都走模拟（dockerAvailable 只作可观测标记），真实 `docker run` 在后续里程碑接入。
export class DockerProvider extends BaseProvider {
  readonly name = "docker";
  readonly type = "docker" as const;
  private dockerAvailable: boolean | null = null;

  get isDockerAvailable(): boolean | null {
    return this.dockerAvailable;
  }

  override async submit(
    script: string,
    inputs: Record<string, unknown>,
    outputs: string[],
  ): Promise<string> {
    await this.checkDocker();
    return super.submit(script, inputs, outputs);
  }

  private async checkDocker(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;
    try {
      const result = Bun.spawnSync(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        { stdout: "ignore", stderr: "ignore" },
      );
      this.dockerAvailable = result.exitCode === 0;
    } catch {
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }
}

// SSHProvider：MVP 只记录 host/scheduler 配置，不实际 SSH 连接，执行走本地模拟。
export class SSHProvider extends BaseProvider {
  readonly name: string;
  readonly type = "ssh" as const;

  constructor(
    readonly host: string,
    readonly scheduler: SchedulerKind,
  ) {
    super();
    this.name = `ssh:${host}`;
  }
}

// CloudProvider：MVP 只记录后端类型（modal/volcengine）与配置，不实际调云端 API，执行走本地模拟。
export class CloudProvider extends BaseProvider {
  readonly name: string;
  readonly type = "cloud" as const;

  constructor(
    readonly backend: CloudBackend,
    readonly config: Record<string, unknown>,
  ) {
    super();
    this.name = backend;
  }
}
