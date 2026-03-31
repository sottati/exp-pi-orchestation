import type { Agent, AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import {
    createSpecialistRegistry,
    createAgentDefinitions,
    ORCHESTRATOR_ID,
    isOrchestratorAgentId,
} from "./agents";
import type { AgentChat, BaseAgentId, Initiator, RunContext, ThreadEnvelope, TraceEvent } from "./contracts";
import { errorMessage, safeAsync } from "./errors";
import { createId, now } from "./ids";
import { ChatManager } from "./chat-manager";
import { ThreadStore } from "./thread-store";
import { createOrchestratorTools, createOrchestratorToolEntries, type SpecialistRegistry } from "./tools";
import { ToolRegistry } from "./tool-registry";
import { type AgentDefinition, type AgentSkillsConfig } from "./agent-builder";
import { type HITLHandler, wrapTool, resolvePermission } from "./tool-middleware";
import { compileSystemPrompt } from "./prompt-compiler";
import { Scheduler } from "./scheduler";
import { createSchedulerToolEntries } from "./scheduler-tools";
import { createNotifyContactToolEntry } from "./notify-tool";
import { createBackgroundTaskToolEntry } from "./background-task-tool";
import { CredentialStore } from "./credential-store";
import { WorkspaceManager } from "./workspace-manager";
import { delimiter, join } from "node:path";
import { buildSkillContextSection } from "./skills-layer";

interface RouteMessageInput {
    fromAgentId: BaseAgentId;
    toAgentId: string;
    content: string;
    initiator: Initiator;
    runContext: RunContext;
    metadata?: Record<string, unknown>;
    chatId?: string;
    toolCallId?: string;
    onAgentEvent?: (event: AgentEvent) => void;
}

interface RouteMessageOutput {
    answer: string;
    durationMs: number;
    threadId: string;
}

interface PreparedAgent {
    agent: Agent;
    selectedSkills: string[];
    availableSkills: number;
    skillErrors: string[];
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
    initiator?: Initiator;
    metadata?: Record<string, unknown>;
    channel?: RunContext["channel"];
    contact?: string;
    orchestratorId?: string;
    onAgentEvent?: (event: AgentEvent) => void;
}

export interface ChatOutput extends RouteMessageOutput {
    runContext: RunContext;
}

function stripThoughtPrefix(text: string): string {
    let next = text.trim();
    while (true) {
        const replaced = next.replace(/^\s*(?:\.\s*)?thought:\s*/i, "");
        if (replaced === next) break;
        next = replaced.trimStart();
    }
    return next.trim();
}

function extractTextFromContent(content: unknown): { text: string; hasToolCall: boolean } {
    if (typeof content === "string") {
        return { text: content, hasToolCall: false };
    }
    if (!Array.isArray(content)) {
        return { text: "", hasToolCall: false };
    }

    const textParts: string[] = [];
    let hasToolCall = false;

    for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const typedBlock = block as { type?: unknown; text?: unknown };
        const type = typeof typedBlock.type === "string" ? typedBlock.type : "";

        if (type === "toolCall" || type === "tool_call" || type === "function_call") {
            hasToolCall = true;
        }
        if (type === "text" && typeof typedBlock.text === "string") {
            textParts.push(typedBlock.text);
        }
    }

    return { text: textParts.join(""), hasToolCall };
}

function isChatStatusText(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return (
        /^chatid\s+\S+\s+is\s+/.test(normalized) ||
        normalized.startsWith("chat started with ") ||
        normalized.startsWith("chat queued for ") ||
        normalized.includes(" not found")
    );
}

function isDelegationPlaceholderText(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return true;
    return (
        isChatStatusText(text) ||
        normalized.includes("chatid=") ||
        normalized.includes("delegate") ||
        normalized.includes("delegat") ||
        normalized.includes("delego") ||
        normalized.includes("delegué") ||
        normalized.includes("en cola") ||
        normalized.includes("queued") ||
        normalized.includes("te aviso")
    );
}

function extractCompletedChatResultFallback(messages: AgentMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as {
            role?: string;
            toolName?: unknown;
            content?: unknown;
            details?: unknown;
        };
        if (message.role !== "toolResult") continue;
        if (message.toolName !== "get_chat_result") continue;

        const details =
            typeof message.details === "object" && message.details !== null
                ? (message.details as Record<string, unknown>)
                : undefined;

        const status = typeof details?.status === "string" ? details.status : undefined;
        const closeReason =
            typeof details?.closeReason === "string" ? details.closeReason : undefined;

        if (status !== "closed" || closeReason !== "completed") continue;

        if (typeof details?.result === "string") {
            const fromDetails = stripThoughtPrefix(details.result);
            if (fromDetails) return fromDetails;
        }

        const { text } = extractTextFromContent(message.content);
        const fromContent = stripThoughtPrefix(text);
        if (fromContent && !isChatStatusText(fromContent)) return fromContent;
    }

    return "";
}

export function extractLastAssistantText(messages: AgentMessage[]): string {
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
        }

        const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
        const { text, hasToolCall } = extractTextFromContent(message.content);
        const visibleText = stripThoughtPrefix(text);

        // Tool-use turns are intermediate by design; don't expose them as final answers.
        if (stopReason === "toolUse" || hasToolCall) {
            continue;
        }

        if (visibleText) {
            return visibleText;
        }
    }

    const completedDelegationResult = extractCompletedChatResultFallback(messages);
    if (completedDelegationResult) {
        return completedDelegationResult;
    }

    if (lastAssistantError) {
        return `Model error: ${lastAssistantError}`;
    }

    return "";
}

const TRACE_STRING_LIMIT = 240;
const TRACE_SENSITIVE_KEY = /(password|pass|token|secret|api[-_]?key|authorization|cookie|credential|refresh|clientsecret|accesstoken)/i;

function truncateForTrace(text: string, limit = TRACE_STRING_LIMIT): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...`;
}

function sanitizeTraceValue(value: unknown, key?: string, depth = 0): unknown {
    if (key && TRACE_SENSITIVE_KEY.test(key)) return "[REDACTED]";

    if (typeof value === "string") return truncateForTrace(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    if (value === undefined) return undefined;

    if (Array.isArray(value)) {
        if (depth >= 1) return `[array(${value.length})]`;
        return value.slice(0, 5).map((item) => sanitizeTraceValue(item, undefined, depth + 1));
    }

    if (typeof value === "object") {
        if (depth >= 2) return "[object]";
        const source = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(source).slice(0, 12)) {
            out[k] = sanitizeTraceValue(v, k, depth + 1);
        }
        return out;
    }

    return String(value);
}

function sanitizeToolArgsForTrace(toolName: string, args: unknown): Record<string, unknown> | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    const source = args as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        // `interact_page.task` can contain resolved credentials; never persist it.
        if (toolName === "interact_page" && key === "task") {
            out.task = "[REDACTED]";
            if (typeof value === "string") out.taskLength = value.length;
            continue;
        }
        out[key] = sanitizeTraceValue(value, key);
    }
    return out;
}

function extractToolErrorFromResult(result: unknown): string | undefined {
    if (!result || typeof result !== "object") return undefined;
    const typed = result as { content?: unknown };
    if (!Array.isArray(typed.content)) return undefined;
    for (const block of typed.content) {
        if (typeof block !== "object" || block === null) continue;
        const maybeText = block as { type?: unknown; text?: unknown };
        if (maybeText.type === "text" && typeof maybeText.text === "string" && maybeText.text.trim()) {
            return truncateForTrace(maybeText.text.trim(), 500);
        }
    }
    return undefined;
}

function summarizeToolDetails(result: unknown): unknown {
    if (!result || typeof result !== "object") return undefined;
    const typed = result as { details?: unknown };
    return sanitizeTraceValue(typed.details);
}

function resolveInitiator(fromAgentId: BaseAgentId): Initiator {
    if (fromAgentId === "user") return "user";
    if (fromAgentId.startsWith("external:")) return "external";
    if (isOrchestratorAgentId(fromAgentId)) return "orchestrator";
    return "specialist";
}

function isTopLevelHumanInitiator(initiator: Initiator): boolean {
    return initiator === "user" || initiator === "external";
}

function createThreadId(sessionId: string, a: BaseAgentId, b: BaseAgentId): string {
    return `${sessionId}::${[a, b].sort().join("<->")}`;
}

/**
 * Maximum number of history messages to load per agent turn.
 * Prevents context-window overflow when threads accumulate large tool results
 * (e.g. browse_url returning thousands of chars of markdown).
 * We keep the most recent N messages; older messages are discarded entirely
 * rather than summarised, since the model will re-orient from the system
 * prompt + the current user message.
 */
const MAX_HISTORY_MESSAGES = 40;

/**
 * Maximum chars of tool-result content kept for *older* messages in the window.
 * Recent messages (last 10) are kept verbatim.
 * This prevents a handful of large browse results from eating the whole context.
 */
const OLD_TOOL_RESULT_MAX_CHARS = 1_500;

function pruneHistory(messages: AgentMessage[]): AgentMessage[] {
    // Hard cap: keep only the last MAX_HISTORY_MESSAGES entries.
    const capped = messages.length > MAX_HISTORY_MESSAGES
        ? messages.slice(messages.length - MAX_HISTORY_MESSAGES)
        : messages;

    // For the older half of the window, truncate large tool-result text blocks.
    const recentBoundary = Math.max(0, capped.length - 10);
    return capped.map((msg, idx) => {
        if (idx >= recentBoundary) return msg; // recent — keep verbatim

        // Attempt to shrink oversized tool result content blocks.
        const typed = msg as { role?: string; content?: unknown };
        if (typed.role !== "toolResult" || !Array.isArray(typed.content)) return msg;

        let mutated = false;
        const newContent = (typed.content as unknown[]).map((block) => {
            if (
                typeof block !== "object" || block === null ||
                (block as { type?: unknown }).type !== "text"
            ) return block;
            const b = block as { type: string; text?: string };
            if (typeof b.text !== "string" || b.text.length <= OLD_TOOL_RESULT_MAX_CHARS) return block;
            mutated = true;
            const trimmed = b.text.slice(0, OLD_TOOL_RESULT_MAX_CHARS);
            return { ...b, text: `${trimmed}\n[…truncated in history]` };
        });

        return mutated ? { ...typed, content: newContent } as AgentMessage : msg;
    });
}

export interface RuntimeOptions {
    sessionId?: string;
    orgId?: string;
    dataDir?: string;
    agents?: AgentDefinition[];
    agentSkills?: AgentSkillsConfig;
    orchestratorIds?: string[];
    hitlHandler?: HITLHandler;
    schedules?: Array<{ id: string; cron: string; agentId: string; task: string }>;
    workspaceManager?: WorkspaceManager;
    workspaceAllowedRoots?: string[];
    /** If provided, called after each scheduled job completes when the job has a contact target. */
    deliverResult?: (job: import("./contracts").ScheduledJob, result: string) => Promise<void>;
    /** If provided, agents can call notify_contact to push proactive messages to a WhatsApp contact. */
    sendMessage?: (orgId: string, orchestratorId: string, contact: string, body: string) => Promise<void>;
}

const denyAllHandler: HITLHandler = async () => ({ approved: false });

const DEFAULT_DELEGATION_TIMEOUT_MS = 180_000;
const DELEGATION_TIMEOUT_BY_AGENT: Partial<Record<BaseAgentId, number>> = {
    explorer: 300_000,
    "web-designer": 300_000,
    marketing: 300_000,
    "graphic-designer": 300_000,
};

function parseAllowedRoots(raw?: string): string[] | undefined {
    if (!raw) return undefined;
    const parts = raw
        .split(delimiter)
        .flatMap((item) => item.split(/\r?\n/))
        .map((item) => item.trim())
        .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
}

export class MultiAgentRuntime {
    readonly sessionId: string;
    readonly orgId?: string;
    readonly primaryOrchestratorId: string;
    readonly store: ThreadStore;
    readonly chatManager: ChatManager;
    readonly specialistRegistry: SpecialistRegistry;
    readonly toolRegistry: ToolRegistry;
    readonly agentDefs: Map<string, AgentDefinition>;
    readonly hitlHandler: HITLHandler;
    readonly scheduler: Scheduler;
    readonly credentialStore: CredentialStore;
    readonly workspaceManager: WorkspaceManager;
    private readonly sendMessageFn?: (orgId: string, orchestratorId: string, contact: string, body: string) => Promise<void>;

    constructor(optionsOrSessionId?: RuntimeOptions | string) {
        const options: RuntimeOptions = typeof optionsOrSessionId === "string"
            ? { sessionId: optionsOrSessionId }
            : optionsOrSessionId ?? {};

        this.sessionId = options.sessionId ?? "default";
        this.orgId = options.orgId;
        const dataDir = options.dataDir ?? ".runtime-data";
        this.store = new ThreadStore({ sessionId: this.sessionId, baseDir: dataDir });
        this.hitlHandler = options.hitlHandler ?? denyAllHandler;
        this.sendMessageFn = options.sendMessage;

        // Credential store (shares base dir with thread store)
        this.credentialStore = new CredentialStore({
            dataDir,
            masterPassword: process.env.MASTER_PASSWORD,
        });

        const workspaceAllowedRoots = options.workspaceAllowedRoots
            ?? parseAllowedRoots(process.env.WORKSPACE_ALLOWED_ROOTS);
        this.workspaceManager = options.workspaceManager ?? new WorkspaceManager({
            dataDir,
            allowedRoots: workspaceAllowedRoots,
        });

        const sharedOpts = {
            credentialStore: this.credentialStore,
            workspaceManager: this.workspaceManager,
            orchestratorIds: options.orchestratorIds,
            skills: options.agentSkills,
        };

        // Agent definitions
        const agentDefList = options.agents ?? createAgentDefinitions(sharedOpts);
        this.agentDefs = new Map(agentDefList.map(d => [d.id, d]));
        const configuredOrchestratorIds = agentDefList
            .map((def) => def.id)
            .filter((id) => isOrchestratorAgentId(id));
        this.primaryOrchestratorId = configuredOrchestratorIds[0] ?? ORCHESTRATOR_ID;

        // Backward-compatible specialist registry (used by orchestrator tools)
        this.specialistRegistry = createSpecialistRegistry(sharedOpts);

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
            executeTask: async (agentId, task, job) => {
                const result = await this.chat({
                    toAgentId: agentId,
                    content: task,
                    contact: job.contact,
                    orchestratorId: job.orchestratorId,
                    channel: job.contact ? "whatsapp" : undefined,
                    initiator: job.contact ? "external" : undefined,
                });
                return result.answer;
            },
            trace: async (event) => {
                await this.trace({
                    ...event,
                    sessionId: this.sessionId,
                } as any);
            },
            deliverResult: options.deliverResult,
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

    getPrimaryOrchestratorId(): string {
        return this.primaryOrchestratorId;
    }

    listChats(): AgentChat[] {
        return this.chatManager.listChats();
    }

    private listChatsForRun(runContext: RunContext): AgentChat[] {
        return this.chatManager.listChats().filter((chat) =>
            chat.parentRunId === runContext.runId &&
            chat.parentTurnId === runContext.turnId
        );
    }

    private async waitForRunChatsToClose(
        runContext: RunContext,
        timeoutMs = 5 * 60_000,
    ): Promise<AgentChat[]> {
        const startedAt = Date.now();
        while (true) {
            const chats = this.listChatsForRun(runContext);
            if (chats.length === 0 || chats.every((chat) => chat.status === "closed")) {
                return chats;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                return chats;
            }
            await Bun.sleep(200);
        }
    }

    private getDelegationTimeoutMs(agentId: string): number {
        const timeout = DELEGATION_TIMEOUT_BY_AGENT[agentId as BaseAgentId];
        return timeout ?? DEFAULT_DELEGATION_TIMEOUT_MS;
    }

    private buildDelegationFallbackAnswer(chats: AgentChat[]): string | undefined {
        if (chats.length === 0) return undefined;
        if (chats.length === 1) {
            const chat = chats[0]!;
            if (chat.status === "closed" && chat.closeReason === "completed") {
                const result = stripThoughtPrefix(chat.result ?? "");
                return result || undefined;
            }
            if (chat.status === "closed") {
                return `Delegation to ${chat.agentId} failed: ${chat.error ?? chat.closeReason ?? "unknown error"}.`;
            }
            return `Delegation to ${chat.agentId} is still ${chat.status}.`;
        }

        const lines = chats.map((chat) => {
            if (chat.status === "closed" && chat.closeReason === "completed") {
                return `${chat.agentId}: ${stripThoughtPrefix(chat.result ?? "") || "(completed with empty result)"}`;
            }
            if (chat.status === "closed") {
                return `${chat.agentId}: failed (${chat.error ?? chat.closeReason ?? "unknown error"})`;
            }
            return `${chat.agentId}: ${chat.status}`;
        });
        return lines.join("\n");
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
        const initiator = input.initiator ?? resolveInitiator(fromAgentId);
        runContext.channel = input.channel;
        runContext.contact = input.contact;
        runContext.orchestratorId = input.orchestratorId ?? (isOrchestratorAgentId(input.toAgentId) ? input.toAgentId : undefined);

        await this.trace({
            type: "run_started",
            status: "running",
            runId: runContext.runId,
            turnId: runContext.turnId,
            agentId: input.toAgentId,
            details: {
                fromAgentId,
                preview: input.content.slice(0, 120),
                ...(input.metadata ?? {}),
                channel: runContext.channel,
                contact: runContext.contact,
                orchestratorId: runContext.orchestratorId,
            },
        });

        try {
            const output = await this.routeMessage({
                fromAgentId,
                toAgentId: input.toAgentId,
                content: input.content,
                initiator,
                runContext,
                metadata: input.metadata,
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

    async runSmokeScenario(name: "math" | "code" | "orchestrator" | "explorer" | "writer" | "debugger" | "web-designer" | "marketing" | "graphic-designer") {
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
        if (name === "web-designer") {
            return this.chat({
                toAgentId: "web-designer",
                content: "List the main accessibility best practices for a modern landing page. Return a concise bullet list.",
            });
        }
        if (name === "marketing") {
            return this.chat({
                toAgentId: "marketing",
                content: "Audit the SEO of https://example.com and list the top issues found.",
            });
        }
        if (name === "graphic-designer") {
            return this.chat({
                toAgentId: "graphic-designer",
                content: "List the tools you have available and describe in one sentence what you can create with each one.",
            });
        }
        return this.chat({
            toAgentId: this.primaryOrchestratorId,
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
            orgId: this.orgId,
        };
    }

    private createOrchestratorToolsForRun(runContext: RunContext, orchestratorAgentId: string) {
        return createOrchestratorTools({
            registry: this.specialistRegistry,
            getRunContext: () => runContext,
            getOrchestratorAgentId: () => orchestratorAgentId,
            createDelegation: (input) => {
                return this.chatManager.createChat(
                    {
                        sessionId: this.sessionId,
                        parentRunId: input.runContext.runId,
                        parentTurnId: input.runContext.turnId,
                        orchestratorId: input.orchestratorId,
                        agentId: input.agentId,
                        task: input.task,
                        context: input.context,
                        timeoutMs: this.getDelegationTimeoutMs(input.agentId),
                    },
                    async (_ctx, chat) => {
                        const content = chat.context
                            ? `Context:\n${chat.context}\n\nTask:\n${chat.task}`
                            : chat.task;
                        const output = await this.routeMessage({
                            fromAgentId: input.orchestratorId,
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

    private createSchedulerToolsForRun(orchestratorAgentId: string, runContext?: RunContext): AgentTool<any>[] {
        const entries = createSchedulerToolEntries({
            scheduler: this.scheduler,
            sessionId: this.sessionId,
            callerAgentId: orchestratorAgentId,
            allowedTargets: null, // orchestrator can target any agent
            orgId: runContext?.orgId,
            orchestratorId: runContext?.orchestratorId,
            defaultContact: runContext?.contact,
        });
        return entries.map(entry => ({
            name: entry.name,
            label: entry.description,
            description: entry.description,
            parameters: entry.parameters,
            execute: entry.execute,
        } as AgentTool<any>));
    }

    private resolveWrappedLocalTools(
        def: AgentDefinition,
        agentId: string,
        runContext: RunContext,
        chatId?: string,
    ): AgentTool<any>[] {
        return (def.localTools ?? []).map(entry => {
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
                    hitlTimeout: 5 * 60_000, // 5 minutes timeout for HITL
                    agentId,
                    getRunContext: () => ({
                        channel: runContext.channel,
                        contact: runContext.contact,
                        orgId: runContext.orgId,
                        orchestratorId: runContext.orchestratorId,
                    }),
                    onHitlStart: () => {
                        if (chatId) this.chatManager.pauseTimeout(chatId);
                    },
                    onHitlEnd: () => {
                        if (chatId) this.chatManager.resumeTimeout(chatId);
                    },
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
    }

    private async createAgentForRoute(
        toAgentId: string,
        userInput: string,
        runContext: RunContext,
        chatId?: string,
    ): Promise<PreparedAgent> {
        const def = this.agentDefs.get(toAgentId);
        if (!def) throw new Error(`Agent '${toAgentId}' is not registered.`);

        // Resolve localTools → AgentTool[] with middleware (permissions, HITL)
        const localTools = this.resolveWrappedLocalTools(def, toAgentId, runContext, chatId);
        let resolvedTools = localTools;

        if (isOrchestratorAgentId(toAgentId)) {
            const orchTools = this.createOrchestratorToolsForRun(runContext, toAgentId);
            resolvedTools = [...orchTools, ...localTools];

            // Inject start_background_task when there's a WhatsApp contact to deliver results to
            if (runContext.contact && runContext.orchestratorId && this.orgId) {
                const bgEntry = createBackgroundTaskToolEntry((agentId, task) =>
                    this.scheduler.addJob({
                        sessionId: this.sessionId,
                        createdBy: toAgentId,
                        targetAgentId: agentId,
                        task,
                        schedule: { type: "delay", delayMs: 1 },
                        orgId: this.orgId,
                        orchestratorId: runContext.orchestratorId,
                        contact: runContext.contact,
                    })
                );
                const bgTool: AgentTool<any> = {
                    name: bgEntry.name,
                    label: bgEntry.description,
                    description: bgEntry.description,
                    parameters: bgEntry.parameters,
                    execute: bgEntry.execute,
                };
                resolvedTools = [...resolvedTools, bgTool];
            }
        }

        // Inject scheduler tools into the secretary agent
        if (toAgentId === "secretary") {
            const schedulerCaller = runContext.orchestratorId ?? this.primaryOrchestratorId;
            const schedulerTools = this.createSchedulerToolsForRun(schedulerCaller, runContext);
            resolvedTools = [...resolvedTools, ...schedulerTools];
        }

        // Inject notify_contact into every agent when the run has a WhatsApp contact
        if (runContext.contact && runContext.orchestratorId && this.orgId && this.sendMessageFn) {
            const orgId = this.orgId;
            const orchestratorId = runContext.orchestratorId;
            const contact = runContext.contact;
            const sendFn = this.sendMessageFn;
            const notifyEntry = createNotifyContactToolEntry((body) =>
                sendFn(orgId, orchestratorId, contact, body)
            );
            const notifyTool: AgentTool<any> = {
                name: notifyEntry.name,
                label: notifyEntry.description,
                description: notifyEntry.description,
                parameters: notifyEntry.parameters,
                execute: notifyEntry.execute,
            };
            resolvedTools = [...resolvedTools, notifyTool];
        }

        const basePrompt = compileSystemPrompt(def, resolvedTools);
        const skillContext = await buildSkillContextSection({
            userInput,
            config: def.skillsConfig,
        });
        if (skillContext.selectedSkills.length > 0) {
            console.error(`[skills] agent=${toAgentId} selected=[${skillContext.selectedSkills.join(", ")}] (${skillContext.availableSkills} available)`);
        }
        const systemPrompt = skillContext.section
            ? `${basePrompt}\n\n${skillContext.section}`
            : basePrompt;
        const agent = def.createAgent(resolvedTools, systemPrompt);
        return {
            agent,
            selectedSkills: skillContext.selectedSkills,
            availableSkills: skillContext.availableSkills,
            skillErrors: skillContext.errors,
        };
    }

    private async routeMessage(input: RouteMessageInput): Promise<RouteMessageOutput> {
        const startedAt = now();
        const preparedAgent = await this.createAgentForRoute(
            input.toAgentId,
            input.content,
            input.runContext,
            input.chatId,
        );
        const agent = preparedAgent.agent;

        const threadId = createThreadId(this.sessionId, input.fromAgentId, input.toAgentId);
        const history = await this.store.getThreadMessages(threadId);
        const historyMessages = pruneHistory(history.map((item) => item.message));
        agent.replaceMessages(historyMessages);

        const userMessage: AgentMessage = {
            role: "user",
            content: input.content,
            timestamp: now(),
        };

        const beforeCount = historyMessages.length;
        const forwardAgentEvent = input.onAgentEvent;
        const unsubscribe = agent.subscribe((event: AgentEvent) => {
            if (event.type === "tool_execution_start") {
                const traceDetails: Record<string, unknown> = {
                    phase: "execution",
                    args: sanitizeToolArgsForTrace(event.toolName, event.args),
                };
                void safeAsync(
                    () =>
                        this.trace({
                            type: "tool_start",
                            status: "running",
                            runId: input.runContext.runId,
                            turnId: input.runContext.turnId,
                            agentId: input.toAgentId,
                            chatId: input.chatId,
                            toolCallId: event.toolCallId,
                            toolName: event.toolName,
                            details: traceDetails,
                        }),
                    "runtime:tool_execution_start",
                );
            } else if (event.type === "tool_execution_end") {
                const error = event.isError
                    ? extractToolErrorFromResult(event.result) ?? "Tool execution failed."
                    : undefined;
                const traceDetails: Record<string, unknown> = {
                    phase: "execution",
                    isError: event.isError,
                    error,
                    details: summarizeToolDetails(event.result),
                };
                void safeAsync(
                    () =>
                        this.trace({
                            type: "tool_end",
                            status: event.isError ? "error" : "ok",
                            runId: input.runContext.runId,
                            turnId: input.runContext.turnId,
                            agentId: input.toAgentId,
                            chatId: input.chatId,
                            toolCallId: event.toolCallId,
                            toolName: event.toolName,
                            details: traceDetails,
                        }),
                    "runtime:tool_execution_end",
                );
                if (event.isError) {
                    console.error(
                        `[tool-error] agent=${input.toAgentId} tool=${event.toolName} call=${event.toolCallId}: ${error ?? "unknown"}`,
                    );
                }
            }

            forwardAgentEvent?.(event);
        });
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
                            : isOrchestratorAgentId(input.toAgentId)
                                ? input.toAgentId
                                : this.primaryOrchestratorId,
                toAgentId:
                    message.role === "assistant"
                        ? input.fromAgentId
                        : message.role === "user"
                            ? input.toAgentId
                            : input.toAgentId,
                initiator: input.initiator,
                chatId: input.chatId,
                toolCallId: input.toolCallId,
                metadata: input.metadata,
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

        let answer = extractLastAssistantText(agent.state.messages);

        // For top-level human→orchestrator turns, don't return before delegated chats settle.
        if (
            isOrchestratorAgentId(input.toAgentId) &&
            isTopLevelHumanInitiator(input.initiator) &&
            !input.chatId
        ) {
            const runChatsAtPromptEnd = this.listChatsForRun(input.runContext);
            const hadPendingDelegations = runChatsAtPromptEnd.some((chat) => chat.status !== "closed");
            if (hadPendingDelegations) {
                await this.waitForRunChatsToClose(input.runContext);
            }

            const settledRunChats = this.listChatsForRun(input.runContext);
            const fallback = this.buildDelegationFallbackAnswer(settledRunChats);
            if (fallback && isDelegationPlaceholderText(answer)) {
                answer = fallback;
            }
        }
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
                channel: input.runContext.channel,
                contact: input.runContext.contact,
                orchestratorId: input.runContext.orchestratorId,
                selectedSkills: preparedAgent.selectedSkills,
                availableSkills: preparedAgent.availableSkills,
                skillErrors: preparedAgent.skillErrors.length > 0 ? preparedAgent.skillErrors : undefined,
                ...(input.metadata ?? {}),
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
            const orchestratorId = chat.orchestratorId ?? this.primaryOrchestratorId;
            const threadId = createThreadId(this.sessionId, orchestratorId, chat.agentId as BaseAgentId);
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
                fromAgentId: orchestratorId,
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
