import { completeSimple } from "@mariozechner/pi-ai";
import type { Model, Message, AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryClient } from "./memory-client";

export interface CompactionParams {
  messages: AgentMessage[];
  model: Model<any>;
  client: MemoryClient;
  threshold?: number; // default from env COMPACTION_THRESHOLD or 80
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

function extractAssistantToolCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typedBlock = block as {
      type?: unknown;
      id?: unknown;
      callId?: unknown;
      toolCallId?: unknown;
      call_id?: unknown;
    };
    const type = typeof typedBlock.type === "string" ? typedBlock.type : "";
    if (type !== "toolCall" && type !== "tool_call" && type !== "function_call") continue;
    const id =
      typeof typedBlock.id === "string"
        ? typedBlock.id
        : typeof typedBlock.callId === "string"
          ? typedBlock.callId
          : typeof typedBlock.toolCallId === "string"
            ? typedBlock.toolCallId
            : typeof typedBlock.call_id === "string"
              ? typedBlock.call_id
              : "";
    if (id) ids.push(id);
  }
  return ids;
}

function extractToolResultCallId(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const typed = message as {
    toolCallId?: unknown;
    callId?: unknown;
    tool_call_id?: unknown;
    call_id?: unknown;
  };
  if (typeof typed.toolCallId === "string") return typed.toolCallId;
  if (typeof typed.callId === "string") return typed.callId;
  if (typeof typed.tool_call_id === "string") return typed.tool_call_id;
  if (typeof typed.call_id === "string") return typed.call_id;
  return "";
}

function findMatchingAssistantToolCallIndex(
  messages: AgentMessage[],
  fromIndex: number,
  toolCallId: string,
): number {
  for (let i = fromIndex; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    const ids = extractAssistantToolCallIds(message.content);
    if (ids.includes(toolCallId)) return i;
  }
  return -1;
}

function adjustKeepStartForToolCallPairs(messages: AgentMessage[], startIndex: number): number {
  let nextStart = Math.max(0, Math.min(startIndex, messages.length));
  while (nextStart < messages.length) {
    const message = messages[nextStart] as { role?: unknown };
    if (message.role !== "toolResult") break;

    const toolCallId = extractToolResultCallId(messages[nextStart]);
    if (!toolCallId) {
      // Malformed tool result at boundary: skip it.
      nextStart += 1;
      continue;
    }

    const matchIndex = findMatchingAssistantToolCallIndex(messages, nextStart - 1, toolCallId);
    if (matchIndex >= 0) {
      // Include the matching assistant tool call in the kept suffix.
      nextStart = matchIndex;
      continue;
    }

    // Orphan tool result with no matching call in previous history: skip it.
    nextStart += 1;
  }
  return nextStart;
}

export async function maybeCompact(params: CompactionParams): Promise<AgentMessage[] | null> {
  const threshold =
    params.threshold ??
    (process.env.COMPACTION_THRESHOLD !== undefined
      ? parseInt(process.env.COMPACTION_THRESHOLD, 10)
      : 80);
  const keep =
    params.keep ??
    (process.env.COMPACTION_KEEP !== undefined
      ? parseInt(process.env.COMPACTION_KEEP, 10)
      : 10);

  if (params.messages.length <= threshold) {
    return null;
  }

  const requestedKeepStart = params.messages.length - keep;
  const safeKeepStart = adjustKeepStartForToolCallPairs(params.messages, requestedKeepStart);
  const toCompact = params.messages.slice(0, safeKeepStart);
  const toKeep = params.messages.slice(safeKeepStart);

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
