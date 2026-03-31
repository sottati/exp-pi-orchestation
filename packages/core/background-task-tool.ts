import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";
import type { ScheduledJob } from "./contracts";

/**
 * Creates a `start_background_task` tool bound to a scheduler callback.
 *
 * Injected into orchestrator agents when the run has an active WhatsApp contact.
 * Lets the orchestrator fire a long-running task, immediately respond to the user
 * ("working on it, I'll notify you"), and deliver the result later via notify_contact /
 * deliverResult once the background agent finishes.
 *
 * Flow:
 *   Orchestrator → start_background_task("code", "Analyze security...")
 *   Orchestrator → responds: "Starting analysis. I'll WhatsApp you the result."
 *   [chat ends, user gets immediate WhatsApp response]
 *   [~1ms later] Scheduler fires → agent runs with full channel context
 *   Agent → notify_contact (optional mid-task updates)
 *   Agent finishes → deliverResult → WhatsApp: final result
 */
export function createBackgroundTaskToolEntry(
  scheduleTask: (targetAgentId: string, task: string) => ScheduledJob,
): ToolEntry {
  return {
    name: "start_background_task",
    source: "local",
    description:
      "Start a long-running task in the background and return immediately. " +
      "The agent will run asynchronously and the result will be delivered to the contact when complete. " +
      "Use this when a task would take too long to complete in a single conversation turn " +
      "(e.g. deep code analysis, large file processing, multi-step research). " +
      "After calling this, tell the user you have started the task and will notify them when done.",
    parameters: Type.Object({
      targetAgentId: Type.String({
        description: "ID of the agent to run the task (e.g. 'code', 'explorer', 'writer').",
      }),
      task: Type.String({
        description: "Full task description for the agent. Be specific — the agent has no other context.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const job = scheduleTask(params.targetAgentId as string, params.task as string);
      return {
        content: [{
          type: "text" as const,
          text: `Background task started (job ${job.jobId}). The agent '${params.targetAgentId}' will run shortly and the result will be sent to the contact automatically.`,
        }],
        details: { jobId: job.jobId },
      };
    },
    defaultPermission: "allow",
    available: true,
  };
}
