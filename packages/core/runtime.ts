import type { Agent, AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { createOrchestratorAgent, createSpecialistRegistry, createAgentDefinitions, ORCHESTRATOR_ID } from "./agents";
import type { AgentChat, BaseAgentId, Initiator, RunContext, ThreadEnvelope, TraceEvent } from "./contracts";
import { errorMessage } from "./errors";
import { createId, now } from "./ids";
import { ChatManager } from "./chat-manager";
import { ThreadStore } from "./thread-store";
import { createOrchestratorTools, createOrchestratorToolEntries, type SpecialistRegistry } from "./tools";
import { ToolRegistry } from "./tool-registry";
import { type AgentDefinition } from "./agent-builder";
import { type HITLHandler, wrapTool, resolvePermission } from "./tool-middleware";
import { compileSystemPrompt } from "./prompt-compiler";
import { Scheduler } from "./scheduler";
import { createSchedulerToolEntries } from "./scheduler-tools";
import { CredentialStore } from "./credential-store";

interface RouteMessageInput {
    fromAgentId: BaseAgentId;
    toAgentId: string;
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
    toAgentId: string;
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

export interface RuntimeOptions {
    sessionId?: string;
    agents?: AgentDefinition[];
    hitlHandler?: HITLHandler;
    schedules?: Array<{ id: string; cron: string; agentId: string; task: string }>;
}

const denyAllHandler: HITLHandler = async () => ({ approved: false });

export class MultiAgentRuntime {
    readonly sessionId: string;
    readonly store: ThreadStore;
    readonly chatManager: ChatManager;
    readonly specialistRegistry: SpecialistRegistry;
    readonly toolRegistry: ToolRegistry;
    readonly agentDefs: Map<string, AgentDefinition>;
    readonly hitlHandler: HITLHandler;
    readonly scheduler: Scheduler;
    readonly credentialStore: CredentialStore;

    constructor(optionsOrSessionId?: RuntimeOptions | string) {
        const options: RuntimeOptions = typeof optionsOrSessionId === "string"
            ? { sessionId: optionsOrSessionId }
            : optionsOrSessionId ?? {};

        this.sessionId = options.sessionId ?? "default";
        this.store = new ThreadStore({ sessionId: this.sessionId });
        this.hitlHandler = options.hitlHandler ?? denyAllHandler;

        // Credential store (shares base dir with thread store)
        this.credentialStore = new CredentialStore({
            dataDir: ".runtime-data",
            masterPassword: process.env.MASTER_PASSWORD,
        });

        const credentialOpts = { credentialStore: this.credentialStore };

        // Agent definitions
        const agentDefList = options.agents ?? createAgentDefinitions(credentialOpts);
        this.agentDefs = new Map(agentDefList.map(d => [d.id, d]));

        // Backward-compatible specialist registry (used by orchestrator tools)
        this.specialistRegistry = createSpecialistRegistry(credentialOpts);

        // Tool registry
        this.toolRegistry = new ToolRegistry();

        this.chatManager = new ChatManager({
            persistChat: (chat) => this.store.appendChatRecord(chat),
            restoreRecords: () => this.store.getChatRecords(),
            getMaxConcurrency: (agentId) => {
                const def = this.agentDefs.get(agentId);
                return def?.maxConcurrency ?? 1;
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

        // Validate required agents exist
        for (const required of ["code", "math"] as const) {
            if (!this.agentDefs.has(required)) {
                throw new Error(`Agent '${required}' is required but not defined.`);
            }
        }

        // Scheduler
        this.scheduler = new Scheduler({
            persistJob: (job) => this.store.appendJob(job),
            restoreJobs: () => this.store.getJobRecords(),
            executeTask: async (agentId, task) => {
                const result = await this.chat({ toAgentId: agentId, content: task });
                return result.answer;
            },
            trace: async (event) => {
                await this.trace({
                    ...event,
                    sessionId: this.sessionId,
                } as any);
            },
        });

        // Config-driven schedules
        if (options.schedules) {
            for (const sched of options.schedules) {
                this.scheduler.addJob({
                    sessionId: this.sessionId,
                    createdBy: "runtime",
                    targetAgentId: sched.agentId,
                    task: sched.task,
                    schedule: { type: "cron", cron: sched.cron },
                });
            }
        }

        // Restore persisted jobs
        void this.scheduler.restore();
    }

    listAgents() {
        return [...this.agentDefs.values()].map((def) => ({
            id: def.id,
            name: def.name,
            role: def.role,
            capabilities: def.capabilities,
            maxConcurrency: def.maxConcurrency,
        }));
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

    async runSmokeScenario(name: "math" | "code" | "orchestrator" | "explorer" | "writer" | "debugger") {
        if (name === "math") {
            return this.chat({ toAgentId: "math", content: "Compute (8 * 5) - (6 / 2). Return one short sentence." });
        }
        if (name === "code") {
            return this.chat({
                toAgentId: "code",
                content: "Create a tiny Bun TypeScript function to sum two numbers and show one usage example.",
            });
        }
        if (name === "explorer") {
            return this.chat({
                toAgentId: "explorer",
                content: "Search the web for 'Bun runtime latest version' and return the top 3 results as a short list.",
            });
        }
        if (name === "writer") {
            return this.chat({
                toAgentId: "writer",
                content: "Write a 3-sentence changelog entry for adding a web explorer agent to a multi-agent runtime.",
            });
        }
        if (name === "debugger") {
            return this.chat({
                toAgentId: "debugger",
                content: "List the files in packages/core/ and read packages/core/errors.ts. Give a brief code review summary.",
            });
        }
        return this.chat({
            toAgentId: ORCHESTRATOR_ID,
            content: [
                "Run a delegation demo.",
                "You will have to solve a mathematical problem.",
                "Then solve (24 / 3) + (7 * 2) using delegate and then get the result, and return one short sentence.",
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
                        task: input.task,
                        context: input.context,
                    },
                    async (_ctx, chat) => {
                        const content = chat.context
                            ? `Context:\n${chat.context}\n\nTask:\n${chat.task}`
                            : chat.task;
                        const output = await this.routeMessage({
                            fromAgentId: ORCHESTRATOR_ID,
                            toAgentId: input.agentId,
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

    private createSchedulerToolsForRun(): AgentTool<any>[] {
        const entries = createSchedulerToolEntries({
            scheduler: this.scheduler,
            sessionId: this.sessionId,
            callerAgentId: ORCHESTRATOR_ID,
            allowedTargets: null, // orchestrator can target any agent
        });
        return entries.map(entry => ({
            name: entry.name,
            label: entry.description,
            description: entry.description,
            parameters: entry.parameters,
            execute: entry.execute,
        } as AgentTool<any>));
    }

    private createAgentForRoute(toAgentId: string, runContext: RunContext): Agent {
        if (toAgentId === ORCHESTRATOR_ID) {
            const orchTools = this.createOrchestratorToolsForRun(runContext);
            return createOrchestratorAgent([...orchTools], {
                credentialStore: this.credentialStore,
            });
        }

        const def = this.agentDefs.get(toAgentId);
        if (!def) throw new Error(`Agent '${toAgentId}' is not registered.`);

        // Resolve localTools → AgentTool[] with middleware (permissions, HITL)
        const localTools: AgentTool<any>[] = (def.localTools ?? []).map(entry => {
            const permission = resolvePermission(
                undefined,
                def.permissions,
                entry.name,
                entry.defaultPermission ?? "allow",
            );
            return wrapTool(
                {
                    name: entry.name,
                    label: entry.description,
                    description: entry.description,
                    parameters: entry.parameters,
                    execute: entry.execute,
                } as AgentTool<any>,
                {
                    permission,
                    hitlHandler: this.hitlHandler,
                    agentId: toAgentId,
                    tracePermission: async (info) => {
                        await this.trace({
                            type: "tool_start",
                            status: "ok",
                            runId: runContext.runId,
                            turnId: runContext.turnId,
                            toolName: info.toolName,
                            details: { permission: info.permission, resolved: info.resolved },
                        });
                    },
                },
            );
        });

        // Inject scheduler tools into the secretary agent
        if (toAgentId === "secretary") {
            const schedulerTools = this.createSchedulerToolsForRun();
            localTools.push(...schedulerTools);
        }

        const systemPrompt = compileSystemPrompt(def, localTools);
        return def.createAgent(localTools, systemPrompt);
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
