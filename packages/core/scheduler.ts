import type { ScheduledJob } from "./contracts";
import { createId, now } from "./ids";
import { errorMessage } from "./errors";

/** Parse a single cron field (e.g., star-slash-5, 1-5, 1,3,5) into an array of matching values. */
export function parseCronField(field: string, min: number, max: number): number[] {
  const results: number[] = [];

  for (const part of field.split(",")) {
    let stepStr: string | undefined;
    let rangeStr = part;

    if (part.includes("/")) {
      [rangeStr = "", stepStr] = part.split("/");
    }

    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let start = min;
    let end = max;

    if (rangeStr === "*") {
      // default range
    } else if (rangeStr.includes("-")) {
      const [s = "0", e = "0"] = rangeStr.split("-");
      start = parseInt(s, 10);
      end = parseInt(e, 10);
    } else {
      const val = parseInt(rangeStr, 10);
      if (!stepStr) {
        results.push(val);
        continue;
      }
      start = val;
    }

    for (let i = start; i <= end; i += step) {
      results.push(i);
    }
  }

  return results.sort((a, b) => a - b);
}

/** Compute the next occurrence after `from` for a 5-field cron pattern. */
export function nextCronTick(pattern: string, from: Date): Date {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron pattern: expected 5 fields, got ${fields.length}`);

  const minutes = parseCronField(fields[0]!, 0, 59);
  const hours = parseCronField(fields[1]!, 0, 23);
  const daysOfMonth = parseCronField(fields[2]!, 1, 31);
  const months = parseCronField(fields[3]!, 1, 12);
  const daysOfWeek = parseCronField(fields[4]!, 0, 6);

  const hasDowConstraint = fields[4]! !== "*";
  const hasDomConstraint = fields[2]! !== "*";

  // Start searching from 1 minute after `from`
  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Safety: max 366 days of scanning
  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    const month = candidate.getUTCMonth() + 1;
    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    const hour = candidate.getUTCHours();
    const minute = candidate.getUTCMinutes();

    if (!months.includes(month)) {
      // Jump to next valid month
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dayMatch = hasDowConstraint && hasDomConstraint
      ? daysOfMonth.includes(dom) || daysOfWeek.includes(dow)
      : hasDowConstraint
        ? daysOfWeek.includes(dow)
        : hasDomConstraint
          ? daysOfMonth.includes(dom)
          : true;

    if (!dayMatch) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!hours.includes(hour)) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    if (!minutes.includes(minute)) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return new Date(candidate.getTime());
  }

  throw new Error(`Could not find next cron tick for '${pattern}' within 366 days.`);
}

export interface CreateJobInput {
  sessionId: string;
  createdBy: string;
  targetAgentId: string;
  task: string;
  schedule: ScheduledJob["schedule"];
  maxRuns?: number;
  /** Channel delivery target — if set, the job result is sent to this contact via the channel. */
  orgId?: string;
  orchestratorId?: string;
  contact?: string;
}

interface SchedulerOptions {
  persistJob: (job: ScheduledJob) => Promise<void>;
  restoreJobs: () => Promise<ScheduledJob[]>;
  /** Executes the agent task. Receives the full job so the runtime can pass channel context. */
  executeTask: (agentId: string, task: string, job: ScheduledJob) => Promise<string>;
  trace: (event: { type: string; status: string; runId: string; turnId: string; details?: Record<string, unknown> }) => Promise<void>;
  /** If provided, called after each successful execution when the job has a contact target. */
  deliverResult?: (job: ScheduledJob, result: string) => Promise<void>;
}

export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly opts: SchedulerOptions;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
  }

  addJob(input: CreateJobInput): ScheduledJob {
    const jobId = createId("job");
    const timestamp = now();

    let nextRunAt: number | undefined;
    let maxRuns = input.maxRuns;

    switch (input.schedule.type) {
      case "cron": {
        const next = nextCronTick(input.schedule.cron!, new Date(timestamp));
        nextRunAt = next.getTime();
        break;
      }
      case "once": {
        nextRunAt = input.schedule.runAt!;
        maxRuns = maxRuns ?? 1;
        break;
      }
      case "delay": {
        nextRunAt = timestamp + input.schedule.delayMs!;
        maxRuns = maxRuns ?? 1;
        break;
      }
    }

    const job: ScheduledJob = {
      jobId,
      sessionId: input.sessionId,
      createdBy: input.createdBy,
      targetAgentId: input.targetAgentId,
      task: input.task,
      schedule: input.schedule,
      status: "active",
      nextRunAt,
      runCount: 0,
      maxRuns,
      createdAt: timestamp,
      updatedAt: timestamp,
      orgId: input.orgId,
      orchestratorId: input.orchestratorId,
      contact: input.contact,
    };

    this.jobs.set(jobId, job);
    void this.opts.persistJob(job);
    this.armTimer(job);

    return { ...job };
  }

  removeJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    this.clearTimer(jobId);
    this.jobs.delete(jobId);
    return true;
  }

  pauseJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "active") return false;

    job.status = "paused";
    job.updatedAt = now();
    this.clearTimer(jobId);
    void this.opts.persistJob(job);
    return true;
  }

  resumeJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "paused") return false;

    job.status = "active";
    job.updatedAt = now();

    // Recompute nextRunAt
    if (job.schedule.type === "cron") {
      const next = nextCronTick(job.schedule.cron!, new Date());
      job.nextRunAt = next.getTime();
    }

    void this.opts.persistJob(job);
    this.armTimer(job);
    return true;
  }

  listJobs(): ScheduledJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  getJob(jobId: string): ScheduledJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : undefined;
  }

  async restore(): Promise<number> {
    const records = await this.opts.restoreJobs();
    let count = 0;
    for (const record of records) {
      if (record.status !== "active" && record.status !== "paused") continue;
      this.jobs.set(record.jobId, record);
      if (record.status === "active") {
        // Recompute nextRunAt and arm
        if (record.schedule.type === "cron") {
          record.nextRunAt = nextCronTick(record.schedule.cron!, new Date()).getTime();
        } else if (record.nextRunAt && record.nextRunAt <= now()) {
          // Past due — execute immediately
          record.nextRunAt = now();
        }
        this.armTimer(record);
      }
      count++;
    }
    return count;
  }

  shutdown(): void {
    for (const [jobId] of this.timers) {
      this.clearTimer(jobId);
    }
  }

  private armTimer(job: ScheduledJob): void {
    if (!job.nextRunAt) return;
    const delayMs = Math.max(0, job.nextRunAt - now());

    const handle = setTimeout(() => {
      void this.executeJob(job.jobId);
    }, delayMs);

    this.timers.set(job.jobId, handle);
  }

  private clearTimer(jobId: string): void {
    const handle = this.timers.get(jobId);
    if (handle) {
      clearTimeout(handle);
      this.timers.delete(jobId);
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "active") return;

    const runId = createId("run");
    const turnId = createId("turn");

    await this.opts.trace({
      type: "job_triggered",
      status: "running",
      runId,
      turnId,
      details: { jobId, targetAgentId: job.targetAgentId, task: job.task },
    });

    try {
      const result = await this.opts.executeTask(job.targetAgentId, job.task, job);

      job.runCount += 1;
      job.lastRunAt = now();
      job.updatedAt = now();

      await this.opts.trace({
        type: "job_completed",
        status: "completed",
        runId,
        turnId,
        details: { jobId, result: result.slice(0, 200) },
      });

      // Deliver result to channel contact if configured
      if (job.contact && this.opts.deliverResult) {
        try {
          await this.opts.deliverResult(job, result);
        } catch (err) {
          console.error(`[scheduler] delivery failed for job ${jobId}: ${errorMessage(err)}`);
        }
      }

      // Check if done
      if (job.maxRuns && job.runCount >= job.maxRuns) {
        job.status = "completed";
        job.nextRunAt = undefined;
        this.clearTimer(jobId);
      } else if (job.schedule.type === "cron") {
        // Re-arm for next occurrence
        job.nextRunAt = nextCronTick(job.schedule.cron!, new Date()).getTime();
        this.armTimer(job);
      }

      void this.opts.persistJob(job);
    } catch (err) {
      job.error = errorMessage(err);
      job.status = "failed";
      job.updatedAt = now();
      this.clearTimer(jobId);
      void this.opts.persistJob(job);

      await this.opts.trace({
        type: "job_failed",
        status: "error",
        runId,
        turnId,
        details: { jobId, error: job.error },
      });
    }
  }
}
