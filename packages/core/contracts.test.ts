import { test, expect } from "bun:test";
import type {
  Permission,
  ScheduledJob,
  RunContext,
  BaseAgentId,
  TraceEvent,
} from "./contracts";

test("BaseAgentId accepts arbitrary strings", () => {
  const id: BaseAgentId = "my-custom-agent";
  expect(id).toBe("my-custom-agent");
});

test("RunContext accepts optional delegation fields", () => {
  const ctx: RunContext = {
    runId: "run_1",
    turnId: "turn_1",
    sessionId: "s1",
  };
  expect(ctx.delegationDepth).toBeUndefined();
  expect(ctx.delegationChain).toBeUndefined();

  const ctxWithDelegation: RunContext = {
    ...ctx,
    delegationDepth: 2,
    delegationChain: ["orchestrator", "code"],
  };
  expect(ctxWithDelegation.delegationDepth).toBe(2);
  expect(ctxWithDelegation.delegationChain).toEqual(["orchestrator", "code"]);
});

test("Permission type accepts valid values", () => {
  const allow: Permission = "allow";
  const deny: Permission = "deny";
  const hitl: Permission = "hitl";
  expect([allow, deny, hitl]).toEqual(["allow", "deny", "hitl"]);
});

test("ScheduledJob has required fields", () => {
  const job: ScheduledJob = {
    jobId: "job_1",
    sessionId: "s1",
    createdBy: "orchestrator",
    targetAgentId: "code",
    task: "Run health check",
    schedule: { type: "cron", cron: "*/5 * * * *" },
    status: "active",
    runCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  expect(job.jobId).toBe("job_1");
  expect(job.schedule.type).toBe("cron");
});

test("ScheduledJob supports 'once' schedule variant", () => {
  const now = Date.now();
  const job: ScheduledJob = {
    jobId: "job_2",
    sessionId: "s1",
    createdBy: "orchestrator",
    targetAgentId: "math",
    task: "One-time report",
    schedule: { type: "once", runAt: now + 60_000 },
    status: "completed",
    maxRuns: 1,
    runCount: 1,
    createdAt: now,
    updatedAt: now,
    lastRunAt: now + 60_000,
    nextRunAt: undefined,
    error: undefined,
  };
  expect(job.schedule.type).toBe("once");
  expect(job.schedule.runAt).toBeGreaterThan(now);
  expect(job.status).toBe("completed");
  expect(job.maxRuns).toBe(1);
});

test("ScheduledJob supports 'delay' schedule variant with optional fields", () => {
  const now = Date.now();
  const job: ScheduledJob = {
    jobId: "job_3",
    sessionId: "s1",
    createdBy: "orchestrator",
    targetAgentId: "code",
    task: "Delayed task",
    schedule: { type: "delay", delayMs: 5000 },
    status: "failed",
    runCount: 2,
    maxRuns: 3,
    createdAt: now,
    updatedAt: now,
    lastRunAt: now - 1000,
    error: "timeout exceeded",
  };
  expect(job.schedule.type).toBe("delay");
  expect(job.schedule.delayMs).toBe(5000);
  expect(job.status).toBe("failed");
  expect(job.error).toBe("timeout exceeded");
  expect(job.maxRuns).toBe(3);
  expect(job.lastRunAt).toBeDefined();
});

test("TraceEvent type includes new event types", () => {
  const types: TraceEvent["type"][] = [
    "run_started", "run_completed", "run_failed",
    "message_routed", "tool_start", "tool_end",
    "chat_created", "chat_started", "chat_retry",
    "chat_completed", "chat_failed", "chat_cancelled",
    "tool_unavailable", "mcp_server_failed",
    "tool_permission_check", "tool_hitl_requested",
    "tool_hitl_approved", "tool_hitl_denied", "tool_hitl_timeout",
    "job_created", "job_triggered", "job_completed",
    "job_failed", "job_cancelled", "job_paused", "job_resumed",
  ];
  expect(types.length).toBeGreaterThan(0);
});
