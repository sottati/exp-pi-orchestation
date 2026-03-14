import type { AgentChat } from "./contracts";
import { errorMessage, safeAsync } from "./errors";
import { createId, now } from "./ids";

interface RunnerContext {
    signal: AbortSignal;
    attempt: number;
}

type ChatRunner = (ctx: RunnerContext, chat: AgentChat) => Promise<string>;

interface QueueTurnInput {
    task: string;
    context?: string;
    resolve: (chat: AgentChat) => void;
    reject: (error: Error) => void;
}

interface ChatRuntimeData {
    record: AgentChat;
    controller?: AbortController;
    runner?: ChatRunner;
    turnQueue: QueueTurnInput[];
    running: boolean;
}

export interface CreateChatInput {
    sessionId: string;
    parentRunId: string;
    parentTurnId: string;
    agentId: string;
    conversationId?: string;
    task: string;
    context?: string;
    timeoutMs?: number;
    maxRetries?: number;
    keepAlive?: boolean;
}

export interface ChatHooks {
    onCreated?: (chat: AgentChat) => Promise<void> | void;
    onStarted?: (chat: AgentChat) => Promise<void> | void;
    onRetry?: (chat: AgentChat) => Promise<void> | void;
    onCompleted?: (chat: AgentChat) => Promise<void> | void;
    onFailed?: (chat: AgentChat) => Promise<void> | void;
    onCancelled?: (chat: AgentChat) => Promise<void> | void;
}

export interface ChatManagerOptions {
    hooks?: ChatHooks;
    persistChat?: (chat: AgentChat) => Promise<void>;
    restoreRecords?: () => Promise<AgentChat[]>;
    getMaxConcurrency?: (agentId: string) => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 1;

export function createConversationId(sessionId: string, firstAgentId: string, secondAgentId: string): string {
    return `${sessionId}::${[firstAgentId, secondAgentId].sort().join("<->")}`;
}

export class ChatManager {
    private readonly chats = new Map<string, ChatRuntimeData>();
    private readonly activeChats = new Map<string, Set<string>>();
    private readonly waitingQueue = new Map<string, string[]>();
    private readonly hooks: ChatHooks;
    private readonly persistChat?: (chat: AgentChat) => Promise<void>;
    private readonly restoreRecords?: () => Promise<AgentChat[]>;
    private readonly getMaxConcurrency: (agentId: string) => number;

    constructor(opts: ChatManagerOptions = {}) {
        this.hooks = opts.hooks ?? {};
        this.persistChat = opts.persistChat;
        this.restoreRecords = opts.restoreRecords;
        this.getMaxConcurrency = opts.getMaxConcurrency ?? (() => 1);
    }

    private safePersist(chat: AgentChat) {
        return safeAsync(() => this.persistChat?.(chat) ?? Promise.resolve(), "chat:persist");
    }

    private safeHook(name: keyof ChatHooks, chat: AgentChat) {
        return safeAsync(async () => { await this.hooks[name]?.(chat); }, `hook:${name}`);
    }

    private markCancelled(chat: AgentChat): boolean {
        if (chat.status === "closed" && chat.closeReason === "cancelled") return false;
        chat.status = "closed";
        chat.closeReason = "cancelled";
        chat.updatedAt = now();
        chat.closedAt = chat.closedAt ?? now();
        return true;
    }

    async restore(): Promise<number> {
        if (!this.restoreRecords) return 0;
        const records = await this.restoreRecords();
        let recovered = 0;
        for (const record of records) {
            if (this.chats.has(record.chatId)) continue;
            record.conversationId ||= createConversationId(record.sessionId, "orchestrator", record.agentId);
            if (record.status === "active" || record.status === "waiting") {
                record.status = "closed";
                record.closeReason = "failed";
                record.error = "Interrupted by runtime restart";
                record.updatedAt = now();
                record.closedAt = now();
                await this.safePersist(record);
                recovered++;
            }
            this.chats.set(record.chatId, { record, turnQueue: [], running: false });
        }
        return recovered;
    }

    createChat(input: CreateChatInput, runner: ChatRunner): AgentChat {
        const chat: AgentChat = {
            chatId: createId("chat"),
            conversationId: input.conversationId ?? createConversationId(input.sessionId, "orchestrator", input.agentId),
            sessionId: input.sessionId,
            parentRunId: input.parentRunId,
            parentTurnId: input.parentTurnId,
            agentId: input.agentId,
            task: input.task,
            context: input.context,
            status: "waiting",
            createdAt: now(),
            updatedAt: now(),
            attempts: 0,
            maxRetries: Math.max(0, input.maxRetries ?? DEFAULT_MAX_RETRIES),
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            keepAlive: input.keepAlive,
        };

        const runtimeData: ChatRuntimeData = { record: chat, runner, turnQueue: [], running: false };
        this.chats.set(chat.chatId, runtimeData);

        const active = this.activeChats.get(input.agentId) ?? new Set();
        this.activeChats.set(input.agentId, active);
        const maxConcurrency = this.getMaxConcurrency(input.agentId);

        if (active.size < maxConcurrency) {
            chat.status = "active";
            active.add(chat.chatId);
            void this.safePersist(chat);
            void this.safeHook("onCreated", chat);
            void this.execute(chat.chatId, runner).catch(err =>
                console.error("[ChatManager] execute:", err)
            );
        } else {
            const queue = this.waitingQueue.get(input.agentId) ?? [];
            queue.push(chat.chatId);
            this.waitingQueue.set(input.agentId, queue);
            void this.safePersist(chat);
            void this.safeHook("onCreated", chat);
        }

        return { ...chat };
    }

    getChat(chatId: string): AgentChat | undefined {
        const runtime = this.chats.get(chatId);
        return runtime ? { ...runtime.record } : undefined;
    }

    sendMessage(chatId: string, input: { task: string; context?: string }): Promise<AgentChat> {
        const runtime = this.chats.get(chatId);
        if (!runtime) {
            return Promise.reject(new Error(`chatId ${chatId} not found.`));
        }
        if (runtime.record.status === "closed") {
            return Promise.reject(new Error(`chatId ${chatId} is closed.`));
        }
        if (!runtime.record.keepAlive) {
            return Promise.reject(new Error(`chatId ${chatId} does not accept follow-up messages.`));
        }

        return new Promise<AgentChat>((resolve, reject) => {
            runtime.turnQueue.push({
                task: input.task,
                context: input.context,
                resolve,
                reject: (error) => reject(error),
            });
            runtime.record.updatedAt = now();
            void this.safePersist(runtime.record);
            if (runtime.record.status === "active" && !runtime.running && runtime.runner) {
                void this.execute(chatId, runtime.runner).catch(err =>
                    console.error("[ChatManager] execute:", err)
                );
            }
        });
    }

    closeChat(chatId: string): AgentChat | undefined {
        const runtime = this.chats.get(chatId);
        if (!runtime) return undefined;
        if (runtime.record.status === "closed") return { ...runtime.record };

        // Remove from waiting queue if queued
        if (runtime.record.status === "waiting") {
            const queue = this.waitingQueue.get(runtime.record.agentId);
            if (queue) {
                const idx = queue.indexOf(chatId);
                if (idx >= 0) queue.splice(idx, 1);
            }
        }

        const changed = this.markCancelled(runtime.record);
        runtime.controller?.abort();
        const pending = runtime.turnQueue.splice(0);
        for (const queued of pending) {
            queued.reject(new Error(`chatId ${chatId} was cancelled.`));
        }
        if (changed) {
            void this.safePersist(runtime.record);
            void this.safeHook("onCancelled", runtime.record);
        }

        this.dequeueNext(runtime.record.agentId);

        return { ...runtime.record };
    }

    listChats(): AgentChat[] {
        return [...this.chats.values()]
            .map(c => ({ ...c.record }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getQueuePosition(chatId: string): number | undefined {
        const chat = this.chats.get(chatId);
        if (!chat || chat.record.status !== "waiting") return undefined;
        const queue = this.waitingQueue.get(chat.record.agentId) ?? [];
        const index = queue.indexOf(chatId);
        return index >= 0 ? index + 1 : undefined;
    }

    private dequeueNext(agentId: string) {
        const active = this.activeChats.get(agentId);
        if (!active) return;

        for (const id of active) {
            const c = this.chats.get(id);
            if (c && c.record.status === "closed") active.delete(id);
        }

        const maxConcurrency = this.getMaxConcurrency(agentId);
        const queue = this.waitingQueue.get(agentId);

        while (queue && queue.length > 0 && active.size < maxConcurrency) {
            const nextId = queue.shift()!;
            const next = this.chats.get(nextId);
            if (!next || !next.runner || next.record.status !== "waiting") continue;

            next.record.status = "active";
            next.record.updatedAt = now();
            active.add(nextId);
            void this.safePersist(next.record);
            void this.execute(nextId, next.runner).catch(err =>
                console.error("[ChatManager] execute:", err)
            );
        }
    }

    private async execute(chatId: string, runner: ChatRunner) {
        const runtime = this.chats.get(chatId);
        if (!runtime || runtime.running) return;

        runtime.running = true;

        let currentQueuedTurn: QueueTurnInput | undefined;

        try {
            while (true) {
                if (runtime.record.keepAlive) {
                    currentQueuedTurn = runtime.turnQueue.shift();
                    if (currentQueuedTurn) {
                        runtime.record.task = currentQueuedTurn.task;
                        runtime.record.context = currentQueuedTurn.context;
                        runtime.record.error = undefined;
                        runtime.record.result = undefined;
                    } else if (runtime.record.attempts > 0) {
                        return;
                    }
                }

                let turnAttempts = 0;
                while (turnAttempts <= runtime.record.maxRetries) {
                    if (runtime.record.status === "closed") return;

                    turnAttempts += 1;
                    runtime.record.attempts += 1;
                    runtime.record.updatedAt = now();
                    runtime.record.startedAt ??= now();
                    runtime.controller = new AbortController();
                    await this.safePersist(runtime.record);
                    await this.safeHook("onStarted", runtime.record);

                    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
                    try {
                        const timeoutPromise = new Promise<string>((_, reject) => {
                            timeoutHandle = setTimeout(() => {
                                runtime.controller?.abort();
                                reject(new Error(`Chat timeout after ${runtime.record.timeoutMs}ms`));
                            }, runtime.record.timeoutMs);
                        });

                        const result = await Promise.race([
                            runner({ signal: runtime.controller.signal, attempt: runtime.record.attempts }, runtime.record),
                            timeoutPromise,
                        ]);

                        if (timeoutHandle) clearTimeout(timeoutHandle);

                        runtime.record.result = result;
                        runtime.record.updatedAt = now();
                        if (runtime.record.keepAlive) {
                            await this.safePersist(runtime.record);
                            currentQueuedTurn?.resolve({ ...runtime.record });
                            currentQueuedTurn = undefined;
                            break;
                        }

                        runtime.record.status = "closed";
                        runtime.record.closeReason = "completed";
                        runtime.record.closedAt = now();
                        await this.safePersist(runtime.record);
                        await this.safeHook("onCompleted", runtime.record);
                        this.dequeueNext(runtime.record.agentId);
                        return;
                    } catch (error) {
                        if (timeoutHandle) clearTimeout(timeoutHandle);

                        if (runtime.controller.signal.aborted) {
                            const changed = this.markCancelled(runtime.record);
                            currentQueuedTurn?.reject(new Error(`chatId ${chatId} was cancelled.`));
                            currentQueuedTurn = undefined;
                            if (changed) {
                                await this.safePersist(runtime.record);
                                await this.safeHook("onCancelled", runtime.record);
                                this.dequeueNext(runtime.record.agentId);
                            }
                            return;
                        }

                        runtime.record.error = errorMessage(error);
                        runtime.record.updatedAt = now();

                        if (turnAttempts <= runtime.record.maxRetries) {
                            await this.safePersist(runtime.record);
                            await this.safeHook("onRetry", runtime.record);
                            continue;
                        }

                        runtime.record.status = "closed";
                        runtime.record.closeReason = "failed";
                        runtime.record.closedAt = now();
                        await this.safePersist(runtime.record);
                        await this.safeHook("onFailed", runtime.record);
                        currentQueuedTurn?.reject(new Error(runtime.record.error ?? "chat failed"));
                        currentQueuedTurn = undefined;
                        for (const queued of runtime.turnQueue.splice(0)) {
                            queued.reject(new Error(runtime.record.error ?? "chat failed"));
                        }
                        this.dequeueNext(runtime.record.agentId);
                        return;
                    }
                }
            }
        } finally {
            runtime.running = false;
        }
    }
}
