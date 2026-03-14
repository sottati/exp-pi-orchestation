import { type Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { createConversationId } from "./chat-manager";
import type { AgentChat, BaseAgentId, RunContext } from "./contracts";

export interface SpecialistDescriptor {
    id: string;
    name: string;
    role: string;
    capabilities: string[];
    inputHint?: string;
    maxConcurrency: number;
}

export interface SpecialistEntry extends SpecialistDescriptor {
    createAgent: (tools?: AgentTool<any>[]) => Agent;
}

export type SpecialistRegistry = Record<string, SpecialistEntry>;

// --- Tool parameters ---

const listAgentsParameters = Type.Object({});
type ListAgentsParameters = Static<typeof listAgentsParameters>;

const delegateParameters = Type.Object({
    agentId: Type.String({ description: "Specialist id from list_agents." }),
    task: Type.String({ description: "Task to delegate to the specialist." }),
    context: Type.Optional(Type.String({ description: "Optional extra context for the specialist." })),
});
type DelegateParameters = Static<typeof delegateParameters>;

const getChatStatusParameters = Type.Object({
    chatId: Type.String({ description: "Chat ID returned by delegate." }),
});
type GetChatStatusParameters = Static<typeof getChatStatusParameters>;

const getChatResultParameters = Type.Object({
    chatId: Type.String({ description: "Chat ID returned by delegate." }),
});
type GetChatResultParameters = Static<typeof getChatResultParameters>;

const followUpChatParameters = Type.Object({
    chatId: Type.String({ description: "Active keepAlive chat ID to continue." }),
    task: Type.String({ description: "Follow-up task for the existing chat." }),
    context: Type.Optional(Type.String({ description: "Optional extra context for the follow-up." })),
});
type FollowUpChatParameters = Static<typeof followUpChatParameters>;

const closeChatParameters = Type.Object({
    chatId: Type.String({ description: "Chat ID to close." }),
});
type CloseChatParameters = Static<typeof closeChatParameters>;

// --- Dependencies ---

interface DelegationInput {
    agentId: string;
    task: string;
    context?: string;
    runContext: RunContext;
}

interface SpecialistReportInput {
    specialistId: Exclude<BaseAgentId, "user" | "orchestrator">;
    message: string;
    runContext: RunContext;
    toolCallId: string;
    chatId?: string;
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
    createDelegation: (input: DelegationInput) => AgentChat;
    findContinuableChat: (input: { sessionId: string; agentId: string }) => AgentChat | undefined;
    sendChatFollowUp: (chatId: string, input: { task: string; context?: string }) => Promise<AgentChat>;
    getChat: (chatId: string) => AgentChat | undefined;
    closeChat: (chatId: string) => AgentChat | undefined;
    getQueuePosition: (chatId: string) => number | undefined;
    traceToolEvent: (input: ToolTraceInput) => Promise<void>;
}

export interface SpecialistToolDeps {
    specialistId: Exclude<BaseAgentId, "user" | "orchestrator">;
    getRunContext: () => RunContext;
    sendReportToOrchestrator: (input: SpecialistReportInput) => Promise<string>;
    traceToolEvent: (input: ToolTraceInput) => Promise<void>;
    chatId?: string;
}

// --- Helpers ---

function getAgentCatalog(registry: SpecialistRegistry): SpecialistDescriptor[] {
    return Object.values(registry).map(({ id, name, role, capabilities, inputHint, maxConcurrency }) => ({
        id, name, role, capabilities, inputHint, maxConcurrency,
    }));
}

function normalizeTask(task: string): string {
    return task.trim().replace(/\s+/g, " ");
}

const MAX_TASK_LENGTH = 10_000;

function validateTask(task: string): string {
    const normalized = normalizeTask(task);
    if (!normalized) throw new Error("Task cannot be empty.");
    if (normalized.length > MAX_TASK_LENGTH) throw new Error(`Task exceeds maximum length of ${MAX_TASK_LENGTH} characters.`);

    let balance = 0;
    for (const char of normalized) {
        if (char === "(") balance += 1;
        if (char === ")") balance -= 1;
        if (balance < 0) throw new Error("Task has invalid parenthesis ordering.");
    }
    if (balance !== 0) throw new Error("Task has unbalanced parentheses.");

    return normalized;
}

// --- Tool factory ---

export function createOrchestratorTools(deps: OrchestratorToolDeps): AgentTool<any>[] {
    const { registry } = deps;

    const listAgentsTool: AgentTool<typeof listAgentsParameters> = {
        name: "list_agents",
        label: "List available specialists",
        description: "List available specialist agents with role, capabilities, and concurrency.",
        parameters: listAgentsParameters,
        execute: async (_toolCallId: string, _params: ListAgentsParameters) => {
            const agents = getAgentCatalog(registry);
            const summary = agents
                .map((a) => `${a.id}: ${a.role} (${a.capabilities.join(", ")}) [slots=${a.maxConcurrency}]`)
                .join("\n");
            return {
                content: [{ type: "text", text: summary || "No specialists available." }],
                details: { agents, count: agents.length },
            };
        },
    };

    const delegateTool: AgentTool<typeof delegateParameters> = {
        name: "delegate",
        label: "Delegate task to specialist",
        description: "Delegate a task to a specialist agent. Returns chatId to track progress. Use get_chat_status/get_chat_result to poll.",
        parameters: delegateParameters,
        execute: async (toolCallId: string, params: DelegateParameters) => {
            const specialist = registry[params.agentId];
            if (!specialist) throw new Error(`Unknown agentId '${params.agentId}'. Use list_agents first.`);

            const runContext = deps.getRunContext();
            const task = validateTask(params.task);

            await deps.traceToolEvent({
                type: "tool_start", status: "running", runContext,
                toolName: "delegate", toolCallId,
                details: {
                    agentId: params.agentId,
                    args: {
                        agentId: params.agentId,
                        task,
                        context: params.context,
                    },
                },
            });

            const conversationId = createConversationId(runContext.sessionId, "orchestrator", params.agentId);
            const existing = deps.findContinuableChat({ sessionId: runContext.sessionId, agentId: params.agentId });
            const chat = existing
                ? await deps.sendChatFollowUp(existing.chatId, { task, context: params.context })
                : deps.createDelegation({
                    agentId: params.agentId,
                    task,
                    context: params.context,
                    runContext,
                });

            const queuePosition = deps.getQueuePosition(chat.chatId);

            await deps.traceToolEvent({
                type: "tool_end", status: "ok", runContext,
                toolName: "delegate", toolCallId,
                details: {
                    agentId: params.agentId,
                    chatId: chat.chatId,
                    conversationId: chat.conversationId || conversationId,
                    status: chat.status,
                    continued: Boolean(existing),
                    args: {
                        agentId: params.agentId,
                        task,
                        context: params.context,
                    },
                },
            });

            const statusText = existing
                ? `Follow-up sent to ${specialist.name}. chatId=${chat.chatId}.`
                : chat.status === "active"
                    ? `Chat started with ${specialist.name}. chatId=${chat.chatId}.`
                    : `Chat queued for ${specialist.name} (position ${queuePosition}). chatId=${chat.chatId}.`;

            return {
                content: [{ type: "text", text: statusText }],
                details: {
                    chatId: chat.chatId,
                    conversationId: chat.conversationId || conversationId,
                    status: chat.status,
                    continued: Boolean(existing),
                    agentId: chat.agentId,
                    queuePosition,
                    runId: runContext.runId,
                    turnId: runContext.turnId,
                    toolCallId,
                },
            };
        },
    };

    const delegateTaskAlias: AgentTool<typeof delegateParameters> = {
        ...delegateTool,
        name: "delegate_task",
        label: "Delegate task (legacy alias)",
        description: "Alias for delegate. Kept for backward compatibility.",
    };

    const followUpChatTool: AgentTool<typeof followUpChatParameters> = {
        name: "follow_up_chat",
        label: "Send follow-up to active chat",
        description: "Send a follow-up message to an open keepAlive chat.",
        parameters: followUpChatParameters,
        execute: async (toolCallId: string, params: FollowUpChatParameters) => {
            const runContext = deps.getRunContext();
            const task = validateTask(params.task);

            await deps.traceToolEvent({
                type: "tool_start", status: "running", runContext,
                toolName: "follow_up_chat", toolCallId,
                details: {
                    chatId: params.chatId,
                    args: {
                        chatId: params.chatId,
                        task,
                        context: params.context,
                    },
                },
            });

            const chat = await deps.sendChatFollowUp(params.chatId, { task, context: params.context });
            const queuePosition = deps.getQueuePosition(chat.chatId);

            await deps.traceToolEvent({
                type: "tool_end", status: "ok", runContext,
                toolName: "follow_up_chat", toolCallId,
                details: {
                    chatId: chat.chatId,
                    conversationId: chat.conversationId,
                    status: chat.status,
                    args: {
                        chatId: params.chatId,
                        task,
                        context: params.context,
                    },
                },
            });

            return {
                content: [{ type: "text", text: `Follow-up queued. chatId=${chat.chatId}.` }],
                details: {
                    chatId: chat.chatId,
                    conversationId: chat.conversationId,
                    status: chat.status,
                    queuePosition,
                    runId: runContext.runId,
                    turnId: runContext.turnId,
                    toolCallId,
                },
            };
        },
    };

    const getChatStatusTool: AgentTool<typeof getChatStatusParameters> = {
        name: "get_chat_status",
        label: "Get chat status",
        description: "Check chat status by chatId.",
        parameters: getChatStatusParameters,
        execute: async (_toolCallId: string, params: GetChatStatusParameters) => {
            const chat = deps.getChat(params.chatId);
            if (!chat) {
                return {
                    content: [{ type: "text", text: `chatId ${params.chatId} not found.` }],
                    details: { found: false },
                };
            }
            const info = chat.status === "closed"
                ? `chatId ${params.chatId} is closed (${chat.closeReason}).${chat.closeReason === "completed" ? " Use get_chat_result to read." : ""}`
                : `chatId ${params.chatId} is ${chat.status}.`;
            return {
                content: [{ type: "text", text: info }],
                details: { found: true, chat },
            };
        },
    };

    const getChatResultTool: AgentTool<typeof getChatResultParameters> = {
        name: "get_chat_result",
        label: "Get chat result",
        description: "Get the result from a completed chat.",
        parameters: getChatResultParameters,
        execute: async (_toolCallId: string, params: GetChatResultParameters) => {
            const chat = deps.getChat(params.chatId);
            if (!chat) {
                return {
                    content: [{ type: "text", text: `chatId ${params.chatId} not found.` }],
                    details: { found: false },
                };
            }

            if (chat.keepAlive && chat.result !== undefined) {
                return {
                    content: [{ type: "text", text: chat.result }],
                    details: {
                        found: true,
                        status: chat.status,
                        closeReason: chat.closeReason,
                        result: chat.result,
                        keepAlive: true,
                    },
                };
            }

            if (chat.status !== "closed" || chat.closeReason !== "completed") {
                const info = chat.status === "closed"
                    ? `chatId ${params.chatId} closed: ${chat.closeReason}. Error: ${chat.error ?? "none"}`
                    : `chatId ${params.chatId} is still ${chat.status}.`;
                return {
                    content: [{ type: "text", text: info }],
                    details: { found: true, status: chat.status, closeReason: chat.closeReason, error: chat.error },
                };
            }
            return {
                content: [{ type: "text", text: chat.result ?? "" }],
                details: { found: true, status: chat.status, closeReason: chat.closeReason, result: chat.result },
            };
        },
    };

    const closeChatTool: AgentTool<typeof closeChatParameters> = {
        name: "close_chat",
        label: "Close chat",
        description: "Close an active or waiting chat.",
        parameters: closeChatParameters,
        execute: async (_toolCallId: string, params: CloseChatParameters) => {
            const chat = deps.closeChat(params.chatId);
            if (!chat) {
                return {
                    content: [{ type: "text", text: `chatId ${params.chatId} not found.` }],
                    details: { found: false },
                };
            }
            return {
                content: [{ type: "text", text: `chatId ${params.chatId} is now closed.` }],
                details: { found: true, status: chat.status },
            };
        },
    };

    return [
        listAgentsTool as AgentTool<any>,
        delegateTool as AgentTool<any>,
        delegateTaskAlias as AgentTool<any>,
        followUpChatTool as AgentTool<any>,
        getChatStatusTool as AgentTool<any>,
        getChatResultTool as AgentTool<any>,
        closeChatTool as AgentTool<any>,
    ];
}

const reportToOrchestratorParameters = Type.Object({
    message: Type.String({
        description: "Summary to send to orchestrator only when user explicitly asks for a report.",
    }),
});
type ReportToOrchestratorParameters = Static<typeof reportToOrchestratorParameters>;

export function createSpecialistTools(deps: SpecialistToolDeps): AgentTool<any>[] {
    const reportToOrchestratorTool: AgentTool<typeof reportToOrchestratorParameters> = {
        name: "report_to_orchestrator",
        label: "Report result to orchestrator",
        description: "Send an explicit specialist report to orchestrator when requested by the user.",
        parameters: reportToOrchestratorParameters,
        execute: async (toolCallId: string, params: ReportToOrchestratorParameters) => {
            const runContext = deps.getRunContext();
            const message = validateTask(params.message);

            await deps.traceToolEvent({
                type: "tool_start",
                status: "running",
                runContext,
                toolName: "report_to_orchestrator",
                toolCallId,
                details: {
                    agentId: deps.specialistId,
                    chatId: deps.chatId,
                    args: {
                        message,
                    },
                },
            });

            const reportAnswer = await deps.sendReportToOrchestrator({
                specialistId: deps.specialistId,
                message,
                runContext,
                toolCallId,
                chatId: deps.chatId,
            });

            await deps.traceToolEvent({
                type: "tool_end",
                status: "ok",
                runContext,
                toolName: "report_to_orchestrator",
                toolCallId,
                details: {
                    agentId: deps.specialistId,
                    chatId: deps.chatId,
                },
            });

            return {
                content: [{ type: "text", text: `Report sent to orchestrator.` }],
                details: {
                    reportedBy: deps.specialistId,
                    reported: true,
                    orchestratorReply: reportAnswer,
                    runId: runContext.runId,
                    turnId: runContext.turnId,
                    toolCallId,
                },
            };
        },
    };

    return [reportToOrchestratorTool as AgentTool<any>];
}
