import type { ThreadEnvelope, TraceEvent } from "../../packages/core/contracts";

export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  maxConcurrency: number;
}

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  timestamp: number;
  runId?: string;
  durationMs?: number;
}

export interface DelegationBlock {
  delegationId: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  result?: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
}

export type ChatItem =
  | { kind: "message"; message: UIMessage }
  | { kind: "delegation"; delegationId: string };

export interface HydratedUiState {
  agents: AgentInfo[];
  sessionId: string;
  messages: UIMessage[];
  chatItems: ChatItem[];
  traces: TraceEvent[];
  delegations: Record<string, DelegationBlock>;
  traceDurations: Record<string, number>;
}

interface BuildUiStateInput {
  agents: AgentInfo[];
  sessionId: string;
  threadMessages: ThreadEnvelope[];
  traces: TraceEvent[];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: string }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("");
}

function getRunDurationMap(traces: TraceEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const trace of traces) {
    if (trace.type !== "run_completed") continue;
    const durationMs = trace.details?.durationMs;
    if (typeof durationMs === "number") out.set(trace.runId, durationMs);
  }
  return out;
}

function buildTraceDurations(traces: TraceEvent[]): Record<string, number> {
  const startTimes: Record<string, number> = {};
  const durations: Record<string, number> = {};

  for (const trace of traces) {
    if (trace.type === "tool_start" || trace.type === "chat_created") {
      const key = trace.toolCallId || trace.chatId || trace.eventId;
      startTimes[key] = trace.timestamp;
    }

    if (trace.type === "tool_end" || trace.type === "chat_completed" || trace.type === "chat_failed") {
      const key = trace.toolCallId || trace.chatId || trace.eventId;
      const startedAt = startTimes[key];
      if (startedAt !== undefined) durations[trace.eventId] = trace.timestamp - startedAt;
    }
  }

  return durations;
}

function isDelegateTrace(trace: TraceEvent): boolean {
  return trace.toolName === "delegate" || trace.toolName === "delegate_task";
}

export function buildHydratedUiState(input: BuildUiStateInput): HydratedUiState {
  const allTraces = [...input.traces].sort((a, b) => a.timestamp - b.timestamp);
  const traces = allTraces.slice(-200);
  const runDurations = getRunDurationMap(allTraces);
  const traceDurations = buildTraceDurations(traces);

  const messages: UIMessage[] = input.threadMessages
    .filter((envelope) => {
      if (envelope.message.role === "assistant") return envelope.fromAgentId === "orchestrator";
      if (envelope.message.role === "user") return envelope.fromAgentId === "user";
      return false;
    })
    .map((envelope) => ({
      id: envelope.envelopeId,
      role: envelope.message.role === "assistant" ? "assistant" : "user",
      content: contentToText(envelope.message.content).trim(),
      timestamp: envelope.timestamp,
      runId: envelope.runId,
      durationMs:
        envelope.message.role === "assistant"
          ? runDurations.get(envelope.runId)
          : undefined,
    }));

  const erroredRunIds = new Set(messages.map((message) => message.runId).filter((runId): runId is string => Boolean(runId)));
  for (const trace of allTraces) {
    if (trace.type !== "run_failed" || trace.agentId !== "orchestrator" || trace.chatId) continue;
    if (erroredRunIds.has(trace.runId)) continue;
    const error = typeof trace.details?.error === "string" ? trace.details.error : "Unknown error";
    messages.push({
      id: `err-${trace.eventId}`,
      role: "error",
      content: `Error: ${error}`,
      timestamp: trace.timestamp,
      runId: trace.runId,
    });
  }

  messages.sort((a, b) => a.timestamp - b.timestamp);

  const delegations: Record<string, DelegationBlock> = {};
  const chatItemsWithTime: Array<{ timestamp: number; order: number; item: ChatItem }> = [];
  let order = 0;

  for (const message of messages) {
    chatItemsWithTime.push({ timestamp: message.timestamp, order: order++, item: { kind: "message", message } });
  }

  for (const trace of allTraces) {
    if (trace.type === "tool_start" && trace.toolCallId && isDelegateTrace(trace)) {
      const args = trace.details?.args as Record<string, unknown> | undefined;
      const task = trace.details?.task ?? args?.task;
      const toAgentId = trace.details?.agentId ?? args?.agentId;
      delegations[trace.toolCallId] = {
        delegationId: trace.toolCallId,
        fromAgentId: trace.agentId ?? "orchestrator",
        toAgentId: typeof toAgentId === "string" ? toAgentId : "unknown",
        task: typeof task === "string" ? task : "",
        status: "running",
      };
      chatItemsWithTime.push({
        timestamp: trace.timestamp,
        order: order++,
        item: { kind: "delegation", delegationId: trace.toolCallId },
      });
    }

    if (trace.type === "tool_end" && trace.toolCallId && isDelegateTrace(trace)) {
      const existing = delegations[trace.toolCallId];
      if (!existing) continue;
      const result = trace.details?.result;
      delegations[trace.toolCallId] = {
        ...existing,
        result: typeof result === "string" ? result : existing.result,
        status: trace.status === "ok" ? "ok" : "error",
        durationMs: traceDurations[trace.eventId],
      };
    }
  }

  chatItemsWithTime.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);

  return {
    agents: input.agents,
    sessionId: input.sessionId,
    messages,
    chatItems: chatItemsWithTime.map(({ item }) => item),
    traces,
    delegations,
    traceDurations,
  };
}

export function getPrimaryThreadId(sessionId: string): string {
  return `${sessionId}::${["user", "orchestrator"].sort().join("<->")}`;
}
