import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type BaseAgentId = string;
export type Initiator = "user" | "orchestrator" | "specialist" | "system";
export type Permission = "allow" | "deny" | "hitl";

export interface RunContext {
    runId: string;
    turnId: string;
    sessionId: string;
    delegationDepth?: number;
    delegationChain?: string[];
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
        | "chat_cancelled"
        | "tool_unavailable"
        | "mcp_server_failed"
        | "tool_permission_check"
        | "tool_hitl_requested"
        | "tool_hitl_approved"
        | "tool_hitl_denied"
        | "tool_hitl_timeout"
        | "job_created"
        | "job_triggered"
        | "job_completed"
        | "job_failed"
        | "job_cancelled"
        | "job_paused"
        | "job_resumed";
    status: TraceStatus;
    agentId?: BaseAgentId;
    toolName?: string;
    toolCallId?: string;
    chatId?: string;
    details?: Record<string, unknown>;
}

export interface ScheduledJob {
    jobId: string;
    sessionId: string;
    createdBy: string;
    targetAgentId: string;
    task: string;
    schedule: {
        type: "cron" | "once" | "delay";
        cron?: string;
        runAt?: number;
        delayMs?: number;
    };
    status: "active" | "paused" | "completed" | "failed";
    maxRuns?: number;
    runCount: number;
    createdAt: number;
    updatedAt: number;
    lastRunAt?: number;
    nextRunAt?: number;
    error?: string;
}
