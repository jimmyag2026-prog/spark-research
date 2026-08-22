import { JobManager } from "./job_manager";
import { CloudProvider, DockerProvider, SSHProvider } from "./providers";
import type { CloudBackend, ComputeProvider, Job, SchedulerKind } from "./providers";

export class ComputeManager {
  private providers = new Map<string, ComputeProvider>();
  private jobManager: JobManager;

  constructor(jobManager?: JobManager) {
    this.jobManager = jobManager ?? new JobManager();
  }

  registerDocker(): ComputeProvider {
    return this.register(new DockerProvider());
  }

  registerSSH(host: string, scheduler: SchedulerKind): ComputeProvider {
    return this.register(new SSHProvider(host, scheduler));
  }

  registerCloud(backend: CloudBackend, config: Record<string, unknown>): ComputeProvider {
    return this.register(new CloudProvider(backend, config));
  }

  async submitJob(
    providerName: string,
    script: string,
    inputs: Record<string, unknown>,
    outputs: string[],
  ): Promise<string> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`compute provider not registered: ${providerName}`);
    const jobId = await provider.submit(script, inputs, outputs);
    this.jobManager.create({ id: jobId, providerName, script, inputs, outputs });
    return jobId;
  }

  async waitAndHarvest(jobId: string): Promise<Job> {
    const job = this.jobManager.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    const provider = this.providers.get(job.providerName);
    if (!provider) throw new Error(`compute provider not registered: ${job.providerName}`);
    this.jobManager.updateStatus(jobId, "running");
    await provider.wait(jobId);
    const result = await provider.harvest(jobId);
    this.jobManager.updateStatus(jobId, "completed", result);
    return this.jobManager.get(jobId)!;
  }

  listJobs(): Job[] {
    return this.jobManager.list();
  }

  getJob(jobId: string): Job | undefined {
    return this.jobManager.get(jobId);
  }

  private register(provider: ComputeProvider): ComputeProvider {
    this.providers.set(provider.name, provider);
    return provider;
  }
}
