import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, statSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createOrchestratorAgent, createSpecialistRegistry, ORCHESTRATOR_ID } from "./agents";
import type { AgentChat, BaseAgentId, Initiator, RunContext, ThreadEnvelope, TraceEvent } from "./contracts";
import { errorMessage } from "./errors";
import { createId, now } from "./ids";
import { ChatManager, createConversationId } from "./chat-manager";
import { ThreadStore } from "./thread-store";
import { createOrchestratorTools, createSpecialistTools, type SpecialistRegistry } from "./tools";

interface RouteMessageInput {
    fromAgentId: BaseAgentId;
    toAgentId: Exclude<BaseAgentId, "user">;
    content: string;
    initiator: Initiator;
    runContext: RunContext;
    chatId?: string;
    toolCallId?: string;
    onAgentEvent?: (event: AgentEvent) => void;
    enableOrchestratorTools?: boolean;
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

export interface RuntimeOptions {
    historyWindowMessages?: number;
}

const DEFAULT_HISTORY_WINDOW_MESSAGES = 50;
const DEFAULT_BASH_TIMEOUT_MS = 20_000;
const MAX_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_OUTPUT_LINES = 2_000;
const MAX_BASH_OUTPUT_BYTES = 50 * 1024;
const MAX_BASH_ROLLING_BYTES = MAX_BASH_OUTPUT_BYTES * 2;

interface BashRunInput {
    command: string;
    cwd?: string;
    timeoutMs?: number;
}

interface BashRunOutput {
    output: string;
    cwd: string;
    timeoutMs: number;
    durationMs: number;
    exitCode: number;
    truncated: boolean;
    fullOutputPath?: string;
}

interface TailTruncationResult {
    content: string;
    truncated: boolean;
    totalLines: number;
    outputLines: number;
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function sanitizeShellOutput(text: string): string {
    return stripAnsi(text)
        .replace(/\r/g, "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function truncateStringToBytesFromEnd(text: string, maxBytes: number): string {
    const buffer = Buffer.from(text, "utf-8");
    if (buffer.length <= maxBytes) return text;
    let start = buffer.length - maxBytes;
    while (start < buffer.length) {
        const byte = buffer[start];
        if (byte === undefined || (byte & 0xc0) !== 0x80) break;
        start += 1;
    }
    return buffer.slice(start).toString("utf-8");
}

function truncateTail(text: string, maxLines = MAX_BASH_OUTPUT_LINES, maxBytes = MAX_BASH_OUTPUT_BYTES): TailTruncationResult {
    const totalLines = text.length === 0 ? 0 : text.split("\n").length;
    const totalBytes = Buffer.byteLength(text, "utf-8");
    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false, totalLines, outputLines: totalLines };
    }

    const lines = text.split("\n");
    const outputLines: string[] = [];
    let outputBytes = 0;

    for (let i = lines.length - 1; i >= 0 && outputLines.length < maxLines; i -= 1) {
        const line = lines[i] ?? "";
        const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0);
        if (outputBytes + lineBytes > maxBytes) {
            if (outputLines.length === 0) {
                outputLines.unshift(truncateStringToBytesFromEnd(line, maxBytes));
            }
            break;
        }
        outputLines.unshift(line);
        outputBytes += lineBytes;
    }

    return {
        content: outputLines.join("\n"),
        truncated: true,
        totalLines,
        outputLines: outputLines.length,
    };
}

function createTempOutputPath(): string {
    return join(tmpdir(), `pi-agent-core-bash-${randomBytes(8).toString("hex")}.log`);
}

function isWithinRoot(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveHistoryWindowMessages(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_HISTORY_WINDOW_MESSAGES;
    }
    return Math.max(0, Math.trunc(limit));
}

function selectHistoryWindow(messages: AgentMessage[], limit: number): AgentMessage[] {
    if (limit <= 0) return [];
    if (messages.length <= limit) return messages;
    return messages.slice(-limit);
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
    readonly historyWindowMessages: number;
    readonly workspaceRoot: string;

    constructor(sessionId = "default", options: RuntimeOptions = {}) {
        this.sessionId = sessionId;
        this.workspaceRoot = process.cwd();
        this.historyWindowMessages = resolveHistoryWindowMessages(options.historyWindowMessages);
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
                        keepAlive: true,
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
            findContinuableChat: ({ sessionId, agentId }) => {
                const conversationId = createConversationId(sessionId, ORCHESTRATOR_ID, agentId);
                return this.chatManager
                    .listChats()
                    .find((chat) => chat.conversationId === conversationId && chat.status === "active" && chat.keepAlive);
            },
            sendChatFollowUp: (chatId, input) => this.chatManager.sendMessage(chatId, input),
            getChat: (chatId) => this.chatManager.getChat(chatId),
            closeChat: (chatId) => this.chatManager.closeChat(chatId),
            runBash: (input) => this.runBashCommand(input),
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

    private createSpecialistToolsForRun(
        runContext: RunContext,
        specialistId: Exclude<BaseAgentId, "user" | "orchestrator">,
        chatId?: string,
    ) {
        return createSpecialistTools({
            specialistId,
            getRunContext: () => runContext,
            sendReportToOrchestrator: (input) => this.sendSpecialistReport(input),
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
            chatId,
        });
    }

    private async sendSpecialistReport(input: {
        specialistId: Exclude<BaseAgentId, "user" | "orchestrator">;
        message: string;
        runContext: RunContext;
        toolCallId: string;
        chatId?: string;
    }): Promise<string> {
        const report = await this.routeMessage({
            fromAgentId: input.specialistId,
            toAgentId: ORCHESTRATOR_ID,
            content: `Specialist report from ${input.specialistId}: ${input.message}`,
            initiator: "specialist",
            runContext: input.runContext,
            chatId: input.chatId,
            toolCallId: input.toolCallId,
            enableOrchestratorTools: false,
        });
        return report.answer;
    }

    private createAgentForRoute(
        toAgentId: Exclude<BaseAgentId, "user">,
        runContext: RunContext,
        enableOrchestratorTools = true,
        chatId?: string,
    ): Agent {
        if (toAgentId === ORCHESTRATOR_ID) {
            const tools = enableOrchestratorTools ? this.createOrchestratorToolsForRun(runContext) : [];
            return createOrchestratorAgent(tools);
        }
        const specialist = this.specialistRegistry[toAgentId];
        if (!specialist) throw new Error(`Agent '${toAgentId}' is not registered.`);
        const specialistTools = this.createSpecialistToolsForRun(runContext, toAgentId, chatId);
        return specialist.createAgent(specialistTools);
    }

    private async routeMessage(input: RouteMessageInput): Promise<RouteMessageOutput> {
        const startedAt = now();
        const agent = this.createAgentForRoute(
            input.toAgentId,
            input.runContext,
            input.enableOrchestratorTools ?? true,
            input.chatId,
        );

        const threadId = createThreadId(this.sessionId, input.fromAgentId, input.toAgentId);
        const history = await this.store.getThreadMessages(threadId);
        const historyMessages = history.map((item) => item.message);
        const contextMessages = selectHistoryWindow(historyMessages, this.historyWindowMessages);
        agent.replaceMessages(contextMessages);

        const userMessage: AgentMessage = {
            role: "user",
            content: input.content,
            timestamp: now(),
        };

        const beforeCount = contextMessages.length;
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
                historyTotal: historyMessages.length,
                contextWindowSize: contextMessages.length,
                contextWindowLimit: this.historyWindowMessages,
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

    private resolveBashCwd(cwd?: string): string {
        const candidate = cwd?.trim()
            ? isAbsolute(cwd.trim())
                ? resolve(cwd.trim())
                : resolve(this.workspaceRoot, cwd.trim())
            : this.workspaceRoot;

        if (!isWithinRoot(this.workspaceRoot, candidate)) {
            throw new Error(`cwd must stay inside workspace root: ${this.workspaceRoot}`);
        }

        if (!existsSync(candidate)) {
            throw new Error(`cwd does not exist: ${candidate}`);
        }

        if (!statSync(candidate).isDirectory()) {
            throw new Error(`cwd is not a directory: ${candidate}`);
        }

        return candidate;
    }

    private resolveBashTimeoutMs(timeoutMs?: number): number {
        if (timeoutMs === undefined) return DEFAULT_BASH_TIMEOUT_MS;
        const normalized = Math.trunc(timeoutMs);
        if (!Number.isFinite(normalized) || normalized <= 0) {
            throw new Error("timeoutMs must be a positive number.");
        }
        return Math.min(normalized, MAX_BASH_TIMEOUT_MS);
    }

    private async runBashCommand(input: BashRunInput): Promise<BashRunOutput> {
        const startedAt = now();
        const cwd = this.resolveBashCwd(input.cwd);
        const timeoutMs = this.resolveBashTimeoutMs(input.timeoutMs);

        const abortController = new AbortController();
        let timedOut = false;
        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            abortController.abort();
        }, timeoutMs);

        const processRef = Bun.spawn({
            cmd: ["bash", "-lc", input.command],
            cwd,
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
            signal: abortController.signal,
        });

        let totalOutputBytes = 0;
        let rollingBytes = 0;
        const rollingChunks: string[] = [];
        const bufferedOutput: string[] = [];
        let fullOutputPath: string | undefined;
        let outputStream: WriteStream | undefined;

        const appendChunk = (chunk: Uint8Array) => {
            const text = sanitizeShellOutput(new TextDecoder().decode(chunk));
            if (!text) return;

            const chunkBytes = Buffer.byteLength(text, "utf-8");
            totalOutputBytes += chunkBytes;

            if (!outputStream) {
                bufferedOutput.push(text);
            }

            if (!outputStream && totalOutputBytes > MAX_BASH_OUTPUT_BYTES) {
                fullOutputPath = createTempOutputPath();
                outputStream = createWriteStream(fullOutputPath, { flags: "a" });
                for (const existing of bufferedOutput) outputStream.write(existing);
                bufferedOutput.length = 0;
            }

            if (outputStream) outputStream.write(text);

            rollingChunks.push(text);
            rollingBytes += chunkBytes;
            while (rollingBytes > MAX_BASH_ROLLING_BYTES && rollingChunks.length > 1) {
                const removed = rollingChunks.shift() ?? "";
                rollingBytes -= Buffer.byteLength(removed, "utf-8");
            }
        };

        const consumeStream = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
            if (!stream) return;
            const reader = stream.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) appendChunk(value);
                }
            } catch (err) {
                if (!abortController.signal.aborted) {
                    throw err;
                }
            } finally {
                reader.releaseLock();
            }
        };

        let exitCode: number;
        try {
            const [code] = await Promise.all([
                processRef.exited,
                consumeStream(processRef.stdout),
                consumeStream(processRef.stderr),
            ]);
            exitCode = code;
        } finally {
            clearTimeout(timeoutHandle);
            if (outputStream) {
                await new Promise<void>((resolveEnd) => {
                    outputStream!.end(() => resolveEnd());
                });
            }
        }

        const recentOutput = outputStream ? rollingChunks.join("") : bufferedOutput.join("");
        const truncation = truncateTail(recentOutput);
        let output = truncation.content || "(no output)";
        if (truncation.truncated && fullOutputPath) {
            output += `\n\n[output truncated: showing last ${truncation.outputLines} lines out of ${truncation.totalLines}. full output: ${fullOutputPath}]`;
        }

        if (timedOut) {
            throw new Error(`${output}\n\nCommand timed out after ${timeoutMs}ms.`);
        }

        if (exitCode !== 0) {
            throw new Error(`${output}\n\nCommand exited with code ${exitCode}.`);
        }

        return {
            output,
            cwd,
            timeoutMs,
            durationMs: now() - startedAt,
            exitCode,
            truncated: truncation.truncated,
            fullOutputPath,
        };
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
            } else if (event.toolName === "get_chat_result" || event.toolName === "get_chat_status" || event.toolName === "follow_up_chat") {
                line = `[tool] ${event.toolName} → ${args.chatId ?? "?"}`;
            } else if (event.toolName === "run_bash") {
                line = `[tool] run_bash → "${String(args.command ?? "").slice(0, 60)}"`;
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
