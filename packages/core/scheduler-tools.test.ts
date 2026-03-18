import { test, expect, describe } from "bun:test";
import { createSchedulerToolEntries } from "./scheduler-tools";
import { Scheduler } from "./scheduler";
import type { ToolEntry } from "./tool-registry";

function makeScheduler() {
  return new Scheduler({
    persistJob: async () => {},
    restoreJobs: async () => [],
    executeTask: async () => "done",
    trace: async () => {},
  });
}

describe("createSchedulerToolEntries", () => {
  test("returns 3 tools with correct names", () => {
    const entries = createSchedulerToolEntries({
      scheduler: makeScheduler(),
      sessionId: "s1",
      callerAgentId: "orchestrator",
      allowedTargets: null,
    });
    const names = entries.map(e => e.name);
    expect(names).toContain("schedule_task");
    expect(names).toContain("list_scheduled_jobs");
    expect(names).toContain("cancel_scheduled_job");
  });

  test("schedule_task has hitl permission, list has allow, cancel has hitl", () => {
    const entries = createSchedulerToolEntries({
      scheduler: makeScheduler(),
      sessionId: "s1",
      callerAgentId: "orchestrator",
      allowedTargets: null,
    });
    const perms = Object.fromEntries(entries.map(e => [e.name, e.defaultPermission]));
    expect(perms["schedule_task"]).toBe("hitl");
    expect(perms["list_scheduled_jobs"]).toBe("allow");
    expect(perms["cancel_scheduled_job"]).toBe("hitl");
  });

  test("schedule_task validates targetAgentId against allowedTargets", async () => {
    const scheduler = makeScheduler();
    const entries = createSchedulerToolEntries({
      scheduler,
      sessionId: "s1",
      callerAgentId: "code",
      allowedTargets: ["math"],
    });
    const scheduleTool = entries.find(e => e.name === "schedule_task")!;

    // Allowed target
    const ok = await scheduleTool.execute("tc1", {
      targetAgentId: "math", task: "compute", cron: "* * * * *",
    });
    expect((ok.content[0] as any).text).toContain("Scheduled");

    // Self is always allowed
    const self = await scheduleTool.execute("tc2", {
      targetAgentId: "code", task: "self task", cron: "0 * * * *",
    });
    expect((self.content[0] as any).text).toContain("Scheduled");

    // Not allowed target
    const denied = await scheduleTool.execute("tc3", {
      targetAgentId: "search", task: "find", cron: "0 0 * * *",
    });
    expect((denied.content[0] as any).text).toContain("not allowed");

    scheduler.shutdown();
  });

  test("list_scheduled_jobs returns current jobs", async () => {
    const scheduler = makeScheduler();
    scheduler.addJob({
      sessionId: "s1", createdBy: "test",
      targetAgentId: "code", task: "x",
      schedule: { type: "cron", cron: "* * * * *" },
    });

    const entries = createSchedulerToolEntries({
      scheduler, sessionId: "s1",
      callerAgentId: "orchestrator", allowedTargets: null,
    });
    const listTool = entries.find(e => e.name === "list_scheduled_jobs")!;
    const result = await listTool.execute("tc1", {});
    expect((result.content[0] as any).text).toContain("code");
    scheduler.shutdown();
  });
});
