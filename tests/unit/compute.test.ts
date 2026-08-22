import { describe, expect, test } from "bun:test";
import { ComputeManager } from "../../backend/src/compute/manager";
import { JobManager } from "../../backend/src/compute/job_manager";
import { CloudProvider, DockerProvider, SSHProvider } from "../../backend/src/compute/providers";

describe("ComputeManager", () => {
  test("registerDocker 注册 docker provider", () => {
    const manager = new ComputeManager();
    const provider = manager.registerDocker();
    expect(provider).toBeInstanceOf(DockerProvider);
    expect(provider.name).toBe("docker");
    expect(manager.listJobs()).toEqual([]);
  });

  test("registerSSH 注册 ssh provider（含 scheduler）", () => {
    const manager = new ComputeManager();
    const provider = manager.registerSSH("login01", "slurm");
    expect(provider).toBeInstanceOf(SSHProvider);
    expect(provider.name).toBe("ssh:login01");
    expect(provider.type).toBe("ssh");
    expect((provider as SSHProvider).scheduler).toBe("slurm");
  });

  test("registerCloud 注册 cloud provider（modal/volcengine）", () => {
    const manager = new ComputeManager();
    const provider = manager.registerCloud("modal", { gpu: "A100", region: "cn-beijing" });
    expect(provider).toBeInstanceOf(CloudProvider);
    expect(provider.name).toBe("modal");
    expect(provider.type).toBe("cloud");
    const vc = manager.registerCloud("volcengine", {});
    expect(vc.name).toBe("volcengine");
  });

  test("submitJob 返回 jobId 且非阻塞，状态为 submitted", async () => {
    const manager = new ComputeManager();
    manager.registerDocker();
    const jobId = await manager.submitJob("docker", "print('hello')", { n: 1 }, ["out.csv"]);
    expect(typeof jobId).toBe("string");
    const job = manager.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.providerName).toBe("docker");
    expect(job!.status).toBe("submitted");
    expect(job!.script).toBe("print('hello')");
  });

  test("waitAndHarvest 收获结果并置为 completed", async () => {
    const manager = new ComputeManager();
    manager.registerDocker();
    const jobId = await manager.submitJob("docker", "run()", { a: 1 }, ["r.json"]);
    const job = await manager.waitAndHarvest(jobId);
    expect(job.status).toBe("completed");
    expect(job.result).toBeDefined();
    expect(job.result).toHaveProperty("stdout");
    expect(job.result).toHaveProperty("exitCode");
    expect((job.result as { exitCode: number }).exitCode).toBe(0);
  });

  test("listJobs 返回所有任务", async () => {
    const manager = new ComputeManager();
    manager.registerDocker();
    manager.registerCloud("volcengine", {});
    const a = await manager.submitJob("docker", "a", {}, []);
    const b = await manager.submitJob("volcengine", "b", {}, []);
    expect(manager.listJobs().length).toBe(2);
    expect(manager.listJobs().map((j) => j.id).sort()).toEqual([a, b].sort());
  });

  test("submitJob 未注册 provider 抛错", async () => {
    const manager = new ComputeManager();
    await expect(manager.submitJob("nope", "x", {}, [])).rejects.toThrow(/not registered/);
  });

  test("waitAndHarvest 对未知 jobId 抛错", async () => {
    const manager = new ComputeManager();
    manager.registerDocker();
    await expect(manager.waitAndHarvest("missing")).rejects.toThrow(/unknown job/);
  });
});

describe("JobManager", () => {
  test("create/get/list", () => {
    const jm = new JobManager();
    const job = jm.create({ id: "j1", providerName: "docker", script: "s", inputs: {}, outputs: [] });
    expect(jm.get("j1")).toBe(job);
    expect(jm.list()).toEqual([job]);
  });

  test("状态转换 submitted -> running -> completed", () => {
    const jm = new JobManager();
    jm.create({ id: "j2", providerName: "docker", script: "s", inputs: {}, outputs: [] });
    jm.updateStatus("j2", "running");
    jm.updateStatus("j2", "completed", { ok: true });
    const job = jm.get("j2")!;
    expect(job.status).toBe("completed");
    expect(job.result).toEqual({ ok: true });
  });

  test("非法状态转换抛错", () => {
    const jm = new JobManager();
    jm.create({ id: "j3", providerName: "docker", script: "s", inputs: {}, outputs: [] });
    expect(() => jm.updateStatus("j3", "completed")).toThrow(/invalid job transition/);
    expect(() => jm.updateStatus("j3", "failed")).not.toThrow();
    expect(() => jm.updateStatus("j3", "running")).toThrow(/invalid job transition/);
  });

  test("对未知 jobId 更新抛错", () => {
    const jm = new JobManager();
    expect(() => jm.updateStatus("nope", "running")).toThrow(/unknown job/);
  });
});
