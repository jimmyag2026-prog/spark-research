import type { JobInit, JobStatus } from "./providers";
import { Job } from "./providers";

const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  submitted: ["running", "failed"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
};

export class JobManager {
  private jobs = new Map<string, Job>();

  create(init: JobInit): Job {
    const job = new Job(init);
    this.jobs.set(job.id, job);
    return job;
  }

  updateStatus(id: string, status: JobStatus, result?: unknown): Job {
    const job = this.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    if (status === job.status) return job;
    if (!VALID_TRANSITIONS[job.status].includes(status)) {
      throw new Error(`invalid job transition: ${job.status} -> ${status}`);
    }
    job.status = status;
    if (result !== undefined) job.result = result;
    return job;
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }
}
