import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "./tool-registry";

/**
 * Creates a `notify_contact` tool entry bound to a specific send function.
 * Injected into every agent run that has an active WhatsApp contact in its RunContext.
 * Allows any agent to push a proactive message to the user without waiting for a reply.
 */
export function createNotifyContactToolEntry(
  sendMessage: (body: string) => Promise<void>,
): ToolEntry {
  return {
    name: "notify_contact",
    source: "local",
    description:
      "Send a proactive message to the WhatsApp contact who originated this task. " +
      "Use to report results, progress updates, or alerts without waiting for the contact to reply. " +
      "The message is delivered through the orchestrator's phone number.",
    parameters: Type.Object({
      message: Type.String({ description: "The message to send to the contact." }),
    }),
    execute: async (_toolCallId, params) => {
      await sendMessage(params.message as string);
      return {
        content: [{ type: "text" as const, text: "Message sent to contact." }],
        details: {},
      };
    },
    defaultPermission: "allow",
    available: true,
  };
}
