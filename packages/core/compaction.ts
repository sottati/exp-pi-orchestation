import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Message, AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryClient } from "./memory-client";

export interface CompactionParams {
  messages: AgentMessage[];
  model: Model<any>;
  client: MemoryClient;
  threshold?: number; // default from env COMPACTION_THRESHOLD or 40
  keep?: number;      // default from env COMPACTION_KEEP or 10
}

function isLlmCompatible(msg: AgentMessage): msg is Message {
  return (
    (msg as Message).role === "user" ||
    (msg as Message).role === "assistant" ||
    (msg as Message).role === "toolResult"
  );
}

function formatMessages(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (!isLlmCompatible(msg)) continue;
    const m = msg as Message;
    if (m.role === "user") {
      const content = m.content;
      let text: string;
      if (typeof content === "string") {
        text = content;
      } else {
        text = content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join(" ");
      }
      lines.push(`User: ${text}`);
    } else if (m.role === "assistant") {
      const textParts = (m as AssistantMessage).content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text);
      lines.push(`Assistant: ${textParts.join(" ")}`);
    } else if (m.role === "toolResult") {
      const textParts = m.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text);
      lines.push(`Tool(${m.toolName}): ${textParts.join(" ")}`);
    }
  }
  return lines.join("\n");
}

export async function maybeCompact(params: CompactionParams): Promise<AgentMessage[] | null> {
  const threshold =
    params.threshold ??
    (process.env.COMPACTION_THRESHOLD !== undefined
      ? parseInt(process.env.COMPACTION_THRESHOLD, 10)
      : 40);
  const keep =
    params.keep ??
    (process.env.COMPACTION_KEEP !== undefined
      ? parseInt(process.env.COMPACTION_KEEP, 10)
      : 10);

  if (params.messages.length <= threshold) {
    return null;
  }

  const toCompact = params.messages.slice(0, params.messages.length - keep);
  const toKeep = params.messages.slice(params.messages.length - keep);

  const llmCompatible = toCompact.filter(isLlmCompatible) as Message[];
  const formatted = formatMessages(toCompact);

  const userPrompt: Message = {
    role: "user",
    content: `Summarize the following conversation concisely, preserving key decisions, preferences, and context:\n\n${formatted}`,
    timestamp: Date.now(),
  };

  let summaryText: string;
  try {
    const response = await completeSimple(params.model, { messages: [userPrompt] });
    if (response.stopReason === "error") {
      return null;
    }
    const textBlock = response.content.find((c): c is TextContent => c.type === "text");
    summaryText = textBlock?.text ?? "";
  } catch {
    return null;
  }

  // Non-fatal: save to engram
  try {
    await params.client.save({
      type: "conversation_summary",
      title: "Conversation summary",
      content: summaryText,
    });
  } catch (err) {
    process.stderr.write(`[compaction] Failed to save summary to engram: ${err}\n`);
  }

  const summaryMessage: AgentMessage = {
    role: "user",
    content: `[Conversation summary: ${summaryText}]`,
    timestamp: Date.now(),
  };

  return [summaryMessage, ...toKeep];
}
