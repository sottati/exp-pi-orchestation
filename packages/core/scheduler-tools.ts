import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { Scheduler } from "./scheduler";

interface SchedulerToolOptions {
  scheduler: Scheduler;
  sessionId: string;
  callerAgentId: string;
  allowedTargets: string[] | null; // null = any target allowed (orchestrator)
  /** Channel context inherited from the current run — used as default delivery target. */
  orgId?: string;
  orchestratorId?: string;
  defaultContact?: string;
}

export function createSchedulerToolEntries(opts: SchedulerToolOptions): ToolEntry[] {
  const { scheduler, sessionId, callerAgentId, allowedTargets, orgId, orchestratorId, defaultContact } = opts;

  const scheduleTask: ToolEntry = {
    name: "schedule_task",
    source: "local",
    description: "Schedule a task for an agent (cron, once, or delayed).",
    parameters: Type.Object({
      targetAgentId: Type.String({ description: "Agent to execute the task." }),
      task: Type.String({ description: "Task description." }),
      cron: Type.Optional(Type.String({ description: "Cron pattern (5-field)." })),
      runAt: Type.Optional(Type.String({ description: "ISO date for one-time execution." })),
      delayMs: Type.Optional(Type.Number({ description: "Delay in ms from now." })),
      contact: Type.Optional(Type.String({ description: "WhatsApp contact number to send the result to. Defaults to the contact who created the reminder." })),
    }),
    execute: async (_toolCallId, params) => {
      const target = params.targetAgentId as string;

      // Validate target: must be self or in allowedTargets
      if (target !== callerAgentId && allowedTargets !== null && !allowedTargets.includes(target)) {
        return {
          content: [{ type: "text" as const, text: `Target '${target}' is not allowed. Allowed: self (${callerAgentId}), ${(allowedTargets ?? []).join(", ")}.` }],
          details: {},
        };
      }

      const schedule = params.cron
        ? { type: "cron" as const, cron: params.cron as string }
        : params.runAt
          ? { type: "once" as const, runAt: new Date(params.runAt as string).getTime() }
          : { type: "delay" as const, delayMs: params.delayMs as number };

      const resolvedContact = (params.contact as string | undefined) ?? defaultContact;

      const job = scheduler.addJob({
        sessionId,
        createdBy: callerAgentId,
        targetAgentId: target,
        task: params.task as string,
        schedule,
        orgId,
        orchestratorId,
        contact: resolvedContact,
      });

      return {
        content: [{ type: "text" as const, text: `Scheduled job ${job.jobId} for ${target}. Next run: ${job.nextRunAt ? new Date(job.nextRunAt).toISOString() : "computing"}.` }],
        details: {},
      };
    },
    defaultPermission: "hitl",
    available: true,
  };

  const listJobs: ToolEntry = {
    name: "list_scheduled_jobs",
    source: "local",
    description: "List all active and paused scheduled jobs.",
    parameters: Type.Object({}),
    execute: async () => {
      const jobs = scheduler.listJobs();
      if (jobs.length === 0) {
        return { content: [{ type: "text" as const, text: "No scheduled jobs." }], details: {} };
      }
      const summary = jobs.map(j =>
        `${j.jobId}: ${j.targetAgentId} - "${j.task}" [${j.status}] next=${j.nextRunAt ? new Date(j.nextRunAt).toISOString() : "none"}`
      ).join("\n");
      return { content: [{ type: "text" as const, text: summary }], details: {} };
    },
    defaultPermission: "allow",
    available: true,
  };

  const cancelJob: ToolEntry = {
    name: "cancel_scheduled_job",
    source: "local",
    description: "Cancel an active or paused scheduled job.",
    parameters: Type.Object({
      jobId: Type.String({ description: "Job ID to cancel." }),
    }),
    execute: async (_toolCallId, params) => {
      const removed = scheduler.removeJob(params.jobId as string);
      return {
        content: [{ type: "text" as const, text: removed ? `Job ${params.jobId} cancelled.` : `Job ${params.jobId} not found.` }],
        details: {},
      };
    },
    defaultPermission: "hitl",
    available: true,
  };

  return [scheduleTask, listJobs, cancelJob];
}
