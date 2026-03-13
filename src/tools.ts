import { type Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { errorMessage } from "./errors";
import { Type, type Static } from "@sinclair/typebox";
import type { BaseAgentId, RunContext, TaskRecord } from "./contracts";

export interface SpecialistDescriptor {
    id: string;
    name: string;
    role: string;
    capabilities: string[];
    inputHint?: string;
}

export interface SpecialistEntry extends SpecialistDescriptor {
    agent: Agent;
}

export type SpecialistRegistry = Record<string, SpecialistEntry>;

type SpecialistId = Exclude<BaseAgentId, "user" | "orchestrator">;

const listAgentsParameters = Type.Object({});
type ListAgentsParameters = Static<typeof listAgentsParameters>;

interface ListAgentsDetails {
    agents: SpecialistDescriptor[];
    count: number;
}

const delegateTaskParameters = Type.Object({
    agentId: Type.String({ description: "Specialist id from list_agents." }),
    task: Type.String({ description: "Task to delegate to the specialist." }),
    context: Type.Optional(Type.String({ description: "Optional extra context for the specialist." })),
});
type DelegateTaskParameters = Static<typeof delegateTaskParameters>;

interface DelegateTaskDetails {
    mode: "sync";
    agentId: string;
    task: string;
    answer: string;
    durationMs: number;
    runId: string;
    turnId: string;
    toolCallId: string;
    threadId: string;
    taskId: string;
    ok: boolean;
}

const delegateTaskAsyncParameters = Type.Object({
    agentId: Type.String({ description: "Specialist id from list_agents." }),
    task: Type.String({ description: "Task to delegate asynchronously." }),
    context: Type.Optional(Type.String({ description: "Optional extra context." })),
    timeoutMs: Type.Optional(Type.Number({ description: "Timeout for each attempt in milliseconds." })),
    maxRetries: Type.Optional(Type.Number({ description: "Maximum retries when task fails." })),
});
type DelegateTaskAsyncParameters = Static<typeof delegateTaskAsyncParameters>;

interface DelegateTaskAsyncDetails {
    mode: "async";
    jobId: string;
    status: TaskRecord["status"];
    agentId: string;
    runId: string;
    turnId: string;
    toolCallId: string;
}

const getTaskStatusParameters = Type.Object({
    jobId: Type.String({ description: "Job ID returned by delegate_task_async." }),
});
type GetTaskStatusParameters = Static<typeof getTaskStatusParameters>;

interface GetTaskStatusDetails {
    found: boolean;
    job?: TaskRecord;
}

const getTaskResultParameters = Type.Object({
    jobId: Type.String({ description: "Job ID returned by delegate_task_async." }),
});
type GetTaskResultParameters = Static<typeof getTaskResultParameters>;

interface GetTaskResultDetails {
    found: boolean;
    status?: TaskRecord["status"];
    result?: string;
    error?: string;
}

const cancelTaskParameters = Type.Object({
    jobId: Type.String({ description: "Job ID to cancel." }),
});
type CancelTaskParameters = Static<typeof cancelTaskParameters>;

interface CancelTaskDetails {
    found: boolean;
    status?: TaskRecord["status"];
}

interface SyncDelegationInput {
    agentId: SpecialistId;
    task: string;
    context?: string;
    runContext: RunContext;
    toolCallId: string;
}

interface SyncDelegationResult {
    answer: string;
    durationMs: number;
    threadId: string;
    taskId: string;
}

interface AsyncDelegationInput {
    agentId: SpecialistId;
    task: string;
    context?: string;
    runContext: RunContext;
    timeoutMs?: number;
    maxRetries?: number;
}

interface ToolTraceInput {
    type: "tool_start" | "tool_end";
    status: "running" | "ok" | "error";
    runContext: RunContext;
    toolName: string;
    toolCallId: string;
    details?: Record<string, unknown>;
}

export interface OrchestratorToolDeps {
    registry: SpecialistRegistry;
    getRunContext: () => RunContext;
    runSyncDelegation: (input: SyncDelegationInput) => Promise<SyncDelegationResult>;
    createAsyncDelegation: (input: AsyncDelegationInput) => TaskRecord;
    getTask: (jobId: string) => TaskRecord | undefined;
    cancelTask: (jobId: string) => TaskRecord | undefined;
    traceToolEvent: (input: ToolTraceInput) => Promise<void>;
}

function getAgentCatalog(registry: SpecialistRegistry): SpecialistDescriptor[] {
    return Object.values(registry).map(({ id, name, role, capabilities, inputHint }) => ({
        id,
        name,
        role,
        capabilities,
        inputHint,
    }));
}

function normalizeTask(task: string): string {
    return task.trim().replace(/\s+/g, " ");
}

const MAX_TASK_LENGTH = 10_000;

function validateTask(task: string): string {
    const normalized = normalizeTask(task);
    if (!normalized) {
        throw new Error("Task cannot be empty.");
    }

    if (normalized.length > MAX_TASK_LENGTH) {
        throw new Error(`Task exceeds maximum length of ${MAX_TASK_LENGTH} characters.`);
    }

    let balance = 0;
    for (const char of normalized) {
        if (char === "(") balance += 1;
        if (char === ")") balance -= 1;
        if (balance < 0) {
            throw new Error("Task has invalid parenthesis ordering.");
        }
    }

    if (balance !== 0) {
        throw new Error("Task has unbalanced parentheses.");
    }

    return normalized;
}

export function createOrchestratorTools(deps: OrchestratorToolDeps): AgentTool<any>[] {
    const { registry } = deps;

    const listAgentsTool: AgentTool<typeof listAgentsParameters, ListAgentsDetails> = {
        name: "list_agents",
        label: "List available specialists",
        description: "List available specialist agents with role and capabilities.",
        parameters: listAgentsParameters,
        execute: async (_toolCallId: string, _params: ListAgentsParameters) => {
            const agents = getAgentCatalog(registry);
            const summary = agents
                .map((agent) => `${agent.id}: ${agent.role} (${agent.capabilities.join(", ")})`)
                .join("\n");

            return {
                content: [{ type: "text", text: summary || "No specialists available." }],
                details: {
                    agents,
                    count: agents.length,
                },
            };
        },
    };

    const delegateTaskTool: AgentTool<typeof delegateTaskParameters, DelegateTaskDetails> = {
        name: "delegate_task_sync",
        label: "Delegate a task (sync)",
        description: "Delegate a task synchronously to a specialist agent by id.",
        parameters: delegateTaskParameters,
        execute: async (toolCallId: string, params: DelegateTaskParameters) => {
            const specialist = registry[params.agentId];
            if (!specialist) {
                throw new Error(`Unknown agentId '${params.agentId}'. Use list_agents first.`);
            }

            const runContext = deps.getRunContext();
            const task = validateTask(params.task);
            await deps.traceToolEvent({
                type: "tool_start",
                status: "running",
                runContext,
                toolName: "delegate_task_sync",
                toolCallId,
                details: { agentId: params.agentId },
            });

            try {
                const result = await deps.runSyncDelegation({
                    agentId: params.agentId as SpecialistId,
                    task,
                    context: params.context,
                    runContext,
                    toolCallId,
                });

                await deps.traceToolEvent({
                    type: "tool_end",
                    status: "ok",
                    runContext,
                    toolName: "delegate_task_sync",
                    toolCallId,
                    details: { agentId: params.agentId, durationMs: result.durationMs, taskId: result.taskId },
                });

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                result.answer ||
                                `${specialist.name} completed the task but returned no text output.`,
                        },
                    ],
                    details: {
                        mode: "sync",
                        agentId: specialist.id,
                        task,
                        answer: result.answer,
                        durationMs: result.durationMs,
                        runId: runContext.runId,
                        turnId: runContext.turnId,
                        toolCallId,
                        threadId: result.threadId,
                        taskId: result.taskId,
                        ok: true,
                    },
                };
            } catch (error) {
                await deps.traceToolEvent({
                    type: "tool_end",
                    status: "error",
                    runContext,
                    toolName: "delegate_task_sync",
                    toolCallId,
                    details: {
                        agentId: params.agentId,
                        error: errorMessage(error),
                    },
                });
                throw error;
            }
        },
    };

    const legacyDelegateTaskTool: AgentTool<typeof delegateTaskParameters, DelegateTaskDetails> = {
        ...delegateTaskTool,
        name: "delegate_task",
        label: "Delegate a task (legacy alias)",
        description: "Alias of delegate_task_sync for backward compatibility.",
    };

    const delegateTaskAsyncTool: AgentTool<typeof delegateTaskAsyncParameters, DelegateTaskAsyncDetails> = {
        name: "delegate_task_async",
        label: "Delegate a task (async)",
        description: "Queue a specialist task and return a jobId immediately.",
        parameters: delegateTaskAsyncParameters,
        execute: async (toolCallId: string, params: DelegateTaskAsyncParameters) => {
            const specialist = registry[params.agentId];
            if (!specialist) {
                throw new Error(`Unknown agentId '${params.agentId}'. Use list_agents first.`);
            }

            const runContext = deps.getRunContext();
            const task = validateTask(params.task);
            await deps.traceToolEvent({
                type: "tool_start",
                status: "running",
                runContext,
                toolName: "delegate_task_async",
                toolCallId,
                details: { agentId: params.agentId },
            });

            const taskRecord = deps.createAsyncDelegation({
                agentId: params.agentId as SpecialistId,
                task,
                context: params.context,
                runContext,
                timeoutMs: params.timeoutMs,
                maxRetries: params.maxRetries,
            });

            await deps.traceToolEvent({
                type: "tool_end",
                status: "ok",
                runContext,
                toolName: "delegate_task_async",
                toolCallId,
                details: { agentId: params.agentId, jobId: taskRecord.jobId },
            });

            return {
                content: [
                    {
                        type: "text",
                        text: `Task queued for ${specialist.name}. jobId=${taskRecord.jobId}.`,
                    },
                ],
                details: {
                    mode: "async",
                    jobId: taskRecord.jobId,
                    status: taskRecord.status,
                    agentId: taskRecord.agentId,
                    runId: runContext.runId,
                    turnId: runContext.turnId,
                    toolCallId,
                },
            };
        },
    };

    const getTaskStatusTool: AgentTool<typeof getTaskStatusParameters, GetTaskStatusDetails> = {
        name: "get_task_status",
        label: "Get task status",
        description: "Check async task status by jobId.",
        parameters: getTaskStatusParameters,
        execute: async (_toolCallId: string, params: GetTaskStatusParameters) => {
            const task = deps.getTask(params.jobId);
            if (!task) {
                return {
                    content: [{ type: "text", text: `jobId ${params.jobId} not found.` }],
                    details: { found: false },
                };
            }
            return {
                content: [{ type: "text", text: `jobId ${params.jobId} is ${task.status}.` }],
                details: { found: true, job: task },
            };
        },
    };

    const getTaskResultTool: AgentTool<typeof getTaskResultParameters, GetTaskResultDetails> = {
        name: "get_task_result",
        label: "Get task result",
        description: "Get async task result by jobId.",
        parameters: getTaskResultParameters,
        execute: async (_toolCallId: string, params: GetTaskResultParameters) => {
            const task = deps.getTask(params.jobId);
            if (!task) {
                return {
                    content: [{ type: "text", text: `jobId ${params.jobId} not found.` }],
                    details: { found: false },
                };
            }

            if (task.status !== "completed") {
                return {
                    content: [{ type: "text", text: `jobId ${params.jobId} is ${task.status}.` }],
                    details: { found: true, status: task.status, error: task.error },
                };
            }

            return {
                content: [{ type: "text", text: task.result ?? "" }],
                details: {
                    found: true,
                    status: task.status,
                    result: task.result,
                },
            };
        },
    };

    const cancelTaskTool: AgentTool<typeof cancelTaskParameters, CancelTaskDetails> = {
        name: "cancel_task",
        label: "Cancel task",
        description: "Cancel a running or queued async task.",
        parameters: cancelTaskParameters,
        execute: async (_toolCallId: string, params: CancelTaskParameters) => {
            const task = deps.cancelTask(params.jobId);
            if (!task) {
                return {
                    content: [{ type: "text", text: `jobId ${params.jobId} not found.` }],
                    details: { found: false },
                };
            }
            return {
                content: [{ type: "text", text: `jobId ${params.jobId} is now ${task.status}.` }],
                details: { found: true, status: task.status },
            };
        },
    };

    return [
        listAgentsTool as AgentTool<any>,
        delegateTaskTool as AgentTool<any>,
        legacyDelegateTaskTool as AgentTool<any>,
        delegateTaskAsyncTool as AgentTool<any>,
        getTaskStatusTool as AgentTool<any>,
        getTaskResultTool as AgentTool<any>,
        cancelTaskTool as AgentTool<any>,
    ];
}