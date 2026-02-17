import { Logger } from 'homebridge';

export type OneShotJobAction =
  | {
      type: 'set_hb_entity';
      entityId: string;
      on?: boolean;
      brightness?: number;
    }
  | {
      type: 'restart_homebridge';
      reason: string;
    };

export type OneShotJob = {
  id: string;
  createdAt: string;
  runAt: string; // ISO timestamp
  action: OneShotJobAction;
};

export type JobExecutor = (job: OneShotJob) => Promise<void>;
export type JobsProvider = () => OneShotJob[];
export type JobsPersister = (nextJobs: OneShotJob[]) => Promise<void>;

export class JobScheduler {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly log: Logger) {}

  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  sync(getJobs: JobsProvider, persistJobs: JobsPersister, executor: JobExecutor): void {
    const jobs = getJobs();
    const now = Date.now();

    // Drop jobs in the past (or with invalid timestamps) deterministically.
    const nextJobs = jobs.filter((job) => {
      const runAt = Date.parse(job.runAt);
      return Number.isFinite(runAt) && runAt > now;
    });
    if (nextJobs.length !== jobs.length) {
      void persistJobs(nextJobs);
    }

    const wanted = new Set(nextJobs.map((j) => j.id));

    // Clear removed timers.
    for (const [id, timer] of this.timers.entries()) {
      if (!wanted.has(id)) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
    }

    // Schedule new timers.
    for (const job of nextJobs) {
      if (this.timers.has(job.id)) {
        continue;
      }

      const runAt = new Date(job.runAt).getTime();
      const delayMs = runAt - Date.now();
      if (!Number.isFinite(runAt) || delayMs <= 0) {
        continue;
      }

      // Node timers max around 24.8 days due to int32 (implementation-dependent). Clamp by chaining.
      const scheduleNext = (): void => {
        const remainingMs = new Date(job.runAt).getTime() - Date.now();
        if (remainingMs <= 0) {
          void this.runJob(job, getJobs, persistJobs, executor);
          return;
        }

        const chunkMs = Math.min(remainingMs, 2_000_000_000);
        const timer = setTimeout(() => {
          this.timers.delete(job.id);
          scheduleNext();
        }, chunkMs);
        this.timers.set(job.id, timer);
      };

      scheduleNext();
    }
  }

  private async runJob(job: OneShotJob, getJobs: JobsProvider, persistJobs: JobsPersister, executor: JobExecutor): Promise<void> {
    try {
      await executor(job);
    } catch (error) {
      this.log.warn(`[LLMControl] Job ${job.id} failed: ${(error as Error).message}`);
    } finally {
      // Remove job after attempt.
      const next = getJobs().filter((j) => j.id !== job.id);
      await persistJobs(next);
    }
  }
}
