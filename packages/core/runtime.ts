import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { createOrchestratorAgent, createSpecialistRegistry, ORCHESTRATOR_ID } from "./agents";
import type { AgentChat, BaseAgentId, Initiator, RunContext, ThreadEnvelope, TraceEvent } from "./contracts";
import { errorMessage } from "./errors";
import { createId, now } from "./ids";
import { ChatManager, createConversationId } from "./chat-manager";
import { ThreadStore } from "./thread-store";
import { createOrchestratorTools, type SpecialistRegistry } from "./tools";

interface RouteMessageInput {
    fromAgentId: BaseAgentId;
    toAgentId: Exclude<BaseAgentId, "user">;
    content: string;
    initiator: Initiator;
    runContext: RunContext;
    chatId?: string;
    toolCallId?: string;
    onAgentEvent?: (event: AgentEvent) => void;
}

interface RouteMessageOutput {
    answer: string;
    durationMs: number;
    threadId: string;
}

export interface ChatInspectionSummary {
    status: string;
    agentId?: string;
    createdAt?: number;
    updatedAt?: number;
}

export interface ChatInspection {
    queryId: string;
    chat?: AgentChat;
    summary?: ChatInspectionSummary;
    traceEvents: TraceEvent[];
    threadMessages: ThreadEnvelope[];
    threadIds: string[];
}

export interface ChatInput {
    toAgentId: Exclude<BaseAgentId, "user">;
    content: string;
    fromAgentId?: BaseAgentId;
    onAgentEvent?: (event: AgentEvent) => void;
}

export interface ChatOutput extends RouteMessageOutput {
    runContext: RunContext;
}

function extractLastAssistantText(messages: AgentMessage[]): string {
    let lastAssistantError: string | undefined;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as {
            role?: string;
            content?: unknown;
            errorMessage?: unknown;
            stopReason?: unknown;
        };
        if (message.role !== "assistant") continue;

        if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
            lastAssistantError = message.errorMessage.trim();
            continue;
        }

        if (typeof message.content === "string") {
            return message.content.trim();
        }
        if (!Array.isArray(message.content)) continue;

        return message.content
            .filter(
                (content): content is { type: "text"; text: string } =>
                    typeof content === "object" &&
                    content !== null &&
                    (content as { type?: string }).type === "text" &&
                    typeof (content as { text?: unknown }).text === "string",
            )
            .map((content) => content.text)
            .join("")
            .trim();
    }

    if (lastAssistantError) {
        return `Model error: ${lastAssistantError}`;
    }

    return "";
}

function resolveInitiator(fromAgentId: BaseAgentId): Initiator {
    if (fromAgentId === "user") return "user";
    if (fromAgentId === ORCHESTRATOR_ID) return "orchestrator";
    return "specialist";
}

function createThreadId(sessionId: string, a: BaseAgentId, b: BaseAgentId): string {
    return `${sessionId}::${[a, b].sort().join("<->")}`;
}

export class MultiAgentRuntime {
    readonly sessionId: string;
    readonly store: ThreadStore;
    readonly chatManager: ChatManager;
    readonly specialistRegistry: SpecialistRegistry;

    constructor(sessionId = "default") {
        this.sessionId = sessionId;
        this.store = new ThreadStore({ sessionId });
        this.specialistRegistry = createSpecialistRegistry();

        this.chatManager = new ChatManager({
            persistChat: (chat) => this.store.appendChatRecord(chat),
            restoreRecords: () => this.store.getChatRecords(),
            getMaxConcurrency: (agentId) => {
                const specialist = this.specialistRegistry[agentId];
                return specialist?.maxConcurrency ?? 1;
            },
            hooks: {
                onCreated: async (chat) => {
                    await this.trace({
                        type: "chat_created",
                        status: chat.status === "active" ? "running" : "queued",
                        runId: chat.parentRunId,
                        turnId: chat.parentTurnId,
                        chatId: chat.chatId,
                        agentId: chat.agentId as BaseAgentId,
                        details: { task: chat.task, status: chat.status },
                    });
                    const text = chat.status === "active"
                        ? "Chat created and started."
                        : "Chat created and queued (agent at capacity).";
                    await this.appendChatStatusMessage(chat, text);
                },
                onStarted: async (chat) => {
                    await this.trace({
                        type: "chat_started",
                        status: "running",
                        runId: chat.parentRunId,
                        turnId: chat.parentTurnId,
                        chatId: chat.chatId,
                        agentId: chat.agentId as BaseAgentId,
                        details: { attempts: chat.attempts },
                    });
                    await this.appendChatStatusMessage(
                        chat,
                        `Chat started (attempt ${chat.attempts}/${chat.maxRetries + 1}).`,
                    );
                },
                onRetry: async (chat) => {
                    await this.trace({
                        type: "chat_retry",
                        status: "running",
                        runId: chat.parentRunId,
                        turnId: chat.parentTurnId,
                        chatId: chat.chatId,
                        agentId: chat.agentId as BaseAgentId,
                        details: { attempts: chat.attempts, error: chat.error },
                    });
                    await this.appendChatStatusMessage(
                        chat,
                        `Chat retry after error: ${chat.error ?? "unknown"}`,
                    );
                },
                onCompleted: async (chat) => {
                    await this.trace({
                        type: "chat_completed",
                        status: "completed",
                        runId: chat.parentRunId,
                        turnId: chat.parentTurnId,
                        chatId: chat.chatId,
                        agentId: chat.agentId as BaseAgentId,
                        details: {
                            attempts: chat.attempts,
                            durationMs: (chat.closedAt ?? now()) - (chat.startedAt ?? now()),
                        },
                    });
                    await this.appendChatStatusMessage(chat, "Chat completed successfully.");
                },
                onFailed: async (chat) => {
                    await this.trace({
                        type: "chat_failed",
                        status: "error",
                        runId: chat.parentRunId,
                        turnId: chat.parentTurnId,
                        chatId: chat.chatId,
                        agentId: chat.agentId as BaseAgentId,
                        details: { attempts: chat.attempts, error: chat.error },
                    });
                    await this.appendChatStatusMessage(
                        chat,
                        `Chat failed after ${chat.attempts} attempts: ${chat.error ?? "unknown"}`,
                    );
                },
                onCancelled: async (chat) => {
                    await this.trace({
                        type: "chat_cancelled",
                        status: "cancelled",
                        runId: chat.parentRunId,
                        turnId: chat.parentTurnId,
                        chatId: chat.chatId,
                        agentId: chat.agentId as BaseAgentId,
                        details: { attempts: chat.attempts },
                    });
                    await this.appendChatStatusMessage(chat, "Chat cancelled.");
                },
            },
        });

        void this.chatManager.restore().then(n => {
            if (n > 0) console.error(`[runtime] restored ${n} interrupted chat(s) as closed`);
        });

        const codeSpecialist = this.specialistRegistry.code;
        const mathSpecialist = this.specialistRegistry.math;
        if (!codeSpecialist || !mathSpecialist) {
            throw new Error("Specialists 'code' and 'math' are required in registry.");
        }
    }

    listAgents() {
        const specialists = Object.values(this.specialistRegistry).map((agent) => ({
            id: agent.id as BaseAgentId,
            name: agent.name,
            role: agent.role,
            capabilities: agent.capabilities,
            maxConcurrency: agent.maxConcurrency,
        }));
        return [
            { id: ORCHESTRATOR_ID, name: "Orchestrator", role: "Routes and delegates tasks.", capabilities: ["routing"], maxConcurrency: Infinity },
            ...specialists,
        ];
    }

    listChats(): AgentChat[] {
        return this.chatManager.listChats();
    }

    getChat(chatId: string): AgentChat | undefined {
        return this.chatManager.getChat(chatId);
    }

    closeChat(chatId: string): AgentChat | undefined {
        return this.chatManager.closeChat(chatId);
    }

    async listThreadIds(): Promise<string[]> {
        return this.store.listThreadIds();
    }

    async getThread(threadId: string): Promise<ThreadEnvelope[]> {
        return this.store.getThreadMessages(threadId);
    }

    async getTraces(): Promise<TraceEvent[]> {
        return this.store.getTraces();
    }

    async inspectChat(queryId: string): Promise<ChatInspection> {
        const chat = this.getChat(queryId);
        const targetIds = new Set<string>([queryId]);
        if (chat) targetIds.add(chat.chatId);

        const allTraces = await this.store.getTraces();
        const traceEvents = allTraces.filter((event) => {
            if (event.chatId && targetIds.has(event.chatId)) return true;
            const detailChatId = event.details?.chatId;
            return typeof detailChatId === "string" && targetIds.has(detailChatId);
        });

        for (const event of traceEvents) {
            if (event.chatId) targetIds.add(event.chatId);
            const detailChatId = event.details?.chatId;
            if (typeof detailChatId === "string") targetIds.add(detailChatId);
        }

        const threadIds = await this.store.listThreadIds();
        const threadMessages: ThreadEnvelope[] = [];
        const relatedThreadIds = new Set<string>();
        for (const threadId of threadIds) {
            const messages = await this.store.getThreadMessages(threadId);
            const matched = messages.filter((m) => m.chatId && targetIds.has(m.chatId));
            if (matched.length > 0) {
                relatedThreadIds.add(threadId);
                threadMessages.push(...matched);
            }
        }

        let summary: ChatInspectionSummary | undefined;
        const first = traceEvents[0];
        const last = traceEvents[traceEvents.length - 1];
        if (!chat && first && last) {
            summary = {
                status: last.status,
                agentId: last.agentId,
                createdAt: first.timestamp,
                updatedAt: last.timestamp,
            };
        }

        return {
            queryId,
            chat,
            summary,
            traceEvents: traceEvents.sort((a, b) => a.timestamp - b.timestamp),
            threadMessages: threadMessages.sort((a, b) => a.timestamp - b.timestamp),
            threadIds: [...relatedThreadIds].sort(),
        };
    }

    async chat(input: ChatInput): Promise<ChatOutput> {
        const runContext = this.createRunContext();
        const fromAgentId = input.fromAgentId ?? "user";
        const initiator = resolveInitiator(fromAgentId);

        await this.trace({
            type: "run_started",
            status: "running",
            runId: runContext.runId,
            turnId: runContext.turnId,
            agentId: input.toAgentId,
            details: { fromAgentId, preview: input.content.slice(0, 120) },
        });

        try {
            const output = await this.routeMessage({
                fromAgentId,
                toAgentId: input.toAgentId,
                content: input.content,
                initiator,
                runContext,
                onAgentEvent: input.onAgentEvent,
            });

            await this.trace({
                type: "run_completed",
                status: "completed",
                runId: runContext.runId,
                turnId: runContext.turnId,
                agentId: input.toAgentId,
                details: { durationMs: output.durationMs, threadId: output.threadId },
            });

            return { ...output, runContext };
        } catch (error) {
            await this.trace({
                type: "run_failed",
                status: "error",
                runId: runContext.runId,
                turnId: runContext.turnId,
                agentId: input.toAgentId,
                details: { error: errorMessage(error) },
            });
            throw error;
        }
    }

    async runSmokeScenario(name: "math" | "code" | "orchestrator") {
        if (name === "math") {
            return this.chat({ toAgentId: "math", content: "Compute (8 * 5) - (6 / 2). Return one short sentence." });
        }
        if (name === "code") {
            return this.chat({
                toAgentId: "code",
                content: "Create a tiny Bun TypeScript function to sum two numbers and show one usage example.",
            });
        }
        return this.chat({
            toAgentId: ORCHESTRATOR_ID,
            content: [
                "Run a delegation demo.",
                "Call list_agents.",
                "Then solve (24 / 3) + (7 * 2) using delegate and then get_chat_result, and return one short sentence.",
            ].join(" "),
        });
    }

    private createRunContext(): RunContext {
        return {
            runId: createId("run"),
            turnId: createId("turn"),
            sessionId: this.sessionId,
        };
    }

    private createOrchestratorToolsForRun(runContext: RunContext) {
        return createOrchestratorTools({
            registry: this.specialistRegistry,
            getRunContext: () => runContext,
            createDelegation: (input) => {
                return this.chatManager.createChat(
                    {
                        sessionId: this.sessionId,
                        parentRunId: input.runContext.runId,
                        parentTurnId: input.runContext.turnId,
                        agentId: input.agentId,
                        conversationId: createConversationId(this.sessionId, ORCHESTRATOR_ID, input.agentId),
                        task: input.task,
                        context: input.context,
                    },
                    async (_ctx, chat) => {
                        const content = chat.context
                            ? `Context:\n${chat.context}\n\nTask:\n${chat.task}`
                            : chat.task;
                        const output = await this.routeMessage({
                            fromAgentId: ORCHESTRATOR_ID,
                            toAgentId: input.agentId as Exclude<BaseAgentId, "user">,
                            content,
                            initiator: "orchestrator",
                            runContext: input.runContext,
                            chatId: chat.chatId,
                        });
                        return output.answer;
                    },
                );
            },
            getChat: (chatId) => this.chatManager.getChat(chatId),
            closeChat: (chatId) => this.chatManager.closeChat(chatId),
            getQueuePosition: (chatId) => this.chatManager.getQueuePosition(chatId),
            traceToolEvent: async (traceInput) => {
                await this.trace({
                    type: traceInput.type,
                    status: traceInput.status,
                    runId: traceInput.runContext.runId,
                    turnId: traceInput.runContext.turnId,
                    toolName: traceInput.toolName,
                    toolCallId: traceInput.toolCallId,
                    details: traceInput.details,
                });
            },
        });
    }

    private createAgentForRoute(toAgentId: Exclude<BaseAgentId, "user">, runContext: RunContext): Agent {
        if (toAgentId === ORCHESTRATOR_ID) {
            return createOrchestratorAgent(this.createOrchestratorToolsForRun(runContext));
        }
        const specialist = this.specialistRegistry[toAgentId];
        if (!specialist) throw new Error(`Agent '${toAgentId}' is not registered.`);
        return specialist.createAgent();
    }

    private async routeMessage(input: RouteMessageInput): Promise<RouteMessageOutput> {
        const startedAt = now();
        const agent = this.createAgentForRoute(input.toAgentId, input.runContext);

        const threadId = createThreadId(this.sessionId, input.fromAgentId, input.toAgentId);
        const history = await this.store.getThreadMessages(threadId);
        const historyMessages = history.map((item) => item.message);
        agent.replaceMessages(historyMessages);

        const userMessage: AgentMessage = {
            role: "user",
            content: input.content,
            timestamp: now(),
        };

        const beforeCount = historyMessages.length;
        const unsubscribe = input.onAgentEvent ? agent.subscribe(input.onAgentEvent) : undefined;
        try {
            await agent.prompt(userMessage);
        } finally {
            unsubscribe?.();
        }
        const newMessages = agent.state.messages.slice(beforeCount);
        let previousEnvelopeId = history.at(-1)?.envelopeId;
        let currentTurnUserEnvelopeId: string | undefined;

        for (const message of newMessages) {
            const envelopeId = createId("env");
            let replyToEnvelopeId = previousEnvelopeId;
            if (message.role === "assistant" && currentTurnUserEnvelopeId) {
                replyToEnvelopeId = currentTurnUserEnvelopeId;
            }

            const envelope: ThreadEnvelope = {
                envelopeId,
                parentEnvelopeId: previousEnvelopeId,
                replyToEnvelopeId,
                sessionId: this.sessionId,
                threadId,
                runId: input.runContext.runId,
                turnId: input.runContext.turnId,
                timestamp: now(),
                fromAgentId:
                    message.role === "assistant"
                        ? input.toAgentId
                        : message.role === "user"
                            ? input.fromAgentId
                            : "orchestrator",
                toAgentId:
                    message.role === "assistant"
                        ? input.fromAgentId
                        : message.role === "user"
                            ? input.toAgentId
                            : input.toAgentId,
                initiator: input.initiator,
                chatId: input.chatId,
                toolCallId: input.toolCallId,
                message,
            };
            try {
                await this.store.appendThreadMessage(envelope);
            } catch (err) {
                console.error("[runtime] appendThreadMessage failed:", errorMessage(err));
            }
            if (message.role === "user") {
                currentTurnUserEnvelopeId = envelopeId;
            }
            previousEnvelopeId = envelopeId;
        }

        const answer = extractLastAssistantText(agent.state.messages);
        const durationMs = now() - startedAt;

        await this.trace({
            type: "message_routed",
            status: "ok",
            runId: input.runContext.runId,
            turnId: input.runContext.turnId,
            agentId: input.toAgentId,
            chatId: input.chatId,
            toolCallId: input.toolCallId,
            details: {
                fromAgentId: input.fromAgentId,
                toAgentId: input.toAgentId,
                threadId,
                durationMs,
                messageCount: newMessages.length,
            },
        });

        return {
            answer,
            durationMs,
            threadId,
        };
    }

    private async appendChatStatusMessage(chat: AgentChat, text: string) {
        try {
            const threadId = createThreadId(this.sessionId, ORCHESTRATOR_ID, chat.agentId as BaseAgentId);
            const history = await this.store.getThreadMessages(threadId);
            const previousEnvelopeId = history.at(-1)?.envelopeId;
            const envelopeId = createId("env");
            const message: AgentMessage = {
                role: "user",
                content: `[chat_status:${chat.status}] chatId=${chat.chatId} ${text}`,
                timestamp: now(),
            };

            const envelope: ThreadEnvelope = {
                envelopeId,
                parentEnvelopeId: previousEnvelopeId,
                replyToEnvelopeId: previousEnvelopeId,
                sessionId: this.sessionId,
                threadId,
                runId: chat.parentRunId,
                turnId: chat.parentTurnId,
                timestamp: now(),
                fromAgentId: ORCHESTRATOR_ID,
                toAgentId: chat.agentId as BaseAgentId,
                initiator: "system",
                chatId: chat.chatId,
                message,
            };
            await this.store.appendThreadMessage(envelope);
        } catch (err) {
            console.error("[runtime] appendChatStatusMessage failed:", errorMessage(err));
        }
    }

    private async trace(
        input: Omit<TraceEvent, "eventId" | "timestamp" | "sessionId">,
    ) {
        const event: TraceEvent = {
            eventId: createId("evt"),
            timestamp: now(),
            sessionId: this.sessionId,
            ...input,
        };
        try {
            await this.store.appendTrace(event);
        } catch (err) {
            console.error("[runtime] trace write failed:", errorMessage(err), event.type);
        }
        debugTrace(event);
    }
}

function debugTrace(event: TraceEvent): void {
    const d = event.details ?? {};
    let line: string | null = null;

    switch (event.type) {
        case "run_started":
            line = `[run]  ← ${d.fromAgentId ?? "?"}: "${String(d.preview ?? "").slice(0, 60)}"`;
            break;
        case "run_completed":
            line = `[run]  ✓ done ${d.durationMs}ms`;
            break;
        case "run_failed":
            line = `[run]  ✗ failed: ${d.error ?? "unknown"}`;
            break;
        case "tool_start": {
            const args = (d.args ?? d) as Record<string, unknown>;
            if (event.toolName === "delegate" || event.toolName === "delegate_task") {
                line = `[tool] delegate → ${args.agentId}: "${String(args.task ?? "").slice(0, 60)}"`;
            } else if (event.toolName === "get_chat_result" || event.toolName === "get_chat_status") {
                line = `[tool] ${event.toolName} → ${args.chatId ?? "?"}`;
            } else {
                line = `[tool] ${event.toolName}`;
            }
            break;
        }
        case "chat_created":
            line = `[chat] ${event.chatId} created → ${event.agentId} [${d.status}]`;
            break;
        case "chat_started":
            line = `[chat] ${event.chatId} started → ${event.agentId}`;
            break;
        case "chat_completed":
            line = `[chat] ${event.chatId} ✓ done ${d.durationMs}ms`;
            break;
        case "chat_failed":
            line = `[chat] ${event.chatId} ✗ failed: ${d.error ?? "unknown"}`;
            break;
        case "chat_cancelled":
            line = `[chat] ${event.chatId} cancelled`;
            break;
    }

    if (line) process.stderr.write(`\x1b[2m${line}\x1b[0m\n`);
}
