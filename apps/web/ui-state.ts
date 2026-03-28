import type { AgentChat, ScheduledJob, ThreadEnvelope, TraceEvent } from "../../packages/core/contracts";

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

export type ThinkingTraceStatus = "running" | "completed" | "error";

export interface ThinkingTraceBlock {
  runId: string;
  lines: string[];
  status: ThinkingTraceStatus;
  startedAt: number;
  updatedAt: number;
  collapsed: boolean;
  source: "model" | "tool";
  hasModelThinking: boolean;
  modelText?: string;
}

export type ChatItem =
  | { kind: "message"; message: UIMessage }
  | { kind: "delegation"; delegationId: string }
  | { kind: "thinking_trace"; runId: string };

export interface HydratedUiState {
  agents: AgentInfo[];
  sessionId: string;
  orgId?: string;
  selectedOrchestratorId?: string;
  selectedContact?: string;
  messages: UIMessage[];
  chatItems: ChatItem[];
  traces: TraceEvent[];
  delegations: Record<string, DelegationBlock>;
  thinkingTraces: Record<string, ThinkingTraceBlock>;
  traceDurations: Record<string, number>;
  chats: AgentChat[];
  jobs: ScheduledJob[];
  orchestrators?: Array<{
    orchestratorId: string;
    ownerNumber: string;
    active: boolean;
    phoneNumberId?: string;
  }>;
  conversations?: Array<{
    orgId: string;
    orchestratorId: string;
    contact: string;
    lastDirection: "inbound" | "outbound";
    lastStatus: "received" | "sent" | "delivered" | "read" | "failed";
    lastTimestamp: number;
    preview?: string;
  }>;
}

interface BuildUiStateInput {
  agents: AgentInfo[];
  sessionId: string;
  orgId?: string;
  selectedOrchestratorId?: string;
  selectedContact?: string;
  threadMessages: ThreadEnvelope[];
  traces: TraceEvent[];
  chats: AgentChat[];
  jobs: ScheduledJob[];
  orchestrators?: HydratedUiState["orchestrators"];
  conversations?: HydratedUiState["conversations"];
}

interface PrimaryThreadOptions {
  orchestratorId?: string;
  contact?: string;
}

function isOrchestratorAgentId(agentId: string): boolean {
  return agentId === "orchestrator" || agentId.startsWith("orchestrator:");
}

function isHumanInboundAgentId(agentId: string): boolean {
  return agentId === "user" || agentId.startsWith("external:");
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

function contentToThinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "thinking"; thinking: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { type?: string }).type === "thinking" &&
        typeof (item as { thinking?: unknown }).thinking === "string",
    )
    .map((item) => item.thinking)
    .join("\n");
}

function thinkingTextToLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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

function formatThinkingLineFromTrace(trace: TraceEvent): string | undefined {
  if (trace.type !== "tool_start" || !trace.toolName) return undefined;

  const details = trace.details as Record<string, unknown> | undefined;
  const args = details?.args as Record<string, unknown> | undefined;
  let label = `→ ${trace.toolName}`;

  if (trace.toolName === "delegate" || trace.toolName === "delegate_task") {
    label = `→ delegate → ${String(details?.agentId ?? args?.agentId ?? "unknown")}: ${String(details?.task ?? args?.task ?? "").slice(0, 80)}`;
  } else if (trace.toolName === "get_chat_result" || trace.toolName === "get_chat_status") {
    label = `→ ${trace.toolName} → ${String(args?.chatId ?? "")}`;
  }

  return label;
}

function hasThinkingTraceItem(chatItems: Array<{ timestamp: number; order: number; item: ChatItem }>, runId: string): boolean {
  return chatItems.some((entry) => entry.item.kind === "thinking_trace" && entry.item.runId === runId);
}

export function buildHydratedUiState(input: BuildUiStateInput): HydratedUiState {
  const allTraces = [...input.traces].sort((a, b) => a.timestamp - b.timestamp);
  const traces = allTraces.slice(-200);
  const runDurations = getRunDurationMap(allTraces);
  const traceDurations = buildTraceDurations(traces);
  const chats = [...input.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const jobs = [...input.jobs].sort((a, b) => b.updatedAt - a.updatedAt);

  const messages: UIMessage[] = input.threadMessages
    .filter((envelope) => {
      if (envelope.message.role === "assistant") {
        return isOrchestratorAgentId(envelope.fromAgentId) && isHumanInboundAgentId(envelope.toAgentId);
      }
      if (envelope.message.role === "user") {
        return isHumanInboundAgentId(envelope.fromAgentId) && isOrchestratorAgentId(envelope.toAgentId);
      }
      return false;
    })
    .map((envelope) => ({
      id: envelope.envelopeId,
      role: envelope.message.role === "assistant" ? "assistant" : "user",
      content: contentToText(envelope.message.content).trim(),
      timestamp: envelope.timestamp,
      runId: envelope.runId,
      agentId: envelope.fromAgentId,
      durationMs:
        envelope.message.role === "assistant"
          ? runDurations.get(envelope.runId)
          : undefined,
    }));

  const erroredRunIds = new Set(messages.map((message) => message.runId).filter((runId): runId is string => Boolean(runId)));
  for (const trace of allTraces) {
    if (trace.type !== "run_failed" || !trace.agentId || !isOrchestratorAgentId(trace.agentId) || trace.chatId) continue;
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

  const sortedThreadMessages = [...input.threadMessages].sort((a, b) => a.timestamp - b.timestamp);
  const delegations: Record<string, DelegationBlock> = {};
  const thinkingTraces: Record<string, ThinkingTraceBlock> = {};
  const runTerminalStatus = new Map<string, ThinkingTraceStatus>();
  const chatItemsWithTime: Array<{ timestamp: number; order: number; item: ChatItem }> = [];
  let order = 0;

  for (const message of messages) {
    chatItemsWithTime.push({ timestamp: message.timestamp, order: order++, item: { kind: "message", message } });
  }

  for (const envelope of sortedThreadMessages) {
    if (envelope.fromAgentId !== "orchestrator" || envelope.message.role !== "assistant") continue;
    const runId = envelope.runId;
    if (!runId) continue;
    const thinkingText = contentToThinkingText(envelope.message.content);
    if (!thinkingText) continue;
    const lines = thinkingTextToLines(thinkingText);
    if (lines.length === 0) continue;

    const existing = thinkingTraces[runId];
    if (!existing) {
      thinkingTraces[runId] = {
        runId,
        lines,
        status: "running",
        startedAt: envelope.timestamp,
        updatedAt: envelope.timestamp,
        collapsed: true,
        source: "model",
        hasModelThinking: true,
        modelText: thinkingText,
      };
      if (!hasThinkingTraceItem(chatItemsWithTime, runId)) {
        chatItemsWithTime.push({
          timestamp: envelope.timestamp,
          order: order++,
          item: { kind: "thinking_trace", runId },
        });
      }
      continue;
    }

    for (const line of lines) {
      if (existing.lines[existing.lines.length - 1] !== line) {
        existing.lines = [...existing.lines, line];
      }
    }
    existing.updatedAt = envelope.timestamp;
    existing.source = "model";
    existing.hasModelThinking = true;
    existing.modelText = existing.modelText ? `${existing.modelText}\n${thinkingText}` : thinkingText;
  }

  for (const trace of allTraces) {
    if (
      trace.agentId === "orchestrator" &&
      !trace.chatId &&
      (trace.type === "run_completed" || trace.type === "run_failed")
    ) {
      runTerminalStatus.set(trace.runId, trace.type === "run_failed" ? "error" : "completed");
    }

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

    const line = formatThinkingLineFromTrace(trace);
    if (line && trace.agentId === "orchestrator" && !trace.chatId) {
      const existing = thinkingTraces[trace.runId];
      if (existing?.hasModelThinking) continue;
      if (!existing) {
        thinkingTraces[trace.runId] = {
          runId: trace.runId,
          lines: [line],
          status: "running",
          startedAt: trace.timestamp,
          updatedAt: trace.timestamp,
          collapsed: true,
          source: "tool",
          hasModelThinking: false,
        };
        if (!hasThinkingTraceItem(chatItemsWithTime, trace.runId)) {
          chatItemsWithTime.push({
            timestamp: trace.timestamp,
            order: order++,
            item: { kind: "thinking_trace", runId: trace.runId },
          });
        }
      } else {
        if (existing.lines[existing.lines.length - 1] !== line) {
          existing.lines = [...existing.lines, line];
        }
        existing.updatedAt = trace.timestamp;
      }
    }
  }

  for (const [runId, block] of Object.entries(thinkingTraces)) {
    const terminalStatus = runTerminalStatus.get(runId);
    if (terminalStatus) {
      block.status = terminalStatus;
      continue;
    }
    if (!messages.some((message) => message.runId === runId)) continue;
    block.status = "completed";
  }

  chatItemsWithTime.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);

  return {
    agents: input.agents,
    sessionId: input.sessionId,
    orgId: input.orgId,
    selectedOrchestratorId: input.selectedOrchestratorId,
    selectedContact: input.selectedContact,
    messages,
    chatItems: chatItemsWithTime.map(({ item }) => item),
    traces,
    delegations,
    thinkingTraces,
    traceDurations,
    chats,
    jobs,
    orchestrators: input.orchestrators ?? [],
    conversations: input.conversations ?? [],
  };
}

export function getPrimaryThreadId(sessionId: string, opts?: PrimaryThreadOptions): string {
  const orchestratorId = opts?.orchestratorId?.trim() || "orchestrator";
  const peerId = opts?.contact?.trim() ? `external:${opts.contact.trim()}` : "user";
  return `${sessionId}::${[peerId, orchestratorId].sort().join("<->")}`;
}
