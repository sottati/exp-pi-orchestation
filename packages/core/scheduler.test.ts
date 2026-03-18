import { test, expect, describe } from "bun:test";
import { nextCronTick, parseCronField, Scheduler, type CreateJobInput } from "./scheduler";
import type { ScheduledJob } from "./contracts";

describe("parseCronField", () => {
  test("* matches all values in range", () => {
    const values = parseCronField("*", 0, 59);
    expect(values).toHaveLength(60);
  });

  test("specific number", () => {
    expect(parseCronField("5", 0, 59)).toEqual([5]);
  });

  test("range 1-5", () => {
    expect(parseCronField("1-5", 0, 59)).toEqual([1, 2, 3, 4, 5]);
  });

  test("step */5 in 0-59", () => {
    const values = parseCronField("*/5", 0, 59);
    expect(values).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  test("list 1,3,5", () => {
    expect(parseCronField("1,3,5", 0, 59)).toEqual([1, 3, 5]);
  });

  test("step with range 10-20/3", () => {
    expect(parseCronField("10-20/3", 0, 59)).toEqual([10, 13, 16, 19]);
  });
});

describe("nextCronTick", () => {
  test("every minute from known time", () => {
    // 2026-03-17 10:30:00 UTC
    const from = new Date("2026-03-17T10:30:00Z");
    const next = nextCronTick("* * * * *", from);
    expect(next.getTime()).toBe(new Date("2026-03-17T10:31:00Z").getTime());
  });

  test("every 5 minutes", () => {
    const from = new Date("2026-03-17T10:32:00Z");
    const next = nextCronTick("*/5 * * * *", from);
    expect(next.getTime()).toBe(new Date("2026-03-17T10:35:00Z").getTime());
  });

  test("specific hour and minute", () => {
    const from = new Date("2026-03-17T08:00:00Z");
    const next = nextCronTick("30 9 * * *", from);
    expect(next.getTime()).toBe(new Date("2026-03-17T09:30:00Z").getTime());
  });

  test("wraps to next day", () => {
    const from = new Date("2026-03-17T23:59:00Z");
    const next = nextCronTick("0 0 * * *", from);
    expect(next.getTime()).toBe(new Date("2026-03-18T00:00:00Z").getTime());
  });

  test("specific day of week (Monday=1)", () => {
    // 2026-03-17 is a Tuesday (day 2)
    const from = new Date("2026-03-17T12:00:00Z");
    const next = nextCronTick("0 9 * * 1", from); // Monday 9:00
    // Next Monday is 2026-03-23
    expect(next.getTime()).toBe(new Date("2026-03-23T09:00:00Z").getTime());
  });
});

function noopTrace() { return Promise.resolve(); }

function makeScheduler(overrides: {
  persistJob?: (job: ScheduledJob) => Promise<void>;
  restoreJobs?: () => Promise<ScheduledJob[]>;
  executeTask?: (agentId: string, task: string) => Promise<string>;
} = {}) {
  return new Scheduler({
    persistJob: overrides.persistJob ?? (async () => {}),
    restoreJobs: overrides.restoreJobs ?? (async () => []),
    executeTask: overrides.executeTask ?? (async () => "done"),
    trace: noopTrace as any,
  });
}

describe("Scheduler", () => {
  test("addJob creates a job with active status", () => {
    const scheduler = makeScheduler();
    const job = scheduler.addJob({
      sessionId: "s1",
      createdBy: "runtime",
      targetAgentId: "code",
      task: "health check",
      schedule: { type: "cron", cron: "*/5 * * * *" },
    });

    expect(job.status).toBe("active");
    expect(job.schedule.type).toBe("cron");
    expect(job.runCount).toBe(0);
    scheduler.shutdown();
  });

  test("addJob with delay type computes runAt", () => {
    const scheduler = makeScheduler();
    const before = Date.now();
    const job = scheduler.addJob({
      sessionId: "s1",
      createdBy: "orchestrator",
      targetAgentId: "math",
      task: "compute",
      schedule: { type: "delay", delayMs: 5000 },
    });

    expect(job.nextRunAt).toBeGreaterThanOrEqual(before + 5000);
    expect(job.maxRuns).toBe(1);
    scheduler.shutdown();
  });

  test("listJobs returns all jobs", () => {
    const scheduler = makeScheduler();
    scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "code", task: "a",
      schedule: { type: "cron", cron: "* * * * *" },
    });
    scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "math", task: "b",
      schedule: { type: "once", runAt: Date.now() + 60000 },
    });

    expect(scheduler.listJobs().length).toBe(2);
    scheduler.shutdown();
  });

  test("removeJob returns true for existing job", () => {
    const scheduler = makeScheduler();
    const job = scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "code", task: "x",
      schedule: { type: "once", runAt: Date.now() + 60000 },
    });

    expect(scheduler.removeJob(job.jobId)).toBe(true);
    expect(scheduler.getJob(job.jobId)).toBeUndefined();
    scheduler.shutdown();
  });

  test("removeJob returns false for unknown job", () => {
    const scheduler = makeScheduler();
    expect(scheduler.removeJob("nope")).toBe(false);
    scheduler.shutdown();
  });

  test("pauseJob and resumeJob toggle status", () => {
    const scheduler = makeScheduler();
    const job = scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "code", task: "x",
      schedule: { type: "cron", cron: "*/5 * * * *" },
    });

    expect(scheduler.pauseJob(job.jobId)).toBe(true);
    expect(scheduler.getJob(job.jobId)?.status).toBe("paused");

    expect(scheduler.resumeJob(job.jobId)).toBe(true);
    expect(scheduler.getJob(job.jobId)?.status).toBe("active");
    scheduler.shutdown();
  });

  test("shutdown clears all timers", () => {
    const scheduler = makeScheduler();
    scheduler.addJob({
      sessionId: "s1", createdBy: "runtime",
      targetAgentId: "code", task: "x",
      schedule: { type: "cron", cron: "* * * * *" },
    });
    // Should not throw
    scheduler.shutdown();
  });
});
