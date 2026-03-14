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
    taskId?: string;
    toolCallId?: string;
    message: AgentMessage;
}

export type TaskStatus =
    | "queued"
    | "running"
    | "needs_human"
    | "completed"
    | "failed"
    | "cancelled";

export interface TaskRecord {
    jobId: string;
    sessionId: string;
    parentRunId: string;
    parentTurnId: string;
    agentId: Exclude<BaseAgentId, "user" | "orchestrator">;
    task: string;
    context?: string;
    status: TaskStatus;
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    finishedAt?: number;
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
        | "task_queued"
        | "task_started"
        | "task_retry"
        | "task_completed"
        | "task_failed"
        | "task_cancelled";
    status: TraceStatus;
    agentId?: BaseAgentId;
    toolName?: string;
    toolCallId?: string;
    taskId?: string;
    details?: Record<string, unknown>;
}
