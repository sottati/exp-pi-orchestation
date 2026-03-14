import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type BaseAgentId = "user" | "orchestrator" | "code" | "math";
export type Initiator = "user" | "orchestrator" | "specialist" | "system";

export interface RunContext {
    runId: string;
    turnId: string;
    sessionId: string;
}

export interface ThreadEnvelope {
    envelopeId: string;
    parentEnvelopeId?: string;
    replyToEnvelopeId?: string;
    sessionId: string;
    threadId: string;
    runId: string;
    turnId: string;
    timestamp: number;
    fromAgentId: BaseAgentId;
    toAgentId: BaseAgentId;
    initiator: Initiator;
    chatId?: string;
    toolCallId?: string;
    message: AgentMessage;
}

export type ChatStatus = "active" | "waiting" | "closed";
export type ChatCloseReason = "completed" | "failed" | "cancelled";

export interface AgentChat {
    chatId: string;
    conversationId: string;
    sessionId: string;
    parentRunId: string;
    parentTurnId: string;
    agentId: string;
    task: string;
    context?: string;
    status: ChatStatus;
    closeReason?: ChatCloseReason;
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    closedAt?: number;
    attempts: number;
    maxRetries: number;
    timeoutMs: number;
    result?: string;
    error?: string;
}

export type TraceStatus = "ok" | "error" | "queued" | "running" | "completed" | "cancelled";

export interface TraceEvent {
    eventId: string;
    timestamp: number;
    sessionId: string;
    runId: string;
    turnId: string;
    type:
        | "run_started"
        | "run_completed"
        | "run_failed"
        | "message_routed"
        | "tool_start"
        | "tool_end"
        | "chat_created"
        | "chat_started"
        | "chat_retry"
        | "chat_completed"
        | "chat_failed"
        | "chat_cancelled";
    status: TraceStatus;
    agentId?: BaseAgentId;
    toolName?: string;
    toolCallId?: string;
    chatId?: string;
    details?: Record<string, unknown>;
}
