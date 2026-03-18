import { test, expect, beforeEach } from "bun:test";
import { ThreadStore } from "./thread-store";
import type { ScheduledJob } from "./contracts";
import { rmSync } from "node:fs";

const TEST_DIR = ".runtime-data-test-jobs";

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    jobId: overrides.jobId ?? "job_1",
    sessionId: "s1",
    createdBy: "runtime",
    targetAgentId: "code",
    task: "health check",
    schedule: { type: "cron", cron: "*/5 * * * *" },
    status: "active",
    runCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
});

test("appendJob and getJobRecords round-trip", async () => {
  const store = new ThreadStore({ sessionId: "s1", baseDir: TEST_DIR });
  const job = makeJob();
  await store.appendJob(job);

  const records = await store.getJobRecords();
  expect(records.length).toBe(1);
  expect(records[0].jobId).toBe("job_1");
});

test("getJobRecords deduplicates by jobId (last wins)", async () => {
  const store = new ThreadStore({ sessionId: "s1", baseDir: TEST_DIR });
  await store.appendJob(makeJob({ status: "active", runCount: 0 }));
  await store.appendJob(makeJob({ status: "completed", runCount: 3 }));

  const records = await store.getJobRecords();
  expect(records.length).toBe(1);
  expect(records[0].status).toBe("completed");
  expect(records[0].runCount).toBe(3);
});

test("getJobRecords returns empty array when no file", async () => {
  const store = new ThreadStore({ sessionId: "s1", baseDir: TEST_DIR });
  const records = await store.getJobRecords();
  expect(records).toEqual([]);
});
