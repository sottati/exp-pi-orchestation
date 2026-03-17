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
